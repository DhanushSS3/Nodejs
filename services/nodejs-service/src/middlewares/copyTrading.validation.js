const { body, param, validationResult } = require('express-validator');

/**
 * Validation middleware for copy follower SL/TP settings update
 */
const validateSlTpSettingsUpdate = [
  // Validate account ID parameter
  param('id')
    .isInt({ min: 1 })
    .withMessage('Account ID must be a positive integer'),

  // Validate copy_sl_mode
  body('copy_sl_mode')
    .optional()
    .isIn(['none', 'percentage', 'amount'])
    .withMessage('copy_sl_mode must be one of: none, percentage, amount'),

  // Validate sl_percentage
  body('sl_percentage')
    .optional()
    .isFloat({ min: 0.01, max: 100.00 })
    .withMessage('sl_percentage must be between 0.01 and 100.00'),

  // Validate sl_amount
  body('sl_amount')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('sl_amount must be greater than 0'),

  // Validate copy_tp_mode
  body('copy_tp_mode')
    .optional()
    .isIn(['none', 'percentage', 'amount'])
    .withMessage('copy_tp_mode must be one of: none, percentage, amount'),

  // Validate tp_percentage
  body('tp_percentage')
    .optional()
    .isFloat({ min: 0.01, max: 1000.00 })
    .withMessage('tp_percentage must be between 0.01 and 1000.00'),

  // Validate tp_amount
  body('tp_amount')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('tp_amount must be greater than 0'),

  // Custom validation to ensure at least one field is provided
  body().custom((value, { req }) => {
    const {
      copy_sl_mode,
      sl_percentage,
      sl_amount,
      copy_tp_mode,
      tp_percentage,
      tp_amount
    } = req.body;

    const hasSlTpFields = copy_sl_mode !== undefined || 
                         sl_percentage !== undefined || 
                         sl_amount !== undefined ||
                         copy_tp_mode !== undefined || 
                         tp_percentage !== undefined || 
                         tp_amount !== undefined;

    if (!hasSlTpFields) {
      throw new Error('At least one SL/TP setting must be provided');
    }

    return true;
  }),

  // Custom validation for conditional requirements
  body().custom((value, { req }) => {
    const { copy_sl_mode, sl_percentage, sl_amount } = req.body;

    // If copy_sl_mode is percentage, sl_percentage is required
    if (copy_sl_mode === 'percentage' && (sl_percentage === undefined || sl_percentage === null)) {
      throw new Error('sl_percentage is required when copy_sl_mode is percentage');
    }

    // If copy_sl_mode is amount, sl_amount is required
    if (copy_sl_mode === 'amount' && (sl_amount === undefined || sl_amount === null)) {
      throw new Error('sl_amount is required when copy_sl_mode is amount');
    }

    return true;
  }),

  body().custom((value, { req }) => {
    const { copy_tp_mode, tp_percentage, tp_amount } = req.body;

    // If copy_tp_mode is percentage, tp_percentage is required
    if (copy_tp_mode === 'percentage' && (tp_percentage === undefined || tp_percentage === null)) {
      throw new Error('tp_percentage is required when copy_tp_mode is percentage');
    }

    // If copy_tp_mode is amount, tp_amount is required
    if (copy_tp_mode === 'amount' && (tp_amount === undefined || tp_amount === null)) {
      throw new Error('tp_amount is required when copy_tp_mode is amount');
    }

    return true;
  }),

  // Middleware to handle validation errors
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array().map(error => error.msg)
      });
    }
    next();
  }
];

/**
 * Validation middleware for getting SL/TP settings
 */
const validateSlTpSettingsGet = [
  // Validate account ID parameter
  param('id')
    .isInt({ min: 1 })
    .withMessage('Account ID must be a positive integer'),

  // Middleware to handle validation errors
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array().map(error => error.msg)
      });
    }
    next();
  }
];

module.exports = {
  validateSlTpSettingsUpdate,
  validateSlTpSettingsGet
};
