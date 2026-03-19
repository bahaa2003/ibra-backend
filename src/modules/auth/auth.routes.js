'use strict';

/**
 * auth.routes.js
 *
 * Public authentication routes:
 *   POST  /api/auth/register
 *   POST  /api/auth/login
 *   GET   /api/auth/verify-email?token=…
 *   POST  /api/auth/resend-verification
 *   GET   /api/auth/google                  → Passport redirect to Google
 *   GET   /api/auth/google/callback         → Passport OAuth callback
 */

const { Router } = require('express');
const passport = require('../../config/google.strategy');
const authController = require('./auth.controller');
const { registerValidation, loginValidation } = require('./auth.validation');
const validate = require('../../shared/middlewares/validate');
const { body } = require('express-validator');
const config = require('../../config/config');
const { authLimiter } = require('../../shared/middlewares/rateLimiter');

const router = Router();

// ── Guard middleware: return 503 when Google credentials are not configured ───
const requireGoogleConfig = (req, res, next) => {
    if (!config.google.clientId || !config.google.clientSecret) {
        return res.status(503).json({
            success: false,
            message: 'Google OAuth is not configured on this server. ' +
                'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env.',
        });
    }
    next();
};

// ─── Email / Password ─────────────────────────────────────────────────────────

/**
 * @route  POST /api/auth/register
 * @desc   Create a new customer account + send verification email
 * @access Public
 */
router.post('/register', authLimiter, registerValidation, validate, authController.register);

/**
 * @route  POST /api/auth/login
 * @desc   Authenticate user and get JWT
 * @access Public
 */
router.post('/login', authLimiter, loginValidation, validate, authController.login);

// ─── Email Verification ───────────────────────────────────────────────────────

/**
 * @route  GET /api/auth/verify-email?token=RAW_TOKEN
 * @desc   Verify email address via link in email
 * @access Public (token-gated)
 */
router.get('/verify-email', authController.verifyEmail);

/**
 * @route  POST /api/auth/resend-verification
 * @desc   Re-send verification email
 * @access Public
 * @note   Apply express-rate-limit in production (e.g. 3 requests / hour)
 */
router.post(
    '/resend-verification',
    authLimiter,
    [
        body('email')
            .isEmail().withMessage('A valid email address is required.')
            .normalizeEmail(),
    ],
    validate,
    authController.resendVerification
);

// ─── Google OAuth ─────────────────────────────────────────────────────────────

/**
 * @route  GET /api/auth/google
 * @desc   Redirect user to Google consent screen
 * @access Public
 */
router.get(
    '/google',
    requireGoogleConfig,
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        session: false,
    })
);

/**
 * @route  GET /api/auth/google/callback
 * @desc   Google calls this after authentication
 * @access Public (OAuth callback)
 */
router.get(
    '/google/callback',
    requireGoogleConfig,
    passport.authenticate('google', {
        session: false,
        failureRedirect: '/api/auth/google/failure',
    }),
    authController.googleCallback
);

/**
 * @route  GET /api/auth/google/failure
 * @desc   Generic fallback when Google OAuth fails
 * @access Public
 */
router.get('/google/failure', (req, res) => {
    res.status(401).json({
        success: false,
        message: 'Google authentication failed. Please try again.',
    });
});

module.exports = router;
