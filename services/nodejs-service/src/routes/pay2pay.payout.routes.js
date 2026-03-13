'use strict';

const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/pay2pay.payout.controller');
const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');

// ── POST /api/pay2pay-payout/ipn ──────────────────────────────────────────────
// Pay2Pay payout webhook (server-to-server). No auth required.
// rawBody must be captured for signature verification.
router.post('/ipn', payoutController.handlePayoutIPN);

// ── GET /api/pay2pay-payout/banks ─────────────────────────────────────────────
// Cached list of Pay2Pay supported banks. Admin-authenticated.
router.get('/banks', authenticateAdmin, requireRole(['superadmin', 'admin']), payoutController.getBankList);

module.exports = router;
