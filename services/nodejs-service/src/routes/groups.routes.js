const express = require('express');
const router = express.Router();
const groupsController = require('../controllers/groups.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

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
 * Public routes for group data access (used by trading engine)
 * All routes require authentication
 */

/**
 * @swagger
 * /api/groups/{groupName}/{symbol}:
 *   get:
 *     summary: Get complete group configuration
 *     description: Retrieve complete group configuration for trading calculations
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
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
  authenticateJWT, 
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
 *       - bearerAuth: []
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
  authenticateJWT, 
  groupsController.getGroupFields
);

/**
 * @swagger
 * /api/groups/{groupName}:
 *   get:
 *     summary: Get all symbols for a group
 *     description: Retrieve all trading symbols available for a specific group
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
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
 *       401:
 *         description: Unauthorized
 */
router.get('/:groupName', 
  authenticateJWT, 
  groupsController.getGroupsByName
);

module.exports = router;
