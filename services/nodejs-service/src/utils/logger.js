/**
 * Legacy Logger Compatibility Layer
 * Provides backward compatibility for existing imports while using new logging system
 */

const { applicationLogger } = require('../services/logging');

/**
 * Legacy logger interface that delegates to new ApplicationLogger
 * Maintains backward compatibility for existing code
 */
class LegacyLogger {
  /**
   * Log info message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static info(message, context = {}) {
    applicationLogger.info(message, context);
  }

  /**
   * Log warning message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static warn(message, context = {}) {
    applicationLogger.warn(message, context);
  }

  /**
   * Log error message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static error(message, context = {}) {
    applicationLogger.error(message, context);
  }

  /**
   * Log debug message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static debug(message, context = {}) {
    applicationLogger.debug(message, context);
  }

  /**
   * Log financial operation (specialized logging for audit trail)
   * @param {string} operation 
   * @param {Object} details 
   */
  static financial(operation, details = {}) {
    applicationLogger.logFinancialOperation(operation, details);
  }

  /**
   * Log transaction start
   * @param {string} operation 
   * @param {Object} context 
   */
  static transactionStart(operation, context = {}) {
    applicationLogger.logTransactionStart(operation, context);
  }

  /**
   * Log transaction success
   * @param {string} operation 
   * @param {Object} context 
   */
  static transactionSuccess(operation, context = {}) {
    applicationLogger.logTransactionSuccess(operation, context);
  }

  /**
   * Log transaction failure
   * @param {string} operation 
   * @param {Error} error 
   * @param {Object} context 
   */
  static transactionFailure(operation, error, context = {}) {
    applicationLogger.logTransactionFailure(operation, error, context);
  }
}

module.exports = LegacyLogger;
