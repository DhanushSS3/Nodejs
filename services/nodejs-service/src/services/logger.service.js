/**
 * Logger service for financial trading system
 * Provides structured logging for transactions, errors, and operations
 */
class Logger {
  /**
   * Log info message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static info(message, context = {}) {
    console.log(JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      message,
      ...context
    }));
  }

  /**
   * Log warning message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static warn(message, context = {}) {
    console.warn(JSON.stringify({
      level: 'warn',
      timestamp: new Date().toISOString(),
      message,
      ...context
    }));
  }

  /**
   * Log error message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static error(message, context = {}) {
    console.error(JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      message,
      ...context
    }));
  }

  /**
   * Log financial operation (specialized logging for audit trail)
   * @param {string} operation 
   * @param {Object} details 
   */
  static financial(operation, details = {}) {
    this.info(`FINANCIAL_OP: ${operation}`, {
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
  static transactionStart(operation, context = {}) {
    this.info(`TRANSACTION_START: ${operation}`, {
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
  static transactionSuccess(operation, context = {}) {
    this.info(`TRANSACTION_SUCCESS: ${operation}`, {
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
  static transactionFailure(operation, error, context = {}) {
    this.error(`TRANSACTION_FAILURE: ${operation}`, {
      transactionPhase: 'failure',
      operation,
      error: error.message,
      stack: error.stack,
      ...context
    });
  }
}

module.exports = Logger;