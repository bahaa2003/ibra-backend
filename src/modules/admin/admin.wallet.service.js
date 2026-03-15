'use strict';

/**
 * admin.wallet.service.js
 *
 * Admin manual wallet adjustments.
 *
 * Uses sequential await operations — compatible with standalone MongoDB
 * instances (no replica set required).
 */

const { User } = require('../users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

const MAX_ADJUSTMENT = 100_000;  // guard against fat-finger typos

// ─── List wallets (summary of all users) ─────────────────────────────────────

const listWallets = async ({ page = 1, limit = 20 } = {}) => {
    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find({ deletedAt: null })
            .select('name email walletBalance creditLimit creditUsed role status')
            .sort({ walletBalance: -1 })
            .skip(skip)
            .limit(limit),
        User.countDocuments({ deletedAt: null }),
    ]);

    return { wallets: users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Get one user's wallet ─────────────────────────────────────────────────────

const getWallet = async (userId) => {
    const user = await User.findById(userId)
        .select('name email walletBalance creditLimit creditUsed currency status');
    if (!user) throw new NotFoundError('User');
    return user;
};

// ─── Transaction history ───────────────────────────────────────────────────────

const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
    const user = await User.findById(userId).select('_id');
    if (!user) throw new NotFoundError('User');

    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        WalletTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('reference', 'status totalPrice'),
        WalletTransaction.countDocuments({ userId }),
    ]);

    return { transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Manual Add ───────────────────────────────────────────────────────────────

/**
 * Admin: add funds to a user's wallet balance.
 * No MongoDB transactions — uses atomic findOneAndUpdate + sequential create.
 */
const addFunds = async (userId, amount, reason, adminId) => {
    if (amount <= 0 || amount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Atomic increment — captures the pre-update document
    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [{ $set: { walletBalance: { $add: ['$walletBalance', amount] } } }],
        { new: false }
    );

    if (!oldUser) throw new NotFoundError('User');

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount,
        balanceBefore: oldUser.walletBalance,
        balanceAfter: oldUser.walletBalance + amount,
        reference: null,
        status: 'COMPLETED',
        description: reason || 'Admin manual credit',
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: { type: 'ADD', amount, reason, userId, transactionId: transaction._id },
    });

    return { transaction };
};

// ─── Manual Deduct ────────────────────────────────────────────────────────────

/**
 * Admin: deduct funds from a user's wallet balance (no order required).
 * No MongoDB transactions — uses atomic findOneAndUpdate + sequential create.
 */
const deductFunds = async (userId, amount, reason, adminId) => {
    if (amount <= 0 || amount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Atomic: only deduct if sufficient balance
    const oldUser = await User.findOneAndUpdate(
        { _id: userId, walletBalance: { $gte: amount } },
        [{ $set: { walletBalance: { $subtract: ['$walletBalance', amount] } } }],
        { new: false }
    );

    if (!oldUser) {
        const check = await User.findById(userId);
        if (!check) throw new NotFoundError('User');
        throw new BusinessRuleError('Insufficient wallet balance for this deduction.', 'INSUFFICIENT_BALANCE');
    }

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount,
        balanceBefore: oldUser.walletBalance,
        balanceAfter: oldUser.walletBalance - amount,
        reference: null,
        status: 'COMPLETED',
        description: reason || 'Admin manual debit',
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: { type: 'DEDUCT', amount, reason, userId, transactionId: transaction._id },
    });

    return { transaction };
};

module.exports = {
    listWallets,
    getWallet,
    getTransactionHistory,
    addFunds,
    deductFunds,
};
