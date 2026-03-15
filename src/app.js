'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config/config');
const globalErrorHandler = require('./shared/errors/errorHandler');
const { AppError } = require('./shared/errors/AppError');

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
const path = require('path');
// Seed default settings on startup (idempotent, no-op if already seeded)
require('./modules/admin/setting.model').seedDefaultSettings().catch(() => { });


const app = express();

// ── Security Middlewares ──────────────────────────────────────────────────────
app.use(helmet());
app.use(
    cors({
        origin: config.env === 'production' ? process.env.ALLOWED_ORIGINS : '*',
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    })
);

// ── Request Parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (config.env !== 'test') {
    app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

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

// ── Admin Routes ──────────────────────────────────────────────────────────────
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/admin`, adminCatalogRoutes);
app.use(`${API_PREFIX}/admin/currencies`, currencyRoutes);

// ── Static Files ──────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));


// ── 404 Handler ────────────────────────────────────────────────────────────────
// Express 5 uses path-to-regexp v8 – use middleware (not app.all) for catch-all
app.use((req, res, next) => {
    next(new AppError(`Route '${req.originalUrl}' not found on this server.`, 404, 'ROUTE_NOT_FOUND'));
});

// ── Global Error Handler (must be last) ───────────────────────────────────────
app.use(globalErrorHandler);

module.exports = app;
