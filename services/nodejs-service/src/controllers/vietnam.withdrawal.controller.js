'use strict';

/**
 * Vietnam Bank Withdrawal Controller
 *
 * Separate endpoint for Vietnam users to submit bank withdrawal requests.
 * Collects the Pay2Pay-specific bank fields (bankId, bankRefNumber, etc.)
 * on top of the standard withdrawal fields.
 *
 * Routes:
 *   POST /api/withdrawals/vietnam-bank   ← Vietnam bank withdrawal request (user)
 */

const moneyRequestService = require('../services/moneyRequest.service');
const payoutService = require('../services/pay2pay.payout.service');
const emailService = require('../services/email.service');
const InternalTransferService = require('../services/internalTransfer.service');
const { LiveUser } = require('../models');
const logger = require('../services/logger.service');

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

// ─── Admin Email Notification ─────────────────────────────────────────────────

/**
 * Send an email to the admin/ops mailbox notifying them of a new Vietnam
 * bank withdrawal request.
 *
 * @param {Object} withdrawalRequest - Saved MoneyRequest instance
 * @param {Object} user - LiveUser record
 * @param {Object} bankDetails - Validated bank detail fields
 */
async function sendAdminWithdrawalNotification(withdrawalRequest, user, bankDetails) {
    const adminEmail = process.env.EMAIL_USER; // The ops/admin inbox from .env
    if (!adminEmail) {
        logger.warn('Vietnam withdrawal: EMAIL_USER not set, skipping admin notification');
        return;
    }

    const { bankRefName, bankRefNumber, bankId, bankCode, amountVnd, binCode } = bankDetails;
    const amountUsd = withdrawalRequest.amount;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 620px; margin: 0 auto; padding: 20px;">

  <div style="background: linear-gradient(135deg, #1a237e, #283593); padding: 24px; border-radius: 10px 10px 0 0; text-align: center;">
    <h2 style="color: #fff; margin: 0; font-size: 20px;">⚡ New Vietnam Bank Withdrawal Request</h2>
    <p style="color: #c5cae9; margin: 8px 0 0; font-size: 14px;">Action Required — Pending Admin Approval</p>
  </div>

  <div style="background: #f9f9f9; padding: 24px; border: 1px solid #e0e0e0; border-top: none;">

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr style="background: #e8eaf6;">
        <td colspan="2" style="padding: 10px 14px; font-weight: bold; color: #283593; font-size: 14px;">
          📋 Request Details
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; width: 40%; border-bottom: 1px solid #eee;">Request ID</td>
        <td style="padding: 8px 14px; font-weight: bold; border-bottom: 1px solid #eee;">${withdrawalRequest.request_id}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Amount (USD)</td>
        <td style="padding: 8px 14px; font-weight: bold; color: #c62828; border-bottom: 1px solid #eee;">$${Number(amountUsd).toFixed(2)} USD</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Amount (VND)</td>
        <td style="padding: 8px 14px; font-weight: bold; border-bottom: 1px solid #eee;">${Number(amountVnd).toLocaleString()} VND</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Submitted At</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${new Date().toUTCString()}</td>
      </tr>
    </table>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr style="background: #e8eaf6;">
        <td colspan="2" style="padding: 10px 14px; font-weight: bold; color: #283593; font-size: 14px;">
          👤 User Details
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; width: 40%; border-bottom: 1px solid #eee;">Name</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${user.name || 'N/A'}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Email</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${user.email || 'N/A'}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Account Number</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${withdrawalRequest.account_number}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">User ID</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">#${user.id}</td>
      </tr>
    </table>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
      <tr style="background: #e8eaf6;">
        <td colspan="2" style="padding: 10px 14px; font-weight: bold; color: #283593; font-size: 14px;">
          🏦 Bank Details (Pay2Pay Transfer 24/7)
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; width: 40%; border-bottom: 1px solid #eee;">Account Name</td>
        <td style="padding: 8px 14px; font-weight: bold; border-bottom: 1px solid #eee;">${bankRefName}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Account Number</td>
        <td style="padding: 8px 14px; font-weight: bold; border-bottom: 1px solid #eee;">${bankRefNumber}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Bank ID</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${bankId}</td>
      </tr>
      <tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">Bank Code</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${bankCode}</td>
      </tr>
      ${binCode ? `<tr>
        <td style="padding: 8px 14px; color: #666; border-bottom: 1px solid #eee;">BIN Code</td>
        <td style="padding: 8px 14px; border-bottom: 1px solid #eee;">${binCode}</td>
      </tr>` : ''}
    </table>

    <div style="background: #fff3e0; border-left: 4px solid #f57c00; padding: 14px 16px; border-radius: 4px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 14px; color: #e65100;">
        <strong>⚠️ Action Required:</strong> Please log in to the admin panel and review this request. 
        Approving will automatically dispatch the payment via Pay2Pay Transfer 24/7.
      </p>
    </div>

    <div style="text-align: center;">
      <p style="font-size: 12px; color: #9e9e9e; margin: 0;">
        This is an automated notification from LiveFXHub. Do not reply.
      </p>
    </div>

  </div>
</body>
</html>
    `;

    try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: process.env.EMAIL_PORT,
            secure: process.env.EMAIL_PORT == 465,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        await transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: adminEmail,
            subject: `⚡ New VN Withdrawal Request: ${withdrawalRequest.request_id} — $${Number(amountUsd).toFixed(2)}`,
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
 *   amountVnd        {number}  Equivalent VND amount to transfer
 *   bankId           {string}  Pay2Pay bank ID (from /banks list)
 *   bankRefNumber    {string}  Recipient bank account number
 *   bankRefName      {string}  Recipient account holder name
 *   bankCode         {string}  Bank code (from /banks list)
 *   binCode          {string}  [optional] BIN code from /banks list
 *
 * The standard method_type is hardcoded as 'BANK'.
 * All Pay2Pay-specific fields are stored in method_details.
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
            return res.status(403).json({ success: false, message: 'Only live users can submit withdrawal requests' });
        }

        const {
            amount,
            amountVnd,
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
        if (!amountVnd || Number(amountVnd) <= 0) missing.push('amountVnd (positive integer in VND)');
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

        const parsedAmount = Number(amount);
        const parsedAmountVnd = Math.round(Number(amountVnd));

        // ── Validate balance ───────────────────────────────────────────────────
        const withdrawalValidation = await InternalTransferService.validateWithdrawal(
            authContext.authUserId,
            'live',
            authContext.authUserId,
            parsedAmount
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

        // ── Fetch user for account number ─────────────────────────────────────
        const user = await LiveUser.findByPk(authContext.authUserId, {
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance'],
        });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User account not found' });
        }

        logger.info(`[${operationId}] Creating Vietnam bank withdrawal request`, {
            userId: authContext.authUserId,
            amount: parsedAmount,
            amountVnd: parsedAmountVnd,
            bankId,
            bankCode,
        });

        // ── Create the MoneyRequest ────────────────────────────────────────────
        const methodDetails = {
            bankId: String(bankId),
            bankRefNumber: String(bankRefNumber),
            bankRefName: String(bankRefName).trim().toUpperCase(),
            bankCode: String(bankCode),
            binCode: binCode ? String(binCode) : String(bankCode),
            amountVnd: parsedAmountVnd,
            gateway: 'pay2pay',
            transferType: 'transfer_247',
        };

        const created = await moneyRequestService.createRequest({
            userId: authContext.authUserId,
            initiatorAccountType: 'live',
            targetAccountId: authContext.authUserId,
            targetAccountType: 'live',
            type: 'withdraw',
            amount: parsedAmount,
            currency,
            methodType: 'BANK',
            methodDetails,
            accountNumber: user.account_number,
        });

        // ── Notify admin via email (non-blocking) ─────────────────────────────
        setImmediate(() => {
            sendAdminWithdrawalNotification(created, user, {
                bankId,
                bankRefNumber,
                bankRefName: methodDetails.bankRefName,
                bankCode,
                binCode: methodDetails.binCode,
                amountVnd: parsedAmountVnd,
            }).catch(err => {
                logger.error(`[${operationId}] Admin email notification failed`, { error: err.message });
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
                amount: created.amount,
                currency: created.currency,
                amountVnd: parsedAmountVnd,
                method_type: created.method_type,
                bank: {
                    bankId,
                    bankRefName: methodDetails.bankRefName,
                    bankRefNumber,
                    bankCode,
                },
                created_at: created.created_at,
                available_balance: withdrawalValidation.availableBalance,
                balance_after_withdrawal: withdrawalValidation.balanceAfterWithdrawal,
            },
        });

    } catch (err) {
        const statusCode = err.statusCode || 500;
        logger.error(`[${operationId}] Failed to create Vietnam bank withdrawal`, { error: err.message });
        return res.status(statusCode).json({ success: false, message: err.message || 'Internal server error' });
    }
}

module.exports = { createVietnamBankWithdrawal };
