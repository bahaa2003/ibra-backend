'use strict';

const { body } = require('express-validator');
const { normalizePhone } = require('../../shared/utils/phone');

const validPhone = (value) => {
    normalizePhone(value);
    return true;
};

const registerValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('Name is required')
        .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

    body('email')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('password')
        .notEmpty().withMessage('Password is required')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),

    body('currency')
        .optional()
        .trim()
        .isLength({ min: 2, max: 10 }).withMessage('Currency code must be between 2 and 10 characters'),

    body('country')
        .optional()
        .trim()
        .isLength({ max: 100 }),

    body('phone')
        .notEmpty().withMessage('Phone number is required')
        .bail()
        .custom(validPhone),

    body('username')
        .optional()
        .trim()
        .isLength({ max: 100 }),
];

const loginValidation = [
    body('email')
        .trim()
        .notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Please provide a valid email address')
        .normalizeEmail(),

    body('password')
        .notEmpty().withMessage('Password is required'),
];

const otpValidation = body('otp')
    .trim()
    .matches(/^\d{6}$/).withMessage('otp must be a 6-digit code');

const optionalTwoFactorTokenValidation = [
    body('tempToken')
        .optional()
        .trim()
        .isString().withMessage('tempToken must be a string')
        .isLength({ min: 20 }).withMessage('tempToken is invalid'),

    body('requestId')
        .optional()
        .trim()
        .isString().withMessage('requestId must be a string')
        .isLength({ min: 20 }).withMessage('requestId is invalid'),
];

const enable2FAValidation = [
    otpValidation,
    ...optionalTwoFactorTokenValidation,
    body()
        .custom((value) => Boolean(value.tempToken || value.requestId))
        .withMessage('tempToken or requestId is required'),
];

const disable2FAValidation = [
    body('currentPassword')
        .optional()
        .isString().withMessage('currentPassword must be a string')
        .isLength({ min: 1 }).withMessage('currentPassword is required'),

    body('password')
        .optional()
        .isString().withMessage('password must be a string')
        .isLength({ min: 1 }).withMessage('password is required'),

    body()
        .custom((value) => Boolean(value.currentPassword || value.password))
        .withMessage('currentPassword is required'),
];

const verify2FAValidation = [
    otpValidation,
    ...optionalTwoFactorTokenValidation,
    body()
        .custom((value) => Boolean(value.tempToken || value.requestId))
        .withMessage('tempToken or requestId is required'),
];

const completeGoogleProfileValidation = [
    body('completionToken')
        .trim()
        .notEmpty().withMessage('Completion token is required'),
    body('phone')
        .notEmpty().withMessage('Phone number is required')
        .bail()
        .custom(validPhone),
];

module.exports = {
    registerValidation,
    loginValidation,
    enable2FAValidation,
    disable2FAValidation,
    verify2FAValidation,
    completeGoogleProfileValidation,
};
