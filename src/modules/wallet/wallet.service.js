'use strict';

const { User, USER_STATUS } = require('../users/user.model');
const { WalletTransaction, TRANSACTION_TYPES } = require('./walletTransaction.model');
const { NotFoundError, BusinessRuleError, InsufficientFundsError } = require('../../shared/errors/AppError');

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an immutable WalletTransaction audit record.
 * Session is optional — works on standalone MongoDB instances.
 *
 * @private
 */
const _createTransactionRecord = async ({
    userId,
    type,
    amount,
    balanceBefore,
    balanceAfter,
    reference,
    description,
    session,
}) => {
    const doc = {
        userId,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        reference,
        status: 'COMPLETED',
        description,
    };

    if (session) {
        const [txn] = await WalletTransaction.create([doc], { session });
        return txn;
    }
    return WalletTransaction.create(doc);
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — ATOMIC DEBIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically debit a user's wallet for an order.
 *
 * STRICT WALLET-ONLY policy (credit/borrow system removed):
 *   - Orders only proceed when walletBalance >= amount.
 *   - creditLimit / creditUsed fields are NOT used and NOT modified.
 *   - Balance can NEVER go negative.
 *
 * Uses a MongoDB aggregation-pipeline findOneAndUpdate — the balance check
 * and deduction are ONE atomic DB operation; no TOCTOU race conditions.
 *
 * Session is optional — when provided it is passed through, otherwise
 * the operation works on standalone MongoDB instances without transactions.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {number}          params.amount      - total order amount
 * @param {string|null}     params.reference   - orderId (set post-commit)
 * @param {string}          params.description
 * @param {ClientSession}   [params.session]   - optional MongoDB session
 *
 * @returns {{ walletDeducted: number, creditUsedAmount: number, transaction: WalletTransaction }}
 *          creditUsedAmount is always 0 (kept for Order schema backward-compat)
 */
const debitWalletAtomic = async ({ userId, amount, reference = null, description = '', session }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Debit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const opts = session ? { new: false, session } : { new: false };

    // ── Atomic CAS: only matches when user is ACTIVE and balance is sufficient ─
    const oldUser = await User.findOneAndUpdate(
        {
            _id: userId,
            status: USER_STATUS.ACTIVE,
            walletBalance: { $gte: amount },   // strict — no credit fallback
        },
        [{ $set: { walletBalance: { $subtract: ['$walletBalance', amount] } } }],
        opts
    );

    if (!oldUser) {
        const findOpts = session ? { session } : {};
        const user = session
            ? await User.findById(userId).session(session)
            : await User.findById(userId);
        if (!user) throw new NotFoundError('User');
        if (user.status !== USER_STATUS.ACTIVE) {
            throw new BusinessRuleError('User account is not active.', 'ACCOUNT_INACTIVE');
        }
        // Balance is insufficient
        throw new InsufficientFundsError(amount, user.walletBalance);
    }

    // ── Immutable wallet transaction record ───────────────────────────────────
    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount,
        balanceBefore: oldUser.walletBalance,
        balanceAfter: oldUser.walletBalance - amount,
        reference,
        description,
        session,
    });

    // creditUsedAmount always 0 — preserved so Order schema & refundWalletAtomic
    // don't need changes (refund restores walletDeducted = amount, creditUsed = 0)
    return { walletDeducted: amount, creditUsedAmount: 0, transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — ATOMIC REFUND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically refund a user's wallet after an order failure.
 * Session is optional.
 */
const refundWalletAtomic = async ({
    userId,
    walletDeducted,
    creditUsedAmount,
    reference,
    description = '',
    session,
}) => {
    const totalRefund = parseFloat((walletDeducted + creditUsedAmount).toFixed(2));
    if (totalRefund <= 0) {
        throw new BusinessRuleError('Refund amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const opts = session ? { new: false, session } : { new: false };

    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [
            {
                $set: {
                    walletBalance: { $add: ['$walletBalance', walletDeducted] },
                    creditUsed: {
                        $max: [0, { $subtract: ['$creditUsed', creditUsedAmount] }],
                    },
                },
            },
        ],
        opts
    );

    if (!oldUser) throw new NotFoundError('User');

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.REFUND,
        amount: totalRefund,
        balanceBefore: oldUser.walletBalance,
        balanceAfter: oldUser.walletBalance + walletDeducted,
        reference,
        description,
        session,
    });

    return { transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — DIRECT CREDIT (deposit top-ups)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically credit a flat amount directly to a user's walletBalance.
 * Session is optional — works on standalone MongoDB instances.
 */
const creditWalletDirect = async ({ userId, amount, reference = null, description = '', session }) => {
    if (amount <= 0) {
        throw new BusinessRuleError('Credit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const opts = session ? { new: false, session } : { new: false };

    const oldUser = await User.findOneAndUpdate(
        { _id: userId },
        [{ $set: { walletBalance: { $add: ['$walletBalance', amount] } } }],
        opts
    );

    if (!oldUser) throw new NotFoundError('User');

    const transaction = await _createTransactionRecord({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount,
        balanceBefore: oldUser.walletBalance,
        balanceAfter: oldUser.walletBalance + amount,
        reference,
        description,
        session,
    });

    return { transaction };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get wallet transaction history for a user (paginated).
 */
const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        WalletTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('reference', 'status totalPrice'),
        WalletTransaction.countDocuments({ userId }),
    ]);

    return {
        transactions,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

module.exports = { debitWalletAtomic, refundWalletAtomic, creditWalletDirect, getTransactionHistory };
