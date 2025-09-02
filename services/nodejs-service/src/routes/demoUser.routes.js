const express = require('express');
const { signup, login, refreshToken, logout, getUserInfo } = require('../controllers/demoUser.controller');
const { body } = require('express-validator');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const upload = require('../middlewares/upload.middleware');

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
    body('security_question').notEmpty(),
    body('security_answer').notEmpty(),
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

module.exports = router; 