const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/admin.auth.controller');
const { authenticateAdmin } = require('../middlewares/auth.middleware');

/**
 * @swagger
 * /api/admin/auth/login:
 *   post:
 *     summary: Admin login (request OTP)
 *     tags: [Admin Authentication]
 *     description: Login as admin using email and password. Sends OTP to admin's email if credentials are valid.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: OTP sent to admin email
 *       400:
 *         description: Invalid credentials or input
 */
router.post('/login', adminAuthController.login);

/**
 * @swagger
 * /api/admin/auth/verify-otp:
 *   post:
 *     summary: Verify admin OTP and issue JWTs
 *     tags: [Admin Authentication]
 *     description: Verify OTP sent to admin's email and return access and refresh tokens.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp]
 *             properties:
 *               adminId:
 *                 type: integer
 *               otp:
 *                 type: string
 *                 length: 6
 *     responses:
 *       200:
 *         description: OTP verified, tokens issued
 *       400:
 *         description: Invalid OTP or input
 */
router.post('/verify-otp', adminAuthController.verifyOtp);

/**
 * @swagger
 * /api/admin/auth/refresh-token:
 *   post:
 *     summary: Refresh admin JWT
 *     tags: [Admin Authentication]
 *     description: Get a new access token using a valid refresh token.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New access token issued
 *       400:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh-token', adminAuthController.refreshToken);

/**
 * @swagger
 * /api/admin/auth/logout:
 *   post:
 *     summary: Logout admin (revoke token)
 *     tags: [Admin Authentication]
 *     security:
 *       - bearerAuth: []
 *     description: Logout admin and revoke current JWT. Requires authentication.
 *     responses:
 *       200:
 *         description: Logout successful
 *       401:
 *         description: Unauthorized
 */
router.post('/logout', authenticateAdmin, adminAuthController.logout);

module.exports = router;
