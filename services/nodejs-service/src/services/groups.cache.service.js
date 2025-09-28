const { redisCluster } = require('../../config/redis');
const { Group } = require('../models');
const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * Redis Groups Caching Service
 * 
 * DESIGN DECISIONS:
 * 1. Redis Structure: Hash (HSET) for efficient partial field updates
 * 2. Key Pattern: groups:{group_name}:{symbol} with hash tags for cluster optimization
 * 3. Cache Strategy: Write-through with pub/sub notifications
 * 4. TTL: No expiration for groups (rarely change, manually invalidated)
 * 5. Startup: Full MySQL → Redis sync
 */

class GroupsCacheService {
  constructor() {
    this.CACHE_PREFIX = 'groups';
    this.PUBSUB_CHANNEL = 'groups_updates';
    this.SYNC_LOCK_KEY = 'groups_sync_lock';
    this.SYNC_LOCK_TTL = 300; // 5 minutes
    this.BATCH_SIZE = 100; // Process groups in batches for memory efficiency
  }

  /**
   * Generate Redis key with hash tag for cluster optimization
   * Pattern: groups:{group_name}:{symbol}
   * Hash tag ensures all keys for same group are co-located in same slot
   */
  getGroupKey(groupName, symbol) {
    // Sanitize group name and symbol for Redis key
    const sanitizedGroupName = groupName.replace(/[{}:]/g, '_');
    const sanitizedSymbol = symbol.replace(/[{}:]/g, '_');
    return `${this.CACHE_PREFIX}:{${sanitizedGroupName}}:${sanitizedSymbol}`;
  }

  /**
   * Generate pattern for scanning group keys
   */
  getGroupPattern(groupName = '*', symbol = '*') {
    // For Redis KEYS command, we need to use wildcards properly
    if (groupName === '*') {
      return `${this.CACHE_PREFIX}:*`;
    }
    
    // Escape special Redis pattern characters but keep the original group name
    // Redis KEYS pattern special chars: * ? [ ] \ 
    // We need to escape these but NOT the + in Royal+
    const escapedGroupName = groupName.replace(/[*?[\]\\]/g, '\\$&');
    const sanitizedSymbol = symbol === '*' ? '*' : symbol.replace(/[{}:]/g, '_');
    
    // Match the exact key format: groups:{groupName}:symbol
    return `${this.CACHE_PREFIX}:{${escapedGroupName}}:${sanitizedSymbol}`;
  }

  /**
   * Convert Group model instance to Redis hash format
   */
  groupToRedisHash(group) {
    return {
      id: group.id.toString(),
      symbol: group.symbol,
      name: group.name,
      commision_type: group.commision_type.toString(),
      commision_value_type: group.commision_value_type.toString(),
      type: group.type.toString(),
      pip_currency: group.pip_currency,
      show_points: group.show_points ? group.show_points.toString() : '',
      swap_buy: group.swap_buy.toString(),
      swap_sell: group.swap_sell.toString(),
      commision: group.commision.toString(),
      margin: group.margin.toString(),
      spread: group.spread.toString(),
      deviation: group.deviation.toString(),
      min_lot: group.min_lot.toString(),
      max_lot: group.max_lot.toString(),
      pips: group.pips.toString(),
      spread_pip: group.spread_pip ? group.spread_pip.toString() : '',
      contract_size: group.contract_size ? group.contract_size.toString() : '',
      profit: group.profit || '',
      swap_type: group.swap_type || '',
      created_at: group.created_at.toISOString(),
      updated_at: group.updated_at.toISOString(),
      // Add cache metadata
      cached_at: new Date().toISOString(),
      cache_version: '1.0'
    };
  }

  /**
   * Convert Redis hash to Group-like object
   */
  redisHashToGroup(hash) {
    if (!hash || Object.keys(hash).length === 0) return null;

    return {
      id: parseInt(hash.id),
      symbol: hash.symbol,
      name: hash.name,
      commision_type: parseInt(hash.commision_type),
      commision_value_type: parseInt(hash.commision_value_type),
      type: parseInt(hash.type),
      pip_currency: hash.pip_currency,
      show_points: hash.show_points ? parseInt(hash.show_points) : null,
      swap_buy: parseFloat(hash.swap_buy),
      swap_sell: parseFloat(hash.swap_sell),
      commision: parseFloat(hash.commision),
      margin: parseFloat(hash.margin),
      spread: parseFloat(hash.spread),
      deviation: parseFloat(hash.deviation),
      min_lot: parseFloat(hash.min_lot),
      max_lot: parseFloat(hash.max_lot),
      pips: parseFloat(hash.pips),
      spread_pip: hash.spread_pip ? parseFloat(hash.spread_pip) : null,
      contract_size: hash.contract_size ? parseFloat(hash.contract_size) : null,
      profit: hash.profit || null,
      swap_type: hash.swap_type || null,
      created_at: new Date(hash.created_at),
      updated_at: new Date(hash.updated_at),
      cached_at: new Date(hash.cached_at),
      cache_version: hash.cache_version
    };
  }

  /**
   * STARTUP SYNC: Load all groups from MySQL into Redis
   * Called during application startup
   */
  async syncAllGroupsToRedis() {
    const lockKey = this.SYNC_LOCK_KEY;
    const lockValue = crypto.randomUUID();

    try {
      // Acquire distributed lock to prevent multiple instances from syncing simultaneously
      const lockAcquired = await redisCluster.set(
        lockKey, 
        lockValue, 
        'PX', 
        this.SYNC_LOCK_TTL * 1000, 
        'NX'
      );

      if (!lockAcquired) {
        logger.info('Groups sync already in progress by another instance');
        return { success: true, message: 'Sync skipped - already in progress' };
      }

      logger.info('Starting groups sync from MySQL to Redis...');
      const startTime = Date.now();

      // Get total count for progress tracking
      const totalGroups = await Group.count();
      logger.info(`Found ${totalGroups} groups to sync`);

      let syncedCount = 0;
      let offset = 0;

      // Process in batches to avoid memory issues
      while (offset < totalGroups) {
        const groups = await Group.findAll({
          limit: this.BATCH_SIZE,
          offset: offset,
          order: [['id', 'ASC']]
        });

        if (groups.length === 0) break;

        // In Redis Cluster, we need to execute operations individually
        // since keys may be distributed across different slots
        for (const group of groups) {
          const key = this.getGroupKey(group.name, group.symbol);
          const hash = this.groupToRedisHash(group);
          
          
          // Log batch progress and any errors
          try {
            // Set key with no expiration to prevent Redis eviction
            await redisCluster.hset(key, hash);
            await redisCluster.persist(key); // Remove any TTL that might be set
          } catch (error) {
            console.error(`Failed to sync ${group.name}:${group.symbol}:`, error);
            logger.error(`Failed to sync ${group.name}:${group.symbol}:`, error);
            throw error; // Re-throw to stop sync on error
          }
        }
        syncedCount += groups.length;
        offset += this.BATCH_SIZE;

        logger.info(`Synced ${syncedCount}/${totalGroups} groups (${Math.round(syncedCount/totalGroups*100)}%)`);
      }

      const duration = Date.now() - startTime;
      logger.info(`Groups sync completed: ${syncedCount} groups in ${duration}ms`);

      // Verify actual keys stored in Redis across ALL cluster nodes
      let totalActualKeys = 0;
      try {
        const nodes = redisCluster.nodes('master');
        for (const node of nodes) {
          const nodeKeys = await node.keys(`${this.CACHE_PREFIX}:*`);
          totalActualKeys += nodeKeys.length;
        }
        logger.info(`SYNC VERIFICATION: Synced ${syncedCount} groups, Redis cluster has ${totalActualKeys} total keys`);
      } catch (err) {
        const actualKeys = await redisCluster.keys(`${this.CACHE_PREFIX}:*`);
        logger.info(`SYNC VERIFICATION: Synced ${syncedCount} groups, Redis has ${actualKeys.length} keys (single node)`);
        totalActualKeys = actualKeys.length;
      }

      // Store sync metadata
      await redisCluster.hset('groups_sync_metadata', {
        last_sync: new Date().toISOString(),
        total_synced: syncedCount.toString(),
        actual_keys_stored: totalActualKeys.toString(),
        sync_duration_ms: duration.toString(),
        sync_version: '1.0'
      });

      return { 
        success: true, 
        synced: syncedCount, 
        duration: duration,
        message: `Successfully synced ${syncedCount} groups`
      };

    } catch (error) {
      logger.error('Groups sync failed:', error);
      throw error;
    } finally {
      // Release lock
      const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
      `;
      await redisCluster.eval(script, 1, lockKey, lockValue);
    }
  }

  /**
   * FETCH: Get group data efficiently for trading calculations
   * Supports multiple lookup patterns for flexibility
   */
  async getGroup(groupName, symbol) {
    try {
      const key = this.getGroupKey(groupName, symbol);
      const hash = await redisCluster.hgetall(key);
      
      if (!hash || Object.keys(hash).length === 0) {
        // Cache miss - try to load from database
        logger.warn(`Cache miss for group: ${groupName}:${symbol}`);
        return await this.loadGroupFromDB(groupName, symbol);
      }

      return this.redisHashToGroup(hash);
    } catch (error) {
      logger.error(`Failed to get group ${groupName}:${symbol}:`, error);
      // Fallback to database
      return await this.loadGroupFromDB(groupName, symbol);
    }
  }

  /**
   * Get multiple groups by pattern (for bulk operations)
   */
  async getGroupsByPattern(groupName = '*', symbol = '*') {
    try {
      const pattern = this.getGroupPattern(groupName, symbol);
      logger.info(`Searching Redis with pattern: ${pattern} for group: ${groupName}`);
      
      // Search across ALL cluster nodes, not just one
      let keys = [];
      try {
        const nodes = redisCluster.nodes('master');
        for (const node of nodes) {
          const nodeKeys = await node.keys(pattern);
          keys = keys.concat(nodeKeys);
        }
        logger.info(`Found ${keys.length} total keys matching pattern: ${pattern}`);
      } catch (clusterErr) {
        keys = await redisCluster.keys(pattern);
        logger.info(`Found ${keys.length} keys matching pattern: ${pattern} (single node)`);
      }
      
      if (keys.length === 0) {
        // Try broader search across all cluster nodes for debugging
        let allGroupKeys = [];
        try {
          const nodes = redisCluster.nodes('master');
          for (const node of nodes) {
            const nodeKeys = await node.keys(`${this.CACHE_PREFIX}:*`);
            allGroupKeys = allGroupKeys.concat(nodeKeys);
          }
        } catch (err) {
          allGroupKeys = await redisCluster.keys(`${this.CACHE_PREFIX}:*`);
        }
        
        logger.info(`Total group keys in cache: ${allGroupKeys.length}`);
        
        return [];
      }

      logger.info(`Processing ${keys.length} keys: ${JSON.stringify(keys.slice(0, 3))}...`);

      // Execute operations individually for Redis Cluster compatibility
      const groups = [];
      for (const key of keys) {
        try {
          const hash = await redisCluster.hgetall(key);
          if (hash && Object.keys(hash).length > 0) {
            groups.push(this.redisHashToGroup(hash));
          }
        } catch (error) {
          logger.warn(`Failed to get group data for key ${key}:`, error);
        }
      }

      logger.info(`Successfully retrieved ${groups.length} groups for pattern: ${pattern}`);
      return groups;
    } catch (error) {
      logger.error(`Failed to get groups by pattern ${groupName}:${symbol}:`, error);
      return [];
    }
  }

  /**
   * Get all groups for a specific group name (all symbols)
   */
  async getGroupsByName(groupName) {
    return await this.getGroupsByPattern(groupName, '*');
  }

  /**
   * Get specific fields from a group (optimized for partial data)
   */
  async getGroupFields(groupName, symbol, fields) {
    try {
      const key = this.getGroupKey(groupName, symbol);
      const values = await redisCluster.hmget(key, ...fields);
      
      const result = {};
      fields.forEach((field, index) => {
        if (values[index] !== null) {
          result[field] = values[index];
        }
      });

      return Object.keys(result).length > 0 ? result : null;
    } catch (error) {
      logger.error(`Failed to get group fields ${groupName}:${symbol}:`, error);
      return null;
    }
  }

  /**
   * UPDATE: Update group fields in Redis and publish changes
   * Only updates changed fields for efficiency
   */
  async updateGroup(groupName, symbol, updates) {
    try {
      const key = this.getGroupKey(groupName, symbol);
      
      // Prepare updates with metadata (convert values to strings for Redis hash)
      const updateHash = {};
      for (const [field, value] of Object.entries(updates)) {
        updateHash[field] = value !== null && value !== undefined ? value.toString() : '';
      }
      updateHash.updated_at = new Date().toISOString();
      updateHash.cached_at = new Date().toISOString();

      // Update Redis
      await redisCluster.hset(key, updateHash);

      // Publish update notification (similar to user cache pattern)
      const updateNotification = {
        action: 'update',
        group_name: groupName,
        symbol: symbol,
        updated_fields: Object.keys(updates),
        timestamp: Date.now()
      };

      await redisCluster.publish('groups_updates', JSON.stringify(updateNotification));

      logger.info(`Updated group ${groupName}:${symbol} fields: ${Object.keys(updates).join(', ')}`);
      return { success: true, updated_fields: Object.keys(updates) };

    } catch (error) {
      logger.error(`Failed to update group ${groupName}:${symbol}:`, error);
      throw error;
    }
  }

  /**
   * UPDATE: Sync single group from database to Redis
   */
  async syncGroupFromDB(groupId) {
    try {
      const group = await Group.findByPk(groupId);
      if (!group) {
        throw new Error(`Group with ID ${groupId} not found`);
      }

      const key = this.getGroupKey(group.name, group.symbol);
      const hash = this.groupToRedisHash(group);
      
      await redisCluster.hset(key, hash);

      // Publish sync notification (following user cache pattern)
      const syncNotification = {
        action: 'sync',
        group_name: group.name,
        symbol: group.symbol,
        group_id: group.id,
        timestamp: Date.now()
      };

      await redisCluster.publish('groups_updates', JSON.stringify(syncNotification));

      logger.info(`Synced group ${group.name}:${group.symbol} from database`);
      return { success: true, group: this.redisHashToGroup(hash) };

    } catch (error) {
      logger.error(`Failed to sync group ${groupId} from database:`, error);
      throw error;
    }
  }

  /**
   * DELETE: Remove group from Redis cache
   */
  async deleteGroup(groupName, symbol) {
    try {
      const key = this.getGroupKey(groupName, symbol);
      const deleted = await redisCluster.del(key);

      if (deleted > 0) {
        // Publish delete notification
        const deleteNotification = {
          action: 'delete',
          group_name: groupName,
          symbol: symbol,
          timestamp: new Date().toISOString(),
          source_service: process.env.SERVICE_NAME || 'nodejs-service'
        };

        await redisCluster.publish(this.PUBSUB_CHANNEL, JSON.stringify(deleteNotification));
        logger.info(`Deleted group ${groupName}:${symbol} from cache`);
      }

      return { success: true, deleted: deleted > 0 };
    } catch (error) {
      logger.error(`Failed to delete group ${groupName}:${symbol}:`, error);
      throw error;
    }
  }

  /**
   * UTILITY: Load group from database (fallback)
   */
  async loadGroupFromDB(groupName, symbol) {
    try {
      const group = await Group.findOne({
        where: { name: groupName, symbol: symbol }
      });

      if (group) {
        // Cache the loaded group
        const key = this.getGroupKey(group.name, group.symbol);
        const hash = this.groupToRedisHash(group);
        await redisCluster.hset(key, hash);
        
        return this.redisHashToGroup(hash);
      }

      return null;
    } catch (error) {
      logger.error(`Failed to load group from database ${groupName}:${symbol}:`, error);
      return null;
    }
  }

  /**
   * UTILITY: Get cache statistics
   */
  async getCacheStats() {
    try {
      const pattern = `${this.CACHE_PREFIX}:*`;
      
      // Get keys from ALL cluster nodes for accurate count
      let totalKeys = 0;
      try {
        const nodes = redisCluster.nodes('master');
        for (const node of nodes) {
          const nodeKeys = await node.keys(pattern);
          totalKeys += nodeKeys.length;
        }
      } catch (clusterErr) {
        // Fallback to single node
        const keys = await redisCluster.keys(pattern);
        totalKeys = keys.length;
      }
      
      const syncMetadata = await redisCluster.hgetall('groups_sync_metadata');
      
      return {
        total_cached_groups: totalKeys,
        cache_pattern: pattern,
        last_sync: syncMetadata.last_sync || 'Never',
        total_synced: parseInt(syncMetadata.total_synced) || 0,
        sync_duration_ms: parseInt(syncMetadata.sync_duration_ms) || 0,
        sync_version: syncMetadata.sync_version || 'Unknown'
      };
    } catch (error) {
      logger.error('Failed to get cache stats:', error);
      return { error: error.message };
    }
  }

  /**
   * UTILITY: Clear all groups cache (use with caution)
   */
  async clearCache() {
    try {
      const pattern = `${this.CACHE_PREFIX}:*`;
      const keys = await redisCluster.keys(pattern);
      
      if (keys.length > 0) {
        // Delete keys individually for Redis Cluster compatibility
        for (const key of keys) {
          await redisCluster.del(key);
        }
        logger.warn(`Cleared ${keys.length} groups from cache`);
      }

      // Clear sync metadata
      await redisCluster.del('groups_sync_metadata');

      return { success: true, cleared: keys.length };
    } catch (error) {
      logger.error('Failed to clear groups cache:', error);
      throw error;
    }
  }
}

module.exports = new GroupsCacheService();
