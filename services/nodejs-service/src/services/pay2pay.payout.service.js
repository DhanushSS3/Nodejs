'use strict';

/**
 * Pay2Pay Payout Service (Transfer 24/7)
 *
 * Handles the full asynchronous payout lifecycle:
 *
 * Admin-Approval Dispatch (sequential):
 *   Step 1 → POST /auth-service/api/v1.0/user/login         → get accessToken
 *   Step 2 → POST /auth-service/api/v1.0/implore-auth        → get verifiedKey
 *   Step 3 → POST /merchant-transaction-service/api/v2.0/transfer_247 → submit transfer
 *
 * Webhook (IPN):
 *   - Validate P-SIGNATURE: Base64(SHA256(rawBodyStr + secretKey))
 *   - On SUCCESS → mark MoneyRequest payout_status = SUCCESS
 *   - On FAIL    → refund user wallet + mark payout_status = FAILED
 *
 * Bank List:
 *   - GET /bank-gateway-service/mch/api/v1.0/bank (cached 24h in-memory)
 */

const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger.service');
const payoutLogger = require('./logging/Pay2PayPayoutLogger');
const tokenService = require('./pay2pay.token.service');
const walletService = require('./wallet.service');
const idGenerator = require('./idGenerator.service');
const redisUserCache = require('./redis.user.cache.service');
const sequelize = require('../config/db');
const {
    GatewayPayment,
    GatewayPaymentEvent,
    UserTransaction,
    LiveUser,
    StrategyProviderAccount,
    CopyFollowerAccount,
} = require('../models');
const MoneyRequest = require('../models/moneyRequest.model');

const GATEWAY_NAME = 'pay2pay';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDomain() {
    return (process.env.PAY2PAY_DOMAIN || 'https://api.pay2pay.vn').replace(/\/$/, '');
}

function getIpnSecretKey() {
    // Payout IPN uses the same secret key as collection IPN
    return process.env.PAY2PAY_IPN_SECRET_KEY || '';
}

function getApiKey() {
    return process.env.PAY2PAY_API_KEY || '';
}

function getUsername() {
    return process.env.PAY2PAY_USERNAME || '';
}

function getPasscodeRaw() {
    return process.env.PAY2PAY_PAYOUT_PASSCODE_RAW || '359135';
}

/**
 * Hash the passcode exactly as Pay2Pay requires for implore-auth:
 *   SHA256(username + rawPasscode) in HEX → Base64
 */
function hashPasscode(username, rawPasscode) {
    const input = `${username}${rawPasscode}`;
    const hexHash = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
    return Buffer.from(hexHash).toString('base64');
}

function getAccountModel(userType) {
    switch ((userType || '').toLowerCase()) {
        case 'strategy_provider': return StrategyProviderAccount;
        case 'copy_follower': return CopyFollowerAccount;
        case 'live':
        default: return LiveUser;
    }
}

/** Generate a random 16-digit numeric string for the audit field. */
function generateAuditNumber() {
    const min = BigInt('1000000000000000');
    const max = BigInt('9999999999999999');
    const range = max - min + BigInt(1);
    // Combine two 32-bit random values for enough entropy
    const hi = BigInt(Math.floor(Math.random() * 0xFFFFFFFF)) << BigInt(16);
    const lo = BigInt(Math.floor(Math.random() * 0xFFFF));
    const rand = ((hi | lo) % range + range) % range;
    return (min + rand).toString();
}

// ─── Bank List Cache ──────────────────────────────────────────────────────────

let _bankListCache = null;
let _bankListCachedAt = 0;
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Fee Calculation ──────────────────────────────────────────────────────────

/**
 * Calculate the fee breakdown for a Pay2Pay payout (Transfer 24/7).
 *
 * Fee logic mirrors the collection side:
 *   totalFeeVnd      = grossAmountVnd × (PAY2PAY_PAYOUT_FEE_PERCENT / 100)
 *   merchantFeeVnd   = totalFeeVnd × (PAY2PAY_PAYOUT_FEE_SHARE_PERCENT / 100)
 *   clientFeeVnd     = totalFeeVnd - merchantFeeVnd
 *   netAmountVnd     = grossAmountVnd - clientFeeVnd
 *   (client receives less; merchant absorbs its share as cost)
 *
 * @param {number} grossAmountVnd - Full VND amount before fees
 * @returns {Object} fee breakdown
 */
function payoutFeeBreakdown(grossAmountVnd) {
    const feePercent = parseFloat(process.env.PAY2PAY_PAYOUT_FEE_PERCENT || '0.5');
    const merchantSharePercent = parseFloat(process.env.PAY2PAY_PAYOUT_FEE_SHARE_PERCENT || '50');
    const clientSharePercent = 100 - merchantSharePercent;

    const totalFeeVnd = Math.round(grossAmountVnd * feePercent / 100);
    const merchantFeeVnd = Math.round(totalFeeVnd * merchantSharePercent / 100);
    const clientFeeVnd = totalFeeVnd - merchantFeeVnd;
    const netAmountVnd = grossAmountVnd - clientFeeVnd; // what client actually receives

    return {
        grossAmountVnd,
        feePercent,
        merchantSharePercent,
        clientSharePercent,
        totalFeeVnd,
        merchantFeeVnd,
        clientFeeVnd,
        netAmountVnd,
    };
}

/**
 * Detect if a Pay2Pay API error is a token revocation / expiry.
 * Pay2Pay returns HTTP 200 with code: 'TOKEN_REVOKED' or 'UNAUTHORIZED',
 * or sometimes HTTP 401.
 */
function isTokenRevoked(err) {
    if (!err) return false;
    const status = err.response && err.response.status;
    if (status === 401) return true;
    const data = err.response && err.response.data;
    if (data) {
        const code = (data.code || '').toUpperCase();
        if (code === 'TOKEN_REVOKED' || code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED') return true;
        const msg = (data.message || '').toLowerCase();
        if (msg.includes('token') && (msg.includes('revoked') || msg.includes('expired') || msg.includes('invalid'))) return true;
    }
    // Catch the message thrown by our own code
    if (err.message && err.message.toLowerCase().includes('token has been revoked')) return true;
    return false;
}

/**
 * Retry wrapper for Pay2Pay API calls.
 * On token revocation error: clear cache, force re-login, retry ONCE.
 *
 * @param {Function} fn - async function to run
 * @returns {Promise<any>}
 */
async function withTokenRetry(fn) {
    try {
        return await fn();
    } catch (err) {
        if (isTokenRevoked(err)) {
            logger.warn('Pay2Pay payout: token revoked/expired detected, clearing cache and retrying once');
            payoutLogger.logError('Token revoked — forcing re-login', { originalError: err.message });
            tokenService.clearTokenCache(); // force fresh login on next getAccessToken()
            // Short delay before retry
            await new Promise(r => setTimeout(r, 300));
            return await fn(); // retry once with fresh token
        }
        throw err;
    }
}

/**
 * Fetch the list of supported banks from Pay2Pay.
 * Result is cached for 24 hours in-memory.
 * Automatically retries once if the token was revoked.
 * @returns {Promise<Array>}
 */
async function listBanks() {
    const now = Date.now();
    if (_bankListCache && (now - _bankListCachedAt) < BANK_LIST_TTL_MS) {
        logger.info('Pay2Pay payout: returning cached bank list');
        return _bankListCache;
    }

    const url = `${getDomain()}/bank-gateway-service/mch/api/v1.0/bank`;
    logger.info('Pay2Pay payout: fetching bank list from API', { url });
    payoutLogger.logRequest('GET /bank-gateway-service/mch/api/v1.0/bank', {});

    const doFetch = async () => {
        // Headers for GET request (pass empty string for body to correctly sign)
        const headers = await tokenService.buildRequestHeaders('');
        const response = await axios.get(url, { headers, timeout: 15000 });
        return response.data;
    };

    try {
        const data = await withTokenRetry(doFetch);
        payoutLogger.logResponse('GET /bank-gateway-service/mch/api/v1.0/bank - SUCCESS', data);

        if (!data || data.code !== 'SUCCESS' || !Array.isArray(data.data)) {
            throw new Error(`Pay2Pay listBanks returned unexpected response: ${JSON.stringify(data)}`);
        }

        _bankListCache = data.data;
        _bankListCachedAt = Date.now();
        logger.info(`Pay2Pay payout: bank list cached (${_bankListCache.length} banks)`);
        return _bankListCache;
    } catch (err) {
        payoutLogger.logError('GET /bank-gateway-service/mch/api/v1.0/bank - FAIL', err.response ? err.response.data : err.message);
        throw new Error(`Pay2Pay listBanks error: ${err.message}`);
    }
}

/** Force-invalidate bank list cache (useful after Pay2Pay updates). */
function invalidateBankListCache() {
    _bankListCache = null;
    _bankListCachedAt = 0;
}

// ─── Step 1: Login ────────────────────────────────────────────────────────────
// Reuses tokenService.getAccessToken() which already handles login + caching.
// Exposed here for the sequential dispatch flow.

async function getAccessToken() {
    return tokenService.getAccessToken();
}

// ─── Step 2: Implore Auth ─────────────────────────────────────────────────────

/**
 * Call POST /auth-service/api/v1.0/implore-auth to get a verifiedKey.
 * This is a per-transfer security step Pay2Pay requires before each transfer.
 *
 * @param {string} accessToken - Valid JWT from step 1
 * @returns {Promise<string>} verifiedKey
 */
async function getVerifiedKey(accessToken) {
    const username = getUsername();
    const rawPasscode = getPasscodeRaw();

    if (!rawPasscode) {
        throw new Error('PAY2PAY_PAYOUT_PASSCODE_RAW is not configured. Required for implore-auth.');
    }

    const authValue = hashPasscode(username, rawPasscode);
    const body = {
        phone: username,
        api: '/merchant-transaction-service/api/v2.0/transfer_247',  // NOTE: 'api' not 'apiRoute'
        authMode: 'PASSCODE',
        authValue,
    };
    const bodyStr = JSON.stringify(body);

    const requestId = uuidv4();
    const requestTime = tokenService.getRequestTime();
    const tenant = process.env.PAY2PAY_TENANT || 'MERCHANT-WEB';

    // Build headers BEFORE computing signature — Authorization must be part of the signed string
    const headers = {
        'Content-Type': 'application/json',
        'p-request-id': requestId,
        'p-request-time': requestTime,
        'p-tenant': tenant,
        'Authorization': `Bearer ${accessToken}`,
    };
    // Compute signature with sorted-header method (Authorization value included)
    headers['p-signature'] = tokenService.createSignatureFromHeaders(headers, bodyStr);

    const url = `${getDomain()}/auth-service/api/v1.0/implore-auth`;

    logger.info('Pay2Pay payout: calling implore-auth', { username, apiRoute: body.api });
    payoutLogger.logRequest('POST /auth-service/api/v1.0/implore-auth', { phone: username, api: body.api, authMode: 'PASSCODE' });

    try {
        const response = await axios.post(url, body, { headers, timeout: 15000 });
        const data = response.data;
        payoutLogger.logResponse('POST /auth-service/api/v1.0/implore-auth - SUCCESS', data);

        if (!data || data.code !== 'SUCCESS' || !data.data || !data.data.verifiedKey) {
            throw new Error(`Pay2Pay implore-auth failed: ${JSON.stringify(data)}`);
        }

        logger.info('Pay2Pay payout: implore-auth success, verifiedKey received');
        return data.data.verifiedKey;
    } catch (err) {
        payoutLogger.logError('POST /auth-service/api/v1.0/implore-auth - FAIL', err.response ? err.response.data : err.message);
        throw new Error(`Pay2Pay implore-auth error: ${err.message}`);
    }
}

// ─── Step 3: Execute Transfer 24/7 ───────────────────────────────────────────

/**
 * Call POST /merchant-transaction-service/api/v2.0/transfer_247.
 *
 * @param {string} verifiedKey - From implore-auth (step 2)
 * @param {Object} payload
 * @param {string} payload.audit         - 16-digit random number (our internal ref)
 * @param {number} payload.amount        - Amount in VND (integer)
 * @param {string} payload.bankId        - Pay2Pay bank ID
 * @param {string} payload.bankRefNumber - Recipient bank account number
 * @param {string} payload.bankRefName   - Recipient name
 * @param {string} payload.bankCode      - Bank code
 * @param {string} payload.content       - Transfer description
 * @returns {Promise<Object>} Pay2Pay transfer response data
 */
async function executeTransfer247(verifiedKey, payload) {
    const body = {
        audit: payload.audit,
        amount: Math.round(Number(payload.amount)),
        bankId: payload.bankId,
        bankRefNumber: payload.bankRefNumber,
        bankRefName: payload.bankRefName,
        bankCode: payload.bankCode,
        content: (payload.content || 'Payout LFX').substring(0, 50),
    };
    const bodyStr = JSON.stringify(body);

    // Pass the verifiedKey as the 'verification' extra header BEFORE signature so that
    // it is included in the sorted-header string-to-sign (required by Pay2Pay).
    const headers = await tokenService.buildRequestHeaders(bodyStr, { 'verification': verifiedKey });

    const url = `${getDomain()}/merchant-transaction-service/api/v2.0/transfer_247`;

    logger.info('Pay2Pay payout: executing transfer_247', {
        audit: body.audit,
        amount: body.amount,
        bankId: body.bankId,
        bankCode: body.bankCode,
    });
    payoutLogger.logRequest('POST /merchant-transaction-service/api/v2.0/transfer_247', body);

    try {
        const response = await axios.post(url, body, { headers, timeout: 30000 });
        const data = response.data;
        payoutLogger.logResponse('POST /merchant-transaction-service/api/v2.0/transfer_247 - SUCCESS', data);

        if (!data || (data.code !== 'SUCCESS' && data.code !== 'PROCESSING')) {
            throw new Error(`Pay2Pay transfer_247 returned error: ${JSON.stringify(data)}`);
        }

        logger.info('Pay2Pay payout: transfer_247 dispatch accepted', {
            audit: body.audit,
            code: data.code,
            message: data.message,
        });

        return data;
    } catch (err) {
        payoutLogger.logError('POST /merchant-transaction-service/api/v2.0/transfer_247 - FAIL', err.response ? err.response.data : err.message);
        throw new Error(`Pay2Pay transfer_247 error: ${err.message}`);
    }
}

// ─── Orchestrated Dispatch ────────────────────────────────────────────────────

/**
 * Full 3-step payout dispatch triggered by admin approval.
 *
 * 1. Get accessToken (cached, no extra login if still valid)
 * 2. Call implore-auth → verifiedKey
 * 3. Call transfer_247 → submit transfer
 * 4. Create GatewayPayment record (purpose: 'payout')
 * 5. Update MoneyRequest payout_status → PROCESSING
 *
 * @param {Object} moneyRequest - Sequelize MoneyRequest instance
 * @param {number} adminId
 * @returns {Promise<{ audit, gatewayPaymentId, p2pResponse }>}
 */
async function dispatchPayout(moneyRequest, adminId) {
    const operationId = `payout_dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    logger.info(`[${operationId}] Starting Pay2Pay payout dispatch`, {
        moneyRequestId: moneyRequest.id,
        requestId: moneyRequest.request_id,
        amount: moneyRequest.amount,
        methodDetails: moneyRequest.method_details,
    });

    const details = moneyRequest.method_details || {};
    const { bankId, bankRefNumber, bankRefName, bankCode, binCode, amountVnd } = details;

    if (!bankId || !bankRefNumber || !bankRefName || !bankCode) {
        throw new Error(
            'Incomplete bank details in method_details. Required: bankId, bankRefNumber, bankRefName, bankCode'
        );
    }

    if (!amountVnd || Number(amountVnd) <= 0) {
        throw new Error('method_details.amountVnd is required and must be positive (VND amount for Pay2Pay)');
    }

    const fees = payoutFeeBreakdown(Number(amountVnd));
    payoutLogger.logFeeBreakdown(fees);
    logger.info(`[${operationId}] Fee breakdown`, fees);

    const audit = generateAuditNumber();
    const transferContent = `LFX WD ${moneyRequest.request_id}`;

    payoutLogger.logPayoutDispatch(operationId, {
        moneyRequestId: moneyRequest.id,
        requestId: moneyRequest.request_id,
        amountVnd,
        audit,
        bankId,
        bankCode: binCode || bankCode,
        fees,
    });

    // ── Step 1: Get access token (with retry on revocation) ───────────────────
    logger.info(`[${operationId}] Step 1: acquiring Pay2Pay access token`);
    const accessToken = await withTokenRetry(() => getAccessToken());

    // ── Step 2: Implore-auth ──────────────────────────────────────────────────
    logger.info(`[${operationId}] Step 2: calling implore-auth`);
    const verifiedKey = await getVerifiedKey(accessToken);

    // ── Step 3: Execute transfer ──────────────────────────────────────────────
    logger.info(`[${operationId}] Step 3: executing transfer_247`, { audit });
    const p2pResponse = await executeTransfer247(verifiedKey, {
        audit,
        amount: Number(amountVnd),
        bankId,
        bankRefNumber,
        bankRefName,
        bankCode: binCode || bankCode,
        content: transferContent,
    });

    // ── Persist GatewayPayment record ─────────────────────────────────────────
    const merchantReferenceId = GatewayPayment.generateMerchantReferenceId();
    const gatewayPayment = await GatewayPayment.create({
        merchant_reference_id: merchantReferenceId,
        gateway: GATEWAY_NAME,
        purpose: 'payout',
        status: 'PROCESSING',
        user_id: moneyRequest.target_account_id || moneyRequest.user_id,
        user_type: moneyRequest.target_account_type || 'live',
        requested_amount: Number(amountVnd),
        requested_currency: 'VND',
        metadata: {
            audit,
            moneyRequestId: moneyRequest.id,
            moneyRequestRef: moneyRequest.request_id,
            adminId,
            bankId,
            bankCode: binCode || bankCode,
            bankRefNumber,
            bankRefName,
            p2pResponse,
        },
    });

    // ── Update MoneyRequest ───────────────────────────────────────────────────
    await moneyRequest.update({
        payout_status: 'PROCESSING',
        payout_ref: audit,
        gateway_payment_id: gatewayPayment.id,
    });

    payoutLogger.logPayoutOutcome(operationId, 'success', {
        audit,
        gatewayPaymentId: gatewayPayment.id,
        merchantReferenceId,
    });

    return { audit, gatewayPaymentId: gatewayPayment.id, p2pResponse, fees };
}

// ─── Payout IPN Verification ──────────────────────────────────────────────────

/**
 * Verify the IPN signature from Pay2Pay for payout webhooks.
 * Algorithm: Base64(SHA256(rawBodyString + secretKey))
 *
 * @param {Object} headers
 * @param {string} rawBodyStr
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyPayoutIPN(headers, rawBodyStr) {
    const apiKey = getApiKey();
    const secretKey = getIpnSecretKey();

    if (!apiKey || !secretKey) {
        logger.error('Pay2Pay payout IPN: PAY2PAY_API_KEY or PAY2PAY_IPN_SECRET_KEY not configured');
        return { valid: false, error: 'Gateway not configured' };
    }

    const receivedApiKey = headers['p-api-key'] || headers['P-API-KEY'] || '';
    if (receivedApiKey !== apiKey) {
        logger.warn('Pay2Pay payout IPN: invalid P-API-KEY', { received: receivedApiKey });
        return { valid: false, error: 'Invalid API key' };
    }

    const receivedSignature = headers['p-signature'] || headers['P-SIGNATURE'] || '';
    const expectedSignature = crypto
        .createHash('sha256')
        .update(`${rawBodyStr}${secretKey}`, 'utf8')
        .digest('base64');

    if (receivedSignature !== expectedSignature) {
        logger.warn('Pay2Pay payout IPN: signature mismatch', {
            expected: expectedSignature,
            received: receivedSignature,
        });
        return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true };
}

// ─── Payout IPN Processing ────────────────────────────────────────────────────

/**
 * Process a verified payout IPN from Pay2Pay.
 * Idempotent — safe to call multiple times for the same event.
 *
 * IPN body fields (from PP-PAYOUT-API docs):
 *   audit    - our 16-digit reference sent in transfer_247
 *   status   - SUCCESS | FAIL | PROCESSING
 *   txnId    - Pay2Pay transaction ID
 *   amount   - VND amount
 *   code, message
 *
 * @param {Object} body - parsed IPN body
 * @param {string} rawBodyStr
 * @param {Object} context - { ip, userAgent }
 * @returns {Promise<{ ok: boolean, duplicate?: boolean, ignored?: boolean, action?: string }>}
 */
async function processPayoutIPN(body, rawBodyStr, context = {}) {
    const {
        auditNumber,  // our 16-digit reference — Pay2Pay sends this as 'auditNumber' in payout IPN
        audit: auditLegacy, // fallback for any future format changes
        txnId,
        status,
        orgAmount,  // Pay2Pay uses 'orgAmount' (not 'amount') in payout IPN
        amount: amountLegacy,
        code,
        message,
        txnDate,
    } = body;

    // Resolve audit ref — prefer auditNumber (confirmed field name from Pay2Pay payout IPN)
    const audit = auditNumber || auditLegacy;
    const amount = orgAmount || amountLegacy;

    const normalizedStatus = (status || '').toUpperCase();
    const payloadHash = crypto
        .createHash('sha256')
        .update(rawBodyStr || JSON.stringify(body), 'utf8')
        .digest('hex');

    logger.info('Pay2Pay payout IPN: processing', { audit, txnId, status: normalizedStatus, txnDate, amount });


    // ── Record event ──────────────────────────────────────────────────────────
    let gatewayEvent;
    try {
        gatewayEvent = await GatewayPaymentEvent.create({
            gateway_payment_id: null,
            gateway: GATEWAY_NAME,
            provider_event_id: txnId || null,
            event_type: `payout_ipn_${(status || 'unknown').toLowerCase()}`,
            payload_hash: payloadHash,
            merchant_reference_id: audit || null,
            provider_reference_id: txnId || null,
            processing_status: 'RECEIVED',
            processed_at: null,
            processing_error: null,
            payload: body,
            metadata: context,
        });
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            const existing = await GatewayPaymentEvent.findOne({
                where: { gateway: GATEWAY_NAME, payload_hash: payloadHash },
            });
            if (existing && existing.processing_status === 'PROCESSED') {
                logger.info('Pay2Pay payout IPN: duplicate, already processed', { audit, txnId });
                payoutLogger.logIPNResult(audit, 'duplicate_skipped', { txnId, status: normalizedStatus });
                return { ok: true, duplicate: true };
            }
            if (existing) gatewayEvent = existing;
            else throw err;
        } else {
            throw err;
        }
    }

    // ── Find MoneyRequest by audit (payout_ref) ───────────────────────────────
    const moneyRequest = await MoneyRequest.findOne({ where: { payout_ref: audit } });

    if (!moneyRequest) {
        await gatewayEvent.update({
            processing_status: 'IGNORED',
            processed_at: new Date(),
            processing_error: 'MoneyRequest not found for audit ref',
        });
        logger.warn('Pay2Pay payout IPN: MoneyRequest not found', { audit });
        payoutLogger.logIPNResult(audit, 'ignored_not_found', { txnId, status: normalizedStatus });
        return { ok: true, ignored: true, reason: 'money_request_not_found' };
    }

    // ── Link event to GatewayPayment ──────────────────────────────────────────
    if (moneyRequest.gateway_payment_id) {
        await gatewayEvent.update({ gateway_payment_id: moneyRequest.gateway_payment_id });
    }

    // ── Idempotency: skip if already in a final state ─────────────────────────
    if (moneyRequest.payout_status === 'SUCCESS' || moneyRequest.payout_status === 'FAILED') {
        await gatewayEvent.update({
            processing_status: 'IGNORED',
            processed_at: new Date(),
            processing_error: `Already in final payout_status: ${moneyRequest.payout_status}`,
        });
        logger.info('Pay2Pay payout IPN: already in final state, skipping', {
            audit,
            payout_status: moneyRequest.payout_status,
        });
        payoutLogger.logIPNResult(audit, 'ignored_final_state', { txnId, status: normalizedStatus, currentStatus: moneyRequest.payout_status });
        return { ok: true, duplicate: true };
    }

    const dbTransaction = await sequelize.transaction();
    let action = 'none';

    try {
        if (normalizedStatus === 'SUCCESS') {
            // ── Mark payout as successful ──────────────────────────────────────
            await moneyRequest.update({ payout_status: 'SUCCESS', payout_ref: txnId || audit }, { transaction: dbTransaction });

            // Update GatewayPayment
            if (moneyRequest.gateway_payment_id) {
                await GatewayPayment.update(
                    {
                        status: 'COMPLETED',
                        provider_reference_id: txnId || null,
                        provider_payload: { ipn: body },
                    },
                    { where: { id: moneyRequest.gateway_payment_id }, transaction: dbTransaction }
                );
            }

            action = 'marked_success';
            logger.info('Pay2Pay payout IPN: payout succeeded', { audit, txnId });

        } else if (normalizedStatus === 'FAIL') {
            // ── Refund the user's wallet ───────────────────────────────────────
            const targetAccountId = moneyRequest.target_account_id || moneyRequest.user_id;
            const targetAccountType = moneyRequest.target_account_type || 'live';
            const refundAmount = Math.abs(parseFloat(moneyRequest.amount));

            // Check for existing refund transaction to avoid double-refund
            const existingRefund = await UserTransaction.findOne({
                where: {
                    reference_id: `REFUND_${moneyRequest.request_id}`,
                    user_id: targetAccountId,
                    type: 'refund',
                },
                transaction: dbTransaction,
            });

            if (!existingRefund) {
                const AccountModel = getAccountModel(targetAccountType);
                const user = await AccountModel.findByPk(targetAccountId, {
                    transaction: dbTransaction,
                    lock: dbTransaction.LOCK.UPDATE,
                });

                if (!user) throw new Error(`User ${targetAccountType}/${targetAccountId} not found for refund`);

                const currentBalance = parseFloat(user.wallet_balance) || 0;
                const newBalance = Math.round((currentBalance + refundAmount) * 1e6) / 1e6;

                await user.update({ wallet_balance: newBalance }, { transaction: dbTransaction });

                const refundTxnId = await idGenerator.generateTransactionId();
                await UserTransaction.create({
                    transaction_id: refundTxnId,
                    user_id: targetAccountId,
                    user_type: targetAccountType,
                    type: 'refund',
                    amount: refundAmount,
                    balance_before: currentBalance,
                    balance_after: newBalance,
                    status: 'completed',
                    reference_id: `REFUND_${moneyRequest.request_id}`,
                    method_type: moneyRequest.method_type || 'OTHER',
                    notes: `Pay2Pay payout FAILED — auto-refund for ${moneyRequest.request_id}`,
                    metadata: {
                        originalMoneyRequestId: moneyRequest.id,
                        originalRequestId: moneyRequest.request_id,
                        payoutAudit: audit,
                        pay2payTxnId: txnId,
                        pay2payCode: code,
                        pay2payMessage: message,
                    },
                }, { transaction: dbTransaction });

                // Best-effort Redis balance update
                setImmediate(async () => {
                    try {
                        await redisUserCache.updateUser(targetAccountType, targetAccountId, { wallet_balance: newBalance });
                    } catch (cacheErr) {
                        logger.error('Pay2Pay payout: Redis cache update failed after refund', { error: cacheErr.message });
                    }
                });

                logger.info('Pay2Pay payout IPN: wallet refunded', {
                    userId: targetAccountId,
                    userType: targetAccountType,
                    refundAmount,
                    newBalance,
                    refundTxnId,
                });

                action = 'refunded';
            } else {
                logger.info('Pay2Pay payout IPN: refund already exists, skipping', { audit });
                action = 'refund_skipped_duplicate';
            }

            // Mark MoneyRequest as FAILED
            await moneyRequest.update(
                {
                    payout_status: 'FAILED',
                    notes: `${moneyRequest.notes ? moneyRequest.notes + ' | ' : ''}Pay2Pay payout FAILED: ${message || code || 'Unknown reason'}`,
                },
                { transaction: dbTransaction }
            );

            // Update GatewayPayment
            if (moneyRequest.gateway_payment_id) {
                await GatewayPayment.update(
                    {
                        status: 'FAILED',
                        provider_reference_id: txnId || null,
                        provider_payload: { ipn: body },
                    },
                    { where: { id: moneyRequest.gateway_payment_id }, transaction: dbTransaction }
                );
            }

        } else {
            // PROCESSING or unknown — just update payout_status
            await moneyRequest.update({ payout_status: 'PROCESSING' }, { transaction: dbTransaction });
            action = 'updated_processing';
        }

        await dbTransaction.commit();

        await gatewayEvent.update({
            processing_status: 'PROCESSED',
            processed_at: new Date(),
            processing_error: null,
        });

        logger.info('Pay2Pay payout IPN: processing complete', { audit, txnId, action });
        payoutLogger.logIPNResult(audit, action, { txnId, status: normalizedStatus });
        return { ok: true, action };

    } catch (err) {
        await dbTransaction.rollback();

        logger.error('Pay2Pay payout IPN: processing failed', {
            audit,
            txnId,
            error: err.message,
            stack: err.stack,
        });

        try {
            await gatewayEvent.update({
                processing_status: 'FAILED',
                processed_at: new Date(),
                processing_error: err.message,
            });
        } catch (updateErr) {
            logger.error('Pay2Pay payout IPN: failed to update event status', { error: updateErr.message });
        }

        throw err;
    }
}

// ─── Bank Account Name Lookup ──────────────────────────────────────────────────

/**
 * Look up the registered account holder name for a Vietnam bank account.
 * Calls: GET /bank-gateway-service/mch/api/v1.0/account-name
 *
 * @param {string} bankId       - Pay2Pay bank ID (from /banks list)
 * @param {string} bankRefNumber - Bank account number to look up
 * @returns {Promise<{ bankRefName: string, bankId: string, bankRefNumber: string }>}
 */
async function getBankAccountName(bankId, bankRefNumber) {
    if (!bankId || !bankRefNumber) {
        throw new Error('bankId and bankRefNumber are required for account name lookup');
    }

    const url = `${getDomain()}/bank-gateway-service/mch/api/v1.0/pob/get_name`;
    const params = { bankId: String(bankId), bankRefNumber: String(bankRefNumber) };

    logger.info('Pay2Pay: looking up bank account name', { url, bankId, bankRefNumber });

    const doFetch = async () => {
        const headers = await tokenService.buildRequestHeaders('');
        const response = await axios.get(url, { headers, params, timeout: 15000 });
        return response.data;
    };

    try {
        const data = await withTokenRetry(doFetch);

        if (!data || data.code !== 'SUCCESS') {
            throw new Error(
                `Pay2Pay account name lookup failed: ${data?.message || data?.code || JSON.stringify(data)}`
            );
        }

        // Pay2Pay returns the name at data.data.bankRefName (confirmed by docs)
        const bankRefName = data.data?.bankRefName || data.data?.accountName || data.data?.name;
        if (!bankRefName) {
            throw new Error('Pay2Pay returned SUCCESS but bankRefName was empty in the response');
        }

        logger.info('Pay2Pay: bank account name resolved', { bankId, bankRefNumber, bankRefName });
        return { bankRefName, bankId, bankRefNumber };
    } catch (err) {
        logger.error('Pay2Pay: bank account name lookup failed', {
            bankId,
            bankRefNumber,
            error: err.response ? err.response.data : err.message,
        });
        throw new Error(`Pay2Pay account name lookup error: ${err.message}`);
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    listBanks,
    invalidateBankListCache,
    getBankAccountName,
    payoutFeeBreakdown,
    dispatchPayout,
    verifyPayoutIPN,
    processPayoutIPN,
    generateAuditNumber,
    withTokenRetry,
    // Exposed for testing
    getVerifiedKey,
    executeTransfer247,
};
