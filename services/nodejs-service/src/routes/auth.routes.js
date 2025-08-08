const express = require('express');
const { body } = require('express-validator');
const { 
  requestEmailOTP, 
  verifyEmailOTP,
  requestPasswordReset,
  verifyPasswordResetOTP,
  resetPassword
} = require('../controllers/auth.controller');
const { handleValidationErrors } = require('../middlewares/error.middleware');

const router = express.Router();

/**
 * @swagger
 * /api/auth/request-email-otp:
 *   post:
 *     summary: Request an OTP for email verification
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - userType
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               userType:
 *                 type: string
 *                 enum: [live, demo]
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       400:
 *         description: Invalid input
 *       429:
 *         description: Too many requests
 */
router.post(
  '/request-email-otp',
  [
    body('email').isEmail().withMessage('A valid email is required.'),
    body('userType').isIn(['live', 'demo']).withMessage('userType must be either \'live\' or \'demo\'.')
  ],
  handleValidationErrors,
  requestEmailOTP
);

/**
 * @swagger
 * /api/auth/verify-email-otp:
 *   post:
 *     summary: Verify an email OTP
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *               - userType
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *                 length: 6
 *               userType:
 *                 type: string
 *                 enum: [live, demo]
 *     responses:
 *       200:
 *         description: Email verified successfully
 *       400:
 *         description: Invalid OTP or input
 */
router.post(
  '/verify-email-otp',
  [
    body('email').isEmail().withMessage('A valid email is required.'),
    body('otp').isString().isLength({ min: 6, max: 6 }).withMessage('OTP must be a 6-digit string.'),
    body('userType').isIn(['live', 'demo']).withMessage('userType must be either \'live\' or \'demo\'.')
  ],
  handleValidationErrors,
  verifyEmailOTP
);

// --- Password Reset Routes ---

/**
 * @swagger
 * /api/auth/request-password-reset:
 *   post:
 *     summary: Request a password reset OTP
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, userType]
 *             properties:
 *               email: { type: string, format: email }
 *               userType: { type: string, enum: [live, demo] }
 *     responses:
 *       200:
 *         description: If an account exists, an OTP has been sent.
 *       429:
 *         description: Too many requests.
 */
router.post(
  '/request-password-reset',
  [
    body('email').isEmail().withMessage('A valid email is required.'),
    body('userType').isIn(['live', 'demo']).withMessage('userType must be either \'live\' or \'demo\'.')
  ],
  handleValidationErrors,
  requestPasswordReset
);

/**
 * @swagger
 * /api/auth/verify-reset-otp:
 *   post:
 *     summary: Verify a password reset OTP
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, userType, otp]
 *             properties:
 *               email: { type: string, format: email }
 *               userType: { type: string, enum: [live, demo] }
 *               otp: { type: string, length: 6 }
 *     responses:
 *       200:
 *         description: OTP verified successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 resetToken: { type: string }
 *       400:
 *         description: Invalid or expired OTP.
 */
router.post(
  '/verify-reset-otp',
  [
    body('email').isEmail().withMessage('A valid email is required.'),
    body('userType').isIn(['live', 'demo']).withMessage('userType must be either \'live\' or \'demo\'.'),
    body('otp').isString().isLength({ min: 6, max: 6 }).withMessage('OTP must be a 6-digit string.')
  ],
  handleValidationErrors,
  verifyPasswordResetOTP
);

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Reset user password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, userType, resetToken, newPassword]
 *             properties:
 *               email: { type: string, format: email }
 *               userType: { type: string, enum: [live, demo] }
 *               resetToken: { type: string }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200:
 *         description: Password has been reset successfully.
 *       400:
 *         description: Invalid or expired reset token.
 */
router.post(
  '/reset-password',
  [
    body('email').isEmail().withMessage('A valid email is required.'),
    body('userType').isIn(['live', 'demo']).withMessage('userType must be either \'live\' or \'demo\'.'),
    body('resetToken').isString().notEmpty().withMessage('Reset token is required.'),
    body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters long.')
  ],
  handleValidationErrors,
  resetPassword
);

module.exports = router;
