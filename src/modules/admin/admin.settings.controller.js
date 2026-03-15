'use strict';

/**
 * admin.settings.controller.js
 */

const svc = require('./admin.settings.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');

// GET /admin/settings
const listSettings = catchAsync(async (req, res) => {
    const settings = await svc.listSettings();
    sendSuccess(res, { settings }, 'Settings retrieved');
});

// GET /admin/settings/:key
const getSettingByKey = catchAsync(async (req, res) => {
    const setting = await svc.getSettingByKey(req.params.key);
    sendSuccess(res, { setting }, 'Setting retrieved');
});

// PATCH /admin/settings/:key
const updateSetting = catchAsync(async (req, res) => {
    const { value } = req.body;
    const setting = await svc.updateSetting(req.params.key, value, req.user._id);
    sendSuccess(res, { setting }, 'Setting updated');
});

module.exports = { listSettings, getSettingByKey, updateSetting };
