'use strict';

const depositService = require('./deposit.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

/**
 * POST /api/deposits
 * Customer creates a deposit request.
 */
const createDeposit = catchAsync(async (req, res) => {
    const { amountRequested, transferImageUrl, transferredFromNumber } = req.body;

    const deposit = await depositService.createDepositRequest({
        userId: req.user._id,
        amountRequested: parseFloat(amountRequested),
        transferImageUrl,
        transferredFromNumber,
        auditContext: req.auditContext,
    });

    sendCreated(res, deposit, 'Deposit request submitted successfully. Pending admin review.');
});

/**
 * GET /api/deposits
 * Admin: list all deposit requests (optional ?status= filter + pagination).
 * Customer: list only their own deposit requests.
 */
const listDeposits = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { status } = req.query;

    let result;
    if (req.user.role === 'ADMIN') {
        result = await depositService.listDeposits({ page, limit, status });
    } else {
        result = await depositService.listMyDeposits(req.user._id, { page, limit, status });
    }

    sendPaginated(res, result.deposits, result.pagination, 'Deposit requests retrieved.');
});

/**
 * PATCH /api/deposits/:id/approve
 * Admin: approve a deposit and credit the customer's wallet.
 */
const approveDeposit = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { overrideAmount } = req.body;

    const deposit = await depositService.approveDeposit(
        id,
        req.user._id,
        overrideAmount !== undefined ? parseFloat(overrideAmount) : null,
        req.auditContext
    );

    sendSuccess(res, deposit, 'Deposit approved and wallet credited successfully.');
});

/**
 * PATCH /api/deposits/:id/reject
 * Admin: reject a deposit request.
 */
const rejectDeposit = catchAsync(async (req, res) => {
    const deposit = await depositService.rejectDeposit(
        req.params.id,
        req.user._id,
        req.auditContext
    );

    sendSuccess(res, deposit, 'Deposit request rejected.');
});

module.exports = { createDeposit, listDeposits, approveDeposit, rejectDeposit };
