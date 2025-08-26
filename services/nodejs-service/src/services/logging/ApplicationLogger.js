const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

/**
 * Application Logger following Single Responsibility Principle
 * Handles general application logging operations
 */
class ApplicationLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('application', {
      filename: 'application.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    });
    super(logger);
  }

  /**
   * Log financial operation (specialized logging for audit trail)
   * @param {string} operation 
   * @param {Object} details 
   */
  logFinancialOperation(operation, details = {}) {
    this.info(`Financial operation: ${operation}`, {
      type: 'financial_operation',
      operation,
      financial: true,
      ...details
    });
  }

  /**
   * Log transaction start
   * @param {string} operation 
   * @param {Object} context 
   */
  logTransactionStart(operation, context = {}) {
    this.info(`Transaction started: ${operation}`, {
      type: 'transaction_start',
      transactionPhase: 'start',
      operation,
      ...context
    });
  }

  /**
   * Log transaction success
   * @param {string} operation 
   * @param {Object} context 
   */
  logTransactionSuccess(operation, context = {}) {
    this.info(`Transaction completed: ${operation}`, {
      type: 'transaction_success',
      transactionPhase: 'success',
      operation,
      ...context
    });
  }

  /**
   * Log transaction failure
   * @param {string} operation 
   * @param {Error} error 
   * @param {Object} context 
   */
  logTransactionFailure(operation, error, context = {}) {
    this.error(`Transaction failed: ${operation}`, {
      type: 'transaction_failure',
      transactionPhase: 'failure',
      operation,
      error: error.message,
      stack: error.stack,
      ...context
    });
  }
}

module.exports = ApplicationLogger;
