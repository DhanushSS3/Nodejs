const express = require('express');
const router = express.Router();
const adminTransactionController = require('../controllers/admin.transaction.controller');
const { authenticateAdmin, requirePermissions } = require('../middlewares/auth.middleware');
const { applyScope } = require('../middlewares/scope.middleware');
const { auditLog } = require('../middlewares/audit.middleware');

// Apply authentication and scoping to all routes
router.use(authenticateAdmin);
router.use(applyScope);

/**
 * @swagger
 * components:
 *   schemas:
 *     TransactionRecord:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Transaction database ID
 *         transaction_id:
 *           type: string
 *           description: Unique transaction identifier
 *         user_email:
 *           type: string
 *           description: User email at time of transaction
 *         amount:
 *           type: number
 *           description: Transaction amount (positive for deposits, negative for withdrawals)
 *         balance_before:
 *           type: number
 *           description: User balance before transaction
 *         balance_after:
 *           type: number
 *           description: User balance after transaction
 *         method_type:
 *           type: string
 *           enum: [BANK, UPI, SWIFT, IBAN, PAYPAL, CRYPTO, OTHER]
 *           description: Payment method used
 *         notes:
 *           type: string
 *           description: Transaction notes
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Transaction creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Transaction last update timestamp
 *         user_name:
 *           type: string
 *           description: User name
 *         user_account_number:
 *           type: string
 *           description: User account number
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
 *             transactions:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TransactionRecord'
 *             pagination:
 *               type: object
 *               properties:
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 total:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 hasNextPage:
 *                   type: boolean
 *                 hasPreviousPage:
 *                   type: boolean
 *             summary:
 *               type: object
 *               properties:
 *                 total_sum_all_records:
 *                   type: number
 *                   description: Sum of ALL deposits/withdrawals (no filters, only type)
 *                 total_count_all_records:
 *                   type: integer
 *                   description: Count of ALL deposits/withdrawals (no filters, only type)
 *                 filtered_sum:
 *                   type: number
 *                   description: Sum of transactions matching applied filters
 *                 filtered_count:
 *                   type: integer
 *                   description: Count of transactions matching applied filters
 *                 page_sum:
 *                   type: number
 *                   description: Sum of transactions on current page only
 *                 page_count:
 *                   type: integer
 *                   description: Count of transactions on current page only
 *     
 *     TransactionStats:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *           properties:
 *             deposits:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   method_type:
 *                     type: string
 *                   count:
 *                     type: integer
 *                   total_amount:
 *                     type: number
 *             withdrawals:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   method_type:
 *                     type: string
 *                   count:
 *                     type: integer
 *                   total_amount:
 *                     type: number
 */

/**
 * @swagger
 * /api/admin/transactions/deposits:
 *   get:
 *     summary: Get filtered deposit transactions with pagination and total sum
 *     tags: [Admin Transactions]
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       **Access Control:**
 *       - Superadmin: Can view all transactions
 *       - Country-level admin: Can only view transactions from users in their assigned country
 *       
 *       **Filtering Options:**
 *       1. **All deposits**: No filters - returns all deposit transactions
 *       2. **By method_type**: Filter by payment method (BANK, UPI, CRYPTO, etc.)
 *       3. **By email**: Filter by user email (supports partial matching)
 *       4. **By date range**: Filter by transaction date (start_date and/or end_date)
 *       5. **Combined**: Use multiple filters together
 *       
 *       **Response includes:**
 *       - Paginated transaction records
 *       - Total sum of ALL deposits (irrespective of filters and pagination)
 *       - Filtered sum (matching applied filters)
 *       - Pagination metadata
 *     parameters:
       - in: query
         name: email
         schema:
           type: string
         description: Filter by user email (supports partial matching)
         example: "john@example.com"
       - in: query
         name: method_type
         schema:
           type: string
           enum: [BANK, UPI, SWIFT, IBAN, PAYPAL, CRYPTO, OTHER]
         description: Filter by payment method type
         example: "BANK"
       - in: query
         name: start_date
         schema:
           type: string
           format: date-time
         description: Filter transactions from this date (ISO 8601 format)
         example: "2024-01-01"
       - in: query
         name: end_date
         schema:
           type: string
           format: date-time
         description: Filter transactions until this date (ISO 8601 format)
         example: "2024-12-31"
       - in: query
         name: page
         schema:
           type: integer
           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of records per page (max 100)
 *     responses:
 *       200:
 *         description: Deposit transactions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransactionResponse'
 *             example:
 *               success: true
 *               message: "Deposit transactions retrieved successfully"
 *               data:
 *                 transactions:
 *                   - id: 1
 *                     transaction_id: "TXN1234567890123456"
 *                     user_email: "john@example.com"
 *                     amount: 1000.50
 *                     balance_before: 500.00
 *                     balance_after: 1500.50
 *                     method_type: "BANK"
 *                     notes: "Initial deposit"
 *                     created_at: "2024-01-15T10:30:00Z"
 *                     user_name: "John Doe"
 *                     user_account_number: "ACC123456"
 *                 pagination:
 *                   page: 1
 *                   limit: 20
 *                   total: 150
 *                   totalPages: 8
 *                   hasNextPage: true
 *                   hasPreviousPage: false
 *                 summary:
 *                   total_sum_all_records: 250000.00
 *                   total_count_all_records: 500
 *                   filtered_sum: 75000.00
 *                   filtered_count: 150
 *                   page_sum: 20000.00
 *                   page_count: 20
 *       400:
 *         description: Invalid parameters
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
 *                   example: "Invalid method_type. Must be one of: BANK, UPI, SWIFT, IBAN, PAYPAL, CRYPTO, OTHER"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Internal server error
 */
router.get('/deposits', 
  requirePermissions(['transaction:read']), 
  auditLog('GET_ADMIN_DEPOSITS'), 
  adminTransactionController.getDeposits
);

/**
 * @swagger
 * /api/admin/transactions/withdrawals:
 *   get:
 *     summary: Get filtered withdrawal transactions with pagination and total sum
 *     tags: [Admin Transactions]
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Retrieve withdrawal transactions with advanced filtering options.
 *       
 *       **Access Control:**
 *       - Superadmin: Can view all transactions
 *       - Country-level admin: Can only view transactions from users in their assigned country
 *       
 *       **Filtering Options:**
 *       1. **All withdrawals**: No filters - returns all withdrawal transactions
 *       2. **By method_type**: Filter by payment method (BANK, UPI, CRYPTO, etc.)
 *       3. **By email**: Filter by user email (supports partial matching)
 *       4. **By date range**: Filter by transaction date (start_date and/or end_date)
 *       5. **Combined**: Use multiple filters together
 *       
 *       **Response includes:**
 *       - Paginated transaction records
 *       - Total sum of ALL withdrawals (irrespective of filters and pagination)
 *       - Filtered sum (matching applied filters)
 *       - Pagination metadata
 *     parameters:
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *         description: Filter by user email (supports partial matching)
 *         example: "jane@example.com"
 *       - in: query
 *         name: method_type
 *         schema:
 *           type: string
 *           enum: [BANK, UPI, SWIFT, IBAN, PAYPAL, CRYPTO, OTHER]
 *         description: Filter by payment method type
 *         example: "UPI"
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter transactions from this date (ISO 8601 format)
 *         example: "2024-01-01"
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter transactions until this date (ISO 8601 format)
 *         example: "2024-12-31"
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of records per page (max 100)
 *     responses:
 *       200:
 *         description: Withdrawal transactions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransactionResponse'
 *             example:
 *               success: true
 *               message: "Withdrawal transactions retrieved successfully"
 *               data:
 *                 transactions:
 *                   - id: 2
 *                     transaction_id: "TXN9876543210987654"
 *                     user_email: "jane@example.com"
 *                     amount: -500.00
 *                     balance_before: 1500.50
 *                     balance_after: 1000.50
 *                     method_type: "UPI"
 *                     notes: "Withdrawal request approved"
 *                     created_at: "2024-01-15T14:30:00Z"
 *                     user_name: "Jane Smith"
 *                     user_account_number: "ACC789012"
 *                 pagination:
 *                   page: 1
 *                   limit: 20
 *                   total: 85
 *                   totalPages: 5
 *                   hasNextPage: true
 *                   hasPreviousPage: false
 *                 summary:
 *                   total_sum_all_records: 150000.00
 *                   total_count_all_records: 300
 *                   filtered_sum: 42500.00
 *                   filtered_count: 85
 *                   page_sum: 10000.00
 *                   page_count: 20
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Internal server error
 */
router.get('/withdrawals', 
  requirePermissions(['transaction:read']), 
  auditLog('GET_ADMIN_WITHDRAWALS'), 
  adminTransactionController.getWithdrawals
);

/**
 * @swagger
 * /api/admin/transactions/stats:
 *   get:
 *     summary: Get transaction statistics summary by method type
 *     tags: [Admin Transactions]
 *     security:
 *       - bearerAuth: []
 *     description: |
 *       Get aggregated statistics for deposits and withdrawals grouped by payment method.
 *       
 *       **Access Control:**
 *       - Superadmin: Statistics for all transactions
 *       - Country-level admin: Statistics for transactions from users in their assigned country only
 *       
 *       **Returns:**
 *       - Count and total amount for each payment method
 *       - Separate statistics for deposits and withdrawals
 *     responses:
 *       200:
 *         description: Transaction statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransactionStats'
 *             example:
 *               success: true
 *               message: "Transaction statistics retrieved successfully"
 *               data:
 *                 deposits:
 *                   - method_type: "BANK"
 *                     count: 120
 *                     total_amount: 50000.00
 *                   - method_type: "UPI"
 *                     count: 85
 *                     total_amount: 25000.00
 *                   - method_type: "CRYPTO"
 *                     count: 15
 *                     total_amount: 10000.00
 *                 withdrawals:
 *                   - method_type: "BANK"
 *                     count: 75
 *                     total_amount: 30000.00
 *                   - method_type: "UPI"
 *                     count: 45
 *                     total_amount: 12500.00
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Internal server error
 */
router.get('/stats', 
  requirePermissions(['transaction:stats']), 
  auditLog('GET_ADMIN_TRANSACTION_STATS'), 
  adminTransactionController.getTransactionStats
);

/**
 * @swagger
 * /api/admin/transactions/method-types:
 *   get:
 *     summary: Get available payment method types for filtering
 *     tags: [Admin Transactions]
 *     security:
 *       - bearerAuth: []
 *     description: Get list of available payment method types that can be used for filtering transactions
 *     responses:
 *       200:
 *         description: Method types retrieved successfully
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
 *                   example: "Method types retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     method_types:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["BANK", "UPI", "SWIFT", "IBAN", "PAYPAL", "CRYPTO", "OTHER"]
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Internal server error
 */
router.get('/method-types', 
  requirePermissions(['transaction:read']), 
  adminTransactionController.getMethodTypes
);

module.exports = router;
