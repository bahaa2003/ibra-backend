'use strict';

/**
 * admin.orders.controller.js
 */

const svc = require('./admin.orders.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');

// GET /admin/orders
const listOrders = catchAsync(async (req, res) => {
    const { status, userId, providerId, from, to, page, limit } = req.query;
    const result = await svc.listOrders({
        status,
        userId,
        providerId,
        from,
        to,
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 20, 10),
    });
    sendPaginated(res, result.orders, result.pagination, 'Orders retrieved');
});

// GET /admin/orders/:id
const getOrderById = catchAsync(async (req, res) => {
    const order = await svc.getOrderById(req.params.id);
    sendSuccess(res, { order }, 'Order retrieved');
});

// POST /admin/orders/:id/retry
const retryOrder = catchAsync(async (req, res) => {
    const order = await svc.retryOrder(req.params.id, req.user._id);
    sendSuccess(res, { order }, 'Order re-submitted to provider');
});

// POST /admin/orders/:id/refund
const refundOrder = catchAsync(async (req, res) => {
    const order = await svc.refundOrder(req.params.id, req.user._id);
    sendSuccess(res, { order }, 'Order refunded');
});

// POST /admin/orders/:id/sync-status
const syncOrderProviderStatus = catchAsync(async (req, res) => {
    const order = await svc.syncOrderProviderStatus(req.params.id, req.user._id);
    sendSuccess(res, { order }, 'Order status synced from provider');
});

// POST /admin/orders/:id/complete
const completeOrder = catchAsync(async (req, res) => {
    const order = await svc.completeOrder(req.params.id, req.user._id);
    sendSuccess(res, { order }, 'Order manually completed');
});

module.exports = { listOrders, getOrderById, retryOrder, refundOrder, syncOrderProviderStatus, completeOrder };
