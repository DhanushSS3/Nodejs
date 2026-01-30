"use strict";

const Stripe = require('stripe');
const logger = require('./logger.service');
const { GatewayPayment } = require('../models');

// Currencies that do not use minor units (no decimals) in Stripe
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

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
}

module.exports = new StripePaymentService();

