const logger = require('./logger.service');
const { redisCluster } = require('../../config/redis');
const idGenerator = require('./idGenerator.service');
const { resolveOpenOrder, getOrderModel } = require('./order.resolver.service');
const copyTradingService = require('./copyTrading.service');
const { acquireUserLock, releaseUserLock } = require('./userLock.service');
const orderLifecycleService = require('./orderLifecycle.service');
const groupsCache = require('./groups.cache.service');
const { pythonServiceAxios } = require('./python.service');

class CloseAllOrdersService {
  constructor() {
    this.maxBatchSize = 20;
    this.resultTemplate = () => ({
      totalOrders: 0,
      closeRequestsSent: 0,
      closeSuccess: 0,
      closeFailed: 0,
      errors: [],
      skipped: [],
      lockAcquired: false
    });
  }

  normalizeStr(v) {
    return (v ?? '').toString();
  }

  _isMarketOpenByType(typeVal) {
    try {
      const t = parseInt(typeVal, 10);
      if (!Number.isNaN(t) && t === 4) {
        return true; // Crypto always open
      }

      const now = new Date();
      const day = now.getUTCDay(); // 0=Sunday
      if (day === 0 || day === 6) return false;
      const hour = now.getUTCHours();
      return hour >= 0 && hour < 22;
    } catch (error) {
      logger.warn('CloseAll: market hours check failed', { error: error.message, typeVal });
      return true;
    }
  }

  async ensureMarketOpen(ctx) {
    try {
      const symbolForHours = ctx.symbol;
      const groupName = this.normalizeStr(ctx?.canonical?.group || 'Classic');
      const gf = await groupsCache.getGroupFields(groupName, symbolForHours, ['type']);
      const gType = gf && gf.type != null ? gf.type : null;
      if (!this._isMarketOpenByType(gType)) {
        const err = new Error('market_closed');
        err.code = 'MARKET_CLOSED';
        throw err;
      }
    } catch (error) {
      if (error.code === 'MARKET_CLOSED') throw error;
      logger.warn('CloseAll: groups cache lookup failed, proceeding', { error: error.message });
    }
  }

  buildCancelFlags(canonical, row) {
    const hasTP = canonical
      ? (canonical.take_profit != null && Number(canonical.take_profit) > 0)
      : (row ? (row.take_profit != null && Number(row.take_profit) > 0) : false);

    const hasSL = canonical
      ? (canonical.stop_loss != null && Number(canonical.stop_loss) > 0)
      : (row ? (row.stop_loss != null && Number(row.stop_loss) > 0) : false);

    return { hasTP, hasSL };
  }

  async persistLifecycleIds({ ctx, orderId, closeId, takeprofitCancelId, stoplossCancelId, incomingStatus }) {
    try {
      const idUpdates = { close_id: closeId, status: incomingStatus };
      if (takeprofitCancelId) idUpdates.takeprofit_cancel_id = takeprofitCancelId;
      if (stoplossCancelId) idUpdates.stoploss_cancel_id = stoplossCancelId;

      if (ctx.row) {
        await ctx.row.update(idUpdates);
      } else {
        try {
          const OrderModel = getOrderModel(ctx?.canonical?.user_type || ctx?.row?.user_type);
          if (OrderModel) {
            const rowRecord = await OrderModel.findOne({ where: { order_id: orderId } });
            if (rowRecord) {
              await rowRecord.update(idUpdates);
            }
          }
        } catch (dbErr) {
          logger.warn('CloseAll: failed to update SQL row with lifecycle ids', { orderId, error: dbErr.message });
        }
      }

      await orderLifecycleService.addLifecycleId(orderId, 'close_id', closeId, 'Close all initiated');

      if (takeprofitCancelId) {
        await orderLifecycleService.addLifecycleId(orderId, 'takeprofit_cancel_id', takeprofitCancelId, 'Close all TP cancel');
      }
      if (stoplossCancelId) {
        await orderLifecycleService.addLifecycleId(orderId, 'stoploss_cancel_id', stoplossCancelId, 'Close all SL cancel');
      }
    } catch (error) {
      logger.warn('CloseAll: persist lifecycle ids failed', { orderId, error: error.message });
    }
  }

  async setCloseContext(orderId, userType, userId) {
    try {
      const contextKey = `close_context:${orderId}`;
      const contextValue = {
        context: 'USER_CLOSED',
        initiator: `close_all:${userType}:${userId}`,
        timestamp: Math.floor(Date.now() / 1000).toString()
      };
      await redisCluster.hset(contextKey, contextValue);
      await redisCluster.expire(contextKey, 300);
    } catch (error) {
      logger.warn('CloseAll: failed to set close context', { orderId, error: error.message });
    }
  }

  async fetchOpenOrders(userType, userId) {
    const tag = `${userType}:${userId}`;
    const indexKey = `user_orders_index:{${tag}}`;

    let ids = [];
    try {
      ids = await redisCluster.smembers(indexKey);
    } catch (error) {
      logger.warn('CloseAll: failed to read user_orders_index', { userType, userId, error: error.message });
      return [];
    }

    if (!ids || !ids.length) return [];

    const pipeline = redisCluster.pipeline();
    const orderKeys = ids.map((oid) => {
      const key = `user_holdings:{${tag}}:${oid}`;
      pipeline.hgetall(key);
      return key;
    });

    let responses = [];
    try {
      responses = await pipeline.exec();
    } catch (error) {
      logger.warn('CloseAll: pipeline read failed', { userType, userId, error: error.message });
      return [];
    }

    const openOrders = [];
    responses.forEach(([err, data], idx) => {
      if (err) return;
      if (!data || String(data.order_status || '').toUpperCase() !== 'OPEN') return;
      data.order_id = data.order_id || ids[idx];
      data.order_key = orderKeys[idx];
      openOrders.push(data);
    });

    return openOrders;
  }

  async closeSingleOrder(ctx) {
    const { order, userId, userType } = ctx;
    const orderId = order.order_id;
    let resolved;

    try {
      resolved = await resolveOpenOrder({
        order_id: orderId,
        user_id: userId,
        user_type: userType,
        symbolReq: order.symbol,
        orderTypeReq: order.order_type
      });

      await this.ensureMarketOpen(resolved);

      const { canonical, row } = resolved;
      let symbol = resolved.symbol;
      let order_type = resolved.order_type;

      if (!symbol) symbol = this.normalizeStr(order.symbol).toUpperCase();
      if (!order_type) order_type = this.normalizeStr(order.order_type).toUpperCase();

      const { hasTP, hasSL } = this.buildCancelFlags(canonical, row);

      const closeId = await idGenerator.generateCloseOrderId();
      const takeprofitCancelId = hasTP ? await idGenerator.generateTakeProfitCancelId() : undefined;
      const stoplossCancelId = hasSL ? await idGenerator.generateStopLossCancelId() : undefined;

      await this.persistLifecycleIds({
        ctx: resolved,
        orderId,
        closeId,
        takeprofitCancelId,
        stoplossCancelId,
        incomingStatus: 'CLOSED'
      });

      await this.setCloseContext(orderId, userType, userId);

      const payload = {
        symbol,
        order_type,
        user_id: userId,
        user_type: userType,
        order_id: orderId,
        status: 'CLOSED',
        order_status: 'CLOSED',
        close_id: closeId
      };

      if (resolved.order_quantity) payload.order_quantity = resolved.order_quantity;
      if (resolved.entry_price) payload.entry_price = resolved.entry_price;
      if (takeprofitCancelId) payload.takeprofit_cancel_id = takeprofitCancelId;
      if (stoplossCancelId) payload.stoploss_cancel_id = stoplossCancelId;

      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const resp = await pythonServiceAxios.post(`${baseUrl}/api/orders/close`, payload, { timeout: 20000 });
      const result = resp.data?.data || resp.data || {};

      return { ok: true, result };
    } catch (error) {
      logger.error('CloseAll: closeSingleOrder error', { orderId, error: error.message });
      return { ok: false, reason: error.message || 'close_failed' };
    }
  }

  async closeAll({ userType, userId, includeCopyFollowers = false }) {
    const summary = this.resultTemplate();
    const userLock = await acquireUserLock(userType, userId);

    if (!userLock) {
      summary.errors.push({ reason: 'user_lock_blocked' });
      return summary;
    }

    summary.lockAcquired = true;

    try {
      const openOrders = await this.fetchOpenOrders(userType, userId);
      summary.totalOrders = openOrders.length;

      if (openOrders.length === 0) {
        summary.skipped.push({ reason: 'no_open_orders' });
        return summary;
      }

      for (const order of openOrders) {
        const closeResult = await this.closeSingleOrder({ order, userId, userType });
        summary.closeRequestsSent += 1;

        if (!closeResult.ok) {
          summary.closeFailed += 1;
          summary.errors.push({ orderId: order.order_id, reason: closeResult.reason });
          continue;
        }

        summary.closeSuccess += 1;

        if (includeCopyFollowers && userType === 'strategy_provider') {
          try {
            await copyTradingService.processStrategyProviderOrderUpdate({
              order_id: order.order_id,
              order_user_id: userId,
              order_status: 'CLOSED'
            });
          } catch (error) {
            summary.errors.push({
              orderId: order.order_id,
              reason: `copy_followers_failed:${error.message}`
            });
          }
        }
      }

      return summary;
    } finally {
      await releaseUserLock(userLock);
    }
  }
}

module.exports = new CloseAllOrdersService();
