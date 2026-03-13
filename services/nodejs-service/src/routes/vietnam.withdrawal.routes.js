'use strict';

const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { createVietnamBankWithdrawal } = require('../controllers/vietnam.withdrawal.controller');

/**
 * @swagger
 * /api/withdrawals/vietnam-bank:
 *   post:
 *     summary: Submit a Vietnam bank withdrawal request (Pay2Pay Transfer 24/7)
 *     description: |
 *       For Vietnam live users only. Collects Pay2Pay bank transfer details.
 *       Admin must approve — withdrawal is then auto-dispatched to Pay2Pay.
 *     tags: [Withdrawals]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, amountVnd, bankId, bankRefNumber, bankRefName, bankCode]
 *             properties:
 *               amount:
 *                 type: number
 *                 description: Amount to withdraw in USD
 *                 example: 50.00
 *               amountVnd:
 *                 type: integer
 *                 description: Equivalent VND amount to send via Pay2Pay (user sees & confirms this)
 *                 example: 1265000
 *               bankId:
 *                 type: string
 *                 description: Pay2Pay bank ID (from GET /api/pay2pay-payout/banks)
 *                 example: "970436"
 *               bankRefNumber:
 *                 type: string
 *                 description: Recipient bank account number
 *                 example: "123456789012"
 *               bankRefName:
 *                 type: string
 *                 description: Recipient account holder full name (as on bank account)
 *                 example: "NGUYEN VAN AN"
 *               bankCode:
 *                 type: string
 *                 description: Bank code (from GET /api/pay2pay-payout/banks)
 *                 example: "970436"
 *               binCode:
 *                 type: string
 *                 description: Optional BIN code (from /banks → binCode field). Defaults to bankCode.
 *                 example: "970436"
 *               currency:
 *                 type: string
 *                 default: USD
 *     responses:
 *       201:
 *         description: Withdrawal request submitted, pending admin approval
 *       400:
 *         description: Validation error or insufficient balance
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a live user
 */
router.post('/vietnam-bank', authenticateJWT, createVietnamBankWithdrawal);

module.exports = router;
