const swapSchedulerService = require('../services/swap.scheduler.service');
const swapCalculationService = require('../services/swap.calculation.service');
const logger = require('../utils/logger');

class SwapController {
  /**
   * Get swap scheduler status
   */
  async getSchedulerStatus(req, res) {
    try {
      const status = swapSchedulerService.getStatus();
      
      res.json({
        success: true,
        message: 'Swap scheduler status retrieved successfully',
        data: status
      });
    } catch (error) {
      logger.error('Error getting swap scheduler status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get swap scheduler status',
        error: error.message
      });
    }
  }

  /**
   * Start swap scheduler
   */
  async startScheduler(req, res) {
    try {
      swapSchedulerService.start();
      
      res.json({
        success: true,
        message: 'Swap scheduler started successfully'
      });
    } catch (error) {
      logger.error('Error starting swap scheduler:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to start swap scheduler',
        error: error.message
      });
    }
  }

  /**
   * Stop swap scheduler
   */
  async stopScheduler(req, res) {
    try {
      swapSchedulerService.stop();
      
      res.json({
        success: true,
        message: 'Swap scheduler stopped successfully'
      });
    } catch (error) {
      logger.error('Error stopping swap scheduler:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to stop swap scheduler',
        error: error.message
      });
    }
  }

  /**
   * Manually trigger swap processing
   */
  async triggerManual(req, res) {
    try {
      const { date } = req.body;
      const targetDate = date ? new Date(date) : new Date();

      // Validate date
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date format'
        });
      }

      // Trigger manual processing (async)
      swapSchedulerService.triggerManual(targetDate).catch(error => {
        logger.error('Error in manual swap processing:', error);
      });

      res.json({
        success: true,
        message: `Manual swap processing triggered for ${targetDate.toDateString()}`,
        data: {
          target_date: targetDate.toISOString()
        }
      });
    } catch (error) {
      logger.error('Error triggering manual swap processing:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to trigger manual swap processing',
        error: error.message
      });
    }
  }

  /**
   * Calculate swap for a specific order (testing endpoint)
   */
  async calculateOrderSwap(req, res) {
    try {
      const { orderType, orderId } = req.params;
      const { date } = req.query;
      
      if (!['live', 'demo', 'copy_follower', 'strategy_provider'].includes(orderType)) {
        return res.status(400).json({
          success: false,
          message: 'Order type must be one of: "live", "demo", "copy_follower", "strategy_provider"'
        });
      }

      const targetDate = date ? new Date(date) : new Date();
      
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date format'
        });
      }

      const result = await swapSchedulerService.processSpecificOrder(orderType, orderId, targetDate);

      res.json({
        success: true,
        message: 'Swap calculation completed',
        data: result
      });
    } catch (error) {
      logger.error('Error calculating order swap:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to calculate order swap',
        error: error.message
      });
    }
  }

  /**
   * Test swap calculation without updating database
   */
  async testSwapCalculation(req, res) {
    try {
      const { symbol, group_name, order_type, order_quantity } = req.body;
      const { date } = req.query;

      if (!symbol || !group_name || !order_type || !order_quantity) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: symbol, group_name, order_type, order_quantity'
        });
      }

      const targetDate = date ? new Date(date) : new Date();
      
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date format'
        });
      }

      // Create mock order object
      const mockOrder = {
        order_id: 'TEST_' + Date.now(),
        symbol: symbol.toUpperCase(),
        group_name,
        order_type: order_type.toUpperCase(),
        order_quantity: parseFloat(order_quantity)
      };

      const swapCharge = await swapCalculationService.calculateSwapCharge(mockOrder, targetDate);

      res.json({
        success: true,
        message: 'Swap calculation test completed',
        data: {
          order: mockOrder,
          target_date: targetDate.toISOString(),
          calculated_swap: swapCharge
        }
      });
    } catch (error) {
      logger.error('Error in swap calculation test:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to test swap calculation',
        error: error.message
      });
    }
  }

  /**
   * Get swap processing history/logs
   */
  async getProcessingHistory(req, res) {
    try {
      // This would typically query a swap_processing_log table
      // For now, return basic status
      res.json({
        success: true,
        message: 'Swap processing history retrieved',
        data: {
          message: 'History logging not yet implemented',
          current_status: swapSchedulerService.getStatus()
        }
      });
    } catch (error) {
      logger.error('Error getting processing history:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get processing history',
        error: error.message
      });
    }
  }
}

module.exports = new SwapController();
