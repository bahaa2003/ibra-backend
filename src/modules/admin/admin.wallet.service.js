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

/**
 * Safe rounding via integer math — kills IEEE-754 dust like 5.684e-14.
 * Number.toFixed(2) still leaks because it returns a string that Number()
 * re-parses, preserving intermediate float imprecision.
 */
const safeRound = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

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
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 * The admin dashboard displays balances in local currency, so the input
 * is naturally in the same denomination.
 *
 * No MongoDB transactions — uses atomic findOneAndUpdate + sequential create.
 */
const addFunds = async (userId, amount, reason, adminId) => {
    const parsedAmount = safeRound(Number(amount));

    if (parsedAmount <= 0 || parsedAmount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Fetch user first to compute credit repayment
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditUsedBefore = safeRound(user.creditUsed || 0);

    // If user has drawn credit (creditUsed > 0), adding funds repays credit first.
    // Example: balance=-50, creditUsed=50, add 80 → creditUsed=0, balance=30
    let creditRepaid = 0;
    if (creditUsedBefore > 0 && balanceBefore < 0) {
        creditRepaid = safeRound(Math.min(parsedAmount, creditUsedBefore));
    }

    const balanceAfter = safeRound(balanceBefore + parsedAmount);
    const creditUsedAfter = safeRound(creditUsedBefore - creditRepaid);

    // Atomic update
    await User.findByIdAndUpdate(userId, {
        $set: {
            walletBalance: balanceAfter,
            creditUsed: creditUsedAfter,
        },
    });

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        amount: parsedAmount,
        balanceBefore,
        balanceAfter,
        reference: null,
        status: 'COMPLETED',
        description: reason || `Admin manual credit (${userCurrency})`,
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: {
            type: 'ADD',
            amount: parsedAmount,
            currency: userCurrency,
            reason,
            userId,
            balanceBefore,
            balanceAfter,
            creditRepaid,
            transactionId: transaction._id,
        },
    });

    return { transaction };
};

/**
 * Admin: deduct funds from a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 *
 * CREDIT LIMIT ENFORCEMENT:
 *   available = walletBalance + (creditLimit - creditUsed)
 *   Deduction allowed only if: amount <= available
 *   newBalance = walletBalance - amount (can go negative up to -creditLimit)
 */
const deductFunds = async (userId, amount, reason, adminId) => {
    const parsedAmount = safeRound(Number(amount));

    if (parsedAmount <= 0 || parsedAmount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Fetch user to check credit limit
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));
    const creditUsedBefore = safeRound(user.creditUsed || 0);
    const availableCredit = safeRound(creditLimit - creditUsedBefore);
    const totalAvailable = safeRound(balanceBefore + availableCredit);

    if (parsedAmount > totalAvailable) {
        throw new BusinessRuleError(
            `Insufficient funds. Available: ${totalAvailable.toFixed(2)} ${userCurrency} ` +
            `(balance: ${balanceBefore.toFixed(2)}, available credit: ${availableCredit.toFixed(2)}).`,
            'INSUFFICIENT_BALANCE'
        );
    }

    // Calculate new balance and credit usage
    const balanceAfter = safeRound(balanceBefore - parsedAmount);

    // If balance goes negative, the deficit is drawn from credit
    let creditDrawn = 0;
    if (balanceAfter < 0) {
        // How much of the credit line is now being used
        creditDrawn = safeRound(Math.min(Math.abs(balanceAfter), availableCredit));
    }
    const creditUsedAfter = safeRound(creditUsedBefore + creditDrawn);

    // Atomic update
    await User.findByIdAndUpdate(userId, {
        $set: {
            walletBalance: balanceAfter,
            creditUsed: creditUsedAfter,
        },
    });

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        amount: parsedAmount,
        balanceBefore,
        balanceAfter,
        reference: null,
        status: 'COMPLETED',
        description: reason || `Admin manual debit (${userCurrency})`,
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: {
            type: 'DEDUCT',
            amount: parsedAmount,
            currency: userCurrency,
            reason,
            userId,
            balanceBefore,
            balanceAfter,
            creditDrawn,
            creditUsedBefore,
            creditUsedAfter,
            transactionId: transaction._id,
        },
    });

    return { transaction };
};

// ─── Admin Force Set Balance ──────────────────────────────────────────────────

/**
 * Admin: forcefully set a user's wallet balance to an exact value.
 *
 * This bypasses credit limit checks — it is an admin override.
 * The amount parameter IS the desired new balance (can be negative).
 * Credit usage is recalculated based on the new balance.
 */
const setBalance = async (userId, targetBalance, reason, adminId) => {
    const newBalance = safeRound(Number(targetBalance));

    if (!Number.isFinite(newBalance)) {
        throw new BusinessRuleError('Target balance must be a valid number.', 'INVALID_AMOUNT');
    }

    if (Math.abs(newBalance) > MAX_ADJUSTMENT * 10) {
        throw new BusinessRuleError(
            `Target balance magnitude exceeds maximum (${MAX_ADJUSTMENT * 10}).`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));

    // Recalculate credit usage based on the new balance
    // If newBalance < 0, creditUsed = min(|newBalance|, creditLimit)
    const creditUsedAfter = newBalance < 0
        ? safeRound(Math.min(Math.abs(newBalance), creditLimit))
        : 0;

    // Atomic update
    await User.findByIdAndUpdate(userId, {
        $set: {
            walletBalance: newBalance,
            creditUsed: creditUsedAfter,
        },
    });

    // Determine transaction type based on direction
    const delta = safeRound(newBalance - balanceBefore);
    const txType = delta >= 0 ? TRANSACTION_TYPES.CREDIT : TRANSACTION_TYPES.DEBIT;

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: txType,
        amount: safeRound(Math.abs(delta)),
        balanceBefore,
        balanceAfter: newBalance,
        reference: null,
        status: 'COMPLETED',
        description: reason || `Admin set balance to ${newBalance} (${userCurrency})`,
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: {
            type: 'SET',
            targetBalance: newBalance,
            delta,
            currency: userCurrency,
            reason,
            userId,
            balanceBefore,
            balanceAfter: newBalance,
            creditUsedAfter,
            transactionId: transaction._id,
        },
    });

    return { transaction, user: { walletBalance: newBalance, creditUsed: creditUsedAfter } };
};

module.exports = {
    listWallets,
    getWallet,
    getTransactionHistory,
    addFunds,
    deductFunds,
    setBalance,
};
