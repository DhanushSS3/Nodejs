const express = require('express');
const router = express.Router();
const groupsController = require('../controllers/groups.controller');
const { authenticateAdmin, authenticateJWT, requirePermission } = require('../middlewares/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     Group:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         symbol:
 *           type: string
 *           example: "EURUSD"
 *         name:
 *           type: string
 *           example: "VIP"
 *         commision_type:
 *           type: integer
 *           example: 1
 *         commision_value_type:
 *           type: integer
 *           example: 1
 *         type:
 *           type: integer
 *           example: 1
 *         pip_currency:
 *           type: string
 *           example: "USD"
 *         show_points:
 *           type: integer
 *           example: 5
 *         swap_buy:
 *           type: number
 *           format: decimal
 *           example: -2.5
 *         swap_sell:
 *           type: number
 *           format: decimal
 *           example: -1.8
 *         commision:
 *           type: number
 *           format: decimal
 *           example: 3.0
 *         margin:
 *           type: number
 *           format: decimal
 *           example: 100.0
 *         spread:
 *           type: number
 *           format: decimal
 *           example: 1.5
 *         deviation:
 *           type: number
 *           format: decimal
 *           example: 10.0
 *         min_lot:
 *           type: number
 *           format: decimal
 *           example: 0.01
 *         max_lot:
 *           type: number
 *           format: decimal
 *           example: 100.0
 *         pips:
 *           type: number
 *           format: decimal
 *           example: 0.0001
 *         spread_pip:
 *           type: number
 *           format: decimal
 *           example: 1.5
 *         contract_size:
 *           type: number
 *           format: decimal
 *           example: 100000.0
 *         profit:
 *           type: string
 *           example: "currency"
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */

/**
 * Groups Routes
 * Admin-only routes for group data access with permission-based authorization
 * All routes require admin authentication and GROUPS_READ permission
 */

/**
 * @swagger
 * /api/groups/{groupName}/{symbol}:
 *   get:
 *     summary: Get complete group configuration
 *     description: Retrieve complete group configuration for trading calculations
 *     tags: [Groups]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: path
 *         name: groupName
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name (e.g., VIP, Standard)
 *         example: "VIP"
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: Trading symbol (e.g., EURUSD, GBPUSD)
 *         example: "EURUSD"
 *     responses:
 *       200:
 *         description: Group configuration retrieved successfully
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
 *                   example: "Group retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/Group'
 *       404:
 *         description: Group not found
 *       401:
 *         description: Unauthorized
 */
router.get('/:groupName/:symbol', 
  authenticateAdmin,
  requirePermission('GROUPS_READ'),
  groupsController.getGroup
);

/**
 * @swagger
 * /api/groups/{groupName}/{symbol}/fields:
 *   get:
 *     summary: Get specific group fields
 *     description: Retrieve only specific fields from group configuration for optimized trading calculations
 *     tags: [Groups]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: path
 *         name: groupName
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name
 *         example: "VIP"
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: Trading symbol
 *         example: "EURUSD"
 *       - in: query
 *         name: fields
 *         required: true
 *         schema:
 *           type: string
 *         description: Comma-separated list of fields to retrieve
 *         example: "spread,margin,swap_buy"
 *     responses:
 *       200:
 *         description: Group fields retrieved successfully
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
 *                   example: "Group fields retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group_name:
 *                       type: string
 *                       example: "VIP"
 *                     symbol:
 *                       type: string
 *                       example: "EURUSD"
 *                     fields:
 *                       type: object
 *                       example:
 *                         spread: "1.5"
 *                         margin: "100.0"
 *                         swap_buy: "-2.5"
 *       404:
 *         description: Group not found
 *       401:
 *         description: Unauthorized
 */
router.get('/:groupName/:symbol/fields', 
  authenticateAdmin,
  requirePermission('GROUPS_READ'),
  groupsController.getGroupFields
);

/**
 * @swagger
 * /api/groups/admin/{groupName}:
 *   get:
 *     summary: Get all symbols for a group (Admin access)
 *     description: Retrieve all trading symbols available for a specific group - Admin only
 *     tags: [Groups]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: path
 *         name: groupName
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name
 *         example: "VIP"
 *     responses:
 *       200:
 *         description: Groups retrieved successfully
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
 *                   example: "Groups retrieved successfully for VIP"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group_name:
 *                       type: string
 *                       example: "VIP"
 *                     symbols:
 *                       type: integer
 *                       example: 50
 *                     groups:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Group'
 *                     access_type:
 *                       type: string
 *                       example: "admin"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Group not found
 *
 * /api/groups/my-group:
 *   get:
 *     summary: Get user's group symbols (User access)
 *     description: Retrieve all trading symbols for the user's group from JWT token
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User's group retrieved successfully
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
 *                   example: "Groups retrieved successfully for VIP"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group_name:
 *                       type: string
 *                       example: "VIP"
 *                     symbols:
 *                       type: integer
 *                       example: 50
 *                     groups:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Group'
 *                     access_type:
 *                       type: string
 *                       example: "user"
 *       400:
 *         description: User group information not available
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Group not found
 */
// Admin route - can query any group
router.get('/admin/:groupName', 
  authenticateAdmin,
  requirePermission('GROUPS_READ'),
  groupsController.getGroupsByName
);

// User route - gets their own group from JWT
router.get('/my-group', 
  authenticateJWT,
  groupsController.getGroupsByName
);

/**
 * @swagger
 * /api/groups/half-spreads:
 *   get:
 *     summary: Get half spreads for user's group
 *     description: Calculate and return half spreads for all instruments in user's group from JWT
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Half spreads calculated successfully
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
 *                   example: "Half spreads calculated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group_name:
 *                       type: string
 *                       example: "VIP"
 *                     total_instruments:
 *                       type: integer
 *                       example: 50
 *                     half_spreads:
 *                       type: object
 *                       additionalProperties:
 *                         type: number
 *                       example:
 *                         AUDCAD: 0.000035
 *                         USDZAR: 4
 *                         USDSGD: 2
 *       400:
 *         description: User group information not available
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: No instruments found for user's group
 *       500:
 *         description: Internal server error
 */
router.get('/half-spreads', authenticateJWT, groupsController.getHalfSpreads);

module.exports = router;
