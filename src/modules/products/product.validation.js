'use strict';

const { body, param, query } = require('express-validator');
const { PRICING_MODES, MARKUP_TYPES, EXECUTION_TYPES } = require('./product.model');

// ─── User-facing / shared validation ─────────────────────────────────────────

const productIdParam = [
    param('id').isMongoId().withMessage('Invalid product ID'),
];

const listProductsValidation = [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1–200'),
];

// ─── Admin: create standalone product ────────────────────────────────────────

const createProductValidation = [
    body('name')
        .trim()
        .notEmpty().withMessage('name is required')
        .isLength({ min: 2, max: 200 }).withMessage('name must be 2–200 characters'),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .notEmpty().withMessage('basePrice is required')
        .isFloat({ min: 0.01 }).withMessage('basePrice must be > 0'),

    body('minQty')
        .notEmpty().withMessage('minQty is required')
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .notEmpty().withMessage('maxQty is required')
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1')
        .custom((v, { req }) => {
            if (parseInt(v) < parseInt(req.body.minQty)) {
                throw new Error('maxQty must be >= minQty');
            }
            return true;
        }),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isURL().withMessage('image must be a valid URL'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean().withMessage('isActive must be a boolean'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),
];

// ─── Admin: publish from provider product ────────────────────────────────────

const publishProductValidation = [
    body('providerProductId')
        .notEmpty().withMessage('providerProductId is required')
        .isMongoId().withMessage('Invalid providerProductId'),

    body('name')
        .trim()
        .notEmpty().withMessage('name is required')
        .isLength({ min: 2, max: 200 }).withMessage('name must be 2–200 characters'),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .optional({ nullable: true })
        .isFloat({ min: 0.01 }).withMessage('basePrice must be > 0, if provided'),

    body('minQty')
        .optional()
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .optional()
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1'),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isURL().withMessage('image must be a valid URL'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean(),

    body('pricingMode')
        .optional()
        .isIn(Object.values(PRICING_MODES))
        .withMessage(`pricingMode must be one of: ${Object.values(PRICING_MODES).join(', ')}`),

    body('markupType')
        .optional()
        .isIn(Object.values(MARKUP_TYPES))
        .withMessage(`markupType must be one of: ${Object.values(MARKUP_TYPES).join(', ')}`),

    body('markupValue')
        .optional()
        .isFloat({ min: 0 }).withMessage('markupValue must be >= 0'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),
];

// ─── Admin: update product ────────────────────────────────────────────────────

const updateProductValidation = [
    param('id').isMongoId().withMessage('Invalid product ID'),

    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 200 }).withMessage('name must be 2–200 characters'),

    body('description')
        .optional({ nullable: true })
        .isString().trim(),

    body('basePrice')
        .optional()
        .isFloat({ min: 0.01 }).withMessage('basePrice must be > 0'),

    body('minQty')
        .optional()
        .isInt({ min: 1 }).withMessage('minQty must be >= 1'),

    body('maxQty')
        .optional()
        .isInt({ min: 1 }).withMessage('maxQty must be >= 1'),

    body('category')
        .optional({ nullable: true })
        .isString().trim(),

    body('image')
        .optional({ nullable: true })
        .isURL().withMessage('image must be a valid URL'),

    body('displayOrder')
        .optional()
        .isInt().withMessage('displayOrder must be an integer'),

    body('isActive')
        .optional()
        .isBoolean(),

    body('pricingMode')
        .optional()
        .isIn(Object.values(PRICING_MODES))
        .withMessage(`pricingMode must be one of: ${Object.values(PRICING_MODES).join(', ')}`),

    body('markupType')
        .optional()
        .isIn(Object.values(MARKUP_TYPES))
        .withMessage(`markupType must be one of: ${Object.values(MARKUP_TYPES).join(', ')}`),

    body('markupValue')
        .optional()
        .isFloat({ min: 0 }).withMessage('markupValue must be >= 0'),

    body('executionType')
        .optional()
        .isIn(Object.values(EXECUTION_TYPES))
        .withMessage(`executionType must be one of: ${Object.values(EXECUTION_TYPES).join(', ')}`),
];

module.exports = {
    productIdParam,
    listProductsValidation,
    createProductValidation,
    publishProductValidation,
    updateProductValidation,
};
