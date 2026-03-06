'use strict';

/**
 * Pay2Pay Payment Controller
 *
 * Handles:
 *  - POST /deposit    → create redirect-based VND deposit (Vietnam users only)
 *  - POST /ipn        → Pay2Pay Instant Payment Notification callback
 *  - GET  /return     → user redirect-back handler (after pay on Pay2Pay page)
 *  - GET  /methods    → available deposit methods + FX rate info
 *  - GET  /:refId     → lookup payment by merchant reference ID
 */

const pay2payService = require('../services/pay2pay.payment.service');
const fxService = require('../services/pay2pay.fx.service');
const logger = require('../utils/logger');
const { LiveUser, StrategyProviderAccount, CopyFollowerAccount } = require('../models');

const SUPPORTED_USER_TYPES = ['live', 'strategy_provider', 'copy_follower'];

// ─── Auth Helpers (mirrors stripe controller) ─────────────────────────────────

class DepositValidationError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function getAuthContext(req) {
    const user = req.user || {};
    const rawUserId = user.sub || user.user_id || user.id;
    const strategyProviderId = user.strategy_provider_id;
    return {
        authUserId: rawUserId ? parseInt(rawUserId, 10) : null,
        authAccountType: (user.account_type || user.user_type || 'live').toString().toLowerCase(),
        strategyProviderId: strategyProviderId ? parseInt(strategyProviderId, 10) : null,
        isActive: user.is_active === undefined ? true : !!user.is_active,
    };
}

/**
 * Resolve and validate the deposit target, returning userId + userType + initiator.
 * Mirrors the logic in stripe.payment.controller with the same ownership rules.
 */
async function resolveDepositTarget(userId, userType, authContext) {
    if (!SUPPORTED_USER_TYPES.includes(userType)) {
        throw new DepositValidationError('Invalid user_type. Allowed: live, strategy_provider, copy_follower');
    }

    const parsedTargetId = parseInt(userId, 10);
    if (Number.isNaN(parsedTargetId) || parsedTargetId <= 0) {
        throw new DepositValidationError('user_id must be a positive integer');
    }

    if (!authContext.isActive) {
        throw new DepositValidationError('Authenticated account is inactive', 401);
    }

    switch (userType) {
        case 'live': {
            if (!authContext.authUserId || authContext.authUserId !== parsedTargetId) {
                throw new DepositValidationError('You can only deposit into your own live account', 403);
            }

            const isLiveSession = authContext.authAccountType === 'live';
            const isStrategySession = authContext.authAccountType === 'strategy_provider';

            if (!isLiveSession && !isStrategySession) {
                throw new DepositValidationError('You can only deposit into your own live account', 403);
            }

            let initiatorUserId = parsedTargetId;
            let initiatorUserType = 'live';

            if (isStrategySession) {
                if (!authContext.strategyProviderId) {
                    throw new DepositValidationError('Strategy provider context missing from token', 403);
                }
                const strategyAccount = await StrategyProviderAccount.findByPk(authContext.strategyProviderId, {
                    attributes: ['id', 'user_id', 'status', 'is_active', 'is_archived'],
                });
                if (!strategyAccount || strategyAccount.user_id !== parsedTargetId) {
                    throw new DepositValidationError('Strategy provider token not linked to this live account', 403);
                }
                if (strategyAccount.is_archived || strategyAccount.status !== 1 || strategyAccount.is_active !== 1) {
                    throw new DepositValidationError('Strategy provider account is inactive or archived');
                }
                initiatorUserId = strategyAccount.id;
                initiatorUserType = 'strategy_provider';
            }

            const liveUser = await LiveUser.findByPk(parsedTargetId, { attributes: ['id', 'status', 'is_active'] });
            if (!liveUser || liveUser.status !== 1 || liveUser.is_active !== 1) {
                throw new DepositValidationError('Live user account is inactive or not found');
            }

            return { targetUserId: parsedTargetId, targetUserType: 'live', initiatorUserId, initiatorUserType };
        }

        case 'strategy_provider': {
            const strategyAccount = await StrategyProviderAccount.findByPk(parsedTargetId, {
                attributes: ['id', 'user_id', 'status', 'is_active', 'is_archived'],
            });
            if (!strategyAccount) throw new DepositValidationError('Strategy provider account not found');
            if (strategyAccount.is_archived || strategyAccount.status !== 1 || strategyAccount.is_active !== 1) {
                throw new DepositValidationError('Strategy provider account is inactive or archived');
            }

            const ownsAsProvider = authContext.authAccountType === 'strategy_provider'
                && authContext.strategyProviderId === strategyAccount.id;
            const ownsAsLiveUser = authContext.authAccountType === 'live'
                && authContext.authUserId === strategyAccount.user_id;

            if (!ownsAsProvider && !ownsAsLiveUser) {
                throw new DepositValidationError('Not authorized to deposit into this strategy provider account', 403);
            }

            return {
                targetUserId: parsedTargetId,
                targetUserType: 'strategy_provider',
                initiatorUserId: ownsAsProvider ? strategyAccount.id : authContext.authUserId,
                initiatorUserType: ownsAsProvider ? 'strategy_provider' : 'live',
            };
        }

        case 'copy_follower': {
            const followerAccount = await CopyFollowerAccount.findByPk(parsedTargetId, {
                attributes: ['id', 'user_id', 'status', 'is_active'],
            });
            if (!followerAccount) throw new DepositValidationError('Copy follower account not found');
            if (followerAccount.status !== 1 || followerAccount.is_active !== 1) {
                throw new DepositValidationError('Copy follower account is inactive');
            }
            if (authContext.authAccountType !== 'live' || authContext.authUserId !== followerAccount.user_id) {
                throw new DepositValidationError('Not authorized to deposit into this copy follower account', 403);
            }

            return {
                targetUserId: parsedTargetId,
                targetUserType: 'copy_follower',
                initiatorUserId: authContext.authUserId,
                initiatorUserType: 'live',
            };
        }

        default:
            throw new DepositValidationError('Unsupported user_type');
    }
}

// ─── Vietnam Country Check ─────────────────────────────────────────────────────

/**
 * Resolve the underlying live user for any account type:
 *  - 'live' → the user directly
 *  - 'strategy_provider' → linked live user (via user_id)
 *  - 'copy_follower' → linked live user (via user_id)
 *
 * @param {number} userId
 * @param {string} userType
 * @returns {Promise<LiveUser>}
 */
async function resolveLinkedLiveUser(userId, userType) {
    const normalized = (userType || '').toLowerCase();

    if (normalized === 'live') {
        return LiveUser.findByPk(userId, { attributes: ['id', 'country', 'country_id'] });
    }

    if (normalized === 'strategy_provider') {
        const account = await StrategyProviderAccount.findByPk(userId, { attributes: ['user_id'] });
        if (!account) return null;
        return LiveUser.findByPk(account.user_id, { attributes: ['id', 'country', 'country_id'] });
    }

    if (normalized === 'copy_follower') {
        const account = await CopyFollowerAccount.findByPk(userId, { attributes: ['user_id'] });
        if (!account) return null;
        return LiveUser.findByPk(account.user_id, { attributes: ['id', 'country', 'country_id'] });
    }

    return null;
}

function isVietnamCountry(liveUser) {
    if (!liveUser) return false;
    const country = (liveUser.country || '').trim().toLowerCase();
    if (country === 'vietnam' || country === 'viet nam' || country === 'việt nam') return true;
    return false;
}

// ─── Controller Methods ────────────────────────────────────────────────────────

class Pay2PayController {

    /**
     * POST /deposit
     * Request body: { amount_vnd: number, user_id, user_type, description? }
     */
    async createDeposit(req, res) {
        try {
            if (!pay2payService.isEnabled()) {
                return res.status(503).json({ status: false, message: 'Pay2Pay gateway is not configured' });
            }

            const body = req.body || {};
            const { amount_vnd, user_id, user_type, description } = body;

            if (!amount_vnd || !user_id || !user_type) {
                return res.status(400).json({
                    status: false,
                    message: 'Missing required fields: amount_vnd, user_id, user_type',
                });
            }

            const rawAmount = Number(amount_vnd);
            if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
                return res.status(400).json({ status: false, message: 'amount_vnd must be a positive number' });
            }

            const authContext = getAuthContext(req);
            if (!authContext.authUserId && !authContext.strategyProviderId) {
                return res.status(401).json({ status: false, message: 'Authentication required' });
            }

            const ownership = await resolveDepositTarget(
                user_id,
                user_type.toString().toLowerCase(),
                authContext
            );

            // ── Vietnam restriction ──────────────────────────────────────────────
            const liveUser = await resolveLinkedLiveUser(ownership.targetUserId, ownership.targetUserType);
            if (!liveUser) {
                return res.status(400).json({ status: false, message: 'User account not found' });
            }
            if (!isVietnamCountry(liveUser)) {
                return res.status(403).json({
                    status: false,
                    message: 'Pay2Pay deposits are only available to users based in Vietnam',
                });
            }

            // ── Create redirect deposit ──────────────────────────────────────────
            const result = await pay2payService.createRedirectDeposit({
                userId: ownership.targetUserId,
                userType: ownership.targetUserType,
                initiatorUserId: ownership.initiatorUserId,
                initiatorUserType: ownership.initiatorUserType,
                amountVnd: rawAmount,
                description,
            });

            logger.info('Pay2Pay: deposit initiated', {
                userId: ownership.targetUserId,
                userType: ownership.targetUserType,
                merchantReferenceId: result.merchantReferenceId,
                amountVnd: rawAmount,
            });

            return res.status(200).json({
                status: true,
                message: 'Pay2Pay deposit initiated. Redirect user to paymentUrl to complete payment.',
                data: result,
            });
        } catch (err) {
            logger.error('Pay2Pay createDeposit error', { error: err.message, body: req.body });

            const statusCode = err instanceof DepositValidationError && err.statusCode
                ? err.statusCode
                : 500;

            return res.status(statusCode).json({
                status: false,
                message: err.message || 'Failed to create Pay2Pay deposit',
            });
        }
    }

    /**
     * POST /ipn
     * Pay2Pay server-to-server notification. Always returns HTTP 200.
     */
    async handleIPN(req, res) {
        const rawBodyStr = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

        logger.info('Pay2Pay IPN received', {
            ip: req.ip,
            headers: {
                'p-api-key': req.headers['p-api-key'],
                'p-signature': req.headers['p-signature'],
            },
            bodyKeys: Object.keys(req.body || {}),
        });

        // ── Verify signature ───────────────────────────────────────────────────
        const verification = pay2payService.verifyIPN(
            req.headers,
            rawBodyStr
        );

        if (!verification.valid) {
            logger.warn('Pay2Pay IPN: rejected - invalid signature', { error: verification.error });
            // Return 200 to prevent Pay2Pay infinite retries; log internally
            return res.status(200).json({ code: 'SIGNATURE_INVALID', message: 'Invalid signature' });
        }

        // ── Process the notification ───────────────────────────────────────────
        try {
            const result = await pay2payService.processIPN(
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
            logger.error('Pay2Pay IPN: processing error', { error: err.message, stack: err.stack });
            // Return 200 to Pay2Pay — internal error, don't trigger retries
            return res.status(200).json({ code: 'INTERNAL_ERROR', message: 'Processing failed' });
        }
    }

    /**
     * GET /return
     * User redirect-back URL after completing (or abandoning) payment on Pay2Pay.
     * Pay2Pay appends query params: orderId, txnId, status, etc.
     */
    async handleReturn(req, res) {
        const { orderId, txnId, status, code, message } = req.query;

        logger.info('Pay2Pay return redirect', { orderId, txnId, status, code, ip: req.ip });

        // Look up the payment to return meaningful info
        let paymentStatus = 'PENDING';
        let gatewayPaymentId = null;

        if (orderId) {
            try {
                const payment = await pay2payService.getPaymentByMerchantReferenceId(orderId);
                paymentStatus = payment.status;
                gatewayPaymentId = payment.id;
            } catch (err) {
                logger.warn('Pay2Pay return: payment not found', { orderId });
            }
        }

        return res.status(200).json({
            status: true,
            message: 'Payment return received',
            data: {
                merchantReferenceId: orderId || null,
                txnId: txnId || null,
                payStatus: paymentStatus,
                pay2payStatus: status || null,
                pay2payCode: code || null,
                pay2payMessage: message || null,
                gatewayPaymentId,
            },
        });
    }

    /**
     * GET /methods
     * Returns Pay2Pay deposit info, supported payment methods, and current FX rate.
     */
    async getMethods(req, res) {
        try {
            const fxRate = await fxService.getVndToUsdRate();
            const feePercent = parseFloat(process.env.PAY2PAY_MERCHANT_FEE_PERCENT || '0.5');
            const minVnd = parseInt(process.env.PAY2PAY_MIN_AMOUNT_VND || '10000', 10);
            const maxVnd = parseInt(process.env.PAY2PAY_MAX_AMOUNT_VND || '500000000', 10);

            return res.status(200).json({
                status: true,
                message: 'Pay2Pay deposit methods',
                data: {
                    gateway: 'pay2pay',
                    currency: 'VND',
                    minAmountVnd: minVnd,
                    maxAmountVnd: maxVnd,
                    fxRate,
                    fxCurrencyPair: 'VND→USD',
                    feeInfo: {
                        totalFeePercent: feePercent,
                        merchantBears: `${(feePercent / 2).toFixed(2)}%`,
                        customerBears: `${(feePercent / 2).toFixed(2)}%`,
                    },
                    methods: [
                        { code: 'QRBANK', name: 'QR Bank Transfer', description: 'Pay via VietQR with any Vietnamese bank' },
                    ],
                    restriction: 'Available for Vietnamese users only',
                    enabled: pay2payService.isEnabled(),
                },
            });
        } catch (err) {
            logger.error('Pay2Pay getMethods error', { error: err.message });
            return res.status(500).json({ status: false, message: 'Failed to fetch Pay2Pay methods' });
        }
    }

    /**
     * GET /:merchantReferenceId
     * Look up a payment record by merchant reference ID.
     */
    async getPayment(req, res) {
        const { merchantReferenceId } = req.params;

        if (!merchantReferenceId) {
            return res.status(400).json({ status: false, message: 'merchantReferenceId is required' });
        }

        try {
            const payment = await pay2payService.getPaymentByMerchantReferenceId(merchantReferenceId);
            return res.status(200).json({ status: true, message: 'Payment retrieved', data: payment });
        } catch (err) {
            if (err.message === 'Payment not found') {
                return res.status(404).json({ status: false, message: 'Payment not found' });
            }
            logger.error('Pay2Pay getPayment error', { merchantReferenceId, error: err.message });
            return res.status(500).json({ status: false, message: 'Failed to retrieve payment' });
        }
    }
}

module.exports = new Pay2PayController();
