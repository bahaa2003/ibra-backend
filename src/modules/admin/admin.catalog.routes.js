'use strict';

/**
 * admin.catalog.routes.js
 *
 * Admin-only routes for the provider catalog system.
 *
 * All routes require:
 *   - Authentication  (authenticate middleware)
 *   - Admin role      (authorize('ADMIN') middleware)
 *
 * Route map:
 *
 * ── Sync ──────────────────────────────────────────────────────────────────────
 *   POST  /admin/catalog/sync                     → syncAll
 *   POST  /admin/catalog/sync/:providerId         → syncProvider
 *
 * ── Raw Provider Products (Layer 2) ──────────────────────────────────────────
 *   GET   /admin/provider-products                → listAllProviderProducts
 *   GET   /admin/provider-products/:providerId    → listProviderProducts
 *   GET   /admin/provider-products/item/:id       → getProviderProduct
 *   PATCH /admin/provider-products/item/:id/translated-name → setTranslatedName
 *
 * ── Platform Products (Layer 3) ───────────────────────────────────────────────
 *   GET   /admin/products                         → listProducts
 *   POST  /admin/products/from-provider           → createProductFromProvider
 *   PATCH /admin/products/:id                     → updateProduct
 *   PATCH /admin/products/:id/toggle              → toggleProduct
 */

const express = require('express');
const  authenticate  = require('../../shared/middlewares/authenticate');
const  authorize  = require('../../shared/middlewares/authorize');
const {
    syncProvider,
    syncAll,
    listAllProviderProducts,
    listProviderProducts,
    getProviderProduct,
    getProviderProductPrice,
    setTranslatedName,
    listProducts,
    createProduct,
    createProductFromProvider,
    updateProduct,
    toggleProduct,
} = require('./admin.catalog.controller');

const router = express.Router();

// All admin routes require authentication and ADMIN role
router.use(authenticate);
router.use(authorize('ADMIN'));

// ── Sync ──────────────────────────────────────────────────────────────────────

router.post('/catalog/sync', syncAll);
router.post('/catalog/sync/:providerId', syncProvider);

// ── Layer 2 — Raw Provider Products ──────────────────────────────────────────
//
// NOTE: /item/:id must be defined BEFORE /:providerId to avoid Express
// treating "item" as a providerId param value.

router.get('/provider-products', listAllProviderProducts);
router.get('/provider-products/item/:id', getProviderProduct);
router.get('/provider-products/item/:id/price', getProviderProductPrice);
router.patch('/provider-products/item/:id/translated-name', setTranslatedName);
router.get('/provider-products/:providerId', listProviderProducts);

// ── Layer 3 — Platform Products ───────────────────────────────────────────────
//
// NOTE: /from-provider must be defined BEFORE /:id to avoid param conflict.

router.get('/products', listProducts);
router.post('/products', createProduct);                   // ← manual product creation
router.post('/products/from-provider', createProductFromProvider);
router.patch('/products/:id/toggle', toggleProduct);
router.patch('/products/:id', updateProduct);

module.exports = router;
