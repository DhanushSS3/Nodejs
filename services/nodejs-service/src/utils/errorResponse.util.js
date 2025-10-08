const Logger = require('../services/logger.service');

/**
 * Error Response Utility
 * Provides standardized error handling for API endpoints
 * Logs detailed errors while returning generic messages to users
 */
class ErrorResponse {
  /**
   * Handle validation errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Array|Object} validationErrors - Validation errors from express-validator or custom validation
   * @param {string} operation - Description of the operation
   */
  static validationError(req, res, validationErrors, operation = 'validation') {
    // Log validation errors for debugging
    Logger.logErrorToFile(new Error('Validation Error'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous',
      userType: req.user?.user_type || req.user?.account_type || 'unknown',
      requestData: {
        params: req.params,
        query: req.query,
        body: Logger.sanitizeRequestBody(req.body)
      },
      additionalContext: {
        validation_errors: validationErrors,
        operation: operation,
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      }
    });

    return res.status(400).json({
      success: false,
      message: 'Invalid input provided. Please check your data and try again.',
      error_code: 'VALIDATION_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle duplicate resource errors (email, phone, etc.)
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {string} message - Specific duplicate error message
   * @param {string} operation - Description of the operation
   */
  static duplicateError(req, res, message, operation = 'duplicate check') {
    // Log duplicate errors for debugging
    Logger.logErrorToFile(new Error('Duplicate Resource Error'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous',
      userType: req.user?.user_type || req.user?.account_type || 'unknown',
      requestData: {
        params: req.params,
        query: req.query,
        body: Logger.sanitizeRequestBody(req.body)
      },
      additionalContext: {
        duplicate_message: message,
        operation: operation,
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      }
    });

    return res.status(409).json({
      success: false,
      message: message,
      error_code: 'DUPLICATE_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle authentication errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {string} message - Optional custom message
   */
  static authenticationError(req, res, message = 'Authentication failed. Please login again.') {
    Logger.logErrorToFile(new Error('Authentication Error'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: 'unauthenticated',
      userType: 'unknown',
      additionalContext: {
        operation: 'authentication',
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
        authorization_header: req.headers.authorization ? 'present' : 'missing'
      }
    });

    return res.status(401).json({
      success: false,
      message: message,
      error_code: 'AUTHENTICATION_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle authorization errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {string} message - Optional custom message
   */
  static authorizationError(req, res, message = 'You do not have permission to perform this action.') {
    Logger.logErrorToFile(new Error('Authorization Error'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous',
      userType: req.user?.user_type || req.user?.account_type || 'unknown',
      additionalContext: {
        operation: 'authorization',
        user_role: req.user?.role || 'unknown',
        required_permissions: req.requiredPermissions || [],
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      }
    });

    return res.status(403).json({
      success: false,
      message: message,
      error_code: 'AUTHORIZATION_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle not found errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {string} resource - Resource that was not found
   */
  static notFoundError(req, res, resource = 'Resource') {
    Logger.logErrorToFile(new Error('Resource Not Found'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous',
      userType: req.user?.user_type || req.user?.account_type || 'unknown',
      additionalContext: {
        operation: 'resource_lookup',
        resource: resource,
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      }
    });

    return res.status(404).json({
      success: false,
      message: `${resource} not found.`,
      error_code: 'NOT_FOUND_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle rate limiting errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  static rateLimitError(req, res) {
    Logger.logErrorToFile(new Error('Rate Limit Exceeded'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous',
      userType: req.user?.user_type || req.user?.account_type || 'unknown',
      additionalContext: {
        operation: 'rate_limiting',
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      }
    });

    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again later.',
      error_code: 'RATE_LIMIT_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle service unavailable errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {string} service - Service that is unavailable
   */
  static serviceUnavailableError(req, res, service = 'Service') {
    Logger.logErrorToFile(new Error('Service Unavailable'), {
      endpoint: `${req.method} ${req.originalUrl}`,
      method: req.method,
      userId: req.user?.sub || req.user?.user_id || req.user?.id || 'anonymous',
      userType: req.user?.user_type || req.user?.account_type || 'unknown',
      additionalContext: {
        operation: 'service_availability',
        service: service,
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      }
    });

    return res.status(503).json({
      success: false,
      message: 'Service is temporarily unavailable. Please try again later.',
      error_code: 'SERVICE_UNAVAILABLE_ERROR',
      correlation_id: Logger.generateCorrelationId(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle generic server errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Error} error - The actual error object
   * @param {string} operation - Description of the operation
   */
  static serverError(req, res, error, operation = 'server operation') {
    return Logger.handleApiError(error, req, res, operation, 500);
  }

  /**
   * Handle database errors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Error} error - The database error
   * @param {string} operation - Description of the database operation
   */
  static databaseError(req, res, error, operation = 'database operation') {
    return Logger.handleApiError(error, req, res, operation, 500);
  }

  /**
   * Handle external service errors (Redis, RabbitMQ, etc.)
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Error} error - The service error
   * @param {string} service - Name of the external service
   */
  static externalServiceError(req, res, error, service = 'external service') {
    return Logger.handleApiError(error, req, res, `${service} operation`, 503);
  }

  /**
   * Success response helper
   * @param {Object} res - Express response object
   * @param {string} message - Success message
   * @param {Object} data - Response data
   * @param {number} statusCode - HTTP status code (default: 200)
   */
  static success(res, message, data = null, statusCode = 200) {
    const response = {
      success: true,
      message: message,
      timestamp: new Date().toISOString()
    };

    if (data !== null) {
      response.data = data;
    }

    return res.status(statusCode).json(response);
  }
}

module.exports = ErrorResponse;
