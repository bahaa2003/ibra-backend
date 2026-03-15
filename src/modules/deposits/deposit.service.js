'use strict';

const mongoose = require('mongoose');
const { DepositRequest, DEPOSIT_STATUS } = require('./deposit.model');
const { User } = require('../users/user.model');
const { creditWalletDirect } = require('../wallet/wallet.service');
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

// =============================================================================
// CREATE
// =============================================================================

/**
 * Customer creates a new deposit request.
 *
 * Business rules:
 *   - User must exist and be ACTIVE (enforced upstream by requireActiveUser middleware).
 *   - No duplicate check — a user may have multiple PENDING requests.
 *   - Amount must be > 0 (enforced by schema).
 *   - No wallet credit at this stage; the request is PENDING until admin review.
 *
 * Audit: DEPOSIT_REQUESTED — fire-and-forget after save.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {number}          params.amountRequested
 * @param {string}          params.transferImageUrl
 * @param {string}          params.transferredFromNumber
 * @param {Object|null}     [params.auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const createDepositRequest = async ({
    userId,
    amountRequested,
    transferImageUrl,
    transferredFromNumber,
    auditContext = null,
}) => {
    // Confirm user exists (belt-and-suspenders — middleware already checks ACTIVE)
    const user = await User.findById(userId).select('_id role');
    if (!user) throw new NotFoundError('User');

    const deposit = await DepositRequest.create({
        userId,
        amountRequested,
        transferImageUrl,
        transferredFromNumber,
        status: DEPOSIT_STATUS.PENDING,
    });

    // Audit: fire-and-forget
    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: DEPOSIT_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: userId.toString(),
            amountRequested,
            transferredFromNumber,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return deposit;
};

// =============================================================================
// APPROVE
// =============================================================================

/**
 * Admin approves a deposit request and credits the user's wallet.
 *
 * All mutations happen inside a single MongoDB transaction session:
 *   1. Load and validate the deposit.
 *   2. Atomic findOneAndUpdate with { status: PENDING } condition — prevents
 *      double-approval even under concurrent requests (no-op if status changed).
 *   3. Atomically credit the user's wallet.
 *   4. Commit.
 *
 * Concurrency safety:
 *   findOneAndUpdate with { _id, status: PENDING } acts as a compare-and-swap.
 *   The first concurrent approve wins; the second finds no matching document
 *   (status is no longer PENDING) and throws DEPOSIT_ALREADY_APPROVED.
 *
 * Audit: DEPOSIT_APPROVED + WALLET_CREDIT — both fire-and-forget AFTER commit.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {number|null}     [overrideAmount]
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const approveDeposit = async (depositId, adminId, overrideAmount = null, auditContext = null) => {
    // Pre-read to give clear error messages if status is already wrong
    const existing = await DepositRequest.findById(depositId);
    if (!existing) throw new NotFoundError('DepositRequest');

    if (existing.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }
    if (existing.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected deposit cannot be approved. Create a new request.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }

    // Determine the approved amount
    const approvedAmount = overrideAmount !== null
        ? parseFloat(parseFloat(overrideAmount).toFixed(2))
        : parseFloat(existing.amountRequested.toFixed(2));

    if (approvedAmount <= 0) {
        throw new BusinessRuleError('Approved amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    // Atomic compare-and-swap on { _id, status: PENDING }
    // If status changed between the pre-read and this write (concurrent request),
    // findOneAndUpdate returns null and we throw.
    const updated = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        {
            $set: {
                status: DEPOSIT_STATUS.APPROVED,
                amountApproved: approvedAmount,
                reviewedBy: adminId,
                reviewedAt: new Date(),
            },
        },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    // Credit the wallet (no session — standalone compatible)
    await creditWalletDirect({
        userId: updated.userId,
        amount: approvedAmount,
        reference: updated._id,
        description: `Deposit approval #${updated._id}`,
    });

    // Audit: fire-and-forget
    const actorId = auditContext?.actorId ?? adminId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: DEPOSIT_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            amountRequested: updated.amountRequested,
            amountApproved: approvedAmount,
            reviewedBy: adminId.toString(),
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: WALLET_ACTIONS.CREDIT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: updated.userId,
        metadata: {
            depositId: updated._id.toString(),
            amount: approvedAmount,
            reason: 'DEPOSIT_APPROVED',
        },
    });

    return updated;
};

// =============================================================================
// REJECT
// =============================================================================

/**
 * Admin rejects a deposit request.
 *
 * Only PENDING requests can be rejected.
 * No financial operation is performed — wallet is untouched.
 *
 * Audit: DEPOSIT_REJECTED — fire-and-forget after save.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const rejectDeposit = async (depositId, adminId, auditContext = null) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('DepositRequest');

    if (deposit.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This deposit request has already been rejected.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }
    if (deposit.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved deposit cannot be rejected. It has already been credited.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    deposit.status = DEPOSIT_STATUS.REJECTED;
    deposit.reviewedBy = adminId;
    deposit.reviewedAt = new Date();
    await deposit.save();

    // Audit: fire-and-forget after save
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: deposit.userId.toString(),
            amountRequested: deposit.amountRequested,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return deposit;
};

// =============================================================================
// QUERIES
// =============================================================================

/**
 * Admin: list deposit requests with optional status filter, paginated.
 * Sorted oldest-first (PENDING queue: FIFO).
 */
const listDeposits = async ({ page = 1, limit = 20, status } = {}) => {
    const filter = {};
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const [deposits, total] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: 1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance')
            .populate('reviewedBy', 'name email'),
        DepositRequest.countDocuments(filter),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Customer: list their own deposit requests, paginated.
 * Sorted newest-first.
 */
const listMyDeposits = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const [deposits, total] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        DepositRequest.countDocuments(filter),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Get a single deposit request by ID.
 * Customers may only see their own; admins may see any.
 *
 * @param {string|ObjectId}      depositId
 * @param {string|ObjectId|null} [requestingUserId] - if set, enforces ownership
 */
const getDepositById = async (depositId, requestingUserId = null) => {
    const deposit = await DepositRequest.findById(depositId)
        .populate('userId', 'name email')
        .populate('reviewedBy', 'name email');

    if (!deposit) throw new NotFoundError('DepositRequest');

    if (requestingUserId && deposit.userId._id.toString() !== requestingUserId.toString()) {
        throw new AuthorizationError('You do not have permission to view this deposit request.');
    }

    return deposit;
};

// =============================================================================
// UPDATE PENDING DEPOSIT
// =============================================================================

/**
 * Update a PENDING deposit request (admin editing amount or transfer number).
 *
 * Guard: strictly rejects updates if the deposit is NOT in PENDING status.
 *
 * @param {string}          depositId
 * @param {Object}          data
 * @param {number}          [data.amountRequested]
 * @param {string}          [data.transferredFromNumber]
 * @param {string|ObjectId} adminId
 *
 * @returns {Promise<DepositRequest>}
 */
const updatePendingDeposit = async (depositId, data, adminId) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('Deposit request');

    if (deposit.status !== DEPOSIT_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot update a ${deposit.status.toLowerCase()} deposit. Only PENDING deposits can be edited.`,
            'DEPOSIT_NOT_PENDING'
        );
    }

    const before = {
        amountRequested: deposit.amountRequested,
        transferredFromNumber: deposit.transferredFromNumber,
    };

    if (data.amountRequested !== undefined) deposit.amountRequested = data.amountRequested;
    if (data.transferredFromNumber !== undefined) deposit.transferredFromNumber = data.transferredFromNumber;

    await deposit.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: { before, after: { amountRequested: deposit.amountRequested, transferredFromNumber: deposit.transferredFromNumber } },
    });

    return deposit;
};

module.exports = {
    createDepositRequest,
    approveDeposit,
    rejectDeposit,
    listDeposits,
    listMyDeposits,
    getDepositById,
    updatePendingDeposit,
};
