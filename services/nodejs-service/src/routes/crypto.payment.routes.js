const express = require('express');
const cryptoPaymentController = require('../controllers/crypto.payment.controller');
const rawBodyMiddleware = require('../middlewares/rawBody.middleware');
const { authenticateJWT } = require('../middlewares/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     CryptoDepositRequest:
 *       type: object
 *       required:
 *         - baseAmount
 *         - baseCurrency
 *         - settledCurrency
 *         - networkSymbol
 *       properties:
 *         baseAmount:
 *           type: string
 *           description: Amount to be deposited
 *           example: "100"
 *         baseCurrency:
 *           type: string
 *           description: Base currency code
 *           example: "USDT"
 *         settledCurrency:
 *           type: string
 *           description: Settlement currency code
 *           example: "USDT"
 *         networkSymbol:
 *           type: string
 *           description: Blockchain network symbol
 *           example: "BSC"
 *         user_id:
 *           type: string
 *           description: Live user ID (optional if authenticated)
 *           example: "4"
 *         customerName:
 *           type: string
 *           description: Optional customer name
 *           example: "John Doe"
 *         comments:
 *           type: string
 *           description: Optional comments
 *           example: "Deposit for trading"
 *     
 *     CryptoDepositResponse:
 *       type: object
 *       properties:
 *         status:
 *           type: boolean
 *           example: true
 *         message:
 *           type: string
 *           example: "PaymentUrl Generated Successfully"
 *         data:
 *           type: object
 *           properties:
 *             paymentUrl:
 *               type: string
 *               example: "https://pay.tylt.money/..."
 *             merchantOrderId:
 *               type: string
 *               example: "livefx_a1b2c3d4e5f6..."
 *             orderId:
 *               type: string
 *               example: "d0d6ff5f-79b6-11ef-8277-02d8461243e9"
 *             depositAddress:
 *               type: string
 *               example: "0xbfae84b277c5b791206a58f634b88527287bf2f8"
 *             expiresAt:
 *               type: string
 *               format: date-time
 *               example: "2024-09-23T15:19:16Z"
 *     
 *     CryptoPayment:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         userId:
 *           type: integer
 *           example: 4
 *         merchantOrderId:
 *           type: string
 *           example: "livefx_a1b2c3d4e5f6..."
 *         orderId:
 *           type: string
 *           example: "d0d6ff5f-79b6-11ef-8277-02d8461243e9"
 *         baseAmount:
 *           type: string
 *           example: "100.00000000"
 *         baseCurrency:
 *           type: string
 *           example: "USDT"
 *         settledCurrency:
 *           type: string
 *           example: "USDT"
 *         networkSymbol:
 *           type: string
 *           example: "BSC"
 *         status:
 *           type: string
 *           enum: [PENDING, PROCESSING, COMPLETED, UNDERPAYMENT, OVERPAYMENT, FAILED, CANCELLED]
 *           example: "PENDING"
 *         baseAmountReceived:
 *           type: string
 *           nullable: true
 *           example: "99.50000000"
 *         commission:
 *           type: string
 *           nullable: true
 *           example: "0.50000000"
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /api/crypto-payments/deposit:
 *   post:
 *     tags:
 *       - Crypto Payments
 *     summary: Create a new crypto payment deposit request
 *     description: Creates a payment request with Tylt gateway and returns payment URL for authenticated live users only
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CryptoDepositRequest'
 *     responses:
 *       200:
 *         description: Payment URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CryptoDepositResponse'
 *       400:
 *         description: Bad request - missing or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Missing required fields"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Failed to create deposit request"
 */
router.post('/deposit', authenticateJWT, cryptoPaymentController.createDeposit);

/**
 * @swagger
 * /api/crypto-payments/{merchantOrderId}:
 *   get:
 *     tags:
 *       - Crypto Payments
 *     summary: Get payment details by merchant order ID
 *     description: Retrieve crypto payment details using the merchant order ID
 *     parameters:
 *       - in: path
 *         name: merchantOrderId
 *         required: true
 *         schema:
 *           type: string
 *           description: "Merchant order ID (format: livefx_{uuid4})"
 *           example: "livefx_a1b2c3d4e5f6..."
 *     responses:
 *       200:
 *         description: Payment details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Payment retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/CryptoPayment'
 *       404:
 *         description: Payment not found
 *       500:
 *         description: Internal server error
 */
router.get('/:merchantOrderId', cryptoPaymentController.getPaymentByOrderId);

/**
 * @swagger
 * /api/crypto-payments/user/{userId}:
 *   get:
 *     tags:
 *       - Crypto Payments
 *     summary: Get payments by user ID
 *     description: Retrieve all crypto payments for a specific live user
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *           description: Live user ID
 *           example: 4
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           description: Number of records to skip
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, PROCESSING, COMPLETED, UNDERPAYMENT, OVERPAYMENT, FAILED, CANCELLED]
 *           description: Filter by payment status
 *     responses:
 *       200:
 *         description: Payments retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Payments retrieved successfully"
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CryptoPayment'
 *                 count:
 *                   type: integer
 *                   example: 5
 *       400:
 *         description: Invalid user ID
 *       500:
 *         description: Internal server error
 */
router.get('/user/:userId', cryptoPaymentController.getPaymentsByUserId);

/**
 * @swagger
 * /api/crypto-payments/webhook:
 *   post:
 *     tags:
 *       - Crypto Payments
 *     summary: Handle webhook from Tylt payment gateway
 *     description: Webhook endpoint for receiving payment status updates from Tylt. Validates HMAC signature and processes payment updates including wallet crediting for live users.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               data:
 *                 type: object
 *                 properties:
 *                   orderId:
 *                     type: string
 *                     example: "d0d6ff5f-79b6-11ef-8277-02d8461243e9"
 *                   merchantOrderId:
 *                     type: string
 *                     example: "livefx_a1b2c3d4e5f6..."
 *                   baseAmount:
 *                     type: number
 *                     example: 100
 *                   baseCurrency:
 *                     type: string
 *                     example: "USDT"
 *                   baseAmountReceived:
 *                     type: number
 *                     example: 99.5
 *                   status:
 *                     type: string
 *                     example: "Completed"
 *                   network:
 *                     type: string
 *                     example: "BSC"
 *                   commission:
 *                     type: number
 *                     example: 0.5
 *               type:
 *                 type: string
 *                 example: "pay-in"
 *     parameters:
 *       - in: header
 *         name: X-TLP-SIGNATURE
 *         required: true
 *         schema:
 *           type: string
 *           description: HMAC SHA-256 signature for webhook validation
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: "ok"
 *       400:
 *         description: Invalid signature or missing data
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: "Invalid HMAC signature"
 *       500:
 *         description: Internal server error
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: "Failed to process webhook"
 */
router.post('/webhook', rawBodyMiddleware, cryptoPaymentController.handleWebhook);

module.exports = router;
