const MoneyRequest = require('../models/moneyRequest.model');
const LiveUser = require('../models/liveUser.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const Admin = require('../models/admin.model');
const idGeneratorService = require('./idGenerator.service');
const walletService = require('./wallet.service');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const sequelize = require('../config/db');

class MoneyRequestService {
  /**
   * Create a new money request
   * @param {Object} requestData - Request data
   * @param {number} requestData.userId - User ID
   * @param {string} requestData.type - 'deposit' or 'withdraw'
   * @param {number} requestData.amount - Amount requested
   * @param {string} [requestData.currency] - Currency (default: USD)
   * @param {string} [requestData.methodType] - Withdrawal method type when type==='withdraw' (BANK|UPI|SWIFT|IBAN|PAYPAL|CRYPTO|OTHER)
   * @param {Object} [requestData.methodDetails] - Arbitrary JSON payload with user-provided payout details
   * @param {string} [requestData.accountNumber] - Platform account number snapshot
   * @returns {Promise<Object>} Created money request
   */
  async createRequest(requestData) {
    const {
      userId,
      initiatorAccountType = 'live',
      targetAccountId = null,
      targetAccountType = null,
      type,
      amount,
      currency = 'USD',
      methodType,
      methodDetails = null,
      accountNumber = null
    } = requestData;
    const operationId = `create_money_request_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      logger.info(`[${operationId}] Creating ${type} request`, {
        userId,
        initiatorAccountType,
        targetAccountId,
        targetAccountType,
        amount
      });

      if (!userId) {
        throw new Error('userId is required');
      }

      const normalizedInitiatorType = (initiatorAccountType || 'live').toString().toLowerCase();
      const normalizedTargetType = (targetAccountType || normalizedInitiatorType || 'live').toString().toLowerCase();
      const supportedAccountTypes = ['live', 'strategy_provider', 'copy_follower'];

      if (!supportedAccountTypes.includes(normalizedInitiatorType)) {
        throw new Error(`Unsupported initiatorAccountType: ${initiatorAccountType}`);
      }

      if (!supportedAccountTypes.includes(normalizedTargetType)) {
        throw new Error(`Unsupported targetAccountType: ${targetAccountType}`);
      }

      // Validate user exists
      const user = await LiveUser.findByPk(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Validate amount
      if (!amount || amount <= 0) {
        throw new Error('Amount must be positive');
      }

      let effectiveTargetAccountId = targetAccountId;
      if (!effectiveTargetAccountId && normalizedTargetType === 'live') {
        effectiveTargetAccountId = userId;
      }

      let targetAccountSnapshot = null;

      // For withdrawals, check if user has sufficient balance
      if (type === 'withdraw') {
        if (!effectiveTargetAccountId) {
          throw new Error('targetAccountId is required for withdrawal requests');
        }

        const parsedTargetId = parseInt(effectiveTargetAccountId, 10);
        if (Number.isNaN(parsedTargetId) || parsedTargetId <= 0) {
          throw new Error('targetAccountId must be a positive integer');
        }

        targetAccountSnapshot = await this.findAccountRecord(normalizedTargetType, parsedTargetId);
        if (!targetAccountSnapshot) {
          throw new Error('Target account not found');
        }

        const currentBalance = parseFloat(targetAccountSnapshot.wallet_balance || 0);
        if (currentBalance < amount) {
          const error = new Error('Insufficient balance for withdrawal request');
          error.statusCode = 400;
          throw error;
        }

        // Validate method type
        const allowedMethods = ['BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'];
        if (!methodType || !allowedMethods.includes(methodType)) {
          throw new Error('Invalid or missing withdrawal method_type');
        }

        effectiveTargetAccountId = parsedTargetId;
      } else {
        // Default snapshot for non-withdraw requests
        effectiveTargetAccountId = userId;
        targetAccountSnapshot = user;
      }

      const snapshotAccountNumber = accountNumber
        || (targetAccountSnapshot && targetAccountSnapshot.account_number)
        || user.account_number;

      if (!snapshotAccountNumber) {
        throw new Error('Account number snapshot is required');
      }

      // Generate unique request ID
      const requestId = idGeneratorService.generateMoneyRequestId();

      // Create the request
      const moneyRequest = await MoneyRequest.create({
        request_id: requestId,
        user_id: userId,
        initiator_user_id: userId,
        initiator_user_type: normalizedInitiatorType,
        target_account_id: effectiveTargetAccountId,
        target_account_type: normalizedTargetType,
        account_number: snapshotAccountNumber,
        method_type: type === 'withdraw' ? methodType : null,
        method_details: type === 'withdraw' ? methodDetails : null,
        type,
        amount: parseFloat(amount),
        currency,
        status: 'pending'
      });

      logger.info(`[${operationId}] Money request created successfully: ${requestId}`);

      // Return plain object without associations to avoid coupling
      return moneyRequest;
    } catch (error) {
      logger.error(`[${operationId}] Error creating money request:`, error);
      throw error;
    }
  }

  getAccountModelByType(accountType = 'live') {
    switch ((accountType || 'live').toString().toLowerCase()) {
      case 'strategy_provider':
        return StrategyProviderAccount;
      case 'copy_follower':
        return CopyFollowerAccount;
      case 'live':
      default:
        return LiveUser;
    }
  }

  async findAccountRecord(accountType, accountId) {
    const Model = this.getAccountModelByType(accountType);
    if (!Model) {
      return null;
    }
    return Model.findByPk(accountId);
  }

  /**
   * Get money request by ID with associations
   * @param {number} id - Request ID
   * @returns {Promise<Object>} Money request with user and admin data
   */
  async getRequestById(id) {
    try {
      const request = await MoneyRequest.findByPk(id, {
        include: [
          {
            model: LiveUser,
            as: 'user',
            attributes: ['id', 'name', 'email', 'account_number']
          },
          {
            model: Admin,
            as: 'admin',
            attributes: ['id', 'username', 'email'],
            required: false
          }
        ]
      });

      if (!request) {
        throw new Error('Money request not found');
      }

      return request;
    } catch (error) {
      logger.error('Error fetching money request:', error);
      throw error;
    }
  }

  /**
   * Get money request by request_id
   * @param {string} requestId - Request ID (e.g., REQ20250001)
   * @returns {Promise<Object>} Money request
   */
  async getRequestByRequestId(requestId) {
    try {
      const request = await MoneyRequest.findOne({
        where: { request_id: requestId },
        include: [
          {
            model: LiveUser,
            as: 'user',
            attributes: ['id', 'name', 'email', 'account_number']
          },
          {
            model: Admin,
            as: 'admin',
            attributes: ['id', 'username', 'email'],
            required: false
          }
        ]
      });

      if (!request) {
        throw new Error('Money request not found');
      }

      return request;
    } catch (error) {
      logger.error('Error fetching money request by request_id:', error);
      throw error;
    }
  }

  /**
   * Get pending requests for admin review
   * @param {Object} filters - Filter options
   * @param {string} filters.type - 'deposit' or 'withdraw'
   * @param {number} filters.limit - Limit results
   * @param {number} filters.offset - Offset for pagination
   * @returns {Promise<Object>} Pending requests with pagination
   */
  async getPendingRequests(filters = {}) {
    try {
      const { type, status = 'pending', limit = 50, offset = 0 } = filters;
      
      const whereClause = { status };
      if (type) {
        whereClause.type = type;
      }

      const { count, rows } = await MoneyRequest.findAndCountAll({
        where: whereClause,
        include: [
          {
            model: LiveUser,
            as: 'user',
            attributes: ['id', 'name', 'email', 'account_number']
          }
        ],
        order: [['created_at', 'ASC']], // Oldest first for FIFO processing
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      return {
        requests: rows.map((row) => {
          const data = row.toJSON ? row.toJSON() : row;
          const user = data.user || row.user || null;
          return {
            ...data,
            user_email: user && user.email ? user.email : null,
            user_account_number: user && user.account_number ? user.account_number : null
          };
        }),
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (offset + limit) < count
      };
    } catch (error) {
      logger.error('Error fetching pending requests:', error);
      throw error;
    }
  }

  /**
   * Get user's money request history
   * @param {number} userId - User ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>} User's money requests
   */
  async getUserRequests(userId, filters = {}) {
    try {
      const { type, status, limit = 50, offset = 0 } = filters;
      
      const whereClause = { user_id: userId };
      if (type) whereClause.type = type;
      if (status) whereClause.status = status;

      const requests = await MoneyRequest.findAll({
        where: whereClause,
        include: [
          {
            model: Admin,
            as: 'admin',
            attributes: ['id', 'username'],
            required: false
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      return requests;
    } catch (error) {
      logger.error('Error fetching user requests:', error);
      throw error;
    }
  }

  /**
   * Approve a money request and create transaction
   * @param {number} requestId - Request ID
   * @param {number} adminId - Admin ID approving the request
   * @param {string} notes - Admin notes
   * @returns {Promise<Object>} Updated request with transaction
   */
  async approveRequest(requestId, adminId, notes = null) {
    const operationId = `approve_request_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const transaction = await sequelize.transaction();

    try {
      logger.info(`[${operationId}] Approving request ${requestId} by admin ${adminId}`);

      // Get the request with user information
      const request = await MoneyRequest.findByPk(requestId, { 
        transaction,
        include: [
          {
            model: LiveUser,
            as: 'user',
            attributes: ['id', 'name', 'email', 'account_number']
          }
        ]
      });
      if (!request) {
        throw new Error('Money request not found');
      }

      if (!['pending', 'on_hold'].includes(request.status)) {
        throw new Error(`Request cannot be approved from status: ${request.status}`);
      }

      const targetAccountId = request.target_account_id || request.user_id;
      const targetAccountType = request.target_account_type || 'live';

      // For withdrawals, double-check balance
      if (request.type === 'withdraw') {
        const currentBalance = await walletService.getCurrentBalance(targetAccountId, targetAccountType);
        if (currentBalance < request.amount) {
          throw new Error('Insufficient balance for withdrawal');
        }
      }

      // Create the actual transaction
      const transactionData = {
        userId: targetAccountId,
        userType: targetAccountType,
        type: request.type,
        amount: request.type === 'withdraw' ? -Math.abs(request.amount) : Math.abs(request.amount),
        referenceId: request.request_id,
        adminId: adminId,
        userEmail: request.user ? request.user.email : null,
        methodType: request.method_type, // Add method type from the request
        notes: notes || `${request.type} approved via money request ${request.request_id}`,
        metadata: {
          money_request_id: request.id,
          approved_by_admin: adminId,
          original_request_amount: request.amount,
          currency: request.currency,
          method_details: request.method_details, // Store method details in metadata for reference
          initiator_user_id: request.initiator_user_id,
          initiator_user_type: request.initiator_user_type,
          target_account_id: targetAccountId,
          target_account_type: targetAccountType
        }
      };

      const walletTransaction = await walletService.createTransaction(transactionData);

      // Update the money request
      await request.update({
        status: 'approved',
        admin_id: adminId,
        approved_at: new Date(),
        notes: notes,
        transaction_id: walletTransaction.transaction_id
      }, { transaction });

      await transaction.commit();

      logger.info(`[${operationId}] Request approved successfully. Transaction ID: ${walletTransaction.transaction_id}`);

      return await this.getRequestById(requestId);
    } catch (error) {
      await transaction.rollback();
      logger.error(`[${operationId}] Error approving request:`, error);
      throw error;
    }
  }

  /**
   * Reject a money request
   * @param {number} requestId - Request ID
   * @param {number} adminId - Admin ID rejecting the request
   * @param {string} notes - Rejection reason
   * @returns {Promise<Object>} Updated request
   */
  async rejectRequest(requestId, adminId, notes) {
    const operationId = `reject_request_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      logger.info(`[${operationId}] Rejecting request ${requestId} by admin ${adminId}`);

      const request = await MoneyRequest.findByPk(requestId);
      if (!request) {
        throw new Error('Money request not found');
      }

      if (!['pending', 'on_hold'].includes(request.status)) {
        throw new Error(`Request cannot be rejected from status: ${request.status}`);
      }

      await request.update({
        status: 'rejected',
        admin_id: adminId,
        approved_at: new Date(),
        notes: notes || 'Request rejected by admin'
      });

      logger.info(`[${operationId}] Request rejected successfully`);

      return await this.getRequestById(requestId);
    } catch (error) {
      logger.error(`[${operationId}] Error rejecting request:`, error);
      throw error;
    }
  }

  /**
   * Get request statistics
   * @param {Object} filters - Date range and other filters
   * @returns {Promise<Object>} Statistics
   */
  async getRequestStatistics(filters = {}) {
    try {
      const { startDate, endDate, type } = filters;
      
      const whereClause = {};
      if (startDate && endDate) {
        whereClause.created_at = {
          [Op.between]: [new Date(startDate), new Date(endDate)]
        };
      }
      if (type) {
        whereClause.type = type;
      }

      const stats = await MoneyRequest.findAll({
        where: whereClause,
        attributes: [
          'status',
          'type',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount']
        ],
        group: ['status', 'type'],
        raw: true
      });

      return stats;
    } catch (error) {
      logger.error('Error fetching request statistics:', error);
      throw error;
    }
  }
}

module.exports = new MoneyRequestService();
