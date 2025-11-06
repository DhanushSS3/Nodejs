const sequelize = require('../config/db');
const { Transaction } = require('sequelize');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const UserTransaction = require('../models/userTransaction.model');
const idGenerator = require('./idGenerator.service');
const logger = require('./logger.service');
const { redisCluster } = require('../../config/redis');

/**
 * Calculate and apply performance fee for copy follower order closure
 * Performance fee is only charged on profitable orders
 * @param {Object} params - Performance fee calculation parameters
 * @param {string} params.copyFollowerOrderId - Copy follower order ID
 * @param {number} params.copyFollowerUserId - Copy follower user ID
 * @param {number} params.strategyProviderId - Strategy provider account ID
 * @param {number} params.orderNetProfit - Net profit from the order (before performance fee)
 * @param {string} params.symbol - Trading symbol
 * @param {string} params.orderType - Order type (BUY/SELL)
 * @returns {Object} Performance fee calculation result
 */
async function calculateAndApplyPerformanceFee({
  copyFollowerOrderId,
  copyFollowerUserId,
  strategyProviderId,
  orderNetProfit,
  symbol,
  orderType
}) {
  // Only charge performance fee on profitable orders
  if (!orderNetProfit || orderNetProfit <= 0) {
    logger.info('No performance fee - order not profitable', {
      copyFollowerOrderId,
      copyFollowerUserId,
      strategyProviderId,
      orderNetProfit
    });
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: 0,
      adjustedNetProfit: orderNetProfit,
      reason: 'order_not_profitable'
    };
  }

  try {
    // Get strategy provider to fetch performance fee percentage
    const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
    if (!strategyProvider) {
      throw new Error(`Strategy provider not found: ${strategyProviderId}`);
    }

    const performanceFeePercentage = parseFloat(strategyProvider.performance_fee || 0);
    if (performanceFeePercentage <= 0) {
      logger.info('No performance fee - strategy provider has 0% fee', {
        copyFollowerOrderId,
        strategyProviderId,
        performanceFeePercentage
      });
      return {
        performanceFeeCharged: false,
        performanceFeeAmount: 0,
        adjustedNetProfit: orderNetProfit,
        reason: 'zero_performance_fee'
      };
    }

    // Calculate performance fee amount
    const performanceFeeAmount = (orderNetProfit * performanceFeePercentage) / 100;
    const adjustedNetProfit = orderNetProfit - performanceFeeAmount;

    logger.info('Calculating performance fee', {
      copyFollowerOrderId,
      copyFollowerUserId,
      strategyProviderId,
      orderNetProfit,
      performanceFeePercentage,
      performanceFeeAmount,
      adjustedNetProfit
    });

    // Apply performance fee in a transaction
    const result = await sequelize.transaction({ 
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED 
    }, async (t) => {
      // 1. Deduct performance fee from copy follower
      const copyFollower = await CopyFollowerAccount.findByPk(copyFollowerUserId, {
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      
      if (!copyFollower) {
        throw new Error(`Copy follower account not found: ${copyFollowerUserId}`);
      }

      const followerBalanceBefore = parseFloat(copyFollower.wallet_balance || 0);
      const followerBalanceAfter = followerBalanceBefore - performanceFeeAmount;

      // Update copy follower balance
      await copyFollower.update({ 
        wallet_balance: followerBalanceAfter 
      }, { transaction: t });

      // 2. Add performance fee to strategy provider
      const providerBalanceBefore = parseFloat(strategyProvider.wallet_balance || 0);
      const providerBalanceAfter = providerBalanceBefore + performanceFeeAmount;

      await strategyProvider.update({ 
        wallet_balance: providerBalanceAfter 
      }, { transaction: t });

      // 3. Create transaction records for audit trail
      
      // Copy follower debit transaction
      const followerTxnId = await idGenerator.generateTransactionId();
      await UserTransaction.create({
        transaction_id: followerTxnId,
        user_id: copyFollowerUserId,
        user_type: 'copy_follower',
        order_id: copyFollowerOrderId, // Link to the copy follower order
        type: 'performance_fee',
        amount: -Math.abs(performanceFeeAmount),
        balance_before: followerBalanceBefore,
        balance_after: followerBalanceAfter,
        status: 'completed',
        notes: `Performance fee for order ${copyFollowerOrderId} to strategy provider ${strategyProviderId}`,
        metadata: {
          copy_follower_order_id: copyFollowerOrderId,
          strategy_provider_id: strategyProviderId,
          performance_fee_percentage: performanceFeePercentage,
          order_net_profit: orderNetProfit,
          symbol,
          order_type: orderType
        }
      }, { transaction: t });

      // Strategy provider credit transaction
      const providerTxnId = await idGenerator.generateTransactionId();
      await UserTransaction.create({
        transaction_id: providerTxnId,
        user_id: strategyProviderId,
        user_type: 'strategy_provider',
        order_id: copyFollowerOrderId, // Link to the copy follower order that generated the fee
        type: 'performance_fee_earned',
        amount: Math.abs(performanceFeeAmount),
        balance_before: providerBalanceBefore,
        balance_after: providerBalanceAfter,
        status: 'completed',
        notes: `Performance fee earned from copy follower ${copyFollowerUserId} order ${copyFollowerOrderId}`,
        metadata: {
          copy_follower_order_id: copyFollowerOrderId,
          copy_follower_user_id: copyFollowerUserId,
          performance_fee_percentage: performanceFeePercentage,
          order_net_profit: orderNetProfit,
          symbol,
          order_type: orderType
        }
      }, { transaction: t });

      // 4. Update copy follower order with performance fee details
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      const currentDate = new Date();
      
      await CopyFollowerOrder.update({
        performance_fee_percentage: performanceFeePercentage,
        gross_profit: orderNetProfit,
        performance_fee_amount: performanceFeeAmount,
        net_profit_after_fees: adjustedNetProfit,
        fee_status: 'paid',
        fee_calculation_date: currentDate,
        fee_payment_date: currentDate
      }, {
        where: { order_id: copyFollowerOrderId },
        transaction: t
      });

      return {
        followerBalanceBefore,
        followerBalanceAfter,
        providerBalanceBefore,
        providerBalanceAfter,
        followerTxnId,
        providerTxnId,
        performanceFeePercentage,
        grossProfit: orderNetProfit,
        performanceFeeAmount,
        netProfitAfterFees: adjustedNetProfit
      };
    });

    // Update Redis cache for both accounts (best-effort)
    try {
      // Update copy follower Redis cache
      const followerKey = `user:{copy_follower:${copyFollowerUserId}}:config`;
      await redisCluster.hset(followerKey, { 
        wallet_balance: String(result.followerBalanceAfter) 
      });

      // Update strategy provider Redis cache
      const providerKey = `user:{strategy_provider:${strategyProviderId}}:config`;
      await redisCluster.hset(providerKey, { 
        wallet_balance: String(result.providerBalanceAfter) 
      });
    } catch (redisError) {
      logger.warn('Failed to update Redis cache after performance fee', { 
        error: redisError.message,
        copyFollowerUserId,
        strategyProviderId
      });
    }

    logger.info('Performance fee applied successfully', {
      copyFollowerOrderId,
      copyFollowerUserId,
      strategyProviderId,
      performanceFeeAmount,
      adjustedNetProfit,
      followerBalanceChange: result.followerBalanceAfter - result.followerBalanceBefore,
      providerBalanceChange: result.providerBalanceAfter - result.providerBalanceBefore
    });

    return {
      performanceFeeCharged: true,
      performanceFeeAmount,
      adjustedNetProfit,
      performanceFeePercentage,
      followerTxnId: result.followerTxnId,
      providerTxnId: result.providerTxnId,
      reason: 'performance_fee_applied'
    };

  } catch (error) {
    logger.error('Failed to calculate and apply performance fee', {
      copyFollowerOrderId,
      copyFollowerUserId,
      strategyProviderId,
      orderNetProfit,
      error: error.message
    });
    throw error;
  }
}

module.exports = {
  calculateAndApplyPerformanceFee
};
