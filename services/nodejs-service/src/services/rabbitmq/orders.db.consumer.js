const amqp = require('amqplib');
const logger = require('../logger.service');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const LiveUser = require('../../models/liveUser.model');
const DemoUser = require('../../models/demoUser.model');
const { updateUserUsedMargin } = require('../user.margin.service');
// Redis cluster (used to fetch canonical order data if SQL row missing)
const { redisCluster } = require('../../../config/redis');
// Event bus for portfolio updates
const portfolioEvents = require('../events/portfolio.events');
// Wallet payout service
const { applyOrderClosePayout } = require('../order.payout.service');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1/';
const ORDER_DB_UPDATE_QUEUE = process.env.ORDER_DB_UPDATE_QUEUE || 'order_db_update_queue';

function getOrderModel(userType) {
  return userType === 'live' ? LiveUserOrder : DemoUserOrder;
}

async function applyDbUpdate(msg) {
  const {
    type,
    order_id,
    user_id,
    user_type,
    order_status,
    order_price,
    margin,
    commission,
    used_margin_usd,
    // Close-specific new fields
    close_price,
    net_profit,
    swap,
    used_margin_executed,
    used_margin_all,
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

        await applyOrderClosePayout({
          userType: String(user_type),
          userId: parseInt(String(user_id), 10),
          orderPk,
          orderIdStr: String(order_id),
          netProfit: Number(net_profit) || 0,
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
        const UserModel = String(user_type) === 'live' ? LiveUser : DemoUser;
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
    if (order_price != null) updateFields.order_price = String(order_price);
    if (margin != null && Number.isFinite(Number(margin))) {
      updateFields.margin = Number(margin).toFixed(8);
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

    // Close message mapping based on which lifecycle id triggered the close
    if (type === 'ORDER_CLOSE_CONFIRMED') {
      try {
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
        let closeMsg = null;
        if (trigger_lifecycle_id) {
          const trig = String(trigger_lifecycle_id);
          if (slId && trig === String(slId)) closeMsg = 'stoploss_triggered';
          else if (tpId && trig === String(tpId)) closeMsg = 'takeprofit_triggered';
          else if (clsId && trig === String(clsId)) closeMsg = 'close';
        }
        if (closeMsg) {
          updateFields.close_message = closeMsg;
        }
      } catch (e) {
        logger.warn('Failed to set close_message from trigger_lifecycle_id', { error: e.message, order_id: String(order_id) });
      }
    }

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
      // Mirror trigger updates into Redis so WS snapshots and services reflect changes
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
          if (st === 'REJECTED' || st === 'CLOSED' || st === 'CANCELLED') {
            pUser.srem(indexKey, String(order_id));
          } else if (st === 'OPEN') {
            pUser.sadd(indexKey, String(order_id));
          }
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
        await pUser.exec();

        // 2) order_data pipeline (separate slot)
        const pOd = redisCluster.pipeline();
        if (Object.prototype.hasOwnProperty.call(updateFields, 'stop_loss')) {
          if (updateFields.stop_loss === null) pOd.hdel(orderDataKey, 'stop_loss');
          else pOd.hset(orderDataKey, 'stop_loss', String(updateFields.stop_loss));
        }
        if (Object.prototype.hasOwnProperty.call(updateFields, 'take_profit')) {
          if (updateFields.take_profit === null) pOd.hdel(orderDataKey, 'take_profit');
          else pOd.hset(orderDataKey, 'take_profit', String(updateFields.take_profit));
        }
        await pOd.exec();

        // 3) symbol_holders (separate slot)
        if (symbolUpper) {
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

      // Emit event for this user's portfolio stream
      try {
        portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
          type: 'order_update',
          order_id: String(order_id),
          update: updateFields,
        });
        // Emit a dedicated event when an order is rejected to trigger immediate DB refresh on WS
        if (String(type) === 'ORDER_REJECTED') {
          portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
            type: 'order_rejected',
            order_id: String(order_id),
          });
        }
      } catch (e) {
        logger.warn('Failed to emit portfolio event after order update', { error: e.message });
      }
    }
  }

  // Update user's used margin in SQL, if provided
  const mirrorUsedMargin = (used_margin_usd != null) ? used_margin_usd : (used_margin_executed != null ? used_margin_executed : null);
  if (mirrorUsedMargin != null) {
    try {
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
      try {
        const payload = JSON.parse(msg.content.toString('utf8'));
        await applyDbUpdate(payload);
        ch.ack(msg);
      } catch (err) {
        logger.error('Orders DB consumer failed to handle message', { error: err.message });
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

module.exports = { startOrdersDbConsumer };
