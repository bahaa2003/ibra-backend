'use strict';

const productService = require('./product.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

// ─── User-facing ──────────────────────────────────────────────────────────────

/**
 * GET /api/products
 * Customers see only active products; admins see everything.
 */
const listProducts = catchAsync(async (req, res) => {
    const activeOnly = req.user.role !== 'ADMIN';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const { products, pagination } = await productService.listProducts({ activeOnly, page, limit });

    // Apply group markup for non-admin users
    if (activeOnly && req.user.groupId) {
        const Group = require('../groups/group.model');
        const group = await Group.findById(req.user.groupId);
        const markup = Number(group?.percentage || 0);

        if (markup > 0) {
            for (const product of products) {
                const base = Number(product.finalPrice || product.basePrice || 0);
                product.finalPrice = parseFloat((base + base * (markup / 100)).toFixed(2));
            }
        }
    }

    sendPaginated(res, products, pagination, 'Products retrieved successfully.');
});

/**
 * GET /api/products/:id
 */
const getProduct = catchAsync(async (req, res) => {
    const product = await productService.getProductById(req.params.id);
    sendSuccess(res, product);
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
