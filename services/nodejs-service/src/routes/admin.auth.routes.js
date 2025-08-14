const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/admin.auth.controller');
const { authenticateAdmin } = require('../middlewares/auth.middleware');

// @route   POST /api/admin/auth/login
// @desc    Login admin and send OTP
router.post('/login', adminAuthController.login);

// @route   POST /api/admin/auth/verify-otp
// @desc    Verify OTP and return JWTs
router.post('/verify-otp', adminAuthController.verifyOtp);

// @route   POST /api/admin/auth/refresh-token
// @desc    Get a new access token using a refresh token
router.post('/refresh-token', adminAuthController.refreshToken);

// @route   POST /api/admin/auth/logout
// @desc    Logout admin (revoke token)
router.post('/logout', authenticateAdmin, adminAuthController.logout);

module.exports = router;
