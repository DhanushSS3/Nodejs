const logger = require('./logger.service');
const CopyFollowerEquityMonitorService = require('./copyFollowerEquityMonitor.service');

/**
 * Background worker for monitoring copy follower equity thresholds
 * Runs every 200ms to check accounts with:
 * 1. Active status and copy_status
 * 2. SL/TP configured (not 'none')
 * 3. Has open orders (to avoid unnecessary monitoring)
 */
class CopyFollowerEquityMonitorWorker {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.monitoringInterval = 200; // 200ms as requested
    this.stats = {
      totalRuns: 0,
      totalAccountsChecked: 0,
      totalTriggered: 0,
      totalErrors: 0,
      lastRunTime: null,
      startTime: null
    };
  }

  /**
   * Start the equity monitoring worker
   */
  start() {
    if (this.isRunning) {
      logger.warn('Copy follower equity monitor worker is already running');
      return;
    }

    this.isRunning = true;
    this.stats.startTime = new Date();
    
    logger.info('Starting copy follower equity monitor worker', {
      interval: `${this.monitoringInterval}ms`,
      startTime: this.stats.startTime
    });

    this.intervalId = setInterval(async () => {
      await this.runMonitoringCycle();
    }, this.monitoringInterval);

    logger.info('✅ Copy follower equity monitor worker started successfully');
  }

  /**
   * Stop the equity monitoring worker
   */
  stop() {
    if (!this.isRunning) {
      logger.warn('Copy follower equity monitor worker is not running');
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.info('Copy follower equity monitor worker stopped', {
      totalRuns: this.stats.totalRuns,
      totalAccountsChecked: this.stats.totalAccountsChecked,
      totalTriggered: this.stats.totalTriggered,
      totalErrors: this.stats.totalErrors,
      uptime: this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0
    });
  }

  /**
   * Run a single monitoring cycle
   */
  async runMonitoringCycle() {
    try {
      this.stats.lastRunTime = new Date();
      this.stats.totalRuns++;

      const result = await CopyFollowerEquityMonitorService.monitorAllCopyFollowerAccounts();
      
      if (result.success) {
        this.stats.totalAccountsChecked += result.checkedCount || 0;
        this.stats.totalTriggered += result.triggeredCount || 0;
        this.stats.totalErrors += result.errors?.length || 0;

        // // Only log if there was activity (accounts checked or errors)
        // if (result.checkedCount > 0 || result.errors?.length > 0) {
        //   logger.info('Copy follower equity monitoring cycle completed', {
        //     totalAccounts: result.totalAccounts,
        //     checkedCount: result.checkedCount,
        //     triggeredCount: result.triggeredCount,
        //     errorCount: result.errors?.length || 0,
        //     runNumber: this.stats.totalRuns
        //   });
        // }

        // Log errors if any
        if (result.errors?.length > 0) {
          result.errors.forEach(error => {
            logger.error('Copy follower equity monitoring error', {
              accountId: error.accountId,
              error: error.error,
              runNumber: this.stats.totalRuns
            });
          });
        }
      } else {
        this.stats.totalErrors++;
        logger.error('Copy follower equity monitoring cycle failed', {
          error: result.error,
          runNumber: this.stats.totalRuns
        });
      }

    } catch (error) {
      this.stats.totalErrors++;
      logger.error('Copy follower equity monitoring cycle exception', {
        error: error.message,
        stack: error.stack,
        runNumber: this.stats.totalRuns
      });
    }
  }

  /**
   * Get current worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      uptime: this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0,
      averageAccountsPerRun: this.stats.totalRuns > 0 ? 
        (this.stats.totalAccountsChecked / this.stats.totalRuns).toFixed(2) : 0
    };
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      monitoringInterval: this.monitoringInterval,
      stats: this.getStats()
    };
  }
}

// Create singleton instance
const copyFollowerEquityMonitorWorker = new CopyFollowerEquityMonitorWorker();

module.exports = copyFollowerEquityMonitorWorker;
