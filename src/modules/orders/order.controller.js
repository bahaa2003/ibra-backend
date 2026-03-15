'use strict';

const orderService = require('./order.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

// ── Customer Endpoints ────────────────────────────────────────────────────────

const createOrder = catchAsync(async (req, res) => {
    const { productId, quantity, orderFieldsValues } = req.body;

    // Extract optional idempotency key from header
    const idempotencyKey = req.headers['idempotency-key'] || null;

    const auditContext = {
        actorId: req.user._id,
        actorRole: 'CUSTOMER',
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const { order, idempotent } = await orderService.createOrder({
        userId: req.user._id,
        productId,
        quantity: parseInt(quantity, 10),
        idempotencyKey,
        orderFieldsValues: orderFieldsValues ?? null,
        auditContext,
    });

    if (idempotent) {
        return sendSuccess(res, order, 'Order already exists (idempotent response).');
    }

    sendCreated(res, order, 'Order placed successfully.');
});

const getMyOrders = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { orders, pagination } = await orderService.listOrdersForUser(req.user._id, {
        page,
        limit,
    });

    sendPaginated(res, orders, pagination, 'Orders retrieved successfully.');
});

const getMyOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id, req.user._id);
    sendSuccess(res, order);
});

// ── Admin Endpoints ───────────────────────────────────────────────────────────

const getAllOrders = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { status } = req.query;

    const { orders, pagination } = await orderService.listAllOrders({ page, limit, status });
    sendPaginated(res, orders, pagination, 'Orders retrieved successfully.');
});

const adminGetOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id);
    sendSuccess(res, order);
});

const failOrder = catchAsync(async (req, res) => {
    const order = await orderService.markOrderAsFailed(req.params.id);
    sendSuccess(res, order, 'Order marked as failed and refund issued.');
});

const completeOrder = catchAsync(async (req, res) => {
    const order = await orderService.markOrderAsCompleted(req.params.id);
    sendSuccess(res, order, 'Order marked as completed.');
});

module.exports = {
    createOrder,
    getMyOrders,
    getMyOrder,
    getAllOrders,
    adminGetOrder,
    failOrder,
    completeOrder,
};
