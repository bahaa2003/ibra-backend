'use strict';

const { body, query, param } = require('express-validator');
const { DEPOSIT_STATUS } = require('./deposit.model');

const createDepositValidation = [
    body('amountRequested')
        .notEmpty().withMessage('amountRequested is required')
        .isFloat({ gt: 0 }).withMessage('amountRequested must be a positive number'),

    body('transferImageUrl')
        .notEmpty().withMessage('transferImageUrl is required')
        .isURL().withMessage('transferImageUrl must be a valid URL')
        .isLength({ max: 2048 }).withMessage('transferImageUrl cannot exceed 2048 characters'),

    body('transferredFromNumber')
        .notEmpty().withMessage('transferredFromNumber is required')
        .isString().withMessage('transferredFromNumber must be a string')
        .trim()
        .isLength({ min: 1, max: 100 }).withMessage('transferredFromNumber must be 1–100 characters'),
];

const approveDepositValidation = [
    param('id')
        .isMongoId().withMessage('Invalid deposit request ID'),

    body('overrideAmount')
        .optional()
        .isFloat({ gt: 0 }).withMessage('overrideAmount must be a positive number'),
];

const rejectDepositValidation = [
    param('id')
        .isMongoId().withMessage('Invalid deposit request ID'),
];

const listDepositsValidation = [
    query('status')
        .optional()
        .isIn(Object.values(DEPOSIT_STATUS))
        .withMessage(`status must be one of: ${Object.values(DEPOSIT_STATUS).join(', ')}`),

    query('page')
        .optional()
        .isInt({ min: 1 }).withMessage('page must be a positive integer'),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
];

module.exports = {
    createDepositValidation,
    approveDepositValidation,
    rejectDepositValidation,
    listDepositsValidation,
};
