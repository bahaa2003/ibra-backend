'use strict';

const mongoose = require('mongoose');
const { Product, computeFinalPrice } = require('../products/product.model');
const { Provider } = require('../providers/provider.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('./order.model');
const { getNextSequence } = require('./counter.model');
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
const {
    notifyOrderCompleted,
    notifyOrderCreated,
    notifyOrderFailed,
    notifyOrderRefunded,
} = require('../notifications/notification.events');
const { getLivePrice, invalidate: invalidatePriceCache } = require('../providers/providerPriceCache');
const { toDecimal, toStr, toFiat, multiply, subtract, add, isPositive, compare } = require('../../shared/utils/decimalPrecision');
const { escapeRegex } = require('../../shared/utils/escapeRegex');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// JIT PRICE AUTO-UPDATE HELPER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Fire-and-forget: update the product's providerPrice, basePrice, and
 * finalPrice when a JIT check detects the provider has raised the price.
 *
 * Uses the same formula as the sync engine (providerProductSync.service.js)
 * so prices remain consistent.
 *
 * Runs OUTSIDE any transaction â€” it is OK if this fails; the next sync
 * cycle will correct it anyway. The important thing is that the ORDER
 * was already aborted.
 *
 * @param {ObjectId}           productId
 * @param {number}             newProviderPrice   - live rawPrice from provider
 * @param {'percentage'|'fixed'} markupType
 * @param {number}             markupValue
 * @private
 */
const _autoUpdateProductPrice = (productId, newProviderPrice, markupType, markupValue) => {
    // Intentionally NOT awaited â€” fire-and-forget
    (async () => {
        try {
            const safeProviderPrice = String(newProviderPrice);
            const newFinalPrice = computeFinalPrice(safeProviderPrice, markupType, markupValue);
            const newBasePrice = newFinalPrice ?? safeProviderPrice;

            await Product.findByIdAndUpdate(productId, {
                $set: {
                    providerPrice: safeProviderPrice,
                    finalPrice: newFinalPrice,
                    basePrice: newBasePrice,
                },
            });
        } catch (err) {
            // Swallow â€” the sync engine will correct this on its next run.
            // A failed auto-update must never crash the process.
        }
    })();
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CREATE ORDER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
 * @param {Object|null} params.customerInput       - pre-validated dynamic field input
 * @param {Object|null} params.provider           - adapter instance (injected for testability)
 */
const createOrder = async ({
    userId,
    productId,
    quantity,
    idempotencyKey = null,
    auditContext = null,
    orderFieldsValues = null,   // â† new param
    provider = null,   // â† injected; null = auto-resolve from factory
    customerInput = null,
}) => {
    // â”€â”€ Pre-transaction: Idempotency Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (idempotencyKey) {
        const existing = await Order.findOne({ userId, idempotencyKey })
            .populate('productId', 'name basePrice executionType providerProduct');
        if (existing) {
            return { order: existing, idempotent: true };
        }
    }

    // â”€â”€ Auto-resolve provider adapter (production flow) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // If no adapter was injected (i.e. called from HTTP controller), resolve
    // the adapter from the factory using the product's linked Provider doc.
    // Tests always inject their own mock, so this branch is never reached
    // in test runs.
    let resolvedProvider = provider;

    // providerCode is the canonical slug/name snapshot written to the Order.
    // The cron uses this field â€” NOT the product â€” so a later admin provider
    // swap cannot corrupt in-flight PROCESSING orders.
    let providerCode = null;

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

                // â”€â”€ Snapshot the provider code UNCONDITIONALLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // providerCode must be captured even when the provider is
                // inactive â€” the code identifies which provider the order
                // belongs to for admin review / DLQ.  The adapter is only
                // obtained when the provider is active.
                if (providerDoc) {
                    providerCode = String(providerDoc.slug || providerDoc.name || '')
                        .toLowerCase().trim() || null;
                }

                if (providerDoc?.isActive) {
                    resolvedProvider = getProviderAdapter(providerDoc);
                } else {
                    console.warn(`[Order] Provider ${prod.provider._id} is INACTIVE â€” fulfillment will self-resolve.`);
                }
            }
        } catch (resolveErr) {
            // Log instead of silently swallowing â€” critical for debugging
            console.error(`[Order] Provider resolution failed for product ${productId}:`, resolveErr.message);
            // resolvedProvider stays null â€” executeOrder will self-resolve
            // providerCode may have been set before the error; if not, the
            // fallback inside _attemptCreateOrder will try again.
        }
    }

    return _attemptCreateOrder({
        userId,
        productId,
        quantity,
        idempotencyKey,
        auditContext,
        orderFieldsValues,
        customerInput,
        provider: resolvedProvider,
        providerCode,
    });

};

/**
 * Internal helper â€” executes the transactional order creation.
 * Retried once on WriteConflict (code 112) or lock timeout (code 24).
 * @private
 */
const _attemptCreateOrder = async (
    {
        userId,
        productId,
        quantity,
        idempotencyKey,
        auditContext,
        orderFieldsValues,
        customerInput: validatedCustomerInput = null,
        provider,
        providerCode = null,
    },
    isRetry = false
) => {

    const session = await mongoose.startSession();

    // â”€â”€ 0. Assign sequential order number (OUTSIDE txn) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Auto-increment counters are intentionally non-transactional (same as
    // PostgreSQL sequences / MySQL AUTO_INCREMENT). A wasted number on
    // abort is acceptable. Running inside snapshot-isolation would fail
    // because the session can't see counter docs created after its snapshot.
    const orderNumber = await getNextSequence('orderNumber', 9999);

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        // â”€â”€ 1. Load & Validate Product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const product = await Product.findById(productId).session(session);
        if (!product) throw new NotFoundError('Product');
        if (!product.isActive) {
            throw new BusinessRuleError('This product is currently unavailable.', 'PRODUCT_INACTIVE');
        }

        // â”€â”€ 2. Validate Quantity Bounds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const qty = parseInt(quantity, 10);
        if (qty < product.minQty || qty > product.maxQty) {
            throw new BusinessRuleError(
                `Quantity must be between ${product.minQty} and ${product.maxQty}.`,
                'QUANTITY_OUT_OF_RANGE'
            );
        }

        // â”€â”€ 2b. Validate / capture dynamic order fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Runs BEFORE any financial mutation so a bad field value costs nothing.
        //
        // If the product defines formal orderFields, validate against them.
        // Otherwise, pass through raw values so that link/target/etc. still
        // reach the provider (critical for SMM-panel services).
        let customerInput = validatedCustomerInput;
        if (!customerInput && product.orderFields && product.orderFields.length > 0) {
            // validateOrderFields throws BusinessRuleError on invalid input
            const { values, fieldsSnapshot } = validateOrderFields(
                product.orderFields,
                orderFieldsValues
            );
            customerInput = { values, fieldsSnapshot };
        } else if (!customerInput && orderFieldsValues && typeof orderFieldsValues === 'object' && Object.keys(orderFieldsValues).length > 0) {
            // No formal schema â€” save raw values so the fulfillment engine
            // can forward them to the provider (e.g. { link: '...' }).
            customerInput = { values: orderFieldsValues, fieldsSnapshot: [] };
        }

        // â”€â”€ 2c. JIT Provider Price Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        //
        // If this product is linked to a provider, verify the provider's live
        // price hasn't increased since the last catalog sync.  This prevents
        // selling at a loss when a provider raises prices between sync cycles.
        //
        // Performance: uses an in-memory cache (5-min TTL) so the full catalog
        // is fetched at most once per provider per TTL window.
        //
        // Fault-tolerant: if the provider API is unreachable, the order
        // proceeds with the cached DB price.  A transient outage should NOT
        // block legitimate orders.
        //
        if (product.provider && product.providerProduct && provider) {
            try {
                // Look up the externalProductId from the linked ProviderProduct
                const ppDoc = await ProviderProduct.findById(product.providerProduct)
                    .select('externalProductId')
                    .lean();

                if (ppDoc?.externalProductId) {
                    const livePrice = await getLivePrice(
                        String(product.provider),
                        ppDoc.externalProductId,
                        provider
                    );

                    if (livePrice !== null && product.providerPrice != null) {
                        // Use decimal.js for lossless comparison (prices are 50dp strings)
                        if (compare(String(livePrice), String(product.providerPrice)) > 0) {
                            // â”€â”€ Price increased â€” abort order, auto-update DB â”€â”€
                            _autoUpdateProductPrice(product._id, livePrice, product.markupType, product.markupValue);
                            invalidatePriceCache(String(product.provider));

                            throw new BusinessRuleError(
                                'The provider has increased the price for this service. ' +
                                'The catalog has been automatically updated. ' +
                                'Please refresh and review the new price before ordering.',
                                'PROVIDER_PRICE_INCREASED'
                            );
                        }
                    }
                }
            } catch (jitErr) {
                // Re-throw our own BusinessRuleError (price increase abort)
                if (jitErr.code === 'PROVIDER_PRICE_INCREASED') throw jitErr;
                // Swallow all other errors (API timeout, network failure, etc.)
                // â€” proceed with the cached DB price rather than blocking the order.
            }
        }

        // â”€â”€ 3. Pricing Engine (USD) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const pricing = await calculateUserPrice(userId, product.basePrice, session);
        const usdTotalPrice = multiply(pricing.finalPrice, String(qty));

        // â”€â”€ 3a. Profit Calculation (USD) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Profit = markup portion only = (markedUpPrice - basePrice) Ã— quantity
        const profitUsd = multiply(subtract(pricing.finalPrice, pricing.basePrice), String(qty));

        // â”€â”€ 3b. Currency Conversion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Fetch the user's preferred currency (within the session for consistency).
        // For USD users this is a no-op (rate = 1, finalAmount = usdTotalPrice).
        const userDoc = await User.findById(userId).select('currency').session(session);
        const userCurrency = userDoc?.currency ?? 'USD';
        const conversion = await convertUsdToUserCurrency(Number(toDecimal(usdTotalPrice).toNumber()), userCurrency);
        // â”€â”€ FINAL ROUNDING â€” only place we round to 2dp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const chargedAmount = toFiat(conversion.finalAmount);
        const rateSnapshot = conversion.rate;

        // â”€â”€ 3c. FINAL PRICE GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Prevent NaN / Infinity / zero from reaching the wallet debit.
        if (!Number.isFinite(chargedAmount) || chargedAmount <= 0) {
            throw new BusinessRuleError(
                'Invalid order price calculation. The final charged amount must be a positive number. ' +
                `(basePrice=${pricing.basePrice}, markup=${pricing.markupPercentage}%, ` +
                `usdTotal=${usdTotalPrice}, currency=${userCurrency}, rate=${rateSnapshot}, ` +
                `chargedAmount=${chargedAmount})`,
                'INVALID_PRICE_CALCULATION'
            );
        }

        const orderId = new mongoose.Types.ObjectId();

        // â”€â”€ 4. Atomic Debit (in user currency) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const { walletDeducted, creditUsedAmount } = await debitWalletAtomic({
            userId,
            amount: chargedAmount,     // â† wallet always in user currency
            reference: orderId,
            description: `Payment for: ${product.name} x${qty}`,
            session,
        });

        // â”€â”€ 5. Determine initial status & execution type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // An AUTOMATIC product â†’ PROCESSING (fulfillment attempted post-commit)
        // Any other case        â†’ PENDING   (admin handles manually)
        const isAutomatic = product.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC;
        const isManualOrder = (
            product.executionType === ORDER_EXECUTION_TYPES.MANUAL ||
            !product.provider ||
            !product.providerProduct
        );
        const initialStatus = isAutomatic ? ORDER_STATUS.PROCESSING : ORDER_STATUS.PENDING;

        // â”€â”€ 6. Create Order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const orderData = {
            _id: orderId,
            userId,
            productId: product._id,
            orderNumber,
            quantity: qty,
            basePriceSnapshot: pricing.basePrice,
            markupPercentageSnapshot: pricing.markupPercentage,
            finalPriceCharged: pricing.finalPrice,
            groupIdSnapshot: pricing.groupId,
            profitUsd: profitUsd,
            unitPrice: pricing.finalPrice,
            totalPrice: String(chargedAmount),   // legacy field â€” now equals chargedAmount
            walletDeducted,
            creditUsedAmount,
            status: initialStatus,
            executionType: product.executionType,
            customerInput,
            // â”€â”€ Provider code snapshot (immutable â€” cron uses this, not product.provider) â”€â”€
            providerCode: providerCode ?? null,
            // â”€â”€ Currency snapshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€ 8. Commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        await session.commitTransaction();

        await order.populate([{ path: 'productId', select: 'name basePrice executionType providerProduct' }]);

        // â”€â”€ 9. Audit: AFTER commit â€” fire-and-forget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€ 10. Trigger provider fulfillment (fire-and-forget) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Always fires for AUTOMATIC products. executeOrder self-resolves the
        // provider adapter if none was pre-resolved, and handles all failures
        // (marks FAILED + refunds the wallet).
        notifyOrderCreated(order, { manualReview: isManualOrder });

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

            // Fire-and-forget â€” client gets PROCESSING response immediately.
            // Pass provider if we have one; executeOrder self-resolves if null.
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
                {
                    userId,
                    productId,
                    quantity,
                    idempotencyKey,
                    auditContext,
                    orderFieldsValues,
                    customerInput: validatedCustomerInput,
                    provider,
                    providerCode,
                },
                true
            );

        }

        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MARK ORDER AS FAILED (REFUND) â€” manual admin action
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Mark an order as FAILED and issue a REFUND.
 *
 * CROSS-CURRENCY SAFE:
 *   The refund uses order.usdAmount (the USD truth frozen at order time)
 *   and converts it to the user's CURRENT currency rate. This prevents
 *   the bug where a currency change between order and refund causes
 *   the wrong numeric amount to be credited.
 *
 * Double-refund prevention via TWO independent guards:
 *   Guard 1 â€” status check:    order.status === 'FAILED'  â†’ already failed
 *   Guard 2 â€” timestamp check: order.refundedAt !== null  â†’ already refunded
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

        // â”€â”€ Refund amount â€” use the EXACT amounts originally deducted â”€â”€â”€â”€â”€â”€â”€â”€
        // NEVER do a live currency conversion here. Exchange rates fluctuate.
        // The user must receive back exactly what was taken from their wallet.
        //
        // Source of truth (frozen at order creation):
        //   walletDeducted   â€“ amount taken from the wallet balance
        //   creditUsedAmount â€“ amount taken from the credit line
        //   chargedAmount    â€“ total (walletDeducted + creditUsed), fallback
        const walletPortion = Number(order.walletDeducted || 0);
        const creditPortion = Number(order.creditUsedAmount || 0);

        // Fallback: if both split fields are 0 but chargedAmount exists,
        // treat chargedAmount as a pure wallet charge (legacy orders).
        const refundWallet = walletPortion > 0 ? walletPortion : Number(order.chargedAmount || 0);
        const refundCredit = creditPortion;
        const totalRefund = refundWallet + refundCredit;

        if (totalRefund <= 0) {
            throw new BusinessRuleError(
                'Order has no charged amount to refund.',
                'NO_REFUNDABLE_AMOUNT'
            );
        }

        // â”€â”€ Update order status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        order.status = ORDER_STATUS.FAILED;
        order.failedAt = new Date();
        order.refundedAt = new Date();
        order.refunded = true;
        await order.save({ session });

        // â”€â”€ Credit the wallet with the exact original amounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: refundWallet,
            creditUsedAmount: refundCredit,
            reference: order._id,
            description: `Refund for failed order #${order.orderNumber || order._id} (${totalRefund} ${order.currency || 'USD'})`,
            session,
        });

        await session.commitTransaction();

        // â”€â”€ Audit â€” AFTER commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                currency: order.currency,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                originalChargedAmount: order.chargedAmount,
                originalWalletDeducted: order.walletDeducted,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                currency: order.currency,
            },
        });

        notifyOrderFailed(order, {
            source: 'manual_refund',
            reason: 'MANUAL_REFUND',
            notifyUser: false,
        });
        notifyOrderRefunded(order, {
            refundAmount: totalRefund,
            currency: order.currency,
            source: 'manual_refund',
            reason: 'MANUAL_REFUND',
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

// -----------------------------------------------------------------------------
// PROCESS ORDER REFUND - CANCELED (full) & PARTIAL (proportional)
// -----------------------------------------------------------------------------

/**
 * Process a refund for an order that was CANCELED or PARTIAL.
 *
 * FULL REFUND (remains === 0, status CANCELED):
 *   refundAmount = order.chargedAmount
 *
 * PARTIAL REFUND (remains > 0, status PARTIAL):
 *   refundAmount = Math.floor((remains / order.quantity) * order.chargedAmount)
 *
 * Uses the ORIGINAL chargedAmount (what the user paid at order time) -
 * NOT live USD conversion. If they paid 100 EGP, max refund is 100 EGP.
 *
 * Idempotency: if order.refunded === true, throws ALREADY_REFUNDED.
 *
 * @param {string|ObjectId} orderId
 * @param {number}          remains      - undelivered units (0 = full refund)
 * @param {Object|null}     auditContext - { actorId, actorRole, ipAddress?, userAgent? }
 * @returns {Promise<Order>}
 */
const processOrderRefund = async (orderId, remains = 0, auditContext = null) => {
    const session = await mongoose.startSession();

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        const order = await Order.findById(orderId).session(session);
        if (!order) throw new NotFoundError('Order');

        // Idempotency guard
        if (order.refunded === true) {
            throw new BusinessRuleError(
                'A refund has already been issued for this order.',
                'ALREADY_REFUNDED'
            );
        }

        // Calculate refund amount
        const chargedAmount = Number(order.chargedAmount || order.walletDeducted || 0);
        if (chargedAmount <= 0) {
            throw new BusinessRuleError(
                'Order has no charged amount to refund.',
                'NO_REFUNDABLE_AMOUNT'
            );
        }

        const remainsCount = Math.max(0, parseInt(remains, 10) || 0);
        const isPartial = remainsCount > 0 && remainsCount < order.quantity;

        let refundAmount;
        if (isPartial) {
            // Proportional refund based on undelivered quantity
            refundAmount = Math.floor((remainsCount / order.quantity) * chargedAmount);
        } else {
            // Full refund
            refundAmount = chargedAmount;
        }

        if (refundAmount <= 0) {
            throw new BusinessRuleError(
                'Calculated refund amount is zero or negative.',
                'INVALID_REFUND_AMOUNT'
            );
        }

        // Update order state before wallet mutation for idempotency.
        order.refunded = true;
        order.refundedAt = new Date();
        if (isPartial) {
            order.remains = remainsCount;
        }
        await order.save({ session });

        // Atomic wallet refund
        const description = isPartial
            ? `Partial refund for Order #${order.orderNumber} (Remains: ${remainsCount}/${order.quantity})`
            : `Full refund for Order #${order.orderNumber}`;

        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: refundAmount,
            creditUsedAmount: 0,
            reference: order._id,
            description,
            session,
        });

        await session.commitTransaction();

        // Audit after commit (fire-and-forget)
        const actorId = auditContext?.actorId ?? order.userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.SYSTEM;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        const auditAction = isPartial
            ? ORDER_ACTIONS.PARTIAL_REFUNDED
            : ORDER_ACTIONS.REFUNDED;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: auditAction,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId: order.userId,
                orderNumber: order.orderNumber,
                chargedAmount,
                refundAmount,
                remains: remainsCount,
                quantity: order.quantity,
                isPartial,
                currency: order.currency,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                refundAmount,
                currency: order.currency,
                reason: isPartial ? 'PARTIAL_DELIVERY' : 'ORDER_CANCELED',
            },
        });

        notifyOrderRefunded(order, {
            refundAmount,
            currency: order.currency,
            source: auditContext?.notificationSource || (isPartial ? 'partial_refund' : 'order_refund'),
            reason: auditContext?.notificationReason || (isPartial ? 'PARTIAL_DELIVERY' : 'ORDER_CANCELED'),
            providerRejected: auditContext?.providerRejected === true,
            partial: isPartial,
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

// -----------------------------------------------------------------------------
// MARK ORDER AS COMPLETED
// -----------------------------------------------------------------------------

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
    notifyOrderCompleted(order, { source: 'manual_service' });
    return order;
};

// -----------------------------------------------------------------------------
// QUERIES
// -----------------------------------------------------------------------------

const listOrdersForUser = async (userId, {
    page = 1,
    limit = 20,
    search,
    status,
    from,
    to,
} = {}) => {
    const skip = (page - 1) * limit;
    const filter = { userId };
    const normalizedStatus = String(status ?? '').trim().toLowerCase();
    const customerStatusGroups = {
        processing: [ORDER_STATUS.PENDING, ORDER_STATUS.PROCESSING],
        completed: [ORDER_STATUS.COMPLETED],
        incomplete: [ORDER_STATUS.FAILED, ORDER_STATUS.CANCELED, ORDER_STATUS.PARTIAL],
        manual_review: [ORDER_STATUS.MANUAL_REVIEW],
    };
    if (normalizedStatus && normalizedStatus !== 'all') {
        const statuses = customerStatusGroups[normalizedStatus] || [normalizedStatus.toUpperCase()];
        filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        // The UI submits date-only values from its date picker. Preserve the
        // previous inclusive end-date behavior instead of stopping at midnight.
        const normalizedTo = String(to ?? '').trim();
        if (to) filter.createdAt.$lte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(normalizedTo)
            ? `${normalizedTo}T23:59:59.999`
            : normalizedTo);
    }
    const normalizedSearch = String(search ?? '').trim();
    if (normalizedSearch) {
        const regex = new RegExp(escapeRegex(normalizedSearch), 'i');
        const matchingProducts = await Product.find({ $or: [{ name: regex }, { description: regex }] }).select('_id').lean();
        const conditions = [
            { providerOrderId: regex },
            { providerCode: regex },
            { 'customerInput.values.playerId': regex },
            { 'customerInput.values.player_id': regex },
            { 'customerInput.values.uid': regex },
            { 'customerInput.values.userId': regex },
            { 'customerInput.values.username': regex },
        ];
        if (matchingProducts.length) conditions.push({ productId: { $in: matchingProducts.map((product) => product._id) } });
        if (mongoose.isValidObjectId(normalizedSearch)) conditions.push({ _id: new mongoose.Types.ObjectId(normalizedSearch) });
        if (/^\d+$/.test(normalizedSearch)) {
            conditions.push({ orderNumber: Number(normalizedSearch) });
        }
        conditions.push({
            $expr: {
                $regexMatch: {
                    input: { $toString: '$orderNumber' },
                    regex: escapeRegex(normalizedSearch),
                },
            },
        });
        filter.$or = conditions;
    }
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name image basePrice executionType'),
        Order.countDocuments(filter),
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
    processOrderRefund,
    markOrderAsCompleted,
    listOrdersForUser,
    listAllOrders,
    getOrderById,
};
