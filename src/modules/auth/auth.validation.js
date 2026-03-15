'use strict';

const { body } = require('express-validator');

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
        .optional()
        .trim()
        .isLength({ max: 30 }),

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

module.exports = { registerValidation, loginValidation };
