'use strict';

/**
 * orderFulfillment.service.js
 *
 * Handles the post-payment provider fulfillment lifecycle.
 * Completely decoupled from order.service.js — called after the financial
 * transaction has committed, so no wallet/session logic lives here.
 *
 * Responsibilities:
 *   1. Call provider.placeOrder()      → executeOrder()
 *   2. Atomic idempotent refund        → refundFailedOrder()
 *   3. Process one status update       → processOrderStatusResult()
 *   4. Cron: batch-poll PROCESSING     → pollProcessingOrders()
 *
 * Design contract:
 *   - executeOrder() NEVER throws — returns result object, logs audit.
 *   - refundFailedOrder() is idempotent via the `refunded` boolean guard.
 *   - pollProcessingOrders() is idempotent — safe to run 1× per minute.
 */

const mongoose = require('mongoose');
const { Order, ORDER_STATUS, MAX_RETRY_COUNT } = require('../orders/order.model');
const { getExternalProductId } = require('../products/product.service');
const { refundWalletAtomic } = require('../wallet/wallet.service');
const { createAuditLog } = require('../audit/audit.service');
const { applyProviderMapping } = require('./orderFields.validator');
const {
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    PROVIDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { toInternalStatus, isTerminal, requiresRefund } = require('../providers/statusMapper');
const { User } = require('../users/user.model');
const { convertUsdToUserCurrency } = require('../../services/currencyConverter.service');

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENT REFUND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically refund a failed order exactly once.
 *
 * CROSS-CURRENCY SAFE:
 *   Uses order.usdAmount (the USD truth frozen at order time) and converts
 *   it to the user's CURRENT currency rate before crediting the wallet.
 *
 * Guard: the `refunded` boolean is set to true via a compare-and-swap
 * findOneAndUpdate so concurrent refund calls cannot double-credit the wallet.
 *
 * @param {Object} order  - Mongoose Order document
 * @returns {Promise<boolean>} true if refund was applied, false if already refunded
 */
const refundFailedOrder = async (order) => {
    // Compare-and-swap: only proceeds when refunded===false
    const swapped = await Order.findOneAndUpdate(
        { _id: order._id, refunded: false },
        { $set: { refunded: true } },
        { new: true }
    );

    if (!swapped) {
        // Already refunded by a concurrent call
        return false;
    }

    // Execute the wallet refund inside its own session
    const session = await mongoose.startSession();
    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        // ── Convert USD truth to user's CURRENT currency ─────────────────
        const userDoc = await User.findById(order.userId).select('currency').session(session);
        const currentCurrency = userDoc?.currency ?? 'USD';
        const usdAmount = order.usdAmount || 0;

        const conversion = await convertUsdToUserCurrency(usdAmount, currentCurrency);
        const refundAmount = conversion.finalAmount;

        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: refundAmount,
            creditUsedAmount: 0,
            reference: order._id,
            description: `Auto-refund: provider order ${order.providerOrderId ?? 'N/A'} failed (${usdAmount} USD → ${refundAmount} ${currentCurrency})`,
            session,
        });

        await session.commitTransaction();

        // Audit — fire-and-forget, after commit
        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                orderUsdAmount: usdAmount,
                originalCurrency: order.currency,
                refundCurrency: currentCurrency,
                refundRate: conversion.rate,
                refundAmount,
                currencyChanged: order.currency !== currentCurrency,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                usdAmount,
                refundCurrency: currentCurrency,
                refundAmount,
                reason: 'PROVIDER_ORDER_FAILED',
            },
        });

        return true;

    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        // Undo the refunded=true flag so the next retry can attempt again
        await Order.findByIdAndUpdate(order._id, { $set: { refunded: false } });
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const Provider = require('../providers/provider.model');
const { Product } = require('../products/product.model');

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE ORDER (called immediately after createOrder commits)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * executeOrder(orderId, provider?, auditContext?)
 *
 * Calls provider.placeOrder(), interprets the result, and updates the Order.
 *
 * Case A: success=true  + Completed  → COMPLETED
 * Case B: success=true  + Pending    → keep PROCESSING, save providerOrderId
 * Case C: success=true  + Cancelled  → FAILED + refund
 * Case D: success=false              → FAILED + refund
 *
 * If no provider adapter is passed, the function self-resolves it from
 * Product.provider. If that also fails, the order is marked FAILED + refund.
 *
 * This function NEVER throws — all errors are caught, the order is marked
 * FAILED, and a refund is attempted.
 *
 * @param {string|ObjectId} orderId
 * @param {Object|null}     [provider]      - adapter instance (null = self-resolve)
 * @param {Object|null}     [auditContext]
 * @returns {Promise<{ order: Order, placed: boolean, refunded: boolean }>}
 */
const executeOrder = async (orderId, provider = null, auditContext = null) => {
    // ─── TOP-LEVEL CRASH GUARD ─────────────────────────────────────────────
    // Wraps the entire function so ANY crash (parsing, DB, provider resolution)
    // marks the order FAILED + refund instead of leaving it stuck in PROCESSING.
    try {

    const order = await Order.findById(orderId)
        .populate('productId', 'name providerProduct providerMapping provider');
    if (!order) {
        console.error(`[Fulfillment] executeOrder: order ${orderId} not found`);
        return { order: null, placed: false, refunded: false };
    }

    // Guard: only attempt execution once
    if (order.status !== ORDER_STATUS.PROCESSING) {
        return { order, placed: false, refunded: false };
    }

    const actorId = auditContext?.actorId ?? order.userId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.SYSTEM;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;

    // ── Self-resolve provider adapter if none was passed ──────────────────
    let resolvedProvider = provider;
    if (!resolvedProvider) {
        try {
            const productProviderId = order.productId?.provider;
            if (!productProviderId) {
                throw new Error('Product has no Provider linked.');
            }
            const providerDoc = await Provider.findById(productProviderId);
            if (!providerDoc) {
                throw new Error(`Provider ${productProviderId} not found in DB.`);
            }
            if (!providerDoc.isActive) {
                throw new Error(`Provider '${providerDoc.name}' is inactive.`);
            }
            resolvedProvider = getProviderAdapter(providerDoc);
        } catch (resolveErr) {
            console.error(`[Fulfillment] Provider resolution failed for order ${orderId}:`, resolveErr.message);

            // Mark FAILED with clear diagnostic message
            const now = new Date();
            await Order.findByIdAndUpdate(orderId, {
                $set: {
                    status: ORDER_STATUS.FAILED,
                    providerRawResponse: { error: resolveErr.message },
                    failedAt: now,
                    lastCheckedAt: now,
                },
            });

            createAuditLog({
                actorId, actorRole, ipAddress, userAgent,
                action: ORDER_ACTIONS.FAILED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: orderId,
                metadata: { orderId: orderId.toString(), reason: 'PROVIDER_RESOLUTION_FAILED', error: resolveErr.message },
            });

            // Refund the user
            let refundIssued = false;
            try {
                const freshOrder = await Order.findById(orderId);
                refundIssued = await refundFailedOrder(freshOrder);
            } catch (refundErr) {
                console.error(`[Fulfillment] Refund FAILED for order ${orderId}:`, refundErr.message);
            }

            return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
        }
    }

    // ── Resolve externalProductId via the 3-layer chain ─────────────────────
    // Order → Platform Product → ProviderProduct → externalProductId
    let externalProductId = null;
    try {
        if (order.productId?._id) {
            externalProductId = await getExternalProductId(order.productId._id);
        }
    } catch (_) { /* non-fatal — fallback to productId below */ }

    // ── Build provider params from customerInput.values + providerMapping ───────
    // Convert internal field keys → provider-expected parameter names.
    // Falls back to identity mapping when no providerMapping is defined.
    const rawCustomerValues = order.customerInput?.values ?? {};
    const mappedCustomerFields = applyProviderMapping(
        rawCustomerValues,
        order.productId?.providerMapping ?? null
    );

    // ── Call the provider ──────────────────────────────────────────────────────
    console.log(`[Fulfillment] Placing order ${orderId} with provider…`);

    let result;
    try {
        result = await resolvedProvider.placeOrder({
            externalProductId: externalProductId ?? String(order.productId._id),
            quantity: order.quantity,
            ...mappedCustomerFields,   // ← spread translated customer fields onto params
        });
    } catch (err) {
        // placeOrder is designed to not throw, but be defensive
        result = {
            success: false,
            providerOrderId: null,
            providerStatus: 'Cancelled',
            rawResponse: { message: err.message },
            errorMessage: err.message,
        };
    }

    console.log(`[Fulfillment] Provider response for order ${orderId}:`, JSON.stringify(result));

    // ── Interpret result ───────────────────────────────────────────────────────
    let newStatus;
    let refundIssued = false;

    if (!result.success) {
        newStatus = ORDER_STATUS.FAILED;
    } else {
        try {
            newStatus = toInternalStatus(result.providerStatus);
        } catch (_) {
            newStatus = ORDER_STATUS.FAILED;
        }
    }

    // ── Persist the provider response onto the order ───────────────────────────
    const now = new Date();

    if (newStatus === ORDER_STATUS.FAILED) {
        await Order.findByIdAndUpdate(orderId, {
            $set: {
                status: ORDER_STATUS.FAILED,
                providerStatus: result.providerStatus,
                providerOrderId: result.providerOrderId,
                providerRawResponse: result.rawResponse,
                failedAt: now,
                lastCheckedAt: now,
            },
        });

        // Audit: placement failed
        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: PROVIDER_ACTIONS.ORDER_PLACE_FAILED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: {
                orderId: orderId.toString(),
                errorMessage: result.errorMessage,
                providerStatus: result.providerStatus,
                rawResponse: result.rawResponse,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.FAILED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: { orderId: orderId.toString(), reason: 'PROVIDER_REJECTED' },
        });

        // Refund
        try {
            const freshOrder = await Order.findById(orderId);
            refundIssued = await refundFailedOrder(freshOrder);
        } catch (refundErr) {
            console.error(`[Fulfillment] Refund FAILED for order ${orderId}:`, refundErr.message);
        }

        return { order: await Order.findById(orderId), placed: false, refunded: refundIssued };
    }

    if (newStatus === ORDER_STATUS.PROCESSING) {
        // Case B: pending — save providerOrderId, cron will poll
        await Order.findByIdAndUpdate(orderId, {
            $set: {
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
                providerRawResponse: result.rawResponse,
                lastCheckedAt: now,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: PROVIDER_ACTIONS.ORDER_PLACED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: orderId,
            metadata: {
                orderId: orderId.toString(),
                providerOrderId: result.providerOrderId,
                providerStatus: result.providerStatus,
            },
        });

        return { order: await Order.findById(orderId), placed: true, refunded: false };
    }

    // Case A: Completed immediately
    await Order.findByIdAndUpdate(orderId, {
        $set: {
            status: ORDER_STATUS.COMPLETED,
            providerOrderId: result.providerOrderId,
            providerStatus: result.providerStatus,
            providerRawResponse: result.rawResponse,
            lastCheckedAt: now,
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: PROVIDER_ACTIONS.ORDER_COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: orderId,
        metadata: {
            orderId: orderId.toString(),
            providerOrderId: result.providerOrderId,
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: ORDER_ACTIONS.COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: orderId,
        metadata: { orderId: orderId.toString() },
    });

    return { order: await Order.findById(orderId), placed: true, refunded: false };

    // ─── END OF TOP-LEVEL CRASH GUARD ──────────────────────────────────────
    } catch (fatalErr) {
        // Something completely unexpected crashed — mark FAILED + refund
        console.error(`[Fulfillment] FATAL crash in executeOrder for ${orderId}:`, fatalErr);

        try {
            const now = new Date();
            await Order.findByIdAndUpdate(orderId, {
                $set: {
                    status: ORDER_STATUS.FAILED,
                    providerRawResponse: { fatalError: fatalErr.message, stack: fatalErr.stack },
                    failedAt: now,
                    lastCheckedAt: now,
                },
            });

            const freshOrder = await Order.findById(orderId);
            if (freshOrder) {
                await refundFailedOrder(freshOrder);
            }
        } catch (cleanupErr) {
            console.error(`[Fulfillment] Cleanup also failed for ${orderId}:`, cleanupErr.message);
        }

        return { order: await Order.findById(orderId).catch(() => null), placed: false, refunded: false };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS ONE STATUS RESULT (shared between cron and manual check)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * processOrderStatusResult(order, statusResult)
 *
 * Given a fresh OrderStatusResult from the provider, update the local order.
 * Handles COMPLETED, CANCELLED (→ refund), and PENDING (→ increment retry).
 *
 * @param {Object} order        - Mongoose Order document (must be PROCESSING)
 * @param {Object} statusResult - { providerOrderId, providerStatus, rawResponse }
 * @returns {Promise<{ action: 'completed'|'failed'|'pending'|'skipped' }>}
 */
const processOrderStatusResult = async (order, statusResult) => {
    if (order.status !== ORDER_STATUS.PROCESSING) {
        return { action: 'skipped' };
    }

    const now = new Date();
    const providerStatus = statusResult.providerStatus;

    if (!isTerminal(providerStatus)) {
        // Still pending — bump retry count
        const newRetry = order.retryCount + 1;

        if (newRetry >= MAX_RETRY_COUNT) {
            // Exceeded retry limit → force-fail
            await Order.findByIdAndUpdate(order._id, {
                $set: {
                    status: ORDER_STATUS.FAILED,
                    providerStatus: providerStatus,
                    providerRawResponse: statusResult.rawResponse,
                    retryCount: newRetry,
                    failedAt: now,
                    lastCheckedAt: now,
                },
            });

            createAuditLog({
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
                action: PROVIDER_ACTIONS.RETRY_LIMIT_EXCEEDED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: {
                    orderId: order._id.toString(),
                    providerOrderId: order.providerOrderId,
                    retryCount: newRetry,
                },
            });

            createAuditLog({
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
                action: ORDER_ACTIONS.FAILED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: { orderId: order._id.toString(), reason: 'RETRY_LIMIT_EXCEEDED' },
            });

            const freshOrder = await Order.findById(order._id);
            await refundFailedOrder(freshOrder).catch((e) =>
                console.error(`[Fulfillment] Refund error (retry limit) for ${order._id}:`, e.message)
            );

            return { action: 'failed' };
        }

        // Not yet at limit — just update retry count and lastCheckedAt
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                retryCount: newRetry,
                lastCheckedAt: now,
            },
        });

        return { action: 'pending' };
    }

    // Terminal: Completed — no refund needed
    if (!requiresRefund(providerStatus)) {
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.COMPLETED,
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                lastCheckedAt: now,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: PROVIDER_ACTIONS.ORDER_COMPLETED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                status: providerStatus,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.COMPLETED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: { orderId: order._id.toString() },
        });

        return { action: 'completed' };
    }

    // ── Determine if this is CANCELED or PARTIAL ─────────────────────────
    const mappedStatus = toInternalStatus(providerStatus);

    if (mappedStatus === ORDER_STATUS.PARTIAL) {
        // ── PARTIAL: extract remains from provider response ──────────────
        const remainsStr = statusResult?.rawResponse?.remains
            || statusResult?.rawResponse?.data?.remains
            || '0';
        const remains = parseInt(remainsStr, 10) || 0;

        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.PARTIAL,
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                remains: remains,
                lastCheckedAt: now,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.PARTIAL_REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                status: providerStatus,
                remains,
                quantity: order.quantity,
            },
        });

        // Trigger partial refund via processOrderRefund
        const { processOrderRefund } = require('./order.service');
        try {
            await processOrderRefund(order._id, remains, {
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
            });
        } catch (e) {
            console.error(`[Fulfillment] Partial refund error for ${order._id}:`, e.message);
        }

        return { action: 'failed' };
    }

    if (mappedStatus === ORDER_STATUS.CANCELED) {
        // ── CANCELED: full refund ────────────────────────────────────────
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.CANCELED,
                providerStatus: providerStatus,
                providerRawResponse: statusResult.rawResponse,
                failedAt: now,
                lastCheckedAt: now,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: PROVIDER_ACTIONS.ORDER_CANCELLED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                orderId: order._id.toString(),
                providerOrderId: order.providerOrderId,
                status: providerStatus,
            },
        });

        createAuditLog({
            actorId: order.userId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: ORDER_ACTIONS.CANCELED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: { orderId: order._id.toString(), reason: 'PROVIDER_CANCELLED' },
        });

        // Trigger full refund via processOrderRefund
        const { processOrderRefund } = require('./order.service');
        try {
            await processOrderRefund(order._id, 0, {
                actorId: order.userId,
                actorRole: ACTOR_ROLES.SYSTEM,
            });
        } catch (e) {
            console.error(`[Fulfillment] Full refund error for ${order._id}:`, e.message);
        }

        return { action: 'failed' };
    }

    // ── FAILED (internal failures, rejected) — existing refund path ──────
    await Order.findByIdAndUpdate(order._id, {
        $set: {
            status: ORDER_STATUS.FAILED,
            providerStatus: providerStatus,
            providerRawResponse: statusResult.rawResponse,
            failedAt: now,
            lastCheckedAt: now,
        },
    });

    createAuditLog({
        actorId: order.userId,
        actorRole: ACTOR_ROLES.SYSTEM,
        action: PROVIDER_ACTIONS.ORDER_CANCELLED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            orderId: order._id.toString(),
            providerOrderId: order.providerOrderId,
            status: providerStatus,
        },
    });

    createAuditLog({
        actorId: order.userId,
        actorRole: ACTOR_ROLES.SYSTEM,
        action: ORDER_ACTIONS.FAILED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: { orderId: order._id.toString(), reason: 'PROVIDER_FAILED' },
    });

    const freshOrder = await Order.findById(order._id);
    await refundFailedOrder(freshOrder).catch((e) =>
        console.error(`[Fulfillment] Refund error (failed) for ${order._id}:`, e.message)
    );

    return { action: 'failed' };
};

// ─────────────────────────────────────────────────────────────────────────────
// CRON: POLL ALL PROCESSING ORDERS (batch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * pollProcessingOrders(provider)
 *
 * Called by the cron job every minute.
 * Finds all PROCESSING orders with a providerOrderId, batch-fetches their
 * status from the provider, then processes each result.
 *
 * Idempotent: safe to call concurrently because processOrderStatusResult uses
 * findByIdAndUpdate (not read-modify-write with save()).
 *
 * @param {Object} provider  - adapter instance
 * @returns {Promise<{
 *   checked: number,
 *   completed: number,
 *   failed: number,
 *   pending: number,
 *   errors: string[],
 * }>}
 */
const pollProcessingOrders = async (provider) => {
    const stats = { checked: 0, completed: 0, failed: 0, pending: 0, errors: [] };

    const processingOrders = await Order.find({
        status: ORDER_STATUS.PROCESSING,
        providerOrderId: { $ne: null },
    }).sort({ lastCheckedAt: 1 }).limit(200); // process oldest-checked first, cap at 200/run

    if (!processingOrders.length) {
        return stats;
    }

    stats.checked = processingOrders.length;
    console.log(`[FulfillmentCron] Checking ${processingOrders.length} PROCESSING order(s)…`);

    // Batch-fetch statuses
    const ids = processingOrders.map((o) => o.providerOrderId);
    let statusResults = [];

    try {
        statusResults = await provider.checkOrdersBatch(ids);
    } catch (err) {
        stats.errors.push(`Batch check failed: ${err.message}`);
        console.error('[FulfillmentCron] checkOrdersBatch error:', err.message);
        return stats;
    }

    // Build a map from providerOrderId → statusResult for O(1) lookup
    const resultMap = new Map(
        statusResults.map((r) => [r.providerOrderId, r])
    );

    // Process each order
    for (const order of processingOrders) {
        const statusResult = resultMap.get(order.providerOrderId);

        if (!statusResult) {
            // Provider didn't include this order in the response — skip this cycle
            stats.pending++;
            continue;
        }

        try {
            const { action } = await processOrderStatusResult(order, statusResult);
            if (action === 'completed') stats.completed++;
            else if (action === 'failed') stats.failed++;
            else stats.pending++;
        } catch (err) {
            stats.errors.push(`[${order._id}] ${err.message}`);
            console.error(`[FulfillmentCron] Error processing order ${order._id}:`, err.message);
        }
    }

    console.log(`[FulfillmentCron] Done. completed=${stats.completed} failed=${stats.failed} pending=${stats.pending} errors=${stats.errors.length}`);
    return stats;
};

module.exports = {
    executeOrder,
    refundFailedOrder,
    processOrderStatusResult,
    pollProcessingOrders,
};
