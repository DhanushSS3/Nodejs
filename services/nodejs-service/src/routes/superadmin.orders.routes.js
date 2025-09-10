const express = require('express');
const router = express.Router();

const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/superadmin.orders.controller');

// All endpoints in this router require superadmin
router.use(authenticateAdmin);
router.use(requireRole(['superadmin']));

/**
 * @swagger
 * tags:
 *   name: Superadmin Orders
 *   description: Admin-only endpoints to repair/rebuild Redis order indices
 */

/**
 * @swagger
 * /api/superadmin/orders/rebuild/user:
 *   post:
 *     summary: Rebuild a user's order indices (and optionally backfill holdings from SQL)
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               include_queued:
 *                 type: boolean
 *                 description: If true, includes QUEUED orders when backfilling from SQL
 *               backfill:
 *                 type: boolean
 *                 description: If true, backfill user_holdings from SQL before rebuilding indices
 *     responses:
 *       200:
 *         description: Rebuild completed
 */
router.post('/rebuild/user', ctrl.rebuildUser);

/**
 * @swagger
 * /api/superadmin/orders/rebuild/symbol:
 *   post:
 *     summary: Rebuild symbol_holders for a symbol by inspecting user indices
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [symbol]
 *             properties:
 *               symbol:
 *                 type: string
 *               scope:
 *                 type: string
 *                 enum: [live, demo, both]
 *                 default: both
 *     responses:
 *       200:
 *         description: Rebuild completed
 */
router.post('/rebuild/symbol', ctrl.rebuildSymbol);

/**
 * @swagger
 * /api/superadmin/orders/ensure/holding:
 *   post:
 *     summary: Ensure a single holding exists in Redis for an OPEN order from SQL
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id, order_id]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               order_id:
 *                 type: string
 */
router.post('/ensure/holding', ctrl.ensureHolding);

/**
 * @swagger
 * /api/superadmin/orders/ensure/symbol-holder:
 *   post:
 *     summary: Ensure a user appears in symbol_holders for a symbol
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id, symbol]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               symbol:
 *                 type: string
 */
router.post('/ensure/symbol-holder', ctrl.ensureSymbolHolder);

/**
 * @swagger
 * /api/superadmin/orders/portfolio:
 *   get:
 *     summary: Fetch a user's portfolio snapshot from Redis
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: User account type
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to fetch the portfolio for
 *     responses:
 *       200:
 *         description: Portfolio snapshot fetched successfully
 *       404:
 *         description: Portfolio not found in Redis for the given user
 */
router.get('/portfolio', ctrl.getUserPortfolio);

/**
 * @swagger
 * /api/superadmin/orders/reject-queued:
 *   post:
 *     summary: Manually reject a queued order and release reserved margin
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order_id, user_type, user_id]
 *             properties:
 *               order_id:
 *                 type: string
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Order rejected and margin released
 */
router.post('/reject-queued', ctrl.rejectQueued);

/**
 * @swagger
 * /api/superadmin/orders/queued:
 *   get:
 *     summary: List all queued orders for a user
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Queued orders retrieved
 */
router.get('/queued', ctrl.getQueuedOrders);

/**
 * @swagger
 * /api/superadmin/orders/margin-status:
 *   get:
 *     summary: Get executed vs total margin status for a user
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Margin status retrieved
 */
router.get('/margin-status', ctrl.getMarginStatus);

module.exports = router;
