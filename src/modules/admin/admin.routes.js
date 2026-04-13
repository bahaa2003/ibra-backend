'use strict';

/**
 * admin.routes.js — Master Admin Router
 *
 * All routes require:
 *   1. authenticate  — valid JWT
 *   2. authorize('ADMIN') — ADMIN role only
 *
 * Route Map:
 * DEPOSITS
 *   GET    /admin/deposits                    — list + filter (status, page, limit)
 *   GET    /admin/deposits/:id                — get one
 *   PATCH  /admin/deposits/:id/approve        — approve + credit wallet
 *   PATCH  /admin/deposits/:id/reject         — reject
 *
 * USERS
 *   GET    /admin/users                     — list + filter + paginate
 *   GET    /admin/users/:id                 — get one
 *   PATCH  /admin/users/:id                 — update
 *   DELETE /admin/users/:id                 — soft delete
 *   PATCH  /admin/users/:id/approve         — approve
 *   PATCH  /admin/users/:id/reject          — reject
 *   POST   /admin/users/adjust-debt          — bulk debt adjustment for currency devaluation
 *
 * PROVIDERS
 *   GET    /admin/providers                  — list
 *   GET    /admin/providers/:id              — get one
 *   POST   /admin/providers                  — create
 *   PATCH  /admin/providers/:id              — update
 *   DELETE /admin/providers/:id              — soft delete
 *   PATCH  /admin/providers/:id/toggle       — toggle active
 *   GET    /admin/providers/:id/balance      — live provider balance
 *   GET    /admin/providers/:id/products     — live provider product list
 *
 * ORDERS
 *   GET    /admin/orders                     — list + filter + paginate
 *   GET    /admin/orders/:id                 — get one
 *   POST   /admin/orders/:id/retry           — retry failed order
 *   POST   /admin/orders/:id/refund          — manual refund
 *
 * WALLETS
 *   GET    /admin/wallets                    — list all user wallets
 *   GET    /admin/wallets/:userId            — single user wallet
 *   GET    /admin/wallets/:userId/transactions — tx history
 *   POST   /admin/wallets/:userId/add        — add funds
 *   POST   /admin/wallets/:userId/deduct     — deduct funds
 *
 * CURRENCIES  (existing, re-mounted here for cohesion)
 *   GET    /admin/currencies                 — list
 *   PATCH  /admin/currencies/:code          — update platformRate
 *
 * GROUPS  (existing, already mounted separately — proxied here too)
 *   GET    /admin/groups                     — list
 *   POST   /admin/groups                     — create
 *   PATCH  /admin/groups/:id                 — update
 *   DELETE /admin/groups/:id                 — deactivate
 *
 * SETTINGS
 *   GET    /admin/settings                   — list all
 *   GET    /admin/settings/:key              — get one
 *   PATCH  /admin/settings/:key              — update value
 *
 * AUDIT LOGS
 *   GET    /admin/audit                      — get entity audit logs
 *   GET    /admin/audit/actor/:actorId       — get actor audit logs
 * DEPOSITS
 *   GET    /admin/deposits                    — list + filter (status, page, limit)
 *   GET    /admin/deposits/:id                — get one
 *   PATCH  /admin/deposits/:id/approve        — approve + credit wallet
 *   PATCH  /admin/deposits/:id/reject         — reject
 *
 */

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const { createUpload } = require('../../shared/middlewares/upload');
const { walletLimiter } = require('../../shared/middlewares/rateLimiter');

const { validateBody, validateQuery, schemas } = require('./admin.validation');

const avatarUpload = createUpload('avatars');

// ── Controllers ───────────────────────────────────────────────────────────────
const usersCtrl = require('./admin.users.controller');
const providersCtrl = require('./admin.providers.controller');
const ordersCtrl = require('./admin.orders.controller');
const walletCtrl = require('./admin.wallet.controller');
const settingsCtrl = require('./admin.settings.controller');
const statsCtrl = require('./admin.stats.controller');
const categoriesCtrl = require('../categories/category.controller');
const categoryValidation = require('../categories/category.validation');

// ── Existing services reused directly ─────────────────────────────────────────
const groupSvc = require('../groups/group.service');
const { Currency } = require('../currency/currency.model');
const { getEntityAuditLogs, getActorAuditLogs } = require('../audit/audit.service');
const depositSvc = require('../deposits/deposit.service');

const router = Router();

// ─── Auth guard — applied to every route in this router ──────────────────────
router.use(authenticate);
router.use(authorize('ADMIN'));

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/stats', statsCtrl.getDashboardStats);

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/users', validateQuery(schemas.listUsersQuery), usersCtrl.listUsers);
router.get('/users/deleted', usersCtrl.listDeletedUsers); // MUST be before /:id
router.post('/users/adjust-debt', walletLimiter, validateBody(schemas.debtAdjustment), walletCtrl.adjustDebt);
router.get('/users/:id', usersCtrl.getUserById);
router.patch('/users/:id', validateBody(schemas.updateUser), usersCtrl.updateUser);
router.delete('/users/:id', usersCtrl.deleteUser);
// approve / reject / restore — specific actions must come BEFORE /:id pattern
router.patch('/users/:id/approve', usersCtrl.approveUser);
router.patch('/users/:id/reject', usersCtrl.rejectUser);
router.patch('/users/:id/restore', usersCtrl.restoreUser);
// Phase 4 gap-bridged routes
router.patch('/users/:id/role', validateBody(schemas.updateUserRole), usersCtrl.updateUserRole);
router.patch('/users/:id/currency', validateBody(schemas.updateUserCurrency), usersCtrl.updateUserCurrency);
router.patch('/users/:id/credit-limit', validateBody(schemas.updateCreditLimit), usersCtrl.updateUserCreditLimit);
router.post('/users/:id/reset-password', validateBody(schemas.resetUserPassword), usersCtrl.resetUserPassword);
router.patch('/users/:id/avatar', avatarUpload.single('avatar'), usersCtrl.updateUserAvatar);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/providers', providersCtrl.listProviders);
router.post('/providers', validateBody(schemas.createProvider), providersCtrl.createProvider);
// sub-resource actions BEFORE /:id to avoid param collision
router.get('/providers/:id/balance', providersCtrl.getProviderBalance);
router.get('/providers/:id/products', providersCtrl.getProviderLiveProducts);
router.post('/providers/:id/test-connection', providersCtrl.testProviderConnection);
router.get('/providers/:id/check-order', providersCtrl.checkProviderOrder);
router.get('/providers/:providerId/products/:externalProductId/price', providersCtrl.getProductPrice);
router.patch('/providers/:id/toggle', providersCtrl.toggleProvider);
router.get('/providers/:id', providersCtrl.getProviderById);
router.patch('/providers/:id', validateBody(schemas.updateProvider), providersCtrl.updateProvider);
router.delete('/providers/:id', providersCtrl.deleteProvider);

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/orders', validateQuery(schemas.listOrdersQuery), ordersCtrl.listOrders);
router.post('/orders/:id/retry', ordersCtrl.retryOrder);
router.post('/orders/:id/refund', ordersCtrl.refundOrder);
router.post('/orders/:id/sync-status', ordersCtrl.syncOrderProviderStatus);
router.post('/orders/:id/complete', ordersCtrl.completeOrder);
router.get('/orders/:id', ordersCtrl.getOrderById);

// ═══════════════════════════════════════════════════════════════════════════════
// WALLETS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/wallets', walletCtrl.listWallets);
router.get('/wallets/:userId/transactions', walletCtrl.getTransactionHistory);
router.post('/wallets/:userId/add', walletLimiter, validateBody(schemas.walletAdjustment), walletCtrl.addFunds);
router.post('/wallets/:userId/deduct', walletLimiter, validateBody(schemas.walletAdjustment), walletCtrl.deductFunds);
router.put('/wallets/:userId/set', walletLimiter, validateBody(schemas.walletSetBalance), walletCtrl.setBalance);
router.get('/wallets/:userId', walletCtrl.getWallet);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES  (Phase 4b gap-bridged module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/categories', categoriesCtrl.listCategories);
router.get('/categories/:id', categoriesCtrl.getCategoryById);
router.post('/categories', validateBody(categoryValidation.createCategorySchema), categoriesCtrl.createCategory);
router.patch('/categories/:id', validateBody(categoryValidation.updateCategorySchema), categoriesCtrl.updateCategory);
router.patch('/categories/:id/toggle', categoriesCtrl.toggleCategory);
router.delete('/categories/:id', categoriesCtrl.deleteCategory);

// ═══════════════════════════════════════════════════════════════════════════════
// CURRENCIES  (thin proxy — full controller lives in currency module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/currencies', catchAsync(async (req, res) => {
    const currencies = await Currency.find().sort({ code: 1 });
    sendSuccess(res, { currencies }, 'Currencies retrieved');
}));

router.patch('/currencies/:code', validateBody(schemas.updateCurrency), catchAsync(async (req, res) => {
    const { platformRate, markupPercentage, isActive, applyDebtAdjustment } = req.body;
    const code = req.params.code.toUpperCase();

    // Delegate to the canonical currency service (handles debt adjustment internally)
    const currencyService = require('../currency/currency.service');
    const { currency, debtAdjustment } = await currencyService.updateCurrencyRate(code, {
        platformRate,
        markupPercentage,
        applyDebtAdjustment,
        adminId: req.user._id,
    });

    // Handle isActive separately (toggle status)
    if (isActive !== undefined && currency.isActive !== isActive) {
        currency.isActive = isActive;
        currency.lastUpdatedAt = new Date();
        await currency.save();
    }

    const message = debtAdjustment?.usersAdjusted
        ? `Currency '${currency.code}' updated. Debt adjustment applied to ${debtAdjustment.usersAdjusted} users.`
        : `Currency '${currency.code}' updated.`;

    sendSuccess(res, { currency, debtAdjustment }, message);
}));

router.post('/currencies', validateBody(schemas.createCurrency), catchAsync(async (req, res) => {
    const { code, name, symbol, platformRate, marketRate, markupPercentage, isActive } = req.body;

    // Check for duplicate code
    const existing = await Currency.findOne({ code: code.toUpperCase() });
    if (existing) {
        const { ConflictError } = require('../../shared/errors/AppError');
        throw new ConflictError(`Currency with code '${code.toUpperCase()}' already exists.`);
    }

    const currency = await Currency.create({
        code: code.toUpperCase(),
        name,
        symbol,
        platformRate,
        marketRate: marketRate ?? null,
        markupPercentage: markupPercentage ?? 0,
        isActive: isActive !== false,
        lastUpdatedAt: new Date(),
    });

    res.status(201).json({ success: true, message: 'Currency created', data: { currency } });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUPS  (thin proxy — full controller lives in groups module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/groups', catchAsync(async (req, res) => {
    const groups = await groupSvc.listGroups({ includeInactive: true });
    sendSuccess(res, { groups }, 'Groups retrieved');
}));

router.post('/groups', validateBody(schemas.createGroup), catchAsync(async (req, res) => {
    const group = await groupSvc.createGroup(req.body);
    res.status(201).json({ success: true, message: 'Group created', data: { group } });
}));

router.patch('/groups/:id', validateBody(schemas.updateGroup), catchAsync(async (req, res) => {
    const group = await groupSvc.updateGroup(req.params.id, req.body);
    sendSuccess(res, { group }, 'Group updated');
}));

router.delete('/groups/:id', catchAsync(async (req, res) => {
    const group = await groupSvc.deleteGroup(req.params.id);
    sendSuccess(res, { group }, 'Group deleted');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/settings', settingsCtrl.listSettings);
router.get('/settings/:key', settingsCtrl.getSettingByKey);
router.patch('/settings/:key', validateBody(schemas.updateSetting), settingsCtrl.updateSetting);

// ═══════════════════════════════════════════════════════════════════════════════
// DEPOSITS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/deposits', catchAsync(async (req, res) => {
    const page = parseInt(req.query.page ?? 1, 10);
    const limit = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const { status, search } = req.query;
    const result = await depositSvc.listDeposits({ page, limit, status, search });
    res.status(200).json({
        success: true,
        message: 'Deposit requests retrieved',
        data: result.deposits,
        pagination: result.pagination,
        summary: result.summary,
    });
}));

router.get('/deposits/:id', catchAsync(async (req, res) => {
    const deposit = await depositSvc.getDepositById(req.params.id);
    sendSuccess(res, deposit);
}));

router.patch('/deposits/:id/approve', validateBody(schemas.approveDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.approveDeposit(
        req.params.id,
        req.user._id,
        {
            // Admin overrides (optional — fallback to original deposit values in service)
            amount: req.body.amount,
            currency: req.body.currency,
            adminNotes: req.body.adminNotes,
        },
        { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    sendSuccess(res, deposit, 'Deposit approved and wallet credited.');
}));

router.patch('/deposits/:id/reject', validateBody(schemas.approveDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.rejectDeposit(
        req.params.id,
        req.user._id,
        req.body.adminNotes ?? null,
        { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    sendSuccess(res, deposit, 'Deposit request rejected.');
}));

/**
 * PATCH /admin/deposits/:id/review
 * Unified review endpoint — approve or reject a deposit in one call.
 * Body: { status: 'APPROVED' | 'REJECTED', adminNotes?: string }
 */
router.patch('/deposits/:id/review', validateBody(schemas.reviewDeposit), catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;
    const auditCtx = { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') };

    let deposit;
    if (status === 'APPROVED') {
        deposit = await depositSvc.approveDeposit(id, req.user._id, auditCtx);
        sendSuccess(res, deposit, 'Deposit approved and wallet credited.');
    } else {
        deposit = await depositSvc.rejectDeposit(id, req.user._id, adminNotes || null, auditCtx);
        sendSuccess(res, deposit, 'Deposit request rejected.');
    }
}));

router.patch('/deposits/:id', validateBody(schemas.updateDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.updatePendingDeposit(req.params.id, req.body, req.user._id);
    sendSuccess(res, { deposit }, 'Deposit request updated');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/audit', catchAsync(async (req, res) => {
    const { entityType, entityId, page, limit } = req.query;
    const result = await getEntityAuditLogs(entityId, entityType, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 50, 10),
    });
    sendPaginated(res, result.logs, result.pagination, 'Audit logs retrieved');
}));

router.get('/audit/actor/:actorId', catchAsync(async (req, res) => {
    const { page, limit } = req.query;
    const result = await getActorAuditLogs(req.params.actorId, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 50, 10),
    });
    sendPaginated(res, result.logs, result.pagination, 'Actor audit logs retrieved');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

const categoryRoutes = require('../categories/category.routes');
router.use('/categories', categoryRoutes);

module.exports = router;
