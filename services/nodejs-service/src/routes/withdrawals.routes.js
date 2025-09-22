const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { createWithdrawalRequest, getMyWithdrawalRequests } = require('../controllers/withdrawals.controller');

/**
 * @swagger
 * /api/withdrawals:
 *   post:
 *     summary: Create a withdrawal request (Live users only)
 *     tags: [Withdrawals]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, method_type]
 *             properties:
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *                 example: USD
 *               method_type:
 *                 type: string
 *                 enum: [BANK, UPI, SWIFT, IBAN, PAYPAL, CRYPTO, OTHER]
 *               method_details:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Free-form JSON with fields like upi_id, bank_account_number, ifsc, iban, swift, paypal_email, crypto_address, etc.
 *     responses:
 *       201:
 *         description: Withdrawal request submitted successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized or inactive
 *       403:
 *         description: Only live users can request withdrawals
 */
router.post('/', authenticateJWT, createWithdrawalRequest);

/**
 * @swagger
 * /api/withdrawals/my-requests:
 *   get:
 *     summary: Get my withdrawal requests (Live users)
 *     tags: [Withdrawals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, rejected, on_hold]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of withdrawal requests
 */
router.get('/my-requests', authenticateJWT, getMyWithdrawalRequests);

module.exports = router;
