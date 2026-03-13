'use strict';

const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/pay2pay.payout.controller');
const { authenticateJWT, authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');

// ── POST /api/pay2pay-payout/ipn ──────────────────────────────────────────────
// Pay2Pay payout webhook (server-to-server). No auth required.
// rawBody must be captured for signature verification.
router.post('/ipn', payoutController.handlePayoutIPN);

// ── GET /api/pay2pay-payout/banks ─────────────────────────────────────────────
// Bank list for Vietnam users to choose from in the withdrawal form.
// Requires user JWT — Vietnam live users call this from the UI.
router.get('/banks', authenticateJWT, payoutController.getBankList);

module.exports = router;
