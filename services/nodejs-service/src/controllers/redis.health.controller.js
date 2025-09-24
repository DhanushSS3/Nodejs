const redisSyncService = require('../services/redis.sync.service');
const redisUserCacheService = require('../services/redis.user.cache.service');
const { redisCluster } = require('../../config/redis');
const logger = require('../services/logger.service');

/**
 * Redis Health Controller
 * Provides health checks and diagnostics for Redis consistency
 */
class RedisHealthController {

  /**
   * Get Redis sync service health status
   */
  static async getHealthStatus(req, res) {
    try {
      const health = await redisSyncService.healthCheck();
      
      const status = health.status === 'healthy' ? 200 : 503;
      
      res.status(status).json({
        success: health.status === 'healthy',
        message: `Redis sync service is ${health.status}`,
        data: health
      });

    } catch (error) {
      logger.error('Redis health check failed:', error);
      
      res.status(503).json({
        success: false,
        message: 'Redis health check failed',
        error: error.message
      });
    }
  }

  /**
   * Check Redis-Database consistency for a specific user
   * Superadmin only endpoint for debugging
   */
  static async checkUserConsistency(req, res) {
    try {
      const { userId } = req.params;
      const { userType = 'live' } = req.query;

      if (!userId || !['live', 'demo'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Valid userId and userType (live/demo) required'
        });
      }

      // Get data from database
      const UserModel = userType === 'live' ? 
        require('../models/liveUser.model') : 
        require('../models/demoUser.model');
      
      const dbUser = await UserModel.findByPk(userId, {
        attributes: ['id', 'wallet_balance', 'leverage', 'margin', 'net_profit', 'account_number', 'group', 'status', 'is_active']
      });

      if (!dbUser) {
        return res.status(404).json({
          success: false,
          message: `${userType} user not found`
        });
      }

      // Get data from Redis
      const userConfigKey = `user:{${userType}:${userId}}:config`;
      const balanceCacheKey = `user_balance:${userType}:${userId}`;
      
      const [redisConfig, redisBalance] = await Promise.all([
        redisCluster.hgetall(userConfigKey),
        redisCluster.get(balanceCacheKey)
      ]);

      // Compare values
      const dbBalance = parseFloat(dbUser.wallet_balance) || 0;
      const redisConfigBalance = parseFloat(redisConfig.wallet_balance) || 0;
      const redisCacheBalance = parseFloat(redisBalance) || 0;

      const consistency = {
        database: {
          wallet_balance: dbBalance,
          leverage: dbUser.leverage,
          margin: parseFloat(dbUser.margin) || 0,
          account_number: dbUser.account_number,
          group: dbUser.group,
          status: dbUser.status,
          is_active: dbUser.is_active
        },
        redis_config: {
          wallet_balance: redisConfigBalance,
          leverage: parseInt(redisConfig.leverage) || 0,
          margin: parseFloat(redisConfig.margin) || 0,
          account_number: redisConfig.account_number,
          group: redisConfig.group,
          status: redisConfig.status,
          is_active: redisConfig.is_active,
          last_updated: redisConfig.last_updated
        },
        redis_balance_cache: {
          wallet_balance: redisCacheBalance,
          ttl: await redisCluster.ttl(balanceCacheKey)
        },
        consistency_check: {
          balance_matches: Math.abs(dbBalance - redisConfigBalance) < 0.01,
          cache_matches: Math.abs(dbBalance - redisCacheBalance) < 0.01,
          all_consistent: Math.abs(dbBalance - redisConfigBalance) < 0.01 && Math.abs(dbBalance - redisCacheBalance) < 0.01
        }
      };

      const isConsistent = consistency.consistency_check.all_consistent;

      res.status(200).json({
        success: true,
        message: `User consistency check ${isConsistent ? 'PASSED' : 'FAILED'}`,
        data: {
          user_id: userId,
          user_type: userType,
          is_consistent: isConsistent,
          ...consistency
        }
      });

    } catch (error) {
      logger.error('User consistency check failed:', error);
      
      res.status(500).json({
        success: false,
        message: 'User consistency check failed',
        error: error.message
      });
    }
  }

  /**
   * Force refresh user data from database to Redis
   * Superadmin only endpoint for fixing inconsistencies
   */
  static async forceRefreshUser(req, res) {
    try {
      const { userId } = req.params;
      const { userType = 'live' } = req.query;

      if (!userId || !['live', 'demo'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Valid userId and userType (live/demo) required'
        });
      }

      const refreshedData = await redisSyncService.forceRefreshUser(parseInt(userId), userType);

      res.status(200).json({
        success: true,
        message: `User ${userType}:${userId} refreshed successfully`,
        data: {
          user_id: parseInt(userId),
          user_type: userType,
          refreshed_fields: refreshedData
        }
      });

    } catch (error) {
      logger.error('Force refresh user failed:', error);
      
      res.status(400).json({
        success: false,
        message: error.message || 'Force refresh failed'
      });
    }
  }

  /**
   * Get Redis cluster information
   */
  static async getClusterInfo(req, res) {
    try {
      const clusterInfo = {
        nodes: [],
        total_keys: 0,
        user_config_keys: 0,
        balance_cache_keys: 0
      };

      const masters = redisCluster.nodes('master');
      
      for (const node of masters) {
        try {
          const nodeInfo = {
            host: node.options.host,
            port: node.options.port,
            status: 'connected',
            keys: 0,
            user_configs: 0,
            balance_caches: 0
          };

          // Count different types of keys
          const patterns = [
            'user:{*}:config',
            'user_balance:*'
          ];

          for (const pattern of patterns) {
            let cursor = '0';
            let count = 0;
            
            do {
              const result = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
              cursor = result[0];
              const keys = result[1] || [];
              count += keys.length;
            } while (cursor !== '0');

            if (pattern.includes('config')) {
              nodeInfo.user_configs = count;
              clusterInfo.user_config_keys += count;
            } else if (pattern.includes('balance')) {
              nodeInfo.balance_caches = count;
              clusterInfo.balance_cache_keys += count;
            }
          }

          nodeInfo.keys = nodeInfo.user_configs + nodeInfo.balance_caches;
          clusterInfo.total_keys += nodeInfo.keys;
          clusterInfo.nodes.push(nodeInfo);

        } catch (nodeError) {
          clusterInfo.nodes.push({
            host: node.options.host,
            port: node.options.port,
            status: 'error',
            error: nodeError.message
          });
        }
      }

      res.status(200).json({
        success: true,
        message: 'Redis cluster information retrieved',
        data: clusterInfo
      });

    } catch (error) {
      logger.error('Get cluster info failed:', error);
      
      res.status(500).json({
        success: false,
        message: 'Failed to get cluster information',
        error: error.message
      });
    }
  }
}

module.exports = RedisHealthController;
