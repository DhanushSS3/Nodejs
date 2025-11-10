const logger = require('./logger.service');
const axios = require('axios');

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
          // SL: equity drops to X% of initial investment
          return initialInvestment * (percentageValue / 100);
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
   * Get user portfolio data from Python service
   * @param {string} userType - User type (copy_follower)
   * @param {string} userId - User ID
   * @returns {Object|null} Portfolio data
   */
  static async getUserPortfolio(userType, userId) {
    try {
      const pythonServiceUrl = process.env.PYTHON_SERVICE_URL || 'http://localhost:8001';
      const response = await axios.get(`${pythonServiceUrl}/api/portfolio/${userType}/${userId}`, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'x-internal-auth': process.env.INTERNAL_API_SECRET || 'livefxhub'
        }
      });

      if (response.data && response.data.success) {
        return response.data.data;
      }

      return null;
    } catch (error) {
      logger.error('Failed to get user portfolio from Python service', {
        userType,
        userId,
        error: error.message
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
   * Close individual copy follower order
   * @param {Object} order - Copy follower order
   * @returns {Object} Close order result
   */
  static async closeCopyFollowerOrder(order) {
    try {
      // Call copy trading controller to close order
      const copyTradingOrdersController = require('../controllers/copyTrading.orders.controller');
      
      const mockReq = {
        body: {
          order_id: order.order_id,
          user_id: String(order.order_user_id),
          symbol: order.symbol,
          order_type: order.order_type === 'BUY' ? 'SELL' : 'BUY', // Opposite to close
          order_quantity: order.order_quantity,
          close_reason: 'auto_stop_copying'
        },
        headers: {
          'x-internal-auth': process.env.INTERNAL_API_SECRET || 'livefxhub'
        },
        user: {},
        ip: '127.0.0.1',
        method: 'POST',
        originalUrl: '/internal/copy-follower/order/close'
      };

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

      await copyTradingOrdersController.closeCopyFollowerOrder(mockReq, mockRes);

      return {
        success: statusCode === 200,
        orderId: order.order_id,
        statusCode,
        data: responseData
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
   * Called periodically by a background job
   */
  static async monitorAllCopyFollowerAccounts() {
    try {
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      
      // Get all active copy follower accounts with SL/TP configured
      const accounts = await CopyFollowerAccount.findAll({
        where: {
          copy_status: 'active',
          is_active: 1,
          status: 1,
          [require('sequelize').Op.or]: [
            { copy_sl_mode: { [require('sequelize').Op.ne]: 'none' } },
            { copy_tp_mode: { [require('sequelize').Op.ne]: 'none' } }
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

      logger.info('Copy follower equity monitoring completed', {
        totalAccounts: accounts.length,
        checkedCount,
        triggeredCount,
        errorCount: errors.length
      });

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
}

module.exports = CopyFollowerEquityMonitorService;
