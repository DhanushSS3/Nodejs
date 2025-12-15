const sequelize = require('../config/db');
const { Transaction } = require('sequelize');
const { LiveUser, DemoUser } = require('../models');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const UserTransaction = require('../models/userTransaction.model');
const idGenerator = require('./idGenerator.service');
const logger = require('./logger.service');
const { redisCluster } = require('../../config/redis');
const { logOrderClosureSwap } = require('../utils/swap.logger');
const CatalogEligibilityRealtimeService = require('./catalogEligibilityRealtime.service');

function getUserModel(userType) {
  switch (userType) {
    case 'live':
      return LiveUser;
    case 'demo':
      return DemoUser;
    case 'strategy_provider':
      return StrategyProviderAccount;
    case 'copy_follower':
      return CopyFollowerAccount;
    default:
      return LiveUser; // Default fallback
  }
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apply order close payout atomically:
 * - Update user's wallet_balance by netProfit
 * - Create three transaction records: commission (debit), profit/loss (credit/debit), and swap (debit/credit)
 *
 * IMPORTANT: This function does NOT implement idempotency by itself.
 * Callers must guard with an external idempotency key (e.g., Redis NX) per order_id.
 */
async function applyOrderClosePayout({
  userType,
  userId,
  orderPk = null,              // numeric SQL PK of the order row if available
  orderIdStr = null,           // string order_id like ord_YYYYMMDD_XXX (for metadata)
  netProfit = 0,
  commission = 0,
  profitUsd = 0,
  swap = 0,
  symbol = null,
  orderType = null,
}) {
  const np = toNum(netProfit);
  const com = Math.max(0, toNum(commission));
  const sw = toNum(swap);
  const pUsd = toNum(profitUsd);

  // Profit/Loss transaction amount excludes swap (handled separately)
  // so that (profit_loss + (-commission) + swap) == net_profit
  const profitLossAmount = pUsd - com; // profit_usd minus commission only
  const profitLossType = profitLossAmount >= 0 ? 'profit' : 'loss';
  
  // Swap transaction amount (positive = credit, negative = debit)
  const swapAmount = sw;
  const swapType = swapAmount >= 0 ? 'swap' : 'swap'; // swap type is always 'swap'

  const UserModel = getUserModel(String(userType));

  const txResult = await sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (t) => {
    // Lock the user row for update to serialize wallet updates
    const user = await UserModel.findByPk(parseInt(String(userId), 10), {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!user) {
      throw new Error(`${String(userType)} user not found for payout`);
    }

    const balanceBefore = toNum(user.wallet_balance);
    const finalBalance = balanceBefore + np;

    // Running balance for audit trail across the two transactions
    let runningBalance = balanceBefore;

    // 1) Commission record (debit) if any
    if (com > 0) {
      const txnId = await idGenerator.generateTransactionId();
      const amount = -Math.abs(com);
      const after = runningBalance + amount;
      await UserTransaction.create({
        transaction_id: txnId,
        user_id: parseInt(String(userId), 10),
        user_type: String(userType),
        order_id: orderPk || null,
        type: 'commission',
        amount: amount,
        balance_before: runningBalance,
        balance_after: after,
        status: 'completed',
        notes: `Commission for order ${orderIdStr || orderPk || ''}`,
        metadata: {
          order_id: orderIdStr,
          order_pk: orderPk,
          symbol,
          order_type: orderType,
          commission,
          profit_usd: pUsd,
          net_profit: np,
          swap: sw,
        },
      }, { transaction: t });
      runningBalance = after;
    }

    // 2) Swap record (if swap amount exists)
    if (sw !== 0) {
      const txnId = await idGenerator.generateTransactionId();
      const amount = swapAmount; // Can be positive (credit) or negative (debit)
      const after = runningBalance + amount;
      await UserTransaction.create({
        transaction_id: txnId,
        user_id: parseInt(String(userId), 10),
        user_type: String(userType),
        order_id: orderPk || null,
        type: 'swap',
        amount: amount,
        balance_before: runningBalance,
        balance_after: after,
        status: 'completed',
        notes: `Swap charges for order ${orderIdStr || orderPk || ''}`,
        metadata: {
          order_id: orderIdStr,
          order_pk: orderPk,
          symbol,
          order_type: orderType,
          commission: com,
          profit_usd: pUsd,
          net_profit: np,
          swap: sw,
        },
      }, { transaction: t });
      runningBalance = after;
    }

    // 3) Profit/Loss record (excluding swap)
    {
      const txnId = await idGenerator.generateTransactionId();
      const amount = profitLossType === 'profit' ? Math.abs(profitLossAmount) : -Math.abs(profitLossAmount);
      const after = finalBalance; // ensure records reconcile to final wallet
      await UserTransaction.create({
        transaction_id: txnId,
        user_id: parseInt(String(userId), 10),
        user_type: String(userType),
        order_id: orderPk || null,
        type: profitLossType,
        amount: amount,
        balance_before: runningBalance,
        balance_after: after,
        status: 'completed',
        notes: `${profitLossType === 'profit' ? 'Profit' : 'Loss'} from order ${orderIdStr || orderPk || ''}`,
        metadata: {
          order_id: orderIdStr,
          order_pk: orderPk,
          symbol,
          order_type: orderType,
          commission: com,
          profit_usd: pUsd,
          net_profit: np,
          swap: sw,
        },
      }, { transaction: t });
      runningBalance = after;
    }

    // Update user's wallet balance and net_profit
    const currentNetProfit = toNum(user.net_profit);
    const newNetProfit = currentNetProfit + np;
    await user.update({ 
      wallet_balance: finalBalance,
      net_profit: newNetProfit 
    }, { transaction: t });

    logger.info('Applied order close payout', {
      userId: String(userId),
      userType: String(userType),
      orderPk,
      orderIdStr,
      balanceBefore,
      finalBalance,
      netProfit: np,
      commission: com,
      profitLossAmount,
      swap: sw,
    });

    // Log swap closure details if swap amount exists
    if (sw !== 0) {
      logOrderClosureSwap({
        order_id: orderIdStr || orderPk?.toString() || 'unknown',
        user_id: parseInt(String(userId), 10),
        user_type: String(userType),
        symbol: symbol || 'unknown',
        group_name: 'unknown', // Would need to be passed from caller
        order_type: orderType || 'unknown',
        order_quantity: 0, // Would need to be passed from caller
        order_duration_days: 0, // Would need to be calculated from order creation date
        total_swap_accumulated: sw,
        final_swap_transaction_id: null, // Swap transaction created separately
        closure_date: new Date().toISOString(),
        net_profit_before_swap: pUsd,
        net_profit_after_swap: np
      });
    }

    return { ok: true, balance_before: balanceBefore, balance_after: finalBalance };
  });

  // After successful commit, sync Redis user config wallet_balance (best-effort)
  try {
    const key = `user:{${String(userType)}:${String(userId)}}:config`;
    await redisCluster.hset(key, { wallet_balance: String(txResult.balance_after) });
    
    // For strategy providers and copy followers, also update their account-specific cache
    if (String(userType) === 'strategy_provider' || String(userType) === 'copy_follower') {
      logger.info('Updated wallet balance for copy trading account', {
        userType: String(userType),
        userId: String(userId),
        balanceAfter: txResult.balance_after,
        netProfit: np,
        commission: com
      });
    }
  } catch (e) {
    logger.warn('Failed to sync Redis wallet_balance after payout', { error: e.message, userId: String(userId), userType: String(userType) });
  }

  // Update catalog eligibility for strategy providers after profit/loss payout
  if (String(userType) === 'strategy_provider') {
    try {
      const eligibilityResult = await CatalogEligibilityRealtimeService.updateStrategyProviderEligibility(
        parseInt(String(userId), 10), 
        `order_payout_${profitLossType}`
      );
      
      logger.info('Catalog eligibility updated after order payout', {
        strategyProviderId: parseInt(String(userId), 10),
        trigger: `order_payout_${profitLossType}`,
        orderIdStr: String(orderIdStr),
        netProfit: np,
        balanceAfter: txResult.balance_after,
        eligibilityResult
      });
    } catch (eligibilityError) {
      logger.error('Failed to update catalog eligibility after order payout', {
        strategyProviderId: parseInt(String(userId), 10),
        trigger: `order_payout_${profitLossType}`,
        orderIdStr: String(orderIdStr),
        error: eligibilityError.message
      });
      // Don't fail the payout if eligibility update fails
    }
  }

  return txResult;
}

module.exports = { applyOrderClosePayout };
