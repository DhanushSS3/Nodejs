const cron = require('node-cron');
const logger = require('../services/logger.service');
const CopyFollowerSlTpService = require('../services/copyFollowerSlTp.service');

/**
 * Background job for monitoring copy follower account equity thresholds
 * Runs every 30 seconds to check if any accounts have reached SL/TP thresholds
 */
class CopyFollowerEquityMonitorJob {
  
  constructor() {
    this.isRunning = false;
    this.task = null;
    this.intervalSeconds = process.env.EQUITY_MONITOR_INTERVAL || 30;
  }

  /**
   * Start the equity monitoring job
   */
  start() {
    if (this.task) {
      logger.warn('Copy follower equity monitor job is already running');
      return;
    }

    // Run every N seconds (default 30 seconds)
    const cronExpression = `*/${this.intervalSeconds} * * * * *`;
    
    this.task = cron.schedule(cronExpression, async () => {
      await this.runMonitoring();
    }, {
      scheduled: false,
      timezone: 'UTC'
    });

    this.task.start();
    
    logger.info('Copy follower equity monitor job started', {
      intervalSeconds: this.intervalSeconds,
      cronExpression
    });
  }

  /**
   * Stop the equity monitoring job
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Copy follower equity monitor job stopped');
    }
  }

  /**
   * Run the equity monitoring process
   */
  async runMonitoring() {
    if (this.isRunning) {
      logger.debug('Equity monitoring already in progress, skipping this cycle');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.debug('Starting copy follower equity monitoring cycle');
      
      const result = await CopyFollowerSlTpService.monitorAllCopyFollowerAccounts();
      
      const duration = Date.now() - startTime;
      
      if (result.success) {
        logger.info('Copy follower equity monitoring completed', {
          duration: `${duration}ms`,
          totalAccounts: result.totalAccounts,
          checkedCount: result.checkedCount,
          triggeredCount: result.triggeredCount,
          errorCount: result.errors?.length || 0
        });

        // Log errors if any
        if (result.errors && result.errors.length > 0) {
          logger.warn('Equity monitoring had errors for some accounts', {
            errorCount: result.errors.length,
            errors: result.errors.slice(0, 5) // Log first 5 errors to avoid spam
          });
        }

        // Log if any auto stop copying was triggered
        if (result.triggeredCount > 0) {
          logger.warn('Auto stop copying triggered for accounts', {
            triggeredCount: result.triggeredCount,
            duration: `${duration}ms`
          });
        }
      } else {
        logger.error('Copy follower equity monitoring failed', {
          duration: `${duration}ms`,
          error: result.error
        });
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Copy follower equity monitoring job error', {
        duration: `${duration}ms`,
        error: error.message,
        stack: error.stack
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get job status
   */
  getStatus() {
    return {
      isScheduled: !!this.task,
      isRunning: this.isRunning,
      intervalSeconds: this.intervalSeconds,
      nextRun: this.task ? this.task.nextDate() : null
    };
  }

  /**
   * Run monitoring once manually (for testing)
   */
  async runOnce() {
    logger.info('Running copy follower equity monitoring manually');
    await this.runMonitoring();
  }
}

// Create singleton instance
const equityMonitorJob = new CopyFollowerEquityMonitorJob();

module.exports = equityMonitorJob;
