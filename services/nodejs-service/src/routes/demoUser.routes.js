const express = require('express');
const { signup, login, refreshToken, logout, getUserInfo } = require('../controllers/demoUser.controller');

const { body, query } = require('express-validator');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');
const upload = require('../middlewares/upload.middleware');
const FinancialSummaryController = require('../controllers/financial.summary.controller');

const router = express.Router();

/**
 * @swagger
 * /api/demo-users/signup:
 *   post:
 *     summary: Register a new demo user
 *     tags: [Demo Users]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/DemoUserSignup'
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Email or phone number already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/signup',
  upload.fields([
    { name: 'address_proof_image', maxCount: 1 },
    { name: 'id_proof_image', maxCount: 1 }
  ]),
  [
    body('name').notEmpty(),
    body('phone_number').notEmpty(),
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
    body('city').notEmpty(),
    body('state').notEmpty(),
    body('country').notEmpty(),
    body('pincode').notEmpty(),
    body('security_question').optional(),
    body('security_answer').optional(),

    body('is_active').notEmpty().isInt({ min: 0, max: 1 }).withMessage('is_active must be 0 or 1'),
    body('address_proof_image').optional(),
    body('id_proof_image').optional(),
  ],
  signup
);

/**
 * @swagger
 * /api/demo-users/login:
 *   post:
 *     summary: Login a demo user
 *     tags: [Demo Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many login attempts
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login',
  [
    body('email').isEmail(),
    body('password').notEmpty(),
  ],
  login
);

/**
 * @swagger
 * /api/demo-users/refresh-token:
 *   post:
 *     summary: Refresh an access token for a demo user
 *     tags: [Demo Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refresh_token
 *             properties:
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Invalid or expired refresh token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/refresh-token', refreshToken);

/**
 * @swagger
 * /api/demo-users/logout:
 *   post:
 *     summary: Logout a demo user
 *     tags: [Demo Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refresh_token
 *             properties:
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/logout', authenticateJWT, logout);

/**
 * @swagger
 * /api/demo-users/me:
 *   get:
 *     summary: Get authenticated demo user information
 *     tags: [Demo Users]
 *     security:
 *       - bearerAuth: []
 *     description: Retrieve current user's profile information using JWT authentication
 *     responses:
 *       200:
 *         description: User information retrieved successfully
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
 *                   example: "User information retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         email:
 *                           type: string
 *                         phone_number:
 *                           type: string
 *                         user_type:
 *                           type: string
 *                         wallet_balance:
 *                           type: number
 *                         leverage:
 *                           type: integer
 *                         margin:
 *                           type: number
 *                         net_profit:
 *                           type: number
 *                         account_number:
 *                           type: string
 *                         group:
 *                           type: string
 *                         city:
 *                           type: string
 *                         state:
 *                           type: string
 *                         pincode:
 *                           type: string
 *                         country:
 *                           type: string
 *                         created_at:
 *                           type: string
 *                           format: date-time
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.get('/me', authenticateJWT, getUserInfo);

/**
 * @swagger
 * /api/demo-users/financial-summary:
 *   get:
 *     summary: Get financial summary for authenticated demo user
 *     tags: [Demo Users]
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
 *                   type: object
 *                   properties:
 *                     user_id:
 *                       type: integer
 *                     user_type:
 *                       type: string
 *                       example: "demo"
 *                     balance:
 *                       type: number
 *                       format: float
 *                       description: Current wallet balance
 *                     total_margin:
 *                       type: number
 *                       format: float
 *                       description: Total margin currently used
 *                     period:
 *                       type: object
 *                       properties:
 *                         start_date:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         end_date:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         is_filtered:
 *                           type: boolean
 *                     trading:
 *                       type: object
 *                       properties:
 *                         net_profit:
 *                           type: number
 *                           format: float
 *                         commission:
 *                           type: number
 *                           format: float
 *                         swap:
 *                           type: number
 *                           format: float
 *                         total_orders:
 *                           type: integer
 *                     transactions:
 *                       type: object
 *                       properties:
 *                         total_deposits:
 *                           type: number
 *                           format: float
 *                         deposit_count:
 *                           type: integer
 *                     overall:
 *                       type: object
 *                       properties:
 *                         user_net_profit:
 *                           type: number
 *                           format: float
 *       400:
 *         description: Bad request - Invalid parameters
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: Demo user not found
 *       500:
 *         description: Internal server error
 */
router.get('/financial-summary',
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

module.exports = router; 