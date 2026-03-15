'use strict';

const mongoose = require('mongoose');
const { Product } = require('../products/product.model');
const { Provider } = require('../providers/provider.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('./order.model');
const { debitWalletAtomic, refundWalletAtomic } = require('../wallet/wallet.service');
const { calculateUserPrice } = require('./pricing.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { validateOrderFields } = require('./orderFields.validator');
const {
    NotFoundError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    PROVIDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { convertUsdToUserCurrency } = require('../../services/currencyConverter.service');
const { User } = require('../users/user.model');

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new order with full financial safety.
 *
 * For AUTOMATIC products (linked to a provider):
 *   - Order lands in PROCESSING status after the financial transaction commits.
 *   - executeOrder() is called fire-and-forget, so the HTTP response is
 *     returned to the client immediately with PROCESSING status.
 *   - The fulfillment engine handles provider call + result handling + refund.
 *
 * For MANUAL products:
 *   - Behaviour unchanged. Order lands in PENDING status (admin fulfils manually).
 *
 * @param {Object}      params
 * @param {ObjectId}    params.userId
 * @param {ObjectId}    params.productId
 * @param {number}      params.quantity
 * @param {string|null} params.idempotencyKey
 * @param {Object|null} params.auditContext
 * @param {Object|null} params.orderFieldsValues  - dynamic field values submitted by customer
 * @param {Object|null} params.provider           - adapter instance (injected for testability)
 */
const createOrder = async ({
    userId,
    productId,
    quantity,
    idempotencyKey = null,
    auditContext = null,
    orderFieldsValues = null,   // ← new param
    provider = null,   // ← injected; null = auto-resolve from factory
}) => {
    // ── Pre-transaction: Idempotency Check ───────────────────────────────────
    if (idempotencyKey) {
        const existing = await Order.findOne({ userId, idempotencyKey })
            .populate('productId', 'name basePrice executionType providerProduct');
        if (existing) {
            return { order: existing, idempotent: true };
        }
    }

    // ── Auto-resolve provider adapter (production flow) ──────────────────────
    // If no adapter was injected (i.e. called from HTTP controller), resolve
    // the adapter from the factory using the product's linked Provider doc.
    // Tests always inject their own mock, so this branch is never reached
    // in test runs.
    let resolvedProvider = provider;
    if (!resolvedProvider) {
        try {
            const prod = await Product.findById(productId)
                .select('executionType provider')
                .populate('provider');
            if (
                prod?.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC &&
                prod?.provider?._id
            ) {
                const providerDoc = prod.provider.toObject
                    ? prod.provider
                    : await Provider.findById(prod.provider);
                if (providerDoc?.isActive) {
                    resolvedProvider = getProviderAdapter(providerDoc);
                }
            }
        } catch (_) {
            // Non-fatal — fall back to manual (PENDING) if resolution fails
        }
    }

    return _attemptCreateOrder({ userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider: resolvedProvider });

};

/**
 * Internal helper — executes the transactional order creation.
 * Retried once on WriteConflict (code 112) or lock timeout (code 24).
 * @private
 */
const _attemptCreateOrder = async (
    { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider },
    isRetry = false
) => {

    const session = await mongoose.startSession();

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        // ── 1. Load & Validate Product ─────────────────────────────────────────
        const product = await Product.findById(productId).session(session);
        if (!product) throw new NotFoundError('Product');
        if (!product.isActive) {
            throw new BusinessRuleError('This product is currently unavailable.', 'PRODUCT_INACTIVE');
        }

        // ── 2. Validate Quantity Bounds ────────────────────────────────────────
        const qty = parseInt(quantity, 10);
        if (qty < product.minQty || qty > product.maxQty) {
            throw new BusinessRuleError(
                `Quantity must be between ${product.minQty} and ${product.maxQty}.`,
                'QUANTITY_OUT_OF_RANGE'
            );
        }

        // ── 2b. Validate dynamic order fields ─────────────────────────────────
        // Runs BEFORE any financial mutation so a bad field value costs nothing.
        let customerInput = null;
        if (product.orderFields && product.orderFields.length > 0) {
            // validateOrderFields throws BusinessRuleError on invalid input
            const { values, fieldsSnapshot } = validateOrderFields(
                product.orderFields,
                orderFieldsValues
            );
            customerInput = { values, fieldsSnapshot };
        }

        // ── 3. Pricing Engine (USD) ────────────────────────────────────────────
        const pricing = await calculateUserPrice(userId, product.basePrice, session);
        const usdTotalPrice = parseFloat((pricing.finalPrice * qty).toFixed(2));

        // ── 3b. Currency Conversion ────────────────────────────────────────────
        // Fetch the user's preferred currency (within the session for consistency).
        // For USD users this is a no-op (rate = 1, finalAmount = usdTotalPrice).
        const userDoc = await User.findById(userId).select('currency').session(session);
        const userCurrency = userDoc?.currency ?? 'USD';
        const conversion = await convertUsdToUserCurrency(usdTotalPrice, userCurrency);
        const chargedAmount = conversion.finalAmount;   // in user currency
        const rateSnapshot = conversion.rate;

        // ── 4. Atomic Debit (in user currency) ────────────────────────────────
        const { walletDeducted, creditUsedAmount } = await debitWalletAtomic({
            userId,
            amount: chargedAmount,     // ← wallet always in user currency
            reference: null,
            description: `Payment for: ${product.name} x${qty}`,
            session,
        });

        // ── 5. Determine initial status & execution type ───────────────────────
        // An AUTOMATIC product with a real provider injected → PROCESSING
        // Any other case                                      → PENDING
        const isAutomatic = (
            product.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC &&
            provider !== null
        );
        const initialStatus = isAutomatic ? ORDER_STATUS.PROCESSING : ORDER_STATUS.PENDING;

        // ── 6. Create Order ────────────────────────────────────────────────────
        const orderData = {
            userId,
            productId: product._id,
            quantity: qty,
            basePriceSnapshot: pricing.basePrice,
            markupPercentageSnapshot: pricing.markupPercentage,
            finalPriceCharged: pricing.finalPrice,
            groupIdSnapshot: pricing.groupId,
            unitPrice: pricing.finalPrice,
            totalPrice: chargedAmount,   // legacy field — now equals chargedAmount
            walletDeducted,
            creditUsedAmount,
            status: initialStatus,
            executionType: product.executionType,
            customerInput,
            // ── Currency snapshot ────────────────────────────────────────────
            currency: userCurrency,
            rateSnapshot,
            usdAmount: usdTotalPrice,
            chargedAmount,
        };
        if (idempotencyKey) orderData.idempotencyKey = idempotencyKey;

        let order;
        try {
            [order] = await Order.create([orderData], { session });
        } catch (createErr) {
            if (createErr.code === 11000 && idempotencyKey) {
                await session.abortTransaction();
                session.endSession();
                const existing = await Order.findOne({ userId, idempotencyKey })
                    .populate('productId', 'name basePrice executionType providerProduct');
                return { order: existing, idempotent: true };
            }
            throw createErr;
        }

        // ── 7. Commit ──────────────────────────────────────────────────────────
        await session.commitTransaction();

        await order.populate([{ path: 'productId', select: 'name basePrice executionType providerProduct' }]);

        // ── 8. Audit: AFTER commit — fire-and-forget ───────────────────────────
        const actorId = auditContext?.actorId ?? userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.CREATED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId,
                productId: product._id,
                quantity: qty,
                usdAmount: usdTotalPrice,
                currency: userCurrency,
                rateSnapshot,
                chargedAmount,
                walletDeducted,
                creditUsedAmount,
                basePriceSnapshot: pricing.basePrice,
                markupPercentageSnapshot: pricing.markupPercentage,
                finalPriceCharged: pricing.finalPrice,
                status: initialStatus,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.DEBIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: userId,
            metadata: {
                orderId: order._id,
                usdAmount: usdTotalPrice,
                currency: userCurrency,
                rateSnapshot,
                chargedAmount,
                walletDeducted,
                creditUsedAmount,
            },
        });

        // ── 9. Trigger provider fulfillment (fire-and-forget) ──────────────────
        if (isAutomatic) {
            createAuditLog({
                actorId, actorRole, ipAddress, userAgent,
                action: ORDER_ACTIONS.PROCESSING,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: { orderId: order._id.toString(), status: ORDER_STATUS.PROCESSING },
            });

            // Lazy-require to avoid circular dependency issues
            const { executeOrder } = require('./orderFulfillment.service');

            // Fire-and-forget — client gets PROCESSING response immediately
            executeOrder(order._id, provider, auditContext).catch((err) => {
                console.error(`[Order] executeOrder failed for ${order._id}:`, err.message);
            });
        }

        return { order, idempotent: false };

    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }

        if ((err.code === 112 || err.code === 24) && !isRetry) {
            session.endSession();
            await new Promise((r) => setTimeout(r, 10));
            return _attemptCreateOrder(
                { userId, productId, quantity, idempotencyKey, auditContext, orderFieldsValues, provider },
                true
            );

        }

        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// MARK ORDER AS FAILED (REFUND) — manual admin action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark an order as FAILED and issue a REFUND.
 * Double-refund prevention via TWO independent guards:
 *   Guard 1 — status check:    order.status === 'FAILED'  → already failed
 *   Guard 2 — timestamp check: order.refundedAt !== null  → already refunded
 */
const markOrderAsFailed = async (orderId, auditContext = null) => {
    const session = await mongoose.startSession();

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        const order = await Order.findById(orderId).session(session);
        if (!order) throw new NotFoundError('Order');

        if (order.status === ORDER_STATUS.FAILED) {
            throw new BusinessRuleError(
                'This order has already been marked as failed.',
                'ORDER_ALREADY_FAILED'
            );
        }

        if (order.refundedAt !== null) {
            throw new BusinessRuleError(
                'A refund has already been issued for this order.',
                'ALREADY_REFUNDED'
            );
        }

        order.status = ORDER_STATUS.FAILED;
        order.failedAt = new Date();
        order.refundedAt = new Date();
        order.refunded = true;
        await order.save({ session });

        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: order.walletDeducted,
            creditUsedAmount: order.creditUsedAmount,
            reference: order._id,
            description: `Refund for failed order #${order._id}`,
            session,
        });

        await session.commitTransaction();

        // Audit — AFTER commit
        const actorId = auditContext?.actorId ?? order.userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId: order.userId,
                walletDeducted: order.walletDeducted,
                creditUsedAmount: order.creditUsedAmount,
                totalRefunded: parseFloat((order.walletDeducted + order.creditUsedAmount).toFixed(2)),
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                walletDeducted: order.walletDeducted,
                creditUsedAmount: order.creditUsedAmount,
            },
        });

        return order;
    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// MARK ORDER AS COMPLETED
// ─────────────────────────────────────────────────────────────────────────────

const markOrderAsCompleted = async (orderId) => {
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    if (order.status !== ORDER_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot complete an order with status '${order.status}'.`,
            'INVALID_STATUS_TRANSITION'
        );
    }

    order.status = ORDER_STATUS.COMPLETED;
    await order.save();
    return order;
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

const listOrdersForUser = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice executionType'),
        Order.countDocuments({ userId }),
    ]);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const listAllOrders = async ({ page = 1, limit = 20, status } = {}) => {
    const filter = status ? { status } : {};
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice')
            .populate('userId', 'name email'),
        Order.countDocuments(filter),
    ]);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const getOrderById = async (orderId, userId = null) => {
    const filter = { _id: orderId };
    if (userId) filter.userId = userId;

    const order = await Order.findOne(filter)
        .populate('productId', 'name basePrice minQty maxQty executionType')
        .populate('userId', 'name email');

    if (!order) throw new NotFoundError('Order');
    return order;
};

module.exports = {
    createOrder,
    markOrderAsFailed,
    markOrderAsCompleted,
    listOrdersForUser,
    listAllOrders,
    getOrderById,
};
