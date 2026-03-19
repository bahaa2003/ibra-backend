'use strict';

/**
 * admin.stats.controller.js — Admin Dashboard Statistics
 *
 * Provides aggregated metrics from the database using MongoDB aggregation.
 * All profit figures are in USD (the system base currency).
 */

const { Order, ORDER_STATUS } = require('../orders/order.model');
const { User } = require('../users/user.model');
const { Product } = require('../products/product.model');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');

/**
 * GET /admin/stats
 *
 * Returns aggregated dashboard statistics:
 *   - totalOrders, completedOrders, pendingOrders, failedOrders
 *   - totalRevenueUsd  (sum of usdAmount from COMPLETED orders)
 *   - totalProfitUsd   (sum of profitUsd from COMPLETED orders)
 *   - totalUsers, activeUsers
 *   - totalProducts, activeProducts
 */
const getDashboardStats = catchAsync(async (_req, res) => {
    // ── 1. Order aggregation ───────────────────────────────────────────────────
    const [orderStats] = await Order.aggregate([
        {
            $facet: {
                totals: [
                    {
                        $group: {
                            _id: null,
                            totalOrders: { $sum: 1 },
                            completedOrders: {
                                $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.COMPLETED] }, 1, 0] },
                            },
                            pendingOrders: {
                                $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PENDING] }, 1, 0] },
                            },
                            processingOrders: {
                                $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PROCESSING] }, 1, 0] },
                            },
                            failedOrders: {
                                $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.FAILED] }, 1, 0] },
                            },
                        },
                    },
                ],
                financials: [
                    { $match: { status: ORDER_STATUS.COMPLETED } },
                    {
                        $group: {
                            _id: null,
                            totalRevenueUsd: { $sum: { $ifNull: ['$usdAmount', 0] } },
                            totalProfitUsd: { $sum: { $ifNull: ['$profitUsd', 0] } },
                        },
                    },
                ],
            },
        },
    ]);

    const totals = orderStats?.totals?.[0] || {};
    const financials = orderStats?.financials?.[0] || {};

    // ── 2. User counts ─────────────────────────────────────────────────────────
    const [totalUsers, activeUsers] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ status: 'approved' }),
    ]);

    // ── 3. Product counts ──────────────────────────────────────────────────────
    const [totalProducts, activeProducts] = await Promise.all([
        Product.countDocuments({ deletedAt: null }),
        Product.countDocuments({ deletedAt: null, isActive: true }),
    ]);

    sendSuccess(res, {
        orders: {
            total: totals.totalOrders || 0,
            completed: totals.completedOrders || 0,
            pending: totals.pendingOrders || 0,
            processing: totals.processingOrders || 0,
            failed: totals.failedOrders || 0,
        },
        financials: {
            totalRevenueUsd: parseFloat((financials.totalRevenueUsd || 0).toFixed(2)),
            totalProfitUsd: parseFloat((financials.totalProfitUsd || 0).toFixed(2)),
        },
        users: {
            total: totalUsers,
            active: activeUsers,
        },
        products: {
            total: totalProducts,
            active: activeProducts,
        },
    }, 'Dashboard statistics retrieved.');
});

module.exports = { getDashboardStats };
