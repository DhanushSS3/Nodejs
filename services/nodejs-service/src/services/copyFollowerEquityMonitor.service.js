const logger = require('./logger.service');

/**
 * Service for monitoring copy follower equity and triggering auto stop copying
 * when equity-based SL/TP thresholds are reached
 */
class CopyFollowerEquityMonitorService {
  
  /**
   * Check if copy follower account has reached equity-based SL/TP thresholds
   * @param {Object} copyFollowerAccount - Copy follower account with SL/TP settings
   * @returns {Object} Threshold check results
   */
  static async checkEquityThresholds(copyFollowerAccount) {
    try {
      const result = {
        shouldStopCopying: false,
        reason: null,
        thresholdType: null, // 'stop_loss' or 'take_profit'
        currentEquity: null,
        thresholdValue: null,
        initialInvestment: null
      };

      // Get current equity from Python portfolio service
      const portfolioData = await this.getUserPortfolio('copy_follower', copyFollowerAccount.id);
      if (!portfolioData || portfolioData.equity === undefined) {
        logger.warn('Failed to get portfolio data for copy follower', {
          copyFollowerAccountId: copyFollowerAccount.id
        });
        return result;
      }

      const currentEquity = parseFloat(portfolioData.equity);
      const initialInvestment = parseFloat(copyFollowerAccount.initial_investment);
      
      result.currentEquity = currentEquity;
      result.initialInvestment = initialInvestment;

      // Check Stop Loss threshold
      if (copyFollowerAccount.copy_sl_mode && copyFollowerAccount.copy_sl_mode !== 'none') {
        const slThreshold = this.calculateThreshold(
          initialInvestment,
          copyFollowerAccount.copy_sl_mode,
          copyFollowerAccount.sl_percentage,
          copyFollowerAccount.sl_amount,
          'stop_loss'
        );

        if (slThreshold !== null && currentEquity <= slThreshold) {
          result.shouldStopCopying = true;
          result.reason = 'Stop loss threshold reached';
          result.thresholdType = 'stop_loss';
          result.thresholdValue = slThreshold;
          return result;
        }
      }

      // Check Take Profit threshold
      if (copyFollowerAccount.copy_tp_mode && copyFollowerAccount.copy_tp_mode !== 'none') {
        const tpThreshold = this.calculateThreshold(
          initialInvestment,
          copyFollowerAccount.copy_tp_mode,
          copyFollowerAccount.tp_percentage,
          copyFollowerAccount.tp_amount,
          'take_profit'
        );

        if (tpThreshold !== null && currentEquity >= tpThreshold) {
          result.shouldStopCopying = true;
          result.reason = 'Take profit threshold reached';
          result.thresholdType = 'take_profit';
          result.thresholdValue = tpThreshold;
          return result;
        }
      }

      return result;

    } catch (error) {
      logger.error('Failed to check equity thresholds', {
        copyFollowerAccountId: copyFollowerAccount.id,
        error: error.message
      });
      return {
        shouldStopCopying: false,
        reason: null,
        thresholdType: null,
        currentEquity: null,
        thresholdValue: null,
        initialInvestment: null,
        error: error.message
      };
    }
  }

  /**
   * Calculate threshold value based on mode (percentage or amount)
   * @param {number} initialInvestment - Initial investment amount
   * @param {string} mode - 'percentage' or 'amount'
   * @param {number} percentage - Percentage value (if mode is percentage)
   * @param {number} amount - Amount value (if mode is amount)
   * @param {string} type - 'stop_loss' or 'take_profit'
   * @returns {number|null} Calculated threshold value
   */
  static calculateThreshold(initialInvestment, mode, percentage, amount, type) {
    try {
      if (mode === 'percentage') {
        const percentageValue = parseFloat(percentage || 0);
        if (percentageValue <= 0) return null;

        if (type === 'stop_loss') {
          // SL: equity drops by X% from initial investment
          // If user sets 0.01% SL, they can lose 0.01% of their investment
          // Threshold = initial - (initial * percentage/100)
          return initialInvestment * (1 - percentageValue / 100);
        } else if (type === 'take_profit') {
          // TP: equity reaches X% above initial investment
          return initialInvestment * (1 + percentageValue / 100);
        }
      } else if (mode === 'amount') {
        const amountValue = parseFloat(amount || 0);
        if (amountValue <= 0) return null;

        if (type === 'stop_loss') {
          // SL: equity drops by X amount from initial investment
          return initialInvestment - amountValue;
        } else if (type === 'take_profit') {
          // TP: equity gains X amount above initial investment
          return initialInvestment + amountValue;
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to calculate threshold', {
        initialInvestment,
        mode,
        percentage,
        amount,
        type,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get user portfolio data from Redis (written by portfolio calculator)
   * @param {string} userType - User type (copy_follower)
   * @param {string} userId - User ID
   * @returns {Object|null} Portfolio data
   */
  static async getUserPortfolio(userType, userId) {
    try {
      const { redisCluster } = require('../../config/redis');
      
      // Portfolio calculator writes to: user_portfolio:{user_type:user_id}
      const portfolioKey = `user_portfolio:{${userType}:${userId}}`;
      
      logger.info('Attempting to get portfolio data for copy follower', {
        userType,
        userId,
        portfolioKey,
        timestamp: new Date().toISOString()
      });
      
      const portfolioData = await redisCluster.hgetall(portfolioKey);
      
      logger.info('Portfolio data retrieved from Redis', {
        userType,
        userId,
        portfolioKey,
        hasData: portfolioData && Object.keys(portfolioData).length > 0,
        dataKeys: portfolioData ? Object.keys(portfolioData) : [],
        rawData: portfolioData,
        timestamp: new Date().toISOString()
      });
      
      if (portfolioData && Object.keys(portfolioData).length > 0) {
        // Convert string values to numbers where appropriate
        const portfolio = {
          equity: parseFloat(portfolioData.equity || 0),
          balance: parseFloat(portfolioData.balance || 0),
          margin: parseFloat(portfolioData.margin || 0),
          free_margin: parseFloat(portfolioData.free_margin || 0),
          margin_level: parseFloat(portfolioData.margin_level || 0),
          profit: parseFloat(portfolioData.profit || 0),
          calc_status: portfolioData.calc_status || 'unknown',
          last_updated: portfolioData.last_updated || null
        };
        
        logger.info('Portfolio data parsed successfully', {
          userType,
          userId,
          portfolio,
          timestamp: new Date().toISOString()
        });
        
        return portfolio;
      }

      // Check if there's an error status
      const errorStatus = portfolioData?.calc_status;
      const errorCodes = portfolioData?.error_codes;
      
      logger.warn('Portfolio data missing or empty for copy follower', {
        userType,
        userId,
        portfolioKey,
        calcStatus: errorStatus,
        errorCodes: errorCodes,
        rawData: portfolioData,
        possibleCauses: [
          'Copy follower not in symbol_holders Redis set',
          'Missing wallet_balance in copy_follower_accounts table',
          'Portfolio calculation error in Python service',
          'Copy follower has no open orders'
        ],
        timestamp: new Date().toISOString()
      });

      // Attempt to backfill Redis entries for this copy follower if they have open orders
      try {
        await this.backfillCopyFollowerRedisEntries(userId);
      } catch (backfillError) {
        logger.error('Failed to backfill Redis entries for copy follower', {
          userId,
          error: backfillError.message
        });
      }

      return null;
    } catch (error) {
      logger.error('Failed to get user portfolio from Redis', {
        userType,
        userId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }

  /**
   * Trigger auto stop copying for copy follower account
   * @param {Object} copyFollowerAccount - Copy follower account
   * @param {string} reason - Reason for stopping
   * @param {string} thresholdType - 'stop_loss' or 'take_profit'
   * @returns {Object} Stop copying result
   */
  static async triggerAutoStopCopying(copyFollowerAccount, reason, thresholdType) {
    try {
      // 1. Close all open orders for this copy follower account
      const closeOrdersResult = await this.closeAllCopyFollowerOrders(copyFollowerAccount.id);
      
      // 2. Update copy follower account status
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      await CopyFollowerAccount.update({
        copy_status: 'stopped',
        stop_reason: `Auto ${thresholdType.replace('_', ' ')}: ${reason}`,
        is_active: 0,
        status: 0
      }, {
        where: { id: copyFollowerAccount.id }
      });

      // 3. Log the auto stop event
      logger.info('Auto stop copying triggered', {
        copyFollowerAccountId: copyFollowerAccount.id,
        userId: copyFollowerAccount.user_id,
        strategyProviderId: copyFollowerAccount.strategy_provider_id,
        reason,
        thresholdType,
        ordersClosedCount: closeOrdersResult.closedCount
      });

      return {
        success: true,
        reason,
        thresholdType,
        ordersClosedCount: closeOrdersResult.closedCount
      };

    } catch (error) {
      logger.error('Failed to trigger auto stop copying', {
        copyFollowerAccountId: copyFollowerAccount.id,
        reason,
        thresholdType,
        error: error.message
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close all open orders for copy follower account
   * @param {number} copyFollowerAccountId - Copy follower account ID
   * @returns {Object} Close orders result
   */
  static async closeAllCopyFollowerOrders(copyFollowerAccountId) {
    try {
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      
      // Get all open orders for this copy follower account
      const openOrders = await CopyFollowerOrder.findAll({
        where: {
          copy_follower_account_id: copyFollowerAccountId,
          order_status: 'OPEN'
        }
      });

      let closedCount = 0;
      const errors = [];

      // Close each order
      for (const order of openOrders) {
        try {
          const closeResult = await this.closeCopyFollowerOrder(order);
          if (closeResult.success) {
            closedCount++;
          } else {
            errors.push({
              orderId: order.order_id,
              error: closeResult.error
            });
          }
        } catch (error) {
          errors.push({
            orderId: order.order_id,
            error: error.message
          });
        }
      }

      return {
        success: true,
        totalOrders: openOrders.length,
        closedCount,
        errors
      };

    } catch (error) {
      logger.error('Failed to close copy follower orders', {
        copyFollowerAccountId,
        error: error.message
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close individual copy follower order using existing copy trading service
   * @param {Object} order - Copy follower order
   * @returns {Object} Close order result
   */
  static async closeCopyFollowerOrder(order) {
    try {
      // Use existing copy trading service to close the order
      const copyTradingService = require('./copyTrading.service');
      
      // Create a mock master order for the close operation
      const mockMasterOrder = {
        order_id: `master_${order.order_id}`,
        order_status: 'CLOSED',
        close_price: null, // Will be determined by Python service
        close_time: new Date().toISOString(),
        net_profit: 0, // Will be calculated by Python service
        close_reason: 'auto_stop_copying',
        close_message: 'Auto SL/TP' // Short close message
      };
      
      // Call the existing closeFollowerOrder method
      const result = await copyTradingService.closeFollowerOrder(order, mockMasterOrder);
      
      return {
        success: true,
        orderId: order.order_id,
        result: result
      };

    } catch (error) {
      logger.error('Failed to close copy follower order', {
        orderId: order.order_id,
        error: error.message
      });
      return {
        success: false,
        orderId: order.order_id,
        error: error.message
      };
    }
  }

  /**
   * Validate SL/TP parameters for copy follower account
   * @param {Object} slTpSettings - SL/TP settings
   * @returns {Object} Validation result
   */
  static validateSlTpSettings(slTpSettings) {
    const errors = [];
    const warnings = [];

    // Validate Stop Loss settings
    if (slTpSettings.copy_sl_mode && slTpSettings.copy_sl_mode !== 'none') {
      if (slTpSettings.copy_sl_mode === 'percentage') {
        const slPercentage = parseFloat(slTpSettings.sl_percentage || 0);
        if (slPercentage <= 0 || slPercentage > 100) {
          errors.push('Stop loss percentage must be between 0.01% and 100%');
        }
        if (slPercentage > 50) {
          warnings.push('Stop loss percentage above 50% may result in significant losses');
        }
      } else if (slTpSettings.copy_sl_mode === 'amount') {
        const slAmount = parseFloat(slTpSettings.sl_amount || 0);
        if (slAmount <= 0) {
          errors.push('Stop loss amount must be greater than 0');
        }
        if (slTpSettings.initial_investment && slAmount >= slTpSettings.initial_investment) {
          errors.push('Stop loss amount cannot be greater than or equal to initial investment');
        }
      }
    }

    // Validate Take Profit settings
    if (slTpSettings.copy_tp_mode && slTpSettings.copy_tp_mode !== 'none') {
      if (slTpSettings.copy_tp_mode === 'percentage') {
        const tpPercentage = parseFloat(slTpSettings.tp_percentage || 0);
        if (tpPercentage <= 0 || tpPercentage > 1000) {
          errors.push('Take profit percentage must be between 0.01% and 1000%');
        }
      } else if (slTpSettings.copy_tp_mode === 'amount') {
        const tpAmount = parseFloat(slTpSettings.tp_amount || 0);
        if (tpAmount <= 0) {
          errors.push('Take profit amount must be greater than 0');
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Monitor all active copy follower accounts for equity thresholds
   * Called periodically by a background job (every 200ms)
   * Only monitors accounts with:
   * 1. Active status and copy_status
   * 2. SL/TP configured (not 'none')
   * 3. Has open orders (to avoid unnecessary monitoring)
   */
  static async monitorAllCopyFollowerAccounts() {
    try {
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      const { Op } = require('sequelize');
      
      // First, get copy follower accounts that have open orders
      const accountsWithOpenOrders = await CopyFollowerOrder.findAll({
        where: {
          order_status: 'OPEN'
        },
        attributes: ['copy_follower_account_id'],
        group: ['copy_follower_account_id'],
        raw: true
      });

      if (accountsWithOpenOrders.length === 0) {
        // No accounts with open orders, skip monitoring
        return {
          success: true,
          totalAccounts: 0,
          checkedCount: 0,
          triggeredCount: 0,
          errors: []
        };
      }

      const accountIdsWithOrders = accountsWithOpenOrders.map(a => a.copy_follower_account_id);

      // Get active copy follower accounts with SL/TP configured AND have open orders
      const accounts = await CopyFollowerAccount.findAll({
        where: {
          id: { [Op.in]: accountIdsWithOrders },
          copy_status: 'active',
          is_active: 1,
          status: 1,
          [Op.or]: [
            { copy_sl_mode: { [Op.ne]: 'none' } },
            { copy_tp_mode: { [Op.ne]: 'none' } }
          ]
        }
      });

      let checkedCount = 0;
      let triggeredCount = 0;
      const errors = [];

      for (const account of accounts) {
        try {
          checkedCount++;
          const thresholdCheck = await this.checkEquityThresholds(account);
          
          if (thresholdCheck.shouldStopCopying) {
            const stopResult = await this.triggerAutoStopCopying(
              account,
              thresholdCheck.reason,
              thresholdCheck.thresholdType
            );
            
            if (stopResult.success) {
              triggeredCount++;
            } else {
              errors.push({
                accountId: account.id,
                error: stopResult.error
              });
            }
          }
        } catch (error) {
          errors.push({
            accountId: account.id,
            error: error.message
          });
        }
      }

      // logger.info('Copy follower equity monitoring completed', {
      //   totalAccounts: accounts.length,
      //   checkedCount,
      //   triggeredCount,
      //   errorCount: errors.length
      // });

      return {
        success: true,
        totalAccounts: accounts.length,
        checkedCount,
        triggeredCount,
        errors
      };

    } catch (error) {
      logger.error('Failed to monitor copy follower accounts', {
        error: error.message
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Backfill Redis entries for copy follower with open orders
   * @param {string} copyFollowerAccountId - Copy follower account ID
   */
  static async backfillCopyFollowerRedisEntries(copyFollowerAccountId) {
    try {
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      const { redisCluster } = require('../../config/redis');
      
      logger.info('Starting Redis backfill for copy follower', {
        copyFollowerAccountId,
        timestamp: new Date().toISOString()
      });

      // Get all open orders for this copy follower
      const openOrders = await CopyFollowerOrder.findAll({
        where: {
          copy_follower_account_id: copyFollowerAccountId,
          order_status: ['OPEN', 'QUEUED']
        }
      });

      if (openOrders.length === 0) {
        logger.info('No open orders found for copy follower backfill', {
          copyFollowerAccountId
        });
        return { backfilled: 0, reason: 'no_open_orders' };
      }

      let backfilledCount = 0;
      const copyTradingService = require('./copyTrading.service');

      for (const order of openOrders) {
        try {
          // Create Redis entries for this order
          await copyTradingService.createRedisEntries({
            order_id: order.order_id,
            order_user_id: copyFollowerAccountId,
            symbol: order.symbol,
            order_type: order.order_type,
            order_status: order.order_status,
            order_price: order.order_price,
            order_quantity: order.order_quantity,
            stop_loss: order.stop_loss,
            take_profit: order.take_profit,
            placed_by: 'copy_trading_backfill'
          }, 'copy_follower');

          backfilledCount++;

          logger.info('Backfilled Redis entries for copy follower order', {
            copyFollowerAccountId,
            orderId: order.order_id,
            symbol: order.symbol,
            orderStatus: order.order_status
          });

        } catch (orderError) {
          logger.error('Failed to backfill Redis entries for specific order', {
            copyFollowerAccountId,
            orderId: order.order_id,
            error: orderError.message
          });
        }
      }

      logger.info('Completed Redis backfill for copy follower', {
        copyFollowerAccountId,
        totalOrders: openOrders.length,
        backfilledCount,
        timestamp: new Date().toISOString()
      });

      return { 
        backfilled: backfilledCount, 
        totalOrders: openOrders.length,
        success: backfilledCount > 0
      };

    } catch (error) {
      logger.error('Failed to backfill Redis entries for copy follower', {
        copyFollowerAccountId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
}

module.exports = CopyFollowerEquityMonitorService;
