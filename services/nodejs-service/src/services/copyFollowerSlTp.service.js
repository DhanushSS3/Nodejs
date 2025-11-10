const logger = require('./logger.service');
const CopyFollowerEquityMonitorService = require('./copyFollowerEquityMonitor.service');

/**
 * Service for equity-based auto stop copying (SL/TP based on account equity, not individual orders)
 * 
 * IMPORTANT: This service has been updated to handle equity-based auto stop copying.
 * The SL/TP settings in copy follower accounts are for monitoring account equity thresholds,
 * not for individual order stop loss/take profit.
 * 
 * When equity reaches the configured threshold (percentage or amount), all orders are closed
 * and copying is automatically stopped.
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

  // Legacy method compatibility (deprecated - now logs warning)
  static async addStopLossToOrder(followerOrder, stopLossPrice) {
    logger.warn('DEPRECATED: addStopLossToOrder called. Use equity-based monitoring instead.', {
      orderId: followerOrder.order_id,
      stopLossPrice
    });
    return { success: true, reason: 'Legacy method - use equity monitoring instead' };
  }

  // Legacy method compatibility (deprecated - now logs warning)
  static async addTakeProfitToOrder(followerOrder, takeProfitPrice) {
    logger.warn('DEPRECATED: addTakeProfitToOrder called. Use equity-based monitoring instead.', {
      orderId: followerOrder.order_id,
      takeProfitPrice
    });
    return { success: true, reason: 'Legacy method - use equity monitoring instead' };
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
