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

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders:
 *   get:
 *     summary: Get all open orders for a specific user
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: Retrieve all open orders for a specific user (live or demo). Requires 'orders:read' permission. Country-level admins can only view orders for users from their country. Superadmins can view orders for any user. Returns all orders without pagination.
 *     parameters:
 *       - in: path
 *         name: userType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: The type of user (live or demo)
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: The ID of the user whose orders to retrieve
 *     responses:
 *       200:
 *         description: User orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Open orders retrieved successfully for live user"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         email:
 *                           type: string
 *                         account_number:
 *                           type: string
 *                         group:
 *                           type: string
 *                         status:
 *                           type: integer
 *                         is_active:
 *                           type: integer
 *                         user_type:
 *                           type: string
 *                           enum: [live, demo]
 *                     orders:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           order_id:
 *                             type: string
 *                           symbol:
 *                             type: string
 *                           order_type:
 *                             type: string
 *                           order_status:
 *                             type: string
 *                             enum: [OPEN, PENDING, QUEUED, PENDING-QUEUED]
 *                           order_price:
 *                             type: number
 *                           order_quantity:
 *                             type: number
 *                           contract_value:
 *                             type: number
 *                           margin:
 *                             type: number
 *                           commission:
 *                             type: number
 *                           swap:
 *                             type: number
 *                           stop_loss:
 *                             type: number
 *                             nullable: true
 *                           take_profit:
 *                             type: number
 *                             nullable: true
 *                           net_profit:
 *                             type: number
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                           updated_at:
 *                             type: string
 *                             format: date-time
 *                           close_message:
 *                             type: string
 *                             nullable: true
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_orders:
 *                           type: integer
 *                         open_orders:
 *                           type: integer
 *                         pending_orders:
 *                           type: integer
 *                         queued_orders:
 *                           type: integer
 *                         total_margin_used:
 *                           type: number
 *                         total_contract_value:
 *                           type: number
 *                         symbols_traded:
 *                           type: array
 *                           items:
 *                             type: string
 *                         order_types:
 *                           type: array
 *                           items:
 *                             type: string
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         operation_id:
 *                           type: string
 *                         fetched_at:
 *                           type: string
 *                           format: date-time
 *                         fetched_by_admin:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                             role:
 *                               type: string
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Invalid user type. Must be 'live' or 'demo'"
 *       403:
 *         description: Insufficient permissions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Insufficient permissions"
 *       404:
 *         description: User not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Live user not found with the specified ID or access denied"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Failed to retrieve user orders"
 *                 error:
 *                   type: string
 */
router.get('/:userType/:userId/orders', requirePermissions(['orders:read']), auditLog('GET_USER_ORDERS'), adminUserManagementController.getUserOpenOrders);

module.exports = router;
