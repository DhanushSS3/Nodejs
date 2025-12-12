const cryptoPaymentService = require('../services/crypto.payment.service');
const logger = require('../utils/logger');
const { cryptoPaymentLogger, cryptoWebhookRawLogger } = require('../services/logging');
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

class CryptoPaymentController {
  /**
   * Create a new crypto payment deposit request
   * @route POST /api/crypto-payments/deposit
   */
  async createDeposit(req, res) {
    try {
      const {
        baseAmount,
        baseCurrency,
        settledCurrency,
        networkSymbol,
        user_id,
        user_type,
        customerName,
        comments
      } = req.body;

      // Validate required fields
      if (!baseAmount || !baseCurrency || !settledCurrency || !networkSymbol) {
        return res.status(400).json({
          status: false,
          message: 'Missing required fields: baseAmount, baseCurrency, settledCurrency, networkSymbol'
        });
      }

      if (!user_id || !user_type) {
        return res.status(400).json({
          status: false,
          message: 'user_id and user_type are required'
        });
      }

      const authContext = getAuthContext(req);
      if (!authContext.authUserId && !authContext.strategyProviderId) {
        return res.status(401).json({
          status: false,
          message: 'Authentication required. Please log in to create a deposit.'
        });
      }

      const ownership = await resolveDepositTarget(user_id, user_type.toString().toLowerCase(), authContext);

      // Validate amount is positive number
      const amount = parseFloat(baseAmount);
      if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({
          status: false,
          message: 'baseAmount must be a positive number'
        });
      }

      logger.info('Creating crypto deposit request', { 
        userId: ownership.targetUserId, 
        userType: ownership.targetUserType,
        amount: baseAmount, 
        currency: baseCurrency,
        network: networkSymbol,
        initiatorUserId: ownership.initiatorUserId,
        initiatorUserType: ownership.initiatorUserType
      });

      // Log the deposit request from frontend
      cryptoPaymentLogger.logDepositRequest(
        ownership.targetUserId, 
        { baseAmount, baseCurrency, settledCurrency, networkSymbol, customerName, comments, user_type: ownership.targetUserType },
        req.ip,
        req.get('User-Agent')
      );

      const result = await cryptoPaymentService.createDepositRequest({
        user_id: ownership.targetUserId.toString(),
        user_type: ownership.targetUserType,
        initiator_user_id: ownership.initiatorUserId ? ownership.initiatorUserId.toString() : null,
        initiator_user_type: ownership.initiatorUserType,
        baseAmount,
        baseCurrency,
        settledCurrency,
        networkSymbol,
        customerName,
        comments,
        // Add request context for logging
        _ip: req.ip,
        _userAgent: req.get('User-Agent')
      });

      // Log the Tylt API response
      cryptoPaymentLogger.logTyltResponse(
        ownership.targetUserId,
        result.data?.merchantOrderId,
        result.data || result
      );

      res.status(200).json(result);

    } catch (error) {
      logger.error('Error in createDeposit controller', { 
        error: error.message,
        body: req.body,
        stack: error.stack 
      });

      const statusCode = error instanceof DepositValidationError && error.statusCode ? error.statusCode : 500;

      res.status(statusCode).json({
        status: false,
        message: error.message || 'Failed to create deposit request'
      });
    }
  }

  /**
   * Get payment details by merchant order ID
   * @route GET /api/crypto-payments/:merchantOrderId
   */
  async getPaymentByOrderId(req, res) {
    try {
      const { merchantOrderId } = req.params;

      if (!merchantOrderId) {
        return res.status(400).json({
          status: false,
          message: 'merchantOrderId is required'
        });
      }

      const payment = await cryptoPaymentService.getPaymentByMerchantOrderId(merchantOrderId);

      res.status(200).json({
        status: true,
        message: 'Payment retrieved successfully',
        data: payment
      });

    } catch (error) {
      logger.error('Error in getPaymentByOrderId controller', { 
        merchantOrderId: req.params.merchantOrderId,
        error: error.message 
      });

      if (error.message === 'Payment not found') {
        return res.status(404).json({
          status: false,
          message: 'Payment not found'
        });
      }

      res.status(500).json({
        status: false,
        message: 'Failed to retrieve payment'
      });
    }
  }

  /**
   * Get payments by user ID
   * @route GET /api/crypto-payments/user/:userId
   */
  async getPaymentsByUserId(req, res) {
    try {
      const { userId } = req.params;
      const { limit, offset, status } = req.query;

      if (!userId) {
        return res.status(400).json({
          status: false,
          message: 'userId is required'
        });
      }

      const userIdInt = parseInt(userId);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({
          status: false,
          message: 'userId must be a positive integer'
        });
      }

      const options = {};
      if (limit) options.limit = parseInt(limit);
      if (offset) options.offset = parseInt(offset);
      if (status) options.status = status;

      const payments = await cryptoPaymentService.getPaymentsByUserId(userIdInt, options);

      res.status(200).json({
        status: true,
        message: 'Payments retrieved successfully',
        data: payments,
        count: payments.length
      });

    } catch (error) {
      logger.error('Error in getPaymentsByUserId controller', { 
        userId: req.params.userId,
        error: error.message 
      });

      res.status(500).json({
        status: false,
        message: 'Failed to retrieve payments'
      });
    }
  }

  /**
   * Handle webhook from Tylt payment gateway
   * @route POST /api/crypto-payments/webhook
   */
  async handleWebhook(req, res) {
    try {
      logger.info('Received Tylt webhook', { 
        body: req.body,
        headers: req.headers 
      });

      // Persist raw webhook payload exactly as received (for audits/debugging)
      if (req.rawBody) {
        cryptoWebhookRawLogger.logRawPayload(req.rawBody);
      }

      // Validate HMAC signature
      const signature = req.headers['x-tlp-signature'];
      const rawBody = req.rawBody || JSON.stringify(req.body);
      
      logger.info('Webhook signature validation details', {
        hasSignature: !!signature,
        hasRawBody: !!req.rawBody,
        bodyType: typeof req.body,
        signatureHeader: signature ? 'present' : 'missing',
        bodyLength: rawBody ? rawBody.length : 0
      });
      
      if (!signature) {
        logger.warn('Webhook received without signature', {
          headers: req.headers,
          body: req.body
        });
        return res.status(400).send('Missing X-TLP-SIGNATURE header');
      }

      const isValidSignature = cryptoPaymentService.validateWebhookSignature(signature, rawBody);
      
      if (!isValidSignature) {
        // Log signature validation failure with expected signature for development
        const expectedSignature = cryptoPaymentService.createSignature(process.env.TLP_API_SECRET, rawBody);
        cryptoPaymentLogger.logSignatureValidationFailure(
          signature,
          expectedSignature,
          rawBody,
          req.ip,
          req.get('User-Agent')
        );
        
        logger.error('Invalid webhook signature', { signature });
        return res.status(400).send('Invalid HMAC signature');
      }

      // Extract webhook data - handle nested data structure
      const webhookData = req.body.data || req.body;
      const { merchantOrderId } = webhookData;

      // Add request context to webhook data for detailed logging
      webhookData._ip = req.ip;
      webhookData._userAgent = req.get('User-Agent');
      webhookData._signature = signature;
      webhookData._signatureValid = isValidSignature;

      // Log webhook callback
      cryptoPaymentLogger.logWebhookCallback(
        webhookData,
        signature,
        isValidSignature,
        req.ip,
        req.get('User-Agent')
      );

      if (!merchantOrderId) {
        return res.status(400).json({
          status: false,
          message: 'merchantOrderId is required in webhook'
        });
      }

      // Update payment record with complete webhook data
      const updatedPayment = await cryptoPaymentService.updatePaymentFromWebhook(merchantOrderId, webhookData);

      // Log payment status update
      cryptoPaymentLogger.logPaymentUpdate(
        merchantOrderId,
        updatedPayment.previousStatus,
        webhookData.status,
        updatedPayment.id
      );

      logger.info('Payment updated from webhook', { 
        merchantOrderId, 
        status: webhookData.status,
        paymentId: updatedPayment.id 
      });

      // Respond with "ok" as required by Tylt
      res.status(200).send('ok');

    } catch (error) {
      logger.error('Error processing webhook', { 
        error: error.message,
        body: req.body,
        stack: error.stack 
      });

      // If payment was not found we don’t want Tylt to keep retrying the
      // webhook (they treat non-2xx as failure and will retry up to N times).
      // Therefore respond with 200 OK but include a body that indicates we
      // ignored the webhook.
      if (error.message && error.message.includes('Payment not found')) {
        logger.warn('Webhook ignored – no matching payment record', {
          merchantOrderId: req.body.merchantOrderId || 'unknown',
          orderId: req.body.orderId || 'unknown'
        });
        return res.status(200).json({ status: true, message: 'Webhook ignored – payment not found' });
      }

      res.status(500).send('Failed to process webhook');
    }
  }

}

module.exports = new CryptoPaymentController();
