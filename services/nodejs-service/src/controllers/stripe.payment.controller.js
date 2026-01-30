const stripePaymentService = require('../services/stripe.payment.service');
const logger = require('../utils/logger');
const { IdempotencyService } = require('../services/idempotency.service');
const { stripePaymentLogger, stripeWebhookRawLogger } = require('../services/logging');
const { LiveUser, StrategyProviderAccount, CopyFollowerAccount } = require('../models');

const SUPPORTED_DEPOSIT_USER_TYPES = ['live', 'strategy_provider', 'copy_follower'];

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

async function resolveDepositTarget(userId, userType, authContext) {
  if (!SUPPORTED_DEPOSIT_USER_TYPES.includes(userType)) {
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
      if (!authContext.authUserId) {
        throw new DepositValidationError('Authentication required', 401);
      }

      const isLiveSession = authContext.authAccountType === 'live';
      const isStrategySession = authContext.authAccountType === 'strategy_provider';

      if (!authContext.authUserId || authContext.authUserId !== parsedTargetId) {
        throw new DepositValidationError('You can only deposit into your own live account', 403);
      }

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
          throw new DepositValidationError('Strategy provider token is not linked to this live account', 403);
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

      return {
        targetUserId: parsedTargetId,
        targetUserType: 'live',
        initiatorUserId,
        initiatorUserType,
      };
    }
    case 'strategy_provider': {
      const strategyAccount = await StrategyProviderAccount.findByPk(parsedTargetId, {
        attributes: ['id', 'user_id', 'status', 'is_active', 'is_archived'],
      });

      if (!strategyAccount) {
        throw new DepositValidationError('Strategy provider account not found');
      }

      if (strategyAccount.is_archived || strategyAccount.status !== 1 || strategyAccount.is_active !== 1) {
        throw new DepositValidationError('Strategy provider account is inactive or archived');
      }

      const ownsAsProvider = authContext.authAccountType === 'strategy_provider'
        && authContext.strategyProviderId === strategyAccount.id;
      const ownsAsLiveUser = authContext.authAccountType === 'live'
        && authContext.authUserId === strategyAccount.user_id;

      if (!ownsAsProvider && !ownsAsLiveUser) {
        throw new DepositValidationError('You are not authorized to deposit into this strategy provider account', 403);
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
        attributes: ['id', 'user_id', 'status', 'is_active', 'copy_status'],
      });

      if (!followerAccount) {
        throw new DepositValidationError('Copy follower account not found');
      }

      if (followerAccount.status !== 1 || followerAccount.is_active !== 1) {
        throw new DepositValidationError('Copy follower account is inactive');
      }

      if (authContext.authAccountType !== 'live' || authContext.authUserId !== followerAccount.user_id) {
        throw new DepositValidationError('You are not authorized to deposit into this copy follower account', 403);
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

class StripePaymentController {
  async createDeposit(req, res) {
    const operationId = `stripe_deposit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const body = req.body || {};

      if (!req.body || Object.keys(body).length === 0) {
        return res.status(400).json({
          status: false,
          message: 'Request body is required and must be valid JSON',
        });
      }

      const {
        amount,
        currency,
        user_id,
        user_type,
        description,
      } = body;

      if (!amount || !currency) {
        return res.status(400).json({
          status: false,
          message: 'Missing required fields: amount, currency',
        });
      }

      if (!user_id || !user_type) {
        return res.status(400).json({
          status: false,
          message: 'user_id and user_type are required',
        });
      }

      const numericAmount = parseFloat(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
          status: false,
          message: 'amount must be a positive number',
        });
      }

      const authContext = getAuthContext(req);
      if (!authContext.authUserId && !authContext.strategyProviderId) {
        return res.status(401).json({
          status: false,
          message: 'Authentication required. Please log in to create a deposit.',
        });
      }

      const ownership = await resolveDepositTarget(user_id, user_type.toString().toLowerCase(), authContext);

      const idempotencyKey = IdempotencyService.generateKey(req, 'stripe_deposit');
      const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

      if (isExisting && record.status === 'completed' && record.response) {
        return res.status(200).json(record.response);
      }

      logger.info('Creating Stripe deposit intent', {
        operationId,
        userId: ownership.targetUserId,
        userType: ownership.targetUserType,
        amount,
        currency,
        initiatorUserId: ownership.initiatorUserId,
        initiatorUserType: ownership.initiatorUserType,
      });

      stripePaymentLogger.logDepositRequest(
        ownership.targetUserId,
        { amount, currency, user_type: ownership.targetUserType, description },
        req.ip,
        req.get('User-Agent'),
      );

      const result = await stripePaymentService.createDepositIntent({
        userId: ownership.targetUserId,
        userType: ownership.targetUserType,
        initiatorUserId: ownership.initiatorUserId,
        initiatorUserType: ownership.initiatorUserType,
        amount,
        currency,
        description,
        idempotencyKey,
        metadata: {
          ip: req.ip,
          userAgent: req.get('User-Agent'),
        },
      });

      await IdempotencyService.markCompleted(idempotencyKey, result);

      return res.status(200).json(result);
    } catch (error) {
      logger.error('Error in Stripe createDeposit controller', {
        error: error.message,
        stack: error.stack,
        body: req.body,
        operationId,
      });

      try {
        const idempotencyKey = IdempotencyService.generateKey(req, 'stripe_deposit');
        await IdempotencyService.markFailed(idempotencyKey, error);
      } catch (idempotencyError) {
        logger.error('Failed to mark Stripe idempotency as failed', {
          error: idempotencyError.message,
        });
      }

      const statusCode = error instanceof DepositValidationError && error.statusCode
        ? error.statusCode
        : (error.message && error.message.includes('Stripe is not configured') ? 503 : 500);

      return res.status(statusCode).json({
        status: false,
        message: error.message || 'Failed to create Stripe deposit intent',
      });
    }
  }

  async getMethods(req, res) {
    try {
      const data = stripePaymentService.getSupportedMethods();
      return res.status(200).json({
        status: true,
        message: 'Stripe deposit methods',
        data,
      });
    } catch (error) {
      logger.error('Error in Stripe getMethods controller', {
        error: error.message,
      });
      return res.status(500).json({
        status: false,
        message: 'Failed to fetch Stripe methods',
      });
    }
  }

  async getPaymentByMerchantReferenceId(req, res) {
    try {
      const { merchantReferenceId } = req.params;

      if (!merchantReferenceId) {
        return res.status(400).json({
          status: false,
          message: 'merchantReferenceId is required',
        });
      }

      const payment = await stripePaymentService.getPaymentByMerchantReferenceId(merchantReferenceId);

      return res.status(200).json({
        status: true,
        message: 'Payment retrieved successfully',
        data: payment,
      });
    } catch (error) {
      logger.error('Error in Stripe getPaymentByMerchantReferenceId controller', {
        merchantReferenceId: req.params.merchantReferenceId,
        error: error.message,
      });

      if (error.message === 'Payment not found') {
        return res.status(404).json({
          status: false,
          message: 'Payment not found',
        });
      }

      return res.status(500).json({
        status: false,
        message: 'Failed to retrieve payment',
      });
    }
  }

  async handleWebhook(req, res) {
    try {
      const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      const signature = req.headers['stripe-signature'];

      logger.info('Received Stripe webhook', {
        hasRawBody: !!req.rawBody,
        bodyType: typeof req.body,
        signatureHeaderPresent: !!signature,
      });

      if (!rawBody) {
        return res.status(400).send('Missing raw body for Stripe webhook');
      }

      if (!signature) {
        logger.warn('Stripe webhook received without signature', {
          headers: req.headers,
        });
        return res.status(400).send('Missing Stripe-Signature header');
      }

      if (req.rawBody) {
        stripeWebhookRawLogger.logRawPayload(req.rawBody);
      }

      let event;
      try {
        event = stripePaymentService.constructEventFromWebhook(rawBody, signature);
      } catch (error) {
        stripePaymentLogger.logSignatureValidationFailure(
          signature,
          error.message,
          rawBody.length,
          req.ip,
          req.get('User-Agent')
        );
        logger.error('Invalid Stripe webhook signature', {
          error: error.message,
        });
        return res.status(400).send('Invalid Stripe signature');
      }

      stripePaymentLogger.logWebhookEvent(event, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
      });

      const result = await stripePaymentService.processWebhookEvent(event, rawBody, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        signature,
      });

      if (result && result.duplicate) {
        return res.status(200).send('ok');
      }

      if (result && result.ignored && result.reason === 'payment_not_found') {
        return res.status(200).json({ status: true, message: 'Webhook ignored - payment not found' });
      }

      return res.status(200).send('ok');
    } catch (error) {
      logger.error('Error processing Stripe webhook', {
        error: error.message,
        stack: error.stack,
      });

      if (error.message && error.message.includes('Stripe webhook is not configured')) {
        return res.status(503).send('Stripe webhook is not configured');
      }

      return res.status(500).send('Failed to process Stripe webhook');
    }
  }
}

module.exports = new StripePaymentController();
