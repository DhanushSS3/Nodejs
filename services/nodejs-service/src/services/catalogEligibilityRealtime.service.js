const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const strategyProviderService = require('./strategyProvider.service');
const logger = require('./logger.service');

class CatalogEligibilityRealtimeService {
  
  /**
   * Update catalog eligibility for a strategy provider in real-time
   * Called when wallet balance changes (transfers, withdrawals, deposits, profit/loss)
   * @param {number} strategyProviderId - Strategy provider account ID
   * @param {string} trigger - What triggered the update (transfer, withdrawal, etc.)
   * @returns {Object} Update result
   */
  static async updateStrategyProviderEligibility(strategyProviderId, trigger = 'balance_change') {
    try {
      logger.info('Real-time catalog eligibility check triggered', {
        strategyProviderId,
        trigger,
        timestamp: new Date().toISOString()
      });

      // Get strategy provider account
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
      
      if (!strategyProvider) {
        logger.warn('Strategy provider not found for eligibility update', {
          strategyProviderId,
          trigger
        });
        return { success: false, reason: 'Strategy provider not found' };
      }

      // Skip if account has free pass (superadmin override)
      if (strategyProvider.catalog_free_pass) {
        logger.info('Skipping eligibility check - strategy provider has free pass', {
          strategyProviderId,
          strategyName: strategyProvider.strategy_name,
          trigger
        });
        return { 
          success: true, 
          skipped: true, 
          reason: 'Free pass active',
          current_status: strategyProvider.is_catalog_eligible
        };
      }

      // Skip if account is not active
      if (strategyProvider.status !== 1 || strategyProvider.is_active !== 1) {
        logger.info('Skipping eligibility check - strategy provider not active', {
          strategyProviderId,
          strategyName: strategyProvider.strategy_name,
          status: strategyProvider.status,
          is_active: strategyProvider.is_active,
          trigger
        });
        
        // If account is inactive but still marked as eligible, remove from catalog
        if (strategyProvider.is_catalog_eligible) {
          await strategyProvider.update({
            is_catalog_eligible: false,
            catalog_eligibility_updated_at: new Date()
          });
          
          logger.info('Removed inactive strategy provider from catalog', {
            strategyProviderId,
            strategyName: strategyProvider.strategy_name,
            trigger
          });
          
          return {
            success: true,
            changed: true,
            previous_status: true,
            new_status: false,
            reason: 'Account inactive - removed from catalog'
          };
        }
        
        return { 
          success: true, 
          skipped: true, 
          reason: 'Account inactive',
          current_status: strategyProvider.is_catalog_eligible
        };
      }

      // Check eligibility using simplified criteria (only equity)
      const eligibilityResult = await strategyProviderService.checkCatalogEligibility(strategyProviderId);
      
      const wasEligible = strategyProvider.is_catalog_eligible;
      const isNowEligible = eligibilityResult.eligible;

      // Update database if eligibility status changed
      if (wasEligible !== isNowEligible) {
        await strategyProvider.update({
          is_catalog_eligible: isNowEligible,
          catalog_eligibility_updated_at: new Date()
        });

        logger.info('Strategy provider catalog eligibility updated in real-time', {
          strategyProviderId,
          strategyName: strategyProvider.strategy_name,
          trigger,
          previousStatus: wasEligible,
          newStatus: isNowEligible,
          reason: eligibilityResult.reason,
          currentEquity: eligibilityResult.current?.current_equity,
          minEquityRequired: eligibilityResult.requirements?.min_equity,
          timestamp: new Date().toISOString()
        });

        return {
          success: true,
          changed: true,
          previous_status: wasEligible,
          new_status: isNowEligible,
          reason: eligibilityResult.reason,
          current_equity: eligibilityResult.current?.current_equity,
          min_equity_required: eligibilityResult.requirements?.min_equity,
          trigger
        };
      } else {
        logger.debug('Strategy provider catalog eligibility unchanged', {
          strategyProviderId,
          strategyName: strategyProvider.strategy_name,
          trigger,
          currentStatus: isNowEligible,
          currentEquity: eligibilityResult.current?.current_equity,
          minEquityRequired: eligibilityResult.requirements?.min_equity
        });

        return {
          success: true,
          changed: false,
          current_status: isNowEligible,
          reason: eligibilityResult.reason,
          current_equity: eligibilityResult.current?.current_equity,
          min_equity_required: eligibilityResult.requirements?.min_equity,
          trigger
        };
      }

    } catch (error) {
      logger.error('Failed to update strategy provider catalog eligibility in real-time', {
        strategyProviderId,
        trigger,
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        error: error.message,
        trigger
      };
    }
  }

  /**
   * Batch update eligibility for multiple strategy providers
   * Useful for bulk operations like internal transfers affecting multiple accounts
   * @param {Array} strategyProviderIds - Array of strategy provider IDs
   * @param {string} trigger - What triggered the batch update
   * @returns {Object} Batch update results
   */
  static async batchUpdateEligibility(strategyProviderIds, trigger = 'batch_update') {
    const results = {
      total: strategyProviderIds.length,
      processed: 0,
      changed: 0,
      errors: 0,
      details: []
    };

    logger.info('Starting batch catalog eligibility update', {
      totalAccounts: strategyProviderIds.length,
      trigger
    });

    for (const strategyProviderId of strategyProviderIds) {
      try {
        const result = await this.updateStrategyProviderEligibility(strategyProviderId, trigger);
        results.processed++;
        
        if (result.changed) {
          results.changed++;
        }
        
        if (!result.success) {
          results.errors++;
        }
        
        results.details.push({
          strategyProviderId,
          ...result
        });
        
      } catch (error) {
        results.errors++;
        results.details.push({
          strategyProviderId,
          success: false,
          error: error.message
        });
      }
    }

    logger.info('Completed batch catalog eligibility update', {
      ...results,
      trigger
    });

    return results;
  }

  /**
   * Get current eligibility status for a strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Current eligibility status
   */
  static async getCurrentEligibilityStatus(strategyProviderId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId, {
        attributes: [
          'id', 'strategy_name', 'is_catalog_eligible', 'catalog_free_pass',
          'wallet_balance', 'net_profit', 'status', 'is_active',
          'catalog_eligibility_updated_at'
        ]
      });

      if (!strategyProvider) {
        return { found: false };
      }

      const currentEquity = parseFloat(strategyProvider.wallet_balance || 0) + parseFloat(strategyProvider.net_profit || 0);
      const minEquity = 100.00;

      return {
        found: true,
        strategyProviderId: strategyProvider.id,
        strategyName: strategyProvider.strategy_name,
        is_catalog_eligible: strategyProvider.is_catalog_eligible,
        catalog_free_pass: strategyProvider.catalog_free_pass,
        current_equity: currentEquity,
        min_equity_required: minEquity,
        meets_equity_requirement: currentEquity >= minEquity,
        account_active: strategyProvider.status === 1 && strategyProvider.is_active === 1,
        last_updated: strategyProvider.catalog_eligibility_updated_at
      };

    } catch (error) {
      logger.error('Failed to get current eligibility status', {
        strategyProviderId,
        error: error.message
      });
      return { found: false, error: error.message };
    }
  }
}

module.exports = CatalogEligibilityRealtimeService;
