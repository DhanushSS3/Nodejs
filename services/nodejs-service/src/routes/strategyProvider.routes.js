const express = require('express');
const router = express.Router();
const strategyProviderController = require('../controllers/strategyProvider.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     CreateStrategyProviderRequest:
 *       type: object
 *       required:
 *         - strategy_name
 *       properties:
 *         strategy_name:
 *           type: string
 *           minLength: 10
 *           maxLength: 100
 *           description: Unique strategy name (minimum 10 characters)
 *           example: "EURUSD Scalping Pro Strategy"
 *         description:
 *           type: string
 *           description: Strategy description
 *           example: "Professional EURUSD scalping strategy with 80% win rate"
 *         visibility:
 *           type: string
 *           enum: [public, private]
 *           default: public
 *           description: Strategy visibility
 *         performance_fee:
 *           type: number
 *           minimum: 5.00
 *           maximum: 50.00
 *           default: 20.00
 *           description: Performance fee percentage (5-50%)
 *           example: 25.00
 *         leverage:
 *           type: integer
 *           enum: [50, 100, 200]
 *           default: 100
 *           description: Account leverage
 *         max_leverage:
 *           type: integer
 *           enum: [50, 100, 200]
 *           description: Maximum leverage for followers
 *         min_investment:
 *           type: number
 *           minimum: 100.00
 *           default: 100.00
 *           description: Minimum investment amount in USD
 *           example: 500.00
 *         max_total_investment:
 *           type: number
 *           maximum: 500000.00
 *           default: 500000.00
 *           description: Maximum total investment amount in USD
 *         max_followers:
 *           type: integer
 *           default: 1000
 *           description: Maximum number of followers
 *         auto_cutoff_level:
 *           type: number
 *           minimum: 10.00
 *           maximum: 90.00
 *           default: 50.00
 *           description: Auto-cutoff level percentage
 *         group:
 *           type: string
 *           description: Trading group
 *           example: "Standard"
 *         strategy_password:
 *           type: string
 *           minLength: 8
 *           description: Password for private strategies (required if visibility is private)
 *     
 *     StrategyProviderResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Strategy provider account ID
 *         user_id:
 *           type: integer
 *           description: Owner user ID
 *         strategy_name:
 *           type: string
 *           description: Strategy name
 *         description:
 *           type: string
 *           description: Strategy description
 *         account_number:
 *           type: string
 *           description: Unique account number
 *         wallet_balance:
 *           type: number
 *           description: Current wallet balance
 *         leverage:
 *           type: integer
 *           description: Account leverage
 *         margin:
 *           type: number
 *           description: Used margin
 *         net_profit:
 *           type: number
 *           description: Net profit/loss
 *         equity:
 *           type: number
 *           description: Account equity
 *         group:
 *           type: string
 *           description: Trading group
 *         visibility:
 *           type: string
 *           enum: [public, private]
 *           description: Strategy visibility
 *         access_link:
 *           type: string
 *           description: Access link for private strategies
 *         performance_fee:
 *           type: number
 *           description: Performance fee percentage
 *         min_investment:
 *           type: number
 *           description: Minimum investment amount
 *         max_total_investment:
 *           type: number
 *           description: Maximum total investment
 *         max_followers:
 *           type: integer
 *           description: Maximum followers
 *         status:
 *           type: integer
 *           description: Account status (1=active, 0=inactive)
 *         is_active:
 *           type: integer
 *           description: Active flag
 *         is_catalog_eligible:
 *           type: boolean
 *           description: Catalog eligibility
 *         is_trustworthy:
 *           type: boolean
 *           description: Trustworthy status
 *         total_followers:
 *           type: integer
 *           description: Current follower count
 *         total_investment:
 *           type: number
 *           description: Total investment amount
 *         total_trades:
 *           type: integer
 *           description: Total trades executed
 *         win_rate:
 *           type: number
 *           description: Win rate percentage
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 */

/**
 * @swagger
 * /api/strategy-providers:
 *   post:
 *     summary: Create a new strategy provider account
 *     description: Create a new strategy provider account for authenticated live user following Exness requirements
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateStrategyProviderRequest'
 *           examples:
 *             public_strategy:
 *               summary: Public Strategy Example
 *               value:
 *                 strategy_name: "EURUSD Scalping Pro Strategy"
 *                 description: "Professional EURUSD scalping strategy with consistent profits"
 *                 visibility: "public"
 *                 performance_fee: 25.00
 *                 leverage: 100
 *                 min_investment: 500.00
 *                 max_total_investment: 100000.00
 *                 auto_cutoff_level: 40.00
 *             private_strategy:
 *               summary: Private Strategy Example
 *               value:
 *                 strategy_name: "Elite Gold Trading Strategy"
 *                 description: "Exclusive gold trading strategy for VIP clients"
 *                 visibility: "private"
 *                 strategy_password: "SecurePass123"
 *                 performance_fee: 35.00
 *                 leverage: 200
 *                 min_investment: 1000.00
 *     responses:
 *       201:
 *         description: Strategy provider account created successfully
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
 *                   example: "Strategy provider account created successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       $ref: '#/components/schemas/StrategyProviderResponse'
 *       400:
 *         description: Validation error or maximum accounts reached
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
 *                   example: "Validation failed: Strategy name must be at least 10 characters long"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Only live users can create strategy provider accounts
 *       409:
 *         description: Conflict - Strategy name already exists
 *       500:
 *         description: Internal server error
 *   get:
 *     summary: Get all strategy provider accounts for authenticated user
 *     description: Retrieve all strategy provider accounts owned by the authenticated user
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Strategy provider accounts retrieved successfully
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
 *                   example: "Strategy provider accounts retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_providers:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/StrategyProviderResponse'
 *                     total:
 *                       type: integer
 *                       example: 2
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/strategy-providers/{id}:
 *   get:
 *     summary: Get strategy provider account by ID
 *     description: Retrieve a specific strategy provider account owned by the authenticated user
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider account ID
 *         example: 1
 *     responses:
 *       200:
 *         description: Strategy provider account retrieved successfully
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
 *                   example: "Strategy provider account retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       $ref: '#/components/schemas/StrategyProviderResponse'
 *       400:
 *         description: Invalid strategy provider ID
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: Strategy provider account not found
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/strategy-providers/private/{accessLink}:
 *   get:
 *     summary: Get private strategy by access link (authenticated live users only)
 *     description: Get full private strategy details using access link. Requires authentication and live user account.
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: accessLink
 *         required: true
 *         schema:
 *           type: string
 *         description: Unique access link for private strategy
 *         example: "a1b2c3d4e5f6g7h8"
 *     responses:
 *       200:
 *         description: Private strategy retrieved successfully
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
 *                   example: "Private strategy retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       allOf:
 *                         - $ref: '#/components/schemas/StrategyProviderResponse'
 *                         - type: object
 *                           properties:
 *                             is_private:
 *                               type: boolean
 *                               example: true
 *                             can_follow:
 *                               type: boolean
 *                               example: true
 *                             requirements_met:
 *                               type: object
 *                               properties:
 *                                 eligible:
 *                                   type: boolean
 *                                 requirements:
 *                                   type: object
 *                                   properties:
 *                                     min_equity:
 *                                       type: number
 *                                     current_equity:
 *                                       type: number
 *       400:
 *         description: Strategy does not meet requirements or invalid access link
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Only live users can access private strategies or cannot follow own strategy
 *       404:
 *         description: Private strategy not found or inactive
 *       500:
 *         description: Internal server error
 */


// Apply JWT authentication to all routes
router.use(authenticateJWT);

// Private strategy routes (requires authentication)
router.get('/private/:accessLink', strategyProviderController.getPrivateStrategyByLink);

// Strategy Provider Account Routes (requires authentication)
router.post('/', strategyProviderController.createStrategyProviderAccount);
router.get('/', strategyProviderController.getUserStrategyProviderAccounts);
router.get('/:id', strategyProviderController.getStrategyProviderAccount);

module.exports = router;
