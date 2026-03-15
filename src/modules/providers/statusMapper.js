'use strict';

/**
 * statusMapper.js
 *
 * Translates raw provider status strings into internal ORDER_STATUS values.
 *
 * ─── Provider vocabulary → Internal platform status ───────────────────────────
 *
 * Royal Crown / Torosfon Store (canonical)
 *   "Completed"            →  COMPLETED
 *   "Pending"              →  PROCESSING
 *   "Cancelled"            →  FAILED
 *
 * Torosfon-specific raw values (adapter normalises these, listed here as fallback)
 *   "completed", "success", "done"               →  COMPLETED
 *   "processing", "pending", "queued"             →  PROCESSING
 *   "failed", "rejected", "error", "cancelled"   →  FAILED
 *
 * Alkasr VIP-specific raw values (adapter normalises too; listed as fallback)
 *   "accept", "accepted"               →  COMPLETED
 *   "wait", "waiting", "in_process"    →  PROCESSING
 *   "reject", "rejected"               →  FAILED
 *
 * Case-insensitive lookup so minor API inconsistencies don't crash the engine.
 */

const { ORDER_STATUS } = require('../orders/order.model');

/**
 * Raw strings the provider may return for order status.
 * These are the CANONICAL values that all adapters must normalise to.
 */
const PROVIDER_STATUS = Object.freeze({
    COMPLETED: 'Completed',
    PENDING: 'Pending',
    CANCELLED: 'Cancelled',
});

/**
 * Map keyed by lowercase provider status → internal ORDER_STATUS.
 *
 * Includes canonical values (Completed / Pending / Cancelled) plus
 * provider-specific raw strings from Toros and Alkasr as defensive aliases.
 * Adapters always normalise before returning, so these aliases exist
 * purely as a safety net.
 *
 * @private
 */
const _MAP = {
    // ── Canonical (Royal Crown / Toros normalised output) ─────────────────────
    completed: ORDER_STATUS.COMPLETED,
    pending: ORDER_STATUS.PROCESSING,
    cancelled: ORDER_STATUS.FAILED,
    // defensive spelling variants
    canceled: ORDER_STATUS.FAILED,
    failed: ORDER_STATUS.FAILED,

    // ── Torosfon Store raw status strings ─────────────────────────────────────
    success: ORDER_STATUS.COMPLETED,
    done: ORDER_STATUS.COMPLETED,
    processing: ORDER_STATUS.PROCESSING,
    in_progress: ORDER_STATUS.PROCESSING,
    queued: ORDER_STATUS.PROCESSING,
    rejected: ORDER_STATUS.FAILED,
    error: ORDER_STATUS.FAILED,

    // ── Alkasr VIP raw status strings ─────────────────────────────────────────
    accept: ORDER_STATUS.COMPLETED,
    accepted: ORDER_STATUS.COMPLETED,
    wait: ORDER_STATUS.PROCESSING,
    waiting: ORDER_STATUS.PROCESSING,
    in_process: ORDER_STATUS.PROCESSING,
    reject: ORDER_STATUS.FAILED,
    cancel: ORDER_STATUS.FAILED,
};

/**
 * Convert a provider status string to the internal ORDER_STATUS constant.
 *
 * @param {string} providerStatus   - raw string from the provider API
 * @returns {string}                - one of ORDER_STATUS values
 * @throws {Error}                  - if the status is not recognised
 */
const toInternalStatus = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    const internal = _MAP[key];
    if (!internal) {
        throw new Error(`[statusMapper] Unknown provider status: '${providerStatus}'`);
    }
    return internal;
};

/**
 * Returns true when the provider status means the order is definitively finished
 * (either successfully or cancelled) and no more polling is needed.
 *
 * @param {string} providerStatus
 * @returns {boolean}
 */
const isTerminal = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    return key === 'completed' || key === 'cancelled' || key === 'canceled' || key === 'failed'
        // Alkasr accept/reject
        || key === 'accept' || key === 'accepted' || key === 'reject' || key === 'rejected'
        // Toros
        || key === 'success' || key === 'done' || key === 'error';
};

/**
 * Returns true when the provider status requires issuing a wallet refund.
 *
 * @param {string} providerStatus
 * @returns {boolean}
 */
const requiresRefund = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    return key === 'cancelled' || key === 'canceled' || key === 'failed'
        // Alkasr reject
        || key === 'reject' || key === 'rejected' || key === 'cancel'
        // Toros
        || key === 'error';
};

module.exports = { PROVIDER_STATUS, toInternalStatus, isTerminal, requiresRefund };
