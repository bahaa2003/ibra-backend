'use strict';

/**
 * admin.catalog.controller.js
 *
 * Thin HTTP adapter for the provider catalog admin endpoints.
 *
 * Responsibilities:
 *   - Trigger provider product syncs
 *   - Browse raw provider products (Layer 2)
 *   - Create / update / toggle platform products (Layer 3)
 *   - List platform products for the admin dashboard
 *
 * No business logic here — all work is delegated to services.
 */

const mongoose = require('mongoose');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { escapeRegex } = require('../../shared/utils/escapeRegex');

const catalogService = require('../providers/providerCatalog.service');
const providerService = require('../providers/provider.service');
const ppService = require('../providers/providerProduct.service');
const productService = require('../products/product.service');
const { ProviderProduct } = require('../providers/providerProduct.model');
const {
    AuthorizationError,
    BusinessRuleError,
    NotFoundError,
} = require('../../shared/errors/AppError');
const {
    getSensitivePricingFieldNames,
    isSupervisorRole,
    sanitizePricingForSupervisor,
} = require('../../shared/utils/priceVisibility');

const SUPERVISOR_SAFE_PRODUCT_UPDATE_FIELDS = new Set([
    'name',
    'nameAr',
    'description',
    'descriptionAr',
    'image',
    'category',
    'categoryId',
    'displayOrder',
    'isActive',
    'status',
]);

const SUPERVISOR_ADMIN_PRODUCT_PRICE_FIELDS = new Set([
    'finalPrice',
    'sellingPrice',
    'displayPrice',
    'markedUpPriceUSD',
    'displayCurrency',
    'usdAmount',
    'priceCoins',
    'basePrice',
    'basePriceCoins',
    'providerPrice',
    'rawPrice',
    'price',
]);

const PROVIDER_LINK_FIELDS = new Set([
    'providerId',
    'supplierId',
    'providerProductId',
    'externalProductId',
]);

const assertSupervisorDoesNotSubmitPricing = (req) => {
    if (!isSupervisorRole(req.user)) return;

    const fields = getSensitivePricingFieldNames(req.body);
    if (!fields.length) return;

    throw new AuthorizationError(
        `Supervisors cannot modify internal pricing or provider fields: ${fields.join(', ')}.`
    );
};

const assertSupervisorOnlySubmitsSafeProductMetadata = (req) => {
    if (!isSupervisorRole(req.user)) return;

    const fields = Object.keys(req.body || {});
    const unsafeFields = fields.filter((field) => !SUPERVISOR_SAFE_PRODUCT_UPDATE_FIELDS.has(field));
    if (!unsafeFields.length) return;

    throw new AuthorizationError(
        `Supervisors can only update safe product metadata fields. Blocked fields: ${unsafeFields.join(', ')}.`
    );
};

const assertAdminOnlyProductMutation = (req, action) => {
    if (!isSupervisorRole(req.user)) return;
    throw new AuthorizationError(`Supervisors cannot ${action} products.`);
};

const assertProviderLinkPayloadOnly = (req) => {
    const fields = Object.keys(req.body || {});
    const unsafeFields = fields.filter((field) => !PROVIDER_LINK_FIELDS.has(field));
    if (!unsafeFields.length) return;

    throw new AuthorizationError(
        `Provider linking only accepts providerId and providerProductId. Blocked fields: ${unsafeFields.join(', ')}.`
    );
};

const assertEmptyPayload = (req, action) => {
    const fields = Object.keys(req.body || {});
    if (!fields.length) return;

    throw new AuthorizationError(`${action} does not accept request body fields: ${fields.join(', ')}.`);
};

const isObjectIdLike = (value) => (
    value
    && typeof value === 'object'
    && (
        value._bsontype === 'ObjectID'
        || value._bsontype === 'ObjectId'
        || typeof value.toHexString === 'function'
    )
);

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || '').trim());

const toPlainCatalogValue = (value) => {
    if (value && typeof value.toObject === 'function') {
        return value.toObject({
            getters: true,
            virtuals: false,
            flattenMaps: true,
        });
    }

    return value;
};

const getSafeCurrentLinkageSummary = (product) => {
    const plainProduct = toPlainCatalogValue(product) || {};
    const provider = toPlainCatalogValue(plainProduct.provider);
    const providerProduct = toPlainCatalogValue(plainProduct.providerProduct);
    const providerObject = provider && typeof provider === 'object' && !isObjectIdLike(provider)
        ? provider
        : {};
    const providerProductObject = providerProduct && typeof providerProduct === 'object' && !isObjectIdLike(providerProduct)
        ? providerProduct
        : {};
    const currentProviderName = String(providerObject.name || '').trim();
    const currentProviderProductName = String(
        providerProductObject.translatedName
        || providerProductObject.rawName
        || ''
    ).trim();
    const linkageMode = String(plainProduct.executionType || '').trim() || null;
    const hasProviderRef = Boolean(plainProduct.provider);
    const hasProviderProductRef = Boolean(plainProduct.providerProduct);

    return {
        currentProviderName,
        currentProviderProductName,
        linkageMode,
        isLinked: Boolean(hasProviderRef || hasProviderProductRef || currentProviderName || currentProviderProductName),
        currentProviderProductActive: providerProductObject.isActive === undefined
            ? null
            : providerProductObject.isActive !== false,
        currentProviderMinQty: providerProductObject.minQty ?? null,
        currentProviderMaxQty: providerProductObject.maxQty ?? null,
    };
};

const addSupervisorCurrentLinkageSummary = (payload) => {
    if (Array.isArray(payload)) {
        return payload.map(addSupervisorCurrentLinkageSummary);
    }

    const plainPayload = toPlainCatalogValue(payload);
    if (
        !plainPayload
        || typeof plainPayload !== 'object'
        || plainPayload instanceof Date
        || Buffer.isBuffer(plainPayload)
        || isObjectIdLike(plainPayload)
    ) {
        return plainPayload;
    }

    return {
        ...plainPayload,
        ...getSafeCurrentLinkageSummary(plainPayload),
    };
};

const stripSupervisorAdminProductPriceFields = (payload) => {
    if (Array.isArray(payload)) {
        return payload.map(stripSupervisorAdminProductPriceFields);
    }

    if (
        !payload
        || typeof payload !== 'object'
        || payload instanceof Date
        || Buffer.isBuffer(payload)
        || isObjectIdLike(payload)
    ) {
        return payload;
    }

    return Object.entries(payload).reduce((result, [key, value]) => {
        if (SUPERVISOR_ADMIN_PRODUCT_PRICE_FIELDS.has(key)) {
            return result;
        }

        result[key] = stripSupervisorAdminProductPriceFields(value);
        return result;
    }, {});
};

const sanitizeAdminProductResponse = (payload, user) => {
    const source = isSupervisorRole(user)
        ? addSupervisorCurrentLinkageSummary(payload)
        : payload;
    const sanitized = sanitizePricingForSupervisor(source, user);
    return isSupervisorRole(user)
        ? stripSupervisorAdminProductPriceFields(sanitized)
        : sanitized;
};

const sanitizeProviderOption = (provider) => ({
    id: String(provider?._id || provider?.id || ''),
    name: String(provider?.name || '').trim(),
    isActive: provider?.isActive !== false,
});

const sanitizeProviderProductOption = (providerProduct) => ({
    id: String(providerProduct?._id || providerProduct?.id || ''),
    name: String(providerProduct?.translatedName || providerProduct?.rawName || '').trim(),
    providerName: String(providerProduct?.provider?.name || '').trim(),
    categoryLabel: null,
    minQty: providerProduct?.minQty ?? null,
    maxQty: providerProduct?.maxQty ?? null,
    isActive: providerProduct?.isActive !== false,
});

const resolveProviderLinkPayload = (body = {}) => {
    const providerId = String(body.providerId || body.supplierId || '').trim();
    const providerProductId = String(body.providerProductId || body.externalProductId || '').trim();

    if (!providerId || !providerProductId || !isValidObjectId(providerId) || !isValidObjectId(providerProductId)) {
        throw new BusinessRuleError(
            'Valid providerId and providerProductId are required.',
            'INVALID_PROVIDER_LINK'
        );
    }

    return { providerId, providerProductId };
};

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * POST /admin/catalog/sync/:providerId
 * Manually trigger a sync for a single provider.
 */
const syncProvider = catchAsync(async (req, res) => {
    assertAdminOnlyProductMutation(req, 'sync provider pricing for');
    const result = await catalogService.syncProviderProducts(req.params.providerId);
    sendSuccess(res, result, 'Provider sync completed.');
});

/**
 * POST /admin/catalog/sync
 * Trigger sync for ALL active providers.
 */
const syncAll = catchAsync(async (req, res) => {
    assertAdminOnlyProductMutation(req, 'sync provider pricing for');
    const results = await catalogService.syncAllProviders();
    sendSuccess(res, results, 'All provider syncs completed.');
});

// ── Raw Provider Products (Layer 2) ───────────────────────────────────────────

/**
 * GET /admin/provider-products
 * Browse ALL raw provider products across all providers.
 * Query: ?search= &page= &limit= &providerId= &isActive=
 */
const listAllProviderProducts = catchAsync(async (req, res) => {
    const { search, page = 1, limit = 50, providerId, isActive } = req.query;

    const filter = {};
    if (providerId) filter.provider = providerId;
    if (isActive !== undefined) filter.isActive = isActive !== 'false';

    const { products, pagination } = await ppService.listProviderProducts(filter, {
        page: parseInt(page, 10),
        limit: Math.min(parseInt(limit, 10), 200),
        search,
    });

    sendPaginated(res, sanitizePricingForSupervisor(products, req.user), pagination, 'Provider products retrieved.');
});

/**
 * GET /admin/provider-products/:providerId
 * Raw provider products scoped to a single provider.
 * Query: ?search= &page= &limit= &includeInactive=
 */
const listProviderProducts = catchAsync(async (req, res) => {
    const { search, page = 1, limit = 50, includeInactive } = req.query;

    const filter = { provider: req.params.providerId };
    if (!includeInactive || includeInactive === 'false') filter.isActive = true;

    const { products, pagination } = await ppService.listProviderProducts(filter, {
        page: parseInt(page, 10),
        limit: Math.min(parseInt(limit, 10), 200),
        search,
    });

    sendPaginated(res, sanitizePricingForSupervisor(products, req.user), pagination, 'Provider products retrieved.');
});

/**
 * GET /admin/provider-products/item/:id
 * Single raw provider product by its internal _id (includes rawPayload).
 */
const getProviderProduct = catchAsync(async (req, res) => {
    const pp = await ppService.getProviderProductById(req.params.id);
    sendSuccess(res, sanitizePricingForSupervisor(pp, req.user));
});

/**
 * GET /admin/provider-products/item/:id/price
 * Returns the price data for a single provider product (used by sync button).
 */
const getProviderProductPrice = catchAsync(async (req, res) => {
    assertAdminOnlyProductMutation(req, 'read provider pricing for');
    const pp = await ppService.getProviderProductById(req.params.id);
    // Prefer rawPayload.product_price (original provider precision) over
    // rawPrice which may have been truncated by older adapter logic.
    const rawPrice = String(pp.rawPayload?.product_price ?? pp.rawPrice ?? '0');
    sendSuccess(res, sanitizePricingForSupervisor({
        rawPrice,
        rawName: pp.rawName || pp.rawPayload?.product_name || '',
        provider: pp.provider?.toString() || '',
        found: true,
    }, req.user), 'Provider product price retrieved.');
});

/**
 * GET /admin/product-provider-options
 * Safe provider picker for blind supervisor provider linking.
 */
const listProductProviderOptions = catchAsync(async (req, res) => {
    const providers = await providerService.listProviders({ includeInactive: false });
    sendSuccess(
        res,
        { providers: providers.map(sanitizeProviderOption).filter((provider) => provider.id && provider.name) },
        'Provider options retrieved.'
    );
});

/**
 * GET /admin/product-provider-options/:providerId/products
 * Safe provider product picker for blind supervisor provider linking.
 * Does not return provider prices, raw payloads, external IDs, or internal mapping data.
 */
const listProductProviderProductOptions = catchAsync(async (req, res) => {
    const { search = '', page = 1, limit = 50 } = req.query;
    const { providerId } = req.params;

    if (!isValidObjectId(providerId)) {
        throw new BusinessRuleError('Valid providerId is required.', 'INVALID_PROVIDER_ID');
    }

    const filter = { provider: providerId, isActive: true };
    if (search) {
        const re = new RegExp(escapeRegex(String(search).trim()), 'i');
        filter.$or = [{ rawName: re }, { translatedName: re }];
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (parsedPage - 1) * parsedLimit;

    const [products, total] = await Promise.all([
        ProviderProduct.find(filter)
            .select('provider rawName translatedName minQty maxQty isActive')
            .sort({ translatedName: 1, rawName: 1 })
            .skip(skip)
            .limit(parsedLimit)
            .populate('provider', 'name'),
        ProviderProduct.countDocuments(filter),
    ]);

    sendPaginated(
        res,
        products.map(sanitizeProviderProductOption).filter((product) => product.id && product.name),
        {
            page: parsedPage,
            limit: parsedLimit,
            total,
            pages: Math.ceil(total / parsedLimit),
        },
        'Provider product options retrieved.'
    );
});

/**
 * PATCH /admin/provider-products/item/:id/translated-name
 * Set admin-friendly name for a raw provider product.
 * Body: { translatedName: "..." }
 */
const setTranslatedName = catchAsync(async (req, res) => {
    const pp = await ppService.setTranslatedName(req.params.id, req.body.translatedName);
    sendSuccess(res, sanitizePricingForSupervisor(pp, req.user), 'Translated name updated.');
});

// ── Platform Products (Layer 3) ───────────────────────────────────────────────

/**
 * GET /admin/products
 * Admin product list — includes inactive.
 * Query: ?page= &limit= &search= &category=
 */
const listProducts = catchAsync(async (req, res) => {
    const { page = 1, limit = 50, search, category } = req.query;
    const { products, pagination } = await productService.listProducts({
        activeOnly: false,
        page: parseInt(page, 10),
        limit: Math.min(parseInt(limit, 10), 200),
        search,
        category,
    });
    sendPaginated(res, sanitizeAdminProductResponse(products, req.user), pagination, 'Products retrieved.');
});

/**
 * POST /admin/products
 * Create a standalone platform product without a provider link.
 * Supports orderFields and providerMapping.
 *
 * Body:
 * {
 *   "name":           "Free Fire Diamonds",
 *   "basePrice":      9.99,
 *   "minQty":         1,
 *   "maxQty":         10000,
 *   "description":    "...",
 *   "category":       "games",
 *   "image":          "https://...",
 *   "displayOrder":   0,
 *   "isActive":       true,
 *   "executionType":  "manual" | "automatic",
 *   "orderFields":    [...],
 *   "providerMapping": { "player_id": "link" }
 * }
 */
const createProduct = catchAsync(async (req, res) => {
    assertAdminOnlyProductMutation(req, 'create');
    assertSupervisorDoesNotSubmitPricing(req);

    const {
        name,
        basePrice,
        minQty,
        maxQty,
        description,
        category,
        image,
        displayOrder,
        isActive,
        executionType,
        orderFields,
        providerMapping,
    } = req.body;

    const product = await productService.createProduct({
        name,
        basePrice,
        minQty,
        maxQty,
        description: description ?? null,
        category: category ?? null,
        image: image ?? null,
        displayOrder: displayOrder ?? 0,
        isActive: isActive ?? true,
        executionType: executionType ?? 'manual',
        orderFields: orderFields ?? [],
        providerMapping: providerMapping ?? {},
    }, req.user._id);

    sendCreated(res, sanitizeAdminProductResponse(product, req.user), 'Product created.');
});

/**
 * POST /admin/products/from-provider
 * Admin selects a ProviderProduct and publishes it as a platform product.
 *
 * Body:
 * {
 *   "providerProductId": "<ObjectId>",
 *   "name":              "Free Fire Diamonds",
 *   "basePrice":         0.003,
 *   "imageUrl":          "https://...",
 *   "category":          "games",
 *   "description":       "...",
 *   "minQty":            1,
 *   "maxQty":            1000,
 *   "pricingMode":       "manual" | "sync",
 *   "executionType":     "manual" | "automatic"
 * }
 */
const createProductFromProvider = catchAsync(async (req, res) => {
    assertAdminOnlyProductMutation(req, 'create provider-linked');
    assertSupervisorDoesNotSubmitPricing(req);

    const {
        providerProductId,
        name,
        basePrice,
        imageUrl,
        image,
        category,
        description,
        minQty,
        maxQty,
        pricingMode,
        executionType,
        displayOrder,
        markupType,
        markupValue,
        isActive,
    } = req.body;

    try {
        const product = await productService.createProductFromProvider({
            providerProductId,
            name,
            basePrice,
            image: imageUrl ?? image ?? null,   // accept both field names
            category: category ?? null,
            description: description ?? null,
            minQty,
            maxQty,
            pricingMode,
            markupType,
            markupValue,
            isActive,
            executionType,
            displayOrder,
            createdBy: req.user._id,
        });


        sendCreated(res, sanitizeAdminProductResponse(product, req.user), 'Product published from provider product.');
    } catch (err) {

        throw err; // re-throw so catchAsync sends proper response
    }
});

/**
 * PATCH /admin/products/:id
 * Update any field of a published platform product.
 */
const updateProduct = catchAsync(async (req, res) => {
    assertSupervisorDoesNotSubmitPricing(req);
    assertSupervisorOnlySubmitsSafeProductMetadata(req);

    const product = await productService.updateProduct(req.params.id, req.body);
    sendSuccess(res, sanitizeAdminProductResponse(product, req.user), 'Product updated.');
});

/**
 * PATCH /admin/products/:id/provider-link
 * Blindly link an existing platform product to a provider product.
 * Supervisors with products.provider.sync can call this, but the response never
 * includes price/provider raw data.
 */
const linkProductProvider = catchAsync(async (req, res) => {
    assertProviderLinkPayloadOnly(req);
    const { providerId, providerProductId } = resolveProviderLinkPayload(req.body);

    const providerProduct = await ProviderProduct.findById(providerProductId)
        .select('provider isActive')
        .populate('provider', 'name isActive');

    if (!providerProduct) throw new NotFoundError('ProviderProduct');
    if (String(providerProduct.provider?._id || providerProduct.provider) !== providerId) {
        throw new BusinessRuleError(
            'The provider product does not belong to the selected provider.',
            'PROVIDER_LINK_MISMATCH'
        );
    }
    if (providerProduct.provider?.isActive === false) {
        throw new BusinessRuleError('The selected provider is inactive.', 'PROVIDER_INACTIVE');
    }
    if (providerProduct.isActive === false) {
        throw new BusinessRuleError('The selected provider product is inactive.', 'PROVIDER_PRODUCT_INACTIVE');
    }

    const product = await productService.updateProduct(req.params.id, {
        provider: providerProduct.provider?._id || providerId,
        providerProduct: providerProduct._id,
        pricingMode: 'sync',
        syncPriceWithProvider: true,
    });

    if (isSupervisorRole(req.user)) {
        return sendSuccess(res, getSafeCurrentLinkageSummary(product), 'Product linked to provider successfully.');
    }

    return sendSuccess(res, sanitizeAdminProductResponse(product, req.user), 'Product linked to provider successfully.');
});

/**
 * POST /admin/products/:id/provider-sync
 * Blindly sync the linked provider price. Supervisor responses are success-only
 * and never expose old/new price values.
 */
const syncProductProviderPrice = catchAsync(async (req, res) => {
    assertEmptyPayload(req, 'Provider price sync');
    const product = await productService.syncProductPriceFromProvider(req.params.id);

    if (isSupervisorRole(req.user)) {
        return sendSuccess(res, getSafeCurrentLinkageSummary(product), 'Provider price synced successfully.');
    }

    return sendSuccess(res, sanitizeAdminProductResponse(product, req.user), 'Provider price synced successfully.');
});

/**
 * PATCH /admin/products/:id/toggle
 * Activate / deactivate a platform product.
 */
const toggleProduct = catchAsync(async (req, res) => {
    const product = await productService.toggleProduct(req.params.id);
    sendSuccess(res, sanitizeAdminProductResponse(product, req.user), `Product ${product.isActive ? 'activated' : 'deactivated'}.`);
});

/**
 * DELETE /admin/products/:id
 * Soft-delete a platform product (sets deletedAt + isActive = false).
 */
const deleteProduct = catchAsync(async (req, res) => {
    assertAdminOnlyProductMutation(req, 'delete');
    const product = await productService.deleteProduct(req.params.id);
    sendSuccess(res, sanitizeAdminProductResponse(product, req.user), 'Product deleted.');
});

module.exports = {
    // Sync
    syncProvider,
    syncAll,
    // Layer 2
    listAllProviderProducts,
    listProviderProducts,
    getProviderProduct,
    getProviderProductPrice,
    listProductProviderOptions,
    listProductProviderProductOptions,
    setTranslatedName,
    // Layer 3
    listProducts,
    createProduct,
    createProductFromProvider,
    updateProduct,
    linkProductProvider,
    syncProductProviderPrice,
    toggleProduct,
    deleteProduct,
};
