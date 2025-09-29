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

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/closed-orders:
 *   get:
 *     summary: Get closed orders for a specific user with pagination
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: Retrieve closed orders for a specific user (live or demo) with pagination. Requires 'orders:read' permission. Country-level admins can only view orders for users from their country. Superadmins can view orders for any user.
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
 *         description: The ID of the user whose closed orders to retrieve
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of orders per page (max 100)
 *     responses:
 *       200:
 *         description: User closed orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   order_id:
 *                     type: string
 *                   symbol:
 *                     type: string
 *                   order_type:
 *                     type: string
 *                   order_status:
 *                     type: string
 *                     enum: [CLOSED]
 *                   order_price:
 *                     type: number
 *                   order_quantity:
 *                     type: number
 *                   contract_value:
 *                     type: number
 *                   margin:
 *                     type: number
 *                   commission:
 *                     type: number
 *                   swap:
 *                     type: number
 *                   stop_loss:
 *                     type: number
 *                     nullable: true
 *                   take_profit:
 *                     type: number
 *                     nullable: true
 *                   net_profit:
 *                     type: number
 *                   close_price:
 *                     type: number
 *                     nullable: true
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *                   updated_at:
 *                     type: string
 *                     format: date-time
 *                   close_message:
 *                     type: string
 *                     nullable: true
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid user type. Must be 'live' or 'demo'"
 *       403:
 *         description: Insufficient permissions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Insufficient permissions"
 *       404:
 *         description: User not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Live user not found or access denied"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Failed to retrieve user closed orders"
 */
router.get('/:userType/:userId/closed-orders', requirePermissions(['orders:read']), auditLog('GET_USER_CLOSED_ORDERS'), adminUserManagementController.getUserClosedOrders);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/pending-orders:
 *   get:
 *     summary: Get pending orders for a specific user with pagination
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: Retrieve pending orders for a specific user (live or demo) with pagination. Requires 'orders:read' permission. Country-level admins can only view orders for users from their country. Superadmins can view orders for any user.
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
 *         description: The ID of the user whose pending orders to retrieve
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of orders per page (max 100)
 *     responses:
 *       200:
 *         description: User pending orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   order_id:
 *                     type: string
 *                   symbol:
 *                     type: string
 *                   order_type:
 *                     type: string
 *                   order_status:
 *                     type: string
 *                     enum: [PENDING]
 *                   order_price:
 *                     type: number
 *                   order_quantity:
 *                     type: number
 *                   contract_value:
 *                     type: number
 *                   margin:
 *                     type: number
 *                   commission:
 *                     type: number
 *                   swap:
 *                     type: number
 *                   stop_loss:
 *                     type: number
 *                     nullable: true
 *                   take_profit:
 *                     type: number
 *                     nullable: true
 *                   net_profit:
 *                     type: number
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *                   updated_at:
 *                     type: string
 *                     format: date-time
 *                   close_message:
 *                     type: string
 *                     nullable: true
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Invalid user type. Must be 'live' or 'demo'"
 *       403:
 *         description: Insufficient permissions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Insufficient permissions"
 *       404:
 *         description: User not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Live user not found or access denied"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Failed to retrieve user pending orders"
 */
router.get('/:userType/:userId/pending-orders', requirePermissions(['orders:read']), auditLog('GET_USER_PENDING_ORDERS'), adminUserManagementController.getUserPendingOrders);

// Admin Order Management Routes

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/instant:
 *   post:
 *     summary: Admin places instant order on behalf of user
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Place an instant order on behalf of a user. Requires 'orders:place' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user to place order for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - symbol
 *               - order_type
 *               - quantity
 *             properties:
 *               symbol:
 *                 type: string
 *                 example: "EURUSD"
 *               order_type:
 *                 type: string
 *                 enum: [BUY, SELL]
 *                 example: "BUY"
 *               quantity:
 *                 type: number
 *                 example: 100000
 *               leverage:
 *                 type: integer
 *                 example: 100
 *               stop_loss:
 *                 type: number
 *                 nullable: true
 *                 example: 1.0800
 *               take_profit:
 *                 type: number
 *                 nullable: true
 *                 example: 1.0900
 *     responses:
 *       200:
 *         description: Order placed successfully
 *       400:
 *         description: Invalid parameters or validation error
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/:userType/:userId/orders/instant', requirePermissions(['orders:place']), auditLog('ADMIN_PLACE_INSTANT_ORDER'), adminUserManagementController.adminPlaceInstantOrder);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/{orderId}/close:
 *   post:
 *     summary: Admin closes order on behalf of user
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Close an existing order on behalf of a user. Requires 'orders:close' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the order to close
 *     responses:
 *       200:
 *         description: Order closed successfully
 *       400:
 *         description: Invalid parameters or order cannot be closed
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/:userType/:userId/orders/:orderId/close', requirePermissions(['orders:close']), auditLog('ADMIN_CLOSE_ORDER'), adminUserManagementController.adminCloseOrder);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/pending:
 *   post:
 *     summary: Admin places pending order on behalf of user
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Place a pending order on behalf of a user. Requires 'orders:place' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user to place order for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - symbol
 *               - order_type
 *               - quantity
 *               - price
 *             properties:
 *               symbol:
 *                 type: string
 *                 example: "EURUSD"
 *               order_type:
 *                 type: string
 *                 enum: [BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP]
 *                 example: "BUY_LIMIT"
 *               quantity:
 *                 type: number
 *                 example: 100000
 *               price:
 *                 type: number
 *                 example: 1.0800
 *               leverage:
 *                 type: integer
 *                 example: 100
 *               stop_loss:
 *                 type: number
 *                 nullable: true
 *                 example: 1.0750
 *               take_profit:
 *                 type: number
 *                 nullable: true
 *                 example: 1.0850
 *     responses:
 *       200:
 *         description: Pending order placed successfully
 *       400:
 *         description: Invalid parameters or validation error
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/:userType/:userId/orders/pending', requirePermissions(['orders:place']), auditLog('ADMIN_PLACE_PENDING_ORDER'), adminUserManagementController.adminPlacePendingOrder);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/pending/{orderId}:
 *   put:
 *     summary: Admin modifies pending order on behalf of user
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Modify an existing pending order on behalf of a user. Requires 'orders:modify' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the pending order to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - price
 *             properties:
 *               price:
 *                 type: number
 *                 example: 1.0820
 *                 description: New price for the pending order
 *     responses:
 *       200:
 *         description: Pending order modified successfully
 *       400:
 *         description: Invalid parameters or order cannot be modified
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.put('/:userType/:userId/orders/pending/:orderId', requirePermissions(['orders:modify']), auditLog('ADMIN_MODIFY_PENDING_ORDER'), adminUserManagementController.adminModifyPendingOrder);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/pending/{orderId}:
 *   delete:
 *     summary: Admin cancels pending order on behalf of user
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Cancel an existing pending order on behalf of a user. Requires 'orders:modify' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the pending order to cancel
 *     responses:
 *       200:
 *         description: Pending order cancelled successfully
 *       400:
 *         description: Invalid parameters or order cannot be cancelled
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.delete('/:userType/:userId/orders/pending/:orderId', requirePermissions(['orders:modify']), auditLog('ADMIN_CANCEL_PENDING_ORDER'), adminUserManagementController.adminCancelPendingOrder);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/{orderId}/stoploss:
 *   post:
 *     summary: Admin sets stop loss for an existing order
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Set stop loss for an existing order on behalf of a user. Requires 'orders:stoploss' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the order to set stop loss for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - stop_loss_price
 *             properties:
 *               stop_loss_price:
 *                 type: number
 *                 example: 1.0800
 *                 description: Stop loss price level
 *     responses:
 *       200:
 *         description: Stop loss set successfully
 *       400:
 *         description: Invalid parameters or order cannot have stop loss
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/:userType/:userId/orders/:orderId/stoploss', requirePermissions(['orders:stoploss']), auditLog('ADMIN_SET_STOPLOSS'), adminUserManagementController.adminSetStopLoss);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/{orderId}/stoploss:
 *   delete:
 *     summary: Admin removes stop loss from an existing order
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Remove stop loss from an existing order on behalf of a user. Requires 'orders:stoploss' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the order to remove stop loss from
 *     responses:
 *       200:
 *         description: Stop loss removed successfully
 *       400:
 *         description: Invalid parameters or order does not have active stop loss
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.delete('/:userType/:userId/orders/:orderId/stoploss', requirePermissions(['orders:stoploss']), auditLog('ADMIN_REMOVE_STOPLOSS'), adminUserManagementController.adminRemoveStopLoss);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/{orderId}/takeprofit:
 *   post:
 *     summary: Admin sets take profit for an existing order
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Set take profit for an existing order on behalf of a user. Requires 'orders:takeprofit' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the order to set take profit for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - take_profit_price
 *             properties:
 *               take_profit_price:
 *                 type: number
 *                 example: 1.0900
 *                 description: Take profit price level
 *     responses:
 *       200:
 *         description: Take profit set successfully
 *       400:
 *         description: Invalid parameters or order cannot have take profit
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/:userType/:userId/orders/:orderId/takeprofit', requirePermissions(['orders:takeprofit']), auditLog('ADMIN_SET_TAKEPROFIT'), adminUserManagementController.adminSetTakeProfit);

/**
 * @swagger
 * /api/admin/users/{userType}/{userId}/orders/{orderId}/takeprofit:
 *   delete:
 *     summary: Admin removes take profit from an existing order
 *     tags: [Admin Order Management]
 *     security:
 *       - bearerAuth: []
 *     description: Remove take profit from an existing order on behalf of a user. Requires 'orders:takeprofit' permission. Follows user's execution flow (provider/local).
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
 *         description: The ID of the user who owns the order
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the order to remove take profit from
 *     responses:
 *       200:
 *         description: Take profit removed successfully
 *       400:
 *         description: Invalid parameters or order does not have active take profit
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User or order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.delete('/:userType/:userId/orders/:orderId/takeprofit', requirePermissions(['orders:takeprofit']), auditLog('ADMIN_REMOVE_TAKEPROFIT'), adminUserManagementController.adminRemoveTakeProfit);

module.exports = router;
