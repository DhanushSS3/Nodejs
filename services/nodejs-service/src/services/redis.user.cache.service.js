const { redisCluster } = require('../../config/redis');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const logger = require('./logger.service');

class RedisUserCacheService {
  constructor() {
    // Use the existing Redis cluster instead of creating new connections
    this.redis = redisCluster;
    this.publisher = redisCluster;
    this.subscriber = redisCluster;

    this.isInitialized = false;
    this.setupSubscriber();
  }

  /**
   * Initialize Redis connections and populate cache
   */
  async initialize() {
    try {
      // Redis cluster is already connected, no need to connect again
      logger.info('Using existing Redis cluster connection');
      
      // Populate cache with all users on startup
      await this.populateCache();
      
      this.isInitialized = true;
      logger.info('Redis User Cache Service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Redis User Cache Service:', error);
      throw error;
    }
  }

  /**
   * Setup Redis subscriber for user updates
   */
  setupSubscriber() {
    this.subscriber.on('message', async (channel, message) => {
      try {
        if (channel === 'user_updates') {
          const updateData = JSON.parse(message);
          await this.handleUserUpdate(updateData);
        }
      } catch (error) {
        logger.error('Error processing Redis message:', error);
      }
    });

    this.subscriber.subscribe('user_updates');
    logger.info('Subscribed to user_updates channel');
  }

  /**
   * Generate Redis key for user config (hash-tagged primary)
   * Pattern: user:{userType:userId}:config
   */
  getUserKey(userType, userId) {
    return `user:{${userType}:${userId}}:config`;
  }

  /**
   * Backward-compat alias to getUserKey (hash-tagged)
   */
  getTaggedUserKey(userType, userId) {
    return this.getUserKey(userType, userId);
  }

  /**
   * Extract cacheable fields from live user
   */
  extractLiveUserFields(user) {
    return {
      id: user.id,
      user_type: 'live',
      wallet_balance: parseFloat(user.wallet_balance) || 0,
      leverage: user.leverage || 0,
      margin: parseFloat(user.margin) || 0,
      account_number: user.account_number,
      group: user.group,
      status: user.status,
      is_active: user.is_active,
      country_id: user.country_id,
      mam_id: user.mam_id,
      mam_status: user.mam_status,
      pam_id: user.pam_id,
      pam_status: user.pam_status,
      copy_trading_wallet: parseFloat(user.copy_trading_wallet) || 0,
      copytrader_id: user.copytrader_id,
      copytrading_status: user.copytrading_status,
      copytrading_alloted_time: user.copytrading_alloted_time ? user.copytrading_alloted_time.toISOString() : null,
      sending_orders: user.sending_orders || 'rock',
      last_updated: new Date().toISOString()
    };
  }

  /**
   * Extract cacheable fields from demo user
   */
  extractDemoUserFields(user) {
    return {
      id: user.id,
      user_type: 'demo',
      wallet_balance: parseFloat(user.wallet_balance) || 0,
      leverage: user.leverage || 0,
      margin: parseFloat(user.margin) || 0,
      account_number: user.account_number,
      group: user.group,
      status: user.status,
      is_active: user.is_active,
      country_id: user.country_id,
      sending_orders: 'rock',
      last_updated: new Date().toISOString()
    };
  }

  /**
   * Populate Redis cache with all users from database
   */
  async populateCache() {
    try {
      logger.info('Starting cache population...');
      
      // Clear existing cache across ALL cluster masters (both legacy and tagged patterns)
      const patterns = ['user:*:*:config', 'user:{*}:config'];
      let cleared = 0;
      try {
        const masters = this.redis.nodes('master');
        for (const node of masters) {
          for (const pat of patterns) {
            let nodeKeys = [];
            try {
              nodeKeys = await node.keys(pat);
            } catch (e) {
              // Fallback to SCAN if KEYS not available
              let cursor = '0';
              do {
                const res = await node.scan(cursor, 'MATCH', pat, 'COUNT', 500);
                cursor = res[0];
                nodeKeys.push(...(res[1] || []));
              } while (cursor !== '0');
            }
            for (const k of nodeKeys) {
              try { await node.del(k); cleared += 1; } catch (delError) {
                logger.warn(`Failed to delete key ${k}:`, delError.message);
              }
            }
          }
        }
        if (cleared > 0) {
          logger.info(`Cleared ${cleared} existing cache entries`);
        }
      } catch (clearErr) {
        logger.warn('Failed to clear existing user config cache across cluster:', clearErr.message);
      }

      // Cache live users
      const liveUsers = await LiveUser.findAll({
        attributes: [
          'id', 'wallet_balance', 'leverage', 'margin', 'account_number',
          'group', 'status', 'is_active', 'country_id', 'mam_id', 'mam_status',
          'pam_id', 'pam_status', 'copy_trading_wallet', 'copytrader_id',
          'copytrading_status', 'copytrading_alloted_time', 'sending_orders'
        ]
      });

      for (const user of liveUsers) {
        const key = this.getUserKey('live', user.id);
        const userData = this.extractLiveUserFields(user);
        await this.redis.hset(key, userData);
      }

      // Cache demo users
      const demoUsers = await DemoUser.findAll({
        attributes: [
          'id', 'wallet_balance', 'leverage', 'margin', 'account_number',
          'group', 'status', 'is_active', 'country_id'
        ]
      });

      for (const user of demoUsers) {
        const key = this.getUserKey('demo', user.id);
        const userData = this.extractDemoUserFields(user);
        await this.redis.hset(key, userData);
      }

      logger.info(`Cache populated: ${liveUsers.length} live users, ${demoUsers.length} demo users`);
    } catch (error) {
      logger.error('Error populating cache:', error);
      throw error;
    }
  }

  /**
   * Get user from cache
   */
  async getUser(userType, userId) {
    try {
      const key = this.getUserKey(userType, userId);
      let userData = await this.redis.hgetall(key);
      // Optional fallback to legacy key during transition (should be empty after flush)
      if (!userData || Object.keys(userData).length === 0) {
        const legacyKey = `user:${userType}:${userId}:config`;
        userData = await this.redis.hgetall(legacyKey);
      }
      
      if (Object.keys(userData).length === 0) {
        return null;
      }

      // Convert string values back to appropriate types
      return {
        ...userData,
        id: parseInt(userData.id),
        wallet_balance: parseFloat(userData.wallet_balance),
        leverage: parseInt(userData.leverage),
        margin: parseFloat(userData.margin),
        status: parseInt(userData.status),
        is_active: parseInt(userData.is_active),
        country_id: userData.country_id ? parseInt(userData.country_id) : null,
        mam_id: userData.mam_id ? parseInt(userData.mam_id) : null,
        mam_status: userData.mam_status ? parseInt(userData.mam_status) : null,
        pam_id: userData.pam_id ? parseInt(userData.pam_id) : null,
        pam_status: userData.pam_status ? parseInt(userData.pam_status) : null,
        copy_trading_wallet: userData.copy_trading_wallet ? parseFloat(userData.copy_trading_wallet) : null,
        copytrader_id: userData.copytrader_id ? parseInt(userData.copytrader_id) : null,
        copytrading_status: userData.copytrading_status ? parseInt(userData.copytrading_status) : null
      };
    } catch (error) {
      logger.error(`Error getting user ${userType}:${userId} from cache:`, error);
      return null;
    }
  }

  /**
   * Update user in cache
   */
  async updateUser(userType, userId, updatedFields) {
    try {
      const key = this.getUserKey(userType, userId);
      
      // Add timestamp
      const fieldsWithTimestamp = {
        ...updatedFields,
        last_updated: new Date().toISOString()
      };

      await this.redis.hset(key, fieldsWithTimestamp);
      logger.info(`Updated cache for user ${userType}:${userId}`);
    } catch (error) {
      logger.error(`Error updating user ${userType}:${userId} in cache:`, error);
      throw error;
    }
  }

  /**
   * Remove user from cache
   */
  async removeUser(userType, userId) {
    try {
      const key = this.getUserKey(userType, userId);
      await this.redis.del(key);
      logger.info(`Removed user ${userType}:${userId} from cache`);
    } catch (error) {
      logger.error(`Error removing user ${userType}:${userId} from cache:`, error);
      throw error;
    }
  }

  /**
   * Publish user update to Redis Pub/Sub
   */
  async publishUserUpdate(userType, userId, updatedFields) {
    try {
      const message = {
        user_type: userType,
        user_id: userId,
        updated_fields: updatedFields,
        timestamp: Date.now()
      };

      await this.publisher.publish('user_updates', JSON.stringify(message));
      logger.info(`Published update for user ${userType}:${userId}`);
    } catch (error) {
      logger.error(`Error publishing update for user ${userType}:${userId}:`, error);
      throw error;
    }
  }

  /**
   * Handle incoming user update from Pub/Sub
   */
  async handleUserUpdate(updateData) {
    try {
      const { user_type, user_id, updated_fields } = updateData;
      await this.updateUser(user_type, user_id, updated_fields);
      logger.info(`Processed update for user ${user_type}:${user_id}`);
    } catch (error) {
      logger.error('Error handling user update:', error);
    }
  }

  /**
   * Get users by country (for scoped access)
   */
  async getUsersByCountry(userType, countryId) {
    try {
      // Hash-tagged pattern
      const pattern = `user:{${userType}:*}:config`;
      // Scan across all cluster masters
      const keys = [];
      try {
        const masters = this.redis.nodes('master');
        for (const node of masters) {
          let cursor = '0';
          do {
            const result = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = result[0];
            keys.push(...(result[1] || []));
          } while (cursor !== '0');
        }
      } catch (scanErr) {
        logger.warn(`Failed cluster scan for pattern ${pattern}:`, scanErr.message);
      }

      const users = [];
      for (const key of keys) {
        try {
          const userData = await this.redis.hgetall(key);
          if (userData.country_id && parseInt(userData.country_id) === countryId) {
            users.push({
              ...userData,
              id: parseInt(userData.id),
              wallet_balance: parseFloat(userData.wallet_balance),
              leverage: parseInt(userData.leverage),
              margin: parseFloat(userData.margin)
            });
          }
        } catch (keyError) {
          logger.warn(`Failed to get data for key ${key}:`, keyError.message);
        }
      }

      return users;
    } catch (error) {
      logger.error(`Error getting users by country ${countryId}:`, error);
      return [];
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const livePattern = 'user:{live:*}:config';
      const demoPattern = 'user:{demo:*}:config';
      
      // Scan across all cluster masters for both patterns
      let liveCount = 0;
      let demoCount = 0;
      try {
        const masters = this.redis.nodes('master');
        for (const node of masters) {
          // live
          let cursor = '0';
          do {
            const res = await node.scan(cursor, 'MATCH', livePattern, 'COUNT', 200);
            cursor = res[0];
            liveCount += (res[1] || []).length;
          } while (cursor !== '0');
          // demo
          cursor = '0';
          do {
            const res = await node.scan(cursor, 'MATCH', demoPattern, 'COUNT', 200);
            cursor = res[0];
            demoCount += (res[1] || []).length;
          } while (cursor !== '0');
        }
      } catch (scanErr) {
        logger.warn('Cluster scan failed while computing cache stats:', scanErr.message);
      }

      return {
        live_users: liveCount,
        demo_users: demoCount,
        total_users: liveCount + demoCount,
        is_initialized: this.isInitialized
      };
    } catch (error) {
      logger.error('Error getting cache stats:', error);
      return { error: error.message };
    }
  }

  /**
   * Refresh single user from database
   */
  async refreshUser(userType, userId) {
    try {
      let user;
      if (userType === 'live') {
        user = await LiveUser.findByPk(userId, {
          attributes: [
            'id', 'wallet_balance', 'leverage', 'margin', 'account_number',
            'group', 'status', 'is_active', 'country_id', 'mam_id', 'mam_status',
            'pam_id', 'pam_status', 'copy_trading_wallet', 'copytrader_id',
            'copytrading_status', 'copytrading_alloted_time', 'sending_orders'
          ]
        });
        if (user) {
          const userData = this.extractLiveUserFields(user);
          await this.updateUser(userType, userId, userData);
        }
      } else if (userType === 'demo') {
        user = await DemoUser.findByPk(userId, {
          attributes: [
            'id', 'wallet_balance', 'leverage', 'margin', 'account_number',
            'group', 'status', 'is_active', 'country_id'
          ]
        });
        if (user) {
          const userData = this.extractDemoUserFields(user);
          await this.updateUser(userType, userId, userData);
        }
      }

      if (!user) {
        await this.removeUser(userType, userId);
      }

      return user !== null;
    } catch (error) {
      logger.error(`Error refreshing user ${userType}:${userId}:`, error);
      throw error;
    }
  }

  /**
   * Close Redis connections
   */
  async close() {
    try {
      // Don't close the shared Redis cluster connection
      logger.info('Redis User Cache Service cleanup completed');
    } catch (error) {
      logger.error('Error during Redis cache cleanup:', error);
    }
  }
}

module.exports = new RedisUserCacheService();
