'use strict';

/**
 * pricing.service.js — Pure Pricing Engine
 * ─────────────────────────────────────────
 * All functions here are pure where possible (no side effects, no DB).
 * calculateUserPrice is the only one that touches the DB.
 *
 * Single source of truth for markup math — used by order.service.js
 * at order creation time to produce the price snapshots burned into
 * each Order document.
 */

const { User } = require('../users/user.model');
const Group = require('../groups/group.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');

// ─────────────────────────────────────────────────────────────────────────────
// PURE CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the final price after applying a group markup percentage.
 *
 * Rules:
 *  - basePrice must be >= 0
 *  - percentage must be >= 0
 *  - finalPrice = basePrice + (basePrice × percentage / 100)
 *  - Result is rounded to 2 decimal places (financial rounding via toFixed)
 *
 * This is intentionally a PURE function — no DB access, no side effects.
 * Safe to call in tests without any DB connection.
 *
 * @param {number} basePrice   - Raw product price (>= 0)
 * @param {number} percentage  - Group markup percentage (>= 0)
 * @returns {number} finalPrice with full precision (rounding deferred to final charge)
 * @throws {BusinessRuleError} if inputs are invalid
 */
const calculateFinalPrice = (basePrice, percentage) => {
    if (typeof basePrice !== 'number' || basePrice < 0) {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }
    if (typeof percentage !== 'number' || percentage < 0) {
        throw new BusinessRuleError(
            'percentage must be a non-negative number.',
            'INVALID_PERCENTAGE'
        );
    }

    const markup = basePrice * (percentage / 100);
    // Retain full precision — do NOT round here. Rounding happens at the
    // final chargedAmount step in order.service.js so micro-prices (e.g.
    // $0.0002/unit × 10000 qty) are not prematurely zeroed out.
    return basePrice + markup;
};

// ─────────────────────────────────────────────────────────────────────────────
// DB-BACKED CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the effective price for a specific user by looking up their
 * group's markup percentage, then applying calculateFinalPrice.
 *
 * This is called at order creation time. The result is immediately snapshotted
 * into the Order document — the group or percentage can change afterwards
 * with NO effect on existing orders.
 *
 * @param {string|ObjectId} userId    - The buying user's ID
 * @param {number}          basePrice - Product's base price
 * @param {Object}          [session] - Optional Mongoose session (for transactions)
 * @returns {Promise<{
 *   basePrice:        number,
 *   markupPercentage: number,
 *   finalPrice:       number,
 *   groupId:          ObjectId
 * }>}
 */
const calculateUserPrice = async (userId, basePrice, session = null) => {
    // Load user with groupId populated so we get percentage in one round-trip
    const query = User.findById(userId).populate('groupId', 'name percentage isActive');
    if (session) query.session(session);
    const user = await query;

    if (!user) throw new NotFoundError('User');

    if (!user.groupId) {
        throw new BusinessRuleError(
            'User is not assigned to any pricing group. Contact an administrator.',
            'NO_GROUP_ASSIGNED'
        );
    }

    const group = user.groupId; // already populated

    if (!group.isActive) {
        throw new BusinessRuleError(
            `User's pricing group '${group.name}' is inactive. Contact an administrator.`,
            'GROUP_INACTIVE'
        );
    }

    // Safe casting — prevent NaN if group.percentage is undefined or non-numeric
    const markupPercentage = Number.isFinite(Number(group.percentage))
        ? Number(group.percentage)
        : 0;

    // Safe casting — prevent NaN if basePrice is somehow non-numeric
    const safeBasePrice = Number.isFinite(Number(basePrice)) ? Number(basePrice) : 0;

    const finalPrice = calculateFinalPrice(safeBasePrice, markupPercentage);

    return {
        basePrice,
        markupPercentage,
        finalPrice,
        groupId: group._id,
    };
};

module.exports = { calculateFinalPrice, calculateUserPrice };
