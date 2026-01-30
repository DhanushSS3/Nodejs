"use strict";

const Stripe = require('stripe');
const crypto = require('crypto');
const logger = require('./logger.service');
const idGenerator = require('./idGenerator.service');
const redisUserCache = require('./redis.user.cache.service');
const { stripePaymentLogger } = require('./logging');
const sequelize = require('../config/db');
const {
  GatewayPayment,
  GatewayPaymentEvent,
  UserTransaction,
  LiveUser,
  StrategyProviderAccount,
  CopyFollowerAccount,
} = require('../models');

// Currencies that do not use minor units (no decimals) in Stripe
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

const DEFAULT_SETTLEMENT_RETRY_ATTEMPTS = Number.isFinite(parseInt(process.env.STRIPE_SETTLEMENT_RETRY_ATTEMPTS || '5', 10))
  ? parseInt(process.env.STRIPE_SETTLEMENT_RETRY_ATTEMPTS || '5', 10)
  : 5;

const DEFAULT_SETTLEMENT_RETRY_DELAY_MS = Number.isFinite(parseInt(process.env.STRIPE_SETTLEMENT_RETRY_DELAY_MS || '400', 10))
  ? parseInt(process.env.STRIPE_SETTLEMENT_RETRY_DELAY_MS || '400', 10)
  : 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StripePaymentService {
  constructor() {
    this.gatewayName = 'stripe';
    this.defaultCurrency = (process.env.STRIPE_DEPOSIT_CURRENCY || 'USD').toLowerCase();
    this.minAmount = parseFloat(process.env.STRIPE_DEPOSIT_MIN_AMOUNT || '1');
    this.maxAmount = parseFloat(process.env.STRIPE_DEPOSIT_MAX_AMOUNT || '100000');

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      logger.warn('STRIPE_SECRET_KEY is not configured. Stripe payments will be disabled.');
      this.stripe = null;
    } else {
      this.stripe = new Stripe(secretKey, {
        apiVersion: process.env.STRIPE_API_VERSION || '2024-06-20',
      });
    }
  }

  ensureStripeClient() {
    if (!this.stripe) {
      throw new Error('Stripe is not configured. Missing STRIPE_SECRET_KEY.');
    }
  }

  normalizeCurrency(currency) {
    return (currency || this.defaultCurrency || 'usd').toString().toLowerCase();
  }

  /**
   * Convert human amount to Stripe minor units (integer)
   * @param {string|number} amount
   * @param {string} currency
   * @returns {{ amountMinor: number, normalizedCurrency: string }}
   */
  toMinorUnits(amount, currency) {
    const numericAmount = parseFloat(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error('amount must be a positive number');
    }

    const normalizedCurrency = this.normalizeCurrency(currency);
    const factor = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? 1 : 100;
    const amountMinor = Math.round(numericAmount * factor);

    if (amountMinor <= 0) {
      throw new Error('amount is too small for the selected currency');
    }

    return { amountMinor, normalizedCurrency };
  }

  fromMinorUnits(amountMinor, currency) {
    const numericMinor = parseInt(amountMinor, 10);
    if (!Number.isFinite(numericMinor) || numericMinor < 0) {
      return 0;
    }

    const normalizedCurrency = this.normalizeCurrency(currency);
    const factor = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? 1 : 100;
    return numericMinor / factor;
  }

  /**
   * Validate amount is within configured bounds (if any)
   * @param {string|number} amount
   */
  validateAmountBounds(amount) {
    const numericAmount = parseFloat(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error('amount must be a positive number');
    }

    if (Number.isFinite(this.minAmount) && numericAmount < this.minAmount) {
      throw new Error(`amount must be at least ${this.minAmount}`);
    }

    if (Number.isFinite(this.maxAmount) && numericAmount > this.maxAmount) {
      throw new Error(`amount must not exceed ${this.maxAmount}`);
    }
  }

  /**
   * Create a Stripe PaymentIntent for a wallet deposit and persist GatewayPayment record.
   *
   * @param {Object} params
   * @param {number} params.userId - Target user/account ID (live / strategy / follower)
   * @param {string} params.userType - Target user/account type
   * @param {number|null} params.initiatorUserId - Initiator ID (may differ from target)
   * @param {string|null} params.initiatorUserType - Initiator type
   * @param {string|number} params.amount - Deposit amount in requested currency
   * @param {string} [params.currency] - Requested currency (default STRIPE_DEPOSIT_CURRENCY)
   * @param {string} [params.description] - Optional description for statement / logs
   * @param {string} [params.idempotencyKey] - Idempotency key for Stripe API
   * @param {Object} [params.metadata] - Extra metadata (ip, userAgent, etc.)
   *
   * @returns {Promise<{status: boolean, message: string, data: Object}>}
   */
  async createDepositIntent(params) {
    this.ensureStripeClient();

    const {
      userId,
      userType,
      initiatorUserId,
      initiatorUserType,
      amount,
      currency,
      description,
      idempotencyKey,
      metadata = {},
    } = params;

    if (!userId || !userType) {
      throw new Error('userId and userType are required');
    }

    this.validateAmountBounds(amount);

    const { amountMinor, normalizedCurrency } = this.toMinorUnits(amount, currency);

    // Generate merchant reference ID upfront for logging + metadata
    const merchantReferenceId = GatewayPayment.generateMerchantReferenceId();

    const intentMetadata = {
      merchant_reference_id: merchantReferenceId,
      gateway: this.gatewayName,
      purpose: 'deposit',
      user_id: String(userId),
      user_type: userType,
      ...(initiatorUserId && { initiator_user_id: String(initiatorUserId) }),
      ...(initiatorUserType && { initiator_user_type: initiatorUserType }),
      ...metadata,
    };

    const requestOptions = {};
    if (idempotencyKey) {
      requestOptions.idempotencyKey = idempotencyKey;
    }

    logger.info('Creating Stripe PaymentIntent', {
      gateway: this.gatewayName,
      merchantReferenceId,
      userId,
      userType,
      amount,
      amountMinor,
      currency: normalizedCurrency,
    });

    const paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: amountMinor,
        currency: normalizedCurrency,
        description: description || 'LiveFXHub wallet deposit',
        metadata: intentMetadata,
        automatic_payment_methods: {
          enabled: true,
        },
      },
      requestOptions,
    );

    logger.info('Stripe PaymentIntent created', {
      gateway: this.gatewayName,
      merchantReferenceId,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });

    stripePaymentLogger.logPaymentIntentCreated(
      userId,
      merchantReferenceId,
      paymentIntent,
      { amount, currency: normalizedCurrency.toUpperCase() },
    );

    const gatewayPayment = await GatewayPayment.create({
      merchant_reference_id: merchantReferenceId,
      gateway: this.gatewayName,
      purpose: 'deposit',
      status: 'PENDING',
      user_id: userId,
      user_type: userType,
      initiator_user_id: initiatorUserId || null,
      initiator_user_type: initiatorUserType || null,
      requested_amount: parseFloat(amount),
      requested_currency: normalizedCurrency.toUpperCase(),
      settled_currency: 'USD',
      provider_reference_id: paymentIntent.id,
      idempotency_key: idempotencyKey || null,
      provider_payload: {
        paymentIntent: {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          client_secret: paymentIntent.client_secret,
        },
      },
      metadata: intentMetadata,
    });

    logger.info('GatewayPayment record created for Stripe deposit', {
      id: gatewayPayment.id,
      merchantReferenceId,
      paymentIntentId: paymentIntent.id,
      userId,
      userType,
    });

    return {
      status: true,
      message: 'Stripe deposit intent created successfully',
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        merchantReferenceId,
        amount: parseFloat(amount),
        currency: normalizedCurrency.toUpperCase(),
        gatewayPaymentId: gatewayPayment.id,
      },
    };
  }

  /**
   * Fetch a GatewayPayment by merchant reference ID (Stripe gateway only).
   * @param {string} merchantReferenceId
   */
  async getPaymentByMerchantReferenceId(merchantReferenceId) {
    const payment = await GatewayPayment.findOne({
      where: {
        merchant_reference_id: merchantReferenceId,
        gateway: this.gatewayName,
      },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    return payment;
  }

  /**
   * Static configuration of supported Stripe deposit methods and constraints.
   * This is used by the frontend to render payment method options.
   */
  getSupportedMethods() {
    const currency = (this.defaultCurrency || 'usd').toUpperCase();

    return {
      currency,
      min_amount: this.minAmount,
      max_amount: this.maxAmount,
      methods: [
        {
          type: 'card',
          label: 'Credit / Debit Card',
          brands: ['visa', 'mastercard', 'amex', 'discover'],
        },
        {
          type: 'upi',
          label: 'UPI',
          supported_currencies: ['INR'],
        },
        {
          type: 'netbanking',
          label: 'NetBanking',
          supported_currencies: ['INR'],
        },
        {
          type: 'wallet',
          label: 'Wallets',
          supported_currencies: [currency],
        },
      ],
    };
  }

  getAccountModel(userType = 'live') {
    const normalizedUserType = (userType || 'live').toString().toLowerCase();
    switch (normalizedUserType) {
      case 'strategy_provider':
        return StrategyProviderAccount;
      case 'copy_follower':
        return CopyFollowerAccount;
      case 'live':
      default:
        return LiveUser;
    }
  }

  async getSettlementDetails(paymentIntent) {
    this.ensureStripeClient();

    const latestCharge = paymentIntent && paymentIntent.latest_charge;
    const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge && latestCharge.id;

    if (!chargeId) {
      return null;
    }

    const maxAttempts = DEFAULT_SETTLEMENT_RETRY_ATTEMPTS > 0 ? DEFAULT_SETTLEMENT_RETRY_ATTEMPTS : 5;
    const retryDelayMs = DEFAULT_SETTLEMENT_RETRY_DELAY_MS > 0 ? DEFAULT_SETTLEMENT_RETRY_DELAY_MS : 400;

    let charge = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      charge = await this.stripe.charges.retrieve(chargeId, {
        expand: ['balance_transaction'],
      });

      if (charge && charge.balance_transaction) {
        break;
      }

      if (attempt < maxAttempts) {
        const waitTime = retryDelayMs * attempt;
        logger.warn('Stripe charge missing balance_transaction, retrying settlement lookup', {
          chargeId,
          paymentIntentId: paymentIntent.id,
          attempt,
          maxAttempts,
          waitTime,
        });
        await sleep(waitTime);
      }
    }

    if (!charge) {
      throw new Error('Stripe charge could not be retrieved for settlement details');
    }

    const chargedAmount = this.fromMinorUnits(charge.amount || 0, charge.currency);
    const chargedCurrency = (charge.currency || paymentIntent.currency || this.defaultCurrency || 'usd').toString().toUpperCase();

    let balanceTransaction = null;
    let balanceTransactionId = null;
    if (charge.balance_transaction) {
      if (typeof charge.balance_transaction === 'string') {
        balanceTransactionId = charge.balance_transaction;
        balanceTransaction = await this.stripe.balanceTransactions.retrieve(balanceTransactionId);
      } else {
        balanceTransaction = charge.balance_transaction;
        balanceTransactionId = balanceTransaction && balanceTransaction.id;
      }
    }

    if (!balanceTransaction) {
      throw new Error('Stripe balance transaction not yet available for settlement');
    }

    const settledAmount = this.fromMinorUnits(balanceTransaction.amount || 0, balanceTransaction.currency);
    const feeAmount = this.fromMinorUnits(balanceTransaction.fee || 0, balanceTransaction.currency);
    const netAmount = this.fromMinorUnits(balanceTransaction.net || 0, balanceTransaction.currency);
    const settledCurrency = (balanceTransaction.currency || 'usd').toString().toUpperCase();

    return {
      chargeId,
      chargedAmount,
      chargedCurrency,
      balanceTransactionId,
      settledAmount,
      settledCurrency,
      feeAmount,
      feeCurrency: settledCurrency,
      netAmount,
      exchangeRate: balanceTransaction.exchange_rate != null ? balanceTransaction.exchange_rate : null,
      charge,
      balanceTransaction,
    };
  }

  getWebhookSecret() {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('Stripe webhook is not configured. Missing STRIPE_WEBHOOK_SECRET.');
    }
    return secret;
  }

  constructEventFromWebhook(rawBody, signatureHeader) {
    this.ensureStripeClient();
    const webhookSecret = this.getWebhookSecret();

    if (!rawBody) {
      throw new Error('Missing raw body for Stripe webhook verification');
    }

    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
      return event;
    } catch (error) {
      logger.error('Stripe webhook signature verification failed', {
        error: error.message,
      });
      throw new Error(`Stripe webhook signature verification failed: ${error.message}`);
    }
  }

  mapStripeStatusToInternal(eventType, paymentIntentStatus) {
    const normalizedEvent = (eventType || '').toString().toLowerCase();
    if (normalizedEvent === 'payment_intent.succeeded') {
      return 'COMPLETED';
    }
    if (normalizedEvent === 'payment_intent.payment_failed') {
      return 'FAILED';
    }
    if (normalizedEvent === 'payment_intent.canceled') {
      return 'CANCELLED';
    }
    if (normalizedEvent === 'payment_intent.processing') {
      return 'PROCESSING';
    }

    const normalizedStatus = (paymentIntentStatus || '').toString().toLowerCase();
    if (normalizedStatus === 'succeeded') {
      return 'COMPLETED';
    }
    if (normalizedStatus === 'processing') {
      return 'PROCESSING';
    }
    if (normalizedStatus === 'canceled') {
      return 'CANCELLED';
    }
    if (normalizedStatus === 'requires_payment_method') {
      return 'FAILED';
    }
    return 'PENDING';
  }

  extractPaidAmount(paymentIntent) {
    const currency = paymentIntent.currency;
    const minor = paymentIntent.amount_received != null
      ? paymentIntent.amount_received
      : paymentIntent.amount;
    const amount = this.fromMinorUnits(minor || 0, currency);
    const normalizedCurrency = (currency || this.defaultCurrency || 'usd').toString().toUpperCase();
    return { amount, currency: normalizedCurrency };
  }

  async creditUserWalletFromStripe(payment, amount, paymentIntent, event, transaction, settlementDetails = null) {
    const AccountModel = this.getAccountModel(payment.user_type);
    const user = await AccountModel.findByPk(payment.user_id, { transaction, lock: transaction.LOCK.UPDATE });

    if (!user) {
      throw new Error(`${payment.user_type} user not found with ID: ${payment.user_id}`);
    }

    const currentBalance = parseFloat(user.wallet_balance) || 0;
    const newBalance = currentBalance + amount;

    await user.update({
      wallet_balance: newBalance,
    }, { transaction });

    const transactionId = await idGenerator.generateTransactionId();
    const referenceId = payment.merchant_reference_id;

    await UserTransaction.create({
      transaction_id: transactionId,
      user_id: payment.user_id,
      user_type: payment.user_type,
      type: 'deposit',
      amount,
      balance_before: currentBalance,
      balance_after: newBalance,
      status: 'completed',
      reference_id: referenceId,
      user_email: user.email,
      method_type: 'OTHER',
      notes: `Stripe deposit - ${event.type}`,
      metadata: {
        paymentGateway: this.gatewayName,
        payment_intent_id: paymentIntent.id,
        charge_id: settlementDetails && settlementDetails.chargeId ? settlementDetails.chargeId : (typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : (paymentIntent.latest_charge && paymentIntent.latest_charge.id)),
        balance_transaction_id: settlementDetails && settlementDetails.balanceTransactionId ? settlementDetails.balanceTransactionId : null,
        event_id: event.id,
        event_type: event.type,
        charged_amount: settlementDetails && settlementDetails.chargedAmount != null ? settlementDetails.chargedAmount : null,
        charged_currency: settlementDetails && settlementDetails.chargedCurrency ? settlementDetails.chargedCurrency : (paymentIntent.currency ? paymentIntent.currency.toUpperCase() : null),
        settled_amount: settlementDetails && settlementDetails.settledAmount != null ? settlementDetails.settledAmount : null,
        settled_currency: settlementDetails && settlementDetails.settledCurrency ? settlementDetails.settledCurrency : 'USD',
        stripe_fee_amount: settlementDetails && settlementDetails.feeAmount != null ? settlementDetails.feeAmount : null,
        stripe_fee_currency: settlementDetails && settlementDetails.feeCurrency ? settlementDetails.feeCurrency : null,
        stripe_net_amount: settlementDetails && settlementDetails.netAmount != null ? settlementDetails.netAmount : null,
        exchange_rate: settlementDetails && settlementDetails.exchangeRate != null ? settlementDetails.exchangeRate : null,
      },
    }, { transaction });

    try {
      await redisUserCache.updateUser(payment.user_type, payment.user_id, {
        wallet_balance: newBalance,
      });
      logger.info('Redis user cache updated after Stripe wallet credit', {
        userId: payment.user_id,
        userType: payment.user_type,
        previousBalance: currentBalance,
        newBalance,
      });
    } catch (cacheError) {
      logger.error('Failed to update Redis cache after Stripe wallet credit', {
        userId: payment.user_id,
        userType: payment.user_type,
        amount,
        error: cacheError.message,
      });
    }

    logger.info('User wallet credited from Stripe payment', {
      userId: payment.user_id,
      userType: payment.user_type,
      amount,
      previousBalance: currentBalance,
      newBalance,
      transactionId,
      merchantReferenceId: payment.merchant_reference_id,
      providerReferenceId: payment.provider_reference_id,
    });

    return { transactionId, previousBalance: currentBalance, newBalance };
  }

  async processWebhookEvent(event, rawBody, context = {}) {
    const gateway = this.gatewayName;
    const eventId = event.id;
    const eventType = event.type;
    const payloadHash = crypto
      .createHash('sha256')
      .update(rawBody || JSON.stringify(event), 'utf8')
      .digest('hex');

    const dataObject = event && event.data && event.data.object;
    if (!dataObject || dataObject.object !== 'payment_intent') {
      stripePaymentLogger.logWebhookEvent(event, {
        ...context,
        ignored: true,
        reason: 'unsupported_object',
      });
      return { ignored: true, reason: 'unsupported_object' };
    }

    const paymentIntent = dataObject;
    const merchantReferenceId = paymentIntent.metadata && paymentIntent.metadata.merchant_reference_id;
    const providerReferenceId = paymentIntent.id;

    const internalStatus = this.mapStripeStatusToInternal(eventType, paymentIntent.status);
    const isFinalCompleted = internalStatus === 'COMPLETED';

    let gatewayEvent;
    try {
      gatewayEvent = await GatewayPaymentEvent.create({
        gateway_payment_id: null,
        gateway,
        provider_event_id: eventId,
        event_type: eventType,
        payload_hash: payloadHash,
        merchant_reference_id: merchantReferenceId || null,
        provider_reference_id: providerReferenceId || null,
        processing_status: 'RECEIVED',
        processed_at: null,
        processing_error: null,
        payload: event,
        metadata: context,
      });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        let existing = await GatewayPaymentEvent.findOne({
          where: {
            gateway,
            provider_event_id: eventId,
          },
        });

        if (!existing) {
          existing = await GatewayPaymentEvent.findOne({
            where: {
              gateway,
              payload_hash: payloadHash,
            },
          });
        }

        if (existing) {
          if (existing.processing_status === 'PROCESSED') {
            return { duplicate: true, event: existing };
          }
          gatewayEvent = existing;
        } else {
          throw error;
        }
      }
      throw error;
    }

    let settlementDetails = null;
    try {
      if (isFinalCompleted) {
        settlementDetails = await this.getSettlementDetails(paymentIntent);
        if (!settlementDetails || !settlementDetails.balanceTransactionId || !settlementDetails.settledCurrency) {
          throw new Error('Stripe settlement details could not be resolved for completed payment');
        }
        if (settlementDetails.settledCurrency.toUpperCase() !== 'USD') {
          throw new Error(`Unexpected Stripe settlement currency: ${settlementDetails.settledCurrency}`);
        }
        if (!(settlementDetails.settledAmount > 0)) {
          throw new Error('Stripe settled amount must be greater than 0 for completed payment');
        }
      }
    } catch (error) {
      try {
        await gatewayEvent.update({
          processing_status: 'FAILED',
          processed_at: new Date(),
          processing_error: error.message,
        });
      } catch (updateError) {
        logger.error('Failed to update GatewayPaymentEvent after Stripe settlement retrieval failure', {
          eventId,
          eventType,
          error: updateError.message,
        });
      }

      stripePaymentLogger.logWebhookError(error, {
        eventId,
        eventType,
        stage: 'settlement_details',
      });

      throw error;
    }

    const processingStartTime = Date.now();
    const transaction = await sequelize.transaction();

    try {
      let payment = null;

      if (merchantReferenceId) {
        payment = await GatewayPayment.findOne({
          where: { merchant_reference_id: merchantReferenceId, gateway },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
      }

      if (!payment && providerReferenceId) {
        payment = await GatewayPayment.findOne({
          where: { provider_reference_id: providerReferenceId, gateway },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
      }

      if (!payment) {
        await transaction.commit();

        await gatewayEvent.update({
          processing_status: 'IGNORED',
          processed_at: new Date(),
          processing_error: 'Payment not found for webhook event',
        });

        return { ignored: true, reason: 'payment_not_found' };
      }

      const statusBefore = payment.status;
      const { amount: fallbackPaidAmount, currency: fallbackPaidCurrency } = this.extractPaidAmount(paymentIntent);

      const paidAmount = settlementDetails && settlementDetails.chargedAmount != null
        ? settlementDetails.chargedAmount
        : fallbackPaidAmount;

      const paidCurrency = settlementDetails && settlementDetails.chargedCurrency
        ? settlementDetails.chargedCurrency
        : fallbackPaidCurrency;

      const settledAmount = settlementDetails && settlementDetails.settledAmount != null
        ? settlementDetails.settledAmount
        : paidAmount;

      const settledCurrency = settlementDetails && settlementDetails.settledCurrency
        ? settlementDetails.settledCurrency
        : (payment.settled_currency || 'USD');

      const feeAmount = settlementDetails && settlementDetails.feeAmount != null ? settlementDetails.feeAmount : null;
      const feeCurrency = settlementDetails && settlementDetails.feeCurrency ? settlementDetails.feeCurrency : null;
      const exchangeRate = settlementDetails && settlementDetails.exchangeRate != null ? settlementDetails.exchangeRate : null;

      let walletCreditSuccess = false;
      let walletCreditAmount = 0;
      let previousWalletBalance = 0;
      let newWalletBalance = 0;
      let transactionId = null;

      let existingCreditTransaction = null;
      if (isFinalCompleted) {
        existingCreditTransaction = await UserTransaction.findOne({
          where: {
            reference_id: payment.merchant_reference_id,
            user_id: payment.user_id,
            user_type: payment.user_type,
            type: 'deposit',
          },
          transaction,
        });
      }

      const hasAlreadyBeenCredited = Boolean(existingCreditTransaction);
      const shouldCreditWallet = isFinalCompleted && !hasAlreadyBeenCredited;

      if (shouldCreditWallet) {
        const creditResult = await this.creditUserWalletFromStripe(
          payment,
          settledAmount,
          paymentIntent,
          event,
          transaction,
          settlementDetails,
        );
        walletCreditSuccess = true;
        walletCreditAmount = settledAmount;
        previousWalletBalance = creditResult.previousBalance;
        newWalletBalance = creditResult.newBalance;
        transactionId = creditResult.transactionId;
      }

      await payment.update(
        {
          status: internalStatus,
          paid_amount: paidAmount,
          paid_currency: paidCurrency,
          settled_amount: settledAmount,
          settled_currency: settledCurrency,
          exchange_rate: exchangeRate,
          fee_amount: feeAmount,
          fee_currency: feeCurrency,
          credited_amount: walletCreditSuccess ? settledAmount : payment.credited_amount,
          credited_currency: payment.credited_currency || settledCurrency || 'USD',
          provider_reference_id: payment.provider_reference_id || providerReferenceId,
          transaction_id: transactionId || payment.transaction_id,
          provider_payload: {
            ...(payment.provider_payload || {}),
            paymentIntent: {
              ...((payment.provider_payload && payment.provider_payload.paymentIntent) || {}),
              id: paymentIntent.id,
              status: paymentIntent.status,
              amount: paymentIntent.amount,
              amount_received: paymentIntent.amount_received,
              currency: paymentIntent.currency,
              latest_charge: settlementDetails && settlementDetails.chargeId ? settlementDetails.chargeId : paymentIntent.latest_charge,
            },
            charge: settlementDetails && settlementDetails.charge ? {
              id: settlementDetails.charge.id,
              amount: settlementDetails.charge.amount,
              currency: settlementDetails.charge.currency,
              balance_transaction: settlementDetails.balanceTransactionId,
            } : ((payment.provider_payload && payment.provider_payload.charge) || undefined),
            balanceTransaction: settlementDetails && settlementDetails.balanceTransaction ? {
              id: settlementDetails.balanceTransaction.id,
              amount: settlementDetails.balanceTransaction.amount,
              currency: settlementDetails.balanceTransaction.currency,
              net: settlementDetails.balanceTransaction.net,
              fee: settlementDetails.balanceTransaction.fee,
              exchange_rate: settlementDetails.balanceTransaction.exchange_rate,
              status: settlementDetails.balanceTransaction.status,
              type: settlementDetails.balanceTransaction.type,
            } : ((payment.provider_payload && payment.provider_payload.balanceTransaction) || undefined),
          },
        },
        { transaction },
      );

      await gatewayEvent.update(
        {
          gateway_payment_id: payment.id,
          processing_status: 'PROCESSED',
          processed_at: new Date(),
          processing_error: null,
        },
        { transaction },
      );

      await transaction.commit();

      const processingTime = Date.now() - processingStartTime;

      stripePaymentLogger.logWebhookProcessing(payment, {
        statusBefore,
        statusAfter: internalStatus,
        walletCreditSuccess,
        walletCreditAmount,
        previousWalletBalance,
        newWalletBalance,
        transactionId,
        eventId,
        eventType,
        processingTime,
      });

      logger.info('Stripe payment updated from webhook', {
        merchantReferenceId: payment.merchant_reference_id,
        providerReferenceId,
        status: internalStatus,
        gatewayPaymentId: payment.id,
        walletCredited: walletCreditSuccess,
      });

      return {
        payment,
        statusBefore,
        statusAfter: internalStatus,
        walletCreditSuccess,
        walletCreditAmount,
        hasAlreadyBeenCredited,
      };
    } catch (error) {
      await transaction.rollback();

      const processingTime = Date.now() - processingStartTime;

      stripePaymentLogger.logWebhookError(error, {
        eventId,
        eventType,
      });

      await gatewayEvent.update({
        processing_status: 'FAILED',
        processed_at: new Date(),
        processing_error: error.message,
      });

      logger.error('Stripe webhook processing failed', {
        eventId,
        eventType,
        error: error.message,
        stack: error.stack,
        processingTime,
      });

      throw error;
    }
  }
}

module.exports = new StripePaymentService();

