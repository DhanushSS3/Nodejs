/**
 * Copy Trading Orders Routes
 * 
 * ARCHITECTURE: All strategy provider order endpoints follow the same uniform pattern as live user orders:
 * - JWT Authentication: User info extracted from JWT token (strategy_provider role required)
 * - Operation Tracking: Each operation has unique operationId for tracing
 * - Lifecycle Management: Full lifecycle ID generation and persistence
 * - Structured Logging: Consistent request/response logging
 * - Error Handling: Uniform error responses with operation tracking
 * - Python Service: Proper payload structure matching live user patterns
 * - Margin Updates: Portfolio events and margin persistence
 * 
 * SECURITY: 
 * - All endpoints require JWT authentication with strategy_provider role
 * - Order ownership validated via strategy provider account association
 * - No user_id required in request body (extracted from JWT)
 * 
 * RESPONSE FORMAT:
 * Success: { success: true, data: {}, order_id: "", [specific_id]: "", operationId: "" }
 * Error: { success: false, message: "", operationId: "" }
 */

const express = require('express');
const router = express.Router();
const copyTradingOrdersController = require('../controllers/copyTrading.orders.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { validateRequest } = require('../middlewares/validation.middleware');
const { body, param, query } = require('express-validator');
const logger = require('../utils/logger');


/**
 * @swagger
 * components:
 *   schemas:
 *     StrategyProviderOrderRequest:
 *       type: object
 *       required:
 *         - symbol
 *         - order_type
 *         - order_price
 *         - order_quantity
 *       properties:
 *         symbol:
 *           type: string
 *           description: Trading symbol (e.g., EURUSD)
 *           example: "EURUSD"
 *         order_type:
 *           type: string
 *           enum: [BUY, SELL]
 *           description: Order type
 *           example: "BUY"
 *         order_price:
 *           type: number
 *           description: Order execution price
 *           example: 1.1000
 *         order_quantity:
 *           type: number
 *           description: Order quantity/lot size
 *           example: 1.0
 *         strategy_provider_id:
 *           type: integer
 *           description: Strategy provider account ID (automatically extracted from JWT token)
 *           example: 123
 *           readOnly: true
 *         stop_loss:
 *           type: number
 *           description: Stop loss price (optional)
 *           example: 1.0950
 *         take_profit:
 *           type: number
 *           description: Take profit price (optional)
 *           example: 1.1050
 *         idempotency_key:
 *           type: string
 *           description: Idempotency key for duplicate prevention
 *           example: "unique-key-123"
 *     
 *     StrategyProviderOrderResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         order_id:
 *           type: string
 *           example: "ord_20231021_001"
 *         strategy_provider_id:
 *           type: integer
 *           example: 123
 *         symbol:
 *           type: string
 *           example: "EURUSD"
 *         order_type:
 *           type: string
 *           example: "BUY"
 *         order_status:
 *           type: string
 *           example: "OPEN"
 *         exec_price:
 *           type: number
 *           example: 1.1000
 *         order_quantity:
 *           type: number
 *           example: 1.0
 *         margin:
 *           type: number
 *           example: 1100.00
 *         commission:
 *           type: number
 *           example: 10.00
 */

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider:
 *   post:
 *     summary: Place strategy provider order (master order)
 *     description: Creates a new order for a strategy provider that will be replicated to all active followers
 *     tags: [Copy Trading Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StrategyProviderOrderRequest'
 *     responses:
 *       200:
 *         description: Order placed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StrategyProviderOrderResponse'
 *       400:
 *         description: Invalid request payload
 *       403:
 *         description: Unauthorized or insufficient permissions
 *       404:
 *         description: Strategy provider account not found
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider',
  authenticateJWT,
  [
    body('symbol')
      .notEmpty()
      .withMessage('Symbol is required')
      .isLength({ min: 1, max: 20 })
      .withMessage('Symbol must be 1-20 characters'),
    body('order_type')
      .isIn(['BUY', 'SELL'])
      .withMessage('Order type must be BUY or SELL'),
    body('order_price')
      .isFloat({ gt: 0 })
      .withMessage('Order price must be a positive number'),
    body('order_quantity')
      .isFloat({ gt: 0 })
      .withMessage('Order quantity must be a positive number'),
    body('stop_loss')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('Stop loss must be a positive number'),
    body('take_profit')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('Take profit must be a positive number'),
    body('idempotency_key')
      .optional()
      .isLength({ min: 1, max: 100 })
      .withMessage('Idempotency key must be 1-100 characters')
  ],
  validateRequest,
  copyTradingOrdersController.placeStrategyProviderOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/pending:
 *   post:
 *     summary: Place strategy provider pending order (master pending order)
 *     description: Creates a new pending order for a strategy provider that will be replicated to all active followers
 *     tags: [Copy Trading Orders]
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
 *             properties:
 *               symbol:
 *                 type: string
 *                 description: Trading symbol (e.g., EURUSD)
 *                 example: "EURUSD"
 *               order_type:
 *                 type: string
 *                 enum: [BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP]
 *                 description: Pending order type
 *                 example: "BUY_LIMIT"
 *               order_price:
 *                 type: number
 *                 description: Order trigger price
 *                 example: 1.0950
 *               order_quantity:
 *                 type: number
 *                 description: Order quantity/lot size
 *                 example: 1.0
 *               stop_loss:
 *                 type: number
 *                 description: Stop loss price (optional)
 *                 example: 1.0900
 *               take_profit:
 *                 type: number
 *                 description: Take profit price (optional)
 *                 example: 1.1000
 *     responses:
 *       201:
 *         description: Pending order placed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 order_id:
 *                   type: string
 *                   example: "ord_20231021_001"
 *                 strategy_provider_id:
 *                   type: integer
 *                   example: 123
 *                 symbol:
 *                   type: string
 *                   example: "EURUSD"
 *                 order_type:
 *                   type: string
 *                   example: "BUY_LIMIT"
 *                 order_status:
 *                   type: string
 *                   example: "PENDING"
 *                 order_price:
 *                   type: number
 *                   example: 1.0950
 *                 order_quantity:
 *                   type: number
 *                   example: 1.0
 *                 compare_price:
 *                   type: number
 *                   example: 1.0945
 *                 group:
 *                   type: string
 *                   example: "Standard"
 *                 operationId:
 *                   type: string
 *                   example: "strategy_provider_pending_place_1698012345_abc123"
 *       400:
 *         description: Invalid request payload
 *       403:
 *         description: Unauthorized or insufficient permissions
 *       404:
 *         description: Strategy provider account not found
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/pending',
  authenticateJWT,
  [
    body('symbol')
      .notEmpty()
      .withMessage('Symbol is required')
      .isLength({ min: 1, max: 20 })
      .withMessage('Symbol must be 1-20 characters'),
    body('order_type')
      .isIn(['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'])
      .withMessage('Order type must be BUY_LIMIT, SELL_LIMIT, BUY_STOP, or SELL_STOP'),
    body('order_price')
      .isFloat({ gt: 0 })
      .withMessage('Order price must be a positive number'),
    body('order_quantity')
      .isFloat({ gt: 0 })
      .withMessage('Order quantity must be a positive number'),
    body('stop_loss')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('Stop loss must be a positive number'),
    body('take_profit')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('Take profit must be a positive number')
  ],
  validateRequest,
  copyTradingOrdersController.placeStrategyProviderPendingOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/{strategy_provider_id}:
 *   get:
 *     summary: Get strategy provider orders
 *     description: Retrieves all orders for a specific strategy provider account
 *     tags: [Copy Trading Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: strategy_provider_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider account ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of orders to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of orders to skip
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *       403:
 *         description: Unauthorized access
 *       404:
 *         description: Strategy provider account not found
 *       500:
 *         description: Internal server error
 */
router.get('/strategy-provider/:strategy_provider_id',
  authenticateJWT,
  [
    param('strategy_provider_id')
      .isInt({ gt: 0 })
      .withMessage('Strategy provider ID must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer')
  ],
  validateRequest,
  copyTradingOrdersController.getStrategyProviderOrders
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/close:
 *   post:
 *     summary: Close strategy provider order
 *     description: Closes a strategy provider order with full lifecycle management. User authentication via JWT (strategy_provider role required). Follows exact same pattern as live user orders with operation tracking, lifecycle IDs, and margin updates.
 *     tags: [Copy Trading Orders]
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
 *             properties:
 *               order_id:
 *                 type: string
 *                 description: Order ID to close (required)
 *                 example: "ord_20231021_001"
 *               close_price:
 *                 type: number
 *                 description: Specific close price (optional, will use market price if not provided)
 *                 example: 1.1025
 *               status:
 *                 type: string
 *                 description: Order status (optional, defaults to CLOSED)
 *                 example: "CLOSED"
 *               order_status:
 *                 type: string
 *                 description: Engine order status (optional, defaults to CLOSED)
 *                 example: "CLOSED"
 *               idempotency_key:
 *                 type: string
 *                 description: Idempotency key for duplicate prevention (optional)
 *                 example: "unique-key-123"
 *     responses:
 *       200:
 *         description: Order closed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Python service response data
 *                 order_id:
 *                   type: string
 *                   example: "ord_20231021_001"
 *                 operationId:
 *                   type: string
 *                   example: "close_sp_order_1698012345_abc123"
 *       400:
 *         description: Order cannot be closed in current status or invalid parameters
 *       403:
 *         description: Unauthorized access or invalid strategy provider role
 *       404:
 *         description: Order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/close',
  authenticateJWT,
  [
    body('order_id')
      .notEmpty()
      .withMessage('Order ID is required'),
    body('close_price')
      .optional()
      .isFloat({ gt: 0 })
      .withMessage('Close price must be a positive number')
  ],
  validateRequest,
  copyTradingOrdersController.closeStrategyProviderOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/copy-follower/{copy_follower_account_id}:
 *   get:
 *     summary: Get copy follower orders
 *     description: Retrieves all orders for a specific copy follower account
 *     tags: [Copy Trading Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: copy_follower_account_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Copy follower account ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of orders to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of orders to skip
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *       403:
 *         description: Unauthorized access
 *       404:
 *         description: Copy follower account not found
 *       500:
 *         description: Internal server error
 */
router.get('/copy-follower/:copy_follower_account_id',
  authenticateJWT,
  [
    param('copy_follower_account_id')
      .isInt({ gt: 0 })
      .withMessage('Copy follower account ID must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer')
  ],
  validateRequest,
  copyTradingOrdersController.getCopyFollowerOrders
);

/**
 * @swagger
 * /api/copy-trading/orders/copy-follower/{copy_follower_account_id}/closed-orders:
 *   get:
 *     summary: Get closed orders for a specific copy follower account
 *     description: Retrieves all closed orders for a specific copy follower account with comprehensive order details including performance fees and profitability metrics
 *     tags: [Copy Trading Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: copy_follower_account_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Copy follower account ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: page_size
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *         description: Number of orders per page
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *         description: Alternative to page_size (for backward compatibility)
 *     responses:
 *       200:
 *         description: Closed orders retrieved successfully
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
 *                   example: "Closed orders retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     copy_follower_account:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                           example: 123
 *                         account_name:
 *                           type: string
 *                           example: "My Copy Trading Account"
 *                         account_number:
 *                           type: string
 *                           example: "CF1730890123456"
 *                         status:
 *                           type: integer
 *                           example: 1
 *                         is_active:
 *                           type: integer
 *                           example: 1
 *                         strategy_provider:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                               example: 456
 *                             strategy_name:
 *                               type: string
 *                               example: "Conservative Growth Strategy"
 *                             account_number:
 *                               type: string
 *                               example: "SP1730890123456"
 *                     orders:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           order_id:
 *                             type: string
 *                             example: "1274319128000"
 *                           master_order_id:
 *                             type: string
 *                             example: "1274319127000"
 *                           symbol:
 *                             type: string
 *                             example: "EURUSD"
 *                           order_type:
 *                             type: string
 *                             example: "BUY"
 *                           order_status:
 *                             type: string
 *                             example: "CLOSED"
 *                           order_price:
 *                             type: number
 *                             example: 1.1000
 *                           order_quantity:
 *                             type: number
 *                             example: 0.1
 *                           close_price:
 *                             type: number
 *                             example: 1.1025
 *                           net_profit:
 *                             type: number
 *                             example: 25.00
 *                           commission:
 *                             type: number
 *                             example: 2.50
 *                           swap:
 *                             type: number
 *                             example: 0.00
 *                           close_message:
 *                             type: string
 *                             example: "Order closed by user"
 *                           performance_fee_amount:
 *                             type: number
 *                             example: 5.00
 *                           net_profit_after_fees:
 *                             type: number
 *                             example: 20.00
 *                           gross_profit:
 *                             type: number
 *                             example: 25.00
 *                           fee_status:
 *                             type: string
 *                             example: "paid"
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                             example: "2025-11-06T10:30:00.000Z"
 *                           updated_at:
 *                             type: string
 *                             format: date-time
 *                             example: "2025-11-06T10:35:00.000Z"
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         current_page:
 *                           type: integer
 *                           example: 1
 *                         page_size:
 *                           type: integer
 *                           example: 20
 *                         total_orders:
 *                           type: integer
 *                           example: 150
 *                         total_pages:
 *                           type: integer
 *                           example: 8
 *                         has_next_page:
 *                           type: boolean
 *                           example: true
 *                         has_previous_page:
 *                           type: boolean
 *                           example: false
 *       400:
 *         description: Invalid copy follower account ID parameter
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Unauthorized access
 *       404:
 *         description: Copy follower account not found or access denied
 *       500:
 *         description: Internal server error
 */
router.get('/copy-follower/:copy_follower_account_id/closed-orders',
  authenticateJWT,
  [
    param('copy_follower_account_id')
      .isInt({ gt: 0 })
      .withMessage('Copy follower account ID must be a positive integer'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('page_size')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Page size must be between 1 and 100'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
  ],
  validateRequest,
  copyTradingOrdersController.getCopyFollowerClosedOrders
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/take-profit/cancel:
 *   post:
 *     summary: Cancel take profit from strategy provider order
 *     description: Removes take profit from strategy provider order with full lifecycle management. User authentication via JWT (strategy_provider role required). Follows exact same pattern as live user orders with operation tracking and lifecycle IDs.
 *     tags: [Copy Trading Orders]
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
 *             properties:
 *               order_id:
 *                 type: string
 *                 description: Order ID to cancel take profit from (required)
 *                 example: "ord_20231021_001"
 *               takeprofit_id:
 *                 type: string
 *                 description: Take profit ID (optional, will be generated if not provided)
 *                 example: "tp_20231021_001"
 *               idempotency_key:
 *                 type: string
 *                 description: Idempotency key for duplicate prevention (optional)
 *                 example: "unique-key-123"
 *     responses:
 *       200:
 *         description: Take profit cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Python service response data
 *                 order_id:
 *                   type: string
 *                   example: "ord_20231021_001"
 *                 takeprofit_cancel_id:
 *                   type: string
 *                   example: "tp_cancel_20231021_001"
 *                 operationId:
 *                   type: string
 *                   example: "cancel_sp_takeprofit_1698012345_abc123"
 *       400:
 *         description: No take profit to cancel or invalid parameters
 *       403:
 *         description: Unauthorized access or invalid strategy provider role
 *       404:
 *         description: Order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/take-profit/cancel',
  authenticateJWT,
  [
    body('order_id')
      .notEmpty()
      .withMessage('Order ID is required'),
    body('takeprofit_id')
      .optional()
      .isString()
      .withMessage('Take profit ID must be a string')
  ],
  validateRequest,
  copyTradingOrdersController.cancelTakeProfitFromOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/stop-loss/cancel:
 *   post:
 *     summary: Cancel stop loss from strategy provider order
 *     description: Removes stop loss from strategy provider order with full lifecycle management. User authentication via JWT (strategy_provider role required). Follows exact same pattern as live user orders with operation tracking and lifecycle IDs.
 *     tags: [Copy Trading Orders]
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
 *             properties:
 *               order_id:
 *                 type: string
 *                 description: Order ID to cancel stop loss from (required)
 *                 example: "ord_20231021_001"
 *               stoploss_id:
 *                 type: string
 *                 description: Stop loss ID (optional, will be generated if not provided)
 *                 example: "sl_20231021_001"
 *               idempotency_key:
 *                 type: string
 *                 description: Idempotency key for duplicate prevention (optional)
 *                 example: "unique-key-123"
 *     responses:
 *       200:
 *         description: Stop loss cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Python service response data
 *                 order_id:
 *                   type: string
 *                   example: "ord_20231021_001"
 *                 stoploss_cancel_id:
 *                   type: string
 *                   example: "sl_cancel_20231021_001"
 *                 operationId:
 *                   type: string
 *                   example: "cancel_sp_stoploss_1698012345_abc123"
 *       400:
 *         description: No stop loss to cancel or invalid parameters
 *       403:
 *         description: Unauthorized access or invalid strategy provider role
 *       404:
 *         description: Order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/stop-loss/cancel',
  authenticateJWT,
  [
    body('order_id')
      .notEmpty()
      .withMessage('Order ID is required'),
    body('stoploss_id')
      .optional()
      .isString()
      .withMessage('Stop loss ID must be a string')
  ],
  validateRequest,
  copyTradingOrdersController.cancelStopLossFromOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/{order_id}/cancel:
 *   post:
 *     summary: Cancel strategy provider order
 *     description: Cancels a pending strategy provider order and related follower orders
 *     tags: [Copy Trading Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: order_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID to cancel
 *     responses:
 *       200:
 *         description: Order cancelled successfully
 *       400:
 *         description: Order cannot be cancelled in current status
 *       403:
 *         description: Unauthorized access
 *       404:
 *         description: Order not found
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/:order_id/cancel',
  authenticateJWT,
  [
    param('order_id')
      .notEmpty()
      .withMessage('Order ID is required')
  ],
  validateRequest,
  copyTradingOrdersController.cancelStrategyProviderOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/stop-loss/add:
 *   post:
 *     summary: Add stop loss to strategy provider order
 *     description: Adds stop loss to an open strategy provider order with full lifecycle management. User authentication via JWT (strategy_provider role required). Follows exact same pattern as live user orders with operation tracking and lifecycle IDs.
 *     tags: [Copy Trading Orders]
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
 *               - stop_loss
 *             properties:
 *               order_id:
 *                 type: string
 *                 description: Order ID to add stop loss to (required)
 *                 example: "ord_20231021_001"
 *               stop_loss:
 *                 type: number
 *                 description: Stop loss price
 *                 example: 1.0950
 *               status:
 *                 type: string
 *                 description: Order status (optional, defaults to STOPLOSS)
 *                 example: "STOPLOSS"
 *               order_status:
 *                 type: string
 *                 description: Engine order status (optional, defaults to OPEN)
 *                 example: "OPEN"
 *               idempotency_key:
 *                 type: string
 *                 description: Idempotency key for duplicate prevention (optional)
 *                 example: "unique-key-123"
 *     responses:
 *       200:
 *         description: Stop loss added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Python service response data
 *                 order_id:
 *                   type: string
 *                   example: "ord_20231021_001"
 *                 stoploss_id:
 *                   type: string
 *                   example: "sl_20231021_001"
 *                 operationId:
 *                   type: string
 *                   example: "add_sp_stoploss_1698012345_abc123"
 *       400:
 *         description: Invalid request, order status, or stop loss value
 *       403:
 *         description: Unauthorized access or invalid strategy provider role
 *       404:
 *         description: Order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/stop-loss/add',
  authenticateJWT,
  [
    body('order_id')
      .notEmpty()
      .withMessage('Order ID is required'),
    body('stop_loss')
      .isFloat({ gt: 0 })
      .withMessage('Stop loss must be a positive number')
  ],
  validateRequest,
  copyTradingOrdersController.addStopLossToOrder
);

/**
 * @swagger
 * /api/copy-trading/orders/strategy-provider/take-profit/add:
 *   post:
 *     summary: Add take profit to strategy provider order
 *     description: Adds take profit to an open strategy provider order with full lifecycle management. User authentication via JWT (strategy_provider role required). Follows exact same pattern as live user orders with operation tracking and lifecycle IDs.
 *     tags: [Copy Trading Orders]
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
 *               - take_profit
 *             properties:
 *               order_id:
 *                 type: string
 *                 description: Order ID to add take profit to (required)
 *                 example: "ord_20231021_001"
 *               take_profit:
 *                 type: number
 *                 description: Take profit price
 *                 example: 1.1050
 *               status:
 *                 type: string
 *                 description: Order status (optional, defaults to TAKEPROFIT)
 *                 example: "TAKEPROFIT"
 *               order_status:
 *                 type: string
 *                 description: Engine order status (optional, defaults to OPEN)
 *                 example: "OPEN"
 *               idempotency_key:
 *                 type: string
 *                 description: Idempotency key for duplicate prevention (optional)
 *                 example: "unique-key-123"
 *     responses:
 *       200:
 *         description: Take profit added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Python service response data
 *                 order_id:
 *                   type: string
 *                   example: "ord_20231021_001"
 *                 takeprofit_id:
 *                   type: string
 *                   example: "tp_20231021_001"
 *                 operationId:
 *                   type: string
 *                   example: "add_sp_takeprofit_1698012345_abc123"
 *       400:
 *         description: Invalid request, order status, or take profit value
 *       403:
 *         description: Unauthorized access or invalid strategy provider role
 *       404:
 *         description: Order not found or access denied
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-provider/take-profit/add',
  authenticateJWT,
  [
    body('order_id')
      .notEmpty()
      .withMessage('Order ID is required'),
    body('take_profit')
      .isFloat({ gt: 0 })
      .withMessage('Take profit must be a positive number')
  ],
  validateRequest,
  copyTradingOrdersController.addTakeProfitToOrder
);

module.exports = router;
