const copyFollowerEquityMonitorWorker = require('../services/copyFollowerEquityMonitor.worker');
const logger = require('../services/logger.service');

/**
 * Get copy follower equity monitor worker status
 * GET /api/copy-trading/equity-monitor/status
 */
async function getEquityMonitorStatus(req, res) {
  try {
    const status = copyFollowerEquityMonitorWorker.getStatus();
    
    res.json({
      success: true,
      message: 'Equity monitor status retrieved successfully',
      data: status
    });

  } catch (error) {
    logger.error('Failed to get equity monitor status', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get equity monitor status',
      error: error.message
    });
  }
}

/**
 * Start copy follower equity monitor worker
 * POST /api/copy-trading/equity-monitor/start
 */
async function startEquityMonitor(req, res) {
  try {
    copyFollowerEquityMonitorWorker.start();
    
    logger.info('Equity monitor worker started via API', {
      userId: req.user?.id,
      userType: req.user?.account_type
    });

    res.json({
      success: true,
      message: 'Equity monitor worker started successfully'
    });

  } catch (error) {
    logger.error('Failed to start equity monitor worker', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to start equity monitor worker',
      error: error.message
    });
  }
}

/**
 * Stop copy follower equity monitor worker
 * POST /api/copy-trading/equity-monitor/stop
 */
async function stopEquityMonitor(req, res) {
  try {
    copyFollowerEquityMonitorWorker.stop();
    
    logger.info('Equity monitor worker stopped via API', {
      userId: req.user?.id,
      userType: req.user?.account_type
    });

    res.json({
      success: true,
      message: 'Equity monitor worker stopped successfully'
    });

  } catch (error) {
    logger.error('Failed to stop equity monitor worker', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to stop equity monitor worker',
      error: error.message
    });
  }
}

/**
 * Check equity thresholds for specific copy follower account
 * GET /api/copy-trading/equity-monitor/account/:id/check
 */
async function checkAccountThresholds(req, res) {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Copy follower account ID is required'
      });
    }

    // Get copy follower account
    const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
    const account = await CopyFollowerAccount.findByPk(id);
    
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Copy follower account not found'
      });
    }

    // Check if user owns this account (for security)
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    
    if (account.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Account does not belong to you'
      });
    }

    const CopyFollowerEquityMonitorService = require('../services/copyFollowerEquityMonitor.service');
    const thresholdCheck = await CopyFollowerEquityMonitorService.checkEquityThresholds(account);
    
    // Calculate thresholds for display
    const initialInvestment = parseFloat(account.investment_amount || 0);
    let stopLossThreshold = null;
    let takeProfitThreshold = null;
    
    // Calculate SL threshold if configured
    if (account.copy_sl_mode && account.copy_sl_mode !== 'none') {
      stopLossThreshold = CopyFollowerEquityMonitorService.calculateThreshold(
        initialInvestment,
        account.copy_sl_mode,
        account.sl_percentage,
        account.sl_amount,
        'stop_loss'
      );
    }
    
    // Calculate TP threshold if configured
    if (account.copy_tp_mode && account.copy_tp_mode !== 'none') {
      takeProfitThreshold = CopyFollowerEquityMonitorService.calculateThreshold(
        initialInvestment,
        account.copy_tp_mode,
        account.tp_percentage,
        account.tp_amount,
        'take_profit'
      );
    }
    
    res.json({
      success: true,
      message: 'Equity thresholds checked successfully',
      data: {
        copy_follower_account_id: account.id,
        account_name: account.account_name,
        
        // Current SL/TP Settings
        sl_tp_settings: {
          copy_sl_mode: account.copy_sl_mode || 'none',
          sl_percentage: account.sl_percentage || null,
          sl_amount: account.sl_amount || null,
          copy_tp_mode: account.copy_tp_mode || 'none',
          tp_percentage: account.tp_percentage || null,
          tp_amount: account.tp_amount || null,
          initial_investment: initialInvestment
        },
        
        // Calculated Thresholds
        calculated_thresholds: {
          stop_loss_threshold: stopLossThreshold,
          take_profit_threshold: takeProfitThreshold,
          current_equity: thresholdCheck.currentEquity || null
        },
        
        // Threshold Check Results
        thresholdCheck
      }
    });

  } catch (error) {
    logger.error('Failed to check account equity thresholds', {
      copy_follower_account_id: req.params.id,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to check equity thresholds',
      error: error.message
    });
  }
}

module.exports = {
  getEquityMonitorStatus,
  startEquityMonitor,
  stopEquityMonitor,
  checkAccountThresholds
};
