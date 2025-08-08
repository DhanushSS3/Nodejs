const TransactionService = require('./transaction.service');
const logger = require('./logger.service');
const DemoUser = require('../models/demoUser.model');
const LiveUser = require('../models/liveUser.model');

/**
 * Financial operations service with atomic transactions and locking
 * All financial operations MUST go through this service
 */
class FinancialService {
  /**
   * Update user wallet balance atomically
   * @param {number} userId 
   * @param {number} amount - Can be positive (credit) or negative (debit)
   * @param {string} userType - 'demo' or 'live'
   * @param {string} reason - Reason for balance update
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>}
   */
  static async updateWalletBalance(userId, amount, userType = 'demo', reason = 'manual', metadata = {}) {
    const operationId = `wallet_update_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.transactionStart('update_wallet_balance', {
      operationId,
      userId,
      amount,
      userType,
      reason,
      metadata
    });

    const userModel = userType === 'live' ? LiveUser : DemoUser;

    return await TransactionService.executeWithUserLock(userId, async (transaction, user) => {
      const oldBalance = parseFloat(user.wallet_balance) || 0;
      const newBalance = oldBalance + amount;

      // Prevent negative balances for debits (unless explicitly allowed)
      if (newBalance < 0 && !metadata.allowNegative) {
        throw new Error(`Insufficient balance. Current: ${oldBalance}, Requested: ${amount}`);
      }

      // Update balance
      await user.update({ 
        wallet_balance: newBalance 
      }, { transaction });

      logger.financial('wallet_balance_updated', {
        operationId,
        userId,
        userType,
        oldBalance,
        newBalance,
        amount,
        reason,
        metadata
      });

      return {
        success: true,
        oldBalance,
        newBalance,
        amount,
        operationId
      };
    }, { userModel });
  }

  /**
   * Update user margin atomically
   * @param {number} userId 
   * @param {number} amount 
   * @param {string} userType 
   * @param {string} reason 
   * @param {Object} metadata 
   * @returns {Promise<Object>}
   */
  static async updateMargin(userId, amount, userType = 'demo', reason = 'trade', metadata = {}) {
    const operationId = `margin_update_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.transactionStart('update_margin', {
      operationId,
      userId,
      amount,
      userType,
      reason,
      metadata
    });

    const userModel = userType === 'live' ? LiveUser : DemoUser;

    return await TransactionService.executeWithUserLock(userId, async (transaction, user) => {
      const oldMargin = parseFloat(user.margin) || 0;
      const newMargin = oldMargin + amount;

      // Prevent negative margin
      if (newMargin < 0) {
        throw new Error(`Insufficient margin. Current: ${oldMargin}, Requested: ${amount}`);
      }

      await user.update({ 
        margin: newMargin 
      }, { transaction });

      logger.financial('margin_updated', {
        operationId,
        userId,
        userType,
        oldMargin,
        newMargin,
        amount,
        reason,
        metadata
      });

      return {
        success: true,
        oldMargin,
        newMargin,
        amount,
        operationId
      };
    }, { userModel });
  }

  /**
   * Update net profit atomically
   * @param {number} userId 
   * @param {number} amount 
   * @param {string} userType 
   * @param {string} reason 
   * @param {Object} metadata 
   * @returns {Promise<Object>}
   */
  static async updateNetProfit(userId, amount, userType = 'demo', reason = 'trade_close', metadata = {}) {
    const operationId = `profit_update_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.transactionStart('update_net_profit', {
      operationId,
      userId,
      amount,
      userType,
      reason,
      metadata
    });

    const userModel = userType === 'live' ? LiveUser : DemoUser;

    return await TransactionService.executeWithUserLock(userId, async (transaction, user) => {
      const oldProfit = parseFloat(user.net_profit) || 0;
      const newProfit = oldProfit + amount;

      await user.update({ 
        net_profit: newProfit 
      }, { transaction });

      logger.financial('net_profit_updated', {
        operationId,
        userId,
        userType,
        oldProfit,
        newProfit,
        amount,
        reason,
        metadata
      });

      return {
        success: true,
        oldProfit,
        newProfit,
        amount,
        operationId
      };
    }, { userModel });
  }

  /**
   * Combined financial operation (e.g., close trade and update balance)
   * @param {number} userId 
   * @param {Object} operations - Object with balance, margin, profit changes
   * @param {string} userType 
   * @param {string} reason 
   * @param {Object} metadata 
   * @returns {Promise<Object>}
   */
  static async performCombinedOperation(userId, operations, userType = 'demo', reason = 'trade_operation', metadata = {}) {
    const operationId = `combined_op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.transactionStart('combined_financial_operation', {
      operationId,
      userId,
      operations,
      userType,
      reason,
      metadata
    });

    const userModel = userType === 'live' ? LiveUser : DemoUser;

    return await TransactionService.executeWithUserLock(userId, async (transaction, user) => {
      const updates = {};
      const results = {};

      // Update wallet balance
      if (operations.balance !== undefined) {
        const oldBalance = parseFloat(user.wallet_balance) || 0;
        const newBalance = oldBalance + operations.balance;
        
        if (newBalance < 0 && !metadata.allowNegativeBalance) {
          throw new Error(`Insufficient balance. Current: ${oldBalance}, Requested: ${operations.balance}`);
        }
        
        updates.wallet_balance = newBalance;
        results.balance = { old: oldBalance, new: newBalance, change: operations.balance };
      }

      // Update margin
      if (operations.margin !== undefined) {
        const oldMargin = parseFloat(user.margin) || 0;
        const newMargin = oldMargin + operations.margin;
        
        if (newMargin < 0) {
          throw new Error(`Insufficient margin. Current: ${oldMargin}, Requested: ${operations.margin}`);
        }
        
        updates.margin = newMargin;
        results.margin = { old: oldMargin, new: newMargin, change: operations.margin };
      }

      // Update net profit
      if (operations.profit !== undefined) {
        const oldProfit = parseFloat(user.net_profit) || 0;
        const newProfit = oldProfit + operations.profit;
        
        updates.net_profit = newProfit;
        results.profit = { old: oldProfit, new: newProfit, change: operations.profit };
      }

      // Apply all updates atomically
      await user.update(updates, { transaction });

      logger.financial('combined_operation_completed', {
        operationId,
        userId,
        userType,
        updates,
        results,
        reason,
        metadata
      });

      return {
        success: true,
        results,
        operationId
      };
    }, { userModel });
  }
}

module.exports = FinancialService;