const { validationResult } = require('express-validator');

/**
 * Middleware to handle express-validator validation results
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object  
 * @param {Function} next - Express next function
 */
const validateRequest = (req, res, next) => {
  console.log('=== VALIDATION MIDDLEWARE CALLED ===');
  console.log('URL:', req.originalUrl || req.url);
  console.log('Method:', req.method);
  console.log('Body:', req.body);
  
  const errors = validationResult(req);
  console.log('Validation errors:', errors.array());
  
  if (!errors.isEmpty()) {
    console.log('VALIDATION FAILED - returning 400');
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(error => ({
        field: error.path || error.param,
        message: error.msg,
        value: error.value
      }))
    });
  }
  
  console.log('VALIDATION SUCCESS - calling next()');
  next();
};

module.exports = {
  validateRequest
};
