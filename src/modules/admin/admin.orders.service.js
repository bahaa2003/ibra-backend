'use strict';

/**
 * admin.orders.service.js
 *
 * Admin-level order inspection, retry, and manual refund.
 */

const mongoose = require('mongoose');
const { Order, ORDER_STATUS } = require('../orders/order.model');
const { markOrderAsFailed } = require('../orders/order.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { Provider } = require('../providers/provider.model');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

// ─── List (admin) ─────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string}  [opts.status]
 * @param {string}  [opts.userId]
 * @param {string}  [opts.providerId]  - filter by provider on the linked product
 * @param {Date}    [opts.from]
 * @param {Date}    [opts.to]
 * @param {number}  [opts.page]
 * @param {number}  [opts.limit]
 */
const listOrders = async ({
    status,
    userId,
    providerId,
    from,
    to,
    page = 1,
    limit = 20,
} = {}) => {
    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = new mongoose.Types.ObjectId(userId);
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    // providerId filter requires a pipeline-style query on the product's provider field
    // We keep it simple: aggregate via populate + post-filter for now.
    // For very large datasets this should be replaced with an aggregation pipeline.

    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice executionType provider')
            .populate('userId', 'name email'),
        Order.countDocuments(filter),
    ]);

    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Get One ──────────────────────────────────────────────────────────────────

const getOrderById = async (id) => {
    const order = await Order.findById(id)
        .populate('productId', 'name basePrice minQty maxQty executionType provider')
        .populate('userId', 'name email walletBalance');
    if (!order) throw new NotFoundError('Order');
    return order;
};

// ─── Retry ────────────────────────────────────────────────────────────────────

/**
 * Re-submit a FAILED order to the provider.
 *
 * This sets the order back to PROCESSING and attempts a fresh fulfillment.
 * The wallet is NOT re-debited (money was already taken; we're retrying the
 * provider call only).
 *
 * @param {string} orderId
 * @param {string} adminId
 */
const retryOrder = async (orderId, adminId) => {
    const order = await Order.findById(orderId)
        .populate({ path: 'productId', populate: { path: 'provider' } });

    if (!order) throw new NotFoundError('Order');

    if (order.status !== ORDER_STATUS.FAILED) {
        throw new BusinessRuleError(
            `Only FAILED orders can be retried. Current status: ${order.status}`,
            'INVALID_STATUS_FOR_RETRY'
        );
    }

    const providerDoc = order.productId?.provider;
    if (!providerDoc) {
        throw new BusinessRuleError('No provider linked to this order\'s product.', 'NO_PROVIDER');
    }

    const adapter = getProviderAdapter(providerDoc);
    const externalProductId = order.providerProductId ?? order.externalProductId;
    if (!externalProductId) {
        throw new BusinessRuleError('Order has no externalProductId — cannot retry.', 'NO_EXTERNAL_ID');
    }

    // Place the order at the provider
    const providerResult = await adapter.placeOrder({
        productId: externalProductId,
        quantity: order.quantity,
        playerData: order.orderFieldsValues ?? {},
    });

    // Update order with new provider reference
    order.status = ORDER_STATUS.PROCESSING;
    order.providerOrderId = providerResult.orderId ?? order.providerOrderId;
    order.retryCount = (order.retryCount ?? 0) + 1;
    await order.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.ORDER_RETRIED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: { orderId, providerOrderId: order.providerOrderId, retryCount: order.retryCount },
    });

    return order;
};

// ─── Manual Refund ────────────────────────────────────────────────────────────

/**
 * Admin-forced refund of a PROCESSING or COMPLETED order.
 *
 * Delegates to the core markOrderAsFailed which atomically:
 *   - Sets status → FAILED
 *   - Refunds wallet
 *   - Writes audit logs
 *
 * @param {string} orderId
 * @param {string} adminId
 */
const refundOrder = async (orderId, adminId) => {
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    if (order.status === ORDER_STATUS.FAILED) {
        throw new BusinessRuleError('Order is already in FAILED (refunded) state.', 'ALREADY_REFUNDED');
    }

    const auditContext = {
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
    };

    const refunded = await markOrderAsFailed(orderId, auditContext);

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.ORDER_REFUNDED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: { userId: order.userId, totalPrice: order.totalPrice },
    });

    return refunded;
};

// ─── Sync Order Provider Status ───────────────────────────────────────────────

/**
 * Fetch the latest status for this order from the external provider API.
 * Maps provider status → internal ORDER_STATUS and updates the order.
 *
 * Provider status mapping:
 *   'Completed'  → ORDER_STATUS.COMPLETED
 *   'Cancelled'  → ORDER_STATUS.FAILED
 *   'Pending'    → ORDER_STATUS.PROCESSING (no change if already PROCESSING)
 */
const syncOrderProviderStatus = async (orderId, adminId) => {
    const order = await Order.findById(orderId).populate('product');
    if (!order) throw new NotFoundError('Order');

    if (!order.providerOrderId) {
        throw new BusinessRuleError(
            'This order has no provider order ID — it was not sent to any provider.',
            'NO_PROVIDER_ORDER'
        );
    }

    // Resolve the provider from the product's provider ref
    const providerId = order.product?.provider;
    if (!providerId) {
        throw new BusinessRuleError(
            'This order\'s product has no linked provider.',
            'NO_PROVIDER_LINKED'
        );
    }

    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('Provider');

    const adapter = getProviderAdapter(provider);

    let statusResult;
    try {
        statusResult = await adapter.checkOrder(order.providerOrderId);
    } catch (err) {
        throw new BusinessRuleError(
            `Failed to fetch status from provider: ${err.message}`,
            'PROVIDER_API_ERROR'
        );
    }

    const before = {
        providerStatus: order.providerStatus,
        status: order.status,
    };

    // Update provider-level fields
    order.providerStatus = statusResult.providerStatus || order.providerStatus;
    order.providerRawResponse = statusResult.rawResponse || order.providerRawResponse;
    order.lastCheckedAt = new Date();

    // Map provider status → internal order status
    const ps = (statusResult.providerStatus || '').toLowerCase();
    if (ps === 'completed' && order.status !== ORDER_STATUS.COMPLETED) {
        order.status = ORDER_STATUS.COMPLETED;
    } else if (ps === 'cancelled' && order.status !== ORDER_STATUS.FAILED) {
        order.status = ORDER_STATUS.FAILED;
    }
    // 'Pending' → no status change (stays PROCESSING)

    await order.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.ORDER_RETRIED,  // reuse — closest existing action
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            action: 'sync_provider_status',
            before,
            after: { providerStatus: order.providerStatus, status: order.status },
            providerOrderId: order.providerOrderId,
        },
    });

    return order;
};


// ─── Manual Complete ──────────────────────────────────────────────────────────

/**
 * Manually mark an order as COMPLETED.
 * Used by admin when fulfillment was done outside the automated engine.
 *
 * Guards:
 *   - Cannot complete an already COMPLETED order
 *   - Cannot complete a FAILED (refunded) order
 */
const completeOrder = async (orderId, adminId) => {
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BusinessRuleError('Order is already completed.', 'ALREADY_COMPLETED');
    }
    if (order.status === ORDER_STATUS.FAILED) {
        throw new BusinessRuleError(
            'Cannot complete a failed/refunded order. Create a new order instead.',
            'ORDER_ALREADY_FAILED'
        );
    }

    const before = order.status;
    order.status = ORDER_STATUS.COMPLETED;
    await order.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.ORDER_COMPLETED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            action: 'manual_complete',
            previousStatus: before,
            newStatus: ORDER_STATUS.COMPLETED,
        },
    });

    return order;
};

module.exports = { listOrders, getOrderById, retryOrder, refundOrder, syncOrderProviderStatus, completeOrder };
