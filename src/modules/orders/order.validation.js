'use strict';

const { body, param } = require('express-validator');

const createOrderValidation = [
    body('productId')
        .notEmpty().withMessage('Product ID is required')
        .isMongoId().withMessage('Invalid product ID format'),

    body('quantity')
        .notEmpty().withMessage('Quantity is required')
        .isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),

    // orderFieldsValues is optional at the HTTP layer.
    // Deep field-by-field validation happens inside orderFields.validator.js
    // using the product's own orderFields definition.
    body('orderFieldsValues')
        .optional({ nullable: true })
        .isObject().withMessage('orderFieldsValues must be an object'),
];

const orderIdParamValidation = [
    param('id')
        .isMongoId().withMessage('Invalid order ID format'),
];

module.exports = { createOrderValidation, orderIdParamValidation };

