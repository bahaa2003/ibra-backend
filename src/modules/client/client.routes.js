'use strict';

const { Router } = require('express');

const apiAuth = require('../../shared/middlewares/apiAuth');
const requireCompleteProfile = require('../../shared/middlewares/requireCompleteProfile');
const clientController = require('./client.controller');
const {
    createClientOrderValidation,
    checkOrdersValidation,
    validateClientRequest,
} = require('./client.validation');

const router = Router();

router.use(apiAuth);

router.get('/profile', clientController.getProfile);
router.use(requireCompleteProfile);
router.get('/products', clientController.getProducts);

router.post(
    '/orders',
    createClientOrderValidation,
    validateClientRequest,
    clientController.createOrder
);

router.get(
    '/check',
    checkOrdersValidation,
    validateClientRequest,
    clientController.checkOrders
);

module.exports = router;
