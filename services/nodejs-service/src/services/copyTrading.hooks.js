const copyTradingService = require('./copyTrading.service');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const logger = require('./logger.service');

/**
 * Copy Trading Hooks - Integrate with existing order flow
 * These hooks are called from order controllers and model hooks
 */
class CopyTradingHooks {

  /**
   * Hook called after strategy provider order is created
   * @param {Object} order - Strategy provider order
   */
  async onStrategyProviderOrderCreated(order) {
    try {
      // Only process orders that are successfully placed (OPEN status)
      if (order.order_status === 'OPEN' && order.is_master_order) {
        logger.info('Strategy provider order created, triggering copy trading', {
          orderId: order.order_id,
          strategyProviderId: order.order_user_id,
          symbol: order.symbol
        });

        // Process copy trading asynchronously to avoid blocking the main order flow
        setImmediate(() => {
          copyTradingService.processStrategyProviderOrder(order)
            .catch(error => {
              logger.error('Copy trading processing failed', {
                orderId: order.order_id,
                error: error.message
              });
            });
        });
      }
    } catch (error) {
      logger.error('Copy trading hook failed on order creation', {
        orderId: order?.order_id,
        error: error.message
      });
    }
  }

  /**
   * Hook called after strategy provider order is updated
   * @param {Object} order - Updated strategy provider order
   * @param {Object} previousValues - Previous order values
   */
  async onStrategyProviderOrderUpdated(order, previousValues) {
    try {
      // Check if order status changed to CLOSED or CANCELLED
      const statusChanged = previousValues.order_status !== order.order_status;
      
      if (statusChanged && ['CLOSED', 'CANCELLED'].includes(order.order_status)) {
        logger.info('Strategy provider order status changed, updating copied orders', {
          orderId: order.order_id,
          oldStatus: previousValues.order_status,
          newStatus: order.order_status
        });

        // Process order updates asynchronously
        setImmediate(() => {
          copyTradingService.processStrategyProviderOrderUpdate(order)
            .catch(error => {
              logger.error('Copy trading update processing failed', {
                orderId: order.order_id,
                error: error.message
              });
            });
        });
      }
    } catch (error) {
      logger.error('Copy trading hook failed on order update', {
        orderId: order?.order_id,
        error: error.message
      });
    }
  }

  /**
   * Hook to be called from orders controller after successful order placement
   * @param {Object} orderData - Order data from controller
   * @param {string} userType - 'live' or 'demo'
   */
  async onOrderPlaced(orderData, userType) {
    try {
      // Only process live orders
      if (userType !== 'live') return;

      // Check if this order belongs to a strategy provider account
      const strategyProviderOrder = await StrategyProviderOrder.findOne({
        where: { 
          order_id: orderData.order_id,
          is_master_order: true 
        }
      });

      if (strategyProviderOrder) {
        await this.onStrategyProviderOrderCreated(strategyProviderOrder);
      }

    } catch (error) {
      logger.error('Copy trading hook failed on order placed', {
        orderId: orderData?.order_id,
        error: error.message
      });
    }
  }

  /**
   * Hook to be called from orders controller after order status update
   * @param {Object} orderData - Updated order data
   * @param {Object} previousData - Previous order data
   * @param {string} userType - 'live' or 'demo'
   */
  async onOrderUpdated(orderData, previousData, userType) {
    try {
      // Only process live orders
      if (userType !== 'live') return;

      // Check if this order belongs to a strategy provider account
      const strategyProviderOrder = await StrategyProviderOrder.findOne({
        where: { 
          order_id: orderData.order_id,
          is_master_order: true 
        }
      });

      if (strategyProviderOrder) {
        await this.onStrategyProviderOrderUpdated(strategyProviderOrder, previousData);
      }

    } catch (error) {
      logger.error('Copy trading hook failed on order updated', {
        orderId: orderData?.order_id,
        error: error.message
      });
    }
  }

  /**
   * Validate if user can place orders (check if they're not in copy trading mode)
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @returns {Object} Validation result
   */
  async validateUserCanPlaceOrders(userId, userType) {
    try {
      if (userType !== 'live') {
        return { canPlace: true };
      }

      // Check if user has active copy follower accounts
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      const activeFollowerAccounts = await CopyFollowerAccount.count({
        where: {
          user_id: userId,
          status: 1,
          is_active: 1,
          copy_status: 'active'
        }
      });

      if (activeFollowerAccounts > 0) {
        return { 
          canPlace: false, 
          reason: 'Cannot place manual orders while copy trading is active. Please pause copy trading first.' 
        };
      }

      return { canPlace: true };

    } catch (error) {
      logger.error('Failed to validate user can place orders', {
        userId,
        userType,
        error: error.message
      });
      
      // Allow trading on validation error to avoid blocking users
      return { canPlace: true };
    }
  }

  /**
   * Check if order modification is allowed for copy trading orders
   * @param {string} orderId - Order ID
   * @param {number} userId - User ID
   * @returns {Object} Validation result
   */
  async validateOrderModification(orderId, userId) {
    try {
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      
      // Check if this is a copied order
      const copiedOrder = await CopyFollowerOrder.findOne({
        where: { 
          order_id: orderId,
          copy_status: 'copied'
        }
      });

      if (copiedOrder) {
        return { 
          canModify: false, 
          reason: 'Cannot modify copied orders. Orders are managed by the strategy provider.' 
        };
      }

      return { canModify: true };

    } catch (error) {
      logger.error('Failed to validate order modification', {
        orderId,
        userId,
        error: error.message
      });
      
      // Allow modification on validation error
      return { canModify: true };
    }
  }

  /**
   * Process performance fee calculation for closed copy trading orders
   * @param {Object} copiedOrder - Closed copied order
   */
  async processPerformanceFee(copiedOrder) {
    try {
      // Only calculate fees for profitable closed orders
      if (copiedOrder.order_status !== 'CLOSED' || !copiedOrder.net_profit || copiedOrder.net_profit <= 0) {
        return;
      }

      const performanceFeePercentage = parseFloat(copiedOrder.performance_fee_percentage || 0);
      if (performanceFeePercentage <= 0) {
        return;
      }

      // Calculate performance fee
      const grossProfit = parseFloat(copiedOrder.net_profit);
      const performanceFeeAmount = (grossProfit * performanceFeePercentage) / 100;
      const netProfitAfterFees = grossProfit - performanceFeeAmount;

      // Update order with fee calculation
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      await CopyFollowerOrder.update({
        gross_profit: grossProfit,
        performance_fee_amount: performanceFeeAmount,
        net_profit_after_fees: netProfitAfterFees,
        fee_status: 'calculated',
        fee_calculation_date: new Date()
      }, {
        where: { id: copiedOrder.id }
      });

      // Update follower account total fees paid
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      await CopyFollowerAccount.increment('total_fees_paid', {
        by: performanceFeeAmount,
        where: { id: copiedOrder.copy_follower_account_id }
      });

      logger.info('Performance fee calculated for copied order', {
        orderId: copiedOrder.order_id,
        grossProfit,
        performanceFeeAmount,
        netProfitAfterFees,
        feePercentage: performanceFeePercentage
      });

    } catch (error) {
      logger.error('Failed to process performance fee', {
        orderId: copiedOrder?.order_id,
        error: error.message
      });
    }
  }
}

module.exports = new CopyTradingHooks();
