const redisUserCache = require('./redis.user.cache.service');
const groupsCacheService = require('./groups.cache.service');
const logger = require('./logger.service');

class StartupCacheService {
  constructor() {
    this.isInitialized = false;
  }

  /**
   * Initialize all cache services on application startup
   */
  async initialize() {
    try {
      logger.info('Starting cache initialization...');
      
      // Initialize Redis User Cache Service
      await redisUserCache.initialize();
      
      // Initialize Groups Cache Service
      logger.info('Initializing groups cache service...');
      const groupsResult = await groupsCacheService.syncAllGroupsToRedis();
      if (!groupsResult.success) {
        throw new Error(`Groups cache initialization failed: ${groupsResult.message}`);
      }
      logger.info(`Groups cache initialized: ${groupsResult.message}`);
      
      this.isInitialized = true;
      logger.info('All cache services initialized successfully');
      
      return {
        success: true,
        message: 'Cache services initialized successfully',
        services: {
          redis_user_cache: true,
          groups_cache: true
        }
      };
    } catch (error) {
      logger.error('Failed to initialize cache services:', error);
      throw error;
    }
  }

  /**
   * Get initialization status
   */
  getStatus() {
    return {
      is_initialized: this.isInitialized,
      redis_user_cache: redisUserCache.isInitialized,
      groups_cache: true // Groups cache doesn't have isInitialized flag
    };
  }

  /**
   * Refresh all caches
   */
  async refreshCaches() {
    try {
      logger.info('Refreshing all caches...');
      
      // Refresh user cache
      await redisUserCache.populateCache();
      
      // Refresh groups cache
      await groupsCacheService.syncAllGroupsToRedis();
      
      logger.info('All caches refreshed successfully');
      return {
        success: true,
        message: 'All caches refreshed successfully'
      };
    } catch (error) {
      logger.error('Failed to refresh caches:', error);
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const userCacheStats = await redisUserCache.getCacheStats();
      const groupsCacheStats = await groupsCacheService.getCacheStats();
      
      return {
        user_cache: userCacheStats,
        groups_cache: groupsCacheStats,
        startup_service: {
          is_initialized: this.isInitialized
        }
      };
    } catch (error) {
      logger.error('Failed to get cache stats:', error);
      return { error: error.message };
    }
  }

  /**
   * Gracefully shutdown cache services
   */
  async shutdown() {
    try {
      logger.info('Shutting down cache services...');
      
      await redisUserCache.close();
      
      this.isInitialized = false;
      logger.info('Cache services shut down successfully');
    } catch (error) {
      logger.error('Error during cache services shutdown:', error);
    }
  }
}

module.exports = new StartupCacheService();
