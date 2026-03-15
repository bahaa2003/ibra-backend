'use strict';

/**
 * auth.controller.js — thin HTTP adapter for auth.service.js
 *
 * Routes:
 *   POST   /api/auth/register            – email/password registration
 *   POST   /api/auth/login               – email/password login
 *   GET    /api/auth/verify-email        – consume email verification token
 *   POST   /api/auth/resend-verification – re-send verification email
 *   GET    /api/auth/google              – redirect to Google login (handled by passport)
 *   GET    /api/auth/google/callback     – Google callback
 */

const authService = require('./auth.service');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const config = require('../../config/config');

// ─── Email / Password ─────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 */
const register = catchAsync(async (req, res) => {
    const { name, email, password, currency, country, phone, username } = req.body;
    const result = await authService.register({ name, email, password, currency, country, phone, username });
    sendCreated(res, result, result.message);
});

/**
 * POST /api/auth/login
 */
const login = catchAsync(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.login({ email, password });
    sendSuccess(res, result, 'Logged in successfully.');
});

// ─── Email Verification ───────────────────────────────────────────────────────

/**
 * GET /api/auth/verify-email?token=RAW_TOKEN
 *
 * On success  → 302 redirect to frontend URL (FRONTEND_VERIFY_REDIRECT_URL)
 * On failure  → JSON 422 error (invalid / expired token)
 */
const verifyEmail = async (req, res) => {
    const redirectUrl = process.env.FRONTEND_VERIFY_REDIRECT_URL || 'http://localhost:5173/email-verified';
    try {
        const { token } = req.query;
        if (!token) {
            return res.redirect(`${redirectUrl}?status=error&message=${encodeURIComponent('Token is required')}`);
        }
        await authService.verifyEmail(token);
        return res.redirect(`${redirectUrl}?status=success`);
    } catch (error) {
        return res.redirect(`${redirectUrl}?status=error&message=${encodeURIComponent(error.message)}`);
    }
};

/**
 * POST /api/auth/resend-verification
 * Body: { email }
 *
 * Always returns the same message to prevent user enumeration.
 */
const resendVerification = catchAsync(async (req, res) => {
    const { email } = req.body;
    const result = await authService.resendVerification(email);
    sendSuccess(res, null, result.message);
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

/**
 * GET /api/auth/google/callback
 *
 * Called by Passport after Google authenticates the user.
 * req.user is set by the Passport strategy.
 */
const googleCallback = catchAsync(async (req, res) => {
    const result = await authService.loginWithGoogle(req.user);

    // Derive the FE base URL from the configured verify-redirect URL
    const frontendBase = config.frontend.verifyRedirectUrl
        .replace(/\/email-verified.*$/, '')   // strip path, keep origin
        .replace(/\/+$/, '');                  // strip trailing slashes

    // If admin not yet approved — redirect frontend can show "pending" message
    if (!result.token) {
        return res.redirect(`${frontendBase}/auth?status=pending`);
    }

    // Redirect with JWT in query param so the SPA can capture it.
    // FE loginWithGoogle() reads ?token= from window.location.search.
    res.redirect(`${frontendBase}/auth?token=${result.token}`);
});

module.exports = { register, login, verifyEmail, resendVerification, googleCallback };
