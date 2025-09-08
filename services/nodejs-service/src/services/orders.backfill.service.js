const { redisCluster } = require('../../config/redis');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const logger = require('./logger.service');
const { Op } = require('sequelize');

class OrdersBackfillService {
  constructor(redis = redisCluster) {
    this.redis = redis;
  }

  getHashTag(userType, userId) {
    return `${userType}:${userId}`;
  }

  getOrderKey(userType, userId, orderId) {
    const tag = this.getHashTag(userType, userId);
    return `user_holdings:{${tag}}:${orderId}`;
  }

  getIndexKey(userType, userId) {
    const tag = this.getHashTag(userType, userId);
    return `user_orders_index:{${tag}}`;
  }

  getSymbolHoldersKey(symbol, userType) {
    return `symbol_holders:${String(symbol).toUpperCase()}:${userType}`;
  }

  async fetchOpenOrdersFromDb(userType, userId, includeQueued = false) {
    const Model = userType === 'live' ? LiveUserOrder : DemoUserOrder;
    const opts = includeQueued
      ? { where: { order_user_id: Number(userId), order_status: { [Op.in]: ['OPEN', 'QUEUED'] } } }
      : { where: { order_user_id: Number(userId), order_status: 'OPEN' } };

    const rows = await Model.findAll(opts);
    return rows.map(r => ({
      order_id: r.order_id,
      symbol: String(r.symbol).toUpperCase(),
      order_type: String(r.order_type).toUpperCase(),
      order_price: r.order_price?.toString?.() ?? String(r.order_price ?? ''),
      order_quantity: r.order_quantity?.toString?.() ?? String(r.order_quantity ?? ''),
      contract_value: r.contract_value?.toString?.() ?? undefined,
      margin: r.margin?.toString?.() ?? undefined,
      order_status: r.order_status,
      created_at: r.created_at?.toISOString?.() ?? undefined,
      updated_at: r.updated_at?.toISOString?.() ?? undefined,
    }));
  }

  async scanExistingUserHoldingOrderIds(userType, userId) {
    const tag = this.getHashTag(userType, userId);
    const pattern = `user_holdings:{${tag}}:*`;
    const masters = this.redis.nodes('master');
    const ids = new Set();
    for (const node of masters) {
      let cursor = '0';
      do {
        const res = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = res[0];
        for (const key of res[1] || []) {
          const parts = String(key).split(':');
          ids.add(parts[parts.length - 1]);
        }
      } while (cursor !== '0');
    }
    return ids;
  }

  buildHoldingMapping(userType, userId, order) {
    const mapping = {
      order_id: order.order_id,
      symbol: order.symbol,
      order_type: order.order_type,
      order_price: order.order_price ?? '',
      order_quantity: order.order_quantity ?? '',
      order_status: order.order_status || 'OPEN',
    };
    if (order.contract_value != null) mapping.contract_value = String(order.contract_value);
    if (order.margin != null) mapping.margin = String(order.margin);
    if (order.created_at) mapping.created_at = order.created_at;
    if (order.updated_at) mapping.updated_at = order.updated_at;
    return mapping;
  }

  async backfillUserHoldingsFromSql(userType, userId, { includeQueued = false } = {}) {
    const orders = await this.fetchOpenOrdersFromDb(userType, userId, includeQueued);
    const existing = await this.scanExistingUserHoldingOrderIds(userType, userId);

    const toCreate = orders.filter(o => !existing.has(o.order_id));

    // HSET holdings for missing orders
    const pipeline = this.redis.pipeline();
    for (const o of toCreate) {
      const key = this.getOrderKey(userType, userId, o.order_id);
      const mapping = this.buildHoldingMapping(userType, userId, o);
      pipeline.hset(key, mapping);
    }
    if (toCreate.length) await pipeline.exec();

    // Update index set and symbol holders
    const indexKey = this.getIndexKey(userType, userId);
    const orderIds = toCreate.map(o => o.order_id);
    if (orderIds.length) await this.redis.sadd(indexKey, ...orderIds);

    const symbols = Array.from(new Set(toCreate.map(o => o.symbol)));
    if (symbols.length) {
      const pipe2 = this.redis.pipeline();
      for (const sym of symbols) {
        pipe2.sadd(this.getSymbolHoldersKey(sym, userType), `${userType}:${userId}`);
      }
      await pipe2.exec();
    }

    return {
      user_type: userType,
      user_id: userId,
      total_sql_open: orders.length,
      created_holdings: toCreate.length,
      index_added: orderIds.length,
      symbols_touched: symbols.length,
    };
  }

  async ensureHoldingFromSql(userType, userId, orderId) {
    // fetch a single order
    const Model = userType === 'live' ? LiveUserOrder : DemoUserOrder;
    const row = await Model.findOne({ where: { order_user_id: Number(userId), order_id: String(orderId) } });
    if (!row) return { ensured: false, reason: 'order_not_found' };
    if (String(row.order_status).toUpperCase() !== 'OPEN') {
      // Only backfill OPEN orders into holdings
      return { ensured: false, reason: 'order_not_open' };
    }
    const order = {
      order_id: row.order_id,
      symbol: String(row.symbol).toUpperCase(),
      order_type: String(row.order_type).toUpperCase(),
      order_price: row.order_price?.toString?.() ?? String(row.order_price ?? ''),
      order_quantity: row.order_quantity?.toString?.() ?? String(row.order_quantity ?? ''),
      contract_value: row.contract_value?.toString?.() ?? undefined,
      margin: row.margin?.toString?.() ?? undefined,
      order_status: row.order_status,
      created_at: row.created_at?.toISOString?.() ?? undefined,
      updated_at: row.updated_at?.toISOString?.() ?? undefined,
    };

    const key = this.getOrderKey(userType, userId, order.order_id);
    await this.redis.hset(key, this.buildHoldingMapping(userType, userId, order));
    await this.redis.sadd(this.getIndexKey(userType, userId), order.order_id);
    await this.redis.sadd(this.getSymbolHoldersKey(order.symbol, userType), `${userType}:${userId}`);

    return { ensured: true };
  }
}

module.exports = new OrdersBackfillService();
