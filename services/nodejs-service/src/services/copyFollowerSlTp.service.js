const logger = require('./logger.service');
const groupsCache = require('./groups.cache.service');
// Note: copyTrading.orders.controller is loaded lazily to avoid circular dependency

/**
 * Service for calculating and applying stop loss and take profit for copy follower orders
 */
class CopyFollowerSlTpService {
  
  /**
   * Calculate SL/TP prices based on copy follower account settings
   * @param {Object} followerOrder - Copy follower order
   * @param {Object} followerAccount - Copy follower account with SL/TP settings
   * @param {Object} executionResult - Order execution result with actual execution price
   * @returns {Object} SL/TP calculation results
   */
  static async calculateSlTpPrices(followerOrder, followerAccount, executionResult = null) {
    try {
      const result = {
        stopLoss: null,
        takeProfit: null,
        hasStopLoss: false,
        hasTakeProfit: false
      };

      // Use execution price if available, otherwise fall back to order price
      const orderPrice = executionResult?.executionPrice 
        ? parseFloat(executionResult.executionPrice)
        : parseFloat(followerOrder.order_price);
      const orderType = followerOrder.order_type;
      const orderQuantity = parseFloat(followerOrder.order_quantity);

      // Get contract size from group configuration
      let contractSize = 100000; // Default for forex
      try {
        // Get copy follower account to find group name
        const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
        const account = await CopyFollowerAccount.findByPk(followerOrder.copy_follower_account_id);
        if (account && account.group_name) {
          const groupFields = await groupsCache.getGroupFields(account.group_name, followerOrder.symbol, ['contract_size']);
          if (groupFields && groupFields.contract_size) {
            contractSize = parseFloat(groupFields.contract_size);
          }
        }
      } catch (error) {
        logger.warn('Failed to get contract size from group config, using default', {
          orderId: followerOrder.order_id,
          error: error.message
        });
      }

      // Calculate Stop Loss
      if (followerAccount.copy_sl_mode && followerAccount.copy_sl_mode !== 'none') {
        result.hasStopLoss = true;
        
        if (followerAccount.copy_sl_mode === 'percentage') {
          const slPercentage = parseFloat(followerAccount.sl_percentage || 0);
          if (slPercentage > 0) {
            // For BUY: SL = entry_price * (1 - sl_percentage/100)
            // For SELL: SL = entry_price * (1 + sl_percentage/100)
            if (orderType === 'BUY') {
              result.stopLoss = orderPrice * (1 - slPercentage / 100);
            } else if (orderType === 'SELL') {
              result.stopLoss = orderPrice * (1 + slPercentage / 100);
            }
          }
        } else if (followerAccount.copy_sl_mode === 'amount') {
          const slAmount = parseFloat(followerAccount.sl_amount || 0);
          if (slAmount > 0 && orderQuantity > 0) {
            // Calculate price movement needed to lose slAmount
            // Loss = (entry_price - sl_price) * lot_size * contract_size
            const priceMovement = slAmount / (orderQuantity * contractSize);
            
            if (orderType === 'BUY') {
              result.stopLoss = orderPrice - priceMovement;
            } else if (orderType === 'SELL') {
              result.stopLoss = orderPrice + priceMovement;
            }
          }
        }
      }

      // Calculate Take Profit
      if (followerAccount.copy_tp_mode && followerAccount.copy_tp_mode !== 'none') {
        result.hasTakeProfit = true;
        
        if (followerAccount.copy_tp_mode === 'percentage') {
          const tpPercentage = parseFloat(followerAccount.tp_percentage || 0);
          if (tpPercentage > 0) {
            // For BUY: TP = entry_price * (1 + tp_percentage/100)
            // For SELL: TP = entry_price * (1 - tp_percentage/100)
            if (orderType === 'BUY') {
              result.takeProfit = orderPrice * (1 + tpPercentage / 100);
            } else if (orderType === 'SELL') {
              result.takeProfit = orderPrice * (1 - tpPercentage / 100);
            }
          }
        } else if (followerAccount.copy_tp_mode === 'amount') {
          const tpAmount = parseFloat(followerAccount.tp_amount || 0);
          if (tpAmount > 0 && orderQuantity > 0) {
            // Calculate price movement needed to gain tpAmount
            const priceMovement = tpAmount / (orderQuantity * contractSize);
            
            if (orderType === 'BUY') {
              result.takeProfit = orderPrice + priceMovement;
            } else if (orderType === 'SELL') {
              result.takeProfit = orderPrice - priceMovement;
            }
          }
        }
      }

      // Round to appropriate decimal places (typically 5 for forex)
      if (result.stopLoss) {
        result.stopLoss = parseFloat(result.stopLoss.toFixed(5));
      }
      if (result.takeProfit) {
        result.takeProfit = parseFloat(result.takeProfit.toFixed(5));
      }

      logger.info('SL/TP prices calculated for copy follower order', {
        orderId: followerOrder.order_id,
        orderType,
        orderPrice,
        orderQuantity,
        contractSize,
        slMode: followerAccount.copy_sl_mode,
        tpMode: followerAccount.copy_tp_mode,
        calculatedSL: result.stopLoss,
        calculatedTP: result.takeProfit
      });

      return result;

    } catch (error) {
      logger.error('Failed to calculate SL/TP prices', {
        orderId: followerOrder.order_id,
        error: error.message
      });
      return {
        stopLoss: null,
        takeProfit: null,
        hasStopLoss: false,
        hasTakeProfit: false,
        error: error.message
      };
    }
  }

  /**
   * Apply SL/TP to copy follower order after successful placement
   * @param {Object} followerOrder - Copy follower order
   * @param {Object} followerAccount - Copy follower account with SL/TP settings
   * @param {Object} executionResult - Order execution result
   * @returns {Object} SL/TP application results
   */
  static async applySlTpToFollowerOrder(followerOrder, followerAccount, executionResult) {
    try {
      // Only apply SL/TP if order was successfully placed
      if (!executionResult.success || !executionResult.data) {
        return { success: false, reason: 'Order execution failed' };
      }

      // Calculate SL/TP prices using actual execution result
      const slTpCalculation = await this.calculateSlTpPrices(followerOrder, followerAccount, executionResult);
      
      if (!slTpCalculation.hasStopLoss && !slTpCalculation.hasTakeProfit) {
        return { success: true, reason: 'No SL/TP configured' };
      }

      const flow = executionResult.data.flow || 'provider';
      const results = {
        success: true,
        flow,
        stopLossResult: null,
        takeProfitResult: null,
        errors: []
      };

      // Apply SL/TP using existing order controller functions
      if (slTpCalculation.hasStopLoss && slTpCalculation.stopLoss) {
        results.stopLossResult = await this.addStopLossToOrder(followerOrder, slTpCalculation.stopLoss);
      }
      
      if (slTpCalculation.hasTakeProfit && slTpCalculation.takeProfit) {
        results.takeProfitResult = await this.addTakeProfitToOrder(followerOrder, slTpCalculation.takeProfit);
      }

      // Update order record with SL/TP prices
      await this.updateOrderWithSlTp(followerOrder, slTpCalculation);

      logger.info('SL/TP applied to copy follower order', {
        orderId: followerOrder.order_id,
        flow,
        stopLoss: slTpCalculation.stopLoss,
        takeProfit: slTpCalculation.takeProfit,
        results
      });

      return results;

    } catch (error) {
      logger.error('Failed to apply SL/TP to copy follower order', {
        orderId: followerOrder.order_id,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Add stop loss to copy follower order using dedicated copy trading controller
   * @param {Object} followerOrder - Copy follower order
   * @param {number} stopLossPrice - Stop loss price
   * @returns {Object} Stop loss addition result
   */
  static async addStopLossToOrder(followerOrder, stopLossPrice) {
    if (!stopLossPrice) {
      return { success: true, reason: 'No stop loss to add' };
    }

    try {
      // Create request object for copy trading controller
      const mockReq = {
        body: {
          order_id: followerOrder.order_id,
          user_id: followerOrder.order_user_id, // copy_follower_account_id
          symbol: followerOrder.symbol,
          order_type: followerOrder.order_type,
          stop_loss: stopLossPrice,
          status: 'STOPLOSS',
          order_status: 'OPEN'
        },
        headers: {
          'x-internal-auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub'
        },
        user: {},
        ip: '127.0.0.1',
        method: 'POST',
        originalUrl: '/internal/copy-follower/stoploss/add'
      };

      // Create mock response object to capture result
      let responseData = null;
      let statusCode = null;
      const mockRes = {
        status: (code) => {
          statusCode = code;
          return mockRes;
        },
        json: (data) => {
          responseData = data;
          return mockRes;
        }
      };

      // Call the dedicated copy follower addStopLoss function (lazy load to avoid circular dependency)
      const copyTradingOrdersController = require('../controllers/copyTrading.orders.controller');
      await copyTradingOrdersController.addStopLossToCopyFollowerOrder(mockReq, mockRes);

      logger.info('Stop loss added to copy follower order', {
        orderId: followerOrder.order_id,
        stopLossPrice,
        statusCode,
        success: statusCode === 200
      });

      return {
        success: statusCode === 200,
        price: stopLossPrice,
        statusCode,
        data: responseData
      };

    } catch (error) {
      logger.error('Failed to add stop loss to copy follower order', {
        orderId: followerOrder.order_id,
        stopLossPrice,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Add take profit to copy follower order using dedicated copy trading controller
   * @param {Object} followerOrder - Copy follower order
   * @param {number} takeProfitPrice - Take profit price
   * @returns {Object} Take profit addition result
   */
  static async addTakeProfitToOrder(followerOrder, takeProfitPrice) {
    if (!takeProfitPrice) {
      return { success: true, reason: 'No take profit to add' };
    }

    try {
      // Create request object for copy trading controller
      const mockReq = {
        body: {
          order_id: followerOrder.order_id,
          user_id: followerOrder.order_user_id, // copy_follower_account_id
          symbol: followerOrder.symbol,
          order_type: followerOrder.order_type,
          take_profit: takeProfitPrice,
          status: 'TAKEPROFIT',
          order_status: 'OPEN'
        },
        headers: {
          'x-internal-auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub'
        },
        user: {},
        ip: '127.0.0.1',
        method: 'POST',
        originalUrl: '/internal/copy-follower/takeprofit/add'
      };

      // Create mock response object to capture result
      let responseData = null;
      let statusCode = null;
      const mockRes = {
        status: (code) => {
          statusCode = code;
          return mockRes;
        },
        json: (data) => {
          responseData = data;
          return mockRes;
        }
      };

      // Call the dedicated copy follower addTakeProfit function (lazy load to avoid circular dependency)
      const copyTradingOrdersController = require('../controllers/copyTrading.orders.controller');
      await copyTradingOrdersController.addTakeProfitToCopyFollowerOrder(mockReq, mockRes);

      logger.info('Take profit added to copy follower order', {
        orderId: followerOrder.order_id,
        takeProfitPrice,
        statusCode,
        success: statusCode === 200
      });

      return {
        success: statusCode === 200,
        price: takeProfitPrice,
        statusCode,
        data: responseData
      };

    } catch (error) {
      logger.error('Failed to add take profit to copy follower order', {
        orderId: followerOrder.order_id,
        takeProfitPrice,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Update order record with SL/TP prices
   * @param {Object} followerOrder - Copy follower order
   * @param {Object} slTpCalculation - SL/TP calculation results
   */
  static async updateOrderWithSlTp(followerOrder, slTpCalculation) {
    try {
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      
      const updateData = {};
      
      if (slTpCalculation.stopLoss) {
        updateData.stop_loss = slTpCalculation.stopLoss;
      }
      
      if (slTpCalculation.takeProfit) {
        updateData.take_profit = slTpCalculation.takeProfit;
      }

      if (Object.keys(updateData).length > 0) {
        await CopyFollowerOrder.update(updateData, {
          where: { order_id: followerOrder.order_id }
        });

        logger.info('Order updated with SL/TP prices', {
          orderId: followerOrder.order_id,
          updateData
        });
      }

    } catch (error) {
      logger.error('Failed to update order with SL/TP prices', {
        orderId: followerOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Check if order is already closed to prevent duplicate closure
   * @param {string} orderId - Order ID
   * @returns {boolean} True if order is closed
   */
  static async isOrderClosed(orderId) {
    try {
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      
      const order = await CopyFollowerOrder.findOne({
        where: { order_id: orderId },
        attributes: ['order_status']
      });

      return order && order.order_status === 'CLOSED';

    } catch (error) {
      logger.error('Failed to check order status', {
        orderId,
        error: error.message
      });
      return false;
    }
  }
}

module.exports = CopyFollowerSlTpService;
