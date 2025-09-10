const { redisCluster } = require('../../config/redis');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
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
    // Always include PENDING along with OPEN. Optionally include QUEUED when requested.
    const statuses = includeQueued ? ['OPEN', 'PENDING', 'QUEUED'] : ['OPEN', 'PENDING'];
    const opts = { where: { order_user_id: Number(userId), order_status: { [Op.in]: statuses } } };

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
      // lifecycle IDs for global lookup
      close_id: r.close_id || null,
      cancel_id: r.cancel_id || null,
      modify_id: r.modify_id || null,
      takeprofit_id: r.takeprofit_id || null,
      stoploss_id: r.stoploss_id || null,
      takeprofit_cancel_id: r.takeprofit_cancel_id || null,
      stoploss_cancel_id: r.stoploss_cancel_id || null,
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
    if (toCreate.length) {
      const pipeline = this.redis.pipeline();
      for (const o of toCreate) {
        const key = this.getOrderKey(userType, userId, o.order_id);
        const mapping = this.buildHoldingMapping(userType, userId, o);
        pipeline.hset(key, mapping);
      }
      await pipeline.exec();
    }

    // Ensure index set contains ALL relevant order IDs (existing + newly created)
    const indexKey = this.getIndexKey(userType, userId);
    const desiredOrderIds = Array.from(new Set(orders.map(o => o.order_id)));
    if (desiredOrderIds.length) {
      try {
        const existingIdx = new Set(await this.redis.smembers(indexKey));
        const idxToAdd = desiredOrderIds.filter(id => !existingIdx.has(id));
        if (idxToAdd.length) await this.redis.sadd(indexKey, ...idxToAdd);
      } catch (e) {
        logger.warn('Failed to ensure index set for user', { error: e.message, userType, userId });
      }
    }

    // Ensure symbol holders for ALL encountered symbols
    const symbols = Array.from(new Set(orders.map(o => o.symbol)));
    if (symbols.length) {
      const pipe2 = this.redis.pipeline();
      for (const sym of symbols) {
        pipe2.sadd(this.getSymbolHoldersKey(sym, userType), `${userType}:${userId}`);
      }
      await pipe2.exec();
    }

    // Backfill order_data and global_order_lookup for ALL relevant orders (holdings may already exist)
    let userGroup = 'Standard';
    try {
      if (userType === 'live') {
        const u = await LiveUser.findByPk(Number(userId));
        if (u && u.group) userGroup = String(u.group);
      } else {
        const u = await DemoUser.findByPk(Number(userId));
        if (u && u.group) userGroup = String(u.group);
      }
    } catch (e) {
      logger.warn('Failed to fetch user group for backfill', { error: e.message, userType, userId });
    }

    const pipe3 = this.redis.pipeline();
    for (const o of orders) {
      const odKey = `order_data:${o.order_id}`;
      const odMap = {
        order_id: o.order_id,
        symbol: o.symbol,
        order_type: o.order_type,
        order_price: o.order_price ?? '',
        order_quantity: o.order_quantity ?? '',
        contract_value: o.contract_value ?? undefined,
        margin: o.margin ?? undefined,
        order_status: o.order_status || 'OPEN',
        created_at: o.created_at || undefined,
        group: userGroup,
        user_type: userType,
      };
      pipe3.hset(odKey, odMap);
      // Global lookup mappings for lifecycle IDs -> canonical order_id
      const lifecycleIds = [
        o.order_id,
        o.close_id,
        o.cancel_id,
        o.modify_id,
        o.takeprofit_id,
        o.stoploss_id,
        o.takeprofit_cancel_id,
        o.stoploss_cancel_id,
      ].filter(Boolean);
      for (const lid of lifecycleIds) {
        pipe3.set(`global_order_lookup:${lid}`, o.order_id);
      }
    }
    await pipe3.exec();

    return {
      user_type: userType,
      user_id: userId,
      total_sql_open_pending: orders.length,
      created_holdings: toCreate.length,
      index_added: orderIds.length,
      symbols_touched: symbols.length,
      order_data_backfilled: orders.length,
      global_lookups_mapped: orders.length,
    };
  }

  async ensureHoldingFromSql(userType, userId, orderId) {
    // fetch a single order
    const Model = userType === 'live' ? LiveUserOrder : DemoUserOrder;
    const row = await Model.findOne({ where: { order_user_id: Number(userId), order_id: String(orderId) } });
    if (!row) return { ensured: false, reason: 'order_not_found' };
    const status = String(row.order_status).toUpperCase();
    if (!['OPEN', 'PENDING', 'QUEUED'].includes(status)) {
      // Only backfill active orders into holdings
      return { ensured: false, reason: 'order_not_active' };
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
    // Also ensure order_data and global lookups
    try {
      let userGroup = 'Standard';
      if (userType === 'live') {
        const u = await LiveUser.findByPk(Number(userId));
        if (u && u.group) userGroup = String(u.group);
      } else {
        const u = await DemoUser.findByPk(Number(userId));
        if (u && u.group) userGroup = String(u.group);
      }
      const odKey = `order_data:${order.order_id}`;
      await this.redis.hset(odKey, {
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_price: order.order_price ?? '',
        order_quantity: order.order_quantity ?? '',
        contract_value: order.contract_value ?? undefined,
        margin: order.margin ?? undefined,
        order_status: order.order_status || 'OPEN',
        created_at: order.created_at || undefined,
        group: userGroup,
        user_type: userType,
      });
      const ids = [row.order_id, row.close_id, row.cancel_id, row.modify_id, row.takeprofit_id, row.stoploss_id, row.takeprofit_cancel_id, row.stoploss_cancel_id].filter(Boolean);
      if (ids.length) {
        const p = this.redis.pipeline();
        for (const lid of ids) p.set(`global_order_lookup:${lid}`, String(row.order_id));
        await p.exec();
      }
    } catch (e) {
      logger.warn('Failed to ensure order_data/global_lookup during ensureHoldingFromSql', { error: e.message, order_id: order.order_id });
    }

    return { ensured: true };
  }
}

module.exports = new OrdersBackfillService();
