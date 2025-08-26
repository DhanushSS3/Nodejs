/**
 * Base Logger Interface following Interface Segregation Principle
 * Defines common logging contract that all specialized loggers must implement
 */
class BaseLogger {
  constructor(logger) {
    if (!logger) {
      throw new Error('Logger instance is required');
    }
    this.logger = logger;
  }

  /**
   * Log info level message
   * @param {string} message 
   * @param {Object} context 
   */
  info(message, context = {}) {
    this.logger.info(message, context);
  }

  /**
   * Log warning level message
   * @param {string} message 
   * @param {Object} context 
   */
  warn(message, context = {}) {
    this.logger.warn(message, context);
  }

  /**
   * Log error level message
   * @param {string} message 
   * @param {Object} context 
   */
  error(message, context = {}) {
    this.logger.error(message, context);
  }

  /**
   * Log debug level message
   * @param {string} message 
   * @param {Object} context 
   */
  debug(message, context = {}) {
    this.logger.debug(message, context);
  }
}

module.exports = BaseLogger;
