const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const LiveUser = require('../models/liveUser.model');
const logger = require('./logger.service');
const { Op } = require('sequelize');

class SuperadminFreePassService {

  /**
   * Grant catalog free pass to a strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @param {number} adminId - Admin ID granting the free pass
   * @param {string} reason - Reason for granting free pass
   * @returns {Object} Grant result
   */
  static async grantCatalogFreePass(strategyProviderId, adminId, reason) {
    try {
      // Find strategy provider
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId, {
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email']
        }]
      });

      if (!strategyProvider) {
        throw new Error('Strategy provider not found');
      }

      // Check if already has free pass
      if (strategyProvider.catalog_free_pass) {
        return {
          success: false,
          message: 'Strategy provider already has catalog free pass',
          current_status: {
            granted_by: strategyProvider.catalog_free_pass_granted_by,
            granted_at: strategyProvider.catalog_free_pass_granted_at,
            reason: strategyProvider.catalog_free_pass_reason
          }
        };
      }

      // Grant free pass
      await strategyProvider.update({
        catalog_free_pass: true,
        catalog_free_pass_granted_by: adminId,
        catalog_free_pass_granted_at: new Date(),
        catalog_free_pass_reason: reason,
        is_catalog_eligible: true  // Automatically make eligible
      });

      logger.info('Catalog free pass granted', {
        strategyProviderId,
        strategyName: strategyProvider.strategy_name,
        adminId,
        reason,
        ownerEmail: strategyProvider.owner?.email
      });

      return {
        success: true,
        message: 'Catalog free pass granted successfully',
        data: {
          strategy_provider_id: strategyProviderId,
          strategy_name: strategyProvider.strategy_name,
          granted_by: adminId,
          granted_at: new Date(),
          reason: reason,
          owner: strategyProvider.owner
        }
      };

    } catch (error) {
      logger.error('Failed to grant catalog free pass', {
        strategyProviderId,
        adminId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Revoke catalog free pass from a strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @param {number} adminId - Admin ID revoking the free pass
   * @returns {Object} Revoke result
   */
  static async revokeCatalogFreePass(strategyProviderId, adminId) {
    try {
      // Find strategy provider
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId, {
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email']
        }]
      });

      if (!strategyProvider) {
        throw new Error('Strategy provider not found');
      }

      // Check if has free pass
      if (!strategyProvider.catalog_free_pass) {
        return {
          success: false,
          message: 'Strategy provider does not have catalog free pass'
        };
      }

      // Store previous free pass info for logging
      const previousGrantInfo = {
        granted_by: strategyProvider.catalog_free_pass_granted_by,
        granted_at: strategyProvider.catalog_free_pass_granted_at,
        reason: strategyProvider.catalog_free_pass_reason
      };

      // Revoke free pass
      await strategyProvider.update({
        catalog_free_pass: false,
        catalog_free_pass_granted_by: null,
        catalog_free_pass_granted_at: null,
        catalog_free_pass_reason: null,
        // Note: Don't automatically set is_catalog_eligible to false
        // Let the cron job determine eligibility based on normal criteria
      });

      logger.info('Catalog free pass revoked', {
        strategyProviderId,
        strategyName: strategyProvider.strategy_name,
        revokedBy: adminId,
        previousGrantInfo,
        ownerEmail: strategyProvider.owner?.email
      });

      return {
        success: true,
        message: 'Catalog free pass revoked successfully',
        data: {
          strategy_provider_id: strategyProviderId,
          strategy_name: strategyProvider.strategy_name,
          revoked_by: adminId,
          revoked_at: new Date(),
          previous_grant: previousGrantInfo,
          owner: strategyProvider.owner
        }
      };

    } catch (error) {
      logger.error('Failed to revoke catalog free pass', {
        strategyProviderId,
        adminId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all strategy providers with catalog free pass
   * @param {Object} filters - Filter options
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Object} Paginated list of free pass accounts
   */
  static async getFreePassAccounts(filters = {}, page = 1, limit = 20) {
    try {
      // Validate pagination
      const pageNum = Math.max(1, parseInt(page) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
      const offset = (pageNum - 1) * limitNum;

      // Build where conditions
      const whereConditions = {
        catalog_free_pass: true
      };

      // Apply filters
      if (filters.search) {
        whereConditions.strategy_name = {
          [Op.iLike]: `%${filters.search}%`
        };
      }

      if (filters.granted_by) {
        whereConditions.catalog_free_pass_granted_by = parseInt(filters.granted_by);
      }

      // Execute query
      const { count, rows } = await StrategyProviderAccount.findAndCountAll({
        where: whereConditions,
        attributes: [
          'id',
          'strategy_name',
          'total_return_percentage',
          'total_followers',
          'catalog_free_pass_granted_by',
          'catalog_free_pass_granted_at',
          'catalog_free_pass_reason',
          'is_catalog_eligible',
          'status',
          'is_active'
        ],
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email']
        }],
        order: [['catalog_free_pass_granted_at', 'DESC']],
        limit: limitNum,
        offset: offset,
        distinct: true
      });

      // Format response
      const freePassAccounts = rows.map(strategy => ({
        id: strategy.id,
        strategy_name: strategy.strategy_name,
        total_return_percentage: parseFloat(strategy.total_return_percentage || 0),
        total_followers: strategy.total_followers || 0,
        free_pass: {
          granted_by: strategy.catalog_free_pass_granted_by,
          granted_at: strategy.catalog_free_pass_granted_at,
          reason: strategy.catalog_free_pass_reason
        },
        is_catalog_eligible: strategy.is_catalog_eligible,
        status: strategy.status,
        is_active: strategy.is_active,
        owner: strategy.owner
      }));

      return {
        free_pass_accounts: freePassAccounts,
        pagination: {
          current_page: pageNum,
          per_page: limitNum,
          total_items: count,
          total_pages: Math.ceil(count / limitNum),
          has_next_page: pageNum < Math.ceil(count / limitNum),
          has_prev_page: pageNum > 1
        },
        filters_applied: filters
      };

    } catch (error) {
      logger.error('Failed to get free pass accounts', {
        filters,
        page,
        limit,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get free pass history/audit log for a specific strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Free pass history
   */
  static async getFreePassHistory(strategyProviderId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId, {
        attributes: [
          'id',
          'strategy_name',
          'catalog_free_pass',
          'catalog_free_pass_granted_by',
          'catalog_free_pass_granted_at',
          'catalog_free_pass_reason',
          'is_catalog_eligible'
        ],
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email']
        }]
      });

      if (!strategyProvider) {
        throw new Error('Strategy provider not found');
      }

      return {
        strategy_provider: {
          id: strategyProvider.id,
          strategy_name: strategyProvider.strategy_name,
          owner: strategyProvider.owner
        },
        current_free_pass_status: {
          has_free_pass: strategyProvider.catalog_free_pass,
          granted_by: strategyProvider.catalog_free_pass_granted_by,
          granted_at: strategyProvider.catalog_free_pass_granted_at,
          reason: strategyProvider.catalog_free_pass_reason,
          is_catalog_eligible: strategyProvider.is_catalog_eligible
        }
      };

    } catch (error) {
      logger.error('Failed to get free pass history', {
        strategyProviderId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get free pass statistics
   * @returns {Object} Statistics
   */
  static async getFreePassStatistics() {
    try {
      const totalFreePass = await StrategyProviderAccount.count({
        where: { catalog_free_pass: true }
      });

      const activeFreePass = await StrategyProviderAccount.count({
        where: { 
          catalog_free_pass: true,
          status: 1,
          is_active: 1
        }
      });

      const totalEligible = await StrategyProviderAccount.count({
        where: { 
          is_catalog_eligible: true,
          status: 1,
          is_active: 1
        }
      });

      const freePassPercentage = totalEligible > 0 ? 
        Math.round((activeFreePass / totalEligible) * 100 * 100) / 100 : 0;

      return {
        total_free_pass_accounts: totalFreePass,
        active_free_pass_accounts: activeFreePass,
        total_catalog_eligible: totalEligible,
        free_pass_percentage: freePassPercentage,
        last_updated: new Date()
      };

    } catch (error) {
      logger.error('Failed to get free pass statistics', {
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = SuperadminFreePassService;
