const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Preserve native console methods so we can override them later without recursion
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleWarn = console.warn.bind(console);
const nativeConsoleError = console.error.bind(console);

// Winston logger for file-based error logging with rotation
const errorLogger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'errors-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '30d',
      zippedArchive: true,
      level: 'error'
    })
  ]
});

// Winston logger for general application logs with rotation
const appLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'application-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: '15d',
      zippedArchive: true
    })
  ]
});

// Dedicated Redis audit logger (captures creations/removals of key order structures)
const redisLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'redis-audit-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '14d',
      zippedArchive: true
    })
  ]
});

// Dedicated symbol_holders logger (tracks membership changes separately)
const symbolHoldersLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'symbol-holders-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      zippedArchive: true
    })
  ]
});

function writeApplicationLog(level, message, context) {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context
  };
  try {
    appLogger.log({ level, message, ...payload });
  } catch (err) {
    nativeConsoleError('Failed to write application log', err);
  }
}

function captureConsoleOutput(level, args) {
  try {
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch (_) { return String(arg); }
    }).join(' ');
    writeApplicationLog(level, message, { source: 'console' });
  } catch (err) {
    nativeConsoleError('Console capture failed', err);
  }
}

console.log = (...args) => {
  captureConsoleOutput('info', args);
  nativeConsoleLog(...args);
};

console.info = console.log;

console.warn = (...args) => {
  captureConsoleOutput('warn', args);
  nativeConsoleWarn(...args);
};

console.error = (...args) => {
  captureConsoleOutput('error', args);
  nativeConsoleError(...args);
};

/**
 * Logger service for financial trading system
 * Provides structured logging for transactions, errors, and operations
 * Includes file-based error logging with rotation for production use
 */
class Logger {
  /**
   * Log info message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static info(message, context = {}) {
    const payload = {
      level: 'info',
      timestamp: new Date().toISOString(),
      message,
      ...context
    };
    nativeConsoleLog(JSON.stringify(payload));
    writeApplicationLog('info', message, context);
  }

  /**
   * Log warning message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static warn(message, context = {}) {
    const payload = {
      level: 'warn',
      timestamp: new Date().toISOString(),
      message,
      ...context
    };
    nativeConsoleWarn(JSON.stringify(payload));
    writeApplicationLog('warn', message, context);
  }

  /**
   * Log error message with context
   * @param {string} message 
   * @param {Object} context 
   */
  static error(message, context = {}) {
    const payload = {
      level: 'error',
      timestamp: new Date().toISOString(),
      message,
      ...context
    };
    nativeConsoleError(JSON.stringify(payload));
    writeApplicationLog('error', message, context);
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

  /**
   * Log error to file with detailed context (for internal debugging)
   * This method logs detailed error information to files for debugging
   * while keeping user-facing responses generic
   * @param {Error} error - The error object
   * @param {Object} context - Additional context information
   * @param {string} endpoint - API endpoint where error occurred
   * @param {string} userId - User ID if available
   * @param {Object} requestData - Request data that caused the error
   */
  static logErrorToFile(error, context = {}) {
    const errorData = {
      timestamp: new Date().toISOString(),
      error_type: error.constructor.name,
      error_message: error.message,
      stack_trace: error.stack,
      endpoint: context.endpoint || 'unknown',
      method: context.method || 'unknown',
      user_id: context.userId || 'anonymous',
      user_type: context.userType || 'unknown',
      request_data: context.requestData || {},
      additional_context: context.additionalContext || {},
      correlation_id: context.correlationId || this.generateCorrelationId()
    };

    // Log to file using Winston
    errorLogger.error('API_ERROR', errorData);

    // Also log to console for development
    console.error('ERROR_LOGGED:', JSON.stringify({
      correlation_id: errorData.correlation_id,
      endpoint: errorData.endpoint,
      error_type: errorData.error_type,
      user_id: errorData.user_id
    }));
  }

  /**
   * Log application info to file
   * @param {string} message 
   * @param {Object} context 
   */
  static logInfoToFile(message, context = {}) {
    appLogger.info(message, {
      timestamp: new Date().toISOString(),
      ...context
    });
  }

  /**
   * Write Redis audit trail entry (e.g., key creation/removal)
   * @param {string} message 
   * @param {Object} context 
   */
  static redis(message, context = {}) {
    redisLogger.info(message, {
      timestamp: new Date().toISOString(),
      ...context
    });
  }

  /**
   * Log symbol_holders membership changes
   * @param {string} message
   * @param {Object} context
   */
  static symbolHolders(message, context = {}) {
    symbolHoldersLogger.info(message, {
      timestamp: new Date().toISOString(),
      ...context
    });
  }

  /**
   * Generate a unique correlation ID for error tracking
   * @returns {string} Correlation ID
   */
  static generateCorrelationId() {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get generic error messages for different error types
   * This ensures users don't see sensitive internal error details
   * @param {Error} error - The error object
   * @param {string} operation - The operation being performed
   * @returns {Object} Generic error response
   */
  static getGenericErrorResponse(error, operation = 'operation') {
    const correlationId = this.generateCorrelationId();
    
    // Map specific error types to user-friendly messages
    const errorMessages = {
      'ValidationError': 'Invalid input provided. Please check your data and try again.',
      'SequelizeValidationError': 'Invalid input provided. Please check your data and try again.',
      'SequelizeUniqueConstraintError': 'This record already exists. Please use different values.',
      'SequelizeForeignKeyConstraintError': 'Invalid reference data provided.',
      'SequelizeTimeoutError': 'Service is temporarily unavailable. Please try again later.',
      'SequelizeConnectionError': 'Service is temporarily unavailable. Please try again later.',
      'JsonWebTokenError': 'Authentication failed. Please login again.',
      'TokenExpiredError': 'Your session has expired. Please login again.',
      'MulterError': 'File upload failed. Please check file size and format.',
      'SyntaxError': 'Invalid request format. Please check your input.',
      'TypeError': 'Service is temporarily unavailable. Please try again later.',
      'ReferenceError': 'Service is temporarily unavailable. Please try again later.',
      'RangeError': 'Invalid input range provided.',
      'Error': 'Service is temporarily unavailable. Please try again later.'
    };

    const errorType = error.constructor.name;
    const genericMessage = errorMessages[errorType] || errorMessages['Error'];

    return {
      success: false,
      message: genericMessage,
      error_code: 'SERVICE_ERROR',
      correlation_id: correlationId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Handle API errors with logging and generic response
   * This is the main method to use in controllers for error handling
   * @param {Error} error - The error object
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {string} operation - Description of the operation
   * @param {number} statusCode - HTTP status code (default: 500)
   */
  static handleApiError(error, req, res, operation = 'API operation', statusCode = 500) {
    // Extract user information from request
    const userId = req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous';
    const userType = req.user?.user_type || req.user?.account_type || 'unknown';

    // Log detailed error information to file
    this.logErrorToFile(error, {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: userId,
      userType: userType,
      requestData: {
        params: req.params,
        query: req.query,
        body: this.sanitizeRequestBody(req.body)
      },
      additionalContext: {
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
        operation: operation
      }
    });

    // Return generic error response to user
    const genericResponse = this.getGenericErrorResponse(error, operation);
    res.status(statusCode).json(genericResponse);
  }

  /**
   * Sanitize request body to remove sensitive information before logging
   * @param {Object} body - Request body
   * @returns {Object} Sanitized body
   */
  static sanitizeRequestBody(body) {
    if (!body || typeof body !== 'object') return body;

    const sensitiveFields = [
      'password', 'confirm_password', 'old_password', 'new_password',
      'token', 'refresh_token', 'access_token', 'api_key', 'secret',
      'otp', 'pin', 'cvv', 'card_number', 'account_number'
    ];

    const sanitized = { ...body };
    
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }
}

module.exports = Logger;