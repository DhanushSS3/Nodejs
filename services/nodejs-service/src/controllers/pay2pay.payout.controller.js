'use strict';

/**
 * Pay2Pay Payout Controller
 *
 * Endpoints:
 *   POST /api/pay2pay-payout/ipn        ← public, no auth (Pay2Pay webhook)
 *   GET  /api/pay2pay-payout/banks      ← authenticated, cached bank list
 *
 * Internal (called from superadmin money-requests controller):
 *   approveAndDispatch(moneyRequest, adminId) → triggers 3-step payout flow
 */

const payoutService = require('../services/pay2pay.payout.service');
const MoneyRequest = require('../models/moneyRequest.model');
const adminAuditService = require('../services/admin.audit.service');
const payoutLogger = require('../services/logging/Pay2PayPayoutLogger');
const logger = require('../services/logger.service');

// ─── Admin-Triggered Dispatch ─────────────────────────────────────────────────

/**
 * Called programmatically (not via route) from the superadmin money-requests
 * controller after admin clicks "Approve" on a withdrawal request.
 *
 * Validates the request is eligible for automatic Pay2Pay dispatch (BANK method
 * with Vietnam bank details populated), then kicks off the 3-step sequential flow.
 *
 * @param {Object} moneyRequest - Sequelize MoneyRequest instance (already approved)
 * @param {number} adminId
 * @returns {Promise<{ dispatched: boolean, reason?: string, result?: Object }>}
 */
async function approveAndDispatch(moneyRequest, adminId) {
    // Only dispatch for BANK withdrawals that have the required Pay2Pay details
    if (moneyRequest.type !== 'withdraw') {
        return { dispatched: false, reason: 'Not a withdrawal request' };
    }

    if (moneyRequest.method_type !== 'BANK') {
        return { dispatched: false, reason: `method_type is ${moneyRequest.method_type}, not BANK. Manual payout required.` };
    }

    const details = moneyRequest.method_details || {};
    const hasRequiredFields = details.bankId && details.bankRefNumber && details.bankRefName
        && details.bankCode && details.amountVnd;

    if (!hasRequiredFields) {
        return {
            dispatched: false,
            reason: 'method_details missing Pay2Pay required fields (bankId, bankRefNumber, bankRefName, bankCode, amountVnd). Manual payout required.',
        };
    }

    if (moneyRequest.payout_status === 'PROCESSING' || moneyRequest.payout_status === 'SUCCESS') {
        return { dispatched: false, reason: `Payout already in state: ${moneyRequest.payout_status}` };
    }

    logger.info('Pay2Pay payout: dispatching approved withdrawal', {
        moneyRequestId: moneyRequest.id,
        requestId: moneyRequest.request_id,
        adminId,
    });

    try {
        const result = await payoutService.dispatchPayout(moneyRequest, adminId);
        return { dispatched: true, result };
    } catch (err) {
        // Log but don't re-throw — the wallet debit already committed.
        // payout_status remains PENDING so admin can retry.
        logger.error('Pay2Pay payout: dispatch failed after admin approval', {
            moneyRequestId: moneyRequest.id,
            error: err.message,
            stack: err.stack,
        });

        // Mark payout_status as FAILED so admin has visibility
        try {
            await moneyRequest.update({
                payout_status: 'FAILED',
                notes: `${moneyRequest.notes ? moneyRequest.notes + ' | ' : ''}Pay2Pay dispatch error: ${err.message}`,
            });
        } catch (updateErr) {
            logger.error('Pay2Pay payout: failed to update payout_status after dispatch error', {
                error: updateErr.message,
            });
        }

        return { dispatched: false, reason: err.message, error: true };
    }
}

// ─── Retry Payout ─────────────────────────────────────────────────────────────

/**
 * POST /api/superadmin/money-requests/:requestId/retry-payout
 * Allows an admin to re-trigger a failed payout dispatch.
 */
async function retryPayout(req, res) {
    const operationId = `payout_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
        const id = parseInt(req.params.requestId, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request id' });
        }

        const adminId = req.admin?.id || req.admin?.sub || null;

        const moneyRequest = await MoneyRequest.findByPk(id);
        if (!moneyRequest) {
            return res.status(404).json({ success: false, message: 'Money request not found' });
        }

        if (moneyRequest.type !== 'withdraw') {
            return res.status(400).json({ success: false, message: 'Not a withdrawal request' });
        }

        if (moneyRequest.status !== 'approved') {
            return res.status(400).json({
                success: false,
                message: `Request must be in 'approved' status to retry payout. Current status: ${moneyRequest.status}`,
            });
        }

        if (moneyRequest.payout_status === 'PROCESSING' || moneyRequest.payout_status === 'SUCCESS') {
            return res.status(400).json({
                success: false,
                message: `Cannot retry — payout already in state: ${moneyRequest.payout_status}`,
            });
        }

        // Re-set payout_status to allow dispatch
        await moneyRequest.update({ payout_status: 'PENDING' });

        const dispatchResult = await approveAndDispatch(moneyRequest, adminId);

        await adminAuditService.logAction({
            adminId,
            action: 'PAYOUT_RETRY',
            ipAddress: req.ip,
            requestBody: { id },
            status: dispatchResult.dispatched ? 'SUCCESS' : 'FAILURE',
            errorMessage: dispatchResult.reason || null,
        });

        return res.status(200).json({
            success: true,
            message: dispatchResult.dispatched
                ? 'Payout re-dispatched to Pay2Pay'
                : `Payout not dispatched: ${dispatchResult.reason}`,
            data: { dispatched: dispatchResult.dispatched, result: dispatchResult.result || null },
        });
    } catch (err) {
        logger.error('Pay2Pay payout: retryPayout error', { operationId, error: err.message });
        return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
    }
}

// ─── Payout IPN ───────────────────────────────────────────────────────────────

/**
 * POST /api/pay2pay-payout/ipn
 * Pay2Pay server-to-server payout notification. Always returns HTTP 200.
 */
async function handlePayoutIPN(req, res) {
    const rawBodyStr = req.rawBody
        || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    payoutLogger.logPayoutIPN(
        { 'p-api-key': req.headers['p-api-key'], 'p-signature': req.headers['p-signature'] },
        req.body || rawBodyStr
    );

    logger.info('Pay2Pay payout IPN received', {
        ip: req.ip,
        headers: {
            'p-api-key': req.headers['p-api-key'],
            'p-signature': req.headers['p-signature'],
        },
        bodyKeys: Object.keys(req.body || {}),
    });

    // ── Verify signature ──────────────────────────────────────────────────────
    const verification = payoutService.verifyPayoutIPN(req.headers, rawBodyStr);
    if (!verification.valid) {
        logger.warn('Pay2Pay payout IPN: rejected', { error: verification.error });
        return res.status(400).json({ code: 'SIGNATURE_INVALID', message: 'Invalid signature' });
    }

    // ── Process ───────────────────────────────────────────────────────────────
    try {
        const result = await payoutService.processPayoutIPN(
            req.body,
            rawBodyStr,
            { ip: req.ip, userAgent: req.get('User-Agent') }
        );

        if (result.duplicate) {
            return res.status(200).json({ code: 'SUCCESS', message: 'Already processed' });
        }
        if (result.ignored) {
            return res.status(200).json({ code: 'SUCCESS', message: 'Ignored' });
        }

        return res.status(200).json({ code: 'SUCCESS', message: 'OK' });
    } catch (err) {
        logger.error('Pay2Pay payout IPN: processing error', { error: err.message, stack: err.stack });
        payoutLogger.logError('Payout IPN processing failed', { error: err.message, body: req.body });
        // Return 200 to stop Pay2Pay from retrying
        return res.status(200).json({ code: 'SUCCESS', message: 'Logged internal error, stopping retries' });
    }
}

// ─── Bank Account Name Lookup ──────────────────────────────────────────────────

/**
 * GET /api/pay2pay-payout/account-name?bankId=BIDV&bankRefNumber=1023020330000
 * Returns the registered account holder name for the given bank account.
 * Called by the frontend to auto-fill and verify the account name.
 */
async function getBankAccountName(req, res) {
    const { bankId, bankRefNumber } = req.query;

    if (!bankId || !bankRefNumber) {
        return res.status(400).json({
            success: false,
            message: 'bankId and bankRefNumber are required query parameters',
        });
    }

    try {
        const result = await payoutService.getBankAccountName(bankId, bankRefNumber);
        return res.status(200).json({
            success: true,
            data: result,
        });
    } catch (err) {
        logger.error('Pay2Pay payout: getBankAccountName error', { error: err.message, bankId, bankRefNumber });
        // Return a user-friendly error (e.g. account not found, invalid bank)
        return res.status(422).json({
            success: false,
            message: err.message || 'Failed to look up account name',
        });
    }
}

// ─── Bank List ────────────────────────────────────────────────────────────────

/**
 * GET /api/pay2pay-payout/banks
 * Returns the cached list of supported banks for Vietnam payouts.
 */
async function getBankList(req, res) {
    try {
        const banks = await payoutService.listBanks();
        return res.status(200).json({
            success: true,
            message: `${banks.length} banks available`,
            data: banks,
        });
    } catch (err) {
        logger.error('Pay2Pay payout: getBankList error', { error: err.message });
        return res.status(500).json({ success: false, message: `Failed to fetch bank list: ${err.message}` });
    }
}

module.exports = {
    approveAndDispatch,  // called programmatically from superadmin controller
    retryPayout,         // POST /api/superadmin/money-requests/:id/retry-payout
    handlePayoutIPN,     // POST /api/pay2pay-payout/ipn
    getBankList,         // GET  /api/pay2pay-payout/banks
    getBankAccountName,  // GET  /api/pay2pay-payout/account-name
};
