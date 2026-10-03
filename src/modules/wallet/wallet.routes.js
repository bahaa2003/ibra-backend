'use strict';

const { Router } = require('express');
const walletController = require('./wallet.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const requireCompleteProfile = require('../../shared/middlewares/requireCompleteProfile');

const router = Router();

/**
 * @route  GET /api/wallet/stats
 * @desc   Get authenticated user's wallet statistics (aggregated)
 * @access Active users (Customer or Admin)
 */
router.get('/stats', authenticate, requireActiveUser, requireCompleteProfile, walletController.getMyWalletStats);

/**
 * @route  GET /api/wallet/transactions
 * @desc   Get authenticated user's own transaction history
 * @access Active users (Customer or Admin)
 */
router.get('/transactions', authenticate, requireActiveUser, requireCompleteProfile, walletController.getMyTransactions);

/**
 * @route  GET /api/wallet/users/:userId/transactions
 * @desc   Admin: Get any user's transaction history
 * @access Admin
 */
router.get(
    '/users/:userId/transactions',
    authenticate,
    requireActiveUser,
    requireCompleteProfile,
    authorize('ADMIN'),
    walletController.getUserTransactions
);

module.exports = router;
