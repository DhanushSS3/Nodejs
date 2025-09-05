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

module.exports = router;
