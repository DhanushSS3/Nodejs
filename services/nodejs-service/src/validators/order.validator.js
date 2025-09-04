const { body, param } = require('express-validator');

/**
 * Validation rules for order operations
 */
class OrderValidator {
  
  /**
   * Validation rules for creating a new order
   */
  static createOrder() {
    return [
      body('order_id')
        .notEmpty()
        .withMessage('Order ID is required')
        .isLength({ max: 64 })
        .withMessage('Order ID must not exceed 64 characters'),
      
      body('order_user_id')
        .isInt({ min: 1 })
        .withMessage('User ID must be a positive integer'),
      
      body('symbol')
        .notEmpty()
        .withMessage('Symbol is required')
        .isLength({ max: 255 })
        .withMessage('Symbol must not exceed 255 characters'),
      
      body('order_type')
        .notEmpty()
        .withMessage('Order type is required')
        .isIn(['BUY', 'SELL', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'])
        .withMessage('Invalid order type'),
      
      body('order_status')
        .notEmpty()
        .withMessage('Order status is required')
        .isIn(['PENDING', 'EXECUTED', 'CANCELLED', 'REJECTED', 'PARTIAL'])
        .withMessage('Invalid order status'),
      
      body('order_price')
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Order price must be a valid decimal with up to 8 decimal places')
        .custom(value => {
          if (parseFloat(value) <= 0) {
            throw new Error('Order price must be greater than 0');
          }
          return true;
        }),
      
      body('order_quantity')
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Order quantity must be a valid decimal with up to 8 decimal places')
        .custom(value => {
          if (parseFloat(value) <= 0) {
            throw new Error('Order quantity must be greater than 0');
          }
          return true;
        }),
      
      body('contract_value')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Contract value must be a valid decimal with up to 8 decimal places'),
      
      body('margin')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Margin must be a valid decimal with up to 8 decimal places'),
      
      body('stop_loss')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Stop loss must be a valid decimal with up to 8 decimal places'),
      
      body('take_profit')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Take profit must be a valid decimal with up to 8 decimal places'),
      
      body('placed_by')
        .optional()
        .isLength({ max: 30 })
        .withMessage('Placed by must not exceed 30 characters')
        .isIn(['USER', 'ADMIN', 'SYSTEM', 'API'])
        .withMessage('Invalid placed_by value')
    ];
  }

  /**
   * Validation rules for updating an order
   */
  static updateOrder() {
    return [
      param('id')
        .isInt({ min: 1 })
        .withMessage('Order ID must be a positive integer'),
      
      body('order_status')
        .optional()
        .isIn(['PENDING', 'EXECUTED', 'CANCELLED', 'REJECTED', 'PARTIAL'])
        .withMessage('Invalid order status'),
      
      body('close_price')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Close price must be a valid decimal with up to 8 decimal places'),
      
      body('net_profit')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Net profit must be a valid decimal with up to 8 decimal places'),
      
      body('swap')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Swap must be a valid decimal with up to 8 decimal places'),
      
      body('commission')
        .optional()
        .isDecimal({ decimal_digits: '0,8' })
        .withMessage('Commission must be a valid decimal with up to 8 decimal places'),
      
      body('cancel_message')
        .optional()
        .isLength({ max: 255 })
        .withMessage('Cancel message must not exceed 255 characters'),
      
      body('close_message')
        .optional()
        .isLength({ max: 255 })
        .withMessage('Close message must not exceed 255 characters'),
      
      body('cancel_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Cancel ID must not exceed 64 characters'),
      
      body('close_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Close ID must not exceed 64 characters'),
      
      body('modify_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Modify ID must not exceed 64 characters'),
      
      body('stoploss_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Stop loss ID must not exceed 64 characters'),
      
      body('takeprofit_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Take profit ID must not exceed 64 characters'),
      
      body('stoploss_cancel_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Stop loss cancel ID must not exceed 64 characters'),
      
      body('takeprofit_cancel_id')
        .optional()
        .isLength({ max: 64 })
        .withMessage('Take profit cancel ID must not exceed 64 characters'),
      
      body('status')
        .optional()
        .isLength({ max: 30 })
        .withMessage('Status must not exceed 30 characters')
    ];
  }

  /**
   * Validation rules for getting orders by user
   */
  static getOrdersByUser() {
    return [
      param('userId')
        .isInt({ min: 1 })
        .withMessage('User ID must be a positive integer'),
      
      body('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be between 1 and 100'),
      
      body('offset')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Offset must be a non-negative integer'),
      
      body('order_status')
        .optional()
        .isIn(['PENDING', 'EXECUTED', 'CANCELLED', 'REJECTED', 'PARTIAL'])
        .withMessage('Invalid order status filter')
    ];
  }
}

module.exports = OrderValidator;
