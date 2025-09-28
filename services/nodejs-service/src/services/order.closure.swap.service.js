const walletService = require('./wallet.service');
const logger = require('../utils/logger');
const { logOrderClosureSwap, logSwapError } = require('../utils/swap.logger');

class OrderClosureSwapService {
  /**
   * Process swap charges when an order is closed
   * This should be called during order closure to create final swap transaction
   * @param {Object} order - Order being closed
   * @param {Date} closureDate - Date when order is being closed
   * @returns {Promise<Object>} - Swap transaction details
   */
  async processOrderClosureSwap(order, closureDate = new Date()) {
    try {
      const orderDurationDays = this.calculateOrderDuration(order.created_at, closureDate);
      const totalSwapAccumulated = parseFloat(order.swap || 0);
      
      // If there's no accumulated swap, nothing to process
      if (totalSwapAccumulated === 0) {
        logger.info(`No swap charges accumulated for order ${order.order_id}`);
        return null;
      }

      // Create final swap transaction if not already created
      // This is typically done during daily processing, but this ensures
      // any remaining swap is properly recorded when order closes
      let swapTransaction = null;
      
      // Check if we need to create a final swap transaction
      // This would happen if order is closed before daily swap processing
      const lastDailySwapDate = this.getLastDailySwapDate();
      const needsFinalSwapTransaction = closureDate > lastDailySwapDate;
      
      if (needsFinalSwapTransaction && totalSwapAccumulated !== 0) {
        try {
          swapTransaction = await walletService.addSwap(
            order.order_user_id,
            order.user_type || 'live', // Default to live if not specified
            0, // No additional swap, just recording closure
            order.id,
            {
              symbol: order.symbol,
              group_name: order.group_name,
              order_type: order.order_type,
              order_quantity: order.order_quantity,
              closure_date: closureDate.toISOString(),
              total_accumulated_swap: totalSwapAccumulated,
              order_duration_days: orderDurationDays,
              transaction_type: 'order_closure_summary'
            }
          );
        } catch (transactionError) {
          logger.warn(`Failed to create closure swap transaction for order ${order.order_id}:`, transactionError);
        }
      }

      // Calculate impact on net profit
      const netProfitBeforeSwap = parseFloat(order.net_profit || 0);
      const netProfitAfterSwap = netProfitBeforeSwap + totalSwapAccumulated;

      // Log comprehensive order closure swap details
      logOrderClosureSwap({
        order_id: order.order_id,
        user_id: order.order_user_id,
        user_type: order.user_type || 'live',
        symbol: order.symbol,
        group_name: order.group_name,
        order_type: order.order_type,
        order_quantity: parseFloat(order.order_quantity),
        order_duration_days: orderDurationDays,
        total_swap_accumulated: totalSwapAccumulated,
        final_swap_transaction_id: swapTransaction?.transaction_id || null,
        closure_date: closureDate.toISOString(),
        net_profit_before_swap: netProfitBeforeSwap,
        net_profit_after_swap: netProfitAfterSwap
      });

      logger.info(`Order closure swap processed for ${order.order_id}: Total swap = ${totalSwapAccumulated}, Duration = ${orderDurationDays} days`);

      return {
        order_id: order.order_id,
        total_swap_accumulated: totalSwapAccumulated,
        order_duration_days: orderDurationDays,
        swap_transaction_id: swapTransaction?.transaction_id || null,
        net_profit_impact: totalSwapAccumulated,
        closure_date: closureDate.toISOString()
      };

    } catch (error) {
      logSwapError(error, {
        order_id: order.order_id,
        user_id: order.order_user_id,
        symbol: order.symbol,
        operation: 'processOrderClosureSwap'
      });
      logger.error(`Error processing order closure swap for ${order.order_id}:`, error);
      return null;
    }
  }

  /**
   * Calculate order duration in days
   */
  calculateOrderDuration(createdAt, closureDate) {
    const created = new Date(createdAt);
    const closed = new Date(closureDate);
    const diffTime = Math.abs(closed - created);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  }

  /**
   * Get the last daily swap processing date
   * This is a simplified version - in production you might want to track this in database
   */
  getLastDailySwapDate() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    yesterday.setHours(0, 1, 0, 0); // Set to 00:01 (when daily processing runs)
    return yesterday;
  }

  /**
   * Check if order has pending swap charges that need to be processed
   * This can be used to determine if swap needs to be calculated before closure
   */
  async checkPendingSwapCharges(order, closureDate = new Date()) {
    try {
      const lastProcessingDate = this.getLastDailySwapDate();
      const orderCreated = new Date(order.created_at);
      
      // If order was created after last processing and is being closed today,
      // it might have pending swap charges
      if (orderCreated > lastProcessingDate && closureDate.getDate() === new Date().getDate()) {
        return {
          hasPendingCharges: true,
          lastProcessingDate: lastProcessingDate.toISOString(),
          orderCreated: orderCreated.toISOString(),
          recommendation: 'Consider running swap calculation before closure'
        };
      }

      return {
        hasPendingCharges: false,
        lastProcessingDate: lastProcessingDate.toISOString(),
        orderCreated: orderCreated.toISOString()
      };

    } catch (error) {
      logger.error(`Error checking pending swap charges for order ${order.order_id}:`, error);
      return {
        hasPendingCharges: false,
        error: error.message
      };
    }
  }

  /**
   * Get swap summary for an order
   * Useful for displaying swap information in order details
   */
  getOrderSwapSummary(order) {
    const totalSwap = parseFloat(order.swap || 0);
    const orderDuration = this.calculateOrderDuration(order.created_at, new Date());
    
    return {
      order_id: order.order_id,
      total_swap_accumulated: totalSwap,
      order_duration_days: orderDuration,
      daily_average_swap: orderDuration > 0 ? totalSwap / orderDuration : 0,
      swap_impact_on_profit: totalSwap,
      is_positive_swap: totalSwap > 0,
      formatted_swap: totalSwap.toFixed(2)
    };
  }
}

module.exports = new OrderClosureSwapService();
