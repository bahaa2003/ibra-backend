'use strict';

const { Router } = require('express');
const userController = require('./user.controller');
const { updateUserValidation } = require('./user.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const { createUpload } = require('../../shared/middlewares/upload');

const avatarUpload = createUpload('avatars');

const router = Router();

// All user routes require authentication
router.use(authenticate);

// ── Customer: Self-service ────────────────────────────────────────────────────

/**
 * @route  GET /api/users/me
 * @desc   Get authenticated user's own profile
 * @access Any authenticated user
 */
router.get('/me', userController.getMyProfile);

/**
 * @route  PATCH /api/users/me
 * @desc   Update own profile (name, email, phone, username, password)
 * @access Any authenticated user
 */
router.patch('/me', userController.updateMyProfile);

/**
 * @route  PATCH /api/users/me/avatar
 * @desc   Update own avatar
 * @access Any authenticated user
 */
router.patch('/me/avatar', avatarUpload.single('avatar'), userController.updateMyAvatar);

// ── Admin: Queries ────────────────────────────────────────────────────────────

/**
 * @route  GET /api/users
 * @desc   List all users. Supports ?status=PENDING|ACTIVE|REJECTED
 * @access Admin
 */
router.get('/', authorize('ADMIN'), userController.listUsers);

/**
 * @route  GET /api/users/:id
 * @desc   Get user by ID
 * @access Admin
 */
router.get('/:id', authorize('ADMIN'), userController.getUser);

// ── Admin: General Update ─────────────────────────────────────────────────────

/**
 * @route  PATCH /api/users/:id
 * @desc   Update user (group, credit limit, name)
 * @access Admin
 * @note   Activation lifecycle is handled via /approve and /reject endpoints
 */
router.patch('/:id', authorize('ADMIN'), updateUserValidation, validate, userController.updateUser);

// ── Admin: Activation Lifecycle ───────────────────────────────────────────────

/**
 * @route  PATCH /api/users/:id/approve
 * @desc   Approve account (PENDING or REJECTED → ACTIVE)
 * @access Admin
 */
router.patch('/:id/approve', authorize('ADMIN'), userController.approveUser);

/**
 * @route  PATCH /api/users/:id/reject
 * @desc   Reject account (PENDING or ACTIVE → REJECTED)
 * @access Admin
 */
router.patch('/:id/reject', authorize('ADMIN'), userController.rejectUser);

module.exports = router;
