const sequelize = require('../config/db');
const { Transaction } = require('sequelize');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const MAMAccount = require('../models/mamAccount.model');
const MAMOrder = require('../models/mamOrder.model');
const MAMAssignment = require('../models/mamAssignment.model');
const UserTransaction = require('../models/userTransaction.model');
const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');
const idGenerator = require('./idGenerator.service');
const logger = require('./logger.service');
const portfolioEvents = require('./events/portfolio.events');
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
}, options = {}) {
  const { adjustAccountNetProfit = false } = options;
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
      const followerNetProfitBefore = parseFloat(copyFollower.net_profit || 0);
      const followerBalanceAfter = followerBalanceBefore - performanceFeeAmount;
      const followerNetProfitAfter = adjustAccountNetProfit
        ? followerNetProfitBefore - performanceFeeAmount
        : followerNetProfitBefore;

      // Update copy follower balance (and net profit if requested)
      const copyFollowerUpdate = {
        wallet_balance: followerBalanceAfter
      };

      if (adjustAccountNetProfit) {
        copyFollowerUpdate.net_profit = followerNetProfitAfter;
      }

      await copyFollower.update(copyFollowerUpdate, { transaction: t });

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

async function _updateMamOrderDerivedProfits(parentMamOrderId, transaction) {
  if (!parentMamOrderId) return;

  const baseWhere = {
    parent_mam_order_id: parentMamOrderId,
    order_status: 'CLOSED'
  };

  const [grossRow, netAfterFeesRow] = await Promise.all([
    LiveUserOrder.findOne({
      attributes: [[sequelize.fn('SUM', sequelize.col('net_profit')), 'gross_sum']],
      where: baseWhere,
      transaction,
      raw: true
    }),
    LiveUserOrder.findOne({
      attributes: [[
        sequelize.fn('SUM', sequelize.literal('COALESCE(net_profit_after_fees, net_profit)')),
        'net_after_fees_sum'
      ]],
      where: baseWhere,
      transaction,
      raw: true
    })
  ]);

  const grossSum = grossRow?.gross_sum != null ? Number(grossRow.gross_sum) : 0;
  const netAfterFeesSum = netAfterFeesRow?.net_after_fees_sum != null
    ? Number(netAfterFeesRow.net_after_fees_sum)
    : grossSum;

  await MAMOrder.update({
    gross_profit: grossSum,
    net_profit_after_fees: netAfterFeesSum
  }, {
    where: { id: parentMamOrderId },
    transaction
  });
}

async function calculateAndApplyMamPerformanceFee({
  liveOrderId,
  liveUserId,
  parentMamOrderId,
  orderNetProfit,
  symbol,
  orderType
} = {}) {
  const normalizedOrderId = String(liveOrderId || '').trim();
  const normalizedUserId = parseInt(String(liveUserId), 10);
  const normalizedNetProfit = Number(orderNetProfit) || 0;

  if (!normalizedOrderId || Number.isNaN(normalizedUserId)) {
    throw new Error('liveOrderId and liveUserId are required for MAM performance fee calculation');
  }

  if (normalizedNetProfit <= 0) {
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: 0,
      adjustedNetProfit: normalizedNetProfit,
      reason: 'order_not_profitable'
    };
  }

  const existingOrder = await LiveUserOrder.findOne({ where: { order_id: normalizedOrderId } });
  if (!existingOrder) {
    throw new Error(`Live user order not found for performance fee: ${normalizedOrderId}`);
  }

  const effectiveParentMamOrderId = parentMamOrderId || existingOrder.parent_mam_order_id;
  if (!effectiveParentMamOrderId) {
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: 0,
      adjustedNetProfit: normalizedNetProfit,
      reason: 'not_mam_child_order'
    };
  }

  if (Number(existingOrder.performance_fee_amount) > 0 || Number(existingOrder.net_profit_after_fees) > 0) {
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: Number(existingOrder.performance_fee_amount) || 0,
      adjustedNetProfit: Number(existingOrder.net_profit_after_fees) || normalizedNetProfit,
      reason: 'performance_fee_already_applied'
    };
  }

  const mamOrder = await MAMOrder.findByPk(effectiveParentMamOrderId);
  if (!mamOrder) {
    throw new Error(`Parent MAM order not found for child order ${normalizedOrderId}`);
  }

  const mamAccountId = mamOrder.mam_account_id;
  const mamAccount = await MAMAccount.findByPk(mamAccountId);
  if (!mamAccount || mamAccount.status !== 'active') {
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: 0,
      adjustedNetProfit: normalizedNetProfit,
      reason: 'mam_account_inactive'
    };
  }

  const performanceFeePercentage = Number(mamAccount.performance_fee_percent || 0);
  if (!(performanceFeePercentage > 0)) {
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: 0,
      adjustedNetProfit: normalizedNetProfit,
      reason: 'zero_performance_fee'
    };
  }

  const activeAssignment = await MAMAssignment.findOne({
    where: {
      mam_account_id: mamAccountId,
      client_live_user_id: normalizedUserId,
      status: ASSIGNMENT_STATUS.ACTIVE
    }
  });

  if (!activeAssignment) {
    return {
      performanceFeeCharged: false,
      performanceFeeAmount: 0,
      adjustedNetProfit: normalizedNetProfit,
      reason: 'assignment_not_active'
    };
  }

  const rawFee = (normalizedNetProfit * performanceFeePercentage) / 100;
  const performanceFeeAmount = Math.min(normalizedNetProfit, Number(rawFee.toFixed(8)));
  const adjustedNetProfit = Math.max(0, Number((normalizedNetProfit - performanceFeeAmount).toFixed(8)));

  const result = await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (t) => {
    const [liveUser, mamAccountForUpdate, liveOrderForUpdate] = await Promise.all([
      LiveUser.findByPk(normalizedUserId, { transaction: t, lock: t.LOCK.UPDATE }),
      MAMAccount.findByPk(mamAccountId, { transaction: t, lock: t.LOCK.UPDATE }),
      LiveUserOrder.findOne({ where: { order_id: normalizedOrderId }, transaction: t, lock: t.LOCK.UPDATE })
    ]);

    if (!liveUser || !mamAccountForUpdate || !liveOrderForUpdate) {
      throw new Error('Failed to lock rows required for MAM performance fee application');
    }

    const liveBalanceBefore = Number(liveUser.wallet_balance || 0);
    const liveBalanceAfter = liveBalanceBefore - performanceFeeAmount;
    const liveNetBefore = Number(liveUser.net_profit || 0);
    const liveNetAfter = liveNetBefore - performanceFeeAmount;

    await liveUser.update({
      wallet_balance: liveBalanceAfter,
      net_profit: liveNetAfter
    }, { transaction: t });

    const mamBalanceBefore = Number(mamAccountForUpdate.mam_balance || 0);
    const mamBalanceAfter = mamBalanceBefore + performanceFeeAmount;

    await mamAccountForUpdate.update({ mam_balance: mamBalanceAfter }, { transaction: t });

    await liveOrderForUpdate.update({
      performance_fee_amount: performanceFeeAmount,
      net_profit_after_fees: adjustedNetProfit
    }, { transaction: t });

    await _updateMamOrderDerivedProfits(effectiveParentMamOrderId, t);

    const liveTxnId = await idGenerator.generateTransactionId();
    await UserTransaction.create({
      transaction_id: liveTxnId,
      user_id: normalizedUserId,
      user_type: 'live',
      order_id: normalizedOrderId,
      type: 'performance_fee',
      amount: -Math.abs(performanceFeeAmount),
      balance_before: liveBalanceBefore,
      balance_after: liveBalanceAfter,
      status: 'completed',
      notes: `Performance fee for MAM order ${normalizedOrderId}`,
      metadata: {
        mam_account_id: mamAccountId,
        parent_mam_order_id: effectiveParentMamOrderId,
        performance_fee_percentage: performanceFeePercentage,
        order_net_profit: normalizedNetProfit,
        symbol,
        order_type: orderType
      }
    }, { transaction: t });

    const mamTxnId = await idGenerator.generateTransactionId();
    await UserTransaction.create({
      transaction_id: mamTxnId,
      user_id: mamAccountId,
      user_type: 'mam_account',
      order_id: normalizedOrderId,
      type: 'performance_fee_earned',
      amount: Math.abs(performanceFeeAmount),
      balance_before: mamBalanceBefore,
      balance_after: mamBalanceAfter,
      status: 'completed',
      notes: `Performance fee earned from live user ${normalizedUserId} order ${normalizedOrderId}`,
      metadata: {
        client_live_user_id: normalizedUserId,
        parent_mam_order_id: effectiveParentMamOrderId,
        performance_fee_percentage: performanceFeePercentage,
        order_net_profit: normalizedNetProfit,
        symbol,
        order_type: orderType
      }
    }, { transaction: t });

    return {
      liveBalanceBefore,
      liveBalanceAfter,
      liveNetAfter,
      mamBalanceBefore,
      mamBalanceAfter,
      liveTxnId,
      mamTxnId
    };
  });

  try {
    await redisCluster.hset(`user:{live:${normalizedUserId}}:config`, {
      wallet_balance: String(result.liveBalanceAfter)
    });
  } catch (error) {
    logger.warn('Failed to update Redis cache for live user after MAM performance fee', {
      error: error.message,
      liveUserId: normalizedUserId
    });
  }

  try {
    await redisCluster.hset(`mam_account:${mamAccountId}:summary`, {
      mam_balance: String(result.mamBalanceAfter)
    });
  } catch (error) {
    logger.warn('Failed to update Redis cache for MAM account after performance fee', {
      error: error.message,
      mamAccountId
    });
  }

  try {
    portfolioEvents.emitUserUpdate('live', String(normalizedUserId), {
      type: 'wallet_balance_update',
      reason: 'mam_performance_fee',
      order_id: normalizedOrderId
    });
    portfolioEvents.emitUserUpdate('live', String(normalizedUserId), {
      type: 'order_update',
      order_id: normalizedOrderId,
      update: {
        performance_fee_amount: performanceFeeAmount,
        net_profit_after_fees: adjustedNetProfit
      }
    });
  } catch (error) {
    logger.warn('Failed to emit live user portfolio events after MAM performance fee', {
      error: error.message,
      liveUserId: normalizedUserId,
      liveOrderId: normalizedOrderId
    });
  }

  try {
    portfolioEvents.emitUserUpdate('mam_account', String(mamAccountId), {
      type: 'wallet_balance_update',
      reason: 'performance_fee_earned',
      parent_mam_order_id: effectiveParentMamOrderId,
      order_id: normalizedOrderId
    });
  } catch (error) {
    logger.warn('Failed to emit MAM account portfolio event after performance fee', {
      error: error.message,
      mamAccountId,
      liveOrderId: normalizedOrderId
    });
  }

  logger.info('Applied MAM performance fee', {
    liveOrderId: normalizedOrderId,
    liveUserId: normalizedUserId,
    parentMamOrderId: effectiveParentMamOrderId,
    mamAccountId,
    performanceFeeAmount,
    performanceFeePercentage,
    adjustedNetProfit
  });

  return {
    performanceFeeCharged: true,
    performanceFeeAmount,
    adjustedNetProfit,
    performanceFeePercentage,
    mamAccountId,
    parentMamOrderId: effectiveParentMamOrderId,
    reason: 'performance_fee_applied'
  };
}

module.exports = {
  calculateAndApplyPerformanceFee,
  calculateAndApplyMamPerformanceFee
};
