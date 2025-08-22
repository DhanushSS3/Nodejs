const express = require('express');
const router = express.Router();
const adminUserManagementController = require('../controllers/admin.user.management.controller');
const { authenticateAdmin, requirePermissions } = require('../middlewares/auth.middleware');
const { applyScope } = require('../middlewares/scope.middleware');
const { auditLog } = require('../middlewares/audit.middleware');

// This entire router is for authenticated admins.
router.use(authenticateAdmin);
// Apply country scoping for all routes in this file.
router.use(applyScope);

/**
 * @swagger
 * /api/admin/users/live-users:
 *   get:
 *     summary: List all live users
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: List all live users. Requires 'user:read' permission. Applies country scoping.
 *     responses:
 *       200:
 *         description: List of live users
 *       403:
 *         description: Forbidden
 */
router.get('/live-users', requirePermissions(['user:read']), adminUserManagementController.listLiveUsers);

/**
 * @swagger
 * /api/admin/users/demo-users:
 *   get:
 *     summary: List all demo users
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: List all demo users. Requires 'user:read' permission. Applies country scoping.
 *     responses:
 *       200:
 *         description: List of demo users
 *       403:
 *         description: Forbidden
 */
router.get('/demo-users', requirePermissions(['user:read']), adminUserManagementController.listDemoUsers);

/**
 * @swagger
 * /api/admin/users/live-users/{userId}:
 *   put:
 *     summary: Update a live user's information
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: Update live user information. Requires 'user:update' permission. Country-level admins can only update users from their country. Superadmins can update any user.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The ID of the user to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone_number:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               country:
 *                 type: string
 *               pincode:
 *                 type: string
 *               leverage:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 1000
 *               group:
 *                 type: string
 *               status:
 *                 type: integer
 *                 enum: [0, 1]
 *               is_active:
 *                 type: integer
 *                 enum: [0, 1]
 *               wallet_balance:
 *                 type: number
 *               margin:
 *                 type: number
 *               net_profit:
 *                 type: number
 *               security_question:
 *                 type: string
 *               security_answer:
 *                 type: string
 *               bank_ifsc_code:
 *                 type: string
 *               bank_holder_name:
 *                 type: string
 *               bank_account_number:
 *                 type: string
 *               fund_manager:
 *                 type: string
 *               is_self_trading:
 *                 type: integer
 *                 enum: [0, 1]
 *               id_proof:
 *                 type: string
 *               address_proof:
 *                 type: string
 *     responses:
 *       200:
 *         description: User updated successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User not found or access denied
 */
router.put('/live-users/:userId', requirePermissions(['user:update']), auditLog('UPDATE_LIVE_USER'), adminUserManagementController.updateLiveUser);

/**
 * @swagger
 * /api/admin/users/demo-users/{userId}:
 *   put:
 *     summary: Update a demo user's information
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: Update demo user information. Requires 'user:update' permission. Country-level admins can only update users from their country. Superadmins can update any user.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The ID of the user to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               phone_number:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               country:
 *                 type: string
 *               pincode:
 *                 type: string
 *               leverage:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 1000
 *               group:
 *                 type: string
 *               status:
 *                 type: integer
 *                 enum: [0, 1]
 *               is_active:
 *                 type: integer
 *                 enum: [0, 1]
 *               wallet_balance:
 *                 type: number
 *               margin:
 *                 type: number
 *               net_profit:
 *                 type: number
 *               security_question:
 *                 type: string
 *               security_answer:
 *                 type: string
 *     responses:
 *       200:
 *         description: User updated successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User not found or access denied
 */
router.put('/demo-users/:userId', requirePermissions(['user:update']), auditLog('UPDATE_DEMO_USER'), adminUserManagementController.updateDemoUser);

module.exports = router;
