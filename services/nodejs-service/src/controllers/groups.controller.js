const groupsCacheService = require('../services/groups.cache.service');
const startupCacheService = require('../services/startup.cache.service');
const { Group } = require('../models');
const { createAuditLog } = require('../middlewares/audit.middleware');
const logger = require('../utils/logger');
const sequelize = require('../config/db');
const { Op } = require('sequelize');
const { enforceAdminSecret } = require('../utils/adminSecret.util');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'HttpError';
  }
}

/**
 * Groups Controller
 * Handles HTTP requests for group management with Redis caching
 */

class GroupsController {
  /**
   * Calculate half spread for a group item
   * @param {Object} group - Group object with spread and spread_pip fields
   * @returns {number} - Calculated half spread
   */
  _calculateHalfSpread(group) {
    const spread = parseFloat(group.spread) || 0;
    const spreadPip = parseFloat(group.spread_pip) || 0;
    return (spread * spreadPip) / 2;
  }

  /**
   * Add half spread calculations to groups array for user access
   * @param {Array} groups - Array of group objects
   * @returns {Array} - Groups with half_spread field added
   */
  _addHalfSpreadsToGroups(groups) {
    return groups.map(group => ({
      ...group,
      half_spread: this._calculateHalfSpread(group)
    }));
  }

  /**
   * Fetch unique group names sorted alphabetically
   * @returns {Promise<string[]>}
   */
  async _fetchUniqueGroupNames() {
    const uniqueGroups = await Group.findAll({
      attributes: ['name'],
      group: ['name'],
      order: [['name', 'ASC']]
    });

    return uniqueGroups.map(group => group.name);
  }

  _buildCopyGroupResponse(result) {
    const { sourceGroupName, targetGroupName, newGroups } = result;
    return {
      success: true,
      message: `Successfully copied ${newGroups.length} instruments from ${sourceGroupName} to ${targetGroupName}`,
      data: {
        source_group_name: sourceGroupName,
        target_group_name: targetGroupName,
        instruments_copied: newGroups.length,
        instruments: newGroups.map(group => ({
          id: group.id,
          symbol: group.symbol,
          name: group.name,
          created_at: group.created_at
        }))
      }
    };
  }

  async _copyGroupInstrumentsCore(sourceGroupName, targetGroupName) {
    const trimmedSource = sourceGroupName?.trim();
    const trimmedTarget = targetGroupName?.trim();

    if (!trimmedSource || !trimmedTarget) {
      throw new HttpError(400, 'Source group name and target group name are required');
    }

    if (trimmedSource === trimmedTarget) {
      throw new HttpError(400, 'Source and target group names must be different');
    }

    let transaction;
    try {
      transaction = await sequelize.transaction();

      const sourceGroups = await Group.findAll({
        where: { name: trimmedSource },
        transaction
      });

      if (sourceGroups.length === 0) {
        throw new HttpError(404, `Source group not found: ${trimmedSource}`);
      }

      const existingTargetGroups = await Group.findAll({
        where: { name: trimmedTarget },
        transaction
      });

      if (existingTargetGroups.length > 0) {
        throw new HttpError(
          409,
          `Target group already exists: ${trimmedTarget}. Found ${existingTargetGroups.length} instruments.`
        );
      }

      const newGroups = [];
      for (const sourceGroup of sourceGroups) {
        const groupData = {
          symbol: sourceGroup.symbol,
          name: trimmedTarget,
          commision_type: sourceGroup.commision_type,
          commision_value_type: sourceGroup.commision_value_type,
          type: sourceGroup.type,
          pip_currency: sourceGroup.pip_currency,
          show_points: sourceGroup.show_points,
          swap_buy: sourceGroup.swap_buy,
          swap_sell: sourceGroup.swap_sell,
          commision: sourceGroup.commision,
          margin: sourceGroup.margin,
          spread: sourceGroup.spread,
          deviation: sourceGroup.deviation,
          min_lot: sourceGroup.min_lot,
          max_lot: sourceGroup.max_lot,
          pips: sourceGroup.pips,
          spread_pip: sourceGroup.spread_pip,
          contract_size: sourceGroup.contract_size,
          profit: sourceGroup.profit
        };

        const newGroup = await Group.create(groupData, { transaction });
        newGroups.push(newGroup);
      }

      await transaction.commit();

      for (const newGroup of newGroups) {
        await groupsCacheService.syncGroupFromDB(newGroup.id);
      }

      return {
        sourceGroupName: trimmedSource,
        targetGroupName: trimmedTarget,
        newGroups
      };
    } catch (error) {
      if (transaction) {
        await transaction.rollback().catch(rollbackError => {
          logger.error('Rollback failed in _copyGroupInstrumentsCore', rollbackError);
        });
      }

      if (error instanceof HttpError) {
        throw error;
      }

      logger.error('_copyGroupInstrumentsCore failed', error);
      throw new HttpError(500, 'Failed to copy group instruments');
    }
  }

  async _updateGroupFieldsCore(groupName, symbol, updates) {
    if (!groupName || !symbol) {
      throw new HttpError(400, 'Group name and symbol are required');
    }

    if (!updates || Object.keys(updates).length === 0) {
      throw new HttpError(400, 'No update fields provided');
    }

    const restrictedFields = ['id', 'name', 'symbol', 'created_at', 'updated_at'];
    const allowedFields = [
      'commision_type', 'commision_value_type', 'type', 'pip_currency',
      'show_points', 'swap_buy', 'swap_sell', 'commision', 'margin',
      'spread', 'deviation', 'min_lot', 'max_lot', 'pips', 'spread_pip',
      'contract_size', 'profit'
    ];

    let transaction;
    try {
      transaction = await sequelize.transaction();

      const group = await Group.findOne({
        where: { name: groupName, symbol },
        transaction
      });

      if (!group) {
        throw new HttpError(404, `Group not found: ${groupName}:${symbol}`);
      }

      const filteredUpdates = {};
      const originalValues = {};

      for (const [key, value] of Object.entries(updates)) {
        if (restrictedFields.includes(key)) {
          continue;
        }
        if (allowedFields.includes(key)) {
          filteredUpdates[key] = value;
          originalValues[key] = group[key];
        }
      }

      if (Object.keys(filteredUpdates).length === 0) {
        throw new HttpError(400, 'No valid fields to update');
      }

      await group.update(filteredUpdates, { transaction });
      await transaction.commit();

      await groupsCacheService.updateGroup(groupName, symbol, filteredUpdates);

      return {
        group,
        filteredUpdates,
        originalValues
      };
    } catch (error) {
      if (transaction) {
        await transaction.rollback().catch((rollbackError) => {
          logger.error('Rollback failed in _updateGroupFieldsCore', rollbackError);
        });
      }

      if (error instanceof HttpError) {
        throw error;
      }

      logger.error('_updateGroupFieldsCore failed', error);
      throw new HttpError(500, 'Failed to update group');
    }
  }

  async _createGroupSymbolCore(payload) {
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
      } = payload || {};

      if (!symbol || !name) {
        throw new HttpError(400, 'Symbol and group name are required');
      }

      const existingGroup = await Group.findOne({
        where: { name, symbol },
        transaction
      });

      if (existingGroup) {
        throw new HttpError(409, `Group symbol already exists: ${name}:${symbol}`);
      }

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

      await transaction.commit();

      await groupsCacheService.syncGroupFromDB(newGroup.id);

      return newGroup;
    } catch (error) {
      await transaction.rollback().catch((rollbackError) => {
        logger.error('Rollback failed in _createGroupSymbolCore', rollbackError);
      });

      if (error instanceof HttpError) {
        throw error;
      }

      logger.error('_createGroupSymbolCore failed', error);
      throw new HttpError(500, 'Failed to create group symbol');
    }
  }
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
   * Get groups dropdown via admin secret (no JWT)
   * GET /api/admin-secret/groups/dropdown
   */
  async getGroupsDropdownAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

    try {
      const groupNames = await this._fetchUniqueGroupNames();

      logger.info(
        `Admin-secret dropdown accessed - ${groupNames.length} groups returned`
      );

      return res.status(200).json({
        success: true,
        message: 'Groups dropdown retrieved successfully',
        data: {
          total_groups: groupNames.length,
          groups: groupNames
        }
      });
    } catch (error) {
      logger.error('Failed to get groups dropdown via admin secret:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch groups dropdown'
      });
    }
  }

  /**
   * Admin-secret protected group lookup by group name
   * GET /api/admin-secret/groups/:groupName
   */
  async getGroupByNameAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

    try {
      const { groupName } = req.params;
      const { search } = req.query;
      const decodedGroupName = decodeURIComponent(groupName || '').trim();

      if (!decodedGroupName) {
        return res.status(400).json({
          success: false,
          message: 'Group name is required'
        });
      }

      const baseQuery = {
        where: { name: decodedGroupName },
        order: [['symbol', 'ASC']]
      };

      if (search && search.trim().length > 0) {
        baseQuery.where.symbol = { [Op.iLike]: `%${search.trim()}%` };
      }

      const groups = await Group.findAll(baseQuery);

      if (!groups || groups.length === 0) {
        return res.status(404).json({
          success: false,
          message: `No group configuration found for ${decodedGroupName}`
        });
      }

      return res.status(200).json({
        success: true,
        message: `Group configuration retrieved for ${decodedGroupName}`,
        data: {
          group_name: decodedGroupName,
          symbols: groups.length,
          groups: groups.map((group) => group.toJSON())
        }
      });
    } catch (error) {
      logger.error('getGroupByNameAdminSecret failed', { error: error.message, stack: error.stack });
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch group configuration'
      });
    }
  }

  /**
   * Get all groups by name (all symbols)
   * GET /api/groups/admin/:groupName (admin access)
   * GET /api/groups/my-group (user access - gets group from JWT)
   */
  async getGroupsByName(req, res) {
    const logger = require('../utils/logger');
    
    try {
      logger.info(`=== CONTROLLER START: getGroupsByName ===`);
    
      let groupName;
      let isUserAccess = false;
      
      // Check if this is user access (my-group route) or admin access
      if (req.route.path === '/my-group') {
        isUserAccess = true;
        // Extract group from JWT for users (supports live users, strategy providers, and copy followers)
        const user = req.user;
        if (!user || !user.group) {
          logger.warn('User group not found in JWT token', { 
            userId: user?.sub || user?.user_id || user?.id,
            userType: user?.user_type || user?.account_type,
            role: user?.role,
            strategyProviderId: user?.strategy_provider_id
          });
          return res.status(400).json({
            success: false,
            message: 'User group information not available'
          });
        }
        groupName = user.group;
        
        // Log user type for debugging
        const userType = user.account_type || user.user_type || 'live';
        const userId = user.sub || user.user_id || user.id;
        const strategyProviderId = user.strategy_provider_id;
        
        logger.info(`User access: extracting group from JWT: "${groupName}"`, {
          userId,
          userType,
          role: user.role,
          strategyProviderId,
          accountType: user.account_type
        });
      } else {
        // Admin access - get group from URL parameter
        const { groupName: rawGroupName } = req.params;
        groupName = decodeURIComponent(rawGroupName);
        logger.info(`Admin access: Raw groupName: "${rawGroupName}", Decoded: "${groupName}"`);
        
        if (!groupName) {
          logger.warn('Group name is missing or empty');
          return res.status(400).json({
            success: false,
            message: 'Group name is required'
          });
        }
      }

      const accessType = isUserAccess ? 'USER' : 'ADMIN';
      logger.info(`[${accessType}] Searching for groups with name: "${groupName}"`);
      
      // First check cache stats to see if cache is populated
      const cacheStats = await groupsCacheService.getCacheStats();
      logger.info(`Cache stats: ${JSON.stringify(cacheStats)}`);

      const groups = await groupsCacheService.getGroupsByName(groupName);
      logger.info(`[${accessType}] Found ${groups.length} groups for ${groupName}`);

      // If no groups found in cache, try fallback to database
      if (groups.length === 0) {
        logger.warn(`[${accessType}] No groups found in cache for ${groupName}, checking database...`);
        
        const { Group } = require('../models');
        const dbGroups = await Group.findAll({
          where: { name: groupName }
        });
        
        logger.info(`[${accessType}] Found ${dbGroups.length} groups in database for ${groupName}`);
        
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
          let groupsToReturn = cachedGroups.length > 0 ? cachedGroups : dbGroups.map(group => ({
            id: group.id,
            symbol: group.symbol,
            name: group.name,
            spread: group.spread,
            spread_pip: group.spread_pip,
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
          
          // Add half_spread calculations for user access
          if (isUserAccess) {
            groupsToReturn = groupsToReturn.map(group => {
              const spread = parseFloat(group.spread) || 0;
              const spreadPip = parseFloat(group.spread_pip) || 0;
              return {
                ...group,
                half_spread: (spread * spreadPip) / 2
              };
            });
          }
          
          if (isUserAccess) {
            return res.status(200).json(groupsToReturn);
          }
          
          return res.status(200).json({
            success: true,
            message: `Groups retrieved successfully for ${groupName} (loaded from database)`,
            data: {
              group_name: groupName,
              symbols: groupsToReturn.length,
              groups: groupsToReturn,
              access_type: accessType.toLowerCase()
            }
          });
        } else {
          logger.warn(`[${accessType}] No groups found in database for ${groupName}`);
          return res.status(404).json({
            success: false,
            message: `No groups found for ${groupName}`,
            data: {
              group_name: groupName,
              access_type: accessType.toLowerCase()
            }
          });
        }
      }

      // Add half_spread calculations for user access
      let finalGroups = groups;
      if (isUserAccess) {
        finalGroups = groups.map(group => {
          const spread = parseFloat(group.spread) || 0;
          const spreadPip = parseFloat(group.spread_pip) || 0;
          return {
            ...group,
            half_spread: (spread * spreadPip) / 2
          };
        });
      }
      
      if (isUserAccess) {
        return res.status(200).json(finalGroups);
      }
      
      res.status(200).json({
        success: true,
        message: `Groups retrieved successfully for ${groupName}`,
        data: {
          group_name: groupName,
          symbols: finalGroups.length,
          groups: finalGroups,
          access_type: accessType.toLowerCase()
        }
      });

    } catch (error) {
      const groupParam = req.params.groupName || 'user-group-from-jwt';
      logger.error(`Failed to get groups for ${groupParam}:`, error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Get half spreads for user's group
   * GET /api/groups/half-spreads
   */
  async getHalfSpreads(req, res) {
    const logger = require('../utils/logger');
    const { redisCluster } = require('../../config/redis');
    
    try {
      logger.info('=== CONTROLLER START: getHalfSpreads ===');
      
      // Extract group from JWT (supports live users, strategy providers, and copy followers)
      const user = req.user;
      if (!user || !user.group) {
        logger.warn('User group not found in JWT token', { 
          userId: user?.sub || user?.user_id || user?.id,
          userType: user?.user_type || user?.account_type,
          role: user?.role,
          strategyProviderId: user?.strategy_provider_id
        });
        return res.status(400).json({
          success: false,
          message: 'User group information not available'
        });
      }
      
      const groupName = user.group;
      const userType = user.account_type || user.user_type || 'live';
      const userId = user.sub || user.user_id || user.id;
      
      logger.info(`User group from JWT: "${groupName}"`, {
        userId,
        userType,
        role: user.role,
        strategyProviderId: user.strategy_provider_id,
        accountType: user.account_type
      });
      
      // Scan for keys matching groups:{groupName}:*
      const pattern = `groups:{${groupName}}:*`;
      logger.info(`Scanning Redis cluster for pattern: ${pattern}`);
      
      let allKeys = [];
      
      try {
        // Try to get keys from all cluster nodes
        const nodes = redisCluster.nodes('master');
        for (const node of nodes) {
          try {
            const nodeKeys = await node.keys(pattern);
            allKeys = allKeys.concat(nodeKeys);
            logger.info(`Found ${nodeKeys.length} keys on node ${node.options.host}:${node.options.port}`);
          } catch (nodeError) {
            logger.warn(`Failed to scan node ${node.options.host}:${node.options.port}:`, nodeError);
          }
        }
      } catch (clusterError) {
        logger.warn('Cluster scan failed, trying single node scan:', clusterError);
        // Fallback to single node scan
        allKeys = await redisCluster.keys(pattern);
      }
      
      logger.info(`Total keys found across cluster: ${allKeys.length}`);
      
      if (allKeys.length === 0) {
        // Fallback to database if no keys found in Redis
        logger.warn(`No Redis keys found for group ${groupName}, checking database...`);
        
        const { Group } = require('../models');
        const dbGroups = await Group.findAll({
          where: { name: groupName },
          attributes: ['symbol', 'spread', 'spread_pip']
        });
        
        if (dbGroups.length === 0) {
          return res.status(404).json({
            success: false,
            message: `No instruments found for group: ${groupName}`
          });
        }
        
        // Calculate half spreads from database data
        const halfSpreads = {};
        for (const group of dbGroups) {
          const spread = parseFloat(group.spread) || 0;
          const spreadPip = parseFloat(group.spread_pip) || 0;
          halfSpreads[group.symbol] = (spread * spreadPip)/2;
        }
        
        return res.status(200).json({
          success: true,
          message: 'Half spreads calculated successfully (from database)',
          data: {
            group_name: groupName,
            total_instruments: dbGroups.length,
            half_spreads: halfSpreads
          }
        });
      }
      
      // Process Redis keys to calculate half spreads
      const halfSpreads = {};
      let processedCount = 0;
      
      for (const key of allKeys) {
        try {
          // Extract symbol from key: groups:{groupName}:SYMBOL
          const keyParts = key.split(':');
          const symbol = keyParts[keyParts.length - 1];
          
          // Fetch spread and spread_pip fields
          const fields = await redisCluster.hmget(key, 'spread', 'spread_pip');
          const [spread, spreadPip] = fields;
          
          if (spread !== null && spreadPip !== null) {
            const spreadValue = parseFloat(spread) || 0;
            const spreadPipValue = parseFloat(spreadPip) || 0;
            const halfSpread = (spreadValue * spreadPipValue) / 2;
            
            halfSpreads[symbol] = halfSpread;
            processedCount++;
            
            logger.debug(`${symbol}: spread=${spreadValue}, spread_pip=${spreadPipValue}, half_spread=${halfSpread}`);
          } else {
            logger.warn(`Missing spread/spread_pip data for ${symbol} in key ${key}`);
          }
        } catch (keyError) {
          logger.warn(`Failed to process key ${key}:`, keyError);
        }
      }
      
      logger.info(`Successfully processed ${processedCount}/${allKeys.length} instruments for group ${groupName}`);
      
      res.status(200).json({
        success: true,
        message: 'Half spreads calculated successfully',
        data: {
          group_name: groupName,
          total_instruments: processedCount,
          half_spreads: halfSpreads
        }
      });
      
    } catch (error) {
      logger.error('Failed to calculate half spreads:', error);
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
   * Delete entire group with all instruments (Superadmin only)
   * DELETE /api/superadmin/groups/:groupName
   */
  async deleteEntireGroup(req, res) {
    const transaction = await sequelize.transaction();
    
    try {
      const { groupName } = req.params;
      const decodedGroupName = decodeURIComponent(groupName);
      const { admin } = req;

      if (!decodedGroupName) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Group name is required'
        });
      }

      // Find all instruments in the group
      const groupInstruments = await Group.findAll({
        where: { name: decodedGroupName },
        transaction
      });

      if (groupInstruments.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Group not found: ${decodedGroupName}`
        });
      }

      // Store group info for audit log before deletion
      const instrumentsToDelete = groupInstruments.map(group => ({
        id: group.id,
        symbol: group.symbol,
        name: group.name
      }));

      // Delete all instruments from database
      await Group.destroy({
        where: { name: decodedGroupName },
        transaction
      });

      // Commit transaction first
      await transaction.commit();

      // Delete all instruments from Redis cache
      for (const instrument of instrumentsToDelete) {
        await groupsCacheService.deleteGroup(instrument.name, instrument.symbol);
      }

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUP_DELETE_ENTIRE',
        req.ip,
        {
          group_name: decodedGroupName,
          instruments_deleted: instrumentsToDelete.length,
          deleted_instruments: instrumentsToDelete
        },
        'SUCCESS'
      );

      logger.info(`Superadmin ${admin.id} deleted entire group: ${decodedGroupName} (${instrumentsToDelete.length} instruments)`);

      res.status(200).json({
        success: true,
        message: `Successfully deleted entire group: ${decodedGroupName} (${instrumentsToDelete.length} instruments)`,
        data: {
          group_name: decodedGroupName,
          instruments_deleted: instrumentsToDelete.length,
          deleted_instruments: instrumentsToDelete
        }
      });

    } catch (error) {
      await transaction.rollback();
      logger.error(`Failed to delete entire group ${req.params.groupName}:`, error);

      await createAuditLog(
        req.admin?.id,
        'GROUP_DELETE_ENTIRE',
        req.ip,
        {
          group_name: req.params.groupName
        },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: 'Failed to delete entire group'
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
   * Copy all instruments from an existing group to a new group (Superadmin only)
   * POST /api/superadmin/groups/copy
   */
  async copyGroupInstruments(req, res) {
    const transaction = await sequelize.transaction();
    
    try {
      const { sourceGroupName, targetGroupName } = req.body;
      const { admin } = req;

      // Validate required fields
      if (!sourceGroupName || !targetGroupName) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Source group name and target group name are required'
        });
      }

      if (sourceGroupName === targetGroupName) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Source and target group names must be different'
        });
      }

      // Check if source group exists
      const sourceGroups = await Group.findAll({
        where: { name: sourceGroupName },
        transaction
      });

      if (sourceGroups.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Source group not found: ${sourceGroupName}`
        });
      }

      // Check if target group already exists
      const existingTargetGroups = await Group.findAll({
        where: { name: targetGroupName },
        transaction
      });

      if (existingTargetGroups.length > 0) {
        await transaction.rollback();
        return res.status(409).json({
          success: false,
          message: `Target group already exists: ${targetGroupName}. Found ${existingTargetGroups.length} instruments.`
        });
      }

      // Copy all instruments from source to target group
      const newGroups = [];
      for (const sourceGroup of sourceGroups) {
        const groupData = {
          symbol: sourceGroup.symbol,
          name: targetGroupName, // Use new group name
          commision_type: sourceGroup.commision_type,
          commision_value_type: sourceGroup.commision_value_type,
          type: sourceGroup.type,
          pip_currency: sourceGroup.pip_currency,
          show_points: sourceGroup.show_points,
          swap_buy: sourceGroup.swap_buy,
          swap_sell: sourceGroup.swap_sell,
          commision: sourceGroup.commision,
          margin: sourceGroup.margin,
          spread: sourceGroup.spread,
          deviation: sourceGroup.deviation,
          min_lot: sourceGroup.min_lot,
          max_lot: sourceGroup.max_lot,
          pips: sourceGroup.pips,
          spread_pip: sourceGroup.spread_pip,
          contract_size: sourceGroup.contract_size,
          profit: sourceGroup.profit
        };

        const newGroup = await Group.create(groupData, { transaction });
        newGroups.push(newGroup);
      }

      // Commit transaction first
      await transaction.commit();

      // Sync all new groups to Redis cache
      for (const newGroup of newGroups) {
        await groupsCacheService.syncGroupFromDB(newGroup.id);
      }

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUP_COPY_INSTRUMENTS',
        req.ip,
        {
          source_group_name: sourceGroupName,
          target_group_name: targetGroupName,
          instruments_copied: newGroups.length,
          copied_group_ids: newGroups.map(g => g.id)
        },
        'SUCCESS'
      );

      logger.info(`Superadmin ${admin.id} copied ${newGroups.length} instruments from ${sourceGroupName} to ${targetGroupName}`);

      res.status(201).json({
        success: true,
        message: `Successfully copied ${newGroups.length} instruments from ${sourceGroupName} to ${targetGroupName}`,
        data: {
          source_group_name: sourceGroupName,
          target_group_name: targetGroupName,
          instruments_copied: newGroups.length,
          instruments: newGroups.map(group => ({
            id: group.id,
            symbol: group.symbol,
            name: group.name,
            created_at: group.created_at
          }))
        }
      });

    } catch (error) {
      await transaction.rollback();
      logger.error('Failed to copy group instruments:', error);

      await createAuditLog(
        req.admin?.id,
        'GROUP_COPY_INSTRUMENTS',
        req.ip,
        {
          source_group_name: req.body.sourceGroupName,
          target_group_name: req.body.targetGroupName
        },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: 'Failed to copy group instruments'
      });
    }
  }

  /**
   * Get all unique group names for dropdown (Superadmin only)
   * GET /api/superadmin/groups/dropdown
   */
  async getGroupsDropdown(req, res) {
    try {
      const { admin } = req;

      const groupNames = await this._fetchUniqueGroupNames();

      // Create audit log
      await createAuditLog(
        admin.id,
        'GROUPS_DROPDOWN_ACCESS',
        req.ip,
        {
          total_groups: groupNames.length,
          accessed_for: 'frontend_dropdown'
        },
        'SUCCESS'
      );

      logger.info(`Superadmin ${admin.id} accessed groups dropdown - ${groupNames.length} groups`);

      res.status(200).json({
        success: true,
        message: 'Groups dropdown retrieved successfully',
        data: {
          total_groups: groupNames.length,
          groups: groupNames
        }
      });

    } catch (error) {
      logger.error('Failed to get groups dropdown:', error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'GROUPS_DROPDOWN_ACCESS',
        req.ip,
        { accessed_for: 'frontend_dropdown' },
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: 'Internal server error'
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

  /**
   * Clear cache and resync all groups from database
   * POST /api/admin/groups/cache/refresh
   */
  async refreshCache(req, res) {
    try {
      logger.info('Admin initiated groups cache refresh', { admin_id: req.admin?.id });

      // Clear existing cache
      const clearResult = await groupsCacheService.clearCache();
      logger.info(`Cleared ${clearResult.cleared} groups from cache`);

      // Resync from database
      const syncResult = await groupsCacheService.syncFromDatabase();
      logger.info(`Resynced ${syncResult.synced} groups to cache`);

      await createAuditLog(
        req.admin?.id,
        'GROUPS_CACHE_REFRESH',
        req.ip,
        { 
          cleared_count: clearResult.cleared,
          synced_count: syncResult.synced
        },
        'SUCCESS'
      );

      res.json({
        success: true,
        message: 'Groups cache refreshed successfully',
        data: {
          cleared: clearResult.cleared,
          synced: syncResult.synced,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Failed to refresh groups cache:', error);

      await createAuditLog(
        req.admin?.id,
        'GROUPS_CACHE_REFRESH',
        req.ip,
        {},
        'FAILED',
        error.message
      );

      res.status(500).json({
        success: false,
        message: 'Failed to refresh groups cache',
        error: error.message
      });
    }
  }

  /**
   * Copy group instruments via admin secret (no JWT)
   * POST /api/admin-secret/groups/copy
   */
  async copyGroupInstrumentsAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

    try {
      const { sourceGroupName, targetGroupName } = req.body;
      const result = await this._copyGroupInstrumentsCore(sourceGroupName, targetGroupName);

      logger.info(
        `[ADMIN_SECRET] Copied ${result.newGroups.length} instruments from ${result.sourceGroupName} to ${result.targetGroupName}`
      );

      return res.status(201).json(this._buildCopyGroupResponse(result));
    } catch (error) {
      logger.error('Admin-secret copyGroupInstruments failed:', error);

      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to copy group instruments'
      });
    }
  }

  /**
   * Get single group instrument via admin secret
   * GET /api/admin-secret/groups/:groupName/:symbol
   */
  async getGroupBySymbolAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

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
          message: `No group configuration found for ${groupName}:${symbol}`
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Group instrument retrieved successfully',
        data: group
      });
    } catch (error) {
      logger.error('Admin-secret getGroupBySymbol failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch group instrument'
      });
    }
  }

  /**
   * Search groups via admin secret with optional filters
   * GET /api/admin-secret/groups (query params: q, groupName, symbol, limit)
   */
  async searchGroupsAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

    try {
      const { q, groupName, symbol, limit = 20 } = req.query;

      const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const searchFilters = [];

      if (groupName) {
        searchFilters.push({
          name: { [Op.iLike]: `%${groupName.trim()}%` }
        });
      }

      if (symbol) {
        searchFilters.push({
          symbol: { [Op.iLike]: `%${symbol.trim()}%` }
        });
      }

      if (q) {
        const term = q.trim();
        searchFilters.push({
          [Op.or]: [
            { name: { [Op.iLike]: `%${term}%` } },
            { symbol: { [Op.iLike]: `%${term}%` } }
          ]
        });
      }

      const whereClause = searchFilters.length > 0 ? { [Op.and]: searchFilters } : {};

      const groups = await Group.findAll({
        where: whereClause,
        order: [['name', 'ASC'], ['symbol', 'ASC']],
        limit: parsedLimit
      });

      return res.status(200).json({
        success: true,
        message: 'Groups search completed successfully',
        data: {
          results: groups,
          count: groups.length,
          limit: parsedLimit
        }
      });
    } catch (error) {
      logger.error('Admin-secret searchGroups failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to search groups'
      });
    }
  }

  /**
   * Update group fields via admin secret (no JWT)
   * PUT /api/admin-secret/groups/:groupName/:symbol
   */
  async updateGroupAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

    try {
      const { groupName, symbol } = req.params;
      const updates = req.body;

      const result = await this._updateGroupFieldsCore(groupName, symbol, updates);

      return res.status(200).json({
        success: true,
        message: 'Group updated successfully',
        data: {
          group_name: groupName,
          symbol,
          updated_fields: Object.keys(result.filteredUpdates),
          original_values: result.originalValues,
          new_values: result.filteredUpdates
        }
      });
    } catch (error) {
      logger.error('Admin-secret updateGroup failed:', error);

      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to update group'
      });
    }
  }

  /**
   * Create group symbol via admin secret (no JWT)
   * POST /api/admin-secret/groups
   */
  async createGroupSymbolAdminSecret(req, res) {
    if (!enforceAdminSecret(req, res)) {
      return;
    }

    try {
      const newGroup = await this._createGroupSymbolCore(req.body);

      return res.status(201).json({
        success: true,
        message: `Group symbol created successfully: ${newGroup.name}:${newGroup.symbol}`,
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
      logger.error('Admin-secret createGroupSymbol failed:', error);

      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to create group symbol'
      });
    }
  }
}

module.exports = new GroupsController();
