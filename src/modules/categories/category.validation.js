'use strict';

/**
 * category.validation.js
 *
 * Joi schemas for Category admin API inputs.
 */

const Joi = require('joi');

const createCategorySchema = Joi.object({
    name: Joi.string().trim().min(1).max(100).required().messages({
        'any.required': 'Category name is required',
        'string.min': 'Category name must be at least 1 character',
    }),
    nameAr: Joi.string().trim().max(100).allow('', null),
    image: Joi.string().uri({ allowRelative: true }).allow('', null),
    sortOrder: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true),
});

const updateCategorySchema = Joi.object({
    name: Joi.string().trim().min(1).max(100),
    nameAr: Joi.string().trim().max(100).allow('', null),
    image: Joi.string().uri({ allowRelative: true }).allow('', null),
    slug: Joi.string().trim().lowercase(),
    sortOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
}).min(1).messages({
    'object.min': 'At least one field must be provided for update',
});

module.exports = {
    createCategorySchema,
    updateCategorySchema,
};
