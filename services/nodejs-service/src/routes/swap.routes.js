const express = require('express');
const router = express.Router();
const swapController = require('../controllers/swap.controller');
const { authenticateAdmin, requirePermission } = require('../middlewares/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     SwapCalculationTest:
 *       type: object
 *       required:
 *         - symbol
 *         - group_name
 *         - order_type
 *         - order_quantity
 *       properties:
 *         symbol:
 *           type: string
 *           example: "EURUSD"
 *         group_name:
 *           type: string
 *           example: "VIP"
 *         order_type:
 *           type: string
 *           enum: [BUY, SELL]
 *           example: "BUY"
 *         order_quantity:
 *           type: number
 *           example: 1.5
 *     SwapSchedulerStatus:
 *       type: object
 *       properties:
 *         isScheduled:
 *           type: boolean
 *           example: true
 *         isRunning:
 *           type: boolean
 *           example: false
 *         nextRun:
 *           type: string
 *           format: date-time
 *           example: "2024-01-02T00:01:00.000Z"
 */

/**
 * Swap Management Routes
 * Admin-only routes for managing swap calculations and scheduling
 * All routes require admin authentication and SWAP_MANAGE permission
 */

/**
 * @swagger
 * /api/admin/swap/scheduler/status:
 *   get:
 *     summary: Get swap scheduler status
 *     description: Get current status of the swap calculation scheduler
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Scheduler status retrieved successfully
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
 *                   example: "Swap scheduler status retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/SwapSchedulerStatus'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.get('/scheduler/status', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.getSchedulerStatus
);

/**
 * @swagger
 * /api/admin/swap/scheduler/start:
 *   post:
 *     summary: Start swap scheduler
 *     description: Start the daily swap calculation scheduler
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Scheduler started successfully
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
 *                   example: "Swap scheduler started successfully"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post('/scheduler/start', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.startScheduler
);

/**
 * @swagger
 * /api/admin/swap/scheduler/stop:
 *   post:
 *     summary: Stop swap scheduler
 *     description: Stop the daily swap calculation scheduler
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Scheduler stopped successfully
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
 *                   example: "Swap scheduler stopped successfully"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post('/scheduler/stop', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.stopScheduler
);

/**
 * @swagger
 * /api/admin/swap/trigger:
 *   post:
 *     summary: Manually trigger swap processing
 *     description: Manually trigger swap calculation for a specific date
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               date:
 *                 type: string
 *                 format: date
 *                 example: "2024-01-01"
 *                 description: "Target date for swap processing (optional, defaults to today)"
 *     responses:
 *       200:
 *         description: Manual processing triggered successfully
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
 *                   example: "Manual swap processing triggered for Mon Jan 01 2024"
 *                 data:
 *                   type: object
 *                   properties:
 *                     target_date:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid date format
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post('/trigger', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.triggerManual
);

/**
 * @swagger
 * /api/admin/swap/calculate/{orderType}/{orderId}:
 *   post:
 *     summary: Calculate swap for specific order
 *     description: Calculate and apply swap charges for a specific order (testing endpoint)
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: path
 *         name: orderType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: Order type (live or demo)
 *         example: "live"
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *         example: "ORD123456"
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date
 *         description: Target date for calculation (optional, defaults to today)
 *         example: "2024-01-01"
 *     responses:
 *       200:
 *         description: Swap calculation completed
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
 *                   example: "Swap calculation completed"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order_id:
 *                       type: string
 *                       example: "ORD123456"
 *                     current_swap:
 *                       type: number
 *                       example: 15.50
 *                     calculated_swap:
 *                       type: number
 *                       example: 2.75
 *                     new_swap:
 *                       type: number
 *                       example: 18.25
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Order not found
 */
router.post('/calculate/:orderType/:orderId', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.calculateOrderSwap
);

/**
 * @swagger
 * /api/admin/swap/test:
 *   post:
 *     summary: Test swap calculation
 *     description: Test swap calculation without updating database
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date
 *         description: Target date for calculation (optional, defaults to today)
 *         example: "2024-01-01"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SwapCalculationTest'
 *     responses:
 *       200:
 *         description: Swap calculation test completed
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
 *                   example: "Swap calculation test completed"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order:
 *                       type: object
 *                       properties:
 *                         order_id:
 *                           type: string
 *                           example: "TEST_1704067200000"
 *                         symbol:
 *                           type: string
 *                           example: "EURUSD"
 *                         group_name:
 *                           type: string
 *                           example: "VIP"
 *                         order_type:
 *                           type: string
 *                           example: "BUY"
 *                         order_quantity:
 *                           type: number
 *                           example: 1.5
 *                     target_date:
 *                       type: string
 *                       format: date-time
 *                     calculated_swap:
 *                       type: number
 *                       example: 2.75
 *       400:
 *         description: Missing required fields or invalid date
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post('/test', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.testSwapCalculation
);

/**
 * @swagger
 * /api/admin/swap/history:
 *   get:
 *     summary: Get swap processing history
 *     description: Get history of swap processing runs
 *     tags: [Admin - Swap Management]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Processing history retrieved successfully
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
 *                   example: "Swap processing history retrieved"
 *                 data:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.get('/history', 
  authenticateAdmin,
  requirePermission('SWAP_MANAGE'),
  swapController.getProcessingHistory
);

module.exports = router;
