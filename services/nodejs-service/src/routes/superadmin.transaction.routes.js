const express = require('express');
const router = express.Router();
const superadminTransactionController = require('../controllers/superadmin.transaction.controller');
const { authenticateAdmin, requireRole, requirePermissions } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     TransactionRequest:
 *       type: object
 *       required:
 *         - userType
 *         - amount
 *       properties:
 *         userType:
 *           type: string
 *           enum: [live, demo]
 *           description: Type of user account (optional - if not provided, searches both live and demo users)
 *         amount:
 *           type: number
 *           minimum: 0.01
 *           description: Transaction amount (must be positive)
 *         notes:
 *           type: string
 *           description: Optional notes for the transaction
 *         referenceId:
 *           type: string
 *           description: Optional external reference ID
 *     
 *     TransactionResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *           properties:
 *             transaction:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 transaction_id:
 *                   type: string
 *                 type:
 *                   type: string
 *                 amount:
 *                   type: number
 *                 status:
 *                   type: string
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *             user:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 name:
 *                   type: string
 *                 email:
 *                   type: string
 *                 balance_before:
 *                   type: number
 *                 balance_after:
 *                   type: number
 */

/**
 * @swagger
 * /api/superadmin/users/{userId}/deposit:
 *   post:
 *     summary: Process deposit for a user (Superadmin only)
 *     tags: [Superadmin Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransactionRequest'
 *           example:
 *             userType: "live"
 *             amount: 1000.50
 *             notes: "Initial deposit for new user"
 *             referenceId: "BANK_REF_123456"
 *     responses:
 *       200:
 *         description: Deposit processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransactionResponse'
 *       400:
 *         description: Invalid input or insufficient balance
 *       401:
 *         description: Unauthorized (missing or invalid token)
 *       403:
 *         description: Forbidden (superadmin role required)
 *       404:
 *         description: User not found
 */
router.post('/users/:userId/deposit', 
  authenticateAdmin, 
  requireRole(['superadmin']), 
  handleValidationErrors, 
  superadminTransactionController.processDeposit
);

/**
 * @swagger
 * /api/superadmin/users/{userId}/withdraw:
 *   post:
 *     summary: Process withdrawal for a user (Superadmin only)
 *     tags: [Superadmin Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransactionRequest'
 *           example:
 *             userType: "live"
 *             amount: 500.00
 *             notes: "Withdrawal request approved"
 *             referenceId: "WITHDRAWAL_REQ_789"
 *     responses:
 *       200:
 *         description: Withdrawal processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransactionResponse'
 *       400:
 *         description: Invalid input or insufficient balance
 *       401:
 *         description: Unauthorized (missing or invalid token)
 *       403:
 *         description: Forbidden (superadmin role required)
 *       404:
 *         description: User not found
 */
router.post('/users/:userId/withdraw', 
  authenticateAdmin, 
  requireRole(['superadmin']), 
  handleValidationErrors, 
  superadminTransactionController.processWithdrawal
);

/**
 * @swagger
 * /api/superadmin/users/{userId}/balance:
 *   get:
 *     summary: Get user current balance (Admin with transaction:read permission)
 *     tags: [Superadmin Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *       - in: query
 *         name: userType
 *         required: false
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: Type of user account (optional - if not provided, searches both live and demo users)
 *     responses:
 *       200:
 *         description: User balance retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     balance:
 *                       type: number
 *                     source:
 *                       type: string
 *                       enum: [cache, database]
 *                     userType:
 *                       type: string
 *                       enum: [live, demo]
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         email:
 *                           type: string
 *                         is_active:
 *                           type: boolean
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (requires transaction:read permission)
 *       404:
 *         description: User not found
 */
router.get('/users/:userId/balance', 
  authenticateAdmin, 
  requirePermissions(['transaction:read']), 
  superadminTransactionController.getUserBalance
);

/**
 * @swagger
 * /api/superadmin/users/{userId}/transactions:
 *   get:
 *     summary: Get user transaction history (Superadmin only)
 *     tags: [Superadmin Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *       - in: query
 *         name: userType
 *         required: false
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: Type of user account (optional - if not provided, searches both live and demo users)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of transactions to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of transactions to skip (for pagination)
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [deposit, withdraw, profit, loss, commission, swap, adjustment]
 *         description: Filter by transaction type
 *     responses:
 *       200:
 *         description: Transaction history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     transactions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           transaction_id:
 *                             type: string
 *                           type:
 *                             type: string
 *                           amount:
 *                             type: number
 *                           balance_before:
 *                             type: number
 *                           balance_after:
 *                             type: number
 *                           status:
 *                             type: string
 *                           reference_id:
 *                             type: string
 *                           notes:
 *                             type: string
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         limit:
 *                           type: integer
 *                         offset:
 *                           type: integer
 *                         hasMore:
 *                           type: boolean
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (not a superadmin)
 *       404:
 *         description: User not found
 */
router.get('/users/:userId/transactions', 
  authenticateAdmin, 
  requirePermissions(['transaction:read']), 
  superadminTransactionController.getUserTransactionHistory
);

/**
 * @swagger
 * /api/superadmin/transactions/stats:
 *   get:
 *     summary: Get transaction statistics for dashboard (Superadmin only)
 *     tags: [Superadmin Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userType
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: Filter by user type (optional)
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *           default: 30
 *         description: Number of days to include in statistics
 *     responses:
 *       200:
 *         description: Transaction statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     period:
 *                       type: object
 *                       properties:
 *                         start_date:
 *                           type: string
 *                           format: date-time
 *                         end_date:
 *                           type: string
 *                           format: date-time
 *                         days:
 *                           type: integer
 *                     statistics:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           user_type:
 *                             type: string
 *                           type:
 *                             type: string
 *                           count:
 *                             type: integer
 *                           total_amount:
 *                             type: number
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (not a superadmin)
 *       500:
 *         description: Internal server error
 */
router.get('/transactions/stats', 
  authenticateAdmin, 
  requirePermissions(['transaction:stats']), 
  superadminTransactionController.getTransactionStats
);

module.exports = router;
