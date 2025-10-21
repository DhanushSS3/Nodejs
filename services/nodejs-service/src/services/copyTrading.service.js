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
const { redisCluster } = require('../../config/redis');
const axios = require('axios');

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
        placed_by: order.placed_by || userType
      });

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

      // Apply follower's SL/TP modifications
      const modifiedOrder = await this.applyFollowerSlTpSettings(masterOrder, follower);

      // Generate follower order ID
      const followerOrderId = await idGenerator.generateOrderId();

      // Create follower order record
      const followerOrder = await CopyFollowerOrder.create({
        order_id: followerOrderId,
        order_user_id: follower.id,
        symbol: masterOrder.symbol,
        order_type: masterOrder.order_type,
        order_status: 'QUEUED',
        order_price: masterOrder.order_price,
        order_quantity: lotCalculation.finalLotSize,
        stop_loss: null, // Set after successful execution
        take_profit: null, // Set after successful execution
        
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
        modified_by_follower: modifiedOrder.modified,
        sl_modification_type: modifiedOrder.slModType,
        tp_modification_type: modifiedOrder.tpModType,
        
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

      // Update copy follower margin for local execution (like regular users)
      if (executionResult.success && executionResult.data?.flow === 'local' && typeof executionResult.data.used_margin_executed === 'number') {
        try {
          await updateUserUsedMargin({
            userType: 'copy_follower',
            userId: parseInt(follower.id),
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
      // Get strategy provider equity (calculated from wallet_balance + net_profit)
      const strategyProvider = await StrategyProviderAccount.findByPk(masterOrder.order_user_id);
      const masterEquity = parseFloat(strategyProvider.wallet_balance || 0) + parseFloat(strategyProvider.net_profit || 0);
      
      // Get follower investment amount (their equity in copy trading)
      const followerInvestment = parseFloat(follower.investment_amount || 0);
      
      logger.info('Lot size calculation data', {
        strategyProviderId: masterOrder.order_user_id,
        strategyProvider: {
          id: strategyProvider.id,
          wallet_balance: strategyProvider.wallet_balance,
          net_profit: strategyProvider.net_profit,
          calculatedEquity: masterEquity
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
        throw new Error(`Master equity is zero or negative: wallet_balance=${strategyProvider.wallet_balance}, net_profit=${strategyProvider.net_profit}, calculated=${masterEquity}`);
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
      
      // Ensure calculated lot meets minimum requirements
      const finalLotSize = Math.max(calculatedLotSize, groupConstraints.minLot);
      
      // Ensure doesn't exceed maximum
      const constrainedLotSize = Math.min(finalLotSize, groupConstraints.maxLot);

      return {
        masterEquity,
        followerInvestment,
        ratio,
        masterLotSize,
        calculatedLotSize,
        finalLotSize: constrainedLotSize,
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
   * Apply follower's SL/TP settings to master order
   * @param {Object} masterOrder - Master order
   * @param {Object} follower - Follower account
   * @returns {Object} Modified order with SL/TP
   */
  async applyFollowerSlTpSettings(masterOrder, follower) {
    try {
      let stopLoss = masterOrder.stop_loss;
      let takeProfit = masterOrder.take_profit;
      let modified = false;
      let slModType = 'none';
      let tpModType = 'none';

      const orderPrice = parseFloat(masterOrder.order_price);
      const isBuy = masterOrder.order_type.toUpperCase().includes('BUY');

      // Apply follower's stop loss settings
      if (follower.copy_sl_mode && follower.copy_sl_mode !== 'none') {
        if (follower.copy_sl_mode === 'percentage' && follower.sl_percentage) {
          const slPercentage = parseFloat(follower.sl_percentage) / 100;
          if (isBuy) {
            stopLoss = orderPrice * (1 - slPercentage);
          } else {
            stopLoss = orderPrice * (1 + slPercentage);
          }
          modified = true;
          slModType = 'percentage';
        } else if (follower.copy_sl_mode === 'amount' && follower.sl_amount) {
          const slAmount = parseFloat(follower.sl_amount);
          if (isBuy) {
            stopLoss = orderPrice - slAmount;
          } else {
            stopLoss = orderPrice + slAmount;
          }
          modified = true;
          slModType = 'amount';
        }
      }

      // Apply follower's take profit settings
      if (follower.copy_tp_mode && follower.copy_tp_mode !== 'none') {
        if (follower.copy_tp_mode === 'percentage' && follower.tp_percentage) {
          const tpPercentage = parseFloat(follower.tp_percentage) / 100;
          if (isBuy) {
            takeProfit = orderPrice * (1 + tpPercentage);
          } else {
            takeProfit = orderPrice * (1 - tpPercentage);
          }
          modified = true;
          tpModType = 'percentage';
        } else if (follower.copy_tp_mode === 'amount' && follower.tp_amount) {
          const tpAmount = parseFloat(follower.tp_amount);
          if (isBuy) {
            takeProfit = orderPrice + tpAmount;
          } else {
            takeProfit = orderPrice - tpAmount;
          }
          modified = true;
          tpModType = 'amount';
        }
      }

      return {
        stopLoss,
        takeProfit,
        modified,
        slModType,
        tpModType
      };

    } catch (error) {
      logger.error('Failed to apply follower SL/TP settings', {
        masterOrderId: masterOrder.order_id,
        followerId: follower.id,
        error: error.message
      });
      
      // Return original values on error
      return {
        stopLoss: masterOrder.stop_loss,
        takeProfit: masterOrder.take_profit,
        modified: false,
        slModType: 'none',
        tpModType: 'none'
      };
    }
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

      // Set stop loss and take profit after successful order execution
      // Get the original SL/TP values from the master order
      const masterOrderData = await StrategyProviderOrder.findOne({ where: { order_id: followerOrder.master_order_id } });
      if (masterOrderData && (masterOrderData.stop_loss || masterOrderData.take_profit)) {
        try {
          // Apply follower's SL/TP modifications
          const modifiedOrder = await this.applyFollowerSlTpSettings(masterOrderData, follower);
          
          // Update the database record with SL/TP values
          await CopyFollowerOrder.update({
            stop_loss: modifiedOrder.stopLoss,
            take_profit: modifiedOrder.takeProfit,
            original_stop_loss: masterOrderData.stop_loss,
            original_take_profit: masterOrderData.take_profit,
            modified_by_follower: modifiedOrder.modified,
            sl_modification_type: modifiedOrder.slModType,
            tp_modification_type: modifiedOrder.tpModType
          }, {
            where: { order_id: followerOrder.order_id }
          });
          
          // Set SL/TP via Python service
          await this.setFollowerOrderSlTp({
            ...followerOrder.dataValues,
            stop_loss: modifiedOrder.stopLoss,
            take_profit: modifiedOrder.takeProfit
          }, follower);
        } catch (slTpError) {
          logger.warn('Failed to set SL/TP for follower order after execution', {
            followerOrderId: followerOrder.order_id,
            followerId: follower.id,
            error: slTpError.message
          });
          // Don't fail the main order execution for SL/TP issues
        }
      }

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
        updateFields.order_status = 'OPEN';
        updateFields.order_price = executionResult.executionPrice;
        updateFields.margin = executionResult.margin;
        updateFields.contract_value = executionResult.contractValue;
        updateFields.commission = executionResult.commission;
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
        
        copy_status: 'skipped',
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
   * Process order closure/modification for copy trading
   * @param {Object} masterOrder - Updated master order
   */
  async processStrategyProviderOrderUpdate(masterOrder) {
    try {
      // Get all copied orders for this master order
      const copiedOrders = await CopyFollowerOrder.findAll({
        where: {
          master_order_id: masterOrder.order_id,
          copy_status: 'copied',
          order_status: 'OPEN'
        }
      });

      if (copiedOrders.length === 0) {
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
   * Close follower order when master order is closed
   * @param {Object} copiedOrder - Copied order
   * @param {Object} masterOrder - Master order
   */
  async closeFollowerOrder(copiedOrder, masterOrder) {
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      
      const payload = {
        order_id: copiedOrder.order_id,
        user_id: copiedOrder.order_user_id,
        user_type: 'copy_follower', // Use copy_follower user type
        close_price: masterOrder.close_price,
        copy_trading: true
      };

      await axios.post(
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
        order_id: copiedOrder.order_id,
        user_id: copiedOrder.order_user_id,
        user_type: 'copy_follower', // Use copy_follower user type
        copy_trading: true
      };

      await axios.post(
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

    } catch (error) {
      logger.error('Failed to cancel follower order', {
        copiedOrderId: copiedOrder.order_id,
        masterOrderId: masterOrder.order_id,
        error: error.message
      });
    }
  }

  /**
   * Set stop loss and take profit for follower order after execution
   * @param {Object} followerOrder - Follower order
   * @param {Object} follower - Follower account
   */
  async setFollowerOrderSlTp(followerOrder, follower) {
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    try {
      // Set stop loss if provided
      if (followerOrder.stop_loss) {
        const slPayload = {
          order_id: followerOrder.order_id,
          user_id: follower.id.toString(),
          user_type: 'copy_follower',
          symbol: followerOrder.symbol,
          order_type: followerOrder.order_type,
          stop_loss: parseFloat(followerOrder.stop_loss),
          order_quantity: followerOrder.order_quantity,
          order_status: 'OPEN',
          status: 'OPEN'
        };

        await axios.post(
          `${baseUrl}/api/orders/stoploss/set`,
          slPayload,
          {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || 'livefxhub'
            }
          }
        );

        logger.info('Set stop loss for follower order', {
          followerOrderId: followerOrder.order_id,
          stopLoss: followerOrder.stop_loss
        });
      }

      // Set take profit if provided
      if (followerOrder.take_profit) {
        const tpPayload = {
          order_id: followerOrder.order_id,
          user_id: follower.id.toString(),
          user_type: 'copy_follower',
          symbol: followerOrder.symbol,
          order_type: followerOrder.order_type,
          take_profit: parseFloat(followerOrder.take_profit),
          order_quantity: followerOrder.order_quantity,
          order_status: 'OPEN',
          status: 'OPEN'
        };

        await axios.post(
          `${baseUrl}/api/orders/takeprofit/set`,
          tpPayload,
          {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || 'livefxhub'
            }
          }
        );

        logger.info('Set take profit for follower order', {
          followerOrderId: followerOrder.order_id,
          takeProfit: followerOrder.take_profit
        });
      }

    } catch (error) {
      logger.error('Failed to set SL/TP for follower order', {
        followerOrderId: followerOrder.order_id,
        followerId: follower.id,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new CopyTradingService();
