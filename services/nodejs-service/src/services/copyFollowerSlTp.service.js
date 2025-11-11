const logger = require('./logger.service');
const CopyFollowerEquityMonitorService = require('./copyFollowerEquityMonitor.service');

/**
 * Service for equity-based auto stop copying (SL/TP based on account equity, not individual orders)
 * 
 * IMPORTANT: Copy followers CANNOT set individual order SL/TP. They can only configure
 * account-level equity thresholds for automatic stop copying.
 * 
 * SL/TP settings in copy follower accounts are for monitoring account equity thresholds:
 * - copy_sl_mode: 'percentage' | 'amount' | 'none'
 * - copy_tp_mode: 'percentage' | 'amount' | 'none'
 * - sl_percentage/sl_amount: Stop loss threshold
 * - tp_percentage/tp_amount: Take profit threshold
 * 
 * When equity reaches the configured threshold, all orders are closed and copying stops.
 * Monitoring runs every 200ms for accounts with open orders and SL/TP configured.
 */
class CopyFollowerSlTpService {
  
  /**
   * Check equity thresholds for copy follower account (replaces old calculateSlTpPrices)
   * @param {Object} followerAccount - Copy follower account with SL/TP settings
   * @returns {Object} Equity threshold check results
   */
  static async checkEquityThresholds(followerAccount) {
    return await CopyFollowerEquityMonitorService.checkEquityThresholds(followerAccount);
  }

  /**
   * Monitor equity after order placement (replaces old applySlTpToFollowerOrder)
   * @param {Object} followerOrder - Copy follower order
   * @param {Object} followerAccount - Copy follower account with SL/TP settings
   * @param {Object} executionResult - Order execution result
   * @returns {Object} Equity monitoring results
   */
  static async monitorEquityAfterOrderPlacement(followerOrder, followerAccount, executionResult) {
    try {
      // Only monitor equity if order was successfully placed
      if (!executionResult.success || !executionResult.data) {
        return { success: false, reason: 'Order execution failed' };
      }

      // Check if account has equity-based SL/TP configured
      if ((!followerAccount.copy_sl_mode || followerAccount.copy_sl_mode === 'none') &&
          (!followerAccount.copy_tp_mode || followerAccount.copy_tp_mode === 'none')) {
        return { success: true, reason: 'No equity-based SL/TP configured' };
      }

      // Check current equity thresholds
      const thresholdCheck = await this.checkEquityThresholds(followerAccount);
      
      if (thresholdCheck.shouldStopCopying) {
        // Trigger auto stop copying
        const stopResult = await CopyFollowerEquityMonitorService.triggerAutoStopCopying(
          followerAccount,
          thresholdCheck.reason,
          thresholdCheck.thresholdType
        );
        
        logger.info('Auto stop copying triggered after order placement', {
          orderId: followerOrder.order_id,
          copyFollowerAccountId: followerAccount.id,
          reason: thresholdCheck.reason,
          thresholdType: thresholdCheck.thresholdType,
          currentEquity: thresholdCheck.currentEquity,
          thresholdValue: thresholdCheck.thresholdValue
        });

        return {
          success: true,
          autoStopTriggered: true,
          reason: thresholdCheck.reason,
          thresholdType: thresholdCheck.thresholdType,
          stopResult
        };
      }

      logger.info('Equity monitoring completed after order placement', {
        orderId: followerOrder.order_id,
        copyFollowerAccountId: followerAccount.id,
        currentEquity: thresholdCheck.currentEquity,
        withinThresholds: true
      });

      return {
        success: true,
        autoStopTriggered: false,
        currentEquity: thresholdCheck.currentEquity,
        withinThresholds: true
      };

    } catch (error) {
      logger.error('Failed to monitor equity after order placement', {
        orderId: followerOrder.order_id,
        copyFollowerAccountId: followerAccount.id,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Trigger auto stop copying (replaces old addStopLossToOrder)
   * @param {Object} followerAccount - Copy follower account
   * @param {string} reason - Reason for stopping
   * @param {string} thresholdType - 'stop_loss' or 'take_profit'
   * @returns {Object} Stop copying result
   */
  static async triggerAutoStopCopying(followerAccount, reason, thresholdType) {
    return await CopyFollowerEquityMonitorService.triggerAutoStopCopying(followerAccount, reason, thresholdType);
  }

  /**
   * Validate SL/TP settings (replaces old addStopLossToOrder logic)
   * @param {Object} slTpSettings - SL/TP settings
   * @returns {Object} Validation result
   */
  static validateSlTpSettings(slTpSettings) {
    return CopyFollowerEquityMonitorService.validateSlTpSettings(slTpSettings);
  }

  /**
   * Monitor all copy follower accounts (background job method)
   * @returns {Object} Monitoring results
   */
  static async monitorAllCopyFollowerAccounts() {
    return await CopyFollowerEquityMonitorService.monitorAllCopyFollowerAccounts();
  }

  // REMOVED: Individual order SL/TP methods
  // Copy followers cannot set individual order SL/TP - only account-level equity thresholds
  
  static async addStopLossToOrder(followerOrder, stopLossPrice) {
    logger.error('UNSUPPORTED: Copy followers cannot set individual order SL/TP', {
      orderId: followerOrder.order_id,
      stopLossPrice,
      message: 'Use account-level equity thresholds instead'
    });
    return { 
      success: false, 
      error: 'Copy followers cannot set individual order SL/TP. Use account-level equity thresholds instead.' 
    };
  }

  static async addTakeProfitToOrder(followerOrder, takeProfitPrice) {
    logger.error('UNSUPPORTED: Copy followers cannot set individual order TP', {
      orderId: followerOrder.order_id,
      takeProfitPrice,
      message: 'Use account-level equity thresholds instead'
    });
    return { 
      success: false, 
      error: 'Copy followers cannot set individual order TP. Use account-level equity thresholds instead.' 
    };
  }

  // Legacy method compatibility (deprecated)
  static async applySlTpToFollowerOrder(followerOrder, followerAccount, executionResult) {
    logger.warn('DEPRECATED: applySlTpToFollowerOrder called. Use monitorEquityAfterOrderPlacement instead.', {
      orderId: followerOrder.order_id
    });
    return await this.monitorEquityAfterOrderPlacement(followerOrder, followerAccount, executionResult);
  }

  // Legacy method compatibility (deprecated)
  static async calculateSlTpPrices(followerOrder, followerAccount, executionResult) {
    logger.warn('DEPRECATED: calculateSlTpPrices called. Use checkEquityThresholds instead.', {
      orderId: followerOrder.order_id
    });
    return await this.checkEquityThresholds(followerAccount);
  }
}

module.exports = CopyFollowerSlTpService;
