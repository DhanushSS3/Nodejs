'use strict';

/**
 * Vietnam Bank Withdrawal Controller
 *
 * POST /api/withdrawals/vietnam-bank
 *
 * Full flow:
 *  1. Authenticate user JWT → get user_id, account_type
 *  2. Accept USD withdrawal amount (user picks gross amount)
 *  3. Auto-convert USD → VND using PAY2PAY_VND_TO_USD_FALLBACK_RATE
 *  4. Calculate fee breakdown (matching collection pattern):
 *       totalFeeVnd    = grossVnd × feePercent
 *       merchantFeeVnd = totalFeeVnd × merchantShare%
 *       clientFeeVnd   = totalFeeVnd - merchantFeeVnd
 *       netAmountVnd   = grossVnd - clientFeeVnd  (what recipient gets)
 *  5. Validate free margin (ensures open positions are not at risk)
 *  6. Create MoneyRequest with all fee + conversion fields in method_details
 *  7. Send admin email notification (ADMIN_NOTIFICATION_EMAIL or EMAIL_USER)
 */

const moneyRequestService = require('../services/moneyRequest.service');
const fxService = require('../services/pay2pay.fx.service');
const { payoutFeeBreakdown } = require('../services/pay2pay.payout.service');
const InternalTransferService = require('../services/internalTransfer.service');
const { LiveUser } = require('../models');
const logger = require('../services/logger.service');
const payoutLogger = require('../services/logging/Pay2PayPayoutLogger');

// ─── Auth Context ─────────────────────────────────────────────────────────────

function getAuthContext(req) {
  const user = req.user || {};
  const rawUserId = user.sub || user.user_id || user.id;
  return {
    authUserId: rawUserId ? parseInt(rawUserId, 10) : null,
    authAccountType: (user.account_type || user.user_type || 'live').toLowerCase(),
    isActive: user.is_active === undefined ? true : !!user.is_active,
  };
}

// ─── Admin Notification Email ─────────────────────────────────────────────────

async function sendAdminWithdrawalNotification(withdrawalRequest, user, bankDetails, feeInfo) {
  // Use dedicated admin notification address, fall back to the sender address
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.EMAIL_USER;
  if (!adminEmail) {
    logger.warn('Vietnam withdrawal: ADMIN_NOTIFICATION_EMAIL and EMAIL_USER not set, skipping admin notification');
    return;
  }

  const { bankRefName, bankRefNumber, bankId, bankCode, binCode } = bankDetails;
  const {
    grossAmountVnd, netAmountVnd, totalFeeVnd, clientFeeVnd,
    merchantFeeVnd, feePercent, rate, amountUsd,
  } = feeInfo;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; padding: 20px;">

  <div style="background: linear-gradient(135deg, #1a237e, #283593); padding: 24px; border-radius: 10px 10px 0 0; text-align: center;">
    <h2 style="color: #fff; margin: 0; font-size: 20px;">⚡ New Vietnam Bank Withdrawal Request</h2>
    <p style="color: #c5cae9; margin: 8px 0 0; font-size: 14px;">Action Required — Pending Admin Approval</p>
  </div>

  <div style="background: #f9f9f9; padding: 24px; border: 1px solid #e0e0e0; border-top: none;">

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr style="background:#e8eaf6"><td colspan="2" style="padding:10px 14px;font-weight:bold;color:#283593;font-size:14px">📋 Request Details</td></tr>
      <tr><td style="padding:8px 14px;color:#666;width:45%;border-bottom:1px solid #eee">Request ID</td><td style="padding:8px 14px;font-weight:bold;border-bottom:1px solid #eee">${withdrawalRequest.request_id}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">User ID</td><td style="padding:8px 14px;border-bottom:1px solid #eee">#${user.id}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">User Name</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${user.name || 'N/A'}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">User Email</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${user.email || 'N/A'}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Trading Account</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${withdrawalRequest.account_number || 'N/A'}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Submitted At</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${new Date().toUTCString()}</td></tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr style="background:#e8eaf6"><td colspan="2" style="padding:10px 14px;font-weight:bold;color:#283593;font-size:14px">💰 Payout Amounts & Fees</td></tr>
      <tr><td style="padding:8px 14px;color:#666;width:45%;border-bottom:1px solid #eee">Withdrawal (USD)</td><td style="padding:8px 14px;font-weight:bold;color:#c62828;border-bottom:1px solid #eee">$${Number(amountUsd).toFixed(2)} USD</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Rate Used</td><td style="padding:8px 14px;border-bottom:1px solid #eee">1 USD = ${Math.round(1 / rate).toLocaleString()} VND</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Gross VND</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${Number(grossAmountVnd).toLocaleString()} VND</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Total Fee (${feePercent}%)</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${Number(totalFeeVnd).toLocaleString()} VND</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Client Bears</td><td style="padding:8px 14px;color:#c62828;border-bottom:1px solid #eee">${Number(clientFeeVnd).toLocaleString()} VND</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Merchant Bears</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${Number(merchantFeeVnd).toLocaleString()} VND</td></tr>
      <tr style="background:#f1f8e9"><td style="padding:8px 14px;color:#2e7d32;font-weight:bold;border-bottom:1px solid #eee">Net to Recipient</td><td style="padding:8px 14px;font-weight:bold;color:#2e7d32;border-bottom:1px solid #eee">${Number(netAmountVnd).toLocaleString()} VND</td></tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <tr style="background:#e8eaf6"><td colspan="2" style="padding:10px 14px;font-weight:bold;color:#283593;font-size:14px">🏦 Bank Details (Pay2Pay Transfer 24/7)</td></tr>
      <tr><td style="padding:8px 14px;color:#666;width:45%;border-bottom:1px solid #eee">Account Name</td><td style="padding:8px 14px;font-weight:bold;border-bottom:1px solid #eee">${bankRefName}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Account Number</td><td style="padding:8px 14px;font-weight:bold;border-bottom:1px solid #eee">${bankRefNumber}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Bank ID</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${bankId}</td></tr>
      <tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">Bank Code</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${bankCode}</td></tr>
      ${binCode ? `<tr><td style="padding:8px 14px;color:#666;border-bottom:1px solid #eee">BIN Code</td><td style="padding:8px 14px;border-bottom:1px solid #eee">${binCode}</td></tr>` : ''}
    </table>

    <div style="background:#fff3e0;border-left:4px solid #f57c00;padding:14px 16px;border-radius:4px;margin-bottom:20px">
      <p style="margin:0;font-size:14px;color:#e65100">
        <strong>⚠️ Action Required:</strong> Review in the admin panel.
        Approving will automatically dispatch via Pay2Pay Transfer 24/7.
      </p>
    </div>
    <p style="font-size:12px;color:#9e9e9e;text-align:center;margin:0">Automated notification from LiveFXHub — do not reply.</p>
  </div>
</body>
</html>`;

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT),
      secure: Number(process.env.EMAIL_PORT) === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: adminEmail,
      subject: `⚡ VN Withdrawal: ${withdrawalRequest.request_id} — $${Number(amountUsd).toFixed(2)} → ${Number(netAmountVnd).toLocaleString()} VND`,
      html,
    });

    logger.info('Vietnam withdrawal: admin notification sent', {
      requestId: withdrawalRequest.request_id,
      to: adminEmail,
    });
  } catch (err) {
    // Non-blocking — don't fail the request if email fails
    logger.error('Vietnam withdrawal: failed to send admin notification email', {
      requestId: withdrawalRequest.request_id,
      error: err.message,
    });
  }
}

// ─── POST /api/withdrawals/vietnam-bank ──────────────────────────────────────

/**
 * Create a Vietnam bank withdrawal request via Pay2Pay Transfer 24/7.
 *
 * Required body fields:
 *   amount           {number}  Withdrawal amount in USD
 *   bankId           {string}  Pay2Pay bank ID (from GET /api/pay2pay-payout/banks)
 *   bankRefNumber    {string}  Recipient bank account number
 *   bankRefName      {string}  Recipient account holder name (as on bank account)
 *   bankCode         {string}  Bank code (from /banks)
 *   binCode          {string}  [optional] BIN code (from /banks), falls back to bankCode
 *
 * VND conversion is done automatically server-side using PAY2PAY_VND_TO_USD_FALLBACK_RATE.
 * The client does NOT need to pass amountVnd — the server calculates it.
 */
async function createVietnamBankWithdrawal(req, res) {
  const operationId = `vn_withdraw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const authContext = getAuthContext(req);

    if (!authContext.authUserId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!authContext.isActive) {
      return res.status(401).json({ success: false, message: 'Account is inactive' });
    }
    if (authContext.authAccountType !== 'live') {
      return res.status(403).json({ success: false, message: 'Only live trading accounts can submit withdrawal requests' });
    }

    const {
      amount,
      bankId,
      bankRefNumber,
      bankRefName,
      bankCode,
      binCode,
      currency = 'USD',
    } = req.body || {};

    // ── Validate required fields ───────────────────────────────────────────
    const missing = [];
    if (!amount || Number(amount) <= 0) missing.push('amount (positive number in USD)');
    if (!bankId) missing.push('bankId');
    if (!bankRefNumber) missing.push('bankRefNumber');
    if (!bankRefName || String(bankRefName).trim().length === 0) missing.push('bankRefName');
    if (!bankCode) missing.push('bankCode');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    const parsedAmountUsd = Number(amount);

    // ── Auto USD → VND conversion ──────────────────────────────────────────
    const { vndAmount: grossAmountVnd, rate } = await fxService.usdToVnd(parsedAmountUsd);

    // ── Fee breakdown ──────────────────────────────────────────────────────
    const fees = payoutFeeBreakdown(grossAmountVnd);

    payoutLogger.logFeeBreakdown({
      operationId,
      amountUsd: parsedAmountUsd,
      rate,
      ...fees,
    });

    logger.info(`[${operationId}] Vietnam withdrawal: fee breakdown`, {
      userId: authContext.authUserId,
      amountUsd: parsedAmountUsd,
      rate,
      ...fees,
    });

    // ── Validate balance (checks free margin — open positions safe) ────────
    const withdrawalValidation = await InternalTransferService.validateWithdrawal(
      authContext.authUserId,
      'live',
      authContext.authUserId,
      parsedAmountUsd
    );

    if (!withdrawalValidation.valid) {
      return res.status(400).json({
        success: false,
        message: withdrawalValidation.error,
        details: {
          availableBalance: withdrawalValidation.availableBalance,
          marginInfo: withdrawalValidation.marginInfo,
        },
      });
    }

    // ── Fetch user ─────────────────────────────────────────────────────────
    const user = await LiveUser.findByPk(authContext.authUserId, {
      attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance'],
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found' });
    }

    logger.info(`[${operationId}] Creating Vietnam bank withdrawal request`, {
      userId: authContext.authUserId,
      amountUsd: parsedAmountUsd,
      grossAmountVnd,
      netAmountVnd: fees.netAmountVnd,
      bankId,
      bankCode,
    });

    // ── Build method_details (all payout + fee data stored here) ──────────
    const methodDetails = {
      // Pay2Pay transfer fields
      bankId: String(bankId),
      bankRefNumber: String(bankRefNumber),
      bankRefName: String(bankRefName).trim().toUpperCase(),
      bankCode: String(bankCode),
      binCode: binCode ? String(binCode) : String(bankCode),
      gateway: 'pay2pay',
      transferType: 'transfer_247',

      // Conversion
      exchangeRate: rate,                         // 1 VND = ? USD
      amountUsd: parsedAmountUsd,

      // Amounts (VND)
      amountVnd: grossAmountVnd,                  // gross VND (used for transfer_247)
      netAmountVnd: fees.netAmountVnd,            // what recipient actually receives

      // Fee breakdown
      feePercent: fees.feePercent,
      totalFeeVnd: fees.totalFeeVnd,
      clientFeeVnd: fees.clientFeeVnd,
      merchantFeeVnd: fees.merchantFeeVnd,
      merchantSharePercent: fees.merchantSharePercent,
      clientSharePercent: fees.clientSharePercent,
    };

    // ── Create MoneyRequest ────────────────────────────────────────────────
    const created = await moneyRequestService.createRequest({
      userId: authContext.authUserId,
      initiatorAccountType: 'live',
      targetAccountId: authContext.authUserId,
      targetAccountType: 'live',
      type: 'withdraw',
      amount: parsedAmountUsd,
      currency,
      methodType: 'BANK',
      methodDetails,
      accountNumber: user.account_number,
    });

    // ── Admin email (non-blocking) ─────────────────────────────────────────
    setImmediate(() => {
      sendAdminWithdrawalNotification(
        created,
        user,
        {
          bankId,
          bankRefNumber,
          bankRefName: methodDetails.bankRefName,
          bankCode,
          binCode: methodDetails.binCode,
        },
        { ...fees, rate, amountUsd: parsedAmountUsd }
      ).catch(err => {
        logger.error(`[${operationId}] Admin email failed`, { error: err.message });
      });
    });

    return res.status(201).json({
      success: true,
      message: 'Vietnam bank withdrawal request submitted. Pending admin approval.',
      data: {
        id: created.id,
        request_id: created.request_id,
        status: created.status,
        payout_status: created.payout_status || 'NA',

        // Amounts
        amount_usd: parsedAmountUsd,
        currency,
        exchange_rate: rate,

        // VND breakdown
        gross_amount_vnd: grossAmountVnd,
        net_amount_vnd: fees.netAmountVnd,

        // Fees
        fee_percent: fees.feePercent,
        total_fee_vnd: fees.totalFeeVnd,
        client_fee_vnd: fees.clientFeeVnd,
        merchant_fee_vnd: fees.merchantFeeVnd,
        client_fee_share: fees.clientSharePercent,
        merchant_fee_share: fees.merchantSharePercent,

        // Bank
        method_type: 'BANK',
        bank: {
          bankId: methodDetails.bankId,
          bankRefName: methodDetails.bankRefName,
          bankRefNumber: methodDetails.bankRefNumber,
          bankCode: methodDetails.bankCode,
        },

        // Balance info
        available_balance: withdrawalValidation.availableBalance,
        balance_after_withdrawal: withdrawalValidation.balanceAfterWithdrawal,

        created_at: created.created_at,
      },
    });

  } catch (err) {
    const statusCode = err.statusCode || 500;
    logger.error(`[${operationId}] Failed to create Vietnam bank withdrawal`, { error: err.message, stack: err.stack });
    payoutLogger.logError('createVietnamBankWithdrawal', err);
    return res.status(statusCode).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = { createVietnamBankWithdrawal };
