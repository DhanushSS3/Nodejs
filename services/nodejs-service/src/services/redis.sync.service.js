const { redisCluster } = require('../../config/redis');
const redisUserCacheService = require('./redis.user.cache.service');
const logger = require('./logger.service');

/**
 * Redis Sync Service
 * Ensures Redis cache consistency after admin operations
 * Handles wallet balance updates, user config sync, and portfolio updates
 */
class RedisSyncService {

  /**
   * Sync user data to Redis after balance changes
   * This ensures all Redis keys are consistent with database changes
   * 
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {Object} updatedFields - Fields that were updated in database
   * @param {Object} options - Additional options
   */
  async syncUserAfterBalanceChange(userId, userType, updatedFields, options = {}) {
    const operationId = `redis_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      logger.info(`[${operationId}] Starting Redis sync for ${userType} user ${userId}`, {
        updatedFields,
        options
      });

      // 1. Update primary user config cache (used by Python services)
      await this._updateUserConfigCache(userId, userType, updatedFields, operationId);

      // 2. Update balance-specific caches
      if (updatedFields.wallet_balance !== undefined) {
        await this._updateBalanceCaches(userId, userType, updatedFields.wallet_balance, operationId);
      }

      // 3. Update user cache service (comprehensive user data)
      await this._updateUserCacheService(userId, userType, updatedFields, operationId);

      // 4. Publish user update event for other services
      await this._publishUserUpdateEvent(userId, userType, updatedFields, operationId);

      // 5. Clear any derived caches that depend on balance
      await this._clearDerivedCaches(userId, userType, operationId);

      logger.info(`[${operationId}] Redis sync completed successfully for ${userType} user ${userId}`);

    } catch (error) {
      logger.error(`[${operationId}] Redis sync failed for ${userType} user ${userId}:`, {
        error: error.message,
        stack: error.stack,
        updatedFields
      });
      
      // Don't throw error - Redis sync failures shouldn't break the main operation
      // The database transaction has already been committed
      logger.warn(`[${operationId}] Continuing despite Redis sync failure - database is authoritative`);
    }
  }

  /**
   * Update primary user config cache (critical for Python services)
   * @private
   */
  async _updateUserConfigCache(userId, userType, updatedFields, operationId) {
    try {
      const userConfigKey = `user:{${userType}:${userId}}:config`;
      
      // Prepare fields for Redis hash update
      const redisFields = {};
      
      if (updatedFields.wallet_balance !== undefined) {
        redisFields.wallet_balance = String(updatedFields.wallet_balance);
      }
      
      if (updatedFields.margin !== undefined) {
        redisFields.margin = String(updatedFields.margin);
      }
      
      if (updatedFields.net_profit !== undefined) {
        redisFields.net_profit = String(updatedFields.net_profit);
      }

      // Add timestamp for cache invalidation
      redisFields.last_balance_update = new Date().toISOString();

      if (Object.keys(redisFields).length > 0) {
        await redisCluster.hset(userConfigKey, redisFields);
        logger.info(`[${operationId}] Updated user config cache: ${userConfigKey}`, redisFields);
      }

    } catch (error) {
      logger.error(`[${operationId}] Failed to update user config cache:`, error);
      throw error;
    }
  }

  /**
   * Update balance-specific caches with TTL
   * @private
   */
  async _updateBalanceCaches(userId, userType, newBalance, operationId) {
    try {
      // 1. Short-term balance cache (1 hour TTL)
      const balanceCacheKey = `user_balance:${userType}:${userId}`;
      await redisCluster.setex(balanceCacheKey, 3600, String(newBalance));
      
      // 2. Portfolio balance cache (if exists)
      const portfolioKey = `user:{${userType}:${userId}}:portfolio`;
      const portfolioExists = await redisCluster.exists(portfolioKey);
      
      if (portfolioExists) {
        await redisCluster.hset(portfolioKey, {
          wallet_balance: String(newBalance),
          balance_updated_at: new Date().toISOString()
        });
        logger.info(`[${operationId}] Updated portfolio balance cache: ${portfolioKey}`);
      }

      logger.info(`[${operationId}] Updated balance caches for ${userType} user ${userId}: ${newBalance}`);

    } catch (error) {
      logger.error(`[${operationId}] Failed to update balance caches:`, error);
      throw error;
    }
  }

  /**
   * Update comprehensive user cache service
   * @private
   */
  async _updateUserCacheService(userId, userType, updatedFields, operationId) {
    try {
      // Use the existing user cache service to update comprehensive user data
      await redisUserCacheService.updateUser(userType, userId, updatedFields);
      logger.info(`[${operationId}] Updated user cache service for ${userType} user ${userId}`);

    } catch (error) {
      logger.error(`[${operationId}] Failed to update user cache service:`, error);
      throw error;
    }
  }

  /**
   * Publish user update event for cross-service communication
   * @private
   */
  async _publishUserUpdateEvent(userId, userType, updatedFields, operationId) {
    try {
      const updateEvent = {
        user_id: userId,
        user_type: userType,
        updated_fields: updatedFields,
        event_type: 'balance_change',
        timestamp: new Date().toISOString(),
        source: 'admin_operation'
      };

      // Publish to user updates channel
      await redisCluster.publish('user_updates', JSON.stringify(updateEvent));
      
      // Also publish to balance updates channel for Python services
      await redisCluster.publish('balance_updates', JSON.stringify(updateEvent));

      logger.info(`[${operationId}] Published user update events for ${userType} user ${userId}`);

    } catch (error) {
      logger.error(`[${operationId}] Failed to publish user update events:`, error);
      throw error;
    }
  }

  /**
   * Clear derived caches that depend on user balance
   * @private
   */
  async _clearDerivedCaches(userId, userType, operationId) {
    try {
      const cachesToClear = [
        `user_margin_calc:${userType}:${userId}`,
        `user_stats:${userType}:${userId}`,
        `user_summary:${userType}:${userId}`,
        `financial_summary:${userType}:${userId}:*`
      ];

      for (const cachePattern of cachesToClear) {
        try {
          if (cachePattern.includes('*')) {
            // Handle pattern-based deletion
            await this._clearCachePattern(cachePattern);
          } else {
            // Direct key deletion
            await redisCluster.del(cachePattern);
          }
        } catch (delError) {
          logger.warn(`[${operationId}] Failed to clear cache ${cachePattern}:`, delError.message);
        }
      }

      logger.info(`[${operationId}] Cleared derived caches for ${userType} user ${userId}`);

    } catch (error) {
      logger.error(`[${operationId}] Failed to clear derived caches:`, error);
      // Don't throw - this is non-critical
    }
  }

  /**
   * Clear caches matching a pattern across Redis cluster
   * @private
   */
  async _clearCachePattern(pattern) {
    try {
      const masters = redisCluster.nodes('master');
      
      for (const node of masters) {
        let cursor = '0';
        do {
          const result = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = result[0];
          const keys = result[1] || [];
          
          if (keys.length > 0) {
            await node.del(...keys);
          }
        } while (cursor !== '0');
      }

    } catch (error) {
      logger.warn(`Failed to clear cache pattern ${pattern}:`, error.message);
    }
  }

  /**
   * Sync user data after transaction creation
   * Called after any wallet transaction that affects balance
   */
  async syncAfterTransaction(transaction, operationId = null) {
    const syncId = operationId || `transaction_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      logger.info(`[${syncId}] Syncing Redis after transaction: ${transaction.transaction_id}`);

      const updatedFields = {
        wallet_balance: transaction.balance_after,
        last_transaction_id: transaction.transaction_id,
        last_transaction_at: transaction.created_at
      };

      await this.syncUserAfterBalanceChange(
        transaction.user_id,
        transaction.user_type,
        updatedFields,
        {
          transaction_id: transaction.transaction_id,
          transaction_type: transaction.type,
          amount: transaction.amount
        }
      );

      logger.info(`[${syncId}] Transaction sync completed for ${transaction.transaction_id}`);

    } catch (error) {
      logger.error(`[${syncId}] Transaction sync failed:`, {
        transaction_id: transaction.transaction_id,
        error: error.message
      });
    }
  }

  /**
   * Force refresh user data from database to Redis
   * Use this when Redis data might be stale or corrupted
   */
  async forceRefreshUser(userId, userType) {
    const operationId = `force_refresh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      logger.info(`[${operationId}] Force refreshing ${userType} user ${userId} from database`);

      // Get fresh data from database
      const UserModel = userType === 'live' ? 
        require('../models/liveUser.model') : 
        require('../models/demoUser.model');
      
      const user = await UserModel.findByPk(userId);
      if (!user) {
        throw new Error(`${userType} user ${userId} not found in database`);
      }

      // Extract all relevant fields
      const userFields = {
        wallet_balance: parseFloat(user.wallet_balance) || 0,
        leverage: user.leverage || 0,
        margin: parseFloat(user.margin) || 0,
        net_profit: parseFloat(user.net_profit) || 0,
        account_number: user.account_number,
        group: user.group,
        status: user.status,
        is_active: user.is_active,
        sending_orders: user.sending_orders || 'rock'
      };

      // Sync to Redis
      await this.syncUserAfterBalanceChange(userId, userType, userFields, {
        force_refresh: true
      });

      logger.info(`[${operationId}] Force refresh completed for ${userType} user ${userId}`);
      return userFields;

    } catch (error) {
      logger.error(`[${operationId}] Force refresh failed for ${userType} user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Sync user data to Redis after admin user updates
   * Handles group changes and other user field updates
   * 
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {Object} updatedFields - Fields that were updated by admin
   * @param {Object} options - Additional options
   */
  async syncUserAfterAdminUpdate(userId, userType, updatedFields, options = {}) {
    const operationId = `admin_user_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      logger.info(`[${operationId}] Starting Redis sync after admin user update for ${userType} user ${userId}`, {
        updatedFields: Object.keys(updatedFields),
        options
      });

      // Check if group was changed (critical for future trading operations)
      const groupChanged = updatedFields.hasOwnProperty('group');
      const oldGroup = options.oldGroup;
      const newGroup = updatedFields.group;

      // 1. Update primary user config cache (critical for Python services)
      await this._updateUserConfigAfterAdminUpdate(userId, userType, updatedFields, operationId);

      // 2. Update balance caches if balance-related fields changed
      if (updatedFields.wallet_balance !== undefined) {
        await this._updateBalanceCaches(userId, userType, updatedFields.wallet_balance, operationId);
      }

      // 3. Update comprehensive user cache service
      await this._updateUserCacheService(userId, userType, updatedFields, operationId);

      // 4. Handle group change specially (forward-looking only)
      if (groupChanged) {
        await this._handleGroupChange(userId, userType, oldGroup, newGroup, operationId);
      }

      // 5. Clear future-calculation caches for affected fields
      await this._clearFutureCalculationCaches(userId, userType, updatedFields, operationId);

      // 6. Publish admin user update events
      await this._publishAdminUserUpdateEvents(userId, userType, updatedFields, groupChanged, operationId);

      logger.info(`[${operationId}] Admin user update Redis sync completed successfully for ${userType} user ${userId}`);

    } catch (error) {
      logger.error(`[${operationId}] Admin user update Redis sync failed for ${userType} user ${userId}:`, {
        error: error.message,
        stack: error.stack,
        updatedFields
      });
      
      // Don't throw error - Redis sync failures shouldn't break admin operations
      logger.warn(`[${operationId}] Continuing despite Redis sync failure - database is authoritative`);
    }
  }

  /**
   * Update user config cache after admin updates
   * @private
   */
  async _updateUserConfigAfterAdminUpdate(userId, userType, updatedFields, operationId) {
    try {
      const userConfigKey = `user:{${userType}:${userId}}:config`;
      
      // Prepare fields for Redis hash update
      const redisFields = {};
      
      // Financial fields
      if (updatedFields.wallet_balance !== undefined) {
        redisFields.wallet_balance = String(updatedFields.wallet_balance);
      }
      
      if (updatedFields.margin !== undefined) {
        redisFields.margin = String(updatedFields.margin);
      }
      
      if (updatedFields.net_profit !== undefined) {
        redisFields.net_profit = String(updatedFields.net_profit);
      }

      // Trading configuration fields (CRITICAL for future operations)
      if (updatedFields.group !== undefined) {
        redisFields.group = String(updatedFields.group);
        redisFields.last_group_update = new Date().toISOString();
      }

      if (updatedFields.leverage !== undefined) {
        redisFields.leverage = String(updatedFields.leverage);
      }

      // User status fields
      if (updatedFields.status !== undefined) {
        redisFields.status = String(updatedFields.status);
      }

      if (updatedFields.is_active !== undefined) {
        redisFields.is_active = String(updatedFields.is_active);
      }

      // Account information
      if (updatedFields.account_number !== undefined) {
        redisFields.account_number = String(updatedFields.account_number);
      }

      if (updatedFields.country_id !== undefined) {
        redisFields.country_id = String(updatedFields.country_id);
      }

      // Live user specific fields
      if (userType === 'live') {
        if (updatedFields.mam_id !== undefined) {
          redisFields.mam_id = String(updatedFields.mam_id || '');
        }
        
        if (updatedFields.mam_status !== undefined) {
          redisFields.mam_status = String(updatedFields.mam_status);
        }

        if (updatedFields.pam_id !== undefined) {
          redisFields.pam_id = String(updatedFields.pam_id || '');
        }

        if (updatedFields.pam_status !== undefined) {
          redisFields.pam_status = String(updatedFields.pam_status);
        }

        if (updatedFields.copy_trading_wallet !== undefined) {
          redisFields.copy_trading_wallet = String(updatedFields.copy_trading_wallet);
        }

        if (updatedFields.copytrader_id !== undefined) {
          redisFields.copytrader_id = String(updatedFields.copytrader_id || '');
        }

        if (updatedFields.copytrading_status !== undefined) {
          redisFields.copytrading_status = String(updatedFields.copytrading_status);
        }
      }

      // Add admin update timestamp
      redisFields.last_admin_update = new Date().toISOString();

      if (Object.keys(redisFields).length > 0) {
        await redisCluster.hset(userConfigKey, redisFields);
        logger.info(`[${operationId}] Updated user config cache after admin update: ${userConfigKey}`, {
          updatedFields: Object.keys(redisFields)
        });
      }

    } catch (error) {
      logger.error(`[${operationId}] Failed to update user config cache after admin update:`, error);
      throw error;
    }
  }

  /**
   * Handle group change specially (forward-looking only)
   * @private
   */
  async _handleGroupChange(userId, userType, oldGroup, newGroup, operationId) {
    try {
      logger.info(`[${operationId}] Handling group change for ${userType} user ${userId}`, {
        oldGroup,
        newGroup
      });

      // Clear group-dependent caches that affect future calculations
      const groupDependentCaches = [
        `user_margin_calc:${userType}:${userId}`,
        `user_group_config:${userType}:${userId}`,
        `margin_requirements:${userType}:${userId}`,
        `spread_config:${userType}:${userId}`
      ];

      for (const cacheKey of groupDependentCaches) {
        try {
          await redisCluster.del(cacheKey);
          logger.info(`[${operationId}] Cleared group-dependent cache: ${cacheKey}`);
        } catch (delError) {
          logger.warn(`[${operationId}] Failed to clear cache ${cacheKey}:`, delError.message);
        }
      }

      // Update portfolio cache with new group if it exists
      const portfolioKey = `user:{${userType}:${userId}}:portfolio`;
      const portfolioExists = await redisCluster.exists(portfolioKey);
      
      if (portfolioExists) {
        await redisCluster.hset(portfolioKey, {
          group: String(newGroup),
          group_updated_at: new Date().toISOString()
        });
        logger.info(`[${operationId}] Updated portfolio cache with new group: ${portfolioKey}`);
      }

      logger.info(`[${operationId}] Group change handling completed - future operations will use new group: ${newGroup}`);

    } catch (error) {
      logger.error(`[${operationId}] Failed to handle group change:`, error);
      throw error;
    }
  }

  /**
   * Clear future-calculation caches for affected fields
   * @private
   */
  async _clearFutureCalculationCaches(userId, userType, updatedFields, operationId) {
    try {
      const cachesToClear = [];

      // Clear margin calculation caches if trading-related fields changed
      if (updatedFields.group || updatedFields.leverage || updatedFields.status || updatedFields.is_active) {
        cachesToClear.push(`user_margin_calc:${userType}:${userId}`);
      }

      // Clear stats caches if any user data changed
      if (Object.keys(updatedFields).length > 0) {
        cachesToClear.push(`user_stats:${userType}:${userId}`);
        cachesToClear.push(`user_summary:${userType}:${userId}`);
      }

      // Clear financial summary caches if financial fields changed
      if (updatedFields.wallet_balance || updatedFields.margin || updatedFields.net_profit) {
        cachesToClear.push(`financial_summary:${userType}:${userId}:*`);
      }

      for (const cachePattern of cachesToClear) {
        try {
          if (cachePattern.includes('*')) {
            await this._clearCachePattern(cachePattern);
          } else {
            await redisCluster.del(cachePattern);
          }
          logger.info(`[${operationId}] Cleared future-calculation cache: ${cachePattern}`);
        } catch (delError) {
          logger.warn(`[${operationId}] Failed to clear cache ${cachePattern}:`, delError.message);
        }
      }

    } catch (error) {
      logger.error(`[${operationId}] Failed to clear future-calculation caches:`, error);
      // Don't throw - this is non-critical
    }
  }

  /**
   * Publish admin user update events for cross-service communication
   * @private
   */
  async _publishAdminUserUpdateEvents(userId, userType, updatedFields, groupChanged, operationId) {
    try {
      const updateEvent = {
        user_id: userId,
        user_type: userType,
        updated_fields: updatedFields,
        group_changed: groupChanged,
        event_type: 'admin_user_update',
        timestamp: new Date().toISOString(),
        source: 'admin_operation'
      };

      // Publish to general user updates channel
      await redisCluster.publish('user_updates', JSON.stringify(updateEvent));
      
      // Publish to admin-specific updates channel
      await redisCluster.publish('admin_user_updates', JSON.stringify(updateEvent));

      // If group changed, publish to group updates channel for Python services
      if (groupChanged) {
        const groupUpdateEvent = {
          ...updateEvent,
          event_type: 'user_group_change',
          old_group: updatedFields.old_group,
          new_group: updatedFields.group
        };
        await redisCluster.publish('group_updates', JSON.stringify(groupUpdateEvent));
      }

      logger.info(`[${operationId}] Published admin user update events for ${userType} user ${userId}`, {
        channels: groupChanged ? ['user_updates', 'admin_user_updates', 'group_updates'] : ['user_updates', 'admin_user_updates']
      });

    } catch (error) {
      logger.error(`[${operationId}] Failed to publish admin user update events:`, error);
      throw error;
    }
  }

  /**
   * Health check for Redis sync service
   */
  async healthCheck() {
    try {
      // Test Redis connectivity
      await redisCluster.ping();
      
      // Test cache operations
      const testKey = `redis_sync_health_${Date.now()}`;
      await redisCluster.setex(testKey, 10, 'test');
      const testValue = await redisCluster.get(testKey);
      await redisCluster.del(testKey);
      
      if (testValue !== 'test') {
        throw new Error('Redis cache test failed');
      }

      return {
        status: 'healthy',
        redis_connected: true,
        cache_operations: 'working',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Redis sync service health check failed:', error);
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new RedisSyncService();
