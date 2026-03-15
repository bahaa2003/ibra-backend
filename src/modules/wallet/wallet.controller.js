'use strict';

const walletService = require('./wallet.service');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

/**
 * Get the authenticated user's transaction history.
 */
const getMyTransactions = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { transactions, pagination } = await walletService.getTransactionHistory(req.user._id, {
        page,
        limit,
    });

    sendPaginated(res, transactions, pagination, 'Transaction history retrieved.');
});

/**
 * Admin: Get any user's transaction history.
 */
const getUserTransactions = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const { transactions, pagination } = await walletService.getTransactionHistory(req.params.userId, {
        page,
        limit,
    });

    sendPaginated(res, transactions, pagination, 'Transaction history retrieved.');
});

module.exports = { getMyTransactions, getUserTransactions };
