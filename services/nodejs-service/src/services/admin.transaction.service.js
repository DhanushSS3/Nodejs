const { UserTransaction, LiveUser, DemoUser } = require('../models');
const sequelize = require('../config/db');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class AdminTransactionService {
  /**
   * Get filtered transactions with pagination and total sum
   * @param {Object} params - Query parameters
   * @param {string} params.type - 'deposit' or 'withdraw'
   * @param {string} [params.email] - User email filter
   * @param {string} [params.method_type] - Payment method filter
   * @param {number} [params.page=1] - Page number
   * @param {number} [params.limit=20] - Records per page
   * @param {Object} params.admin - Admin information
   * @returns {Promise<Object>} Paginated transactions with total sum
   */
  async getFilteredTransactions({ type, email, method_type, page = 1, limit = 20, admin }) {
    const operationId = `get_filtered_transactions_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      logger.info(`[${operationId}] Fetching ${type} transactions`, {
        email, method_type, page, limit, admin_id: admin.id, admin_role: admin.role
      });

      // Validate type
      if (!['deposit', 'withdraw'].includes(type)) {
        throw new Error('Invalid transaction type. Must be "deposit" or "withdraw"');
      }

      // Validate pagination
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      // Build base where clause
      const baseWhere = {
        type: type,
        status: 'completed' // Only show completed transactions
      };

      // Add method_type filter if provided
      if (method_type) {
        baseWhere.method_type = method_type;
      }

      // Build country filter for non-superadmin
      let countryFilter = {};
      if (admin.role !== 'superadmin' && admin.country_id) {
        countryFilter = { country_id: admin.country_id };
      }

      // Build user filter based on email if provided
      let userIds = null;
      if (email) {
        // Find users matching email pattern (supports partial matching)
        const userWhere = {
          email: { [Op.like]: `%${email}%` },
          ...countryFilter
        };

        const [liveUsers, demoUsers] = await Promise.all([
          LiveUser.findAll({
            where: userWhere,
            attributes: ['id'],
            raw: true
          }),
          DemoUser.findAll({
            where: userWhere,
            attributes: ['id'],
            raw: true
          })
        ]);

        // Combine user IDs with their types
        userIds = [
          ...liveUsers.map(u => ({ user_id: u.id, user_type: 'live' })),
          ...demoUsers.map(u => ({ user_id: u.id, user_type: 'demo' }))
        ];

        if (userIds.length === 0) {
          // No users found matching email, return empty result
          return {
            transactions: [],
            pagination: {
              page: pageNum,
              limit: limitNum,
              total: 0,
              totalPages: 0,
              hasNextPage: false,
              hasPreviousPage: false
            },
            summary: {
              total_sum: 0,
              total_records: 0,
              filtered_sum: 0,
              filtered_records: 0
            }
          };
        }

        // Add user filter to base where clause
        baseWhere[Op.or] = userIds.map(({ user_id, user_type }) => ({
          user_id: user_id,
          user_type: user_type
        }));
      } else if (admin.role !== 'superadmin' && admin.country_id) {
        // For country-scoped admins without email filter, we need to filter by country
        // Get all user IDs from the admin's country
        const [liveUsers, demoUsers] = await Promise.all([
          LiveUser.findAll({
            where: countryFilter,
            attributes: ['id'],
            raw: true
          }),
          DemoUser.findAll({
            where: countryFilter,
            attributes: ['id'],
            raw: true
          })
        ]);

        userIds = [
          ...liveUsers.map(u => ({ user_id: u.id, user_type: 'live' })),
          ...demoUsers.map(u => ({ user_id: u.id, user_type: 'demo' }))
        ];

        if (userIds.length > 0) {
          baseWhere[Op.or] = userIds.map(({ user_id, user_type }) => ({
            user_id: user_id,
            user_type: user_type
          }));
        }
      }

      // Execute queries in parallel for efficiency
      const [transactions, totalSum, totalCount] = await Promise.all([
        // Get paginated transactions with user details
        this._getTransactionsWithUserDetails(baseWhere, offset, limitNum),
        
        // Get total sum of all matching transactions (not just current page)
        UserTransaction.sum('amount', { where: baseWhere }),
        
        // Get total count of all matching transactions
        UserTransaction.count({ where: baseWhere })
      ]);

      // Calculate pagination info
      const totalPages = Math.ceil(totalCount / limitNum);
      const hasNextPage = pageNum < totalPages;
      const hasPreviousPage = pageNum > 1;

      // Calculate filtered sum (sum of current page)
      const filteredSum = Array.isArray(transactions) 
        ? transactions.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0)
        : 0;

      logger.info(`[${operationId}] Successfully fetched ${Array.isArray(transactions) ? transactions.length : 0} transactions`, {
        total_sum: totalSum || 0,
        total_count: totalCount,
        filtered_sum: filteredSum
      });

      return {
        transactions: Array.isArray(transactions) ? transactions.map(tx => ({
          id: tx.id,
          transaction_id: tx.transaction_id,
          user_email: tx.user_email,
          amount: parseFloat(tx.amount || 0),
          balance_before: parseFloat(tx.balance_before || 0),
          balance_after: parseFloat(tx.balance_after || 0),
          method_type: tx.method_type,
          notes: tx.notes,
          created_at: tx.created_at,
          updated_at: tx.updated_at,
          user_name: tx.user_name,
          user_account_number: tx.user_account_number
        })) : [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages,
          hasNextPage,
          hasPreviousPage
        },
        summary: {
          total_sum: Math.abs(totalSum || 0), // Use absolute value for display
          total_records: totalCount,
          filtered_sum: Math.abs(filteredSum),
          filtered_records: Array.isArray(transactions) ? transactions.length : 0
        }
      };

    } catch (error) {
      logger.error(`[${operationId}] Error fetching filtered transactions:`, error);
      throw error;
    }
  }

  /**
   * Get transactions with user details using efficient joins
   * @private
   */
  async _getTransactionsWithUserDetails(whereClause, offset, limit) {
    // Use raw SQL for better performance with complex joins
    const query = `
      SELECT 
        ut.id,
        ut.transaction_id,
        ut.user_email,
        ut.amount,
        ut.balance_before,
        ut.balance_after,
        ut.method_type,
        ut.notes,
        ut.created_at,
        ut.updated_at,
        COALESCE(lu.name, du.name) as user_name,
        COALESCE(lu.account_number, du.account_number) as user_account_number
      FROM user_transactions ut
      LEFT JOIN live_users lu ON ut.user_id = lu.id AND ut.user_type = 'live'
      LEFT JOIN demo_users du ON ut.user_id = du.id AND ut.user_type = 'demo'
      WHERE ${this._buildWhereClause(whereClause)}
      ORDER BY ut.created_at DESC
      LIMIT :limit OFFSET :offset
    `;

    const replacements = {
      limit,
      offset,
      ...this._extractWhereValues(whereClause)
    };

    const results = await sequelize.query(query, {
      replacements,
      type: sequelize.QueryTypes.SELECT
    });

    return results;
  }

  /**
   * Build WHERE clause for raw SQL query
   * @private
   */
  _buildWhereClause(whereClause) {
    const conditions = [];
    
    if (whereClause.type) {
      conditions.push('ut.type = :type');
    }
    
    if (whereClause.status) {
      conditions.push('ut.status = :status');
    }
    
    if (whereClause.method_type) {
      conditions.push('ut.method_type = :method_type');
    }
    
    if (whereClause[Op.or]) {
      const orConditions = whereClause[Op.or].map((condition, index) => 
        `(ut.user_id = :user_id_${index} AND ut.user_type = :user_type_${index})`
      ).join(' OR ');
      conditions.push(`(${orConditions})`);
    }
    
    return conditions.join(' AND ');
  }

  /**
   * Extract values from where clause for SQL replacements
   * @private
   */
  _extractWhereValues(whereClause) {
    const values = {};
    
    if (whereClause.type) values.type = whereClause.type;
    if (whereClause.status) values.status = whereClause.status;
    if (whereClause.method_type) values.method_type = whereClause.method_type;
    
    if (whereClause[Op.or]) {
      whereClause[Op.or].forEach((condition, index) => {
        values[`user_id_${index}`] = condition.user_id;
        values[`user_type_${index}`] = condition.user_type;
      });
    }
    
    return values;
  }

  /**
   * Get transaction statistics summary
   * @param {Object} params - Query parameters
   * @param {Object} params.admin - Admin information
   * @returns {Promise<Object>} Transaction statistics
   */
  async getTransactionStats({ admin }) {
    const operationId = `get_transaction_stats_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      logger.info(`[${operationId}] Fetching transaction statistics`, {
        admin_id: admin.id, admin_role: admin.role
      });

      // Build country filter for non-superadmin
      let userIds = null;
      if (admin.role !== 'superadmin' && admin.country_id) {
        const [liveUsers, demoUsers] = await Promise.all([
          LiveUser.findAll({
            where: { country_id: admin.country_id },
            attributes: ['id'],
            raw: true
          }),
          DemoUser.findAll({
            where: { country_id: admin.country_id },
            attributes: ['id'],
            raw: true
          })
        ]);

        userIds = [
          ...liveUsers.map(u => ({ user_id: u.id, user_type: 'live' })),
          ...demoUsers.map(u => ({ user_id: u.id, user_type: 'demo' }))
        ];
      }

      // Build base where clause
      let baseWhere = { status: 'completed' };
      if (userIds && userIds.length > 0) {
        baseWhere[Op.or] = userIds.map(({ user_id, user_type }) => ({
          user_id: user_id,
          user_type: user_type
        }));
      }

      // Get statistics for deposits and withdrawals
      const [depositStats, withdrawalStats] = await Promise.all([
        UserTransaction.findAll({
          where: { ...baseWhere, type: 'deposit' },
          attributes: [
            'method_type',
            [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
            [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount']
          ],
          group: ['method_type'],
          raw: true
        }),
        UserTransaction.findAll({
          where: { ...baseWhere, type: 'withdraw' },
          attributes: [
            'method_type',
            [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
            [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount']
          ],
          group: ['method_type'],
          raw: true
        })
      ]);

      return {
        deposits: depositStats.map(stat => ({
          method_type: stat.method_type || 'OTHER',
          count: parseInt(stat.count),
          total_amount: Math.abs(parseFloat(stat.total_amount || 0))
        })),
        withdrawals: withdrawalStats.map(stat => ({
          method_type: stat.method_type || 'OTHER',
          count: parseInt(stat.count),
          total_amount: Math.abs(parseFloat(stat.total_amount || 0))
        }))
      };

    } catch (error) {
      logger.error(`[${operationId}] Error fetching transaction statistics:`, error);
      throw error;
    }
  }
}

module.exports = new AdminTransactionService();
