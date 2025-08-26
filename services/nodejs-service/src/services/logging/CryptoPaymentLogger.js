const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

/**
 * Crypto Payment Logger following Single Responsibility Principle
 * Handles all crypto payment related logging operations
 */
class CryptoPaymentLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('cryptoPayments', {
      filename: 'cryptoPayments.log',
      maxsize: 10485760, // 10MB for payment logs
      maxFiles: 10
    });
    super(logger);
  }

  /**
   * Log deposit request from frontend
   * @param {number} userId 
   * @param {Object} requestData 
   * @param {string} ip 
   * @param {string} userAgent 
   */
  logDepositRequest(userId, requestData, ip, userAgent) {
    this.info('Deposit request received', {
      type: 'deposit_request',
      userId,
      requestData: {
        baseAmount: requestData.baseAmount,
        baseCurrency: requestData.baseCurrency,
        settledCurrency: requestData.settledCurrency,
        networkSymbol: requestData.networkSymbol,
        customerName: requestData.customerName,
        comments: requestData.comments
      },
      ip,
      userAgent
    });
  }

  /**
   * Log Tylt API response
   * @param {number} userId 
   * @param {string} merchantOrderId 
   * @param {Object} tyltResponse 
   */
  logTyltResponse(userId, merchantOrderId, tyltResponse) {
    this.info('Tylt API response received', {
      type: 'tylt_response',
      userId,
      merchantOrderId,
      response: {
        success: !!tyltResponse.paymentUrl,
        orderId: tyltResponse.orderId,
        paymentUrl: tyltResponse.paymentUrl,
        depositAddress: tyltResponse.depositAddress,
        expiresAt: tyltResponse.expiresAt,
        error: tyltResponse.error || null
      }
    });
  }

  /**
   * Log webhook callback
   * @param {Object} webhookData 
   * @param {string} signature 
   * @param {boolean} isValidSignature 
   * @param {string} ip 
   * @param {string} userAgent 
   */
  logWebhookCallback(webhookData, signature, isValidSignature, ip, userAgent) {
    this.info('Webhook callback received', {
      type: 'webhook_callback',
      merchantOrderId: webhookData.merchantOrderId,
      orderId: webhookData.orderId,
      status: webhookData.status,
      baseAmount: webhookData.baseAmount,
      baseAmountReceived: webhookData.baseAmountReceived,
      signature: signature,
      signatureValid: isValidSignature,
      ip,
      userAgent
    });
  }

  /**
   * Log signature validation failure with expected signature
   * @param {string} receivedSignature 
   * @param {string} expectedSignature 
   * @param {string} rawBody 
   * @param {string} ip 
   * @param {string} userAgent 
   */
  logSignatureValidationFailure(receivedSignature, expectedSignature, rawBody, ip, userAgent) {
    this.warn('Signature validation failed', {
      type: 'signature_validation_failure',
      receivedSignature,
      expectedSignature,
      rawBodyLength: rawBody ? rawBody.length : 0,
      rawBodyPreview: rawBody ? rawBody.substring(0, 200) + '...' : null,
      ip,
      userAgent
    });
  }

  /**
   * Log payment update from webhook
   * @param {string} merchantOrderId 
   * @param {string} oldStatus 
   * @param {string} newStatus 
   * @param {number} paymentId 
   */
  logPaymentUpdate(merchantOrderId, oldStatus, newStatus, paymentId) {
    this.info('Payment status updated', {
      type: 'payment_update',
      merchantOrderId,
      paymentId,
      statusChange: {
        from: oldStatus,
        to: newStatus
      }
    });
  }
}

module.exports = CryptoPaymentLogger;
