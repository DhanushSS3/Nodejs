const logger = require('../services/logger.service');

/**
 * Global error handling middleware for financial operations
 */
function errorHandler(err, req, res, next) {
  // Log the error with context
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body
  });

  // Handle specific error types
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors.map(error => ({
        field: error.path,
        message: error.message
      }))
    });
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      success: false,
      message: 'Duplicate entry',
      field: err.errors[0]?.path || 'unknown'
    });
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid reference'
    });
  }

  // Database connection errors
  if (err.name === 'SequelizeConnectionError' || err.name === 'SequelizeConnectionRefusedError') {
    return res.status(503).json({
      success: false,
      message: 'Service temporarily unavailable'
    });
  }

  // Deadlock errors (should be handled by transaction service, but just in case)
  if (err.original && err.original.code === 'ER_LOCK_DEADLOCK') {
    return res.status(503).json({
      success: false,
      message: 'System temporarily busy, please try again'
    });
  }

  // Default error response
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { 
      error: err.message,
      stack: err.stack 
    })
  });
}

/**
 * 404 handler
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
}

/**
 * Request timeout handler
 */
function timeoutHandler(timeout = 30000) {
  return (req, res, next) => {
    req.setTimeout(timeout, () => {
      const err = new Error('Request timeout');
      err.status = 408;
      next(err);
    });
    next();
  };
}

module.exports = {
  errorHandler,
  notFoundHandler,
  timeoutHandler
};