const groupsCacheService = require('../services/groups.cache.service');
const startupCacheService = require('../services/startup.cache.service');
const { Group } = require('../models');
const { createAuditLog } = require('../middlewares/audit.middleware');
const logger = require('../utils/logger');
const sequelize = require('../config/db');

/**
 * Groups Controller
 * Handles HTTP requests for group management with Redis caching
 */

class GroupsController {
  /**
   * Get group by name and symbol
   * GET /api/groups/:groupName/:symbol
   */
  async getGroup(req, res) {
    try {
      const { groupName, symbol } = req.params;

      if (!groupName || !symbol) {
        return res.status(400).json({
          success: false,
          message: 'Group name and symbol are required'
        });
      }

      const group = await groupsCacheService.getGroup(groupName, symbol);

      if (!group) {
        return res.status(404).json({
          success: false,
          message: `Group not found: ${groupName}:${symbol}`
        });
      }

      res.status(200).json({
        success: true,
        message: 'Group retrieved successfully',
        data: group
      });

    } catch (error) {
      logger.error(`Failed to get group ${req.params.groupName}:${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Get all groups by name (all symbols)
   * GET /api/groups/:groupName
   */
  async getGroupsByName(req, res) {
    const logger = require('../utils/logger');
    
    try {
      logger.info(`=== CONTROLLER START: getGroupsByName ===`);
    
    // Decode URL-encoded group name (e.g., "Royal+" becomes "Royal ")
    const { groupName: rawGroupName } = req.params;
    const groupName = decodeURIComponent(rawGroupName);

    logger.info(`Raw groupName: "${rawGroupName}", Decoded: "${groupName}"`);

    if (!groupName) {
      logger.warn('Group name is missing or empty');
      return res.status(400).json({
        success: false,
        message: 'Group name is required'
      });
    }

    logger.info(`Searching for groups with name: "${groupName}" (raw: "${rawGroupName}")`);
      
      // First check cache stats to see if cache is populated
      const cacheStats = await groupsCacheService.getCacheStats();
      logger.info(`Cache stats: ${JSON.stringify(cacheStats)}`);

      const groups = await groupsCacheService.getGroupsByName(groupName);
      logger.info(`Found ${groups.length} groups for ${groupName}`);

      // If no groups found in cache, try fallback to database
      if (groups.length === 0) {
        logger.warn(`No groups found in cache for ${groupName}, checking database...`);
        
        const { Group } = require('../models');
        const dbGroups = await Group.findAll({
          where: { name: groupName }
        });
        
        logger.info(`Found ${dbGroups.length} groups in database for ${groupName}`);
        
        if (dbGroups.length > 0) {
          logger.info(`Caching ${dbGroups.length} groups for ${groupName}...`);
          
          // Cache the groups and return them
          for (const group of dbGroups) {
            logger.info(`Syncing group ID ${group.id}: ${group.name}:${group.symbol}`);
            await groupsCacheService.syncGroupFromDB(group.id);
          }
          
          logger.info(`Retrying cache lookup for ${groupName}...`);
          // Retry cache lookup
          const cachedGroups = await groupsCacheService.getGroupsByName(groupName);
          
          logger.info(`After caching, found ${cachedGroups.length} groups for ${groupName}`);
          
          // If cache still returns 0, return the DB groups directly
          const groupsToReturn = cachedGroups.length > 0 ? cachedGroups : dbGroups.map(group => ({
            id: group.id,
            symbol: group.symbol,
            name: group.name,
            spread: group.spread,
            margin: group.margin,
            swap_long: group.swap_long,
            swap_short: group.swap_short,
            lot_size: group.lot_size,
            lot_step: group.lot_step,
            vol_min: group.vol_min,
            vol_max: group.vol_max,
            vol_step: group.vol_step,
            contract_size: group.contract_size,
            tick_size: group.tick_size,
            tick_value: group.tick_value,
            profit_mode: group.profit_mode,
            margin_mode: group.margin_mode,
            margin_initial: group.margin_initial,
            margin_maintenance: group.margin_maintenance,
            session_quote: group.session_quote,
            session_trade: group.session_trade,
            digits: group.digits,
            currency_base: group.currency_base,
            currency_profit: group.currency_profit,
            currency_margin: group.currency_margin,
            color: group.color,
            description: group.description,
            path: group.path,
            category: group.category,
            exchange: group.exchange,
            cfd_mode: group.cfd_mode,
            expiration_mode: group.expiration_mode,
            filling_mode: group.filling_mode,
            order_mode: group.order_mode,
            expiration_time: group.expiration_time,
            spread_balance: group.spread_balance,
            spread_diff: group.spread_diff,
            spread_diff_balance: group.spread_diff_balance,
            tick_flags: group.tick_flags,
            calc_mode: group.calc_mode,
            face_value: group.face_value,
            accrued_interest: group.accrued_interest,
            splice_type: group.splice_type,
            splice_time: group.splice_time,
            splice_time_type: group.splice_time_type,
            ie_check_mode: group.ie_check_mode,
            category_margin: group.category_margin,
            margin_rate_initial: group.margin_rate_initial,
            margin_rate_maintenance: group.margin_rate_maintenance,
            margin_rate_liquidity: group.margin_rate_liquidity,
            margin_hedge: group.margin_hedge,
            margin_divider: group.margin_divider,
            point: group.point,
            multiply: group.multiply,
            bid_tick_value: group.bid_tick_value,
            ask_tick_value: group.ask_tick_value,
            long_only: group.long_only,
            instant_max_volume: group.instant_max_volume,
            margin_currency: group.margin_currency,
            freeze_level: group.freeze_level,
            exemode: group.exemode,
            swap_rollover3days: group.swap_rollover3days,
            margin_liquid: group.margin_liquid,
            profit_calc: group.profit_calc,
            margin_calc: group.margin_calc,
            swap_enable: group.swap_enable,
            swap_type: group.swap_type,
            swap_size: group.swap_size,
            swap_size_long: group.swap_size_long,
            swap_size_short: group.swap_size_short,
            cross_currencies: group.cross_currencies,
            margin_flags: group.margin_flags,
            margin_rate: group.margin_rate
          }));
          
          return res.status(200).json({
            success: true,
            message: `Groups retrieved successfully for ${groupName} (loaded from database)`,
            data: {
              group_name: groupName,
              symbols: groupsToReturn.length,
              groups: groupsToReturn
            }
          });
        } else {
          logger.warn(`No groups found in database for ${groupName}`);
        }
      }

      res.status(200).json({
        success: true,
        message: `Groups retrieved successfully for ${groupName}`,
        data: {
          group_name: groupName,
          symbols: groups.length,
          groups: groups
        }
      });

    } catch (error) {
      logger.error(`Failed to get groups for ${req.params.groupName}:`, error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Get specific fields from a group (optimized for trading calculations)
   * GET /api/groups/:groupName/:symbol/fields?fields=spread,margin,swap_buy
   */
  async getGroupFields(req, res) {
    try {
      const { groupName, symbol } = req.params;
      const { fields } = req.query;

      if (!groupName || !symbol) {
        return res.status(400).json({
          success: false,
          message: 'Group name and symbol are required'
        });
      }

      if (!fields) {
        return res.status(400).json({
          success: false,
          message: 'Fields parameter is required (comma-separated list)'
        });
      }

      const fieldsList = fields.split(',').map(f => f.trim());
      const result = await groupsCacheService.getGroupFields(groupName, symbol, fieldsList);

      if (!result) {
        return res.status(404).json({
          success: false,
          message: `Group not found: ${groupName}:${symbol}`
        });
      }

      res.status(200).json({
        success: true,
        message: 'Group fields retrieved successfully',
        data: {
          group_name: groupName,
          symbol: symbol,
          fields: result
        }
      });

    } catch (error) {
      logger.error(`Failed to get group fields ${req.params.groupName}:${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Update group fields (superadmin only)
   * PUT /api/superadmin/groups/:groupName/:symbol
   */
  async updateGroup(req, res) {
    const transaction = await sequelize.transaction();
    
    try {
      const { groupName, symbol } = req.params;
      const updates = req.body;
      const { admin } = req;

      if (!groupName || !symbol) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Group name and symbol are required'
        });
      }

      if (!updates || Object.keys(updates).length === 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'No update fields provided'
        });
      }

      // Find the group in database
      const group = await Group.findOne({
        where: { name: groupName, symbol: symbol },
        transaction
      });

      if (!group) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Group not found: ${groupName}:${symbol}`
        });
      }

      // Filter allowed fields (exclude id, name, symbol, created_at, updated_at)
      const restrictedFields = ['id', 'name', 'symbol', 'created_at', 'updated_at'];
      const allowedFields = [
        'commision_type', 'commision_value_type', 'type', 'pip_currency', 
        'show_points', 'swap_buy', 'swap_sell', 'commision', 'margin', 
        'spread', 'deviation', 'min_lot', 'max_lot', 'pips', 'spread_pip',
        'contract_size', 'profit'
      ];

      const filteredUpdates = {};
      const originalValues = {};

      for (const [key, value] of Object.entries(updates)) {
        if (!restrictedFields.includes(key)) {
          originalValues[key] = group[key];
          filteredUpdates[key] = value;
        }
      }

      if (Object.keys(filteredUpdates).length === 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'No valid fields to update'
        });
      }

      // Update database
      await group.update(filteredUpdates, { transaction });

      // Update Redis cache
      await groupsCacheService.updateGroup(groupName, symbol, filteredUpdates);

      await transaction.commit();

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUP_UPDATE',
        req.ip,
        {
          group_name: groupName,
          symbol: symbol,
          group_id: group.id,
          updated_fields: Object.keys(filteredUpdates),
          original_values: originalValues,
          new_values: filteredUpdates
        },
        'SUCCESS'
      );

      logger.info(`Group updated by admin ${admin.id}: ${groupName}:${symbol}`);

      res.status(200).json({
        success: true,
        message: 'Group updated successfully',
        data: {
          group_name: groupName,
          symbol: symbol,
          updated_fields: Object.keys(filteredUpdates),
          updated_at: new Date().toISOString()
        }
      });

    } catch (error) {
      await transaction.rollback();
      logger.error(`Failed to update group ${req.params.groupName}:${req.params.symbol}:`, error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'GROUP_UPDATE',
        req.ip,
        {
          group_name: req.params.groupName,
          symbol: req.params.symbol,
          attempted_updates: req.body
        },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Sync group from database to Redis (superadmin only)
   * POST /api/superadmin/groups/sync/:groupId
   */
  async syncGroup(req, res) {
    try {
      const { groupId } = req.params;
      const { admin } = req;

      if (!groupId || isNaN(parseInt(groupId))) {
        return res.status(400).json({
          success: false,
          message: 'Valid group ID is required'
        });
      }

      const result = await groupsCacheService.syncGroupFromDB(parseInt(groupId));

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUP_SYNC',
        req.ip,
        {
          group_id: parseInt(groupId),
          group_name: result.group?.name,
          symbol: result.group?.symbol
        },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Group synced successfully',
        data: result
      });

    } catch (error) {
      logger.error(`Failed to sync group ${req.params.groupId}:`, error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'GROUP_SYNC',
        req.ip,
        { group_id: req.params.groupId },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Get cache statistics (superadmin only)
   * GET /api/superadmin/groups/cache/stats
   */
  async getCacheStats(req, res) {
    try {
      const stats = await groupsCacheService.getCacheStats();

      res.status(200).json({
        success: true,
        message: 'Cache statistics retrieved successfully',
        data: {
          cache_stats: stats,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Failed to get cache stats:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Force re-sync all groups (superadmin only)
   * POST /api/superadmin/groups/cache/resync
   */
  async forceResync(req, res) {
    try {
      const { admin } = req;

      logger.warn(`Force resync requested by admin ${admin.id}`);
      
      const result = await groupsCacheService.syncAllGroupsToRedis();

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUPS_FORCE_RESYNC',
        req.ip,
        { 
          sync_result: result,
          reason: 'Manual force resync'
        },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Groups cache re-sync completed',
        data: result
      });

    } catch (error) {
      logger.error('Failed to force resync groups:', error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'GROUPS_FORCE_RESYNC',
        req.ip,
        { reason: 'Manual force resync' },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Clear groups cache (superadmin only - dangerous operation)
   * DELETE /api/superadmin/groups/cache
   */
  async clearCache(req, res) {
    try {
      const { admin } = req;
      const { confirm } = req.body;

      if (confirm !== 'CLEAR_GROUPS_CACHE') {
        return res.status(400).json({
          success: false,
          message: 'Confirmation required. Send {"confirm": "CLEAR_GROUPS_CACHE"} in request body'
        });
      }

      logger.warn(`Cache clear requested by admin ${admin.id}`);
      
      const result = await groupsCacheService.clearCache();

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUPS_CACHE_CLEAR',
        req.ip,
        { 
          cleared_count: result.cleared,
          reason: 'Manual cache clear'
        },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Groups cache cleared successfully',
        data: result
      });

    } catch (error) {
      logger.error('Failed to clear groups cache:', error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'GROUPS_CACHE_CLEAR',
        req.ip,
        { reason: 'Manual cache clear' },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Delete a specific group symbol (Superadmin only)
   * DELETE /api/superadmin/groups/:groupName/:symbol
   */
  async deleteGroupSymbol(req, res) {
    const transaction = await sequelize.transaction();
    
    try {
      const { groupName, symbol } = req.params;
      const decodedGroupName = decodeURIComponent(groupName);

      if (!decodedGroupName || !symbol) {
        return res.status(400).json({
          success: false,
          message: 'Group name and symbol are required'
        });
      }

      // Check if group exists in database
      const group = await Group.findOne({
        where: { name: decodedGroupName, symbol: symbol },
        transaction
      });

      if (!group) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Group not found: ${decodedGroupName}:${symbol}`
        });
      }

      // Delete from database
      await group.destroy({ transaction });

      // Delete from Redis cache
      await groupsCacheService.deleteGroup(decodedGroupName, symbol);

      await transaction.commit();

      // Create audit log
      await createAuditLog(
        req.admin?.id,
        'GROUP_SYMBOL_DELETE',
        req.ip,
        { 
          group_name: decodedGroupName, 
          symbol: symbol,
          group_id: group.id
        },
        'SUCCESS'
      );

      logger.info(`Superadmin ${req.admin?.id} deleted group symbol: ${decodedGroupName}:${symbol}`);

      res.status(200).json({
        success: true,
        message: `Group symbol deleted successfully: ${decodedGroupName}:${symbol}`,
        data: {
          deleted_group: {
            id: group.id,
            name: decodedGroupName,
            symbol: symbol
          }
        }
      });

    } catch (error) {
      await transaction.rollback();
      logger.error(`Failed to delete group symbol ${req.params.groupName}:${req.params.symbol}:`, error);

      await createAuditLog(
        req.admin?.id,
        'GROUP_SYMBOL_DELETE',
        req.ip,
        { 
          group_name: req.params.groupName, 
          symbol: req.params.symbol
        },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: 'Failed to delete group symbol'
      });
    }
  }

  /**
   * Create a new group symbol record (Superadmin only)
   * POST /api/superadmin/groups
   */
  async createGroupSymbol(req, res) {
    const transaction = await sequelize.transaction();
    
    try {
      const {
        symbol,
        name,
        commision_type = 1,
        commision_value_type = 1,
        type = 1,
        pip_currency = 'USD',
        show_points = 5,
        swap_buy = 0,
        swap_sell = 0,
        commision = 0,
        margin = 100,
        spread = 0,
        deviation = 10,
        min_lot = 0.01,
        max_lot = 100,
        pips = 0.0001,
        spread_pip = 0,
        contract_size = 100000,
        profit = 'currency'
      } = req.body;

      // Validate required fields
      if (!symbol || !name) {
        return res.status(400).json({
          success: false,
          message: 'Symbol and group name are required'
        });
      }

      // Check if group symbol already exists
      const existingGroup = await Group.findOne({
        where: { name: name, symbol: symbol },
        transaction
      });

      if (existingGroup) {
        await transaction.rollback();
        return res.status(409).json({
          success: false,
          message: `Group symbol already exists: ${name}:${symbol}`
        });
      }

      // Create new group in database
      const newGroup = await Group.create({
        symbol,
        name,
        commision_type,
        commision_value_type,
        type,
        pip_currency,
        show_points,
        swap_buy,
        swap_sell,
        commision,
        margin,
        spread,
        deviation,
        min_lot,
        max_lot,
        pips,
        spread_pip,
        contract_size,
        profit
      }, { transaction });

      // Commit transaction first
      await transaction.commit();

      // Add to Redis cache after successful database commit
      await groupsCacheService.syncGroupFromDB(newGroup.id);

      // Create audit log
      await createAuditLog(
        req.admin?.id,
        'GROUP_SYMBOL_CREATE',
        req.ip,
        { 
          group_name: name, 
          symbol: symbol,
          group_id: newGroup.id
        },
        'SUCCESS'
      );

      logger.info(`Superadmin ${req.admin?.id} created group symbol: ${name}:${symbol}`);

      res.status(201).json({
        success: true,
        message: `Group symbol created successfully: ${name}:${symbol}`,
        data: {
          group: {
            id: newGroup.id,
            symbol: newGroup.symbol,
            name: newGroup.name,
            commision_type: newGroup.commision_type,
            commision_value_type: newGroup.commision_value_type,
            type: newGroup.type,
            pip_currency: newGroup.pip_currency,
            show_points: newGroup.show_points,
            swap_buy: newGroup.swap_buy,
            swap_sell: newGroup.swap_sell,
            commision: newGroup.commision,
            margin: newGroup.margin,
            spread: newGroup.spread,
            deviation: newGroup.deviation,
            min_lot: newGroup.min_lot,
            max_lot: newGroup.max_lot,
            pips: newGroup.pips,
            spread_pip: newGroup.spread_pip,
            contract_size: newGroup.contract_size,
            profit: newGroup.profit,
            created_at: newGroup.created_at,
            updated_at: newGroup.updated_at
          }
        }
      });

    } catch (error) {
      await transaction.rollback();
      logger.error('Failed to create group symbol:', error);

      await createAuditLog(
        req.admin?.id,
        'GROUP_SYMBOL_CREATE',
        req.ip,
        { 
          group_name: req.body.name, 
          symbol: req.body.symbol
        },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: 'Failed to create group symbol'
      });
    }
  }
}

module.exports = new GroupsController();
