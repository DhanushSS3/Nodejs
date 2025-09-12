const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/auth.middleware');
const ordersController = require('../controllers/orders.controller');

// POST /api/orders/instant/place
/**
 * @swagger
 * /api/orders/instant/place:
 *   post:
 *     summary: Place an instant order and forward to execution service
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - symbol
 *               - order_type
 *               - order_price
 *               - order_quantity
 *               - user_id
 *               - user_type
 *             properties:
 *               symbol:
 *                 type: string
 *                 example: "EURCHF"
 *               order_type:
 *                 type: string
 *                 enum: [BUY, SELL]
 *                 example: "SELL"
 *               order_price:
 *                 type: number
 *                 example: 0.93861
 *               order_quantity:
 *                 type: number
 *                 example: 0.1
 *               user_id:
 *                 type: string
 *                 example: "5"
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *                 example: "live"
 *               idempotency_key:
 *                 type: string
 *                 description: Optional client-provided idempotency key
 *                 example: "a7f3c9e2-4b1d-4f6a-9d3e-8c2f1a7b9e6t"
 *               status:
 *                 type: string
 *                 description: External provider status passthrough
 *                 example: "OPEN"
 *               order_status:
 *                 type: string
 *                 description: Internal lifecycle, must be OPEN on placement
 *                 example: "OPEN"
 *     responses:
 *       201:
 *         description: Order placed or queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 order_id:
 *                   type: string
 *                 order_status:
 *                   type: string
 *                   description: Order lifecycle status (OPEN when executed locally, QUEUED when waiting for provider)
 *                 execution_mode:
 *                   type: string
 *                   example: "local"
 *                 margin:
 *                   type: number
 *                 exec_price:
 *                   type: number
 *                 contract_value:
 *                   type: number
 *       400:
 *         description: Invalid payload
 *       403:
 *         description: Forbidden (JWT/user checks)
 *       409:
 *         description: Conflict (duplicate order_id)
 *       500:
 *         description: Internal server error
 */
router.post('/instant/place', authenticateJWT, ordersController.placeInstantOrder);

// POST /api/orders/close
/**
 * @swagger
 * /api/orders/close:
 *   post:
 *     summary: Close an existing order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order_id
 *               - user_id
 *               - user_type
 *             properties:
 *               order_id:
 *                 type: string
 *               user_id:
 *                 type: string
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               close_price:
 *                 type: number
 *                 description: Optional price hint (must be > 0 if provided)
 *     responses:
 *       200:
 *         description: Close request processed
 *       400:
 *         description: Invalid payload
 *       403:
 *         description: Forbidden (JWT/user checks or market closed)
 *       404:
 *         description: Order not found
 *       409:
 *         description: Conflict (order not OPEN)
 *       503:
 *         description: Provider rejected/timeout
 */
router.post('/close', authenticateJWT, ordersController.closeOrder);

// POST /api/orders/stoploss/add
/**
 * @swagger
 * /api/orders/stoploss/add:
 *   post:
 *     summary: Add/Set a Stop Loss for an existing OPEN order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order_id
 *               - user_id
 *               - user_type
 *               - symbol
 *               - order_type
 *               - stop_loss
 *             properties:
 *               order_id:
 *                 type: string
 *                 example: "ord_20250905_008"
 *               user_id:
 *                 type: string
 *                 example: "5"
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *                 example: "live"
 *               symbol:
 *                 type: string
 *                 example: "EURUSD"
 *               order_type:
 *                 type: string
 *                 enum: [BUY, SELL]
 *                 example: "BUY"
 *               stop_loss:
 *                 type: number
 *                 example: 1.08325
 *               order_status:
 *                 type: string
 *                 description: Internal lifecycle status. Must be OPEN.
 *                 example: "OPEN"
 *               status:
 *                 type: string
 *                 description: External engine status passthrough (used for provider routing)
 *                 example: "STOPLOSS"
 *     responses:
 *       200:
 *         description: Stoploss accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 order_id:
 *                   type: string
 *                 stoploss_id:
 *                   type: string
 *                   description: Lifecycle ID generated for stoploss request
 *                 data:
 *                   type: object
 *                   description: Python service response
 *       400:
 *         description: Invalid payload or price constraints violated
 *       403:
 *         description: Forbidden (JWT/user checks)
 *       404:
 *         description: Order not found
 *       409:
 *         description: Conflict (order is not OPEN)
 *       503:
 *         description: Provider rejected/timeout
 */
router.post('/stoploss/add', authenticateJWT, ordersController.addStopLoss);

// POST /api/orders/takeprofit/add
/**
 * @swagger
 * /api/orders/takeprofit/add:
 *   post:
 *     summary: Add/Set a Take Profit for an existing OPEN order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order_id
 *               - user_id
 *               - user_type
 *               - symbol
 *               - order_type
 *               - take_profit
 *             properties:
 *               order_id:
 *                 type: string
 *                 example: "ord_20250905_008"
 *               user_id:
 *                 type: string
 *                 example: "5"
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *                 example: "live"
 *               symbol:
 *                 type: string
 *                 example: "EURUSD"
 *               order_type:
 *                 type: string
 *                 enum: [BUY, SELL]
 *                 example: "BUY"
 *               take_profit:
 *                 type: number
 *                 example: 1.09675
 *               order_status:
 *                 type: string
 *                 description: Internal lifecycle status. Must be OPEN.
 *                 example: "OPEN"
 *               status:
 *                 type: string
 *                 description: External engine status passthrough (used for provider routing)
 *                 example: "TAKEPROFIT"
 *     responses:
 *       200:
 *         description: Takeprofit accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 order_id:
 *                   type: string
 *                 takeprofit_id:
 *                   type: string
 *                   description: Lifecycle ID generated for takeprofit request
 *                 data:
 *                   type: object
 *                   description: Python service response
 *       400:
 *         description: Invalid payload or price constraints violated
 *       403:
 *         description: Forbidden (JWT/user checks)
 *       404:
 *         description: Order not found
 *       409:
 *         description: Conflict (order is not OPEN)
 *       503:
 *         description: Provider rejected/timeout
 */
router.post('/takeprofit/add', authenticateJWT, ordersController.addTakeProfit);

// POST /api/orders/stoploss/cancel
/**
 * @swagger
 * /api/orders/stoploss/cancel:
 *   post:
 *     summary: Cancel Stop Loss for an OPEN order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order_id
 *               - user_id
 *               - user_type
 *               - symbol
 *               - order_type
 *               - stoploss_id
 *             properties:
 *               order_id:
 *                 type: string
 *               user_id:
 *                 type: string
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               symbol:
 *                 type: string
 *               order_type:
 *                 type: string
 *                 enum: [BUY, SELL]
 *               order_status:
 *                 type: string
 *                 example: OPEN
 *               status:
 *                 type: string
 *                 example: STOPLOSS-CANCEL
 *               stoploss_id:
 *                 type: string
 *                 description: Original lifecycle stoploss id
 *     responses:
 *       200:
 *         description: Cancel request accepted
 *       400:
 *         description: Invalid payload
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 *       409:
 *         description: Conflict (no active SL or order not OPEN)
 */
router.post('/stoploss/cancel', authenticateJWT, ordersController.cancelStopLoss);

// POST /api/orders/takeprofit/cancel
/**
 * @swagger
 * /api/orders/takeprofit/cancel:
 *   post:
 *     summary: Cancel Take Profit for an OPEN order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order_id
 *               - user_id
 *               - user_type
 *               - symbol
 *               - order_type
 *               - takeprofit_id
 *             properties:
 *               order_id:
 *                 type: string
 *               user_id:
 *                 type: string
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               symbol:
 *                 type: string
 *               order_type:
 *                 type: string
 *                 enum: [BUY, SELL]
 *               order_status:
 *                 type: string
 *                 example: OPEN
 *               status:
 *                 type: string
 *                 example: TAKEPROFIT-CANCEL
 *               takeprofit_id:
 *                 type: string
 *                 description: Original lifecycle takeprofit id
 *     responses:
 *       200:
 *         description: Cancel request accepted
 *       400:
 *         description: Invalid payload
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Order not found
 *       409:
 *         description: Conflict (no active TP or order not OPEN)
 */
router.post('/takeprofit/cancel', authenticateJWT, ordersController.cancelTakeProfit);

module.exports = router;
