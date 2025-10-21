const { redisCluster } = require('../../config/redis');
const logger = require('../utils/logger');

class CopyTradingRedisService {
  constructor() {
    this.logger = logger;
  }

  /**
   * Add follower to strategy provider's active followers set
   * @param {number} strategyProviderId - Strategy provider ID
   * @param {number} copyFollowerAccountId - Copy follower account ID
   */
  async addFollowerToProvider(strategyProviderId, copyFollowerAccountId) {
    try {
      const followersKey = `copy_master_followers:${strategyProviderId}:active`;
      await redisCluster.sadd(followersKey, copyFollowerAccountId.toString());
      
      // Also maintain reverse mapping
      const followerMasterKey = `copy_follower_master:${copyFollowerAccountId}:provider_id`;
      await redisCluster.set(followerMasterKey, strategyProviderId.toString());
      
      this.logger.info(`Added follower ${copyFollowerAccountId} to strategy provider ${strategyProviderId}`);
    } catch (error) {
      this.logger.error(`Failed to add follower to provider`, {
        strategyProviderId,
        copyFollowerAccountId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Remove follower from strategy provider's active followers set
   * @param {number} strategyProviderId - Strategy provider ID
   * @param {number} copyFollowerAccountId - Copy follower account ID
   */
  async removeFollowerFromProvider(strategyProviderId, copyFollowerAccountId) {
    try {
      const followersKey = `copy_master_followers:${strategyProviderId}:active`;
      await redisCluster.srem(followersKey, copyFollowerAccountId.toString());
      
      // Remove reverse mapping
      const followerMasterKey = `copy_follower_master:${copyFollowerAccountId}:provider_id`;
      await redisCluster.del(followerMasterKey);
      
      this.logger.info(`Removed follower ${copyFollowerAccountId} from strategy provider ${strategyProviderId}`);
    } catch (error) {
      this.logger.error(`Failed to remove follower from provider`, {
        strategyProviderId,
        copyFollowerAccountId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all active followers for a strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Array} Array of follower IDs
   */
  async getActiveFollowers(strategyProviderId) {
    try {
      const followersKey = `copy_master_followers:${strategyProviderId}:active`;
      const followers = await redisCluster.smembers(followersKey);
      return followers.map(id => parseInt(id));
    } catch (error) {
      this.logger.error(`Failed to get active followers`, {
        strategyProviderId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get strategy provider for a follower
   * @param {number} copyFollowerAccountId - Copy follower account ID
   * @returns {number|null} Strategy provider ID or null
   */
  async getProviderForFollower(copyFollowerAccountId) {
    try {
      const followerMasterKey = `copy_follower_master:${copyFollowerAccountId}:provider_id`;
      const providerId = await redisCluster.get(followerMasterKey);
      return providerId ? parseInt(providerId) : null;
    } catch (error) {
      this.logger.error(`Failed to get provider for follower`, {
        copyFollowerAccountId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Create user config entries for copy trading accounts
   * @param {Object} account - Account data (StrategyProviderAccount or CopyFollowerAccount)
   * @param {string} userType - 'strategy_provider' or 'copy_follower'
   */
  async createUserConfig(account, userType) {
    try {
      const configKey = `user:{${userType}:${account.id}}:config`;
      
      const configData = {
        wallet_balance: account.wallet_balance?.toString() || '0',
        leverage: account.leverage?.toString() || '100',
        group: account.group || 'Standard',
        status: account.status?.toString() || '1',
        is_active: account.is_active?.toString() || '1',
        sending_orders: account.sending_orders || 'barclays',
        auto_cutoff_level: account.auto_cutoff_level?.toString() || '50.00'
      };

      await redisCluster.hset(configKey, configData);
      
      this.logger.debug(`Created user config for ${userType}:${account.id}`);
    } catch (error) {
      this.logger.error(`Failed to create user config`, {
        accountId: account.id,
        userType,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update user config for copy trading accounts
   * @param {number} accountId - Account ID
   * @param {string} userType - 'strategy_provider' or 'copy_follower'
   * @param {Object} updates - Config updates
   */
  async updateUserConfig(accountId, userType, updates) {
    try {
      const configKey = `user:{${userType}:${accountId}}:config`;
      
      // Convert all values to strings for Redis
      const stringUpdates = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== null && value !== undefined) {
          stringUpdates[key] = value.toString();
        }
      }

      if (Object.keys(stringUpdates).length > 0) {
        await redisCluster.hset(configKey, stringUpdates);
        this.logger.debug(`Updated user config for ${userType}:${accountId}`, stringUpdates);
      }
    } catch (error) {
      this.logger.error(`Failed to update user config`, {
        accountId,
        userType,
        updates,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Initialize portfolio entry for copy trading accounts
   * @param {number} accountId - Account ID
   * @param {string} userType - 'strategy_provider' or 'copy_follower'
   * @param {Object} initialData - Initial portfolio data
   */
  async initializePortfolio(accountId, userType, initialData = {}) {
    try {
      const portfolioKey = `user_portfolio:{${userType}:${accountId}}`;
      
      const portfolioData = {
        equity: initialData.equity?.toString() || '0',
        balance: initialData.balance?.toString() || '0',
        free_margin: initialData.free_margin?.toString() || '0',
        used_margin: initialData.used_margin?.toString() || '0',
        used_margin_executed: initialData.used_margin_executed?.toString() || '0',
        used_margin_all: initialData.used_margin_all?.toString() || '0',
        margin_level: initialData.margin_level?.toString() || '0',
        open_pnl: initialData.open_pnl?.toString() || '0',
        total_pl: initialData.total_pl?.toString() || '0',
        calc_status: 'ok',
        degraded_fields: '',
        ts: Date.now().toString()
      };

      await redisCluster.hset(portfolioKey, portfolioData);
      
      this.logger.debug(`Initialized portfolio for ${userType}:${accountId}`);
    } catch (error) {
      this.logger.error(`Failed to initialize portfolio`, {
        accountId,
        userType,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Clean up Redis entries when copy trading relationship ends
   * @param {number} strategyProviderId - Strategy provider ID
   * @param {number} copyFollowerAccountId - Copy follower account ID
   */
  async cleanupCopyTradingRelationship(strategyProviderId, copyFollowerAccountId) {
    try {
      // Remove from active followers
      await this.removeFollowerFromProvider(strategyProviderId, copyFollowerAccountId);
      
      // Clean up any pending replication data
      const replicationKeys = [
        `copy_replication_pending:${strategyProviderId}:${copyFollowerAccountId}`,
        `copy_order_mapping:${copyFollowerAccountId}:*`
      ];
      
      for (const keyPattern of replicationKeys) {
        if (keyPattern.includes('*')) {
          // Handle pattern keys
          const keys = await redisCluster.keys(keyPattern);
          if (keys.length > 0) {
            await redisCluster.del(...keys);
          }
        } else {
          await redisCluster.del(keyPattern);
        }
      }
      
      this.logger.info(`Cleaned up copy trading relationship`, {
        strategyProviderId,
        copyFollowerAccountId
      });
    } catch (error) {
      this.logger.error(`Failed to cleanup copy trading relationship`, {
        strategyProviderId,
        copyFollowerAccountId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get copy trading statistics from Redis
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Copy trading statistics
   */
  async getCopyTradingStats(strategyProviderId) {
    try {
      const followersKey = `copy_master_followers:${strategyProviderId}:active`;
      const activeFollowers = await redisCluster.scard(followersKey);
      
      // Get additional stats if needed
      const stats = {
        active_followers: activeFollowers,
        last_updated: Date.now()
      };
      
      return stats;
    } catch (error) {
      this.logger.error(`Failed to get copy trading stats`, {
        strategyProviderId,
        error: error.message
      });
      return {
        active_followers: 0,
        last_updated: Date.now()
      };
    }
  }

  /**
   * Batch update multiple copy trading relationships
   * @param {Array} relationships - Array of {strategyProviderId, copyFollowerAccountId, action}
   */
  async batchUpdateRelationships(relationships) {
    try {
      const pipeline = redisCluster.pipeline();
      
      for (const rel of relationships) {
        const { strategyProviderId, copyFollowerAccountId, action } = rel;
        const followersKey = `copy_master_followers:${strategyProviderId}:active`;
        const followerMasterKey = `copy_follower_master:${copyFollowerAccountId}:provider_id`;
        
        if (action === 'add') {
          pipeline.sadd(followersKey, copyFollowerAccountId.toString());
          pipeline.set(followerMasterKey, strategyProviderId.toString());
        } else if (action === 'remove') {
          pipeline.srem(followersKey, copyFollowerAccountId.toString());
          pipeline.del(followerMasterKey);
        }
      }
      
      await pipeline.exec();
      
      this.logger.info(`Batch updated ${relationships.length} copy trading relationships`);
    } catch (error) {
      this.logger.error(`Failed to batch update relationships`, {
        count: relationships.length,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new CopyTradingRedisService();
