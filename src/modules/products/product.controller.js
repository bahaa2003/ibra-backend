'use strict';

const productService = require('./product.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');

// ─── Sensitive fields that must NEVER reach non-admin clients ─────────────────

const SENSITIVE_FIELDS = [
    'providerPrice',
    'markupType',
    'markupValue',
    'pricingMode',
    'provider',
    'providerProduct',
    'providerMapping',
    'syncPriceWithProvider',
    'enableManualPrice',
    'manualPriceAdjustment',
    'executionType',
    'createdBy',
    'deletedAt',
    'internalNotes',
    'syncedProviderBasePrice',
    'supplierId',
    'providerId',
    'externalProductId',
    'externalProductName',
    '__v',
];

/**
 * Strip sensitive business fields from a product before sending to customers.
 * Works on both Mongoose documents and plain objects.
 */
const sanitizeProductForCustomer = (product) => {
    if (!product) return product;
    const obj = typeof product.toObject === 'function' ? product.toObject() : { ...product };
    for (const field of SENSITIVE_FIELDS) {
        delete obj[field];
    }
    return obj;
};

const sanitizeProductsForCustomer = (products) =>
    (Array.isArray(products) ? products : []).map(sanitizeProductForCustomer);

/**
 * Guest catalogue responses are deliberately allowlisted. Keeping this
 * separate from customer serialization prevents future internal pricing or
 * provider fields from becoming public when the Product model grows.
 */
const sanitizeProductForGuest = (product) => {
    if (!product) return product;
    const obj = typeof product.toObject === 'function' ? product.toObject() : product;
    return {
        _id: obj._id,
        name: obj.name,
        description: obj.description ?? null,
        image: obj.image ?? null,
        category: obj.category ?? null,
        displayOrder: obj.displayOrder ?? 0,
        isActive: obj.isActive === true,
    };
};

const sanitizeProductsForGuest = (products) =>
    (Array.isArray(products) ? products : []).map(sanitizeProductForGuest);

// ─── User-facing ──────────────────────────────────────────────────────────────

/**
 * GET /api/products
 * Customers see only active products; admins see everything.
 */
const listProducts = catchAsync(async (req, res) => {
    const isAdmin = req.user?.role === 'ADMIN';
    const isGuest = !req.user;
    const activeOnly = !isAdmin;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { search, category } = req.query;

    const { products, pagination } = await productService.listProducts({ activeOnly, page, limit, search, category });

    // Apply group markup for non-admin users
    if (activeOnly && req.user?.groupId) {
        const Group = require('../groups/group.model');
        const group = await Group.findById(req.user.groupId);
        const markup = Number(group?.percentage || 0);

        if (markup > 0) {
            const { computeMarkup } = require('../../shared/utils/decimalPrecision');
            for (const product of products) {
                const base = String(product.finalPrice || product.basePrice || '0');
                product.finalPrice = computeMarkup(base, 'percentage', markup);
            }
        }
    }

    const responseProducts = isGuest
        ? sanitizeProductsForGuest(products)
        : (isAdmin ? products : sanitizeProductsForCustomer(products));
    const safeResponseProducts = sanitizePricingForSupervisor(responseProducts, req.user);
    sendPaginated(res, safeResponseProducts, pagination, 'Products retrieved successfully.');
});

/**
 * GET /api/products/:id
 */
const getProduct = catchAsync(async (req, res) => {
    const product = await productService.getProductById(req.params.id);
    const isAdmin = req.user?.role === 'ADMIN';
    const responseProduct = isAdmin ? product : sanitizeProductForCustomer(product);
    sendSuccess(res, sanitizePricingForSupervisor(responseProduct, req.user));
});

// ─── Admin only ───────────────────────────────────────────────────────────────

/**
 * POST /api/products
 * Create a standalone product (no provider link).
 */
const createProduct = catchAsync(async (req, res) => {
    const product = await productService.createProduct(req.body, req.user._id);
    sendCreated(res, product, 'Product created successfully.');
});

/**
 * POST /api/products/publish
 * Admin selects a ProviderProduct and publishes it as a platform product.
 * Supports markup configuration, qty override, image override.
 */
const publishProduct = catchAsync(async (req, res) => {
    const product = await productService.publishFromProviderProduct(req.body, req.user._id);
    sendCreated(res, product, 'Product published successfully.');
});

/**
 * PATCH /api/products/:id
 * Update any admin-writable field. Markup-aware price recalculation is
 * applied automatically when needed.
 */
const updateProduct = catchAsync(async (req, res) => {
    const product = await productService.updateProduct(req.params.id, req.body);
    sendSuccess(res, product, 'Product updated successfully.');
});

/**
 * PATCH /api/products/:id/toggle-status
 */
const toggleStatus = catchAsync(async (req, res) => {
    const product = await productService.toggleProductStatus(req.params.id);
    sendSuccess(res, product, `Product ${product.isActive ? 'activated' : 'deactivated'}.`);
});

module.exports = {
    listProducts,
    getProduct,
    createProduct,
    publishProduct,
    updateProduct,
    toggleStatus,
};
