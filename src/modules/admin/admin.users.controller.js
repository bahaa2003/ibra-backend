'use strict';

/**
 * admin.users.controller.js
 *
 * Thin HTTP adapter — all logic lives in admin.users.service.js.
 */

const svc = require('./admin.users.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');

// GET /admin/users
const listUsers = catchAsync(async (req, res) => {
    const { status, verified, email, role, from, to, page, limit, sortBy, sortOrder } = req.query;
    const result = await svc.listUsers({
        status,
        verified: verified !== undefined ? verified === 'true' : undefined,
        email,
        role,
        from,
        to,
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 20, 10),
        sortBy,
        sortOrder,
    });
    sendPaginated(res, result.users, result.pagination, 'Users retrieved');
});

// GET /admin/users/:id
const getUserById = catchAsync(async (req, res) => {
    const user = await svc.getUserById(req.params.id);
    sendSuccess(res, { user }, 'User retrieved');
});

// PATCH /admin/users/:id
const updateUser = catchAsync(async (req, res) => {
    const user = await svc.updateUser(req.params.id, req.body, req.user._id);
    sendSuccess(res, { user }, 'User updated');
});

// DELETE /admin/users/:id
const deleteUser = catchAsync(async (req, res) => {
    const user = await svc.deleteUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User soft-deleted');
});

// PATCH /admin/users/:id/approve
const approveUser = catchAsync(async (req, res) => {
    const user = await svc.approveUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User approved');
});

// PATCH /admin/users/:id/reject
const rejectUser = catchAsync(async (req, res) => {
    const user = await svc.rejectUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User rejected');
});

// PATCH /admin/users/:id/role
const updateUserRole = catchAsync(async (req, res) => {
    const user = await svc.updateUserRole(req.params.id, req.body.role, req.user._id);
    sendSuccess(res, { user }, 'User role updated');
});

// PATCH /admin/users/:id/currency
const updateUserCurrency = catchAsync(async (req, res) => {
    const user = await svc.updateUserCurrency(req.params.id, req.body.currency, req.user._id);
    sendSuccess(res, { user }, 'User currency updated');
});

// POST /admin/users/:id/reset-password
const resetUserPassword = catchAsync(async (req, res) => {
    const user = await svc.resetUserPassword(req.params.id, req.body.password, req.user._id);
    sendSuccess(res, { user }, 'User password reset');
});

// PATCH /admin/users/:id/avatar
const updateUserAvatar = catchAsync(async (req, res) => {
    const relativePath = req.file ? `/uploads/avatars/${req.file.filename}` : null;
    const user = await svc.updateUserAvatar(req.params.id, relativePath, req.user._id);
    sendSuccess(res, { user }, 'User avatar updated');
});

module.exports = {
    listUsers,
    getUserById,
    updateUser,
    deleteUser,
    approveUser,
    rejectUser,
    updateUserRole,
    updateUserCurrency,
    resetUserPassword,
    updateUserAvatar,
};
