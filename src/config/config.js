'use strict';

/**
 * Centralized application configuration.
 * All environment variable access should go through this file.
 */
const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,

    db: {
        uri: process.env.MONGO_URI,
    },

    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },

    bcrypt: {
        rounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    },

    // ── Google OAuth ────────────────────────────────────────────────────────────
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: process.env.GOOGLE_CALLBACK_URL ||
            `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`,
    },

    // ── Email / SMTP ────────────────────────────────────────────────────────────
    email: {
        host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.EMAIL_FROM || 'noreply@platform.com',
        // Base URL for verification links (server-side)
        appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`,
    },

    // ── Frontend ────────────────────────────────────────────────────────────────
    frontend: {
        url: process.env.FRONTEND_URL || 'http://localhost:3000',
        verifyRedirectUrl: process.env.FRONTEND_VERIFY_REDIRECT_URL ||
            `${process.env.FRONTEND_URL || 'http://localhost:3000'}/email-verified`,
    },

    // ── CORS ────────────────────────────────────────────────────────────────────
    cors: {
        allowedOrigins: process.env.ALLOWED_ORIGINS || 'http://localhost:3000',
    },
};

// Guard: fail fast if critical configs are missing
const required = ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = config;
