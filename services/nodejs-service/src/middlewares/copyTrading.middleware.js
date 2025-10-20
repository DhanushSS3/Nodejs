const copyTradingHooks = require('../services/copyTrading.hooks');
const logger = require('../services/logger.service');

/**
 * Middleware to validate copy trading constraints before order placement
 */
async function validateCopyTradingConstraints(req, res, next) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const userType = req.body?.user_type || 'live';

    // Skip validation for demo accounts
    if (userType !== 'live' || !userId) {
      return next();
    }

    // Check if user can place manual orders (not in copy trading mode)
    const validation = await copyTradingHooks.validateUserCanPlaceOrders(userId, userType);
    
    if (!validation.canPlace) {
      return res.status(403).json({
        success: false,
        message: validation.reason || 'Cannot place orders while copy trading is active',
        error_code: 'COPY_TRADING_ACTIVE'
      });
    }

    next();
  } catch (error) {
    logger.error('Copy trading validation middleware failed', {
      userId: req.user?.id,
      error: error.message
    });
    
    // Allow request to proceed on validation error to avoid blocking users
    next();
  }
}

/**
 * Middleware to validate order modification constraints for copy trading
 */
async function validateOrderModification(req, res, next) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const orderId = req.params?.order_id || req.body?.order_id;

    if (!userId || !orderId) {
      return next();
    }

    // Check if order can be modified (not a copied order)
    const validation = await copyTradingHooks.validateOrderModification(orderId, userId);
    
    if (!validation.canModify) {
      return res.status(403).json({
        success: false,
        message: validation.reason || 'Cannot modify copied orders',
        error_code: 'COPIED_ORDER_MODIFICATION_DENIED'
      });
    }

    next();
  } catch (error) {
    logger.error('Order modification validation middleware failed', {
      userId: req.user?.id,
      orderId: req.params?.order_id || req.body?.order_id,
      error: error.message
    });
    
    // Allow request to proceed on validation error
    next();
  }
}

/**
 * Middleware to trigger copy trading hooks after successful order operations
 */
function triggerCopyTradingHooks(req, res, next) {
  // Store original res.json to intercept successful responses
  const originalJson = res.json;
  
  res.json = function(data) {
    // Check if response indicates success
    if (data && data.success === true && data.order_id) {
      const userType = req.body?.user_type || 'live';
      
      // Trigger copy trading hooks asynchronously
      setImmediate(() => {
        copyTradingHooks.onOrderPlaced({
          order_id: data.order_id,
          ...req.body
        }, userType).catch(error => {
          logger.error('Copy trading hooks failed after order placement', {
            orderId: data.order_id,
            error: error.message
          });
        });
      });
    }
    
    // Call original res.json
    return originalJson.call(this, data);
  };
  
  next();
}

module.exports = {
  validateCopyTradingConstraints,
  validateOrderModification,
  triggerCopyTradingHooks
};
