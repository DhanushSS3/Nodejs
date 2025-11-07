const amqp = require('amqplib');
const logger = require('../logger.service');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const StrategyProviderOrder = require('../../models/strategyProviderOrder.model');
const CopyFollowerOrder = require('../../models/copyFollowerOrder.model');
const LiveUser = require('../../models/liveUser.model');
const DemoUser = require('../../models/demoUser.model');
const StrategyProviderAccount = require('../../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../../models/copyFollowerAccount.model');
const OrderRejection = require('../../models/orderRejection.model');
const OrderLifecycleId = require('../../models/orderLifecycleId.model');
const { updateUserUsedMargin } = require('../user.margin.service');
// Redis cluster (used to fetch canonical order data if SQL row missing)
const { redisCluster } = require('../../../config/redis');
// Event bus for portfolio updates
const portfolioEvents = require('../events/portfolio.events');
// Wallet payout service
const { applyOrderClosePayout } = require('../order.payout.service');
// Copy trading service for strategy provider order distribution
const copyTradingService = require('../copyTrading.service');
// Performance fee service for copy followers
const { calculateAndApplyPerformanceFee } = require('../performanceFee.service');
// Strategy provider statistics service
const StrategyProviderStatsService = require('../strategyProviderStats.service');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1/';
const ORDER_DB_UPDATE_QUEUE = process.env.ORDER_DB_UPDATE_QUEUE || 'order_db_update_queue';

function getOrderModel(userType) {
  switch (userType) {
    case 'live':
      return LiveUserOrder;
    case 'demo':
      return DemoUserOrder;
    case 'strategy_provider':
      return StrategyProviderOrder;
    case 'copy_follower':
      return CopyFollowerOrder;
    default:
      return LiveUserOrder; // Default fallback
  }
}

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

function normalizeOrderType(t) {
  const s = String(t || '').toUpperCase().trim();
  if (s === 'B') return 'BUY';
  if (s === 'S') return 'SELL';
  if (s === 'BUY_LIMIT' || s === 'BUY_STOP' || s === 'B_LIMIT' || s === 'B_STOP') return 'BUY';
  if (s === 'SELL_LIMIT' || s === 'SELL_STOP' || s === 'S_LIMIT' || s === 'S_STOP') return 'SELL';
  return s;
}

async function handleOrderRejectionRecord(msg) {
  const {
    canonical_order_id,
    provider_order_id,
    user_id,
    user_type,
    symbol,
    rejection_type,
    redis_status,
    provider_ord_status,
    reason,
    provider_exec_id,
    provider_raw_data,
    order_type,
    order_price,
    order_quantity,
    margin_released
  } = msg || {};

  if (!canonical_order_id || !user_id || !user_type || !rejection_type) {
    throw new Error('Missing required fields in rejection record message');
  }

  logger.info('DB consumer creating rejection record', {
    canonical_order_id: String(canonical_order_id),
    user_id: String(user_id),
    user_type: String(user_type),
    rejection_type,
    redis_status,
    symbol
  });

  try {
    // Create rejection record
    await OrderRejection.create({
      canonical_order_id: String(canonical_order_id),
      provider_order_id: provider_order_id ? String(provider_order_id) : null,
      user_id: parseInt(String(user_id), 10),
      user_type: String(user_type),
      symbol: symbol ? String(symbol).toUpperCase() : '',
      rejection_type: String(rejection_type),
      redis_status: redis_status ? String(redis_status) : '',
      provider_ord_status: provider_ord_status ? String(provider_ord_status) : null,
      reason: reason ? String(reason) : null,
      provider_exec_id: provider_exec_id ? String(provider_exec_id) : null,
      provider_raw_data: provider_raw_data || null,
      order_type: order_type ? String(order_type) : null,
      order_price: order_price != null && Number.isFinite(Number(order_price)) ? Number(order_price) : null,
      order_quantity: order_quantity != null && Number.isFinite(Number(order_quantity)) ? Number(order_quantity) : null,
      margin_released: margin_released != null && Number.isFinite(Number(margin_released)) ? Number(margin_released) : null
    });

    logger.info('Created order rejection record', {
      canonical_order_id: String(canonical_order_id),
      rejection_type,
      user_id: String(user_id),
      user_type: String(user_type)
    });

    // Emit websocket event for rejection notification
    try {
      portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
        type: 'order_rejection_created',
        canonical_order_id: String(canonical_order_id),
        rejection_type: String(rejection_type),
        reason: reason ? String(reason) : null,
        symbol: symbol ? String(symbol).toUpperCase() : null
      });
    } catch (e) {
      logger.warn('Failed to emit rejection notification event', { error: e.message });
    }

  } catch (error) {
    logger.error('Failed to create order rejection record', {
      error: error.message,
      canonical_order_id: String(canonical_order_id),
      rejection_type
    });
    throw error;
  }
}

async function handleCloseIdUpdate(msg) {
  const { order_id, user_id, user_type, close_id } = msg || {};
  
  if (!order_id || !user_id || !user_type || !close_id) {
    throw new Error('Missing required fields in close_id update message');
  }

  const OrderModel = getOrderModel(String(user_type));
  
  logger.info('Processing close_id update', {
    order_id: String(order_id),
    user_id: String(user_id),
    user_type: String(user_type),
    close_id: String(close_id)
  });

  try {
    // Update main order table with close_id
    const [updatedRows] = await OrderModel.update(
      { close_id: String(close_id).trim() },
      { where: { order_id: String(order_id) } }
    );

    if (updatedRows === 0) {
      logger.warn('No order found to update with close_id', {
        order_id: String(order_id),
        close_id: String(close_id)
      });
    } else {
      logger.info('Order updated with close_id', {
        order_id: String(order_id),
        close_id: String(close_id),
        updated_rows: updatedRows
      });
    }

    // Create lifecycle record for complete audit trail
    const [lifecycleRecord, created] = await OrderLifecycleId.findOrCreate({
      where: {
        order_id: String(order_id),
        id_type: 'close_id',
        lifecycle_id: String(close_id)
      },
      defaults: {
        status: 'active',
        notes: 'Autocutoff close ID - saved before provider send'
      }
    });

    if (created) {
      logger.info('OrderLifecycleId record created', {
        order_id: String(order_id),
        close_id: String(close_id),
        lifecycle_record_id: lifecycleRecord.id
      });
    } else {
      logger.info('OrderLifecycleId record already exists', {
        order_id: String(order_id),
        close_id: String(close_id),
        existing_record_id: lifecycleRecord.id
      });
    }

  } catch (error) {
    logger.error('Failed to save close_id to database', {
      error: error.message,
      order_id: String(order_id),
      user_id: String(user_id),
      user_type: String(user_type),
      close_id: String(close_id)
    });
    throw error;
  }
}

async function applyDbUpdate(msg) {
  const {
    type,
    order_id,
    user_id,
    user_type,
    order_type,
    order_status,
    order_price,
    order_quantity,
    margin,
    contract_value,
    commission,
    commission_entry: commission_entry_msg,
    commission_exit: commission_exit_msg,
    used_margin_usd,
    // Close-specific new fields
    close_price,
    net_profit,
    swap,
    used_margin_executed,
    used_margin_all,
    close_message,
    // For mapping close_message based on which lifecycle id triggered close
    trigger_lifecycle_id,
    // Trigger fields
    stop_loss,
    take_profit,
  } = msg || {};
  if (!order_id || !user_id || !user_type) {
    throw new Error('Missing required fields in DB update message');
  }

  const OrderModel = getOrderModel(String(user_type));
  logger.info('DB consumer received message', {
    type,
    order_id: String(order_id),
    user_id: String(user_id),
    user_type: String(user_type),
    order_status,
    order_price,
    order_quantity,
    margin,
    commission,
    used_margin_usd,
    close_price,
    net_profit,
    swap,
    used_margin_executed,
    used_margin_all,
    trigger_lifecycle_id,
    stop_loss,
    take_profit,
  });

  // Attempt to find existing row first
  let row = await OrderModel.findOne({ where: { order_id: String(order_id) } });
  if (!row) {
    // If missing, fetch minimal required fields from Redis canonical order_data:{order_id}
    try {
      const key = `order_data:${String(order_id)}`;
      const canonical = await redisCluster.hgetall(key);
      if (!canonical || Object.keys(canonical).length === 0) {
        logger.warn('Canonical order not found in Redis for DB backfill', { order_id });
      } else {
        const symbol = canonical.symbol || canonical.order_company_name; // normalized by services
        const order_type = canonical.order_type;
        const order_quantity = canonical.order_quantity ?? '0';
        const price = order_price != null ? String(order_price) : (canonical.order_price ?? '0');
        const status = String(order_status || canonical.order_status || 'OPEN');
        // Round to 8 decimals to match DECIMAL(18,8)
        const marginStr = margin != null && Number.isFinite(Number(margin))
          ? Number(margin).toFixed(8)
          : (canonical.margin ?? null);
        const contractValueStr = contract_value != null && Number.isFinite(Number(contract_value))
          ? Number(contract_value).toFixed(8)
          : (canonical.contract_value ?? null);
        const commissionStr = commission != null && Number.isFinite(Number(commission))
          ? Number(commission).toFixed(8)
          : (canonical.commission ?? canonical.commission_entry ?? null);

        if (!symbol || !order_type) {
          logger.warn('Missing required fields in canonical order for SQL create', { order_id, symbol, order_type });
        } else {
          row = await OrderModel.create({
            order_id: String(order_id),
            order_user_id: parseInt(String(user_id), 10),
            symbol: String(symbol).toUpperCase(),
            order_type: String(order_type).toUpperCase(),
            order_status: status,
            order_price: String(price),
            order_quantity: String(order_quantity),
            contract_value: contractValueStr != null ? String(contractValueStr) : null,
            margin: marginStr != null ? String(marginStr) : null,
            commission: commissionStr != null ? String(commissionStr) : null,
            placed_by: 'user'
          });
          logger.info('Created SQL order row from Redis canonical for DB update', { order_id });
        }
      }
    } catch (e) {
      logger.error('Failed to backfill SQL order from Redis canonical', { order_id, error: e.message });
    }
  }

  // Wallet payout and transaction records (idempotent per order)
  try {
    if (type === 'ORDER_CLOSE_CONFIRMED') {
      const payoutKey = `close_payout_applied:${String(order_id)}`;
      const nx = await redisCluster.set(payoutKey, '1', 'EX', 7 * 24 * 3600, 'NX');
      if (nx) {
        const OrderModelP = getOrderModel(String(user_type));
        let rowP = row;
        if (!rowP) {
          try { rowP = await OrderModelP.findOne({ where: { order_id: String(order_id) } }); } catch (_) {}
        }
        const orderPk = rowP?.id ?? null;
        const symbolP = rowP?.symbol ?? undefined;
        const orderTypeP = rowP?.order_type ?? undefined;

        // For copy followers, calculate performance fee before applying payout
        let adjustedNetProfit = Number(net_profit) || 0;
        let performanceFeeResult = null;
        
        if (String(user_type) === 'copy_follower' && adjustedNetProfit > 0) {
          try {
            // Get copy follower order to find strategy provider
            const CopyFollowerOrder = require('../../models/copyFollowerOrder.model');
            const copyFollowerOrder = await CopyFollowerOrder.findOne({
              where: { order_id: String(order_id) }
            });
            
            if (copyFollowerOrder && copyFollowerOrder.strategy_provider_id) {
              performanceFeeResult = await calculateAndApplyPerformanceFee({
                copyFollowerOrderId: String(order_id),
                copyFollowerUserId: parseInt(String(user_id), 10),
                strategyProviderId: copyFollowerOrder.strategy_provider_id,
                orderNetProfit: adjustedNetProfit,
                symbol: symbolP ? String(symbolP).toUpperCase() : undefined,
                orderType: orderTypeP ? String(orderTypeP).toUpperCase() : undefined
              });
              
              // Use adjusted net profit after performance fee deduction
              if (performanceFeeResult.performanceFeeCharged) {
                adjustedNetProfit = performanceFeeResult.adjustedNetProfit;
                logger.info('Performance fee applied for copy follower order', {
                  order_id: String(order_id),
                  originalNetProfit: Number(net_profit) || 0,
                  adjustedNetProfit,
                  performanceFeeAmount: performanceFeeResult.performanceFeeAmount
                });
              }
            }
          } catch (performanceFeeError) {
            logger.error('Failed to apply performance fee for copy follower', {
              order_id: String(order_id),
              user_id: String(user_id),
              error: performanceFeeError.message
            });
            // Continue with original net profit if performance fee calculation fails
          }
        }

        // Apply payout for all user types (live, demo, strategy_provider, copy_follower)
        // For copy followers, use adjusted net profit after performance fee
        await applyOrderClosePayout({
          userType: String(user_type),
          userId: parseInt(String(user_id), 10),
          orderPk,
          orderIdStr: String(order_id),
          netProfit: adjustedNetProfit,
          commission: Number(commission) || 0,
          profitUsd: Number(msg.profit_usd) || 0,
          swap: Number(swap) || 0,
          symbol: symbolP ? String(symbolP).toUpperCase() : undefined,
          orderType: orderTypeP ? String(orderTypeP).toUpperCase() : undefined,
        });

        // Trigger a WS snapshot refresh for wallet balance
        try {
          portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
            type: 'wallet_balance_update',
            order_id: String(order_id),
          });
          
          // If performance fee was applied, also emit update for strategy provider
          if (performanceFeeResult && performanceFeeResult.performanceFeeCharged) {
            portfolioEvents.emitUserUpdate('strategy_provider', String(performanceFeeResult.strategyProviderId), {
              type: 'wallet_balance_update',
              reason: 'performance_fee_earned',
              order_id: String(order_id),
            });
          }
        } catch (e) {
          logger.warn('Failed to emit WS after payout', { error: e.message, order_id: String(order_id) });
        }
      } else {
        logger.info('Skip payout; already applied for order', { order_id: String(order_id) });
      }
    }
  } catch (e) {
    logger.error('Failed to apply payout on close', { error: e.message, order_id: String(order_id) });
  }

  // Increment user's aggregate net_profit for close confirmations (idempotent per order_id)
  try {
    if (type === 'ORDER_CLOSE_CONFIRMED' && net_profit != null && Number.isFinite(Number(net_profit))) {
      const key = `close_np_applied:${String(order_id)}`;
      // NX ensure we only apply once; expire after 7 days as a safety window
      const setRes = await redisCluster.set(key, '1', 'EX', 7 * 24 * 3600, 'NX');
      if (setRes) {
        const np = Number(net_profit);
        const UserModel = getUserModel(String(user_type));
        await UserModel.increment({ net_profit: np }, { where: { id: parseInt(String(user_id), 10) } });
        logger.info('Applied user net_profit increment from close', { user_id: String(user_id), user_type: String(user_type), order_id: String(order_id), net_profit: np });
      } else {
        logger.info('Skip user net_profit increment; already applied for order', { order_id: String(order_id) });
      }
    }
  } catch (e) {
    logger.error('Failed to increment user net_profit from DB consumer', { error: e.message, order_id: String(order_id) });
  }

  // If still no row, nothing else we can do; avoid throwing to prevent poison messages
  if (!row) {
    logger.warn('Skipping DB order update; SQL row not found and could not be created', { order_id });
  } else {
    const updateFields = {};
    if (order_status) updateFields.order_status = String(order_status);
    // Default for pending-cancel confirmations if publisher forgot to set order_status
    if (!order_status && String(type) === 'ORDER_PENDING_CANCEL') {
      updateFields.order_status = 'CANCELLED';
    }
    // Default for order rejection confirmations if publisher forgot to set order_status
    if (!order_status && String(type) === 'ORDER_REJECTED') {
      updateFields.order_status = 'REJECTED';
    }
    if (order_type) updateFields.order_type = normalizeOrderType(order_type);
    if (order_price != null) updateFields.order_price = String(order_price);
    if (order_quantity != null) updateFields.order_quantity = String(order_quantity);
    if (margin != null && Number.isFinite(Number(margin))) {
      updateFields.margin = Number(margin).toFixed(8);
    }
    if (contract_value != null && Number.isFinite(Number(contract_value))) {
      updateFields.contract_value = Number(contract_value).toFixed(8);
    }
    if (commission != null && Number.isFinite(Number(commission))) {
      updateFields.commission = Number(commission).toFixed(8);
    }
    // Trigger fields
    if (stop_loss != null && Number.isFinite(Number(stop_loss))) {
      updateFields.stop_loss = Number(stop_loss).toFixed(8);
    }
    if (take_profit != null && Number.isFinite(Number(take_profit))) {
      updateFields.take_profit = Number(take_profit).toFixed(8);
    }
    // Cancel trigger messages: explicitly nullify columns
    if (type === 'ORDER_STOPLOSS_CANCEL') {
      updateFields.stop_loss = null;
    }
    if (type === 'ORDER_TAKEPROFIT_CANCEL') {
      updateFields.take_profit = null;
    }
    // Close-specific fields
    if (close_price != null && Number.isFinite(Number(close_price))) {
      updateFields.close_price = Number(close_price).toFixed(8);
    }
    if (net_profit != null && Number.isFinite(Number(net_profit))) {
      updateFields.net_profit = Number(net_profit).toFixed(8);
    }
    if (swap != null && Number.isFinite(Number(swap))) {
      updateFields.swap = Number(swap).toFixed(8);
    }

    // Enhanced close message mapping based on close scenario
    if (type === 'ORDER_CLOSE_CONFIRMED') {
      try {
        let closeMsg = null;
        
        // Priority 1: Use explicit close_message if provided in payload
        if (close_message && String(close_message).trim()) {
          closeMsg = String(close_message).trim();
        }
        // Priority 2: Determine from trigger_lifecycle_id
        else if (trigger_lifecycle_id) {
          let slId = row.stoploss_id || null;
          let tpId = row.takeprofit_id || null;
          let clsId = row.close_id || null;
          
          // Fallback to Redis canonical if SQL row lacks these ids
          if (!slId || !tpId || !clsId) {
            try {
              const canonical = await redisCluster.hgetall(`order_data:${String(order_id)}`);
              if (canonical) {
                if (!slId && canonical.stoploss_id) slId = String(canonical.stoploss_id);
                if (!tpId && canonical.takeprofit_id) tpId = String(canonical.takeprofit_id);
                if (!clsId && canonical.close_id) clsId = String(canonical.close_id);
              }
            } catch (e) {
              // best effort only
            }
          }
          
          const trig = String(trigger_lifecycle_id);
          console.log("trigger_lifecycle_id:", trig, "slId:", slId, "tpId:", tpId, "clsId:", clsId);
          if (slId && trig === String(slId)) {
            closeMsg = 'Stoploss';
          } else if (tpId && trig === String(tpId)) {
            closeMsg = 'Takeprofit';
          } else if (clsId && trig === String(clsId)) {
            closeMsg = 'Closed';
          } else if (trig.includes('trigger_stoploss_')) {
            // Handle synthetic stoploss trigger IDs
            closeMsg = 'Stoploss';
          } else if (trig.includes('trigger_takeprofit_')) {
            // Handle synthetic takeprofit trigger IDs
            closeMsg = 'Takeprofit';
          } else {
            // Check if trigger ID indicates autocutoff
            if (trig.includes('autocutoff') || trig.includes('liquidation') || trig.includes('margin_call')) {
              closeMsg = 'Autocutoff';
            } else {
              closeMsg = 'Closed'; // Default for unknown triggers
            }
          }
        }
        // Priority 3: Default fallback
        else {
          closeMsg = 'Closed';
        }
        
        if (closeMsg) {
          updateFields.close_message = closeMsg;
          logger.info('Set close_message for order', { 
            order_id: String(order_id), 
            close_message: closeMsg, 
            trigger_lifecycle_id: trigger_lifecycle_id || 'none',
            detection_method: close_message ? 'explicit' : (trigger_lifecycle_id ? 'trigger_id' : 'default')
          });
        }
      } catch (e) {
        logger.warn('Failed to set close_message', { error: e.message, order_id: String(order_id) });
        // Set default close_message on error
        updateFields.close_message = 'Closed';
      }
    }

    // Fallback: if status transitions to OPEN and no explicit order_type provided, convert existing pending type to BUY/SELL
    try {
      const willBeOpen = Object.prototype.hasOwnProperty.call(updateFields, 'order_status') && String(updateFields.order_status).toUpperCase() === 'OPEN';
      const lacksType = !Object.prototype.hasOwnProperty.call(updateFields, 'order_type');
      if (willBeOpen && lacksType && row && row.order_type) {
        const cur = String(row.order_type).toUpperCase();
        const norm = normalizeOrderType(cur);
        if (norm !== cur) {
          updateFields.order_type = norm;
        }
      }
    } catch (_) {}

    if (Object.keys(updateFields).length > 0) {
      const before = {
        margin: row.margin != null ? row.margin.toString() : null,
        commission: row.commission != null ? row.commission.toString() : null,
        order_price: row.order_price != null ? row.order_price.toString() : null,
        order_status: row.order_status,
        stop_loss: row.stop_loss != null ? row.stop_loss.toString() : null,
        take_profit: row.take_profit != null ? row.take_profit.toString() : null,
      };
      await row.update(updateFields);
      const after = {
        margin: row.margin != null ? row.margin.toString() : null,
        commission: row.commission != null ? row.commission.toString() : null,
        order_price: row.order_price != null ? row.order_price.toString() : null,
        order_status: row.order_status,
        close_price: row.close_price != null ? row.close_price.toString() : null,
        net_profit: row.net_profit != null ? row.net_profit.toString() : null,
        swap: row.swap != null ? row.swap.toString() : null,
        stop_loss: row.stop_loss != null ? row.stop_loss.toString() : null,
        take_profit: row.take_profit != null ? row.take_profit.toString() : null,
      };
      logger.info('DB consumer applied order update', { order_id: String(order_id), before, updateFields, after });
      // Mirror updates into Redis except for pending cancel finalization (keys were deleted by worker)
      if (String(type) !== 'ORDER_PENDING_CANCEL') {
        try {
          const userTypeStr = String(user_type);
          const userIdStr = String(user_id);
          const hashTag = `${userTypeStr}:${userIdStr}`;
          const orderKey = `user_holdings:{${hashTag}}:${String(order_id)}`;
          const orderDataKey = `order_data:${String(order_id)}`;
          const indexKey = `user_orders_index:{${hashTag}}`;
          const symbolUpper = row?.symbol ? String(row.symbol).toUpperCase() : undefined;
          // 1) User-slot pipeline: user_holdings + user_orders_index share the same hash tag slot
          const pUser = redisCluster.pipeline();
          // Maintain index membership based on order_status when provided
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_status')) {
            const st = String(updateFields.order_status).toUpperCase();
            if (st === 'REJECTED' || st === 'CLOSED' || st === 'CANCELLED' || st === 'QUEUED') {
              pUser.srem(indexKey, String(order_id));
            } else if (st === 'OPEN' || st === 'PENDING') {
              // Ensure presence in index for OPEN and PENDING
              pUser.sadd(indexKey, String(order_id));
            }
            // Mirror order_status into user_holdings for immediate WS/UI visibility
            pUser.hset(orderKey, 'order_status', st);
          } else {
            // Default behavior (for trigger updates not changing status): ensure presence
            pUser.sadd(indexKey, String(order_id));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'stop_loss')) {
            if (updateFields.stop_loss === null) {
              pUser.hdel(orderKey, 'stop_loss');
            } else {
              pUser.hset(orderKey, 'stop_loss', String(updateFields.stop_loss));
            }
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'take_profit')) {
            if (updateFields.take_profit === null) {
              pUser.hdel(orderKey, 'take_profit');
            } else {
              pUser.hset(orderKey, 'take_profit', String(updateFields.take_profit));
            }
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_type')) {
            pUser.hset(orderKey, 'order_type', String(updateFields.order_type).toUpperCase());
          }
          // Mirror common numeric fields used by UI
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_price')) {
            pUser.hset(orderKey, 'order_price', String(updateFields.order_price));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_quantity')) {
            pUser.hset(orderKey, 'order_quantity', String(updateFields.order_quantity));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'contract_value')) {
            pUser.hset(orderKey, 'contract_value', String(updateFields.contract_value));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'commission')) {
            pUser.hset(orderKey, 'commission', String(updateFields.commission));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'net_profit')) {
            pUser.hset(orderKey, 'net_profit', String(updateFields.net_profit));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'close_price')) {
            pUser.hset(orderKey, 'close_price', String(updateFields.close_price));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'swap')) {
            pUser.hset(orderKey, 'swap', String(updateFields.swap));
          }
          await pUser.exec();

          // 2) order_data pipeline (separate slot)
          const pOd = redisCluster.pipeline();
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_status')) {
            pOd.hset(orderDataKey, 'order_status', String(updateFields.order_status).toUpperCase());
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'stop_loss')) {
            if (updateFields.stop_loss === null) pOd.hdel(orderDataKey, 'stop_loss');
            else pOd.hset(orderDataKey, 'stop_loss', String(updateFields.stop_loss));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'take_profit')) {
            if (updateFields.take_profit === null) pOd.hdel(orderDataKey, 'take_profit');
            else pOd.hset(orderDataKey, 'take_profit', String(updateFields.take_profit));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_type')) {
            pOd.hset(orderDataKey, 'order_type', String(updateFields.order_type).toUpperCase());
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_price')) {
            pOd.hset(orderDataKey, 'order_price', String(updateFields.order_price));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'order_quantity')) {
            pOd.hset(orderDataKey, 'order_quantity', String(updateFields.order_quantity));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'contract_value')) {
            pOd.hset(orderDataKey, 'contract_value', String(updateFields.contract_value));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'commission')) {
            pOd.hset(orderDataKey, 'commission', String(updateFields.commission));
            // For OPEN confirmations, also persist entry commission breakdown into canonical
            if (String(type) === 'ORDER_OPEN_CONFIRMED') {
              pOd.hset(orderDataKey, 'commission_entry', String(updateFields.commission));
            }
          }
          if (commission_entry_msg != null) {
            pOd.hset(orderDataKey, 'commission_entry', String(commission_entry_msg));
          }
          if (commission_exit_msg != null) {
            pOd.hset(orderDataKey, 'commission_exit', String(commission_exit_msg));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'net_profit')) {
            pOd.hset(orderDataKey, 'net_profit', String(updateFields.net_profit));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'close_price')) {
            pOd.hset(orderDataKey, 'close_price', String(updateFields.close_price));
          }
          if (Object.prototype.hasOwnProperty.call(updateFields, 'swap')) {
            pOd.hset(orderDataKey, 'swap', String(updateFields.swap));
          }
          await pOd.exec();

          // 3) symbol_holders (separate slot): only add for OPEN orders
          if (symbolUpper && String(updateFields.order_status || row.order_status).toUpperCase() === 'OPEN') {
            try {
              const symKey = `symbol_holders:${symbolUpper}:${userTypeStr}`;
              await redisCluster.sadd(symKey, hashTag);
            } catch (e2) {
              logger.warn('symbol_holders sadd failed', { error: e2.message, symbol: symbolUpper, user: hashTag });
            }
          }
        } catch (e) {
          logger.warn('Failed to mirror trigger to Redis holdings', { error: e.message, order_id: String(order_id) });
        }
      } else {
        logger.info('Skip Redis mirror for ORDER_PENDING_CANCEL (keys were removed by worker)', { order_id: String(order_id) });
      }

      // Emit event for this user's portfolio stream
      try {
        // Hydrate WS update for PENDING confirmation with core fields if not present
        let updateForWs = { ...updateFields };
        if (String(type) === 'ORDER_PENDING_CONFIRMED') {
          if (!Object.prototype.hasOwnProperty.call(updateForWs, 'symbol') && row?.symbol) {
            updateForWs.symbol = String(row.symbol).toUpperCase();
          }
          if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_type') && row?.order_type) {
            updateForWs.order_type = String(row.order_type).toUpperCase();
          }
          if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_price') && row?.order_price != null) {
            updateForWs.order_price = String(row.order_price);
          }
          if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_quantity') && row?.order_quantity != null) {
            updateForWs.order_quantity = String(row.order_quantity);
          }
        }
        const wsPayload = {
          type: 'order_update',
          order_id: String(order_id),
          update: updateForWs,
        };
        if (String(type) === 'ORDER_PENDING_CONFIRMED') {
          wsPayload.reason = 'pending_confirmed';
        }
        if (String(type) === 'ORDER_PENDING_CANCEL') {
          wsPayload.reason = 'pending_cancelled';
        }
        portfolioEvents.emitUserUpdate(String(user_type), String(user_id), wsPayload);
        // Emit a dedicated event when an order is rejected to trigger immediate DB refresh on WS
        if (String(type) === 'ORDER_REJECTED') {
          portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
            type: 'order_rejected',
            order_id: String(order_id),
          });
        }
        // Emit immediate event for pending order triggers to refresh UI instantly
        if (String(type) === 'ORDER_PENDING_TRIGGERED') {
          portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
            type: 'order_update',
            order_id: String(order_id),
            reason: 'pending_triggered',
            update: updateForWs,
          });
        }
      } catch (e) {
        logger.warn('Failed to emit portfolio event after order update', { error: e.message });
      }
    }
  }

  // Handle post-close operations (margin updates, copy trading, etc.)
  await handlePostCloseOperations(msg, row);

  // NOTE: Copy trading replication is handled in the controller when the order is placed
  // Removing duplicate trigger that was causing double copy orders in provider flow
  // The replication should only happen once when the order is initially placed, not again on confirmation

  // Update user's used margin in SQL, if provided
  const mirrorUsedMargin = (used_margin_usd != null) ? used_margin_usd : (used_margin_executed != null ? used_margin_executed : null);
  if (mirrorUsedMargin != null) {
    try {
      logger.info('Updating user margin from DB consumer', {
        order_id: String(order_id),
        user_id: String(user_id),
        user_type: String(user_type),
        message_type: type,
        mirrorUsedMargin,
        used_margin_usd,
        used_margin_executed
      });
      await updateUserUsedMargin({ userType: String(user_type), userId: parseInt(String(user_id), 10), usedMargin: mirrorUsedMargin });
    } catch (e) {
      logger.error('Failed to persist used margin in SQL', { error: e.message, user_id, user_type });
      // Do not fail the message solely due to mirror write; treat as non-fatal
    }
    // Emit separate event for margin change
    try {
      portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
        type: 'user_margin_update',
        used_margin_usd: mirrorUsedMargin,
      });
    } catch (e) {
      logger.warn('Failed to emit portfolio event after user margin update', { error: e.message });
    }
  }
}

async function startOrdersDbConsumer() {
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    const ch = await conn.createChannel();
    await ch.assertQueue(ORDER_DB_UPDATE_QUEUE, { durable: true });
    await ch.prefetch(32);

    logger.info(`Orders DB consumer connected. Listening on ${ORDER_DB_UPDATE_QUEUE}`);

    ch.consume(ORDER_DB_UPDATE_QUEUE, async (msg) => {
      if (!msg) return;
      let payload = null;
      try {
        payload = JSON.parse(msg.content.toString('utf8'));
        
        // Route different message types
        if (payload.type === 'ORDER_REJECTION_RECORD') {
          await handleOrderRejectionRecord(payload);
        } else if (payload.type === 'ORDER_CLOSE_ID_UPDATE') {
          await handleCloseIdUpdate(payload);
        } else {
          await applyDbUpdate(payload);
        }
        
        ch.ack(msg);
      } catch (err) {
        logger.error('Orders DB consumer failed to handle message', { 
          error: err.message, 
          messageType: payload?.type || 'unknown',
          rawMessage: msg.content.toString('utf8').substring(0, 200) // First 200 chars for debugging
        });
        // Requeue to retry transient failures
        ch.nack(msg, false, true);
      }
    }, { noAck: false });

    // Handle connection errors
    conn.on('error', (e) => logger.error('AMQP connection error', { error: e.message }));
    conn.on('close', () => logger.warn('AMQP connection closed'));
  } catch (err) {
    logger.error('Failed to start Orders DB consumer', { error: err.message });
    // Let the process continue; a supervisor can retry or we can add a backoff/retry here
  }
}

/**
 * Handle post-close operations for all user types
 * Follows SOLID principles - Single Responsibility for post-close processing
 * @param {Object} payload - Order update payload
 * @param {Object} row - Updated order row
 */
async function handlePostCloseOperations(payload, row) {
  const { type, user_type, user_id, order_id, used_margin_executed, net_profit } = payload;
  
  // Only process for close confirmations
  if (type !== 'ORDER_CLOSE_CONFIRMED') {
    return;
  }

  try {
    // 1. Update user margin for all user types (existing logic)
    if (typeof used_margin_executed === 'number') {
      await updateUserUsedMargin({ 
        userType: user_type, 
        userId: parseInt(user_id, 10), 
        usedMargin: used_margin_executed 
      });
      
      // Emit portfolio events
      try {
        portfolioEvents.emitUserUpdate(user_type, user_id, { 
          type: 'user_margin_update', 
          used_margin_usd: used_margin_executed 
        });
        portfolioEvents.emitUserUpdate(user_type, user_id, { 
          type: 'order_update', 
          order_id, 
          update: { order_status: 'CLOSED' } 
        });
      } catch (eventErr) {
        logger.warn('Failed to emit portfolio events', { 
          order_id, 
          error: eventErr.message 
        });
      }
    }

    // 2. Update net profit for user account (existing logic)
    if (typeof net_profit === 'number' && Number.isFinite(net_profit)) {
      const UserModel = getUserModel(user_type);
      if (UserModel) {
        await UserModel.increment(
          { net_profit: net_profit }, 
          { where: { id: parseInt(user_id, 10) } }
        );
      }
    }

    // 3. Update comprehensive statistics for strategy providers
    if (user_type === 'strategy_provider') {
      await updateStrategyProviderStatistics(user_id, order_id);
    }

    // 4. Handle copy trading distribution for strategy providers (NEW)
    if (user_type === 'strategy_provider' && row) {
      await handleStrategyProviderCopyTrading(row);
    }

  } catch (error) {
    logger.error('Failed to handle post-close operations', {
      order_id,
      user_type,
      user_id,
      error: error.message
    });
  }
}

/**
 * Update comprehensive statistics for strategy provider account
 * @param {string} userId - Strategy provider user ID
 * @param {string} orderId - ID of the closed order
 */
async function updateStrategyProviderStatistics(userId, orderId) {
  try {
    // First, let's check the actual order to see what user_id it has
    const order = await StrategyProviderOrder.findOne({
      where: { order_id: orderId },
      attributes: ['id', 'order_id', 'order_user_id', 'order_status', 'net_profit']
    });

    logger.info('Looking for strategy provider account for statistics update', {
      userId,
      userIdType: typeof userId,
      parsedUserId: parseInt(userId, 10),
      orderId,
      orderDetails: order ? {
        id: order.id,
        order_id: order.order_id,
        order_user_id: order.order_user_id,
        order_status: order.order_status,
        net_profit: order.net_profit
      } : null
    });

    if (!order) {
      logger.warn('Strategy provider order not found for statistics update', {
        userId,
        orderId
      });
      return;
    }

    // The order_user_id is the strategy provider account ID, not the user ID
    // So we should find the strategy provider account by its ID (order_user_id)
    const strategyProvider = await StrategyProviderAccount.findByPk(order.order_user_id);

    if (!strategyProvider) {
      logger.warn('Strategy provider account not found for statistics update', {
        userId,
        orderId,
        orderUserId: order.order_user_id,
        message: 'Strategy provider account not found by order_user_id'
      });
      return;
    }

    logger.info('Found strategy provider account for statistics update', {
      userId,
      orderId,
      strategyProviderId: strategyProvider.id,
      strategyProviderUserId: strategyProvider.user_id,
      strategyName: strategyProvider.strategy_name
    });

    // Update comprehensive statistics using the dedicated service
    // This is done asynchronously to avoid blocking the DB consumer
    setImmediate(async () => {
      try {
        await StrategyProviderStatsService.updateStatisticsAfterOrderClose(
          strategyProvider.id,
          orderId
        );
        
        logger.info('Strategy provider statistics updated from DB consumer', {
          userId,
          strategyProviderId: strategyProvider.id,
          orderId
        });
      } catch (statsError) {
        logger.error('Failed to update strategy provider statistics from DB consumer', {
          userId,
          strategyProviderId: strategyProvider.id,
          orderId,
          error: statsError.message
        });
      }
    });

  } catch (error) {
    logger.error('Failed to initiate strategy provider statistics update', {
      userId,
      orderId,
      error: error.message
    });
  }
}

/**
 * Handle copy trading distribution for strategy provider order close
 * Follows Open/Closed principle - extensible without modifying existing code
 * @param {Object} masterOrder - Strategy provider order
 */
async function handleStrategyProviderCopyTrading(masterOrder) {
  try {
    logger.info('Processing strategy provider order close for copy trading', {
      orderId: masterOrder.order_id,
      orderStatus: masterOrder.order_status
    });

    // Use existing copy trading service to handle follower order distribution
    await copyTradingService.processStrategyProviderOrderUpdate(masterOrder);

    logger.info('Strategy provider copy trading distribution completed', {
      orderId: masterOrder.order_id
    });

  } catch (error) {
    logger.error('Failed to process strategy provider copy trading', {
      orderId: masterOrder.order_id,
      error: error.message
    });
  }
}

/**
 * Get user model based on user type
 * Follows Dependency Inversion - depends on abstraction
 * @param {string} userType - Type of user
 * @returns {Object} User model
 */
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
      return null;
  }
}

module.exports = { startOrdersDbConsumer };
