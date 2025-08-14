const { validationResult } = require('express-validator');
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

  // Database not initialized (e.g., table missing)
  if (err.name === 'SequelizeDatabaseError') {
    const code = err.original?.code || err.parent?.code;
    const errno = err.original?.errno || err.parent?.errno;
    const message = (err.original?.sqlMessage || err.parent?.sqlMessage || '').toLowerCase();
    // MySQL/MariaDB missing table error code is ER_NO_SUCH_TABLE (1146)
    if (code === 'ER_NO_SUCH_TABLE' || errno === 1146 || message.includes('no such table')) {
      return res.status(503).json({
        success: false,
        message: 'Database not initialized. Please run migrations and seed data.'
      });
    }
    // MySQL/MariaDB unknown column error code is ER_BAD_FIELD_ERROR (1054)
    if (code === 'ER_BAD_FIELD_ERROR' || errno === 1054 || message.includes('unknown column')) {
      return res.status(503).json({
        success: false,
        message: 'Database schema mismatch. Please run the latest migrations.'
      });
    }
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

/**
 * Middleware to handle validation errors from express-validator
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      message: 'Validation failed', 
      errors: errors.array().map(err => ({ field: err.path, message: err.msg }))
    });
  }
  next();
}

module.exports = {
  errorHandler,
  notFoundHandler,
  timeoutHandler,
  handleValidationErrors
};