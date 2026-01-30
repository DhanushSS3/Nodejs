const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

class StripePaymentLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('stripePayments', {
      filename: 'stripePayments.log',
      maxsize: 10485760,
      maxFiles: 10,
    });
    super(logger);
  }

  logDepositRequest(userId, requestData, ip, userAgent) {
    this.info('Stripe deposit request received', {
      type: 'stripe_deposit_request',
      userId,
      requestData: {
        amount: requestData.amount,
        currency: requestData.currency,
        user_type: requestData.user_type,
        description: requestData.description || null,
      },
      ip,
      userAgent,
    });
  }

  logPaymentIntentCreated(userId, merchantReferenceId, paymentIntent, context = {}) {
    this.info('Stripe PaymentIntent created', {
      type: 'stripe_payment_intent_created',
      userId,
      merchantReferenceId,
      paymentIntent: {
        id: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status,
        client_secret_present: !!paymentIntent.client_secret,
      },
      context,
    });
  }

  logWebhookEvent(event, metadata = {}) {
    this.info('Stripe webhook event received', {
      type: 'stripe_webhook_event',
      eventId: event.id,
      eventType: event.type,
      apiVersion: event.api_version,
      created: event.created,
      dataObjectType: event.data && event.data.object && event.data.object.object,
      paymentIntentId: event.data && event.data.object && event.data.object.id,
      merchantReferenceId: event.data && event.data.object && event.data.object.metadata && event.data.object.metadata.merchant_reference_id,
      metadata,
    });
  }

  logSignatureValidationFailure(receivedSignature, errorMessage, rawBodyLength, ip, userAgent) {
    this.warn('Stripe signature validation failed', {
      type: 'stripe_signature_validation_failure',
      receivedSignature,
      errorMessage,
      rawBodyLength,
      ip,
      userAgent,
    });
  }

  logWebhookProcessing(payment, details) {
    this.info('Stripe webhook processing details', {
      type: 'stripe_webhook_processing',
      gatewayPaymentId: payment && payment.id,
      merchantReferenceId: payment && payment.merchant_reference_id,
      providerReferenceId: payment && payment.provider_reference_id,
      statusBefore: details.statusBefore,
      statusAfter: details.statusAfter,
      walletCredit: {
        success: details.walletCreditSuccess,
        amount: details.walletCreditAmount,
        previousBalance: details.previousWalletBalance,
        newBalance: details.newWalletBalance,
        transactionId: details.transactionId,
      },
      eventId: details.eventId,
      eventType: details.eventType,
      processingTime: details.processingTime,
    });
  }

  logWebhookError(error, context = {}) {
    this.error('Stripe webhook processing failed', {
      type: 'stripe_webhook_error',
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      context,
    });
  }
}

module.exports = StripePaymentLogger;
