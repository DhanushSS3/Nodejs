const express = require('express');
const router = express.Router();
const InternalTransferController = require('../controllers/internalTransfer.controller');
const { authenticateToken } = require('../middleware/auth');
const { body, param, query } = require('express-validator');
const { handleValidationErrors } = require('../middleware/validation');

/**
 * @swagger
 * components:
 *   schemas:
 *     Account:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           enum: [main, strategy_provider, copy_follower]
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         account_number:
 *           type: string
 *         wallet_balance:
 *           type: number
 *         margin:
 *           type: number
 *         net_profit:
 *           type: number
 *         available_balance:
 *           type: number
 *     
 *     TransferRequest:
 *       type: object
 *       required:
 *         - fromAccountType
 *         - toAccountType
 *         - amount
 *       properties:
 *         fromAccountType:
 *           type: string
 *           enum: [main, strategy_provider, copy_follower]
 *           description: Source account type
 *         fromAccountId:
 *           type: integer
 *           description: Source account ID (not required for main account)
 *         toAccountType:
 *           type: string
 *           enum: [main, strategy_provider, copy_follower]
 *           description: Destination account type
 *         toAccountId:
 *           type: integer
 *           description: Destination account ID (not required for main account)
 *         amount:
 *           type: number
 *           minimum: 0.01
 *           description: Transfer amount
 *         notes:
 *           type: string
 *           description: Optional transfer notes
 *     
 *     TransferHistory:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         transaction_id:
 *           type: string
 *         amount:
 *           type: number
 *         balance_before:
 *           type: number
 *         balance_after:
 *           type: number
 *         status:
 *           type: string
 *         notes:
 *           type: string
 *         metadata:
 *           type: object
 *         created_at:
 *           type: string
 *           format: date-time
 *         transfer_direction:
 *           type: string
 *           enum: [incoming, outgoing]
 */

/**
 * @swagger
 * /api/internal-transfers/accounts:
 *   get:
 *     summary: Get all user accounts with balances
 *     tags: [Internal Transfers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User accounts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     mainAccount:
 *                       $ref: '#/components/schemas/Account'
 *                     strategyProviderAccounts:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Account'
 *                     copyFollowerAccounts:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Account'
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
router.get('/accounts', authenticateToken, InternalTransferController.getUserAccounts);

/**
 * @swagger
 * /api/internal-transfers/validate:
 *   post:
 *     summary: Validate transfer request
 *     tags: [Internal Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransferRequest'
 *     responses:
 *       200:
 *         description: Transfer validation successful
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
 *                     sourceAccount:
 *                       type: object
 *                     destinationAccount:
 *                       type: object
 *                     transferAmount:
 *                       type: number
 *                     availableBalance:
 *                       type: number
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
router.post('/validate', 
  authenticateToken,
  [
    body('fromAccountType')
      .isIn(['main', 'strategy_provider', 'copy_follower'])
      .withMessage('Invalid fromAccountType'),
    body('toAccountType')
      .isIn(['main', 'strategy_provider', 'copy_follower'])
      .withMessage('Invalid toAccountType'),
    body('amount')
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be greater than 0.01'),
    body('fromAccountId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('fromAccountId must be a positive integer'),
    body('toAccountId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('toAccountId must be a positive integer')
  ],
  handleValidationErrors,
  InternalTransferController.validateTransfer
);

/**
 * @swagger
 * /api/internal-transfers/execute:
 *   post:
 *     summary: Execute internal transfer
 *     tags: [Internal Transfers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransferRequest'
 *     responses:
 *       200:
 *         description: Transfer completed successfully
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
 *                     transactionId:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     sourceAccount:
 *                       type: object
 *                     destinationAccount:
 *                       type: object
 *       400:
 *         description: Transfer failed
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
router.post('/execute',
  authenticateToken,
  [
    body('fromAccountType')
      .isIn(['main', 'strategy_provider', 'copy_follower'])
      .withMessage('Invalid fromAccountType'),
    body('toAccountType')
      .isIn(['main', 'strategy_provider', 'copy_follower'])
      .withMessage('Invalid toAccountType'),
    body('amount')
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be greater than 0.01'),
    body('fromAccountId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('fromAccountId must be a positive integer'),
    body('toAccountId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('toAccountId must be a positive integer'),
    body('notes')
      .optional()
      .isLength({ max: 500 })
      .withMessage('Notes must be less than 500 characters')
  ],
  handleValidationErrors,
  InternalTransferController.executeTransfer
);

/**
 * @swagger
 * /api/internal-transfers/history:
 *   get:
 *     summary: Get transfer history
 *     tags: [Internal Transfers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of records per page
 *       - in: query
 *         name: accountType
 *         schema:
 *           type: string
 *           enum: [main, strategy_provider, copy_follower]
 *         description: Filter by account type
 *       - in: query
 *         name: accountId
 *         schema:
 *           type: integer
 *         description: Filter by account ID
 *     responses:
 *       200:
 *         description: Transfer history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     transfers:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TransferHistory'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         totalPages:
 *                           type: integer
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
router.get('/history',
  authenticateToken,
  [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('accountType')
      .optional()
      .isIn(['main', 'strategy_provider', 'copy_follower'])
      .withMessage('Invalid accountType'),
    query('accountId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('accountId must be a positive integer')
  ],
  handleValidationErrors,
  InternalTransferController.getTransferHistory
);

/**
 * @swagger
 * /api/internal-transfers/account/{accountType}/{accountId}/balance:
 *   get:
 *     summary: Get account balance and margin info
 *     tags: [Internal Transfers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: accountType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [main, strategy_provider, copy_follower]
 *         description: Account type
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema:
 *           type: string
 *         description: Account ID (use 'me' for main account)
 *     responses:
 *       200:
 *         description: Account balance retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Account'
 *                     - type: object
 *                       properties:
 *                         availableBalance:
 *                           type: number
 *                         marginInfo:
 *                           type: object
 *                           properties:
 *                             openOrdersCount:
 *                               type: integer
 *                             totalMarginRequired:
 *                               type: number
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Account not found
 *       500:
 *         description: Internal server error
 */
router.get('/account/:accountType/:accountId/balance',
  authenticateToken,
  [
    param('accountType')
      .isIn(['main', 'strategy_provider', 'copy_follower'])
      .withMessage('Invalid accountType'),
    param('accountId')
      .custom((value, { req }) => {
        if (req.params.accountType === 'main' && value !== 'me') {
          throw new Error('Use "me" as accountId for main account');
        }
        if (req.params.accountType !== 'main' && (isNaN(parseInt(value)) || parseInt(value) < 1)) {
          throw new Error('accountId must be a positive integer for non-main accounts');
        }
        return true;
      })
  ],
  handleValidationErrors,
  InternalTransferController.getAccountBalance
);

module.exports = router;
