'use strict';

/**
 * auth.service.js
 *
 * Authentication business logic:
 *   - register      : email+password registration with email verification
 *   - login         : credential check + status + verification gate
 *   - verifyEmail   : consume email token, mark verified
 *   - resendVerification : re-issue + re-send the verification email
 *   - loginWithGoogle   : called after successful passport OAuth callback
 *
 * Security design:
 *   - Email verification tokens are stored as SHA-256 hashes (never raw)
 *   - Tokens expire in 24 hours
 *   - Password is never stored in raw form (bcrypt via model pre-save hook)
 *   - JWT is only issued when account is ACTIVE (approved by admin)
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const { User, ROLES, USER_STATUS } = require('../users/user.model');
const { getHighestPercentageGroup } = require('../groups/group.service');
const { sendVerificationEmail } = require('../../services/email.service');
const {
    AuthenticationError,
    ConflictError,
    BusinessRuleError,
    NotFoundError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { USER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

// ─── Private Helpers ──────────────────────────────────────────────────────────

/** Sign JWT for a user. */
const signToken = (userId, role) =>
    jwt.sign({ id: userId, role }, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn,
    });

/**
 * Generate a cryptographically random token and its SHA-256 hash.
 *
 * @returns {{ rawToken: string, hashedToken: string }}
 */
const _generateVerificationToken = () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');
    return { rawToken, hashedToken };
};

/** Hash an incoming raw token for DB lookup. */
const _hashToken = (raw) =>
    crypto.createHash('sha256').update(raw).digest('hex');

// ─── register ─────────────────────────────────────────────────────────────────

/**
 * Register a new customer account.
 *
 * Business rules:
 *  1. Email must be unique.
 *  2. Assigned to the group with the highest markup percentage.
 *  3. Status starts as PENDING — admin must approve before login is allowed.
 *  4. verified = false — user must click email link before login is allowed.
 *  5. A verification email is dispatched (fire-and-forget safe).
 */
const register = async ({ name, email, password, currency, country, phone, username }) => {
    // ── 1. Prevent duplicate accounts ─────────────────────────────────────────
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
        throw new ConflictError('An account with this email address already exists.');
    }

    // ── 2. Pricing group ──────────────────────────────────────────────────────
    const group = await getHighestPercentageGroup();

    // ── 3. Verification token ─────────────────────────────────────────────────
    const { rawToken, hashedToken } = _generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);  // +24 h

    // ── 4. Create user ────────────────────────────────────────────────────────
    const user = await User.create({
        name,
        email,
        password,
        role: ROLES.CUSTOMER,
        groupId: group._id,
        status: USER_STATUS.PENDING,
        verified: false,
        emailVerificationToken: hashedToken,
        emailVerificationExpires: expiresAt,
        currency: currency || 'USD',
        ...(country ? { country } : {}),
        ...(phone ? { phone } : {}),
        ...(username ? { username } : {}),
    });

    // ── 5. Audit (fire-and-forget) ────────────────────────────────────────────
    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES.CUSTOMER,
        action: USER_ACTIONS.REGISTERED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, name: user.name, groupId: user.groupId },
    });

    // ── 6. Send verification email (fire-and-forget — never block registration) ──
    const baseUrl = process.env.APP_URL || 'http://localhost:5000';
    const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}`;

    sendVerificationEmail(user, rawToken).catch((err) => {
        console.error('[Auth] Failed to send verification email:', err.message);
    });

    return {
        user: user.toSafeObject(),
        message:
            'Registration successful! Please check your email to verify your account. ' +
            'After verification, your account will be reviewed by an admin.',
    };
};

// ─── login ────────────────────────────────────────────────────────────────────

/**
 * Authenticate an existing user and issue a JWT.
 *
 * Gate order:
 *   1. User must exist
 *   2. Email must be verified
 *   3. Status must be ACTIVE (not PENDING / REJECTED)
 *   4. Password must match
 */
const login = async ({ email, password }) => {
    const user = await User.findOne({ email: email.toLowerCase() })
        .select('+password +verified');

    if (!user) {
        throw new AuthenticationError('Invalid email or password.');
    }

    // ── Gate 1: Email verification ────────────────────────────────────────────
    if (!user.verified) {
        throw new AuthenticationError(
            'Please verify your email address before logging in. ' +
            'Check your inbox for the verification link.'
        );
    }

    // ── Gate 2: Admin approval status ─────────────────────────────────────────
    if (user.status === USER_STATUS.PENDING) {
        createAuditLog({
            actorId: user._id,
            actorRole: ACTOR_ROLES[user.role] ?? user.role,
            action: USER_ACTIONS.LOGIN_BLOCKED,
            entityType: ENTITY_TYPES.USER,
            entityId: user._id,
            metadata: { reason: 'PENDING', email: user.email },
        });

        throw new AuthenticationError(
            'Your account is awaiting admin approval. Please check back later.'
        );
    }

    if (user.status === USER_STATUS.REJECTED) {
        createAuditLog({
            actorId: user._id,
            actorRole: ACTOR_ROLES[user.role] ?? user.role,
            action: USER_ACTIONS.LOGIN_BLOCKED,
            entityType: ENTITY_TYPES.USER,
            entityId: user._id,
            metadata: { reason: 'REJECTED', email: user.email },
        });

        throw new AuthenticationError(
            'Your account was rejected by an administrator. Please contact support.'
        );
    }

    // ── Gate 3: Password match ────────────────────────────────────────────────
    // Google OAuth users have no password — block password login for them
    if (!user.password) {
        throw new AuthenticationError(
            'This account uses Google Sign-In. Please log in with Google.'
        );
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw new AuthenticationError('Invalid email or password.');
    }

    const token = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return { token, user: user.toSafeObject() };
};

// ─── verifyEmail ──────────────────────────────────────────────────────────────

/**
 * Consume an email verification token.
 *
 * @param {string} rawToken  — token from query string (un-hashed)
 * @returns {{ redirectUrl: string }}
 */
const verifyEmail = async (rawToken) => {
    if (!rawToken) {
        throw new BusinessRuleError('Verification token is required.', 'MISSING_TOKEN');
    }

    const hashedToken = _hashToken(rawToken);

    const user = await User.findOne({
        emailVerificationToken: hashedToken,
        emailVerificationExpires: { $gt: new Date() },
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) {
        throw new BusinessRuleError(
            'Verification link is invalid or has expired. Please request a new one.',
            'INVALID_OR_EXPIRED_TOKEN'
        );
    }

    // Mark as verified and clear token fields
    user.verified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    return { redirectUrl: config.frontend.verifyRedirectUrl };
};

// ─── resendVerification ───────────────────────────────────────────────────────

/**
 * Re-issue and re-send a verification email.
 * Rate-limit is applied at the route level (express-rate-limit).
 *
 * @param {string} email
 */
const resendVerification = async (email) => {
    const user = await User.findOne({ email: email.toLowerCase() })
        .select('+emailVerificationToken +emailVerificationExpires +verified');

    if (!user) {
        // Avoid user enumeration — return same message as success
        return { message: 'If that email exists, a verification link has been sent.' };
    }

    if (user.verified) {
        throw new BusinessRuleError(
            'This account is already verified.',
            'ALREADY_VERIFIED'
        );
    }

    const { rawToken, hashedToken } = _generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    user.emailVerificationToken = hashedToken;
    user.emailVerificationExpires = expiresAt;
    await user.save();

    sendVerificationEmail(user, rawToken).catch((err) => {
        console.error('[Auth] Failed to resend verification email:', err.message);
    });

    return { message: 'If that email exists, a verification link has been sent.' };
};

// ─── loginWithGoogle ──────────────────────────────────────────────────────────

/**
 * Called by the Google OAuth callback route after Passport succeeds.
 * Issues a JWT for the authenticated user.
 *
 * Note: Google OAuth users bypass the email verification gate
 * because Google has already verified the email. They still need
 * admin approval (PENDING → ACTIVE) before accessing the platform.
 *
 * @param {Object} user  — User document from Passport strategy
 * @returns {{ token: string, user: Object, message?: string }}
 */
const loginWithGoogle = (user) => {
    if (user.status === USER_STATUS.PENDING) {
        // Return a token-less response so the frontend can show the approval message.
        // Some frontends prefer a token even for pending users; adjust as needed.
        return {
            token: null,
            user: user.toSafeObject(),
            message: 'Your account is awaiting admin approval. You will be notified once activated.',
        };
    }

    if (user.status === USER_STATUS.REJECTED) {
        throw new AuthenticationError(
            'Your account was rejected by an administrator. Please contact support.'
        );
    }

    const token = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, method: 'google-oauth' },
    });

    return { token, user: user.toSafeObject() };
};

module.exports = { register, login, verifyEmail, resendVerification, loginWithGoogle };
