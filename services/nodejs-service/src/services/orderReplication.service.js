const { redisCluster } = require('../config/redis');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const Group = require('../models/group.model');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class OrderReplicationService {
  constructor() {
    this.logger = logger;
  }

  /**
   * Replicate a strategy provider order to all active followers
   * @param {Object} masterOrder - The strategy provider order
   * @param {string} action - The action type (PLACE, MODIFY, CLOSE, etc.)
   */
  async replicateOrder(masterOrder, action = 'PLACE') {
    try {
      // Validate master order is from strategy provider
      if (!masterOrder.strategy_provider_id) {
        throw new Error('Master order must have strategy_provider_id');
      }

      this.logger.info(`[ORDER_REPLICATION] Starting replication for master order ${masterOrder.order_id}`, {
        master_order_id: masterOrder.order_id,
        strategy_provider_id: masterOrder.strategy_provider_id,
        action: action,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_quantity: masterOrder.order_quantity
      });

      // Get active followers for this strategy provider
      const followers = await this.getActiveFollowers(masterOrder.strategy_provider_id);
      
      if (!followers || followers.length === 0) {
        this.logger.info(`[ORDER_REPLICATION] No active followers found for strategy provider ${masterOrder.strategy_provider_id}`);
        return { success: true, copied_orders: 0, failed_orders: 0 };
      }

      this.logger.info(`[ORDER_REPLICATION] Found ${followers.length} active followers for replication`);

      // Get strategy provider equity for lot calculation
      const strategyProvider = await StrategyProviderAccount.findByPk(masterOrder.strategy_provider_id);
      if (!strategyProvider) {
        throw new Error(`Strategy provider ${masterOrder.strategy_provider_id} not found`);
      }

      // Process followers in batches to avoid overwhelming the system
      const batchSize = 50;
      const results = {
        success: true,
        copied_orders: 0,
        failed_orders: 0,
        details: []
      };

      for (let i = 0; i < followers.length; i += batchSize) {
        const batch = followers.slice(i, i + batchSize);
        const batchResults = await this.processBatch(batch, masterOrder, strategyProvider, action);
        
        results.copied_orders += batchResults.copied_orders;
        results.failed_orders += batchResults.failed_orders;
        results.details.push(...batchResults.details);
      }

      this.logger.info(`[ORDER_REPLICATION] Completed replication for master order ${masterOrder.order_id}`, {
        total_followers: followers.length,
        copied_orders: results.copied_orders,
        failed_orders: results.failed_orders
      });

      return results;

    } catch (error) {
      this.logger.error(`[ORDER_REPLICATION] Error replicating order ${masterOrder.order_id}:`, error);
      throw error;
    }
  }

  /**
   * Process a batch of followers for order replication
   */
  async processBatch(followers, masterOrder, strategyProvider, action) {
    const results = {
      copied_orders: 0,
      failed_orders: 0,
      details: []
    };

    const copyPromises = followers.map(async (follower) => {
      try {
        const copyResult = await this.createCopyOrder(follower, masterOrder, strategyProvider, action);
        if (copyResult.success) {
          results.copied_orders++;
        } else {
          results.failed_orders++;
        }
        results.details.push(copyResult);
      } catch (error) {
        results.failed_orders++;
        results.details.push({
          success: false,
          follower_id: follower.id,
          error: error.message
        });
      }
    });

    await Promise.allSettled(copyPromises);
    return results;
  }

  /**
   * Create a copy order for a specific follower
   */
  async createCopyOrder(follower, masterOrder, strategyProvider, action) {
    try {
      // Calculate follower lot size
      const lotCalculation = await this.calculateFollowerLot(
        masterOrder.order_quantity,
        strategyProvider.equity,
        follower.investment_amount,
        follower.group
      );

      // Check if calculated lot meets minimum requirements
      if (lotCalculation.skipped) {
        this.logger.warn(`[ORDER_REPLICATION] Skipping copy for follower ${follower.id}: ${lotCalculation.reason}`);
        return {
          success: false,
          follower_id: follower.id,
          skipped: true,
          reason: lotCalculation.reason
        };
      }

      // Generate unique order ID for copy order
      const copyOrderId = this.generateCopyOrderId();

      // Create copy order data
      const copyOrderData = {
        order_id: copyOrderId,
        order_user_id: follower.id,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_status: 'PENDING',
        order_price: masterOrder.order_price,
        order_quantity: lotCalculation.final_lot_size,
        stop_loss: masterOrder.stop_loss,
        take_profit: masterOrder.take_profit,
        
        // Copy trading specific fields
        master_order_id: masterOrder.order_id,
        strategy_provider_id: masterOrder.strategy_provider_id,
        copy_follower_account_id: follower.id,
        
        // Lot calculation audit trail
        master_lot_size: masterOrder.order_quantity,
        follower_investment_at_copy: follower.investment_amount,
        master_equity_at_copy: strategyProvider.equity,
        lot_ratio: lotCalculation.lot_ratio,
        calculated_lot_size: lotCalculation.calculated_lot_size,
        final_lot_size: lotCalculation.final_lot_size,
        
        // Copy settings
        copy_status: 'pending',
        copy_timestamp: new Date(),
        performance_fee_percentage: strategyProvider.performance_fee,
        
        placed_by: 'copy_trading'
      };

      // Save to database
      const copyOrder = await CopyFollowerOrder.create(copyOrderData);

      // Create Redis entries for copy order
      await this.createRedisOrderEntries(copyOrder, 'copy_follower');

      this.logger.info(`[ORDER_REPLICATION] Created copy order ${copyOrderId} for follower ${follower.id}`, {
        copy_order_id: copyOrderId,
        master_order_id: masterOrder.order_id,
        follower_id: follower.id,
        calculated_lot: lotCalculation.final_lot_size,
        master_lot: masterOrder.order_quantity
      });

      return {
        success: true,
        follower_id: follower.id,
        copy_order_id: copyOrderId,
        lot_size: lotCalculation.final_lot_size
      };

    } catch (error) {
      this.logger.error(`[ORDER_REPLICATION] Error creating copy order for follower ${follower.id}:`, error);
      return {
        success: false,
        follower_id: follower.id,
        error: error.message
      };
    }
  }

  /**
   * Calculate the appropriate lot size for a follower
   */
  async calculateFollowerLot(masterLot, masterEquity, followerInvestment, followerGroup) {
    try {
      // Basic proportional calculation
      const lotRatio = followerInvestment / masterEquity;
      const calculatedLot = masterLot * lotRatio;

      // Get minimum lot size for the group
      const group = await Group.findOne({ where: { name: followerGroup } });
      const minLot = group ? parseFloat(group.min_lot || 0.01) : 0.01;

      // Check if calculated lot meets minimum
      if (calculatedLot < minLot) {
        return {
          skipped: true,
          reason: 'below_min_lot',
          calculated_lot_size: calculatedLot,
          min_lot_required: minLot,
          lot_ratio: lotRatio
        };
      }

      // Apply any maximum lot restrictions (could be added later)
      const finalLotSize = calculatedLot;

      return {
        skipped: false,
        lot_ratio: lotRatio,
        calculated_lot_size: calculatedLot,
        final_lot_size: finalLotSize,
        min_lot_required: minLot
      };

    } catch (error) {
      this.logger.error('[ORDER_REPLICATION] Error calculating follower lot:', error);
      return {
        skipped: true,
        reason: 'calculation_error',
        error: error.message
      };
    }
  }

  /**
   * Get active followers for a strategy provider
   */
  async getActiveFollowers(strategyProviderId) {
    try {
      const followers = await CopyFollowerAccount.scope('copying').findAll({
        where: { 
          strategy_provider_id: strategyProviderId,
          status: 1,
          is_active: 1,
          copy_status: 'active'
        }
      });

      return followers;
    } catch (error) {
      this.logger.error(`[ORDER_REPLICATION] Error fetching followers for strategy provider ${strategyProviderId}:`, error);
      return [];
    }
  }

  /**
   * Create Redis entries for copy order (same pattern as existing orders)
   */
  async createRedisOrderEntries(order, userType) {
    try {
      const hash_tag = `${userType}:${order.order_user_id}`;
      const order_key = `user_holdings:{${hash_tag}}:${order.order_id}`;
      const index_key = `user_orders_index:{${hash_tag}}`;
      const symbol_holders_key = `symbol_holders:${order.symbol}:${userType}`;
      const order_data_key = `order_data:${order.order_id}`;

      // Create order data entry (canonical)
      await redisCluster.hset(order_data_key, {
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price.toString(),
        order_quantity: order.order_quantity.toString(),
        user_type: userType,
        user_id: order.order_user_id.toString(),
        stop_loss: order.stop_loss ? order.stop_loss.toString() : '',
        take_profit: order.take_profit ? order.take_profit.toString() : '',
        status: order.order_status,
        execution_status: 'PENDING',
        placed_by: order.placed_by || 'copy_trading'
      });

      // Create user holdings entry
      await redisCluster.hset(order_key, {
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price.toString(),
        order_quantity: order.order_quantity.toString(),
        user_type: userType,
        user_id: order.order_user_id.toString(),
        stop_loss: order.stop_loss ? order.stop_loss.toString() : '',
        take_profit: order.take_profit ? order.take_profit.toString() : '',
        status: order.order_status,
        execution_status: 'PENDING',
        placed_by: order.placed_by || 'copy_trading'
      });

      // Add to user orders index
      await redisCluster.sadd(index_key, order.order_id);

      // Add to symbol holders
      await redisCluster.sadd(symbol_holders_key, hash_tag);

      this.logger.debug(`[ORDER_REPLICATION] Created Redis entries for copy order ${order.order_id}`);

    } catch (error) {
      this.logger.error(`[ORDER_REPLICATION] Error creating Redis entries for order ${order.order_id}:`, error);
      throw error;
    }
  }

  /**
   * Generate unique copy order ID
   */
  generateCopyOrderId() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `CPY${timestamp}${random}`;
  }

  /**
   * Handle master order status changes (close, cancel, etc.)
   */
  async handleMasterOrderStatusChange(masterOrderId, newStatus, closePrice = null) {
    try {
      this.logger.info(`[ORDER_REPLICATION] Handling master order status change`, {
        master_order_id: masterOrderId,
        new_status: newStatus,
        close_price: closePrice
      });

      // Find all copy orders for this master order
      const copyOrders = await CopyFollowerOrder.findAll({
        where: { 
          master_order_id: masterOrderId,
          order_status: ['OPEN', 'PENDING']
        }
      });

      if (copyOrders.length === 0) {
        this.logger.info(`[ORDER_REPLICATION] No active copy orders found for master order ${masterOrderId}`);
        return;
      }

      // Process each copy order based on the master order status change
      for (const copyOrder of copyOrders) {
        await this.updateCopyOrderStatus(copyOrder, newStatus, closePrice);
      }

    } catch (error) {
      this.logger.error(`[ORDER_REPLICATION] Error handling master order status change for ${masterOrderId}:`, error);
      throw error;
    }
  }

  /**
   * Update copy order status based on master order changes
   */
  async updateCopyOrderStatus(copyOrder, newStatus, closePrice = null) {
    try {
      // Update copy order status in database
      await copyOrder.update({
        order_status: newStatus,
        close_price: closePrice,
        updated_at: new Date()
      });

      // Update Redis entries
      const hash_tag = `copy_follower:${copyOrder.order_user_id}`;
      const order_key = `user_holdings:{${hash_tag}}:${copyOrder.order_id}`;
      const order_data_key = `order_data:${copyOrder.order_id}`;

      const updateData = {
        order_status: newStatus,
        status: newStatus
      };

      if (closePrice) {
        updateData.close_price = closePrice.toString();
      }

      await redisCluster.hset(order_key, updateData);
      await redisCluster.hset(order_data_key, updateData);

      this.logger.info(`[ORDER_REPLICATION] Updated copy order ${copyOrder.order_id} status to ${newStatus}`);

    } catch (error) {
      this.logger.error(`[ORDER_REPLICATION] Error updating copy order ${copyOrder.order_id}:`, error);
      throw error;
    }
  }
}

module.exports = new OrderReplicationService();
