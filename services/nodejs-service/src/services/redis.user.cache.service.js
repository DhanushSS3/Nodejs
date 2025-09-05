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
   * Generate Redis key for user
   */
  getUserKey(userType, userId) {
    return `user:${userType}:${userId}:config`;
  }

  /**
   * Generate hash-tagged Redis key for user to ensure same cluster slot
   */
  getTaggedUserKey(userType, userId) {
    return `user:{${userType}:${userId}}:config`;
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
      
      // Clear existing cache - handle Redis cluster CROSSSLOT limitation
      const pattern = 'user:*:*:config';
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        // Delete keys one by one to avoid CROSSSLOT errors in Redis cluster
        for (const key of keys) {
          try {
            await this.redis.del(key);
          } catch (delError) {
            logger.warn(`Failed to delete key ${key}:`, delError.message);
          }
        }
        logger.info(`Cleared ${keys.length} existing cache entries`);
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
        const taggedKey = this.getTaggedUserKey('live', user.id);
        const userData = this.extractLiveUserFields(user);
        await this.redis.hset(key, userData);
        await this.redis.hset(taggedKey, userData);
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
        const taggedKey = this.getTaggedUserKey('demo', user.id);
        const userData = this.extractDemoUserFields(user);
        await this.redis.hset(key, userData);
        await this.redis.hset(taggedKey, userData);
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
      if (!userData || Object.keys(userData).length === 0) {
        const taggedKey = this.getTaggedUserKey(userType, userId);
        userData = await this.redis.hgetall(taggedKey);
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
      const taggedKey = this.getTaggedUserKey(userType, userId);
      
      // Add timestamp
      const fieldsWithTimestamp = {
        ...updatedFields,
        last_updated: new Date().toISOString()
      };

      await this.redis.hset(key, fieldsWithTimestamp);
      await this.redis.hset(taggedKey, fieldsWithTimestamp);
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
      const taggedKey = this.getTaggedUserKey(userType, userId);
      await this.redis.del(key);
      await this.redis.del(taggedKey);
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
      const pattern = `user:${userType}:*:config`;
      
      // Use SCAN instead of KEYS for better performance in Redis cluster
      const keys = [];
      let cursor = '0';
      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');

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
      const livePattern = 'user:live:*:config';
      const demoPattern = 'user:demo:*:config';
      
      // Use SCAN instead of KEYS for Redis cluster compatibility
      const liveKeys = [];
      const demoKeys = [];
      
      // Scan for live users
      let cursor = '0';
      do {
        const result = await this.redis.scan(cursor, 'MATCH', livePattern, 'COUNT', 100);
        cursor = result[0];
        liveKeys.push(...result[1]);
      } while (cursor !== '0');
      
      // Scan for demo users
      cursor = '0';
      do {
        const result = await this.redis.scan(cursor, 'MATCH', demoPattern, 'COUNT', 100);
        cursor = result[0];
        demoKeys.push(...result[1]);
      } while (cursor !== '0');

      return {
        live_users: liveKeys.length,
        demo_users: demoKeys.length,
        total_users: liveKeys.length + demoKeys.length,
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
