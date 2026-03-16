'use strict';

/**
 * product.service.js  (Layer 3 — Platform Products)
 *
 * Admin-controlled catalogue of products exposed to users.
 * This is the ONLY layer users ever interact with — they never see
 * ProviderProducts or raw provider data.
 *
 * Flow:
 *   User places order
 *     → Platform Product  (Layer 3 — this service)
 *     → ProviderProduct   (Layer 2)
 *     → Provider API      (Layer 1, via adapter)
 *
 * Key responsibilities:
 *   - CRUD for platform products (manual + provider-linked)
 *   - Publish a ProviderProduct as a platform product (admin flow)
 *   - Override name, price, qty, image at publish time
 *   - Compute finalPrice = providerPrice + markup
 *   - If pricingMode=sync: basePrice auto-tracks providerPrice on each sync
 *   - Toggle active / deactivate
 */

const { Product, PRICING_MODES, MARKUP_TYPES, computeFinalPrice } = require('./product.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const {
    NotFoundError,
    ConflictError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');

// =============================================================================
// USER-FACING QUERIES
// =============================================================================

/**
 * listProducts({ activeOnly, page, limit })
 *
 * Public-facing product list. Returns only active products for customers;
 * admins pass activeOnly=false to see everything.
 */
const listProducts = async ({ activeOnly = true, page = 1, limit = 50 } = {}) => {
    const filter = activeOnly ? { isActive: true } : {};
    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort({ displayOrder: 1, name: 1 })
            .skip(skip)
            .limit(limit)
            .populate('provider', 'name slug')
            .populate('providerProduct', 'rawName externalProductId'),
        Product.countDocuments(filter),
    ]);

    return {
        products,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * getProductById(id)
 * Throws NotFoundError if missing.
 */
const getProductById = async (id) => {
    const product = await Product.findById(id)
        .populate('provider', 'name slug baseUrl isActive')
        .populate('providerProduct', 'rawName externalProductId rawPrice lastSyncedAt');
    if (!product) throw new NotFoundError('Product');
    return product;
};

// =============================================================================
// ADMIN — MANUAL PRODUCT CREATION (no provider link)
// =============================================================================

/**
 * createProduct(params, adminUserId)
 *
 * Create a standalone platform product with no provider linkage.
 * Used when admin wants full manual control over all aspects.
 */
const createProduct = async ({
    name,
    description = null,
    basePrice,
    minQty,
    maxQty,
    category = null,
    image = null,
    displayOrder = 0,
    isActive = true,
    executionType = 'manual',
    orderFields = [],       // ← dynamic order form fields
    providerMapping = {},   // ← internal key → provider param name map
}, adminUserId = null) => {
    const existing = await Product.findOne({ name: new RegExp(`^${name}$`, 'i') });
    if (existing) throw new ConflictError(`A product named '${name}' already exists.`);

    if (Number(maxQty) < Number(minQty)) {
        throw new BusinessRuleError('maxQty must be >= minQty.', 'INVALID_QTY_RANGE');
    }

    return Product.create({
        name,
        description,
        basePrice: parseFloat(parseFloat(basePrice).toFixed(6)),
        minQty,
        maxQty,
        category,
        image,
        displayOrder,
        isActive,
        executionType,
        orderFields,
        providerMapping,
        createdBy: adminUserId,
    });
};


// =============================================================================
// ADMIN — PUBLISH FROM PROVIDER PRODUCT (3-layer flow)
// =============================================================================

/**
 * publishFromProviderProduct(params, adminUserId)
 *
 * Admin selects a ProviderProduct and publishes it as a public Platform Product.
 *
 * Rules:
 *   - ProviderProduct must exist and its Provider must be active.
 *   - One ProviderProduct → at most one Platform Product (enforced here).
 *   - Admin may override name, qty bounds, image, and all pricing fields.
 *   - markupType + markupValue → finalPrice = providerPrice + markup
 *   - If pricingMode=sync: basePrice is immediately set from providerPrice+markup
 *     and will auto-update on each future sync.
 *   - executionType defaults to 'automatic' (provider-linked products are
 *     usually auto-fulfilled).
 *
 * @returns {Promise<Product>}
 */
const publishFromProviderProduct = async ({
    providerProductId,
    name,
    description = null,
    basePrice = null,            // used when pricingMode=manual and no markup
    minQty = null,
    maxQty = null,
    category = null,
    image = null,
    displayOrder = 0,
    isActive = true,
    pricingMode = PRICING_MODES.MANUAL,
    markupType = MARKUP_TYPES.PERCENTAGE,
    markupValue = 0,
    executionType = 'automatic',
    createdBy = null,            // accepted here for the createProductFromProvider alias
}, adminUserId = null) => {
    // Resolve createdBy from either param location
    const resolvedCreatedBy = createdBy ?? adminUserId;

    // ── Validate ProviderProduct ───────────────────────────────────────────────
    const pp = await ProviderProduct.findById(providerProductId).populate('provider');
    if (!pp) throw new NotFoundError('ProviderProduct');
    if (!pp.provider.isActive) {
        throw new BusinessRuleError(
            'The provider for this product is currently inactive.',
            'PROVIDER_INACTIVE'
        );
    }
    if (!pp.isActive) {
        throw new BusinessRuleError(
            'Cannot publish an inactive provider product.',
            'PROVIDER_PRODUCT_INACTIVE'
        );
    }

    // ── Prevent duplicate publish ─────────────────────────────────────────────
    const alreadyPublished = await Product.findOne({ providerProduct: providerProductId });
    if (alreadyPublished) {
        throw new ConflictError(
            `ProviderProduct '${pp.rawName}' has already been published as '${alreadyPublished.name}'.`
        );
    }

    // ── Compute pricing ───────────────────────────────────────────────────────
    // Fallback: if rawPrice is 0 but rawPayload has the real price, use that
    const effectiveRawPrice = Number(pp.rawPrice || pp.rawPayload?.product_price || 0) || 0;
    const providerPrice = parseFloat(effectiveRawPrice.toFixed(6));

    let resolvedFinalPrice;
    let resolvedBasePrice;

    if (pricingMode === PRICING_MODES.SYNC) {
        // Compute from providerPrice + markup; basePrice tracks it forever
        resolvedFinalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
        resolvedBasePrice = resolvedFinalPrice ?? providerPrice;
    } else {
        // Manual — admin either supplies basePrice directly OR markup is applied one-time
        if (markupValue > 0) {
            resolvedFinalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
            resolvedBasePrice = resolvedFinalPrice ?? providerPrice;
        } else if (basePrice != null) {
            resolvedBasePrice = parseFloat(parseFloat(basePrice).toFixed(6));
            resolvedFinalPrice = resolvedBasePrice;
        } else {
            resolvedBasePrice = providerPrice;
            resolvedFinalPrice = providerPrice;
        }
    }

    // Guard: if computed price is 0 but admin supplied a valid basePrice, use it
    if (resolvedBasePrice <= 0 && basePrice != null && parseFloat(basePrice) > 0) {
        resolvedBasePrice = parseFloat(parseFloat(basePrice).toFixed(6));
        resolvedFinalPrice = resolvedBasePrice;
    }

    return Product.create({
        name,
        description,
        basePrice: resolvedBasePrice,
        providerPrice,
        finalPrice: resolvedFinalPrice,
        minQty: minQty ?? pp.minQty,
        maxQty: maxQty ?? pp.maxQty,
        category,
        image,
        displayOrder,
        isActive,
        pricingMode,
        markupType,
        markupValue,
        executionType,
        provider: pp.provider._id,
        providerProduct: pp._id,
        createdBy: resolvedCreatedBy,
    });
};

// =============================================================================
// ADMIN — UPDATE PUBLISHED PRODUCT
// =============================================================================

/**
 * updateProduct(productId, updates, adminUserId?)
 *
 * Admin modifies a published product.
 *
 * Safe fields (all optional):
 *   name, description, image, category, displayOrder, isActive,
 *   basePrice, minQty, maxQty, pricingMode, markupType, markupValue, executionType
 *
 * Pricing rules on update:
 *   - If pricingMode changes to 'sync' AND providerProduct is linked:
 *       recompute basePrice from current providerPrice + markup immediately.
 *   - If markupType or markupValue changes while in 'sync' pricingMode:
 *       recompute basePrice immediately.
 *   - In 'manual' pricingMode: basePrice is whatever admin sets.
 *
 * @returns {Promise<Product>}
 */
const updateProduct = async (productId, updates) => {
    const product = await Product.findById(productId).populate('providerProduct', 'rawPrice');
    if (!product) throw new NotFoundError('Product');

    const ALLOWED = [
        'name', 'description', 'image', 'category', 'displayOrder', 'isActive',
        'basePrice', 'minQty', 'maxQty', 'pricingMode', 'markupType', 'markupValue',
        'executionType', 'orderFields', 'providerMapping',   // ← both field schemas updatable
    ];
    const safe = Object.fromEntries(
        Object.entries(updates).filter(([k]) => ALLOWED.includes(k))
    );

    // Detect if we need to recompute pricing
    const effectivePricingMode = safe.pricingMode ?? product.pricingMode;
    const effectiveMarkupType = safe.markupType ?? product.markupType;
    const effectiveMarkupValue = safe.markupValue ?? product.markupValue;
    const switchingToSync = safe.pricingMode === PRICING_MODES.SYNC
        && product.pricingMode !== PRICING_MODES.SYNC;
    const markupChanged = (safe.markupType != null || safe.markupValue != null)
        && effectivePricingMode === PRICING_MODES.SYNC;

    if ((switchingToSync || markupChanged) && product.providerProduct) {
        const rawPrice = parseFloat(product.providerProduct.rawPrice.toFixed(6));
        const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
        safe.providerPrice = rawPrice;
        safe.finalPrice = newFinalPrice;
        safe.basePrice = newFinalPrice ?? rawPrice;
    }

    Object.assign(product, safe);
    await product.save();
    return product.populate([
        { path: 'provider', select: 'name slug' },
        { path: 'providerProduct', select: 'rawName externalProductId rawPrice' },
    ]);
};

// =============================================================================
// ADMIN — TOGGLE STATUS
// =============================================================================

const toggleProductStatus = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new NotFoundError('Product');
    product.isActive = !product.isActive;
    await product.save();
    return product;
};

// =============================================================================
// INTERNAL — ORDER FULFILLMENT HELPER
// =============================================================================

/**
 * getExternalProductId(productId)
 *
 * Resolves the externalProductId for a Platform Product.
 * Used by the fulfillment engine to know what ID to send to the provider.
 *
 * Chain: Order.productId → Product.providerProduct → ProviderProduct.externalProductId
 *
 * @param {string|ObjectId} productId — Platform Product _id
 * @returns {Promise<string|null>} externalProductId, or null if not provider-linked
 */
const getExternalProductId = async (productId) => {
    const product = await Product.findById(productId)
        .select('providerProduct')
        .populate('providerProduct', 'externalProductId');
    return product?.providerProduct?.externalProductId ?? null;
};

module.exports = {
    listProducts,
    getProductById,
    createProduct,
    publishFromProviderProduct,
    updateProduct,
    toggleProductStatus,
    getExternalProductId,

    // Canonical alias names used by admin catalog API
    createProductFromProvider: publishFromProviderProduct,  // prompt-specified name
    toggleProduct: toggleProductStatus,                     // prompt-specified name
};

