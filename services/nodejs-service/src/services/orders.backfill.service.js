const { redisCluster } = require('../../config/redis');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const logger = require('./logger.service');
const { Op } = require('sequelize');
const groupsCache = require('./groups.cache.service');
const redisUserCache = require('./redis.user.cache.service');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');

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

  getOrderModel(userType) {
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
        throw new Error(`Unsupported user type: ${userType}`);
    }
  }

  async deriveUserContext(userType, userId) {
    const context = { group: 'Standard', sendingOrders: null };
    const numericId = Number(userId);
    if (!Number.isFinite(numericId)) {
      return context;
    }

    try {
      if (userType === 'live') {
        const user = await LiveUser.findByPk(numericId);
        if (user) {
          if (user.group) context.group = String(user.group);
          if (user.sending_orders) context.sendingOrders = String(user.sending_orders);
        }
      } else if (userType === 'demo') {
        const user = await DemoUser.findByPk(numericId);
        if (user) {
          if (user.group) context.group = String(user.group);
          if (user.sending_orders) context.sendingOrders = String(user.sending_orders);
        }
      } else if (userType === 'strategy_provider') {
        const account = await StrategyProviderAccount.findByPk(numericId);
        if (account) {
          if (account.group) context.group = String(account.group);
          if (account.sending_orders) context.sendingOrders = String(account.sending_orders);
        }
      } else if (userType === 'copy_follower') {
        const account = await CopyFollowerAccount.findByPk(numericId);
        if (account) {
          if (account.group) context.group = String(account.group);
          if (account.sending_orders) context.sendingOrders = String(account.sending_orders);
        }
      }
    } catch (e) {
      logger.warn('Failed to derive user context', { error: e.message, userType, userId });
    }

    return context;
  }

  async fetchOpenOrdersFromDb(userType, userId, includeQueued = false) {
    const Model = this.getOrderModel(userType);
    // Always include PENDING along with OPEN. Optionally include QUEUED when requested.
    const statuses = includeQueued ? ['OPEN', 'PENDING', 'QUEUED', 'PENDING-QUEUED'] : ['OPEN', 'PENDING'];
    const where = { order_user_id: Number(userId), order_status: { [Op.in]: statuses } };

    const rows = await Model.findAll({ where });
    return rows.map(r => ({
      order_id: r.order_id,
      symbol: String(r.symbol).toUpperCase(),
      order_type: String(r.order_type).toUpperCase(),
      order_price: r.order_price?.toString?.() ?? String(r.order_price ?? ''),
      order_quantity: r.order_quantity?.toString?.() ?? String(r.order_quantity ?? ''),
      contract_value: r.contract_value?.toString?.() ?? undefined,
      margin: r.margin?.toString?.() ?? undefined,
      commission: r.commission?.toString?.() ?? undefined,
      swap: r.swap?.toString?.() ?? undefined,
      order_status: r.order_status,
      created_at: r.created_at?.toISOString?.() ?? undefined,
      updated_at: r.updated_at?.toISOString?.() ?? undefined,
      stop_loss: r.stop_loss?.toString?.() ?? undefined,
      take_profit: r.take_profit?.toString?.() ?? undefined,
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
    if (order.commission != null) mapping.commission = String(order.commission);
    if (order.swap != null) mapping.swap = String(order.swap);
    if (order.stop_loss != null) mapping.stop_loss = String(order.stop_loss);
    if (order.take_profit != null) mapping.take_profit = String(order.take_profit);
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
    let indexAdded = 0;
    if (desiredOrderIds.length) {
      try {
        const existingIdx = new Set(await this.redis.smembers(indexKey));
        const idxToAdd = desiredOrderIds.filter(id => !existingIdx.has(id));
        if (idxToAdd.length) {
          await this.redis.sadd(indexKey, ...idxToAdd);
          indexAdded = idxToAdd.length;
        }
      } catch (e) {
        logger.warn('Failed to ensure index set for user', { error: e.message, userType, userId });
      }
    }

    // Ensure symbol holders for ALL encountered symbols (sequential to avoid cross-slot pipeline)
    const symbols = Array.from(new Set(orders.map(o => o.symbol)));
    if (symbols.length) {
      for (const sym of symbols) {
        try {
          await this.redis.sadd(this.getSymbolHoldersKey(sym, userType), `${userType}:${userId}`);
        } catch (e) {
          logger.warn('symbol_holders SADD failed', { error: e.message, symbol: sym, userType, userId });
        }
      }
    }

    // Backfill order_data and global_order_lookup for ALL relevant orders (holdings may already exist)
    const userContext = await this.deriveUserContext(userType, userId);
    const userGroup = userContext.group || 'Standard';

    for (const o of orders) {
      const odKey = `order_data:${o.order_id}`;
      const odMap = {
        order_id: o.order_id,
        user_id: userId,  
        symbol: o.symbol,
        order_type: o.order_type,
        order_price: o.order_price ?? '',
        order_quantity: o.order_quantity ?? '',
        contract_value: o.contract_value ?? undefined,
        margin: o.margin ?? undefined,
        commission: o.commission ?? undefined,
        swap: o.swap ?? undefined,
        order_status: o.order_status || 'OPEN',
        created_at: o.created_at || undefined,
        group: userGroup,
        user_type: userType,
        sending_orders: userContext.sendingOrders || undefined,
      };
      try {
        await this.redis.hset(odKey, odMap);
      } catch (e) {
        logger.warn('order_data HSET failed during backfill', { error: e.message, order_id: o.order_id });
      }
      // Global lookup mappings for lifecycle IDs -> canonical order_id (sequential; different slots)
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
        try {
          await this.redis.set(`global_order_lookup:${lid}`, o.order_id);
        } catch (e) {
          logger.warn('global_order_lookup SET failed', { error: e.message, lifecycle_id: String(lid), order_id: o.order_id });
        }
      }
    }

    return {
      user_type: userType,
      user_id: userId,
      total_sql_open_pending: orders.length,
      created_holdings: toCreate.length,
      index_added: indexAdded,
      symbols_touched: symbols.length,
      order_data_backfilled: orders.length,
      global_lookups_mapped: orders.length,
    };
  }

  // Deep rebuild: pending monitoring (local/provider), triggers (SL/TP), user config
  async rebuildUserExecutionCaches(userType, userId, { includeQueued = true } = {}) {
    // 1) Ensure user config present
    if (userType === 'live' || userType === 'demo') {
      try {
        let cfg = await redisUserCache.getUser(userType, Number(userId));
        if (!cfg) {
          await redisUserCache.refreshUser(userType, Number(userId));
          await redisUserCache.getUser(userType, Number(userId));
        }
      } catch (e) {
        logger.warn('Failed to ensure user config in Redis', { error: e.message, userType, userId });
      }
    }

    // 2) Fetch ALL active orders (OPEN, PENDING, optionally QUEUED)
    const orders = await this.fetchOpenOrdersFromDb(userType, userId, includeQueued);

    // Determine group and provider flow
    let groupName = 'Standard';
    let sendingOrders = null;
    let userContext = null;
    try {
      userContext = await this.deriveUserContext(userType, userId);
      if (userContext.group) groupName = String(userContext.group);
      if (userContext.sendingOrders) sendingOrders = String(userContext.sendingOrders);
    } catch (e) {
      logger.warn('Failed to derive user group/sending_orders; using defaults', { error: e.message, userType, userId });
    }
    const isProviderFlow = (sendingOrders === 'barclays');

    // 3) Ensure user_holdings and index membership (same-slot pipeline)
    try {
      const tag = this.getHashTag(userType, userId);
      const indexKey = this.getIndexKey(userType, userId);
      const p = this.redis.pipeline();
      const orderIds = [];
      for (const o of orders) {
        const key = this.getOrderKey(userType, userId, o.order_id);
        const mapping = this.buildHoldingMapping(userType, userId, o);
        p.hset(key, mapping);
        orderIds.push(o.order_id);
      }
      if (orderIds.length) {
        p.sadd(indexKey, ...orderIds);
      }
      await p.exec();
    } catch (e) {
      logger.warn('Failed to ensure holdings/index during deep rebuild', { error: e.message, userType, userId });
    }

    // 4) Ensure order_data and global lookups (sequential per order; different slots)
    for (const o of orders) {
      const odKey = `order_data:${o.order_id}`;
      const odMap = {
        order_id: o.order_id,
        user_id: userId,  
        symbol: o.symbol,
        order_type: o.order_type,
        order_price: o.order_price ?? '',
        order_quantity: o.order_quantity ?? '',
        contract_value: o.contract_value ?? undefined,
        margin: o.margin ?? undefined,
        order_status: o.order_status || 'OPEN',
        created_at: o.created_at || undefined,
        group: groupName,
        user_type: userType,
        sending_orders: userContext?.sendingOrders || undefined,
      };
      try { await this.redis.hset(odKey, odMap); } catch (e) {
        logger.warn('order_data HSET failed during deep rebuild', { error: e.message, order_id: o.order_id });
      }
      const lifecycleIds = [o.order_id, o.close_id, o.cancel_id, o.modify_id, o.takeprofit_id, o.stoploss_id, o.takeprofit_cancel_id, o.stoploss_cancel_id].filter(Boolean);
      for (const lid of lifecycleIds) {
        try { await this.redis.set(`global_order_lookup:${lid}`, o.order_id); } catch (e) {
          logger.warn('global_order_lookup SET failed during deep rebuild', { error: e.message, lifecycle_id: String(lid), order_id: o.order_id });
        }
      }
    }

    // 5) Rebuild pending structures
    let pendingLocal = 0;
    let pendingProvider = 0;
    for (const o of orders) {
      const st = String(o.order_status || '').toUpperCase();
      if (st === 'PENDING' || st === 'PENDING-QUEUED' || st === 'QUEUED') {
        if (isProviderFlow) {
          // Provider-monitor keys
          try {
            await this.redis.sadd('provider_pending_active', o.order_id);
            await this.redis.hset(`provider_pending:${o.order_id}`, {
              symbol: o.symbol,
              order_type: o.order_type,
              order_quantity: String(o.order_quantity ?? ''),
              user_id: String(userId),
              user_type: String(userType),
              group: groupName,
              created_at: Date.now().toString(),
            });
            pendingProvider += 1;
          } catch (e) {
            logger.warn('Failed to rebuild provider pending state', { error: e.message, order_id: o.order_id });
          }
        } else {
          // Local-monitor keys
          let halfSpread = 0;
          try {
            const gf = await groupsCache.getGroupFields(groupName, o.symbol, ['spread', 'spread_pip']);
            if (gf && gf.spread != null && gf.spread_pip != null) {
              const spread = Number(gf.spread);
              const spread_pip = Number(gf.spread_pip);
              if (Number.isFinite(spread) && Number.isFinite(spread_pip)) {
                halfSpread = (spread * spread_pip) / 2.0;
              }
            }
          } catch (e) {
            logger.warn('Failed to get group spread for pending rebuild', { error: e.message, group: groupName, symbol: o.symbol });
          }
          const priceNum = Number(o.order_price);
          const compare = Number.isFinite(priceNum) ? Number((priceNum - halfSpread).toFixed(8)) : NaN;
          if (Number.isFinite(compare) && compare > 0) {
            try {
              const zkey = `pending_index:{${o.symbol}}:${o.order_type}`;
              await this.redis.zadd(zkey, compare, o.order_id);
            } catch (e) {
              logger.warn('Failed ZADD pending_index during rebuild', { error: e.message, symbol: o.symbol, order_type: o.order_type, order_id: o.order_id });
            }
          }
          try {
            await this.redis.hset(`pending_orders:${o.order_id}`, {
              symbol: o.symbol,
              order_type: o.order_type,
              user_type: String(userType),
              user_id: String(userId),
              order_price_user: String(o.order_price ?? ''),
              order_price_compare: Number.isFinite(compare) ? String(compare) : '',
              order_quantity: String(o.order_quantity ?? ''),
              status: 'PENDING',
              created_at: Date.now().toString(),
              group: groupName,
            });
          } catch (e) {
            logger.warn('Failed HSET pending_orders during rebuild', { error: e.message, order_id: o.order_id });
          }
          try { await this.redis.sadd('pending_active_symbols', o.symbol); } catch (_) {}
          pendingLocal += 1;
        }
      }
    }

    // 6) Rebuild SL/TP triggers for OPEN orders
    let triggersAdded = 0;
    for (const o of orders) {
      const st = String(o.order_status || '').toUpperCase();
      if (st !== 'OPEN') continue;
      const side = String(o.order_type || '').toUpperCase();
      const isBuySell = (side === 'BUY' || side === 'SELL');
      if (!isBuySell) continue;
      const sl = o.stop_loss != null ? Number(o.stop_loss) : NaN;
      const tp = o.take_profit != null ? Number(o.take_profit) : NaN;
      const hasSL = Number.isFinite(sl) && sl > 0;
      const hasTP = Number.isFinite(tp) && tp > 0;
      if (!hasSL && !hasTP) continue;
      try {
        const trigKey = `order_triggers:${o.order_id}`;
        const mapping = {
          order_id: o.order_id,
          symbol: String(o.symbol).toUpperCase(),
          order_type: side,
          user_type: String(userType),
          user_id: String(userId),
        };
        if (hasSL) {
          mapping.stop_loss = String(sl);
          mapping.stop_loss_user = String(sl);
          mapping.stop_loss_compare = String(sl);
        }
        if (hasTP) {
          mapping.take_profit = String(tp);
          mapping.take_profit_user = String(tp);
          mapping.take_profit_compare = String(tp);
        }
        await this.redis.hset(trigKey, mapping);
        if (hasSL) {
          await this.redis.zadd(`sl_index:{${o.symbol}}:${side}`, sl, o.order_id);
        }
        if (hasTP) {
          await this.redis.zadd(`tp_index:{${o.symbol}}:${side}`, tp, o.order_id);
        }
        try { await this.redis.sadd('trigger_active_symbols', String(o.symbol).toUpperCase()); } catch (_) {}
        triggersAdded += 1;
      } catch (e) {
        logger.warn('Failed to rebuild order triggers for order', { error: e.message, order_id: o.order_id });
      }
    }

    return {
      user_type: userType,
      user_id: userId,
      pending_local_built: pendingLocal,
      pending_provider_built: pendingProvider,
      triggers_built: triggersAdded,
    };
  }

  async ensureHoldingFromSql(userType, userId, orderId) {
    // fetch a single order
    const Model = this.getOrderModel(userType);
    const row = await Model.findOne({ where: { order_user_id: Number(userId), order_id: String(orderId) } });
    if (!row) return { ensured: false, reason: 'order_not_found' };
    const status = String(row.order_status).toUpperCase();
    if (!['OPEN', 'PENDING', 'QUEUED', 'PENDING-QUEUED'].includes(status)) {
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
      const context = await this.deriveUserContext(userType, userId);
      const userGroup = context.group || 'Standard';
      const odKey = `order_data:${order.order_id}`;
      await this.redis.hset(odKey, {
        order_id: order.order_id,
        user_id: userId,  // ← MISSING FIELD ADDED!
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
        sending_orders: context.sendingOrders || undefined,
      });
      const ids = [row.order_id, row.close_id, row.cancel_id, row.modify_id, row.takeprofit_id, row.stoploss_id, row.takeprofit_cancel_id, row.stoploss_cancel_id].filter(Boolean);
      if (ids.length) {
        for (const lid of ids) {
          try {
            await this.redis.set(`global_order_lookup:${lid}`, String(row.order_id));
          } catch (e2) {
            logger.warn('global_order_lookup SET failed in ensureHoldingFromSql', { error: e2.message, lifecycle_id: String(lid), order_id: row.order_id });
          }
        }
      }
    } catch (e) {
      logger.warn('Failed to ensure order_data/global_lookup during ensureHoldingFromSql', { error: e.message, order_id: order.order_id });
    }

    return { ensured: true };
  }

  // Prune Redis for a user: remove holdings/index entries not present in SQL.
  // If deep=true, also remove order_data, pending structures, triggers, and global lookups per stale order.
  async pruneUserRedisAgainstSql(userType, userId, { deep = true, pruneSymbolHolders = false } = {}) {
    // 1) Fetch SQL active orders for the user
    const sqlOrders = await this.fetchOpenOrdersFromDb(userType, userId, true);
    const sqlIds = new Set(sqlOrders.map(o => String(o.order_id)));
    // 2) Discover current Redis holdings for the user
    const existingIds = await this.scanExistingUserHoldingOrderIds(userType, userId);
    const staleIds = Array.from(existingIds).filter(id => !sqlIds.has(String(id)));
    const keptIds = Array.from(existingIds).filter(id => sqlIds.has(String(id)));

    const hashTag = this.getHashTag(userType, userId);
    const indexKey = this.getIndexKey(userType, userId);

    let holdingsDeleted = 0;
    let indexRemoved = 0;
    let orderDataDeleted = 0;
    let pendingRemoved = 0;
    let triggerRemoved = 0;
    let globalLookupRemoved = 0;
    let symbolHolderSrem = 0;

    // 3) Remove user-scoped keys in one same-slot pipeline
    if (staleIds.length) {
      const p = this.redis.pipeline();
      for (const oid of staleIds) {
        p.srem(indexKey, String(oid));
        p.del(this.getOrderKey(userType, userId, String(oid)));
      }
      try { await p.exec(); } catch (e) {
        logger.warn('Pipeline error pruning user holdings/index', { error: e.message, userType, userId });
      }
      holdingsDeleted = staleIds.length;
      indexRemoved = staleIds.length;
    }

    if (deep) {
      // 4) For each stale order, clean cross-slot keys sequentially
      for (const oid of staleIds) {
        const orderId = String(oid);
        let symbol = null;
        let orderType = null; // may be BUY_LIMIT, etc., or BUY/SELL
        let side = null; // BUY/SELL for triggers
        // 4a) Fetch order_data to discover symbol, type, lifecycle ids
        let od = null;
        try { od = await this.redis.hgetall(`order_data:${orderId}`); } catch (_) {}
        if (od && Object.keys(od).length) {
          if (od.symbol) symbol = String(od.symbol).toUpperCase();
          if (od.order_type) orderType = String(od.order_type).toUpperCase();
          // some schemas store BUY/SELL as order_type for OPEN
          if (orderType === 'BUY' || orderType === 'SELL') side = orderType;
          // lifecycle ids
          const lids = [od.close_id, od.cancel_id, od.modify_id, od.takeprofit_id, od.stoploss_id, od.takeprofit_cancel_id, od.stoploss_cancel_id].filter(Boolean);
          for (const lid of lids) {
            try { await this.redis.del(`global_order_lookup:${String(lid)}`); globalLookupRemoved += 1; } catch (_) {}
          }
          try { await this.redis.del(`order_data:${orderId}`); orderDataDeleted += 1; } catch (_) {}
        }
        // 4b) Pending structures: pending_orders hash and ZREM from pending_index by symbol/type
        try {
          const pend = await this.redis.hgetall(`pending_orders:${orderId}`);
          if (pend && Object.keys(pend).length) {
            if (!symbol && pend.symbol) symbol = String(pend.symbol).toUpperCase();
            if (!orderType && pend.order_type) orderType = String(pend.order_type).toUpperCase();
            try { await this.redis.del(`pending_orders:${orderId}`); pendingRemoved += 1; } catch (_) {}
          }
        } catch (_) {}
        if (symbol && orderType && /BUY_|SELL_/.test(orderType)) {
          const zkey = `pending_index:{${symbol}}:${orderType}`;
          try { await this.redis.zrem(zkey, orderId); pendingRemoved += 1; } catch (_) {}
        }
        // 4c) Triggers
        try {
          const trig = await this.redis.hgetall(`order_triggers:${orderId}`);
          if (trig && Object.keys(trig).length) {
            const symT = String(trig.symbol || symbol || '').toUpperCase();
            const sideT = String(trig.order_type || trig.side || side || '').toUpperCase();
            if (symT && (sideT === 'BUY' || sideT === 'SELL')) {
              try { await this.redis.zrem(`sl_index:{${symT}}:${sideT}`, orderId); } catch (_) {}
              try { await this.redis.zrem(`tp_index:{${symT}}:${sideT}`, orderId); } catch (_) {}
            }
            try { await this.redis.del(`order_triggers:${orderId}`); triggerRemoved += 1; } catch (_) {}
          }
        } catch (_) {}

        // 4d) Optionally update symbol_holders if no other active orders for this symbol
        if (pruneSymbolHolders && symbol) {
          try {
            // Check if any kept order (from holdings) belongs to this symbol
            let hasOther = false;
            const keptArr = Array.from(keptIds);
            if (keptArr.length) {
              const p = this.redis.pipeline();
              const keys = keptArr.map(id => `user_holdings:{${hashTag}}:${id}`);
              for (const k of keys) p.hget(k, 'symbol');
              const r = await p.exec();
              for (const [err, val] of r || []) {
                if (!err && val && String(val).toUpperCase() === symbol) { hasOther = true; break; }
              }
            }
            if (!hasOther) {
              const holder = `${userType}:${userId}`;
              try { await this.redis.srem(`symbol_holders:${symbol}:${userType}`, holder); symbolHolderSrem += 1; } catch (_) {}
              logger.symbolHolders('symbol_holders_remove', {
                user_type: userType,
                user_id: userId,
                symbol,
                key: `symbol_holders:${symbol}:${userType}`,
                reason: 'backfill_prune_no_other_orders'
              });
            } else {
              logger.symbolHolders('symbol_holders_skip', {
                user_type: userType,
                user_id: userId,
                symbol,
                reason: 'other_open_orders_present_during_prune'
              });
            }
          } catch (_) {}
        }
      }
    }

    return {
      user_type: userType,
      user_id: userId,
      sql_active: sqlIds.size,
      redis_holdings_found: existingIds.size,
      stale_orders: staleIds.length,
      pruned: {
        holdings_deleted: holdingsDeleted,
        index_removed: indexRemoved,
        order_data_deleted: orderDataDeleted,
        pending_removed: pendingRemoved,
        triggers_removed: triggerRemoved,
        global_lookups_removed: globalLookupRemoved,
        symbol_holders_srem: symbolHolderSrem,
      }
    };
  }
}

module.exports = new OrdersBackfillService();
