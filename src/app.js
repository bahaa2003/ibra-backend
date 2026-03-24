'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config/config');
const globalErrorHandler = require('./shared/errors/errorHandler');
const { AppError } = require('./shared/errors/AppError');
const { apiLimiter } = require('./shared/middlewares/rateLimiter');

// ── Module Routers ────────────────────────────────────────────────────────────
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const groupRoutes = require('./modules/groups/group.routes');
const productRoutes = require('./modules/products/product.routes');
const orderRoutes = require('./modules/orders/order.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const depositRoutes = require('./modules/deposits/deposit.routes');
const providerRoutes = require('./modules/providers/provider.routes');
const adminCatalogRoutes = require('./modules/admin/admin.catalog.routes');
const adminRoutes = require('./modules/admin/admin.routes');    // ← dashboard router
const meRoutes = require('./modules/me/me.routes');          // ← user panel
const currencyRoutes = require('./modules/currency/currency.routes');
const uploadRoutes = require('./shared/routes/upload.routes');
const path = require('path');
// Seed default settings on startup (idempotent, no-op if already seeded)
require('./modules/admin/setting.model').seedDefaultSettings().catch(() => { });


const app = express();

// ── Security Middlewares ──────────────────────────────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));
app.use(
    cors({
        origin: config.env === 'production' ? process.env.ALLOWED_ORIGINS : '*',
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    })
);

// ── Request Parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (config.env !== 'test') {
    app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

// ── Static Files ──────────────────────────────────────────────────────────────
// Serve uploaded files (deposit receipts, etc.) from /uploads
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ── Passport (OAuth strategies) ───────────────────────────────────────────────
// Only initialize when Google credentials are configured.
// Tests and environments without GOOGLE_CLIENT_ID skip this safely.
if (config.google.clientId && config.google.clientSecret) {
    const passport = require('./config/google.strategy');
    app.use(passport.initialize());
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        status: 'healthy',
        environment: config.env,
        timestamp: new Date().toISOString(),
    });
});

// ── API Routes ────────────────────────────────────────────────────────────────
const API_PREFIX = '/api';

// Apply general rate limiter to all API routes (500 req / 15 min per IP)
app.use(API_PREFIX, apiLimiter);

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/groups`, groupRoutes);
app.use(`${API_PREFIX}/products`, productRoutes);
app.use(`${API_PREFIX}/orders`, orderRoutes);
app.use(`${API_PREFIX}/wallet`, walletRoutes);
app.use(`${API_PREFIX}/audit`, auditRoutes);
app.use(`${API_PREFIX}/deposits`, depositRoutes);
app.use(`${API_PREFIX}/providers`, providerRoutes);

// ── User Panel ─────────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/me`, meRoutes);

// ── Public Categories (no auth required — used by storefront/guest pages) ─────
app.get(`${API_PREFIX}/categories`, async (req, res) => {
    try {
        const categorySvc = require('./modules/categories/category.service');
        const categories = await categorySvc.listCategories({ includeInactive: false });
        res.json({ success: true, message: 'Categories retrieved', data: { categories } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load categories' });
    }
});

// ── Public Currencies (no auth required — used by registration page) ──────────
app.get(`${API_PREFIX}/currencies/active`, async (req, res) => {
    try {
        const { Currency } = require('./modules/currency/currency.model');
        const currencies = await Currency.find({ isActive: true })
            .select('code name symbol platformRate')
            .sort({ code: 1 });
        res.json({ success: true, message: 'Active currencies', data: { currencies } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load currencies' });
    }
});

// ── Public Payment Settings (no auth required — used by customer deposit pages) ─
app.get(`${API_PREFIX}/settings/payment`, async (req, res) => {
    try {
        const { Setting } = require('./modules/admin/setting.model');
        const keys = ['paymentGroups', 'paymentCountryAccounts', 'paymentInstructions', 'whatsappNumber'];
        const settings = await Setting.find({ key: { $in: keys } }).lean();
        const find = (key) => settings.find((s) => s.key === key)?.value;

        const paymentGroups = (find('paymentGroups') || [])
            .filter((g) => g.isActive !== false)
            .map((g) => ({
                ...g,
                methods: (g.methods || []).filter((m) => m.isActive !== false),
            }))
            .filter((g) => g.methods && g.methods.length > 0);

        res.json({
            success: true,
            message: 'Payment settings',
            data: {
                paymentGroups,
                countryAccounts: find('paymentCountryAccounts') || [],
                instructions: find('paymentInstructions') || '',
                whatsappNumber: find('whatsappNumber') || '',
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load payment settings' });
    }
});

// ── Admin Routes ──────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/admin`, adminCatalogRoutes);
app.use(`${API_PREFIX}/admin/currencies`, currencyRoutes);

// ── Generic Upload ────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/upload`, uploadRoutes);


// ── 404 Handler ────────────────────────────────────────────────────────────────
// Express 5 uses path-to-regexp v8 – use middleware (not app.all) for catch-all
app.use((req, res, next) => {
    next(new AppError(`Route '${req.originalUrl}' not found on this server.`, 404, 'ROUTE_NOT_FOUND'));
});

// ── Global Error Handler (must be last) ───────────────────────────────────────
app.use(globalErrorHandler);

module.exports = app;
