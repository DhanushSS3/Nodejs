const logger = require('../utils/logger');
const { StrategyProviderAccount, StrategyProviderOrder } = require('../models');
const sequelize = require('../config/db');
const { Op } = require('sequelize');

/**
 * Strategy Provider Statistics Service
 * Handles calculation and updating of strategy provider performance metrics
 */
class StrategyProviderStatsService {
  
  /**
   * Main method to update all statistics after an order is closed
   * @param {number} strategyProviderId - Strategy provider account ID
   * @param {number} closedOrderId - ID of the order that was just closed
   */
  static async updateStatisticsAfterOrderClose(strategyProviderId, closedOrderId) {
    const startTime = Date.now();
    
    try {
      logger.info('Starting strategy provider statistics update', {
        strategyProviderId,
        strategyProviderIdType: typeof strategyProviderId,
        closedOrderId,
        closedOrderIdType: typeof closedOrderId
      });

      // Get strategy provider account
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
      if (!strategyProvider) {
        throw new Error(`Strategy provider account not found: ${strategyProviderId}`);
      }

      // Check if the specific closed order exists (for debugging)
      if (closedOrderId) {
        const specificOrder = await StrategyProviderOrder.findOne({
          where: {
            order_id: closedOrderId,
            order_user_id: strategyProviderId
          },
          attributes: ['id', 'order_id', 'order_status', 'net_profit', 'createdAt', 'updatedAt']
        });
        
        logger.info('Checking specific closed order', {
          strategyProviderId,
          closedOrderId,
          specificOrder: specificOrder ? {
            id: specificOrder.id,
            order_id: specificOrder.order_id,
            order_status: specificOrder.order_status,
            net_profit: specificOrder.net_profit
          } : null
        });
      }

      // Get all closed orders for this strategy provider
      const closedOrders = await StrategyProviderOrder.findAll({
        where: {
          order_user_id: strategyProviderId,
          order_status: 'CLOSED'
        },
        attributes: ['id', 'order_id', 'net_profit', 'createdAt', 'updatedAt'],
        order: [['createdAt', 'ASC']]
      });

      logger.info('Retrieved closed orders for statistics calculation', {
        strategyProviderId,
        totalClosedOrders: closedOrders.length,
        closedOrderIds: closedOrders.map(o => o.order_id),
        closedOrderNetProfits: closedOrders.map(o => o.net_profit)
      });

      // Calculate all statistics
      const statistics = await this.calculateAllStatistics(strategyProvider, closedOrders);
      
      logger.info('Calculated statistics for strategy provider', {
        strategyProviderId,
        statistics,
        strategyProviderCurrentBalance: strategyProvider.wallet_balance
      });

      // Update strategy provider account in a single transaction
      await sequelize.transaction(async (t) => {
        await StrategyProviderAccount.update(statistics, {
          where: { id: strategyProviderId },
          transaction: t
        });
      });

      const duration = Date.now() - startTime;
      logger.info('Strategy provider statistics updated successfully', {
        strategyProviderId,
        closedOrderId,
        statistics,
        duration: `${duration}ms`
      });

      return statistics;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Failed to update strategy provider statistics', {
        strategyProviderId,
        closedOrderId,
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms`
      });
      throw error;
    }
  }

  /**
   * Calculate all statistics for a strategy provider
   * @param {Object} strategyProvider - Strategy provider account object
   * @param {Array} closedOrders - Array of closed orders
   * @returns {Object} Statistics object
   */
  static async calculateAllStatistics(strategyProvider, closedOrders) {
    const statistics = {};

    // 1. Date tracking
    statistics.last_trade_date = new Date();
    
    // Set first_trade_date only if not already set
    if (!strategyProvider.first_trade_date && closedOrders.length > 0) {
      statistics.first_trade_date = new Date(closedOrders[0].createdAt);
    }

    // 2. Trade counters
    statistics.closed_trades = closedOrders.length;

    // 3. Win rate calculation
    statistics.win_rate = this.calculateWinRate(closedOrders);

    // 4. Total return percentage
    statistics.total_return_percentage = this.calculateTotalReturn(strategyProvider, closedOrders);

    // 5. Three month return
    statistics.three_month_return = this.calculateThreeMonthReturn(strategyProvider, closedOrders);

    // 6. Maximum drawdown
    statistics.max_drawdown = this.calculateMaxDrawdown(strategyProvider, closedOrders);

    return statistics;
  }

  /**
   * Calculate win rate percentage
   * @param {Array} closedOrders - Array of closed orders
   * @returns {number} Win rate percentage
   */
  static calculateWinRate(closedOrders) {
    if (closedOrders.length === 0) return 0;

    const winningTrades = closedOrders.filter(order => 
      parseFloat(order.net_profit || 0) > 0
    ).length;

    const winRate = (winningTrades / closedOrders.length) * 100;
    
    logger.debug('Win rate calculated', {
      totalTrades: closedOrders.length,
      winningTrades,
      winRate: winRate.toFixed(2)
    });

    return parseFloat(winRate.toFixed(2));
  }

  /**
   * Calculate total return percentage based on initial balance
   * @param {Object} strategyProvider - Strategy provider account
   * @param {Array} closedOrders - Array of closed orders
   * @returns {number} Total return percentage
   */
  static calculateTotalReturn(strategyProvider, closedOrders) {
    const initialBalance = parseFloat(strategyProvider.wallet_balance || 0);
    
    if (initialBalance <= 0) return 0;

    const totalNetProfit = closedOrders.reduce((sum, order) => 
      sum + parseFloat(order.net_profit || 0), 0
    );

    const totalReturn = (totalNetProfit / initialBalance) * 100;
    
    logger.debug('Total return calculated', {
      initialBalance,
      totalNetProfit,
      totalReturn: totalReturn.toFixed(4)
    });

    return parseFloat(totalReturn.toFixed(4));
  }

  /**
   * Calculate three month return percentage
   * @param {Object} strategyProvider - Strategy provider account
   * @param {Array} closedOrders - Array of closed orders
   * @returns {number} Three month return percentage
   */
  static calculateThreeMonthReturn(strategyProvider, closedOrders) {
    const initialBalance = parseFloat(strategyProvider.wallet_balance || 0);
    
    if (initialBalance <= 0) return 0;

    // Get orders closed in last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const recentOrders = closedOrders.filter(order => 
      new Date(order.updatedAt) >= threeMonthsAgo
    );

    const threeMonthProfit = recentOrders.reduce((sum, order) => 
      sum + parseFloat(order.net_profit || 0), 0
    );

    const threeMonthReturn = (threeMonthProfit / initialBalance) * 100;
    
    logger.debug('Three month return calculated', {
      initialBalance,
      recentOrdersCount: recentOrders.length,
      threeMonthProfit,
      threeMonthReturn: threeMonthReturn.toFixed(4)
    });

    return parseFloat(threeMonthReturn.toFixed(4));
  }

  /**
   * Calculate maximum drawdown percentage
   * @param {Object} strategyProvider - Strategy provider account
   * @param {Array} closedOrders - Array of closed orders (should be sorted by createdAt ASC)
   * @returns {number} Maximum drawdown percentage
   */
  static calculateMaxDrawdown(strategyProvider, closedOrders) {
    const initialBalance = parseFloat(strategyProvider.wallet_balance || 0);
    
    if (initialBalance <= 0 || closedOrders.length === 0) return 0;

    let runningBalance = initialBalance;
    let peakBalance = initialBalance;
    let maxDrawdownValue = 0;

    // Calculate running balance and track maximum drawdown
    for (const order of closedOrders) {
      runningBalance += parseFloat(order.net_profit || 0);
      
      // Update peak if current balance is higher
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
      
      // Calculate current drawdown from peak
      if (peakBalance > 0) {
        const currentDrawdown = ((peakBalance - runningBalance) / peakBalance) * 100;
        if (currentDrawdown > maxDrawdownValue) {
          maxDrawdownValue = currentDrawdown;
        }
      }
    }

    logger.debug('Maximum drawdown calculated', {
      initialBalance,
      finalBalance: runningBalance,
      peakBalance,
      maxDrawdown: maxDrawdownValue.toFixed(4)
    });

    return parseFloat(maxDrawdownValue.toFixed(4));
  }

  /**
   * Increment total trades counter when an order is placed
   * @param {number} strategyProviderId - Strategy provider account ID
   * @param {number} placedOrderId - ID of the order that was just placed
   */
  static async incrementTotalTrades(strategyProviderId, placedOrderId) {
    try {
      logger.info('Incrementing total trades counter', {
        strategyProviderId,
        placedOrderId
      });

      // Get current strategy provider to check if first_trade_date needs to be set
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
      if (!strategyProvider) {
        throw new Error(`Strategy provider account not found: ${strategyProviderId}`);
      }

      const updateFields = { total_trades: strategyProvider.total_trades + 1 };
      
      // Set first_trade_date only if not already set (first trade)
      if (!strategyProvider.first_trade_date) {
        updateFields.first_trade_date = new Date();
        logger.info('Setting first_trade_date for strategy provider', {
          strategyProviderId,
          placedOrderId
        });
      }

      await StrategyProviderAccount.update(updateFields, {
        where: { id: strategyProviderId }
      });

      logger.info('Total trades counter incremented successfully', {
        strategyProviderId,
        placedOrderId,
        updatedFields: Object.keys(updateFields)
      });

    } catch (error) {
      logger.error('Failed to increment total trades counter', {
        strategyProviderId,
        placedOrderId,
        error: error.message
      });
      // Don't throw - this should not block order placement
    }
  }

  /**
   * Update statistics for multiple strategy providers (batch processing)
   * @param {Array} strategyProviderIds - Array of strategy provider IDs
   */
  static async batchUpdateStatistics(strategyProviderIds) {
    logger.info('Starting batch statistics update', {
      providerCount: strategyProviderIds.length
    });

    const results = [];
    
    for (const providerId of strategyProviderIds) {
      try {
        const stats = await this.updateStatisticsAfterOrderClose(providerId, null);
        results.push({ providerId, success: true, stats });
      } catch (error) {
        logger.error('Batch update failed for provider', {
          providerId,
          error: error.message
        });
        results.push({ providerId, success: false, error: error.message });
      }
    }

    logger.info('Batch statistics update completed', {
      total: strategyProviderIds.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });

    return results;
  }
}

module.exports = StrategyProviderStatsService;
