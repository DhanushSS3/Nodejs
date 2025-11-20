const { Op } = require('sequelize');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const LiveUser = require('../models/liveUser.model');
const Group = require('../models/group.model');
const logger = require('./logger.service');
const idGenerator = require('./idGenerator.service');
const groupsCache = require('./groups.cache.service');
const { updateUserUsedMargin } = require('./user.margin.service');
const portfolioEvents = require('./events/portfolio.events');
const orderLifecycleService = require('./orderLifecycle.service');
// CopyFollowerSlTpService removed - equity monitoring now handled by background worker
const { redisCluster } = require('../../config/redis');
const axios = require('axios');


// Create reusable axios instance for Python service calls
const pythonServiceAxios = axios.create({
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub'
  }
});

class CopyTradingService {

  /**
   * Create strategy provider order with proper Redis entries
   * @param {Object} orderData - Strategy provider order data
   */
  async createStrategyProviderOrder(orderData) {
    try {
      // Create strategy provider order in database
      const masterOrder = await StrategyProviderOrder.create({
        ...orderData,
        is_master_order: true,
        copy_distribution_status: 'pending'
      });

      // Create Redis entries for strategy provider
      await this.createRedisOrderEntries(masterOrder, 'strategy_provider');

      logger.info('Created strategy provider order', {
        orderId: masterOrder.order_id,
        strategyProviderId: masterOrder.order_user_id,
        symbol: masterOrder.symbol
      });

      // Trigger replication to followers
      await this.processStrategyProviderOrder(masterOrder);

      return masterOrder;

    } catch (error) {
      logger.error('Failed to create strategy provider order', {
        error: error.message,
        orderData
      });
      throw error;
    }
  }

  /**
   * Create Redis entries for orders (strategy_provider or copy_follower)
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
        placed_by: order.placed_by || userType
      });

      // Create user holdings entry
      const redisData = {
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
        placed_by: order.placed_by || userType
      };

      // Add master_order_id for copy follower orders
      if (userType === 'copy_follower' && order.master_order_id) {
        redisData.master_order_id = order.master_order_id.toString();
      }

      await redisCluster.hset(order_key, redisData);

      // Add to user orders index
      await redisCluster.sadd(index_key, order.order_id);

      // Add to symbol holders
      await redisCluster.sadd(symbol_holders_key, hash_tag);

      logger.info(`Created Redis entries for ${userType} order ${order.order_id}`);

    } catch (error) {
      logger.error(`Failed to create Redis entries for ${userType} order ${order.order_id}`, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process strategy provider pending order and replicate to all active followers
   * @param {Object} masterOrder - Strategy provider pending order
   */
  async processStrategyProviderPendingOrder(masterOrder) {
    try {
      logger.info('Processing strategy provider pending order for copy trading', {
        orderId: masterOrder.order_id,
        strategyProviderId: masterOrder.order_user_id,
        symbol: masterOrder.symbol,
        orderType: masterOrder.order_type
      });

      // Get all active followers for this strategy provider
      const followers = await this.getActiveFollowers(masterOrder.order_user_id);
      
      if (followers.length === 0) {
        logger.info('No active followers found for strategy provider pending order', {
          strategyProviderId: masterOrder.order_user_id
        });
        return;
      }

      // Update master order distribution status
      await StrategyProviderOrder.update({
        copy_distribution_status: 'distributing',
        copy_distribution_started_at: new Date(),
        total_followers_copied: followers.length
      }, {
        where: { order_id: masterOrder.order_id }
      });

      // Process each follower for pending order
      const copyResults = await Promise.allSettled(
        followers.map(follower => this.replicatePendingOrderToFollower(masterOrder, follower))
      );

      // Count successful and failed copies
      const successful = copyResults.filter(result => result.status === 'fulfilled').length;
      const failed = copyResults.filter(result => result.status === 'rejected').length;

      // Update master order with final results
      await StrategyProviderOrder.update({
        copy_distribution_status: 'completed',
        copy_distribution_completed_at: new Date(),
        successful_copies_count: successful,
        failed_copies_count: failed
      }, {
        where: { order_id: masterOrder.order_id }
      });

      logger.info('Copy trading pending order distribution completed', {
        orderId: masterOrder.order_id,
        totalFollowers: followers.length,
        successful,
        failed
      });

    } catch (error) {
      logger.error('Failed to process strategy provider pending order for copy trading', {
        orderId: masterOrder?.order_id,
        error: error.message
      });
      
      // Update master order status to failed
      if (masterOrder?.order_id) {
        await StrategyProviderOrder.update({
          copy_distribution_status: 'failed'
        }, {
          where: { order_id: masterOrder.order_id }
        });
      }
    }
  }

  /**
   * Process strategy provider order and replicate to all active followers
   * @param {Object} masterOrder - Strategy provider order
   */
  async processStrategyProviderOrder(masterOrder) {
    try {
      logger.info('Processing strategy provider order for copy trading', {
        orderId: masterOrder.order_id,
        strategyProviderId: masterOrder.order_user_id,
        symbol: masterOrder.symbol,
        orderType: masterOrder.order_type
      });

      // Get all active followers for this strategy provider
      const followers = await this.getActiveFollowers(masterOrder.order_user_id);
      
      if (followers.length === 0) {
        logger.info('No active followers found for strategy provider', {
          strategyProviderId: masterOrder.order_user_id
        });
        return;
      }

      // Update master order distribution status
      await StrategyProviderOrder.update({
        copy_distribution_status: 'distributing',
        copy_distribution_started_at: new Date(),
        total_followers_copied: followers.length
      }, {
        where: { order_id: masterOrder.order_id }
      });

      // Process each follower
      const copyResults = await Promise.allSettled(
        followers.map(follower => this.replicateOrderToFollower(masterOrder, follower))
      );

      // Count successful and failed copies
      const successful = copyResults.filter(result => result.status === 'fulfilled').length;
      const failed = copyResults.filter(result => result.status === 'rejected').length;

      // Update master order with final results
      await StrategyProviderOrder.update({
        copy_distribution_status: 'completed',
        copy_distribution_completed_at: new Date(),
        successful_copies_count: successful,
        failed_copies_count: failed
      }, {
        where: { order_id: masterOrder.order_id }
      });

      logger.info('Copy trading distribution completed', {
        orderId: masterOrder.order_id,
        totalFollowers: followers.length,
        successful,
        failed
      });

    } catch (error) {
      logger.error('Failed to process strategy provider order for copy trading', {
        orderId: masterOrder?.order_id,
        error: error.message
      });
      
      // Update master order status to failed
      if (masterOrder?.order_id) {
        await StrategyProviderOrder.update({
          copy_distribution_status: 'failed'
        }, {
          where: { order_id: masterOrder.order_id }
        });
      }
    }
  }

  /**
   * Get all active followers for a strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Array} Active followers
   */
  async getActiveFollowers(strategyProviderId) {
    try {
      logger.info('Searching for active followers', {
        strategyProviderId,
        searchCriteria: {
          strategy_provider_id: strategyProviderId,
          status: 1,
          is_active: 1,
          copy_status: 'active'
        }
      });

      const followers = await CopyFollowerAccount.findAll({
        where: {
          strategy_provider_id: strategyProviderId,
          status: 1,
          is_active: 1,
          copy_status: 'active'
        },
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'status', 'is_active', 'is_self_trading'],
          required: false // LEFT JOIN instead of INNER JOIN
        }]
      });

      // Manual user lookup for followers without associated user
      for (const follower of followers) {
        if (!follower.owner && follower.user_id) {
          try {
            const user = await LiveUser.findByPk(follower.user_id, {
              attributes: ['id', 'status', 'is_active', 'is_self_trading']
            });
            follower.user = user; // Manually attach user
            logger.info('Manually loaded user for follower', {
              followerId: follower.id,
              userId: follower.user_id,
              userFound: !!user
            });
          } catch (userErr) {
            logger.error('Failed to manually load user for follower', {
              followerId: follower.id,
              userId: follower.user_id,
              error: userErr.message
            });
          }
        } else {
          follower.user = follower.owner; // Use the association result
        }
      }

      logger.info('Found followers', {
        strategyProviderId,
        followerCount: followers.length,
        followers: followers.map(f => ({
          id: f.id,
          user_id: f.user_id,
          strategy_provider_id: f.strategy_provider_id,
          copy_status: f.copy_status,
          status: f.status,
          is_active: f.is_active,
          hasUser: !!f.user,
          userDetails: f.user ? {
            id: f.user.id,
            status: f.user.status,
            is_active: f.user.is_active,
            is_self_trading: f.user.is_self_trading
          } : null
        }))
      });

      return followers;
    } catch (error) {
      logger.error('Failed to get active followers', {
        strategyProviderId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Replicate master order to individual follower
   * @param {Object} masterOrder - Strategy provider order
   * @param {Object} follower - Follower account
   */
  async replicateOrderToFollower(masterOrder, follower) {
    try {
      // Validate follower can receive orders
      const canCopy = await this.validateFollowerForCopy(follower);
      if (!canCopy.valid) {
        throw new Error(canCopy.reason);
      }

      // Calculate lot size based on follower's equity/balance
      const lotCalculation = await this.calculateFollowerLotSize(masterOrder, follower);
      
      // Check if calculated lot meets minimum requirements
      if (lotCalculation.finalLotSize < lotCalculation.minLot) {
        await this.createSkippedOrder(masterOrder, follower, 'min_lot_size', lotCalculation);
        return { status: 'skipped', reason: 'Below minimum lot size' };
      }

      // Note: Individual order SL/TP removed - copy followers use account-level equity thresholds only
      // const modifiedOrder = await this.applyFollowerSlTpSettings(masterOrder, follower); // REMOVED

      // Generate follower order ID
      const followerOrderId = await idGenerator.generateOrderId();

      // Create follower order record
      // Note: Individual order SL/TP removed - copy followers use account-level equity thresholds only
      const followerOrder = await CopyFollowerOrder.create({
        order_id: followerOrderId,
        order_user_id: follower.id,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_status: 'QUEUED',
        order_price: masterOrder.order_price,
        order_quantity: lotCalculation.finalLotSize,
        stop_loss: null, // Individual order SL/TP removed
        take_profit: null, // Individual order SL/TP removed
        
        // Copy trading specific fields
        master_order_id: masterOrder.order_id,
        strategy_provider_id: masterOrder.order_user_id,
        copy_follower_account_id: follower.id,
        
        // Lot calculation audit trail
        master_lot_size: masterOrder.order_quantity,
        follower_investment_at_copy: follower.investment_amount,
        master_equity_at_copy: lotCalculation.masterEquity,
        lot_ratio: lotCalculation.ratio,
        calculated_lot_size: lotCalculation.calculatedLotSize,
        final_lot_size: lotCalculation.finalLotSize,
        
        // Copy settings
        copy_status: 'pending',
        original_stop_loss: null, // Individual order SL/TP removed
        original_take_profit: null, // Individual order SL/TP removed
        modified_by_follower: false, // No individual order modifications
        sl_modification_type: 'none', // No individual order SL/TP
        tp_modification_type: 'none', // No individual order SL/TP
        
        // Performance fee tracking
        performance_fee_percentage: follower.strategyProvider?.performance_fee || 0,
        
        status: 'OPEN',
        placed_by: 'copy_trading'
      });

      // Execute order through Python service
      logger.info('About to execute follower order', {
        followerOrderId: followerOrder.order_id,
        followerId: follower.id,
        masterOrderId: masterOrder.order_id
      });
      
      const executionResult = await this.executeFollowerOrder(followerOrder, follower);
      
      logger.info('Follower order execution result', {
        followerOrderId: followerOrder.order_id,
        success: executionResult.success,
        error: executionResult.error,
        executionResult: executionResult
      });

      // Update follower order with execution results
      await this.updateFollowerOrderAfterExecution(followerOrder, executionResult);

      // Create Redis entries for copy follower order (CRITICAL for portfolio calculation)
      if (executionResult.success) {
        try {
          logger.info('Creating Redis entries for copy follower order', {
            followerOrderId: followerOrder.order_id,
            copyFollowerAccountId: follower.id,
            symbol: followerOrder.symbol,
            orderStatus: executionResult.data?.flow === 'provider' ? 'QUEUED' : 'OPEN'
          });

          // Create Redis entries so Python portfolio calculator can find this copy follower
          await this.createRedisOrderEntries({
            order_id: followerOrder.order_id,
            order_user_id: follower.id, // Use copy follower account ID
            symbol: followerOrder.symbol,
            order_type: followerOrder.order_type,
            order_status: executionResult.data?.flow === 'provider' ? 'QUEUED' : 'OPEN',
            order_price: executionResult.executionPrice || followerOrder.order_price,
            order_quantity: followerOrder.order_quantity,
            stop_loss: followerOrder.stop_loss,
            take_profit: followerOrder.take_profit,
            placed_by: 'copy_trading'
          }, 'copy_follower');

          logger.info('Redis entries created successfully for copy follower order', {
            followerOrderId: followerOrder.order_id,
            copyFollowerAccountId: follower.id,
            symbolHoldersKey: `symbol_holders:${followerOrder.symbol}:copy_follower`
          });

        } catch (redisError) {
          logger.error('Failed to create Redis entries for copy follower order', {
            followerOrderId: followerOrder.order_id,
            copyFollowerAccountId: follower.id,
            error: redisError.message,
            stack: redisError.stack
          });
          // Don't fail the entire operation, but this will cause portfolio calculation issues
        }
      }

      // Update copy follower margin for local execution (like regular users)
      if (executionResult.success && executionResult.data?.flow === 'local' && typeof executionResult.data.used_margin_executed === 'number') {
        try {
          await updateUserUsedMargin({
            userType: 'copy_follower',
            userId: parseInt(follower.id), // Use copy follower account ID to avoid ambiguity
            usedMargin: executionResult.data.used_margin_executed,
          });
          
          // Emit portfolio event for copy follower margin update
          try {
            portfolioEvents.emitUserUpdate('copy_follower', follower.id.toString(), {
              type: 'user_margin_update',
              used_margin_usd: executionResult.data.used_margin_executed,
            });
          } catch (e) {
            logger.warn('Failed to emit portfolio event after copy follower margin update', { 
              error: e.message, 
              copyFollowerId: follower.id 
            });
          }
        } catch (mErr) {
          logger.error('Failed to update copy follower used margin', {
            error: mErr.message,
            copyFollowerId: follower.id,
            userType: 'copy_follower',
          });
          // Do not fail the request; SQL margin is an eventual-consistency mirror of Redis
        }
      }

      // Note: Equity monitoring is now handled by background worker (every 200ms)
      // No need for individual order monitoring - background worker monitors all accounts efficiently

      // Update follower account statistics
      await this.updateFollowerAccountStats(follower, executionResult.success);

      return { 
        status: 'success', 
        orderId: followerOrderId,
        lotSize: lotCalculation.finalLotSize
      };

    } catch (error) {
      logger.error('Failed to replicate order to follower', {
        masterOrderId: masterOrder.order_id,
        followerId: follower.id,
        error: error.message,
        stack: error.stack
      });

      // Update follower account failed copies count
      await CopyFollowerAccount.increment('failed_copies', {
        where: { id: follower.id }
      });

      throw error;
    }
  }

  /**
   * Replicate master pending order to individual follower
   * @param {Object} masterOrder - Strategy provider pending order
   * @param {Object} follower - Follower account
   */
  async replicatePendingOrderToFollower(masterOrder, follower) {
    try {
      // Validate follower can receive orders
      const canCopy = await this.validateFollowerForCopy(follower);
      if (!canCopy.valid) {
        throw new Error(canCopy.reason);
      }

      // Calculate lot size based on follower's equity/balance
      const lotCalculation = await this.calculateFollowerLotSize(masterOrder, follower);
      
      // Check if calculated lot meets minimum requirements
      if (lotCalculation.finalLotSize < lotCalculation.minLot) {
        await this.createSkippedPendingOrder(masterOrder, follower, 'min_lot_size', lotCalculation);
        return { status: 'skipped', reason: 'Below minimum lot size' };
      }

      // Generate follower order ID
      const followerOrderId = await idGenerator.generateOrderId();

      // Create follower pending order record
      const followerOrder = await CopyFollowerOrder.create({
        order_id: followerOrderId,
        order_user_id: follower.id,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_status: 'PENDING', // Pending orders start as PENDING
        order_price: masterOrder.order_price,
        order_quantity: lotCalculation.finalLotSize,
        stop_loss: masterOrder.stop_loss,
        take_profit: masterOrder.take_profit,
        
        // Copy trading specific fields
        master_order_id: masterOrder.order_id,
        strategy_provider_id: masterOrder.order_user_id,
        copy_follower_account_id: follower.id,
        
        // Lot calculation audit trail
        master_lot_size: masterOrder.order_quantity,
        follower_investment_at_copy: follower.investment_amount,
        master_equity_at_copy: lotCalculation.masterEquity,
        lot_ratio: lotCalculation.ratio,
        calculated_lot_size: lotCalculation.calculatedLotSize,
        final_lot_size: lotCalculation.finalLotSize,
        
        // Copy settings
        copy_status: 'pending',
        original_stop_loss: masterOrder.stop_loss,
        original_take_profit: masterOrder.take_profit,
        
        // Performance fee tracking
        performance_fee_percentage: follower.strategyProvider?.performance_fee || 0,
        
        status: 'PENDING',
        placed_by: 'copy_trading'
      });

      // Place pending order through Python service (same as live users)
      logger.info('About to place follower pending order', {
        followerOrderId: followerOrder.order_id,
        followerId: follower.id,
        masterOrderId: masterOrder.order_id
      });
      
      const placementResult = await this.placeFollowerOrder(followerOrder, follower);
      
      if (placementResult.success) {
        try {
          portfolioEvents.emitUserUpdate('copy_follower', follower.id, {
            type: 'order_pending_created',
            order_id: followerOrder.order_id,
            flow: placementResult.flow,
            strategy_provider_id: masterOrder.order_user_id
          });
        } catch (emitErr) {
          logger.warn('Failed to emit copy follower pending creation event', {
            followerOrderId: followerOrder.order_id,
            followerId: follower.id,
            error: emitErr.message
          });
        }

        if (placementResult.flow === 'provider') {
          try {
            await this.createRedisOrderEntries({
              order_id: followerOrder.order_id,
              order_user_id: follower.id,
              symbol: followerOrder.symbol,
              order_type: followerOrder.order_type,
              order_status: 'PENDING-QUEUED',
              order_price: followerOrder.order_price,
              order_quantity: followerOrder.order_quantity,
              stop_loss: followerOrder.stop_loss,
              take_profit: followerOrder.take_profit,
              master_order_id: masterOrder.order_id,
              placed_by: 'copy_trading'
            }, 'copy_follower');

            try {
              await orderLifecycleService.addLifecycleId(
                followerOrder.order_id,
                'order_id',
                followerOrder.order_id,
                'copy_follower_provider_pending'
              );
            } catch (lifecycleError) {
              logger.warn('Failed to register lifecycle id for copy follower pending order', {
                followerOrderId: followerOrder.order_id,
                followerId: follower.id,
                error: lifecycleError.message
              });
            }
          } catch (providerRedisError) {
            logger.error('Failed to create Redis context for provider copy follower pending order', {
              followerOrderId: followerOrder.order_id,
              masterOrderId: masterOrder.order_id,
              followerId: follower.id,
              error: providerRedisError.message
            });

            await followerOrder.update({
              copy_status: 'failed',
              order_status: 'REJECTED',
              failure_reason: 'redis_entry_failed'
            });

            try {
              await CopyFollowerAccount.increment('failed_copies', {
                where: { id: follower.id }
              });
            } catch (failedMetricError) {
              logger.warn('Failed to increment copy follower failed_copies metric after redis sync failure', {
                followerId: follower.id,
                error: failedMetricError.message
              });
            }

            return { status: 'failed', reason: 'redis_entry_failed' };
          }
        }
      }

      logger.info('Follower pending order placement result', {
        followerOrderId: followerOrder.order_id,
        success: placementResult.success,
        error: placementResult.error,
        placementResult: placementResult
      });

      // Update follower order with placement results
      await this.updateFollowerOrderAfterPlacement(followerOrder, placementResult);

      // Update follower account statistics
      await this.updateFollowerAccountStats(follower, placementResult.success);

      return { 
        status: 'success', 
        orderId: followerOrderId,
        lotSize: lotCalculation.finalLotSize
      };

    } catch (error) {
      logger.error('Failed to replicate pending order to follower', {
        masterOrderId: masterOrder.order_id,
        followerId: follower.id,
        error: error.message,
        stack: error.stack
      });

      // Update follower account failed copies count
      await CopyFollowerAccount.increment('failed_copies', {
        where: { id: follower.id }
      });

      throw error;
    }
  }

  /**
   * Validate if follower can receive copied orders
   * @param {Object} follower - Follower account
   * @returns {Object} Validation result
   */
  async validateFollowerForCopy(follower) {
    try {
      logger.info('Validating follower for copy', {
        followerId: follower.id,
        user: follower.user ? {
          id: follower.user.id,
          status: follower.user.status,
          is_active: follower.user.is_active,
          is_self_trading: follower.user.is_self_trading
        } : null,
        followerAccount: {
          status: follower.status,
          is_active: follower.is_active,
          copy_status: follower.copy_status
        }
      });

      // Check follower user status (more flexible validation)
      if (!follower.user) {
        return { valid: false, reason: 'Follower user not found' };
      }

      if (parseInt(follower.user.status) !== 1) {
        return { valid: false, reason: `Follower user status is ${follower.user.status}, expected 1` };
      }

      if (parseInt(follower.user.is_active) !== 1) {
        return { valid: false, reason: `Follower user is_active is ${follower.user.is_active}, expected 1` };
      }

      if (parseInt(follower.user.is_self_trading) !== 1) {
        return { valid: false, reason: `Follower self trading is ${follower.user.is_self_trading}, expected 1` };
      }

      // Check follower account status
      if (parseInt(follower.status) !== 1) {
        return { valid: false, reason: `Follower account status is ${follower.status}, expected 1` };
      }

      if (parseInt(follower.is_active) !== 1) {
        return { valid: false, reason: `Follower account is_active is ${follower.is_active}, expected 1` };
      }

      if (follower.copy_status !== 'active') {
        return { valid: false, reason: 'Copy trading is paused or stopped' };
      }

      // Check daily loss limits
      if (follower.max_daily_loss) {
        const todayLoss = await this.getTodayLossForFollower(follower.id);
        if (todayLoss >= follower.max_daily_loss) {
          return { valid: false, reason: 'Daily loss limit exceeded' };
        }
      }

      // Check drawdown limits
      if (follower.stop_copying_on_drawdown) {
        const currentDrawdown = await this.calculateFollowerDrawdown(follower);
        if (currentDrawdown >= follower.stop_copying_on_drawdown) {
          return { valid: false, reason: 'Drawdown limit exceeded' };
        }
      }

      return { valid: true };

    } catch (error) {
      logger.error('Error validating follower for copy', {
        followerId: follower.id,
        error: error.message
      });
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * Calculate follower lot size based on equity ratio
   * @param {Object} masterOrder - Master order
   * @param {Object} follower - Follower account
   * @returns {Object} Lot calculation details
   */
  async calculateFollowerLotSize(masterOrder, follower) {
    try {
      // Get strategy provider and require live equity from Redis portfolio data
      const strategyProvider = await StrategyProviderAccount.findByPk(masterOrder.order_user_id);
      if (!strategyProvider) {
        throw new Error(`Strategy provider not found: ${masterOrder.order_user_id}`);
      }

      // Fetch live equity from Redis portfolio data (required)
      const portfolioKey = `user_portfolio:{strategy_provider:${masterOrder.order_user_id}}`;
      let portfolioData;
      try {
        portfolioData = await redisCluster.hgetall(portfolioKey);
      } catch (redisError) {
        logger.error('Failed to fetch portfolio data from Redis', {
          strategyProviderId: masterOrder.order_user_id,
          portfolioKey,
          error: redisError.message
        });
        throw new Error(`Cannot fetch live portfolio data for strategy provider ${masterOrder.order_user_id}: ${redisError.message}`);
      }

      // If portfolio data is missing, wait briefly and try once more (portfolio might be recalculating)
      if (!portfolioData || !portfolioData.equity) {
        logger.info('Portfolio data missing, waiting for potential recalculation', {
          strategyProviderId: masterOrder.order_user_id,
          portfolioKey
        });
        
        // Wait 1 second for portfolio calculator to potentially update the key (increased from 500ms)
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        try {
          portfolioData = await redisCluster.hgetall(portfolioKey);
          if (portfolioData && portfolioData.equity) {
            logger.info('Portfolio data found after wait', {
              strategyProviderId: masterOrder.order_user_id,
              portfolioKey,
              equity: portfolioData.equity
            });
          }
        } catch (retryError) {
          logger.warn('Retry fetch of portfolio data failed', {
            strategyProviderId: masterOrder.order_user_id,
            error: retryError.message
          });
        }
      }

      let masterEquity;
      let equitySource;
      
      if (!portfolioData || !portfolioData.equity) {
        // Enhanced fallback: Check Redis config for updated balance first, then DB wallet_balance
        let configBalance = null;
        try {
          const configKey = `user:{strategy_provider:${masterOrder.order_user_id}}:config`;
          const configData = await redisCluster.hgetall(configKey);
          configBalance = parseFloat(configData.balance || configData.wallet_balance || 0);
          
          logger.info('Checking Redis config for updated balance', {
            strategyProviderId: masterOrder.order_user_id,
            configKey,
            configBalance,
            configFields: Object.keys(configData || {}),
            rawConfigData: configData
          });
        } catch (configError) {
          logger.warn('Failed to fetch config balance from Redis', {
            strategyProviderId: masterOrder.order_user_id,
            error: configError.message
          });
        }
        
        // Use config balance if available and valid, otherwise fallback to DB wallet_balance
        masterEquity = (configBalance && configBalance > 0) ? configBalance : parseFloat(strategyProvider.wallet_balance || 0);
        equitySource = (configBalance && configBalance > 0) ? 'redis_config_balance' : 'db_wallet_balance_fallback';
        
        logger.warn('No live equity data available in Redis portfolio, using enhanced fallback', {
          strategyProviderId: masterOrder.order_user_id,
          portfolioKey,
          portfolioData: portfolioData ? Object.keys(portfolioData) : null,
          configBalance,
          dbWalletBalance: strategyProvider.wallet_balance,
          finalEquity: masterEquity,
          equitySource
        });
        
        if (masterEquity <= 0) {
          throw new Error(`Strategy provider ${masterOrder.order_user_id} has no equity available (final equity: ${masterEquity}, source: ${equitySource})`);
        }
      } else {
        masterEquity = parseFloat(portfolioData.equity);
        equitySource = 'redis_portfolio';
        
        logger.info('Using live equity from Redis portfolio', {
          strategyProviderId: masterOrder.order_user_id,
          portfolioKey,
          liveEquity: masterEquity,
          portfolioFields: Object.keys(portfolioData),
          portfolioLastUpdated: portfolioData.last_updated,
          portfolioCalcStatus: portfolioData.calc_status
        });
      }
      
      // Get follower investment amount (their equity in copy trading)
      const followerInvestment = parseFloat(follower.investment_amount || 0);
      
      logger.info('Lot size calculation data', {
        strategyProviderId: masterOrder.order_user_id,
        strategyProvider: {
          id: strategyProvider.id,
          wallet_balance: strategyProvider.wallet_balance,
          liveEquity: masterEquity,
          equitySource: equitySource
        },
        follower: {
          id: follower.id,
          investment_amount: follower.investment_amount,
          followerInvestment: followerInvestment
        },
        masterOrder: {
          order_quantity: masterOrder.order_quantity
        }
      });
      
      if (masterEquity <= 0) {
        throw new Error(`Master equity is zero or negative: live_equity=${masterEquity} from Redis portfolio`);
      }

      // Calculate basic ratio
      const ratio = followerInvestment / masterEquity;
      const masterLotSize = parseFloat(masterOrder.order_quantity);
      let calculatedLotSize = masterLotSize * ratio;

      // Apply follower's max lot size limit
      if (follower.max_lot_size && calculatedLotSize > follower.max_lot_size) {
        calculatedLotSize = parseFloat(follower.max_lot_size);
      }

      // Get group min/max lot constraints
      const groupConstraints = await this.getGroupLotConstraints(follower.group, masterOrder.symbol);
      
      // Don't round up to minimum - let the caller decide whether to skip or not
      // Only constrain to maximum if it exceeds the limit
      let finalLotSize = calculatedLotSize;
      if (finalLotSize > groupConstraints.maxLot) {
        finalLotSize = groupConstraints.maxLot;
      }


      logger.info('Lot size calculation data',{ finalLotSize: finalLotSize , calculatedLotSize: calculatedLotSize} );

      return {
        masterEquity,
        followerInvestment,
        ratio,
        masterLotSize,
        calculatedLotSize,
        finalLotSize,
        minLot: groupConstraints.minLot,
        maxLot: groupConstraints.maxLot
      };

    } catch (error) {
      logger.error('Failed to calculate follower lot size', {
        masterOrderId: masterOrder.order_id,
        followerId: follower.id,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get group lot constraints for symbol
   * @param {string} groupName - Group name
   * @param {string} symbol - Trading symbol
   * @returns {Object} Min/max lot constraints
   */
  async getGroupLotConstraints(groupName, symbol) {
    try {
      const groupFields = await groupsCache.getGroupFields(groupName, symbol, ['min_lot', 'max_lot']);
      
      return {
        minLot: parseFloat(groupFields?.min_lot || 0.01),
        maxLot: parseFloat(groupFields?.max_lot || 100.0)
      };
    } catch (error) {
      logger.error('Failed to get group lot constraints', {
        groupName,
        symbol,
        error: error.message
      });
      
      // Return default constraints
      return {
        minLot: 0.01,
        maxLot: 100.0
      };
    }
  }

  /**
   * DEPRECATED: Apply follower's SL/TP settings to master order
   * Individual order SL/TP removed - copy followers use account-level equity thresholds only
   * @param {Object} masterOrder - Master order
   * @param {Object} follower - Follower account
   * @returns {Object} Modified order with SL/TP
   * @deprecated Use account-level equity monitoring instead
   */
  async applyFollowerSlTpSettings(masterOrder, follower) {
    logger.warn('DEPRECATED: applyFollowerSlTpSettings called. Individual order SL/TP removed for copy followers.', {
      masterOrderId: masterOrder.order_id,
      followerId: follower.id
    });
    return {
      stopLoss: null,
      takeProfit: null,
      modified: false,
      slModType: 'none',
      tpModType: 'none'
    };
  }

  /**
   * Execute follower order through Python service
   * @param {Object} followerOrder - Follower order
   * @param {Object} follower - Follower account
   * @returns {Object} Execution result
   */
  async executeFollowerOrder(followerOrder, follower) {
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    // Execute follower order through Python service (without SL/TP initially)
    const payload = {
      symbol: followerOrder.symbol,
      order_type: followerOrder.order_type,
      order_price: followerOrder.order_price,
      order_quantity: followerOrder.order_quantity,
      user_id: follower.id.toString(), // Convert to string as required by Python service
      user_type: 'copy_follower', // Use copy_follower user type
      order_id: followerOrder.order_id,
      status: 'OPEN',
      order_status: 'OPEN',
      copy_trading: true,
      master_order_id: followerOrder.master_order_id
    };
    
    try {

      logger.info('Executing follower order payload', {
        followerOrderId: followerOrder.order_id,
        payload: payload,
        pythonServiceUrl: `${baseUrl}/api/orders/instant/execute`
      });

      const response = await axios.post(
        `${baseUrl}/api/orders/instant/execute`,
        payload,
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || 'livefxhub'
          }
        }
      );

      const result = {
        success: true,
        data: response.data?.data || response.data || {},
        executionPrice: response.data?.data?.exec_price || followerOrder.order_price,
        margin: response.data?.data?.margin_usd || 0,
        contractValue: response.data?.data?.contract_value || 0,
        commission: response.data?.data?.commission_entry || 0
      };

      // Note: Individual order SL/TP removed - copy followers use account-level equity thresholds only
      // Post-execution SL/TP logic removed - background worker monitors equity thresholds

      return result;

    } catch (error) {
      logger.error('Failed to execute follower order', {
        followerOrderId: followerOrder.order_id,
        followerId: follower.id,
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
        statusText: error.response?.statusText,
        headers: error.response?.headers,
        payload: payload,
        pythonServiceUrl: `${baseUrl}/api/orders/instant/execute`
      });

      return {
        success: false,
        error: error.message,
        executionPrice: followerOrder.order_price,
        margin: 0,
        contractValue: 0,
        commission: 0
      };
    }
  }

  /**
   * Update follower order after execution
   * @param {Object} followerOrder - Follower order
   * @param {Object} executionResult - Execution result
   */
  async updateFollowerOrderAfterExecution(followerOrder, executionResult) {
    try {
      const updateFields = {
        copy_timestamp: new Date()
      };

      if (executionResult.success) {
        updateFields.copy_status = 'copied';
        
        // Follow same pattern as live users and strategy providers
        const flow = executionResult.data?.flow || 'local';
        updateFields.order_status = flow === 'provider' ? 'QUEUED' : 'OPEN';
        updateFields.order_price = executionResult.executionPrice;
        
        // For provider flow, only update basic fields (margin updated by worker on confirmation)
        // For local flow, update all fields immediately
        if (flow === 'local') {
          updateFields.margin = executionResult.margin;
          updateFields.contract_value = executionResult.contractValue;
          updateFields.commission = executionResult.commission;
        }
        
        logger.info('Copy follower order status set based on flow', {
          followerOrderId: followerOrder.order_id,
          flow,
          orderStatus: updateFields.order_status
        });
      } else {
        updateFields.copy_status = 'failed';
        updateFields.order_status = 'REJECTED';
        updateFields.failure_reason = executionResult.error;
      }

      await CopyFollowerOrder.update(updateFields, {
        where: { id: followerOrder.id }
      });

    } catch (error) {
      logger.error('Failed to update follower order after execution', {
        followerOrderId: followerOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Update follower account statistics
   * @param {Object} follower - Follower account
   * @param {boolean} success - Whether copy was successful
   */
  async updateFollowerAccountStats(follower, success) {
    try {
      const updateFields = {
        last_copy_date: new Date()
      };

      if (success) {
        updateFields.successful_copies = follower.successful_copies + 1;
        updateFields.total_copied_orders = follower.total_copied_orders + 1;
      } else {
        updateFields.failed_copies = follower.failed_copies + 1;
      }

      await CopyFollowerAccount.update(updateFields, {
        where: { id: follower.id }
      });

    } catch (error) {
      logger.error('Failed to update follower account stats', {
        followerId: follower.id,
        error: error.message
      });
    }
  }

  /**
   * Create skipped order record for audit trail
   * @param {Object} masterOrder - Master order
   * @param {Object} follower - Follower account
   * @param {string} reason - Skip reason
   * @param {Object} lotCalculation - Lot calculation details
   */
  async createSkippedOrder(masterOrder, follower, reason, lotCalculation) {
    try {
      const followerOrderId = await idGenerator.generateOrderId();

      await CopyFollowerOrder.create({
        order_id: followerOrderId,
        order_user_id: follower.id,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_status: 'SKIPPED',
        order_price: masterOrder.order_price,
        order_quantity: lotCalculation.calculatedLotSize,
        
        // Copy trading specific fields
        master_order_id: masterOrder.order_id,
        strategy_provider_id: masterOrder.order_user_id,
        copy_follower_account_id: follower.id,
        
        // Lot calculation audit trail
        master_lot_size: masterOrder.order_quantity,
        follower_investment_at_copy: follower.investment_amount,
        master_equity_at_copy: lotCalculation.masterEquity,
        lot_ratio: lotCalculation.ratio,
        calculated_lot_size: lotCalculation.calculatedLotSize,
        final_lot_size: lotCalculation.finalLotSize,
        
        copy_status: 'failed',
        failure_reason: `Skipped: ${reason}`,
        
        status: 'SKIPPED',
        placed_by: 'copy_trading'
      });

      // Update follower account skipped count
      await CopyFollowerAccount.increment('failed_copies', {
        where: { id: follower.id }
      });

    } catch (error) {
      logger.error('Failed to create skipped order record', {
        masterOrderId: masterOrder.order_id,
        followerId: follower.id,
        error: error.message
      });
    }
  }

  /**
   * Get today's loss for follower (for daily loss limit check)
   * @param {number} followerId - Follower ID
   * @returns {number} Today's loss amount
   */
  async getTodayLossForFollower(followerId) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const result = await CopyFollowerOrder.sum('net_profit', {
        where: {
          copy_follower_account_id: followerId,
          order_status: 'CLOSED',
          net_profit: { [Op.lt]: 0 },
          updated_at: { [Op.gte]: today }
        }
      });

      return Math.abs(result || 0);
    } catch (error) {
      logger.error('Failed to get today loss for follower', {
        followerId,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Calculate current drawdown for follower
   * @param {Object} follower - Follower account
   * @returns {number} Current drawdown percentage
   */
  async calculateFollowerDrawdown(follower) {
    try {
      const initialInvestment = parseFloat(follower.initial_investment || follower.investment_amount || 0);
      const currentEquity = parseFloat(follower.equity || 0);
      
      if (initialInvestment <= 0) return 0;
      
      const drawdown = ((initialInvestment - currentEquity) / initialInvestment) * 100;
      return Math.max(0, drawdown);
      
    } catch (error) {
      logger.error('Failed to calculate follower drawdown', {
        followerId: follower.id,
        error: error.message
      });
      return 0;
    }
  }

  /**

      // Process each copied order based on master order status
      for (const copiedOrder of copiedOrders) {
        if (masterOrder.order_status === 'CLOSED') {
          await this.closeFollowerOrder(copiedOrder, masterOrder);
        } else if (masterOrder.order_status === 'CANCELLED') {
          await this.cancelFollowerOrder(copiedOrder, masterOrder);
        }
      }

    } catch (error) {
      logger.error('Failed to process strategy provider order update', {
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Close follower order when master order is closed
   * @param {Object} copiedOrder - Copied order
   * @param {Object} masterOrder - Master order
   */
  async closeFollowerOrder(copiedOrder, masterOrder) {
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      
      // Generate close_id for copy follower order
      const close_id = await idGenerator.generateOrderId();
      
      const payload = {
        order_id: String(copiedOrder.order_id), // Ensure it's a string
        user_id: String(copiedOrder.order_user_id), // Ensure it's a string
        user_type: 'copy_follower',
        symbol: copiedOrder.symbol,           // Required by Python schema
        order_type: copiedOrder.order_type,   // Required by Python schema
        close_price: masterOrder.close_price || null, // Ensure it's not undefined
        status: 'CLOSED',                     // Required by Python schema
        order_status: 'CLOSED',               // Required by Python schema
        close_id: String(close_id),           // Add close_id for copy follower order
        close_message: masterOrder.close_message || null, // Add close message
        copy_trading: true
      };

      // Debug log the payload
      logger.info('Closing follower order payload', {
        copiedOrderId: copiedOrder.order_id,
        masterOrderId: masterOrder.order_id,
        payload
      });

      const response = await axios.post(
        `${baseUrl}/api/orders/close`,
        payload,
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || 'livefxhub'
          }
        }
      );

      // For local flow, update the copy follower order in Node.js database as well
      if (response.data?.data?.flow === 'local') {
        try {
          const result = response.data.data;
          const updateFields = {
            order_status: 'CLOSED',
            status: 'CLOSED'
          };
          
          // Add close result fields if available
          if (result.close_price != null) updateFields.close_price = String(result.close_price);
          // Note: net_profit will be updated later with adjusted value after performance fee calculation
          if (result.swap != null) updateFields.swap = String(result.swap);
          if (result.total_commission != null) updateFields.commission = String(result.total_commission);
          if (masterOrder.close_message) updateFields.close_message = masterOrder.close_message;
          
          // Update copy follower order in database
          await CopyFollowerOrder.update(updateFields, {
            where: { order_id: copiedOrder.order_id }
          });
          
          logger.info('Copy follower order updated in database after local close', {
            copiedOrderId: copiedOrder.order_id,
            masterOrderId: masterOrder.order_id,
            updateFields
          });

          // Update copy follower account margin (same as strategy providers)
          if (typeof result.used_margin_executed === 'number') {
            try {
              await updateUserUsedMargin({
                userType: 'copy_follower',
                userId: parseInt(copiedOrder.order_user_id),
                usedMargin: result.used_margin_executed
              });
              
              logger.info('Copy follower margin updated after local close', {
                copiedOrderId: copiedOrder.order_id,
                user_id: copiedOrder.order_user_id,
                used_margin: result.used_margin_executed
              });
            } catch (marginError) {
              logger.error('Failed to update copy follower margin', {
                copiedOrderId: copiedOrder.order_id,
                user_id: copiedOrder.order_user_id,
                error: marginError.message
              });
            }
          }

          // Apply wallet payout for copy follower (same as strategy providers)
          let adjustedNetProfit = Number(result.net_profit) || 0;
          let payoutApplied = false;
          try {
            const payoutKey = `close_payout_applied:${String(copiedOrder.order_id)}`;
            const nx = await redisCluster.set(payoutKey, '1', 'EX', 7 * 24 * 3600, 'NX');
            if (nx) {
              payoutApplied = true;
              // Calculate adjusted net profit after performance fee (if applicable)
              let performanceFeeResult = null;
              
              // Always update net profit in order record, regardless of profit/loss
              try {
                if (adjustedNetProfit > 0) {
                  // Try to apply performance fee for profitable orders
                  const { calculateAndApplyPerformanceFee } = require('./performanceFee.service');
                  performanceFeeResult = await calculateAndApplyPerformanceFee({
                    copyFollowerOrderId: copiedOrder.order_id,
                    copyFollowerUserId: parseInt(copiedOrder.order_user_id),
                    strategyProviderId: masterOrder.order_user_id,
                    orderNetProfit: adjustedNetProfit,
                    symbol: copiedOrder.symbol,
                    orderType: copiedOrder.order_type
                  });
                  
                  if (performanceFeeResult && performanceFeeResult.performanceFeeCharged) {
                    adjustedNetProfit = performanceFeeResult.adjustedNetProfit;
                    
                    logger.info('Performance fee applied for copy follower local close', {
                      copiedOrderId: copiedOrder.order_id,
                      originalNetProfit: result.net_profit,
                      performanceFeeAmount: performanceFeeResult.performanceFeeAmount,
                      adjustedNetProfit
                    });
                  }
                }
                
                // Update copy follower order with net_profit (for both profit and loss)
                await CopyFollowerOrder.update({
                  net_profit: String(adjustedNetProfit)
                }, {
                  where: { order_id: copiedOrder.order_id }
                });
                
                logger.info('Copy follower order net profit updated in database', {
                  copiedOrderId: copiedOrder.order_id,
                  net_profit: adjustedNetProfit,
                  hasPerformanceFee: performanceFeeResult?.performanceFeeCharged || false
                });
                
              } catch (performanceFeeError) {
                logger.error('Failed to apply performance fee for copy follower local close', {
                  copiedOrderId: copiedOrder.order_id,
                  error: performanceFeeError.message
                });
                
                // Still update net profit even if performance fee calculation fails
                try {
                  await CopyFollowerOrder.update({
                    net_profit: String(adjustedNetProfit)
                  }, {
                    where: { order_id: copiedOrder.order_id }
                  });
                  
                  logger.info('Copy follower order net profit updated (performance fee failed)', {
                    copiedOrderId: copiedOrder.order_id,
                    net_profit: adjustedNetProfit
                  });
                } catch (updateError) {
                  logger.error('Failed to update copy follower order net profit', {
                    copiedOrderId: copiedOrder.order_id,
                    error: updateError.message
                  });
                }
              }

              const { applyOrderClosePayout } = require('./order.payout.service');
              await applyOrderClosePayout({
                userType: 'copy_follower',
                userId: parseInt(copiedOrder.order_user_id),
                orderPk: copiedOrder?.id ?? null,
                orderIdStr: String(copiedOrder.order_id),
                netProfit: adjustedNetProfit,
                commission: Number(result.total_commission) || 0,
                profitUsd: Number(result.profit_usd) || 0,
                swap: Number(result.swap) || 0,
                symbol: copiedOrder.symbol,
                orderType: copiedOrder.order_type,
              });
              
              logger.info('Copy follower wallet payout applied after local close', {
                copiedOrderId: copiedOrder.order_id,
                user_id: copiedOrder.order_user_id,
                adjustedNetProfit
              });
              
              // Emit wallet balance update events
              try {
                const portfolioEvents = require('./events/portfolio.events');
                portfolioEvents.emitUserUpdate('copy_follower', String(copiedOrder.order_user_id), { 
                  type: 'wallet_balance_update', 
                  order_id: copiedOrder.order_id 
                });
                
                // If performance fee was applied, also emit update for strategy provider
                if (performanceFeeResult && performanceFeeResult.performanceFeeCharged) {
                  portfolioEvents.emitUserUpdate('strategy_provider', String(masterOrder.order_user_id), {
                    type: 'wallet_balance_update',
                    reason: 'performance_fee_earned',
                    order_id: copiedOrder.order_id,
                  });
                }
              } catch (_) {}
            }
          } catch (e) {
            logger.warn('Failed to apply wallet payout on copy follower local close', { 
              error: e.message, 
              order_id: copiedOrder.order_id
            });
          }

        } catch (dbError) {
          logger.error('Failed to update copy follower order in database', {
            copiedOrderId: copiedOrder.order_id,
            error: dbError.message
          });
        }
      }

    } catch (error) {
      logger.error('Failed to close follower order', {
        copiedOrderId: copiedOrder.order_id,
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Cancel follower order when master order is cancelled
   * @param {Object} copiedOrder - Copied order
   * @param {Object} masterOrder - Master order
   */
  async cancelFollowerOrder(copiedOrder, masterOrder) {
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      
      const payload = {
        order_id: String(copiedOrder.order_id), // Ensure it's a string
        user_id: String(copiedOrder.order_user_id), // Ensure it's a string
        user_type: 'copy_follower',
        symbol: copiedOrder.symbol, // Required by Python schema
        order_type: copiedOrder.order_type, // Required by Python schema
        status: 'CANCELLED', // Required by Python schema
        order_status: 'CANCELLED', // Required by Python schema
        copy_trading: true
      };

      const response = await axios.post(
        `${baseUrl}/api/orders/cancel`,
        payload,
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || 'livefxhub'
          }
        }
      );

      // For local flow, update the copy follower order in Node.js database as well
      if (response.data?.data?.flow === 'local') {
        try {
          const result = response.data.data;
          const updateFields = {
            order_status: 'CANCELLED',
            status: 'CANCELLED'
          };
          
          // Update copy follower order in database
          await CopyFollowerOrder.update(updateFields, {
            where: { order_id: copiedOrder.order_id }
          });
          
          logger.info('Copy follower order updated in database after local cancel', {
            copiedOrderId: copiedOrder.order_id,
            masterOrderId: masterOrder.order_id,
            updateFields
          });

          // Update copy follower account margin if provided
          if (typeof result.used_margin_executed === 'number') {
            try {
              await updateUserUsedMargin({
                userType: 'copy_follower',
                userId: parseInt(copiedOrder.order_user_id),
                usedMargin: result.used_margin_executed
              });
              
              logger.info('Copy follower margin updated after local cancel', {
                copiedOrderId: copiedOrder.order_id,
                user_id: copiedOrder.order_user_id,
                used_margin: result.used_margin_executed
              });
            } catch (marginError) {
              logger.error('Failed to update copy follower margin after cancel', {
                copiedOrderId: copiedOrder.order_id,
                user_id: copiedOrder.order_user_id,
                error: marginError.message
              });
            }
          }
          
        } catch (dbError) {
          logger.error('Failed to update copy follower order in database after cancel', {
            copiedOrderId: copiedOrder.order_id,
            error: dbError.message
          });
        }
      }

    } catch (error) {
      logger.error('Failed to cancel follower order', {
        copiedOrderId: copiedOrder.order_id,
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * DEPRECATED: Set stop loss and take profit for follower order after execution
   * Individual order SL/TP removed - copy followers use account-level equity thresholds only
   * @param {Object} followerOrder - Follower order
   * @param {Object} follower - Follower account
   * @deprecated Use account-level equity monitoring instead
   */
  async setFollowerOrderSlTp(followerOrder, follower) {
    logger.warn('DEPRECATED: setFollowerOrderSlTp called. Individual order SL/TP removed for copy followers.', {
      followerOrderId: followerOrder.order_id,
      followerId: follower.id
    });
    return { success: false, error: 'Individual order SL/TP not supported for copy followers' };
  }


  /**
   * Place follower pending order through Python service
   * @param {Object} followerOrder - Follower order
   * @param {Object} follower - Follower account
   * @returns {Object} Placement result
   */
  async placeFollowerOrder(followerOrder, follower) {
    try {
      // Determine effective flow (inherit from strategy provider)
      let isProviderFlow = false;
      let strategySo = null;
      let followerSo = null;
      
      try {
        // Get strategy provider's flow from master order
        const strategyProviderConfig = await redisCluster.hgetall(`user:{strategy_provider:${followerOrder.strategy_provider_id}}:config`);
        strategySo = (strategyProviderConfig && strategyProviderConfig.sending_orders) ? 
          String(strategyProviderConfig.sending_orders).trim().toLowerCase() : null;
        
        // Get follower's own config as fallback
        const followerConfig = await redisCluster.hgetall(`user:{copy_follower:${follower.id}}:config`);
        followerSo = (followerConfig && followerConfig.sending_orders) ? 
          String(followerConfig.sending_orders).trim().toLowerCase() : null;
        
        // Inherit from strategy provider, fallback to follower's own setting
        const effectiveSo = strategySo || followerSo;
        isProviderFlow = (effectiveSo === 'barclays');
        
        logger.info('Copy follower placement flow inheritance', {
          followerOrderId: followerOrder.order_id,
          strategyProviderId: followerOrder.strategy_provider_id,
          strategyProviderSendingOrders: strategySo,
          followerSendingOrders: followerSo,
          effectiveSendingOrders: effectiveSo,
          isProviderFlow
        });
      } catch (e) {
        logger.warn('Failed to determine follower flow, defaulting to local', { error: e.message });
        isProviderFlow = false;
      }

      try {
        const followerConfigKey = `user:{copy_follower:${follower.id}}:config`;
        const followerConfig = await redisCluster.hgetall(followerConfigKey);
        const followerPortfolioKey = `user_portfolio:{copy_follower:${follower.id}}`;
        const followerPortfolio = await redisCluster.hgetall(followerPortfolioKey);

        logger.info('Copy follower pending placement margin context', {
          followerOrderId: followerOrder.order_id,
          followerId: follower.id,
          strategyProviderId: followerOrder.strategy_provider_id,
          flow: isProviderFlow ? 'provider' : 'local',
          followerConfigKey,
          followerConfigWalletBalance: followerConfig && followerConfig.wallet_balance,
          followerConfigBalance: followerConfig && followerConfig.balance,
          followerConfigLeverage: followerConfig && followerConfig.leverage,
          followerConfigGroup: followerConfig && followerConfig.group,
          followerConfigSendingOrders: followerConfig && followerConfig.sending_orders,
          followerPortfolioKey,
          followerPortfolioUsedMarginAll: followerPortfolio && followerPortfolio.used_margin_all,
          followerPortfolioEquity: followerPortfolio && followerPortfolio.equity,
          followerPortfolioRaw: followerPortfolio
        });
      } catch (debugErr) {
        logger.warn('Failed to log copy follower pending placement margin context', {
          followerOrderId: followerOrder.order_id,
          followerId: follower.id,
          error: debugErr.message
        });
      }

      if (isProviderFlow) {
        // PROVIDER FLOW: Send to Python service
        const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
        
        const payload = {
          order_id: followerOrder.order_id,
          user_id: follower.id.toString(),
          user_type: 'copy_follower',
          symbol: followerOrder.symbol,
          order_type: followerOrder.order_type,
          order_price: followerOrder.order_price,
          order_quantity: followerOrder.order_quantity,
          stop_loss: followerOrder.stop_loss || null,
          take_profit: followerOrder.take_profit || null,
          group: follower.group || 'Standard'
        };

        logger.info('Placing follower pending order through Python service (provider flow)', {
          followerOrderId: followerOrder.order_id,
          followerId: follower.id,
          payload
        });

        const response = await pythonServiceAxios.post(
          `${baseUrl}/api/orders/pending/place`,
          payload
        );

        return {
          success: true,
          data: response.data,
          flow: 'provider'
        };

      } else {
        // LOCAL FLOW: Store directly in Redis (same as strategy provider)
        logger.info('Placing follower pending order locally (local flow)', {
          followerOrderId: followerOrder.order_id,
          followerId: follower.id,
          symbol: followerOrder.symbol,
          order_type: followerOrder.order_type
        });

        const symbol = followerOrder.symbol;
        const orderType = followerOrder.order_type;
        const order_id = followerOrder.order_id;
        const user_id = follower.id.toString();
        
        // Calculate compare price using same logic as strategy provider
        // Pending monitoring is ask-based for all types: store compare = user_price - half_spread
        // Get half_spread for this follower's group
        let half_spread = 0;
        try {
          const followerGroup = follower.group || 'Standard';
          const groupConfig = await redisCluster.hgetall(`group_config:${followerGroup}`);
          half_spread = parseFloat(groupConfig.half_spread || 0);
        } catch (e) {
          logger.warn('Failed to get half_spread for follower group, using 0', {
            followerId: follower.id,
            group: follower.group,
            error: e.message
          });
          half_spread = 0;
        }
        
        const compare_price = Number((parseFloat(followerOrder.order_price) - half_spread).toFixed(8));
        
        // Validate compare_price (same validation as strategy provider)
        if (!(compare_price > 0)) {
          throw new Error(`Invalid compare_price for follower order: ${compare_price} (order_price: ${followerOrder.order_price}, half_spread: ${half_spread})`);
        }

        // Store pending order in Redis for monitoring (same as strategy provider)
        const zkey = `pending_index:{${symbol}}:${orderType}`;
        const hkey = `pending_orders:${order_id}`;
        
        await redisCluster.zadd(zkey, compare_price, order_id);
        await redisCluster.hset(hkey, {
          symbol: symbol,
          order_type: orderType,
          user_type: 'copy_follower',
          user_id: user_id,
          order_price_user: String(followerOrder.order_price),
          order_price_compare: String(compare_price),
          order_quantity: String(followerOrder.order_quantity),
          status: 'PENDING',
          created_at: Date.now().toString(),
          group: follower.group || 'Standard',
        });
        
        // Ensure symbol is tracked for periodic scanning by the worker
        await redisCluster.sadd('pending_active_symbols', symbol);

        // Also store in user holdings and index (same as strategy provider)
        const tag = `copy_follower:${user_id}`;
        const userIdx = `user_orders_index:{${tag}}`;
        const userHolding = `user_holdings:{${tag}}:${order_id}`;
        const orderData = `order_data:${order_id}`;
        
        // Split operations to avoid Redis cluster cross-slot issues
        // First: user-specific operations (same slot due to same hash tag pattern)
        const userPipe = redisCluster.pipeline();
        userPipe.sadd(userIdx, order_id);
        userPipe.hset(userHolding, {
          order_id: String(order_id),
          symbol: symbol,
          order_type: orderType,
          order_status: 'PENDING',
          status: 'PENDING',
          execution_status: 'QUEUED',
          order_price: String(followerOrder.order_price),
          order_quantity: String(followerOrder.order_quantity),
          group: follower.group || 'Standard',
          created_at: Date.now().toString(),
        });
        await userPipe.exec();

        // Second: order_data operation (separate to avoid cross-slot issues)
        await redisCluster.hset(orderData, {
          order_id: String(order_id),
          user_type: 'copy_follower',
          user_id: user_id,
          symbol: symbol,
          order_type: orderType,
          order_status: 'PENDING',
          status: 'PENDING',
          execution_status: 'QUEUED',
          order_price: String(followerOrder.order_price),
          order_quantity: String(followerOrder.order_quantity),
          group: follower.group || 'Standard',
          created_at: Date.now().toString(),
        });

        logger.info('Copy follower pending order stored locally', {
          followerOrderId: order_id,
          followerId: follower.id,
          symbol,
          orderType,
          orderPrice: followerOrder.order_price,
          halfSpread: half_spread,
          comparePrice: compare_price,
          zkey,
          hkey
        });

        return {
          success: true,
          data: { flow: 'local' },
          flow: 'local'
        };
      }

    } catch (error) {
      logger.error('Failed to place follower pending order', {
        followerOrderId: followerOrder.order_id,
        followerId: follower.id,
        error: error.message,
        stack: error.stack
      });

      return {
        success: false,
        error: error.message,
        flow: 'local'
      };
    }
  }

  /**
   * Update follower order after pending placement
   * @param {Object} followerOrder - Follower order
   * @param {Object} placementResult - Placement result
   */
  async updateFollowerOrderAfterPlacement(followerOrder, placementResult) {
    try {
      const updateFields = {
        copy_timestamp: new Date()
      };

      if (placementResult.success) {
        updateFields.copy_status = 'copied';
        updateFields.order_status = 'PENDING';
      } else {
        updateFields.copy_status = 'failed';
        updateFields.order_status = 'REJECTED';
        updateFields.failure_reason = placementResult.error;
      }

      await CopyFollowerOrder.update(updateFields, {
        where: { id: followerOrder.id }
      });

    } catch (error) {
      logger.error('Failed to update follower order after pending placement', {
        followerOrderId: followerOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Create skipped pending order record for audit trail
   * @param {Object} masterOrder - Master pending order
   * @param {Object} follower - Follower account
   * @param {string} reason - Skip reason
   * @param {Object} lotCalculation - Lot calculation details
   */
  async createSkippedPendingOrder(masterOrder, follower, reason, lotCalculation) {
    try {
      const followerOrderId = await idGenerator.generateOrderId();

      await CopyFollowerOrder.create({
        order_id: followerOrderId,
        order_user_id: follower.id,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_status: 'SKIPPED',
        order_price: masterOrder.order_price,
        order_quantity: lotCalculation.calculatedLotSize,
        
        // Copy trading specific fields
        master_order_id: masterOrder.order_id,
        strategy_provider_id: masterOrder.order_user_id,
        copy_follower_account_id: follower.id,
        
        // Lot calculation audit trail
        master_lot_size: masterOrder.order_quantity,
        follower_investment_at_copy: follower.investment_amount,
        master_equity_at_copy: lotCalculation.masterEquity,
        lot_ratio: lotCalculation.ratio,
        calculated_lot_size: lotCalculation.calculatedLotSize,
        final_lot_size: lotCalculation.finalLotSize,
        
        copy_status: 'failed',
        failure_reason: `Skipped: ${reason}`,
        
        status: 'SKIPPED',
        placed_by: 'copy_trading'
      });

      // Update follower account skipped count
      await CopyFollowerAccount.increment('failed_copies', {
        where: { id: follower.id }
      });

    } catch (error) {
      logger.error('Failed to create skipped pending order record', {
        masterOrderId: masterOrder.order_id,
        followerId: follower.id,
        error: error.message
      });
    }
  }

  /**
   * Process order closure/modification for copy trading
   * @param {Object} masterOrder - Updated master order
   */
  async processStrategyProviderOrderUpdate(masterOrder) {
    try {
      // Get all follower orders for this master order (including failed/pending copies)
      const copiedOrders = await CopyFollowerOrder.findAll({
        where: {
          master_order_id: masterOrder.order_id,
          copy_status: ['copied', 'pending', 'failed'], // Include all statuses that need cancellation
          order_status: ['OPEN', 'PENDING', 'PENDING-QUEUED', 'REJECTED'] // Include rejected orders too
        }
      });

      logger.info('Found follower orders for master order update', {
        masterOrderId: masterOrder.order_id,
        masterOrderStatus: masterOrder.order_status,
        followerOrderCount: copiedOrders.length,
        followerOrders: copiedOrders.map(o => ({
          order_id: o.order_id,
          copy_status: o.copy_status,
          order_status: o.order_status
        }))
      });

      if (copiedOrders.length === 0) {
        logger.warn('No follower orders found for master order update', {
          masterOrderId: masterOrder.order_id,
          masterOrderStatus: masterOrder.order_status
        });
        return;
      }

      // Process each copied order based on master order status
      for (const copiedOrder of copiedOrders) {
        if (masterOrder.order_status === 'CLOSED') {
          await this.closeFollowerOrder(copiedOrder, masterOrder);
        } else if (masterOrder.order_status === 'CANCELLED') {
          await this.cancelFollowerOrder(copiedOrder, masterOrder);
        }
      }

    } catch (error) {
      logger.error('Failed to process strategy provider order update', {
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Cancel follower order when master order is cancelled
   * @param {Object} copiedOrder - Copied order
   * @param {Object} masterOrder - Master order
   */
  async cancelFollowerOrder(copiedOrder, masterOrder) {
    try {
      const symbol = copiedOrder.symbol;
      const order_type = copiedOrder.order_type;
      const user_id = copiedOrder.order_user_id.toString();
      const user_type = 'copy_follower';
      const order_id = copiedOrder.order_id;

      logger.info('Cancelling follower order', {
        followerOrderId: order_id,
        masterOrderId: masterOrder.order_id,
        copyStatus: copiedOrder.copy_status,
        orderStatus: copiedOrder.order_status
      });

      // If the order failed to place or is still pending placement, just update DB
      if (['failed', 'pending'].includes(copiedOrder.copy_status) || ['REJECTED', 'SKIPPED'].includes(copiedOrder.order_status)) {
        logger.info('Follower order was not successfully placed, updating DB only', {
          followerOrderId: order_id,
          copyStatus: copiedOrder.copy_status,
          orderStatus: copiedOrder.order_status
        });

        // Update copy follower order in DB
        await CopyFollowerOrder.update({
          order_status: 'CANCELLED',
          copy_status: 'cancelled',
          close_message: 'Master order cancelled'
        }, {
          where: { order_id }
        });

        // Emit WebSocket update
        try {
          portfolioEvents.emitUserUpdate(user_type, user_id, {
            type: 'order_update',
            order_id,
            update: { order_status: 'CANCELLED' },
            reason: 'master_order_cancelled'
          });
        } catch (_) {}

        logger.info('Follower order cancelled (DB only)', {
          followerOrderId: order_id,
          masterOrderId: masterOrder.order_id
        });
        return;
      }

      // For successfully placed orders, determine flow type
      // Copy followers should inherit flow from their strategy provider
      let isProviderFlow = false;
      try {
        // First check strategy provider's flow
        const strategyProviderConfig = await redisCluster.hgetall(`user:{strategy_provider:${masterOrder.order_user_id}}:config`);
        const strategySo = (strategyProviderConfig && strategyProviderConfig.sending_orders) ? 
          String(strategyProviderConfig.sending_orders).trim().toLowerCase() : null;
        
        // Check follower's own config as fallback
        const followerConfig = await redisCluster.hgetall(`user:{copy_follower:${copiedOrder.order_user_id}}:config`);
        const followerSo = (followerConfig && followerConfig.sending_orders) ? 
          String(followerConfig.sending_orders).trim().toLowerCase() : null;
        
        // Inherit from strategy provider, fallback to follower's own setting
        const effectiveSo = strategySo || followerSo;
        isProviderFlow = (effectiveSo === 'barclays');
        
        logger.info('Copy follower flow detection', {
          copyFollowerId: copiedOrder.order_user_id,
          strategyProviderId: masterOrder.order_user_id,
          strategyProviderSendingOrders: strategySo,
          followerSendingOrders: followerSo,
          effectiveSendingOrders: effectiveSo,
          isProviderFlow,
          followerOrderId: order_id,
          masterOrderId: masterOrder.order_id
        });
      } catch (_) { 
        isProviderFlow = false; 
      }

      if (!isProviderFlow) {
        // LOCAL FLOW: Remove from Redis directly and update DB
        try {
          // Remove from pending monitoring if it's a pending order
          if (['PENDING', 'PENDING-QUEUED'].includes(copiedOrder.order_status)) {
            await redisCluster.zrem(`pending_index:{${symbol}}:${order_type}`, order_id);
            await redisCluster.del(`pending_orders:${order_id}`);
          }
        } catch (e) { 
          logger.warn('Failed to remove from pending ZSET/HASH for follower', { error: e.message, order_id }); 
        }

        try {
          const tag = `${user_type}:${user_id}`;
          const idx = `user_orders_index:{${tag}}`;
          const h = `user_holdings:{${tag}}:${order_id}`;
          
          // Use pipeline for same-slot keys
          const p1 = redisCluster.pipeline();
          p1.srem(idx, order_id);
          p1.del(h);
          await p1.exec();
          
          // Delete canonical separately
          try { 
            await redisCluster.del(`order_data:${order_id}`); 
          } catch (eDel) {
            logger.warn('Failed to delete order_data for follower pending cancel', { error: eDel.message, order_id });
          }
        } catch (e2) { 
          logger.warn('Failed to remove holdings/index for follower pending cancel', { error: e2.message, order_id }); 
        }

        // Update copy follower order in DB
        await CopyFollowerOrder.update({
          order_status: 'CANCELLED',
          copy_status: 'cancelled',
          close_message: 'Master order cancelled'
        }, {
          where: { order_id }
        });

        // Emit WebSocket update
        try {
          portfolioEvents.emitUserUpdate(user_type, user_id, {
            type: 'order_update',
            order_id,
            update: { order_status: 'CANCELLED' },
            reason: 'master_order_cancelled'
          });
          portfolioEvents.emitUserUpdate(user_type, user_id, {
            type: 'pending_cancelled',
            order_id,
            reason: 'master_order_cancelled'
          });
        } catch (_) {}

        logger.info('Copy follower order cancelled (local flow)', {
          copiedOrderId: order_id,
          masterOrderId: masterOrder.order_id
        });

      } else {
        // PROVIDER FLOW: Generate cancel_id and send to Python service
        let cancel_id = null;
        try { 
          cancel_id = await idGenerator.generateCancelOrderId(); 
        } catch (e) { 
          logger.warn('Failed to generate cancel_id for follower', { error: e.message, order_id }); 
        }
        
        if (!cancel_id) {
          logger.error('Failed to generate cancel_id for follower order', { order_id });
          return;
        }

        // Update order with cancel_id
        await CopyFollowerOrder.update({
          cancel_id,
          order_status: 'PENDING-CANCEL',
          copy_status: 'pending'
        }, {
          where: { order_id }
        });

        // Update Redis with cancel_id
        try {
          const tag = `${user_type}:${user_id}`;
          const h = `user_holdings:{${tag}}:${order_id}`;
          const od = `order_data:${order_id}`;
          
          // Store cancel_id in Redis
          try { 
            await redisCluster.hset(h, 'cancel_id', String(cancel_id)); 
          } catch (e1) { 
            logger.warn('HSET cancel_id failed on user_holdings for follower', { error: e1.message, order_id }); 
          }
          try { 
            await redisCluster.hset(od, 'cancel_id', String(cancel_id)); 
          } catch (e2) { 
            logger.warn('HSET cancel_id failed on order_data for follower', { error: e2.message, order_id }); 
          }
          try { 
            await redisCluster.hset(h, 'status', 'PENDING-CANCEL'); 
          } catch (e3) { 
            logger.warn('HSET status failed on user_holdings for follower', { error: e3.message, order_id }); 
          }
          try { 
            await redisCluster.hset(od, 'status', 'PENDING-CANCEL'); 
          } catch (e4) { 
            logger.warn('HSET status failed on order_data for follower', { error: e4.message, order_id }); 
          }
        } catch (e) { 
          logger.warn('Failed to mirror cancel status in Redis for follower', { error: e.message, order_id }); 
        }

        // Register cancel_id with lifecycle service
        try {
          const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
          pythonServiceAxios.post(
            `${baseUrl}/api/orders/registry/lifecycle-id`,
            { order_id, new_id: cancel_id, id_type: 'cancel_id' }
          ).catch(() => {});
        } catch (_) {}

        // Send cancel request to Python service
        try {
          const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
          const pyPayload = { 
            order_id, 
            cancel_id, 
            order_type, 
            user_id, 
            user_type, 
            status: 'CANCELLED',
            symbol 
          };
          
          pythonServiceAxios.post(
            `${baseUrl}/api/orders/pending/cancel`,
            pyPayload
          ).then(() => {
            logger.info('Dispatched provider pending cancel for copy follower', { order_id, cancel_id, order_type });
          }).catch((ePy) => { 
            logger.error('Python pending cancel failed for copy follower', { error: ePy.message, order_id }); 
          });
        } catch (_) {}

        logger.info('Copy follower order cancel submitted (provider flow)', {
          copiedOrderId: order_id,
          masterOrderId: masterOrder.order_id,
          cancel_id
        });
      }

    } catch (error) {
      logger.error('Failed to cancel follower order', {
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate close price for copy follower order
   * @param {Object} copyOrder - Copy follower order
   * @param {Object} masterOrder - Closed strategy provider order
   * @returns {number} Close price for copy follower
   */
  calculateCopyFollowerClosePrice(copyOrder, masterOrder) {
    // For now, use the same close price as master order
    // In the future, this could be adjusted for spread differences
    return parseFloat(masterOrder.close_price);
  }

  /**
   * Remove SL/TP triggers for closed order
   * @param {string} orderId - Order ID
   */
  async removeSlTpTriggersForOrder(orderId) {
    try {
      const redisCluster = require('../config/redis');

      // Remove stop loss trigger
      const slTriggerKey = `stoploss_trigger:${orderId}`;
      await redisCluster.del(slTriggerKey);
      await redisCluster.srem('active_stoploss_triggers', orderId);

      // Remove take profit trigger
      const tpTriggerKey = `takeprofit_trigger:${orderId}`;
      await redisCluster.del(tpTriggerKey);
      await redisCluster.srem('active_takeprofit_triggers', orderId);

      logger.info('Removed SL/TP triggers for closed order', {
        orderId,
        slTriggerKey,
        tpTriggerKey
      });

    } catch (error) {
      logger.error('Failed to remove SL/TP triggers for order', {
        orderId,
        error: error.message
      });
    }
  }

  /**
   * Handle strategy provider manual order closure and replicate to copy followers
   * @param {Object} masterOrder - Strategy provider order that was closed
   */
  async handleStrategyProviderOrderClosure(masterOrder) {
    try {
      logger.info('Processing strategy provider order closure for copy trading', {
        orderId: masterOrder.order_id,
        strategyProviderId: masterOrder.order_user_id,
        symbol: masterOrder.symbol,
        closePrice: masterOrder.close_price
      });

      // Get all copy follower orders for this master order
      const copyFollowerOrders = await CopyFollowerOrder.findAll({
        where: {
          master_order_id: masterOrder.order_id,
          order_status: ['OPEN', 'PENDING'] // Only close orders that are still open
        }
      });

      if (copyFollowerOrders.length === 0) {
        logger.info('No open copy follower orders found for closed strategy provider order', {
          masterOrderId: masterOrder.order_id
        });
        return;
      }

      logger.info('Found copy follower orders to close', {
        masterOrderId: masterOrder.order_id,
        copyOrdersCount: copyFollowerOrders.length,
        copyOrderIds: copyFollowerOrders.map(o => o.order_id)
      });

      // Process each copy follower order closure
      const closureResults = await Promise.allSettled(
        copyFollowerOrders.map(copyOrder => this.closeCopyFollowerOrder(copyOrder, masterOrder))
      );

      // Count successful and failed closures
      const successful = closureResults.filter(result => result.status === 'fulfilled').length;
      const failed = closureResults.filter(result => result.status === 'rejected').length;

      logger.info('Copy follower order closures completed', {
        masterOrderId: masterOrder.order_id,
        totalCopyOrders: copyFollowerOrders.length,
        successful,
        failed
      });

    } catch (error) {
      logger.error('Failed to handle strategy provider order closure', {
        masterOrderId: masterOrder?.order_id,
        error: error.message
      });
    }
  }

  /**
   * Close individual copy follower order when master order is closed
   * @param {Object} copyOrder - Copy follower order to close
   * @param {Object} masterOrder - Closed strategy provider order
   */
  async closeCopyFollowerOrder(copyOrder, masterOrder) {
    try {
      // Check if order is already closed to prevent duplicate closure
      const isAlreadyClosed = await CopyFollowerSlTpService.isOrderClosed(copyOrder.order_id);
      if (isAlreadyClosed) {
        logger.info('Copy follower order already closed, skipping', {
          copyOrderId: copyOrder.order_id,
          masterOrderId: masterOrder.order_id
        });
        return { success: true, reason: 'Already closed' };
      }

      logger.info('Closing copy follower order due to master order closure', {
        copyOrderId: copyOrder.order_id,
        masterOrderId: masterOrder.order_id,
        symbol: copyOrder.symbol,
        orderType: copyOrder.order_type
      });

      // Get copy follower account details
      const followerAccount = await CopyFollowerAccount.findByPk(copyOrder.copy_follower_account_id);
      if (!followerAccount) {
        throw new Error('Copy follower account not found');
      }

      // Calculate close price for copy follower (may need spread adjustment)
      const closePrice = this.calculateCopyFollowerClosePrice(copyOrder, masterOrder);

      // Close the order through order service
      const orderService = require('./order.service');
      const closeRequest = {
        order_id: copyOrder.order_id,
        close_price: closePrice,
        user_type: 'copy_follower',
        user_id: copyOrder.order_user_id,
        close_reason: 'strategy_provider_closure'
      };

      const closeResult = await orderService.closeOrder(closeRequest);

      if (closeResult.success) {
        logger.info('Copy follower order closed successfully', {
          copyOrderId: copyOrder.order_id,
          masterOrderId: masterOrder.order_id,
          closePrice,
          closeResult
        });

        // Remove any active SL/TP triggers for this order
        await this.removeSlTpTriggersForOrder(copyOrder.order_id);

      } else {
        logger.error('Failed to close copy follower order', {
          copyOrderId: copyOrder.order_id,
          masterOrderId: masterOrder.order_id,
          error: closeResult.error
        });
      }

      return closeResult;

    } catch (error) {
      logger.error('Error closing copy follower order', {
        copyOrderId: copyOrder.order_id,
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }
}

module.exports = new CopyTradingService();
