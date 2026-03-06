'use strict';

/**
 * Pay2Pay Payment Service (Redirect Flow)
 *
 * Handles:
 *  - Creating a redirect deposit (user is sent to Pay2Pay's hosted payment page)
 *  - IPN (Instant Payment Notification) verification and processing
 *  - Configurable fee split: PAY2PAY_MERCHANT_FEE_SHARE_PERCENT (0-100) controls
 *    how much of the fee the platform absorbs (default 50%). Set to 100 to bear all.
 *  - Dynamic VND→USD conversion using live FX rate
 *  - Idempotent wallet crediting with row-level DB locking
 *  - Transaction status inquiry
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger.service');
const idGenerator = require('./idGenerator.service');
const redisUserCache = require('./redis.user.cache.service');
const tokenService = require('./pay2pay.token.service');
const fxService = require('./pay2pay.fx.service');
const sequelize = require('../config/db');
const {
    GatewayPayment,
    GatewayPaymentEvent,
    UserTransaction,
    LiveUser,
    StrategyProviderAccount,
    CopyFollowerAccount,
} = require('../models');

const GATEWAY_NAME = 'pay2pay';

// ─── Configuration Helpers ───────────────────────────────────────────────────

function getDomain() {
    return (process.env.PAY2PAY_DOMAIN || 'https://api.pay2pay.vn').replace(/\/$/, '');
}

function getApiKey() {
    return process.env.PAY2PAY_API_KEY || '';
}

function getIpnSecretKey() {
    return process.env.PAY2PAY_IPN_SECRET_KEY || '';
}

function getIpnUrl() {
    return process.env.PAY2PAY_IPN_URL || '';
}

function getReturnUrl() {
    return process.env.PAY2PAY_RETURN_URL || '';
}

function getMinAmountVnd() {
    return parseInt(process.env.PAY2PAY_MIN_AMOUNT_VND || '10000', 10);
}

function getMaxAmountVnd() {
    return parseInt(process.env.PAY2PAY_MAX_AMOUNT_VND || '500000000', 10);
}

/** Total fee % Pay2Pay charges per transaction (e.g. 0.5 means 0.5%). */
function getMerchantFeePercent() {
    return parseFloat(process.env.PAY2PAY_MERCHANT_FEE_PERCENT || '0.5');
}

/**
 * % of the total fee that the platform (merchant) bears, 0-100.
 * The remainder is deducted from the customer's credited USD amount.
 * Set to 100 to absorb the full fee; set to 50 for a 50/50 split.
 */
function getMerchantFeeSharePercent() {
    const raw = parseFloat(process.env.PAY2PAY_MERCHANT_FEE_SHARE_PERCENT);
    if (!Number.isFinite(raw)) return 50; // default 50/50
    return Math.min(100, Math.max(0, raw));
}

/** Merchant Key used for signing Collection-Redirect requests (SHA256+Base64). */
function getMerchantKey() {
    return process.env.PAY2PAY_MERCHANT_KEY || '';
}

/** Merchant ID (PP0000311 etc.) */
function getMerchantId() {
    return process.env.PAY2PAY_MERCHANT_ID || '';
}

/**
 * Generate the redirect signature required by Pay2Pay Collection-Redirect API.
 * Algorithm: SHA256(sortedParamString + merchantKey) → Base64
 *
 * Sorted param string is built from the request params sorted alphabetically by key,
 * then concatenated as key=value&key=value, then merchantKey appended.
 *
 * @param {Object} params - request body params (excluding signature field)
 * @param {string} merchantKey - PAY2PAY_MERCHANT_KEY
 * @returns {string} Base64-encoded SHA256 signature
 */
function computeRedirectSignature(params, merchantKey) {
    // Sort keys alphabetically, build query string
    const sortedKeys = Object.keys(params).sort();
    const paramStr = sortedKeys
        .filter(k => params[k] != null && params[k] !== '')
        .map(k => `${k}=${params[k]}`)
        .join('&');
    const input = paramStr + merchantKey;
    return crypto.createHash('sha256').update(input, 'utf8').digest('base64');
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function getAccountModel(userType) {
    switch ((userType || '').toString().toLowerCase()) {
        case 'strategy_provider': return StrategyProviderAccount;
        case 'copy_follower': return CopyFollowerAccount;
        case 'live':
        default: return LiveUser;
    }
}

/**
 * Map Pay2Pay IPN status codes to our internal statuses.
 * @param {string} pay2payStatus
 * @returns {string}
 */
function mapStatus(pay2payStatus) {
    switch ((pay2payStatus || '').toString().toUpperCase()) {
        case 'SUCCESS': return 'COMPLETED';
        case 'FAIL': return 'FAILED';
        case 'CANCELED':
        case 'CANCELLED': return 'CANCELLED';
        case 'PROCESSING': return 'PROCESSING';
        case 'SUSPECT': return 'PROCESSING'; // treat as pending manual review
        case 'INIT':
        default: return 'PENDING';
    }
}

/**
 * Compute the SHA-256-based IPN signature for verification.
 * Per Pay2Pay docs: SHA256(rawBodyString + secretKey) → Base64
 *
 * @param {string} rawBodyStr - exact raw request body string
 * @param {string} secretKey
 * @returns {string} Base64-encoded SHA-256 hash
 */
function computeIpnSignature(rawBodyStr, secretKey) {
    const input = `${rawBodyStr}${secretKey}`;
    return crypto.createHash('sha256').update(input, 'utf8').digest('base64');
}

// ─── Fee Calculation ─────────────────────────────────────────────────────────

/**
 * Calculate fee split amounts.
 *
 * The share that the platform bears is controlled by PAY2PAY_MERCHANT_FEE_SHARE_PERCENT
 * (0-100). The remainder is deducted from the customer's credited USD amount.
 *
 *   merchantSharePct = 100 → platform absorbs full fee, customer gets grossUsd
 *   merchantSharePct = 50  → 50/50 split (default)
 *   merchantSharePct = 0   → customer bears the entire fee
 *
 * @param {number} vndAmount - original VND amount paid by customer
 * @param {number} rate - VND→USD rate
 * @param {number|null} ipnFeeVnd - fee in VND if provided by IPN (null to estimate)
 * @returns {{ grossUsd, totalFeeVnd, totalFeeUsd, merchantFeeUsd, customerFeeUsd, creditUsd, merchantSharePct }}
 */
function calculateFees(vndAmount, rate, ipnFeeVnd = null) {
    const grossUsd = vndAmount * rate;

    let totalFeeVnd;
    if (ipnFeeVnd != null && ipnFeeVnd >= 0) {
        totalFeeVnd = ipnFeeVnd;
    } else {
        // Estimate from configured fee %
        const feePercent = getMerchantFeePercent();
        totalFeeVnd = Math.round(vndAmount * (feePercent / 100));
    }

    const totalFeeUsd = totalFeeVnd * rate;
    const merchantSharePct = getMerchantFeeSharePercent(); // 0-100
    const merchantFeeUsd = totalFeeUsd * (merchantSharePct / 100); // platform absorbs
    const customerFeeUsd = totalFeeUsd * (1 - merchantSharePct / 100); // deducted from credit

    const creditUsd = Math.max(0, grossUsd - customerFeeUsd);

    return {
        grossUsd: Math.round(grossUsd * 1e6) / 1e6,
        totalFeeVnd,
        totalFeeUsd: Math.round(totalFeeUsd * 1e6) / 1e6,
        merchantFeeUsd: Math.round(merchantFeeUsd * 1e6) / 1e6,
        customerFeeUsd: Math.round(customerFeeUsd * 1e6) / 1e6,
        creditUsd: Math.round(creditUsd * 1e6) / 1e6,
        merchantSharePct,
    };
}

// ─── Redirect Deposit ─────────────────────────────────────────────────────────

/**
 * Create a redirect-based deposit with Pay2Pay.
 * Returns a paymentUrl that the frontend should redirect the user to.
 *
 * @param {Object} params
 * @param {number} params.userId - target account ID
 * @param {string} params.userType - 'live' | 'strategy_provider' | 'copy_follower'
 * @param {number|null} params.initiatorUserId
 * @param {string|null} params.initiatorUserType
 * @param {number} params.amountVnd - payment amount in VND (integer)
 * @param {string} [params.description]
 * @returns {Promise<{ merchantReferenceId, paymentUrl, txnId, amount, currency, fxRate, estimatedUsd }>}
 */
async function createRedirectDeposit(params) {
    const {
        userId,
        userType,
        initiatorUserId,
        initiatorUserType,
        amountVnd,
        description,
    } = params;

    // ── Validate amount ──────────────────────────────────────────────────────
    const intAmount = Math.round(Number(amountVnd));
    if (!Number.isFinite(intAmount) || intAmount <= 0) {
        throw new Error('amount_vnd must be a positive integer');
    }
    const minVnd = getMinAmountVnd();
    const maxVnd = getMaxAmountVnd();
    if (intAmount < minVnd) {
        throw new Error(`Minimum deposit amount is ${minVnd.toLocaleString()} VND`);
    }
    if (intAmount > maxVnd) {
        throw new Error(`Maximum deposit amount is ${maxVnd.toLocaleString()} VND`);
    }

    if (!tokenService.isEnabled()) {
        throw new Error('Pay2Pay is not configured. Missing required credentials.');
    }

    // ── Fetch FX rate & estimate USD ─────────────────────────────────────────
    const fxRate = await fxService.getVndToUsdRate();
    const feeEstimate = calculateFees(intAmount, fxRate, null);

    // ── Generate merchant reference ID ───────────────────────────────────────
    const merchantReferenceId = GatewayPayment.generateMerchantReferenceId();

    // ── Build Pay2Pay redirect request body ──────────────────────────────────
    // Uses the Redirect Collection API endpoint
    const ipnUrl = getIpnUrl();
    const returnUrl = getReturnUrl();

    if (!ipnUrl) {
        throw new Error('PAY2PAY_IPN_URL is not configured.');
    }
    if (!returnUrl) {
        throw new Error('PAY2PAY_RETURN_URL is not configured.');
    }

    const merchantId = getMerchantId();
    const merchantKey = getMerchantKey();

    if (!merchantKey) {
        throw new Error('PAY2PAY_MERCHANT_KEY is not configured. Required for redirect flow.');
    }

    // Build request body WITHOUT signature first (signature is computed over these params)
    const requestBody = {
        merchantId,
        currency: 'VND',
        amount: intAmount,
        orderId: merchantReferenceId,
        orderDesc: description || 'LiveFXHub wallet deposit',
        returnUrl,
        ipnUrl,
        paymentMethod: process.env.PAY2PAY_DEFAULT_PAYMENT_METHOD || 'QRBANK',
    };

    // Add Merchant Key signature for redirect flow (SHA256 of sorted params + merchantKey → base64)
    const redirectSignature = computeRedirectSignature(requestBody, merchantKey);
    requestBody.signature = redirectSignature;

    const bodyStr = JSON.stringify(requestBody);
    const headers = await tokenService.buildRequestHeaders(bodyStr);

    // ── Call Pay2Pay redirect initialize endpoint ─────────────────────────────
    const url = `${getDomain()}/pgw-transaction-service/mch/api/v1.0/redirectUrl`;

    logger.info('Pay2Pay: calling redirect initialize', {
        merchantReferenceId,
        amountVnd: intAmount,
        url,
    });

    let providerResponse;
    try {
        const response = await axios.post(url, requestBody, { headers, timeout: 20000 });
        providerResponse = response.data;
    } catch (err) {
        const errData = err.response && err.response.data;
        logger.error('Pay2Pay: redirect initialize API error', {
            merchantReferenceId,
            error: err.message,
            response: errData,
        });
        throw new Error(
            `Pay2Pay API error: ${errData ? JSON.stringify(errData) : err.message}`
        );
    }

    if (!providerResponse || providerResponse.code !== 'SUCCESS') {
        throw new Error(`Pay2Pay returned non-SUCCESS: ${JSON.stringify(providerResponse)}`);
    }

    const paymentUrl =
        providerResponse.data && (providerResponse.data.paymentUrl || providerResponse.data.redirectUrl);

    if (!paymentUrl) {
        throw new Error('Pay2Pay did not return a paymentUrl in response');
    }

    const txnId = providerResponse.data && providerResponse.data.txnId;

    // ── Persist GatewayPayment record ─────────────────────────────────────────
    const gatewayPayment = await GatewayPayment.create({
        merchant_reference_id: merchantReferenceId,
        gateway: GATEWAY_NAME,
        purpose: 'deposit',
        status: 'PENDING',
        user_id: userId,
        user_type: userType,
        initiator_user_id: initiatorUserId || null,
        initiator_user_type: initiatorUserType || null,
        requested_amount: intAmount,
        requested_currency: 'VND',
        settled_currency: 'USD',
        provider_reference_id: txnId || null,
        provider_payload: {
            initResponse: providerResponse.data,
        },
        metadata: {
            fxRateAtCreation: fxRate,
            estimatedGrossUsd: feeEstimate.grossUsd,
            estimatedCustomerFeeUsd: feeEstimate.customerFeeUsd,
            estimatedMerchantFeeUsd: feeEstimate.merchantFeeUsd,
            estimatedCreditUsd: feeEstimate.creditUsd,
            description,
        },
    });

    logger.info('Pay2Pay: deposit created', {
        id: gatewayPayment.id,
        merchantReferenceId,
        amountVnd: intAmount,
        paymentUrl,
        userId,
        userType,
    });

    return {
        merchantReferenceId,
        paymentUrl,
        txnId: txnId || null,
        amount: intAmount,
        currency: 'VND',
        fxRate,
        estimatedUsd: feeEstimate.creditUsd,
        estimatedGrossUsd: feeEstimate.grossUsd,
        estimatedCustomerFeeUsd: feeEstimate.customerFeeUsd,
        gatewayPaymentId: gatewayPayment.id,
    };
}

// ─── IPN Verification ─────────────────────────────────────────────────────────

/**
 * Verify the authenticity of an IPN request from Pay2Pay.
 *
 * @param {Object} headers - raw HTTP request headers (lowercased)
 * @param {string} rawBodyStr - exact raw body string received (not re-serialized)
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyIPN(headers, rawBodyStr) {
    const apiKey = getApiKey();
    const secretKey = getIpnSecretKey();

    if (!apiKey || !secretKey) {
        logger.error('Pay2Pay IPN: PAY2PAY_API_KEY or PAY2PAY_IPN_SECRET_KEY not configured');
        return { valid: false, error: 'Gateway not configured' };
    }

    // Check API key header (Pay2Pay sends P-API-KEY)
    const receivedApiKey =
        headers['p-api-key'] || headers['P-API-KEY'] || '';

    if (receivedApiKey !== apiKey) {
        logger.warn('Pay2Pay IPN: invalid P-API-KEY', { received: receivedApiKey });
        return { valid: false, error: 'Invalid API key' };
    }

    // Verify signature
    const receivedSignature =
        headers['p-signature'] || headers['P-SIGNATURE'] || '';

    const expectedSignature = computeIpnSignature(rawBodyStr, secretKey);

    if (receivedSignature !== expectedSignature) {
        logger.warn('Pay2Pay IPN: signature mismatch', {
            expected: expectedSignature,
            received: receivedSignature,
        });
        return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true };
}

// ─── IPN Processing ───────────────────────────────────────────────────────────

/**
 * Process a verified IPN notification from Pay2Pay.
 * Idempotent: safe to call multiple times for the same event.
 *
 * @param {Object} body - parsed IPN body
 * @param {string} rawBodyStr - raw body for hashing
 * @param {Object} context - { ip, userAgent }
 * @returns {Promise<{ ok: boolean, duplicate?: boolean, ignored?: boolean, reason?: string }>}
 */
async function processIPN(body, rawBodyStr, context = {}) {
    const {
        merchantId,
        orderId,       // = our merchant_reference_id
        txnId,         // = Pay2Pay's transaction ID
        amount,        // VND amount
        status,        // SUCCESS | FAIL | PROCESSING | ...
        code,
        message,
        txnDate,
    } = body;

    const internalStatus = mapStatus(status);
    const payloadHash = crypto
        .createHash('sha256')
        .update(rawBodyStr || JSON.stringify(body), 'utf8')
        .digest('hex');

    // ── Record IPN event ──────────────────────────────────────────────────────
    let gatewayEvent;
    try {
        gatewayEvent = await GatewayPaymentEvent.create({
            gateway_payment_id: null, // will update after finding the payment
            gateway: GATEWAY_NAME,
            provider_event_id: txnId || null,
            event_type: `ipn_${(status || 'unknown').toLowerCase()}`,
            payload_hash: payloadHash,
            merchant_reference_id: orderId || null,
            provider_reference_id: txnId || null,
            processing_status: 'RECEIVED',
            processed_at: null,
            processing_error: null,
            payload: body,
            metadata: context,
        });
    } catch (err) {
        // Deduplicate: if same hash already exists and was processed, skip
        if (err.name === 'SequelizeUniqueConstraintError') {
            const existing = await GatewayPaymentEvent.findOne({
                where: { gateway: GATEWAY_NAME, payload_hash: payloadHash },
            });
            if (existing && existing.processing_status === 'PROCESSED') {
                logger.info('Pay2Pay IPN: duplicate event, already processed', { orderId, txnId });
                return { ok: true, duplicate: true };
            }
            if (existing) gatewayEvent = existing;
            else throw err;
        } else {
            throw err;
        }
    }

    // ── Find GatewayPayment ───────────────────────────────────────────────────
    const dbTransaction = await sequelize.transaction();

    try {
        const payment = await GatewayPayment.findOne({
            where: { merchant_reference_id: orderId, gateway: GATEWAY_NAME },
            transaction: dbTransaction,
            lock: dbTransaction.LOCK.UPDATE,
        });

        if (!payment) {
            await dbTransaction.commit();
            await gatewayEvent.update({
                processing_status: 'IGNORED',
                processed_at: new Date(),
                processing_error: 'Payment record not found',
            });
            logger.warn('Pay2Pay IPN: payment not found', { orderId, txnId });
            return { ok: true, ignored: true, reason: 'payment_not_found' };
        }

        // Link event to payment
        await gatewayEvent.update({ gateway_payment_id: payment.id });

        // ── Idempotency guard ─────────────────────────────────────────────────
        if (payment.status === 'COMPLETED') {
            await dbTransaction.commit();
            await gatewayEvent.update({
                processing_status: 'IGNORED',
                processed_at: new Date(),
                processing_error: 'Payment already COMPLETED',
            });
            logger.info('Pay2Pay IPN: already completed, skipping', { orderId, txnId });
            return { ok: true, duplicate: true };
        }

        // ── Fetch live FX rate for crediting ─────────────────────────────────
        const fxRate = await fxService.getVndToUsdRate();
        const vndAmount = parseFloat(amount) || 0;

        // Fee: use amount from IPN if available (fee field), else estimate
        const ipnFeeVnd = body.fee != null ? parseFloat(body.fee) : null;
        const fees = calculateFees(vndAmount, fxRate, ipnFeeVnd);

        // ── Credit wallet on SUCCESS ──────────────────────────────────────────
        let walletCreditSuccess = false;
        let creditResult = null;

        if (internalStatus === 'COMPLETED') {
            // Final idempotency: check if UserTransaction already created
            const existingTxn = await UserTransaction.findOne({
                where: {
                    reference_id: payment.merchant_reference_id,
                    user_id: payment.user_id,
                    user_type: payment.user_type,
                    type: 'deposit',
                },
                transaction: dbTransaction,
            });

            if (!existingTxn) {
                if (fees.creditUsd <= 0) {
                    throw new Error(
                        `Credit amount (${fees.creditUsd} USD) is too low after fee deduction`
                    );
                }

                creditResult = await creditUserWallet(
                    payment,
                    fees.creditUsd,
                    fees,
                    body,
                    fxRate,
                    dbTransaction
                );
                walletCreditSuccess = true;
            } else {
                logger.info('Pay2Pay IPN: wallet already credited, skipping', { orderId });
            }
        }

        // ── Update GatewayPayment ─────────────────────────────────────────────
        await payment.update({
            status: internalStatus,
            paid_amount: vndAmount > 0 ? vndAmount : payment.paid_amount,
            paid_currency: 'VND',
            settled_amount: fees.grossUsd,
            settled_currency: 'USD',
            credited_amount: walletCreditSuccess ? fees.creditUsd : payment.credited_amount,
            credited_currency: 'USD',
            exchange_rate: fxRate,
            fee_amount: fees.totalFeeUsd,
            fee_currency: 'USD',
            provider_reference_id: txnId || payment.provider_reference_id,
            transaction_id: creditResult ? creditResult.transactionId : payment.transaction_id,
            provider_payload: {
                ...(payment.provider_payload || {}),
                ipn: body,
            },
            metadata: {
                ...(payment.metadata || {}),
                fxRateAtSettlement: fxRate,
                grossUsd: fees.grossUsd,
                totalFeeVnd: fees.totalFeeVnd,
                totalFeeUsd: fees.totalFeeUsd,
                merchantFeeUsd: fees.merchantFeeUsd,
                customerFeeUsd: fees.customerFeeUsd,
                txnDate,
                pay2payCode: code,
                pay2payMessage: message,
            },
        }, { transaction: dbTransaction });

        await dbTransaction.commit();

        // ── Mark event as processed ───────────────────────────────────────────
        await gatewayEvent.update({
            processing_status: 'PROCESSED',
            processed_at: new Date(),
            processing_error: null,
        });

        logger.info('Pay2Pay IPN: processed successfully', {
            orderId,
            txnId,
            internalStatus,
            vndAmount,
            creditUsd: fees.creditUsd,
            walletCredited: walletCreditSuccess,
        });

        return { ok: true, internalStatus, walletCredited: walletCreditSuccess };
    } catch (err) {
        await dbTransaction.rollback();

        logger.error('Pay2Pay IPN: processing failed', {
            orderId,
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
            logger.error('Pay2Pay IPN: failed to update event status', { error: updateErr.message });
        }

        throw err;
    }
}

// ─── Wallet Crediting ─────────────────────────────────────────────────────────

/**
 * Credit a user's wallet with the net USD amount after fee deduction.
 *
 * @param {GatewayPayment} payment
 * @param {number} creditUsd - amount to credit in USD
 * @param {Object} fees - fee breakdown
 * @param {Object} ipnBody - raw IPN body
 * @param {number} fxRate - VND→USD rate used
 * @param {SequelizeTransaction} transaction - DB transaction
 * @returns {Promise<{ transactionId, previousBalance, newBalance }>}
 */
async function creditUserWallet(payment, creditUsd, fees, ipnBody, fxRate, transaction) {
    const AccountModel = getAccountModel(payment.user_type);
    const user = await AccountModel.findByPk(payment.user_id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
    });

    if (!user) {
        throw new Error(`${payment.user_type} user not found with ID: ${payment.user_id}`);
    }

    const currentBalance = parseFloat(user.wallet_balance) || 0;
    const newBalance = Math.round((currentBalance + creditUsd) * 1e6) / 1e6;

    await user.update({ wallet_balance: newBalance }, { transaction });

    const transactionId = await idGenerator.generateTransactionId();

    await UserTransaction.create({
        transaction_id: transactionId,
        user_id: payment.user_id,
        user_type: payment.user_type,
        type: 'deposit',
        amount: creditUsd,
        balance_before: currentBalance,
        balance_after: newBalance,
        status: 'completed',
        reference_id: payment.merchant_reference_id,
        user_email: user.email,
        method_type: 'OTHER',
        notes: `Pay2Pay VND deposit - ${creditUsd.toFixed(6)} USD credited`,
        metadata: {
            paymentGateway: GATEWAY_NAME,
            merchant_reference_id: payment.merchant_reference_id,
            pay2pay_txn_id: ipnBody.txnId,
            vnd_amount: ipnBody.amount,
            fx_rate: fxRate,
            gross_usd: fees.grossUsd,
            total_fee_vnd: fees.totalFeeVnd,
            total_fee_usd: fees.totalFeeUsd,
            merchant_fee_usd: fees.merchantFeeUsd,
            customer_fee_usd: fees.customerFeeUsd,
            credit_usd: creditUsd,
            sender_bank_id: ipnBody.senderBankId,
            sender_bank_name: ipnBody.senderBankName,
            sender_bank_ref_name: ipnBody.senderBankRefName,
        },
    }, { transaction });

    // Update Redis cache (best-effort, non-blocking)
    try {
        await redisUserCache.updateUser(payment.user_type, payment.user_id, {
            wallet_balance: newBalance,
        });
    } catch (cacheErr) {
        logger.error('Pay2Pay: failed to update Redis cache after wallet credit', {
            userId: payment.user_id,
            error: cacheErr.message,
        });
    }

    logger.info('Pay2Pay: wallet credited', {
        userId: payment.user_id,
        userType: payment.user_type,
        creditUsd,
        previousBalance: currentBalance,
        newBalance,
        transactionId,
    });

    return { transactionId, previousBalance: currentBalance, newBalance };
}

// ─── Transaction Inquiry ──────────────────────────────────────────────────────

/**
 * Query Pay2Pay for the current status of a transaction.
 * Uses the v2 inquiry endpoint.
 *
 * @param {string} merchantReferenceId - our order ID sent to Pay2Pay
 * @returns {Promise<Object>} Pay2Pay inquiry response data
 */
async function inquiryStatus(merchantReferenceId) {
    const requestBody = { orderId: merchantReferenceId };
    const bodyStr = JSON.stringify(requestBody);
    const headers = await tokenService.buildRequestHeaders(bodyStr);

    const url = `${getDomain()}/pgw-transaction-service/mch/api/v2.0/inquiry`;

    logger.info('Pay2Pay: querying transaction status', { merchantReferenceId, url });

    try {
        const response = await axios.post(url, requestBody, { headers, timeout: 15000 });
        const data = response.data;

        if (!data || data.code !== 'SUCCESS') {
            logger.warn('Pay2Pay inquiry returned non-SUCCESS', { data });
        }

        return data;
    } catch (err) {
        const errData = err.response && err.response.data;
        logger.error('Pay2Pay inquiry failed', {
            merchantReferenceId,
            error: err.message,
            response: errData,
        });
        throw new Error(`Pay2Pay inquiry error: ${errData ? JSON.stringify(errData) : err.message}`);
    }
}

// ─── Payment Lookup ───────────────────────────────────────────────────────────

/**
 * Find a GatewayPayment by merchant reference ID.
 * @param {string} merchantReferenceId
 * @returns {Promise<GatewayPayment>}
 */
async function getPaymentByMerchantReferenceId(merchantReferenceId) {
    const payment = await GatewayPayment.findOne({
        where: { merchant_reference_id: merchantReferenceId, gateway: GATEWAY_NAME },
    });
    if (!payment) throw new Error('Payment not found');
    return payment;
}

/**
 * Check if Pay2Pay is enabled (i.e., configured).
 * @returns {boolean}
 */
function isEnabled() {
    return tokenService.isEnabled();
}

module.exports = {
    createRedirectDeposit,
    verifyIPN,
    processIPN,
    inquiryStatus,
    getPaymentByMerchantReferenceId,
    isEnabled,
    computeIpnSignature,
    calculateFees,
    mapStatus,
};
