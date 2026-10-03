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
const { sendVerificationEmail, sendTwoFactorOtpEmail } = require('../../services/email.service');
const {
    AuthenticationError,
    ConflictError,
    BusinessRuleError,
    NotFoundError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { USER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { safeCreateAdminActorNotifications } = require('../notifications/notification.service');
const { normalizePhone } = require('../../shared/utils/phone');
const { getProfileCompletionState, toSafeUserWithProfileCompletion } = require('../../shared/utils/profileCompletion');

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

const TWO_FACTOR_PURPOSE = '2fa-pending';
const PROFILE_COMPLETION_PURPOSE = 'profile-completion';
const TWO_FACTOR_TTL_MINUTES = 10;
const PROFILE_COMPLETION_TTL_MINUTES = 10;
const TWO_FACTOR_TTL_MS = TWO_FACTOR_TTL_MINUTES * 60 * 1000;

const signTwoFactorTempToken = (userId, role) =>
    jwt.sign(
        { id: userId, role, purpose: TWO_FACTOR_PURPOSE },
        config.jwt.secret,
        { expiresIn: `${TWO_FACTOR_TTL_MINUTES}m` }
    );

const signProfileCompletionToken = (userId) =>
    jwt.sign(
        { id: userId, purpose: PROFILE_COMPLETION_PURPOSE },
        config.jwt.secret,
        { expiresIn: `${PROFILE_COMPLETION_TTL_MINUTES}m` }
    );

const hashSecret = (secret) =>
    crypto.createHash('sha256').update(String(secret || '')).digest('hex');

const generateOtp = () =>
    String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

const timingSafeCompareHex = (left, right) => {
    const leftValue = String(left || '');
    const rightValue = String(right || '');
    if (!leftValue || !rightValue || leftValue.length !== rightValue.length) {
        return false;
    }

    try {
        return crypto.timingSafeEqual(
            Buffer.from(leftValue, 'hex'),
            Buffer.from(rightValue, 'hex')
        );
    } catch {
        return false;
    }
};

const maskEmail = (email = '') => {
    const [name, domain] = String(email || '').split('@');
    if (!name || !domain) return email;
    if (name.length <= 2) return `${name.slice(0, 1)}***@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
};

const clearTwoFactorChallenge = async (user) => {
    user.twoFactorOtp = null;
    user.twoFactorOtpExpires = null;
    user.twoFactorTempToken = null;
    user.twoFactorTempTokenExpires = null;
    await user.save();
    return user;
};

const issueTwoFactorChallenge = async (user) => {
    const otp = generateOtp();
    const tempToken = signTwoFactorTempToken(user._id, user.role);
    const expiresAt = new Date(Date.now() + TWO_FACTOR_TTL_MS);

    user.twoFactorOtp = hashSecret(otp);
    user.twoFactorOtpExpires = expiresAt;
    user.twoFactorTempToken = hashSecret(tempToken);
    user.twoFactorTempTokenExpires = expiresAt;
    await user.save();

    await sendTwoFactorOtpEmail(user, otp, { expiresMinutes: TWO_FACTOR_TTL_MINUTES });

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.TWO_FACTOR_CHALLENGE_ISSUED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return {
        tempToken,
        requestId: tempToken,
        email: user.email,
        maskedEmail: maskEmail(user.email),
        expiresIn: TWO_FACTOR_TTL_MS / 1000,
    };
};

const verifyTwoFactorChallenge = (user, { otp, tempToken }) => {
    if (!tempToken) {
        throw new AuthenticationError('Two-factor verification token is required.');
    }

    let decoded;
    try {
        decoded = jwt.verify(tempToken, config.jwt.secret);
    } catch {
        throw new AuthenticationError('Two-factor verification has expired. Please log in again.');
    }

    if (
        decoded.purpose !== TWO_FACTOR_PURPOSE ||
        String(decoded.id) !== String(user._id)
    ) {
        throw new AuthenticationError('Invalid two-factor verification token.');
    }

    const challengeExpired = (
        !user.twoFactorOtp ||
        !user.twoFactorOtpExpires ||
        user.twoFactorOtpExpires.getTime() <= Date.now() ||
        !user.twoFactorTempToken ||
        !user.twoFactorTempTokenExpires ||
        user.twoFactorTempTokenExpires.getTime() <= Date.now()
    );

    if (challengeExpired) {
        throw new BusinessRuleError('Two-factor code has expired. Request a new code.', 'OTP_EXPIRED');
    }

    if (!timingSafeCompareHex(user.twoFactorTempToken, hashSecret(tempToken))) {
        throw new AuthenticationError('Invalid two-factor verification token.');
    }

    if (!timingSafeCompareHex(user.twoFactorOtp, hashSecret(otp))) {
        throw new BusinessRuleError('Invalid two-factor code.', 'INVALID_OTP');
    }
};

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
    let normalizedPhone;
    try {
        normalizedPhone = normalizePhone(phone);
    } catch (error) {
        throw new BusinessRuleError(error.message, 'INVALID_PHONE');
    }
    // ── 1. Prevent duplicate accounts ─────────────────────────────────────────
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
        throw new ConflictError('email already exists');
    }

    if (username) {
        const existingUsername = await User.findOne({ username: username.toLowerCase() });
        if (existingUsername) {
            throw new ConflictError('username already exists');
        }
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
        phone: normalizedPhone,
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

    if (user.status === USER_STATUS.PENDING) {
        void safeCreateAdminActorNotifications({
            title: 'تسجيل مستخدم جديد',
            message: 'قام مستخدم جديد بالتسجيل وبانتظار تفعيل حسابه.',
            type: 'account',
            priority: 'normal',
            route: `/admin/users?userId=${user._id.toString()}`,
            entityType: 'user',
            entityId: user._id,
            metadata: {
                userId: user._id.toString(),
                email: user.email,
                name: user.name,
                status: user.status,
            },
        });
    }

    return {
        user: toSafeUserWithProfileCompletion(user),
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
        .select('+password +verified +twoFactorOtp +twoFactorOtpExpires +twoFactorTempToken +twoFactorTempTokenExpires');

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

    if (user.isTwoFactorEnabled) {
        const challenge = await issueTwoFactorChallenge(user);
        return {
            requires2FA: true,
            tempToken: challenge.tempToken,
            requestId: challenge.requestId,
            email: challenge.email,
            maskedEmail: challenge.maskedEmail,
            expiresIn: challenge.expiresIn,
        };
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

    return { token, user: toSafeUserWithProfileCompletion(user) };
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
    if (user.status === USER_STATUS.REJECTED) {
        throw new AuthenticationError(
            'Your account was rejected by an administrator. Please contact support.'
        );
    }

    const completion = getProfileCompletionState(user);
    if (completion.profileCompletionRequired) {
        return {
            profileCompletionRequired: true,
            missingProfileFields: completion.missingProfileFields,
            completionToken: signProfileCompletionToken(user._id),
            user: toSafeUserWithProfileCompletion(user),
        };
    }

    if (user.status === USER_STATUS.PENDING) {
        // Return a token-less response so the frontend can show the approval message.
        // Some frontends prefer a token even for pending users; adjust as needed.
        return {
            token: null,
            user: toSafeUserWithProfileCompletion(user),
            message: 'Your account is awaiting admin approval. You will be notified once activated.',
        };
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

    return { token, user: toSafeUserWithProfileCompletion(user) };
};

const completeGoogleProfile = async ({ completionToken, phone }) => {
    let decoded;
    try {
        decoded = jwt.verify(completionToken, config.jwt.secret);
    } catch {
        throw new AuthenticationError('Profile completion session has expired. Please sign in with Google again.');
    }

    if (decoded.purpose !== PROFILE_COMPLETION_PURPOSE) {
        throw new AuthenticationError('Invalid profile completion token.');
    }

    const user = await User.findById(decoded.id);
    if (!user) throw new NotFoundError('User');
    if (user.role !== ROLES.CUSTOMER) {
        throw new AuthenticationError('Profile completion is not required for this account.');
    }
    if (user.status === USER_STATUS.REJECTED) {
        throw new AuthenticationError('Your account was rejected by an administrator. Please contact support.');
    }

    user.phone = normalizePhone(phone);
    await user.save();

    const safeUser = toSafeUserWithProfileCompletion(user);
    if (user.status === USER_STATUS.PENDING) {
        return { token: null, user: safeUser, status: user.status };
    }

    return { token: signToken(user._id, user.role), user: safeUser, status: user.status };
};

const generate2FASecret = async (userId) => {
    const user = await User.findById(userId)
        .select('+twoFactorOtp +twoFactorOtpExpires +twoFactorTempToken +twoFactorTempTokenExpires');
    if (!user) throw new NotFoundError('User');

    return issueTwoFactorChallenge(user);
};

const enable2FA = async ({ userId, otp, tempToken, requestId }) => {
    const user = await User.findById(userId)
        .select('+twoFactorOtp +twoFactorOtpExpires +twoFactorTempToken +twoFactorTempTokenExpires');
    if (!user) throw new NotFoundError('User');

    verifyTwoFactorChallenge(user, { otp, tempToken: tempToken || requestId });

    user.isTwoFactorEnabled = true;
    await clearTwoFactorChallenge(user);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.TWO_FACTOR_ENABLED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return { user: toSafeUserWithProfileCompletion(user), twoFactorEnabled: true };
};

const disable2FA = async ({ userId, currentPassword }) => {
    const user = await User.findById(userId)
        .select('+password +twoFactorOtp +twoFactorOtpExpires +twoFactorTempToken +twoFactorTempTokenExpires');
    if (!user) throw new NotFoundError('User');

    if (!user.password) {
        throw new BusinessRuleError('Password confirmation is not available for this account.', 'PASSWORD_NOT_AVAILABLE');
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
        throw new AuthenticationError('Current password is incorrect.');
    }

    user.isTwoFactorEnabled = false;
    await clearTwoFactorChallenge(user);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.TWO_FACTOR_DISABLED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    return { user: toSafeUserWithProfileCompletion(user), twoFactorEnabled: false };
};

const verify2FA = async ({ otp, tempToken, requestId }) => {
    const tokenToVerify = tempToken || requestId;
    if (!tokenToVerify) {
        throw new AuthenticationError('Two-factor verification token is required.');
    }

    let decoded;
    try {
        decoded = jwt.verify(tokenToVerify, config.jwt.secret);
    } catch {
        throw new AuthenticationError('Two-factor verification has expired. Please log in again.');
    }

    if (decoded.purpose !== TWO_FACTOR_PURPOSE) {
        throw new AuthenticationError('Invalid two-factor verification token.');
    }

    const user = await User.findById(decoded.id)
        .select('+twoFactorOtp +twoFactorOtpExpires +twoFactorTempToken +twoFactorTempTokenExpires');
    if (!user) throw new NotFoundError('User');

    if (user.status !== USER_STATUS.ACTIVE) {
        throw new AuthenticationError('Your account is not active. Contact an administrator.');
    }

    verifyTwoFactorChallenge(user, { otp, tempToken: tokenToVerify });
    await clearTwoFactorChallenge(user);

    const token = signToken(user._id, user.role);

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.TWO_FACTOR_VERIFIED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email },
    });

    createAuditLog({
        actorId: user._id,
        actorRole: ACTOR_ROLES[user.role] ?? user.role,
        action: USER_ACTIONS.LOGIN_SUCCESS,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, twoFactor: true },
    });

    return { token, user: toSafeUserWithProfileCompletion(user) };
};

module.exports = {
    register,
    login,
    verifyEmail,
    resendVerification,
    loginWithGoogle,
    completeGoogleProfile,
    generate2FASecret,
    enable2FA,
    disable2FA,
    verify2FA,
    signTwoFactorTempToken,
    signProfileCompletionToken,
    hashSecret,
    generateOtp,
    timingSafeCompareHex,
    clearTwoFactorChallenge,
    issueTwoFactorChallenge,
};
