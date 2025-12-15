const FinancialSummaryService = require('../services/financial.summary.service');
const logger = require('../services/logger.service');

/**
 * Financial Summary Controller
 * Handles HTTP requests for user financial data
 */
class FinancialSummaryController {

  /**
   * Get financial summary for authenticated user
   * Supports optional date filtering via query parameters
   * 
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  static async getFinancialSummary(req, res) {
    try {
      // Extract user info from JWT token
      const userId = req.user.sub || req.user.user_id || req.user.id;
      const userType = req.user.account_type || req.user.user_type;
      const allowedUserTypes = ['live', 'demo', 'strategy_provider'];

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID not found in authentication token'
        });
      }

      if (!userType || !allowedUserTypes.includes(userType)) {
        return res.status(400).json({
          success: false,
          message: `Invalid or missing user type in authentication token. Allowed types: ${allowedUserTypes.join(', ')}`
        });
      }

      // Extract and validate date parameters
      const { start_date, end_date } = req.query;
      
      let startDate = null;
      let endDate = null;

      try {
        const dateValidation = FinancialSummaryService.validateDateRange(start_date, end_date);
        startDate = dateValidation.startDate;
        endDate = dateValidation.endDate;
      } catch (dateError) {
        return res.status(400).json({
          success: false,
          message: dateError.message
        });
      }

      logger.info('Financial summary request', {
        userId,
        userType,
        startDate,
        endDate,
        ip: req.ip
      });

      // Get financial summary
      const summary = await FinancialSummaryService.getFinancialSummary(
        userId,
        userType,
        startDate,
        endDate
      );

      // Success response
      res.status(200).json({
        success: true,
        message: 'Financial summary retrieved successfully',
        data: summary
      });

    } catch (error) {
      logger.error('Error in getFinancialSummary controller', {
        error: error.message,
        stack: error.stack,
        userId: req.user?.sub || req.user?.user_id || req.user?.id,
        userType: req.user?.account_type || req.user?.user_type
      });

      // Handle specific error types
      if (error.message.includes('user not found')) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (error.message.includes('Invalid user type')) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user type'
        });
      }

      // Generic server error
      res.status(500).json({
        success: false,
        message: 'Internal server error while retrieving financial summary'
      });
    }
  }

  /**
   * Get financial summary for live users specifically
   * This is a convenience method that ensures live user context
   * 
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  static async getLiveUserFinancialSummary(req, res) {
    try {
      // Override user type to ensure live user context
      req.user.account_type = 'live';
      req.user.user_type = 'live';
      
      // Call the main method
      await FinancialSummaryController.getFinancialSummary(req, res);
      
    } catch (error) {
      logger.error('Error in getLiveUserFinancialSummary controller', {
        error: error.message,
        stack: error.stack,
        userId: req.user?.sub || req.user?.user_id || req.user?.id
      });

      res.status(500).json({
        success: false,
        message: 'Internal server error while retrieving live user financial summary'
      });
    }
  }

  /**
   * Get financial summary for demo users specifically
   * This is a convenience method that ensures demo user context
   * 
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  static async getDemoUserFinancialSummary(req, res) {
    try {
      // Override user type to ensure demo user context
      req.user.account_type = 'demo';
      req.user.user_type = 'demo';
      
      // Call the main method
      await FinancialSummaryController.getFinancialSummary(req, res);
      
    } catch (error) {
      logger.error('Error in getDemoUserFinancialSummary controller', {
        error: error.message,
        stack: error.stack,
        userId: req.user?.sub || req.user?.user_id || req.user?.id
      });

      res.status(500).json({
        success: false,
        message: 'Internal server error while retrieving demo user financial summary'
      });
    }
  }
}

module.exports = FinancialSummaryController;
