'use strict';

const express = require('express');
const pay2payController = require('../controllers/pay2pay.payment.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

const router = express.Router();

// ── POST /deposit ────────────────────────────────────────────────────────────
// Create a redirect deposit. Returns paymentUrl to redirect user to Pay2Pay.
// Vietnam users only — restriction is enforced inside the controller.
router.post('/deposit', authenticateJWT, pay2payController.createDeposit.bind(pay2payController));

// ── POST /ipn ────────────────────────────────────────────────────────────────
// Pay2Pay Instant Payment Notification (server-to-server callback).
// Must NOT require JWT. Always returns HTTP 200.
router.post('/ipn', pay2payController.handleIPN.bind(pay2payController));

// ── GET /return ──────────────────────────────────────────────────────────────
// User is redirected back here after completing/cancelling payment on Pay2Pay.
// No auth required — Pay2Pay sends the user directly.
router.get('/return', pay2payController.handleReturn.bind(pay2payController));

// ── GET /methods ─────────────────────────────────────────────────────────────
// Returns Pay2Pay payment info, live FX rate, fee structure, limits.
router.get('/methods', pay2payController.getMethods.bind(pay2payController));

// ── GET /:merchantReferenceId ─────────────────────────────────────────────────
// Look up a payment by merchant reference ID (auth required).
router.get('/:merchantReferenceId', authenticateJWT, pay2payController.getPayment.bind(pay2payController));

module.exports = router;
