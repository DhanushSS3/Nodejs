const express = require('express');
const { query } = require('express-validator');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');
const FinancialSummaryController = require('../controllers/financial.summary.controller');

const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     FinancialSummary:
 *       type: object
 *       properties:
 *         user_id:
 *           type: integer
 *           description: User ID
 *         user_type:
 *           type: string
 *           enum: [live, demo]
 *           description: Type of user account
 *         balance:
 *           type: number
 *           format: float
 *           description: Current wallet balance
 *         total_margin:
 *           type: number
 *           format: float
 *           description: Total margin currently used
 *         period:
 *           type: object
 *           properties:
 *             start_date:
 *               type: string
 *               format: date-time
 *               nullable: true
 *               description: Start date for filtered data
 *             end_date:
 *               type: string
 *               format: date-time
 *               nullable: true
 *               description: End date for filtered data
 *             is_filtered:
 *               type: boolean
 *               description: Whether date filtering was applied
 *         trading:
 *           type: object
 *           properties:
 *             net_profit:
 *               type: number
 *               format: float
 *               description: Sum of net profit from orders in the period
 *             commission:
 *               type: number
 *               format: float
 *               description: Sum of commission from orders in the period
 *             swap:
 *               type: number
 *               format: float
 *               description: Sum of swap from orders in the period
 *             total_orders:
 *               type: integer
 *               description: Total number of orders in the period
 *         transactions:
 *           type: object
 *           properties:
 *             total_deposits:
 *               type: number
 *               format: float
 *               description: Sum of deposits in the period
 *             deposit_count:
 *               type: integer
 *               description: Number of deposits in the period
 *         overall:
 *           type: object
 *           properties:
 *             user_net_profit:
 *               type: number
 *               format: float
 *               description: User's total net profit (from user table)
 */

/**
 * @swagger
 * /api/financial-summary:
 *   get:
 *     summary: Get comprehensive financial summary for authenticated user
 *     tags: [Financial Summary]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for filtering data (YYYY-MM-DD or ISO format)
 *         example: "2024-01-01"
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for filtering data (YYYY-MM-DD or ISO format)
 *         example: "2024-12-31"
 *     responses:
 *       200:
 *         description: Financial summary retrieved successfully
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
 *                   example: "Financial summary retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/FinancialSummary'
 *             example:
 *               success: true
 *               message: "Financial summary retrieved successfully"
 *               data:
 *                 user_id: 123
 *                 user_type: "live"
 *                 balance: 10000.50
 *                 total_margin: 2500.00
 *                 period:
 *                   start_date: "2024-01-01T00:00:00.000Z"
 *                   end_date: "2024-12-31T23:59:59.999Z"
 *                   is_filtered: true
 *                 trading:
 *                   net_profit: 1250.75
 *                   commission: 45.50
 *                   swap: -12.25
 *                   total_orders: 25
 *                 transactions:
 *                   total_deposits: 5000.00
 *                   deposit_count: 3
 *                 overall:
 *                   user_net_profit: 1250.75
 *       400:
 *         description: Bad request - Invalid parameters
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
 *                   example: "Invalid start_date format. Use YYYY-MM-DD or ISO format."
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.get('/',
  authenticateJWT,
  [
    query('start_date')
      .optional()
      .isISO8601()
      .withMessage('start_date must be a valid date in YYYY-MM-DD or ISO format'),
    query('end_date')
      .optional()
      .isISO8601()
      .withMessage('end_date must be a valid date in YYYY-MM-DD or ISO format')
  ],
  handleValidationErrors,
  FinancialSummaryController.getFinancialSummary
);

/**
 * @swagger
 * /api/live-users/financial-summary:
 *   get:
 *     summary: Get financial summary for authenticated live user
 *     tags: [Live Users, Financial Summary]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for filtering data (YYYY-MM-DD or ISO format)
 *         example: "2024-01-01"
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for filtering data (YYYY-MM-DD or ISO format)
 *         example: "2024-12-31"
 *     responses:
 *       200:
 *         description: Live user financial summary retrieved successfully
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
 *                   example: "Financial summary retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/FinancialSummary'
 *       400:
 *         description: Bad request - Invalid parameters
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: Live user not found
 *       500:
 *         description: Internal server error
 */
const liveUserFinancialSummaryRouter = express.Router();
liveUserFinancialSummaryRouter.get('/financial-summary',
  authenticateJWT,
  [
    query('start_date')
      .optional()
      .isISO8601()
      .withMessage('start_date must be a valid date in YYYY-MM-DD or ISO format'),
    query('end_date')
      .optional()
      .isISO8601()
      .withMessage('end_date must be a valid date in YYYY-MM-DD or ISO format')
  ],
  handleValidationErrors,
  FinancialSummaryController.getLiveUserFinancialSummary
);

/**
 * @swagger
 * /api/demo-users/financial-summary:
 *   get:
 *     summary: Get financial summary for authenticated demo user
 *     tags: [Demo Users, Financial Summary]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for filtering data (YYYY-MM-DD or ISO format)
 *         example: "2024-01-01"
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for filtering data (YYYY-MM-DD or ISO format)
 *         example: "2024-12-31"
 *     responses:
 *       200:
 *         description: Demo user financial summary retrieved successfully
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
 *                   example: "Financial summary retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/FinancialSummary'
 *       400:
 *         description: Bad request - Invalid parameters
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: Demo user not found
 *       500:
 *         description: Internal server error
 */
const demoUserFinancialSummaryRouter = express.Router();
demoUserFinancialSummaryRouter.get('/financial-summary',
  authenticateJWT,
  [
    query('start_date')
      .optional()
      .isISO8601()
      .withMessage('start_date must be a valid date in YYYY-MM-DD or ISO format'),
    query('end_date')
      .optional()
      .isISO8601()
      .withMessage('end_date must be a valid date in YYYY-MM-DD or ISO format')
  ],
  handleValidationErrors,
  FinancialSummaryController.getDemoUserFinancialSummary
);

module.exports = {
  financialSummaryRouter: router,
  liveUserFinancialSummaryRouter,
  demoUserFinancialSummaryRouter
};
