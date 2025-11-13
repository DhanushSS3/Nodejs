const cron = require('node-cron');
const StrategyProviderAccount = require('../../models/strategyProviderAccount.model');
const strategyProviderService = require('../strategyProvider.service');
const logger = require('../logger.service');

class CatalogEligibilityCronService {
  
  /**
   * Initialize and start the catalog eligibility cron job
   * DEPRECATED: Now using real-time updates instead of daily cron job
   * Only runs if CATALOG_ELIGIBILITY_CRON_ENABLED=true is set
   */
  static initializeCronJobs() {
    const cronEnabled = process.env.CATALOG_ELIGIBILITY_CRON_ENABLED === 'true';
    
    if (!cronEnabled) {
      logger.info('Catalog eligibility cron job DISABLED - using real-time updates instead', {
        reason: 'Real-time eligibility updates now handle catalog status changes',
        enableWith: 'CATALOG_ELIGIBILITY_CRON_ENABLED=true'
      });
      return;
    }

    // Run daily at 2:00 AM (0 2 * * *) - only if explicitly enabled
    const cronExpression = process.env.CATALOG_ELIGIBILITY_CRON || '0 2 * * *';
    
    logger.info('Initializing catalog eligibility cron job (LEGACY MODE)', {
      cronExpression,
      timezone: 'UTC',
      warning: 'Consider using real-time updates instead'
    });

    cron.schedule(cronExpression, async () => {
      await this.updateAllCatalogEligibility();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    logger.info('Catalog eligibility cron job scheduled successfully (LEGACY MODE)');
  }

  /**
   * Update catalog eligibility for all strategy provider accounts
   * This is the main function that runs daily
   */
  static async updateAllCatalogEligibility() {
    const startTime = Date.now();
    let processedCount = 0;
    let eligibleCount = 0;
    let ineligibleCount = 0;
    let errorCount = 0;

    try {
      logger.info('Starting daily catalog eligibility update job');

      // Get all active strategy provider accounts (excluding free pass accounts)
      const strategies = await StrategyProviderAccount.findAll({
        where: { 
          status: 1, 
          is_active: 1,
          catalog_free_pass: false  // Skip accounts with superadmin free pass
        },
        attributes: ['id', 'strategy_name', 'is_catalog_eligible', 'catalog_free_pass'],
        order: [['id', 'ASC']]
      });

      logger.info('Found strategy providers to process', {
        totalStrategies: strategies.length
      });

      // Process each strategy provider
      for (const strategy of strategies) {
        try {
          await this.updateSingleStrategyEligibility(strategy);
          processedCount++;

          // Log progress every 50 strategies
          if (processedCount % 50 === 0) {
            logger.info('Catalog eligibility update progress', {
              processed: processedCount,
              total: strategies.length,
              eligible: eligibleCount,
              ineligible: ineligibleCount,
              errors: errorCount
            });
          }

        } catch (error) {
          errorCount++;
          logger.error('Failed to update catalog eligibility for strategy', {
            strategyId: strategy.id,
            strategyName: strategy.strategy_name,
            error: error.message
          });
        }
      }

      const duration = Date.now() - startTime;
      
      logger.info('Completed daily catalog eligibility update job', {
        totalProcessed: processedCount,
        eligibleStrategies: eligibleCount,
        ineligibleStrategies: ineligibleCount,
        errors: errorCount,
        durationMs: duration,
        durationMinutes: Math.round(duration / 60000 * 100) / 100
      });

      // Send summary notification if there are errors
      if (errorCount > 0) {
        logger.warn('Catalog eligibility update completed with errors', {
          errorCount,
          totalProcessed: processedCount,
          errorRate: Math.round((errorCount / processedCount) * 100 * 100) / 100 + '%'
        });
      }

    } catch (error) {
      logger.error('Fatal error in catalog eligibility cron job', {
        error: error.message,
        stack: error.stack,
        processedCount,
        durationMs: Date.now() - startTime
      });
    }
  }

  /**
   * Update catalog eligibility for a single strategy provider
   * @param {Object} strategy - Strategy provider instance
   */
  static async updateSingleStrategyEligibility(strategy) {
    try {
      // Check eligibility using existing service method
      const eligibilityResult = await strategyProviderService.checkCatalogEligibility(strategy.id);
      
      const wasEligible = strategy.is_catalog_eligible;
      const isNowEligible = eligibilityResult.eligible;

      // Update the database if eligibility status changed
      if (wasEligible !== isNowEligible) {
        await strategy.update({
          is_catalog_eligible: isNowEligible,
          catalog_eligibility_updated_at: new Date()
        });

        logger.info('Strategy catalog eligibility status changed', {
          strategyId: strategy.id,
          strategyName: strategy.strategy_name,
          previousStatus: wasEligible,
          newStatus: isNowEligible,
          reason: eligibilityResult.reason,
          currentStats: eligibilityResult.current
        });

        // Update counters
        if (isNowEligible) {
          this.eligibleCount++;
        } else {
          this.ineligibleCount++;
        }
      }

      return {
        strategyId: strategy.id,
        eligible: isNowEligible,
        changed: wasEligible !== isNowEligible,
        reason: eligibilityResult.reason
      };

    } catch (error) {
      logger.error('Error updating single strategy eligibility', {
        strategyId: strategy.id,
        strategyName: strategy.strategy_name,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Manually trigger catalog eligibility update (for admin use)
   * @returns {Object} Update results
   */
  static async manualTriggerUpdate() {
    logger.info('Manual catalog eligibility update triggered');
    
    const result = await this.updateAllCatalogEligibility();
    
    return {
      success: true,
      message: 'Manual catalog eligibility update completed',
      timestamp: new Date().toISOString(),
      result
    };
  }

  /**
   * Get cron job status and next run time
   * @returns {Object} Cron job status
   */
  static getCronJobStatus() {
    const cronExpression = process.env.CATALOG_ELIGIBILITY_CRON || '0 2 * * *';
    
    return {
      enabled: true,
      cronExpression,
      timezone: 'UTC',
      description: 'Daily catalog eligibility update at 2:00 AM UTC',
      nextRun: this.getNextRunTime(cronExpression)
    };
  }

  /**
   * Calculate next run time for cron expression
   * @param {string} cronExpression - Cron expression
   * @returns {string} Next run time
   */
  static getNextRunTime(cronExpression) {
    try {
      // Simple calculation for daily 2 AM cron
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(2, 0, 0, 0);
      
      return tomorrow.toISOString();
    } catch (error) {
      return 'Unable to calculate next run time';
    }
  }
}

// Initialize counters
CatalogEligibilityCronService.eligibleCount = 0;
CatalogEligibilityCronService.ineligibleCount = 0;

module.exports = CatalogEligibilityCronService;
