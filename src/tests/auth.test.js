'use strict';

/**
 * auth.test.js — Authentication Flow Test Suite
 *
 * Covers:
 *  [1] Registration — token creation, verification email fire-and-forget
 *  [2] Email Verification — happy path, expired token, invalid token
 *  [3] Resend Verification — anti-enumeration, already-verified guard
 *  [4] Login gates — unverified, pending, rejected, Google-only account
 *  [5] Login success — JWT issued, audit logged
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { register, login, verifyEmail, resendVerification } = require('../modules/auth/auth.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a group + register a new user, return { user, rawToken }. */
const registerUser = async () => {
    await createGroup({ name: 'Default', percentage: 0 });
    const result = await register({
        name: 'Test User',
        email: `test-${Date.now()}@example.com`,
        password: 'SecurePass@1',
    });
    // Fetch the hashed token from DB
    const dbUser = await User
        .findOne({ email: result.user.email })
        .select('+emailVerificationToken +emailVerificationExpires +verified');

    // Reconstruct the raw token is impossible — instead, use a known raw token.
    // We re-generate by directly seeding: pick a known raw token and hash it.
    const known = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(known).digest('hex');
    dbUser.emailVerificationToken = hash;
    dbUser.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await dbUser.save();

    return { user: dbUser, rawToken: known };
};

// ─────────────────────────────────────────────────────────────────────────────
// [1] Registration
// ─────────────────────────────────────────────────────────────────────────────

describe('[1] Registration', () => {
    beforeEach(async () => {
        await createGroup({ name: 'Default', percentage: 0 });
    });

    it('creates a new user with verified=false and PENDING status', async () => {
        const { user } = await register({
            name: 'Alice',
            email: `alice-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const dbUser = await User.findById(user._id)
            .select('+emailVerificationToken +emailVerificationExpires +verified');

        expect(dbUser.verified).toBe(false);
        expect(dbUser.status).toBe(USER_STATUS.PENDING);
        expect(dbUser.emailVerificationToken).not.toBeNull();
        expect(dbUser.emailVerificationExpires).not.toBeNull();
    });

    it('stores a HASHED token (not raw) in the DB', async () => {
        const { user } = await register({
            name: 'Bob',
            email: `bob-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const dbUser = await User.findById(user._id)
            .select('+emailVerificationToken');

        // Should be a 64-char hex string (SHA-256)
        expect(dbUser.emailVerificationToken).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sets expiry ~24 hours in the future', async () => {
        const before = Date.now();
        const { user } = await register({
            name: 'Charlie',
            email: `charlie-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const dbUser = await User.findById(user._id)
            .select('+emailVerificationExpires');

        const expiresMs = dbUser.emailVerificationExpires.getTime();
        const after = Date.now();

        // Should be within [before + 23h, before + 25h] to be flexible
        expect(expiresMs).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
        expect(expiresMs).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000);
    });

    it('throws ConflictError if email already registered', async () => {
        const email = `dup-${Date.now()}@example.com`;
        await register({ name: 'D1', email, password: 'SecurePass@1' });
        await expect(
            register({ name: 'D2', email, password: 'AnotherPass@1' })
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('does NOT return a JWT token at registration', async () => {
        const result = await register({
            name: 'Eve',
            email: `eve-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });
        expect(result.token).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [2] Email Verification
// ─────────────────────────────────────────────────────────────────────────────

describe('[2] Email Verification', () => {
    it('marks user as verified and clears token on valid token', async () => {
        const { user, rawToken } = await registerUser();
        expect(user.verified).toBe(false);

        await verifyEmail(rawToken);

        const updated = await User.findById(user._id)
            .select('+emailVerificationToken +emailVerificationExpires +verified');

        expect(updated.verified).toBe(true);
        expect(updated.emailVerificationToken).toBeNull();
        expect(updated.emailVerificationExpires).toBeNull();
    });

    it('returns a redirectUrl', async () => {
        const { rawToken } = await registerUser();
        const { redirectUrl } = await verifyEmail(rawToken);
        expect(typeof redirectUrl).toBe('string');
        expect(redirectUrl.length).toBeGreaterThan(0);
    });

    it('throws on invalid token', async () => {
        await registerUser();
        await expect(
            verifyEmail('completely-wrong-token-that-doesnt-match-anything')
        ).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    });

    it('throws on expired token', async () => {
        const { user, rawToken } = await registerUser();

        // Back-date the expiry
        await User.findByIdAndUpdate(user._id, {
            emailVerificationExpires: new Date(Date.now() - 1000),
        });

        await expect(verifyEmail(rawToken))
            .rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    });

    it('throws if token already consumed (used twice)', async () => {
        const { rawToken } = await registerUser();
        await verifyEmail(rawToken);   // first use — clears token

        await expect(verifyEmail(rawToken))
            .rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    });

    it('throws if no token supplied', async () => {
        await expect(verifyEmail(undefined))
            .rejects.toMatchObject({ code: 'MISSING_TOKEN' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] Resend Verification
// ─────────────────────────────────────────────────────────────────────────────

describe('[3] Resend Verification', () => {
    it('re-issues a new token (different from the old one)', async () => {
        const { user, rawToken: _old } = await registerUser();

        const oldHash = (await User.findById(user._id)
            .select('+emailVerificationToken')).emailVerificationToken;

        await resendVerification(user.email);

        const newHash = (await User.findById(user._id)
            .select('+emailVerificationToken')).emailVerificationToken;

        expect(newHash).not.toEqual(oldHash);
        expect(newHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns an anti-enumeration message for unknown email', async () => {
        const result = await resendVerification('nobody@nowhere.com');
        expect(result.message).toMatch(/verification link has been sent/i);
    });

    it('throws ALREADY_VERIFIED for already-verified user', async () => {
        const group = await createGroup({ name: 'VG', percentage: 0 });
        const user = await createCustomer({   // createCustomer sets verified:true by default
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
        });
        await expect(resendVerification(user.email))
            .rejects.toMatchObject({ code: 'ALREADY_VERIFIED' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [4] Login Gates
// ─────────────────────────────────────────────────────────────────────────────

describe('[4] Login gates', () => {
    const email = `gates-${Date.now()}@example.com`;
    const password = 'SecurePass@1';

    beforeEach(async () => {
        await createGroup({ name: 'Default', percentage: 0 });
    });

    it('blocks login when email is not verified', async () => {
        await register({ name: 'Unverified', email, password });
        // Don't verify — status is PENDING, verified=false

        await expect(login({ email, password }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const err = await login({ email, password }).catch((e) => e);
        expect(err.message).toMatch(/verify your email/i);
    });

    it('blocks login when account is PENDING (even if verified)', async () => {
        await register({ name: 'Pending', email: `pending-${Date.now()}@example.com`, password });
        // Manually mark as verified but keep PENDING
        const u = await User.findOne({ email: { $regex: 'pending-' } });
        u.verified = true;
        await u.save();

        await expect(login({ email: u.email, password }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const err = await login({ email: u.email, password }).catch((e) => e);
        expect(err.message).toMatch(/awaiting admin approval/i);
    });

    it('blocks login when account is REJECTED', async () => {
        const group = await createGroup({ name: 'RejGrp', percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.REJECTED,
            verified: true,
            email: `rejected-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        await expect(login({ email: user.email, password: 'SecurePass@1' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const err = await login({ email: user.email, password: 'SecurePass@1' }).catch((e) => e);
        expect(err.message).toMatch(/rejected/i);
    });

    it('blocks password login for Google-only accounts', async () => {
        const group = await createGroup({ name: 'GoogleGrp', percentage: 0 });
        await User.create({
            name: 'Google User',
            email: `goauth-${Date.now()}@example.com`,
            googleId: 'google-uid-123',
            role: 'CUSTOMER',
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
            // No password field
        });
        const u = await User.findOne({ googleId: 'google-uid-123' });

        await expect(login({ email: u.email, password: 'any-pass' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [5] Login Success
// ─────────────────────────────────────────────────────────────────────────────

describe('[5] Login success', () => {
    it('issues a JWT when verified + ACTIVE + correct password', async () => {
        const group = await createGroup({ name: 'Success', percentage: 0 });
        const user = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.ACTIVE,
            verified: true,
        });

        // Re-set password via the model's pre-save hook
        const raw = 'ThePassword@1';
        const fresh = await User.findById(user._id);
        fresh.password = raw;
        await fresh.save();

        const result = await login({ email: user.email, password: raw });
        expect(result.token).toBeDefined();
        expect(typeof result.token).toBe('string');
        expect(result.token.split('.')).toHaveLength(3);   // JWT has 3 parts
        expect(result.user.password).toBeUndefined();
    });
});
