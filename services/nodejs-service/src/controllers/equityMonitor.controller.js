const logger = require('../services/logger.service');
const CopyFollowerSlTpService = require('../services/copyFollowerSlTp.service');
const equityMonitorJob = require('../jobs/copyFollowerEquityMonitor.job');

/**
 * Controller for managing copy follower equity monitoring
 */
class EquityMonitorController {

  /**
   * Get equity monitoring job status
   */
  static async getJobStatus(req, res) {
    try {
      const status = equityMonitorJob.getStatus();
      
      res.status(200).json({
        success: true,
        message: 'Equity monitoring job status retrieved',
        data: status
      });

    } catch (error) {
      logger.error('Failed to get equity monitoring job status', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        message: 'Failed to get job status',
        error: error.message
      });
    }
  }

  /**
   * Start equity monitoring job
   */
  static async startJob(req, res) {
    try {
      equityMonitorJob.start();
      
      res.status(200).json({
        success: true,
        message: 'Equity monitoring job started',
        data: equityMonitorJob.getStatus()
      });

    } catch (error) {
      logger.error('Failed to start equity monitoring job', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        message: 'Failed to start job',
        error: error.message
      });
    }
  }

  /**
   * Stop equity monitoring job
   */
  static async stopJob(req, res) {
    try {
      equityMonitorJob.stop();
      
      res.status(200).json({
        success: true,
        message: 'Equity monitoring job stopped',
        data: equityMonitorJob.getStatus()
      });

    } catch (error) {
      logger.error('Failed to stop equity monitoring job', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        message: 'Failed to stop job',
        error: error.message
      });
    }
  }

  /**
   * Run equity monitoring once manually
   */
  static async runOnce(req, res) {
    try {
      const result = await CopyFollowerSlTpService.monitorAllCopyFollowerAccounts();
      
      res.status(200).json({
        success: true,
        message: 'Equity monitoring completed',
        data: result
      });

    } catch (error) {
      logger.error('Failed to run equity monitoring', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        message: 'Failed to run monitoring',
        error: error.message
      });
    }
  }

  /**
   * Check equity thresholds for specific copy follower account
   */
  static async checkAccountThresholds(req, res) {
    try {
      const { copy_follower_account_id } = req.params;
      
      if (!copy_follower_account_id) {
        return res.status(400).json({
          success: false,
          message: 'Copy follower account ID is required'
        });
      }

      // Get copy follower account
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      const account = await CopyFollowerAccount.findByPk(copy_follower_account_id);
      
      if (!account) {
        return res.status(404).json({
          success: false,
          message: 'Copy follower account not found'
        });
      }

      const thresholdCheck = await CopyFollowerSlTpService.checkEquityThresholds(account);
      
      res.status(200).json({
        success: true,
        message: 'Equity thresholds checked',
        data: {
          copy_follower_account_id: account.id,
          account_name: account.account_name,
          thresholdCheck
        }
      });

    } catch (error) {
      logger.error('Failed to check account equity thresholds', {
        copy_follower_account_id: req.params.copy_follower_account_id,
        error: error.message
      });
      res.status(500).json({
        success: false,
        message: 'Failed to check thresholds',
        error: error.message
      });
    }
  }

  /**
   * Validate SL/TP settings
   */
  static async validateSlTpSettings(req, res) {
    try {
      const slTpSettings = req.body;
      
      const validation = CopyFollowerSlTpService.validateSlTpSettings(slTpSettings);
      
      res.status(200).json({
        success: true,
        message: 'SL/TP settings validated',
        data: validation
      });

    } catch (error) {
      logger.error('Failed to validate SL/TP settings', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        message: 'Failed to validate settings',
        error: error.message
      });
    }
  }
}

module.exports = EquityMonitorController;
