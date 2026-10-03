'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const authService = require('../modules/auth/auth.service');
const userService = require('../modules/users/user.service');
const authenticate = require('../shared/middlewares/authenticate');
const requireCompleteProfile = require('../shared/middlewares/requireCompleteProfile');
const { normalizePhone } = require('../shared/utils/phone');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);

const invokeMiddleware = (middleware, req) => new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
});

describe('phone normalization and completion', () => {
    it('normalizes Arabic-Indic and formatted international phone input', () => {
        expect(normalizePhone('01012345678')).toBe('01012345678');
        expect(normalizePhone('٠١٠١٢٣٤٥٦٧٨')).toBe('01012345678');
        expect(normalizePhone('۰۱۰۱۲۳۴۵۶۷۸')).toBe('01012345678');
        expect(normalizePhone('+20 (101) 234-5678')).toBe('+201012345678');
        expect(normalizePhone('+966501234567')).toBe('+966501234567');
    });

    it('rejects malformed phone input', () => {
        [
            'abc010123456', '++201012345678', '20+1012345678', '+20/1012345678',
            '12.34', '+', '123456', '1234567890123456',
        ].forEach((phone) => expect(() => normalizePhone(phone)).toThrow());
    });

    it('rejects missing local-registration phone before creating a user', async () => {
        await expect(authService.register({
            name: 'No Phone', email: 'no-phone@test.com', password: 'ValidPass@1',
        })).rejects.toMatchObject({ code: 'INVALID_PHONE', statusCode: 422 });
        expect(await User.countDocuments()).toBe(0);
    });

    it('persists a normalized local registration phone and permits duplicates', async () => {
        await createGroup({ name: 'Phone registration group', percentage: 0 });
        const first = await authService.register({
            name: 'First User', email: 'first-phone@test.com', password: 'ValidPass@1', phone: '٠١٠١٢٣٤٥٦٧٨',
        });
        const second = await authService.register({
            name: 'Second User', email: 'second-phone@test.com', password: 'ValidPass@1', phone: '01012345678',
        });

        expect((await User.findById(first.user._id)).phone).toBe('01012345678');
        expect((await User.findById(second.user._id)).phone).toBe('01012345678');
    });

    it('allows an active legacy customer to log in with completion state', async () => {
        const group = await createGroup({ name: 'Legacy login group', percentage: 0 });
        const { _id, email } = await createCustomer({ groupId: group._id, password: 'ValidPass@1' });
        const result = await authService.login({ email, password: 'ValidPass@1' });

        expect(result.token).toBeTruthy();
        expect(result.user.profileCompletionRequired).toBe(true);
        expect(result.user.missingProfileFields).toEqual(['phone']);
        expect(result.user._id.toString()).toBe(_id.toString());
    });

    it('completes only phone without changing financial or authorization state', async () => {
        const group = await createGroup({ name: 'Legacy completion group', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, walletBalance: 321, creditLimit: 40, creditUsed: 5 });
        const result = await userService.completeMyPhone(customer._id, '+20 (101) 234-5678');
        const updated = await User.findById(customer._id);

        expect(result.profileCompletionRequired).toBe(false);
        expect(updated.phone).toBe('+201012345678');
        expect(updated.walletBalance).toBe(321);
        expect(updated.creditLimit).toBe(40);
        expect(updated.creditUsed).toBe(5);
        expect(updated.role).toBe(ROLES.CUSTOMER);
        expect(updated.status).toBe(USER_STATUS.ACTIVE);
    });

    it('rejects malformed self-service phone updates with a stable validation error', async () => {
        const group = await createGroup({ name: 'Invalid phone group', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, phone: '01012345678' });

        await expect(userService.completeMyPhone(customer._id, 'not-a-phone'))
            .rejects.toMatchObject({ code: 'INVALID_PHONE', statusCode: 422 });
        expect((await User.findById(customer._id)).phone).toBe('01012345678');
    });

    it('does not let a completed customer clear a phone, while legacy staff can save a blank phone', async () => {
        const group = await createGroup({ name: 'Profile update group', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, phone: '01012345678' });
        const staff = await User.create({
            name: 'Legacy Admin', email: 'legacy-admin@test.com', password: 'ValidPass@1',
            role: ROLES.ADMIN, groupId: group._id, status: USER_STATUS.ACTIVE, verified: true,
        });

        await expect(userService.updateMyProfile(customer._id, { phone: '   ' }))
            .rejects.toMatchObject({ code: 'INVALID_PHONE', statusCode: 422 });
        await userService.updateMyProfile(staff._id, { name: 'Updated Admin', phone: '' });

        expect((await User.findById(customer._id)).phone).toBe('01012345678');
        expect((await User.findById(staff._id)).phone).toBeNull();
    });

    it('blocks incomplete customer business access but bypasses staff', () => {
        const next = jest.fn();
        expect(() => requireCompleteProfile({}, {}, next))
            .toThrow(/authentication/i);
        expect(() => requireCompleteProfile({ user: { role: ROLES.CUSTOMER, phone: null } }, {}, next)).toThrow(/phone/i);
        requireCompleteProfile({ user: { role: ROLES.ADMIN, phone: null } }, {}, next);
        requireCompleteProfile({ user: { role: ROLES.SUPERVISOR, phone: null } }, {}, next);
        expect(next).toHaveBeenCalledTimes(2);
    });

    it('uses a short-lived Google completion token without activating pending users', async () => {
        const group = await createGroup({ name: 'Google phone group', percentage: 0 });
        const user = await User.create({
            name: 'Google Pending', email: 'google-phone@test.com', googleId: 'google-phone-id',
            role: ROLES.CUSTOMER, groupId: group._id, status: USER_STATUS.PENDING, verified: true,
        });
        const start = authService.loginWithGoogle(user);
        expect(start.token).toBeUndefined();
        expect(start.completionToken).toBeTruthy();

        const completed = await authService.completeGoogleProfile({
            completionToken: start.completionToken,
            phone: '+966501234567',
        });
        const updated = await User.findById(user._id);
        expect(completed.token).toBeNull();
        expect(updated.status).toBe(USER_STATUS.PENDING);
        expect(updated.phone).toBe('+966501234567');
    });

    it('does not accept a Google completion token as an ordinary authenticated session', async () => {
        const group = await createGroup({ name: 'Google token guard group', percentage: 0 });
        const user = await createCustomer({ groupId: group._id });
        const completionToken = authService.signProfileCompletionToken(user._id);
        const error = await invokeMiddleware(authenticate, {
            headers: { authorization: `Bearer ${completionToken}` },
        });

        expect(error).toMatchObject({ code: 'AUTHENTICATION_ERROR', statusCode: 401 });
    });

    it('rejects normal, expired, and malformed JWTs at Google completion without changing the user', async () => {
        const group = await createGroup({ name: 'Completion token validation group', percentage: 0 });
        const user = await createCustomer({ groupId: group._id });
        const normalToken = jwt.sign({ id: user._id, role: ROLES.CUSTOMER }, config.jwt.secret, { expiresIn: '10m' });
        const expiredToken = jwt.sign(
            { id: user._id, purpose: 'profile-completion' }, config.jwt.secret, { expiresIn: '-1s' }
        );

        for (const completionToken of [normalToken, expiredToken, 'not-a-token']) {
            await expect(authService.completeGoogleProfile({ completionToken, phone: '01012345678' }))
                .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', statusCode: 401 });
        }
        expect((await User.findById(user._id)).phone).toBeNull();
    });

    it('preserves 2FA before returning legacy completion state', async () => {
        const group = await createGroup({ name: '2FA completion group', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id });
        const tempToken = authService.signTwoFactorTempToken(customer._id, ROLES.CUSTOMER);
        await User.findByIdAndUpdate(customer._id, {
            $set: {
                isTwoFactorEnabled: true,
                twoFactorOtp: authService.hashSecret('123456'),
                twoFactorOtpExpires: new Date(Date.now() + 60_000),
                twoFactorTempToken: authService.hashSecret(tempToken),
                twoFactorTempTokenExpires: new Date(Date.now() + 60_000),
            },
        });

        const result = await authService.verify2FA({ otp: '123456', tempToken });
        expect(result.token).toBeTruthy();
        expect(result.user.profileCompletionRequired).toBe(true);
        expect(result.user.missingProfileFields).toEqual(['phone']);
    });

    it('allows Google linking to save a legacy user with no phone', async () => {
        const group = await createGroup({ name: 'Google linking group', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id });

        customer.googleId = 'linked-google-id';
        customer.verified = true;
        await customer.save();

        const linked = await User.findById(customer._id);
        expect(linked.googleId).toBe('linked-google-id');
        expect(linked.phone).toBeNull();
    });

    it('keeps Google users with a valid phone on their normal flow and rejects rejected users', async () => {
        const group = await createGroup({ name: 'Google state group', percentage: 0 });
        const active = await User.create({
            name: 'Google Active', email: 'google-active@test.com', googleId: 'google-active-id',
            phone: '01012345678', role: ROLES.CUSTOMER, groupId: group._id,
            status: USER_STATUS.ACTIVE, verified: true,
        });
        const rejected = await User.create({
            name: 'Google Rejected', email: 'google-rejected@test.com', googleId: 'google-rejected-id',
            role: ROLES.CUSTOMER, groupId: group._id, status: USER_STATUS.REJECTED, verified: true,
        });

        const result = authService.loginWithGoogle(active);
        expect(result.token).toBeTruthy();
        expect(result.completionToken).toBeUndefined();
        expect(() => authService.loginWithGoogle(rejected))
            .toThrow(/rejected/i);
    });
});
