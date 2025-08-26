const winston = require('winston');
const path = require('path');

/**
 * Logger Factory following Factory Pattern and SOLID principles
 * Single Responsibility: Creates and configures loggers
 * Open/Closed: Easy to extend with new logger types
 * Dependency Inversion: Depends on abstractions (winston interface)
 */
class LoggerFactory {
  static loggers = new Map();

  /**
   * Create or get existing logger instance
   * @param {string} loggerName - Name of the logger
   * @param {Object} options - Logger configuration options
   * @returns {winston.Logger}
   */
  static getLogger(loggerName, options = {}) {
    if (this.loggers.has(loggerName)) {
      return this.loggers.get(loggerName);
    }

    const logger = this.createLogger(loggerName, options);
    this.loggers.set(loggerName, logger);
    return logger;
  }

  /**
   * Create a new winston logger instance
   * @param {string} loggerName - Name of the logger
   * @param {Object} options - Configuration options
   * @returns {winston.Logger}
   */
  static createLogger(loggerName, options = {}) {
    const {
      filename = `${loggerName}.log`,
      level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'debug' : 'info'),
      maxsize = 5242880, // 5MB
      maxFiles = 5,
      format = this.getLogFormat()
    } = options;

    return winston.createLogger({
      level,
      format,
      transports: [
        new winston.transports.File({
          filename: path.join(__dirname, '../../../logs', filename),
          maxsize,
          maxFiles,
        }),
        // Add console transport for development
        ...(process.env.NODE_ENV === 'development' ? [
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize(),
              winston.format.simple()
            )
          })
        ] : [])
      ]
    });
  }

  /**
   * Get appropriate log format based on environment
   * @returns {winston.Format}
   */
  static getLogFormat() {
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    if (isDevelopment) {
      // Human-readable format for development
      return winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
          return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
        })
      );
    } else {
      // Structured JSON format for production
      return winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      );
    }
  }

  /**
   * Clear all cached loggers (useful for testing)
   */
  static clearLoggers() {
    this.loggers.clear();
  }
}

module.exports = LoggerFactory;
