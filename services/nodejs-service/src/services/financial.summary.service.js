const { Op } = require('sequelize');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const UserTransaction = require('../models/userTransaction.model');
const logger = require('./logger.service');

/**
 * Financial Summary Service
 * Provides comprehensive financial data for authenticated users
 * Supports date filtering for time-based analysis
 */
class FinancialSummaryService {
  
  /**
   * Get comprehensive financial summary for a user
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {Date|null} startDate - Optional start date for filtering
   * @param {Date|null} endDate - Optional end date for filtering
   * @returns {Object} Financial summary data
   */
  static async getFinancialSummary(userId, userType, startDate = null, endDate = null) {
    try {
      logger.info('Getting financial summary', {
        userId,
        userType,
        startDate,
        endDate
      });

      // Get user model and order model based on user type
      const { UserModel, OrderModel } = this._getUserModels(userType);
      
      // Get user data for current balance
      const user = await UserModel.findByPk(userId, {
        attributes: ['id', 'wallet_balance', 'net_profit', 'margin']
      });

      if (!user) {
        throw new Error(`${userType} user not found`);
      }

      // Build date filter condition
      const dateFilter = this._buildDateFilter(startDate, endDate);

      // Get aggregated order data (net_profit, commission, swap)
      const orderSummary = await this._getOrderSummary(OrderModel, userId, dateFilter);

      // Get deposit summary from transactions
      const depositSummary = await this._getDepositSummary(userId, userType, dateFilter);

      // Prepare final summary
      const summary = {
        user_id: userId,
        user_type: userType,
        balance: parseFloat(user.wallet_balance || 0),
        total_margin: parseFloat(user.margin || 0),
        period: {
          start_date: startDate,
          end_date: endDate,
          is_filtered: !!(startDate || endDate)
        },
        trading: {
          net_profit: orderSummary.net_profit,
          commission: orderSummary.commission,
          swap: orderSummary.swap,
          total_orders: orderSummary.total_orders
        },
        transactions: {
          total_deposits: depositSummary.total_deposits,
          deposit_count: depositSummary.deposit_count
        },
        overall: {
          user_net_profit: parseFloat(user.net_profit || 0)
        }
      };

      logger.info('Financial summary generated successfully', {
        userId,
        userType,
        summary: {
          net_profit: summary.trading.net_profit,
          deposits: summary.transactions.total_deposits,
          balance: summary.balance
        }
      });

      return summary;

    } catch (error) {
      logger.error('Error getting financial summary', {
        userId,
        userType,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get user models based on user type
   * @param {string} userType - 'live' or 'demo'
   * @returns {Object} UserModel and OrderModel
   * @private
   */
  static _getUserModels(userType) {
    if (userType === 'live') {
      return {
        UserModel: LiveUser,
        OrderModel: LiveUserOrder
      };
    } else if (userType === 'demo') {
      return {
        UserModel: DemoUser,
        OrderModel: DemoUserOrder
      };
    } else {
      throw new Error(`Invalid user type: ${userType}`);
    }
  }

  /**
   * Build date filter condition for queries
   * @param {Date|null} startDate - Start date
   * @param {Date|null} endDate - End date
   * @returns {Object|null} Sequelize where condition
   * @private
   */
  static _buildDateFilter(startDate, endDate) {
    if (!startDate && !endDate) {
      return null;
    }

    const dateCondition = {};
    
    if (startDate && endDate) {
      dateCondition.created_at = {
        [Op.between]: [startDate, endDate]
      };
    } else if (startDate) {
      dateCondition.created_at = {
        [Op.gte]: startDate
      };
    } else if (endDate) {
      dateCondition.created_at = {
        [Op.lte]: endDate
      };
    }

    return dateCondition;
  }

  /**
   * Get aggregated order summary (net_profit, commission, swap)
   * @param {Object} OrderModel - Sequelize model for orders
   * @param {number} userId - User ID
   * @param {Object|null} dateFilter - Date filter condition
   * @returns {Object} Order summary data
   * @private
   */
  static async _getOrderSummary(OrderModel, userId, dateFilter) {
    try {
      const whereCondition = {
        order_user_id: userId
      };

      // Add date filter if provided
      if (dateFilter) {
        Object.assign(whereCondition, dateFilter);
      }

      // Get aggregated data from orders
      const result = await OrderModel.findOne({
        where: whereCondition,
        attributes: [
          [OrderModel.sequelize.fn('SUM', OrderModel.sequelize.col('net_profit')), 'total_net_profit'],
          [OrderModel.sequelize.fn('SUM', OrderModel.sequelize.col('commission')), 'total_commission'],
          [OrderModel.sequelize.fn('SUM', OrderModel.sequelize.col('swap')), 'total_swap'],
          [OrderModel.sequelize.fn('COUNT', OrderModel.sequelize.col('id')), 'total_orders']
        ],
        raw: true
      });

      return {
        net_profit: parseFloat(result?.total_net_profit || 0),
        commission: parseFloat(result?.total_commission || 0),
        swap: parseFloat(result?.total_swap || 0),
        total_orders: parseInt(result?.total_orders || 0)
      };

    } catch (error) {
      logger.error('Error getting order summary', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get deposit summary from user transactions
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {Object|null} dateFilter - Date filter condition
   * @returns {Object} Deposit summary data
   * @private
   */
  static async _getDepositSummary(userId, userType, dateFilter) {
    try {
      const whereCondition = {
        user_id: userId,
        user_type: userType,
        type: 'deposit',
        status: 'completed'
      };

      // Add date filter if provided
      if (dateFilter) {
        Object.assign(whereCondition, dateFilter);
      }

      // Get aggregated deposit data
      const result = await UserTransaction.findOne({
        where: whereCondition,
        attributes: [
          [UserTransaction.sequelize.fn('SUM', UserTransaction.sequelize.col('amount')), 'total_deposits'],
          [UserTransaction.sequelize.fn('COUNT', UserTransaction.sequelize.col('id')), 'deposit_count']
        ],
        raw: true
      });

      return {
        total_deposits: parseFloat(result?.total_deposits || 0),
        deposit_count: parseInt(result?.deposit_count || 0)
      };

    } catch (error) {
      logger.error('Error getting deposit summary', {
        userId,
        userType,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validate date range parameters
   * @param {string|null} startDateStr - Start date string
   * @param {string|null} endDateStr - End date string
   * @returns {Object} Validated dates or null
   */
  static validateDateRange(startDateStr, endDateStr) {
    let startDate = null;
    let endDate = null;

    if (startDateStr) {
      startDate = new Date(startDateStr);
      if (isNaN(startDate.getTime())) {
        throw new Error('Invalid start_date format. Use YYYY-MM-DD or ISO format.');
      }
    }

    if (endDateStr) {
      endDate = new Date(endDateStr);
      if (isNaN(endDate.getTime())) {
        throw new Error('Invalid end_date format. Use YYYY-MM-DD or ISO format.');
      }
      
      // Set end date to end of day if only date is provided
      if (endDateStr.length === 10) { // YYYY-MM-DD format
        endDate.setHours(23, 59, 59, 999);
      }
    }

    // Validate date range
    if (startDate && endDate && startDate > endDate) {
      throw new Error('start_date cannot be greater than end_date');
    }

    return { startDate, endDate };
  }
}

module.exports = FinancialSummaryService;
