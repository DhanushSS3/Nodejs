const express = require('express');
const { body } = require('express-validator');
const { requestEmailOTP, verifyEmailOTP } = require('../controllers/auth.controller');
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

module.exports = router;
