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

  /**
   * Log outgoing WebSocket/HTTP request to Tylt API
   * @param {string} method - HTTP method (POST, GET, etc.)
   * @param {string} url - API endpoint URL
   * @param {Object} headers - Request headers
   * @param {Object} requestBody - Request payload
   * @param {string} merchantOrderId - Associated merchant order ID
   * @param {number} userId - User ID making the request
   */
  logOutgoingRequest(method, url, headers, requestBody, merchantOrderId, userId) {
    this.info('Outgoing API request to Tylt', {
      type: 'outgoing_request',
      direction: 'OUTBOUND',
      method,
      url,
      merchantOrderId,
      userId,
      headers: {
        'X-TLP-APIKEY': headers['X-TLP-APIKEY'] ? '***REDACTED***' : undefined,
        'X-TLP-SIGNATURE': headers['X-TLP-SIGNATURE'] ? '***REDACTED***' : undefined,
        'Content-Type': headers['Content-Type'],
        'User-Agent': headers['User-Agent']
      },
      requestBody: {
        merchantOrderId: requestBody.merchantOrderId,
        baseAmount: requestBody.baseAmount,
        baseCurrency: requestBody.baseCurrency,
        settledCurrency: requestBody.settledCurrency,
        networkSymbol: requestBody.networkSymbol,
        callBackUrl: requestBody.callBackUrl,
        settleUnderpayment: requestBody.settleUnderpayment,
        customerName: requestBody.customerName,
        comments: requestBody.comments
      },
      timestamp: new Date().toISOString(),
      requestSize: JSON.stringify(requestBody).length
    });
  }

  /**
   * Log incoming WebSocket/HTTP response from Tylt API
   * @param {number} statusCode - HTTP status code
   * @param {Object} responseHeaders - Response headers
   * @param {Object} responseBody - Response payload
   * @param {string} merchantOrderId - Associated merchant order ID
   * @param {number} userId - User ID
   * @param {number} responseTime - Response time in milliseconds
   */
  logIncomingResponse(statusCode, responseHeaders, responseBody, merchantOrderId, userId, responseTime) {
    this.info('Incoming API response from Tylt', {
      type: 'incoming_response',
      direction: 'INBOUND',
      statusCode,
      merchantOrderId,
      userId,
      responseTime: `${responseTime}ms`,
      headers: {
        'content-type': responseHeaders['content-type'],
        'content-length': responseHeaders['content-length'],
        'server': responseHeaders['server']
      },
      responseBody: {
        success: responseBody.success,
        message: responseBody.message,
        data: responseBody.data ? {
          orderId: responseBody.data.orderId,
          paymentURL: responseBody.data.paymentURL,
          depositAddress: responseBody.data.depositAddress,
          expiresAt: responseBody.data.expiresAt,
          settledAmountRequested: responseBody.data.settledAmountRequested,
          commission: responseBody.data.commission
        } : null,
        error: responseBody.error || null
      },
      timestamp: new Date().toISOString(),
      responseSize: JSON.stringify(responseBody).length
    });
  }

  /**
   * Log complete WebSocket communication flow
   * @param {Object} flowData - Complete flow information
   */
  logWebSocketFlow(flowData) {
    this.info('WebSocket communication flow', {
      type: 'websocket_flow',
      flowId: flowData.flowId,
      userId: flowData.userId,
      merchantOrderId: flowData.merchantOrderId,
      userRequestedAmount: flowData.userRequestedAmount,
      userRequestedCurrency: flowData.userRequestedCurrency,
      flow: {
        step1_user_request: {
          timestamp: flowData.userRequestTimestamp,
          amount: flowData.userRequestedAmount,
          currency: flowData.userRequestedCurrency,
          network: flowData.networkSymbol,
          userAgent: flowData.userAgent,
          ip: flowData.ip
        },
        step2_api_request: {
          timestamp: flowData.apiRequestTimestamp,
          endpoint: flowData.apiEndpoint,
          method: 'POST',
          requestSize: flowData.requestSize
        },
        step3_api_response: {
          timestamp: flowData.apiResponseTimestamp,
          statusCode: flowData.apiStatusCode,
          responseTime: flowData.responseTime,
          responseSize: flowData.responseSize,
          success: flowData.apiSuccess
        },
        step4_user_response: {
          timestamp: flowData.userResponseTimestamp,
          paymentUrl: flowData.paymentUrl,
          expiresAt: flowData.expiresAt
        }
      },
      totalFlowTime: `${flowData.totalFlowTime}ms`,
      success: flowData.success
    });
  }

  /**
   * Log detailed webhook processing
   * @param {Object} webhookData - Complete webhook data
   * @param {Object} processingDetails - Processing details
   */
  logWebhookProcessing(webhookData, processingDetails) {
    this.info('Webhook processing details', {
      type: 'webhook_processing',
      merchantOrderId: webhookData.merchantOrderId,
      orderId: webhookData.orderId,
      webhookReceived: {
        timestamp: processingDetails.receivedAt,
        ip: processingDetails.ip,
        userAgent: processingDetails.userAgent,
        signature: processingDetails.signature,
        signatureValid: processingDetails.signatureValid
      },
      paymentDetails: {
        status: webhookData.status,
        baseAmount: webhookData.baseAmount,
        baseAmountReceived: webhookData.baseAmountReceived,
        settledAmount: webhookData.settledAmount,
        settledAmountReceived: webhookData.settledAmountReceived,
        settledAmountCredited: webhookData.settledAmountCredited,
        commission: webhookData.commission,
        network: webhookData.network,
        depositAddress: webhookData.depositAddress,
        transactions: webhookData.transactions
      },
      processing: {
        databaseUpdateSuccess: processingDetails.dbUpdateSuccess,
        walletCreditSuccess: processingDetails.walletCreditSuccess,
        walletCreditAmount: processingDetails.walletCreditAmount,
        previousWalletBalance: processingDetails.previousWalletBalance,
        newWalletBalance: processingDetails.newWalletBalance,
        transactionId: processingDetails.transactionId,
        processingTime: `${processingDetails.processingTime}ms`
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log error in WebSocket communication
   * @param {string} stage - Stage where error occurred
   * @param {Error} error - Error object
   * @param {Object} context - Additional context
   */
  logWebSocketError(stage, error, context) {
    this.error(`WebSocket error in ${stage}`, {
      type: 'websocket_error',
      stage,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      context: {
        userId: context.userId,
        merchantOrderId: context.merchantOrderId,
        requestedAmount: context.requestedAmount,
        timestamp: new Date().toISOString()
      }
    });
  }
}

module.exports = CryptoPaymentLogger;
