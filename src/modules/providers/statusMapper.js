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
 * provider-specific raw strings from Royal Crown, Toros, and Alkasr
 * as defensive aliases.
 *
 * @private
 */
const _MAP = {
    // ── COMPLETED ────────────────────────────────────────────────────────────
    completed:   ORDER_STATUS.COMPLETED,
    complete:    ORDER_STATUS.COMPLETED,
    success:     ORDER_STATUS.COMPLETED,
    done:        ORDER_STATUS.COMPLETED,
    accept:      ORDER_STATUS.COMPLETED,
    accepted:    ORDER_STATUS.COMPLETED,
    ok:          ORDER_STATUS.COMPLETED,
    delivered:   ORDER_STATUS.COMPLETED,
    fulfilled:   ORDER_STATUS.COMPLETED,

    // ── PROCESSING (still in-flight, keep polling) ──────────────────────────
    processing:    ORDER_STATUS.PROCESSING,
    in_progress:   ORDER_STATUS.PROCESSING,
    'in progress': ORDER_STATUS.PROCESSING,
    inprogress:    ORDER_STATUS.PROCESSING,
    in_process:    ORDER_STATUS.PROCESSING,
    running:       ORDER_STATUS.PROCESSING,
    active:        ORDER_STATUS.PROCESSING,

    // ── PENDING (queued, not started yet) ────────────────────────────────────
    pending:   ORDER_STATUS.PROCESSING,   // providers say "Pending" when they mean "working on it"
    queued:    ORDER_STATUS.PROCESSING,
    wait:      ORDER_STATUS.PROCESSING,
    waiting:   ORDER_STATUS.PROCESSING,
    awaiting:  ORDER_STATUS.PROCESSING,
    new:       ORDER_STATUS.PROCESSING,
    created:   ORDER_STATUS.PROCESSING,

    // ── PARTIAL (treat as COMPLETED — partial delivery is still delivered) ───
    partial:              ORDER_STATUS.COMPLETED,
    partially_completed:  ORDER_STATUS.COMPLETED,
    partial_complete:     ORDER_STATUS.COMPLETED,

    // ── FAILED ──────────────────────────────────────────────────────────────
    cancelled:  ORDER_STATUS.FAILED,
    canceled:   ORDER_STATUS.FAILED,
    cancel:     ORDER_STATUS.FAILED,
    failed:     ORDER_STATUS.FAILED,
    fail:       ORDER_STATUS.FAILED,
    error:      ORDER_STATUS.FAILED,
    rejected:   ORDER_STATUS.FAILED,
    reject:     ORDER_STATUS.FAILED,
    refunded:   ORDER_STATUS.FAILED,
    expired:    ORDER_STATUS.FAILED,
};

/**
 * Convert a provider status string to the internal ORDER_STATUS constant.
 *
 * Defensive: if the status is not recognised, logs a warning and
 * falls back to PROCESSING (so the order keeps getting polled rather
 * than crashing the pipeline).
 *
 * @param {string} providerStatus   - raw string from the provider API
 * @returns {string}                - one of ORDER_STATUS values
 */
const toInternalStatus = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    const internal = _MAP[key];
    if (!internal) {
        console.warn(`[statusMapper] Unknown provider status: '${providerStatus}' — defaulting to PROCESSING`);
        return ORDER_STATUS.PROCESSING;
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
    const mapped = toInternalStatus(providerStatus);
    return mapped === ORDER_STATUS.COMPLETED || mapped === ORDER_STATUS.FAILED;
};

/**
 * Returns true when the provider status requires issuing a wallet refund.
 *
 * @param {string} providerStatus
 * @returns {boolean}
 */
const requiresRefund = (providerStatus) => {
    const key = String(providerStatus ?? '').toLowerCase().trim();
    return key === 'cancelled' || key === 'canceled' || key === 'cancel'
        || key === 'failed'    || key === 'fail'     || key === 'error'
        || key === 'reject'    || key === 'rejected'  || key === 'refunded'
        || key === 'expired';
};

module.exports = { PROVIDER_STATUS, toInternalStatus, isTerminal, requiresRefund };
