const axios = require('axios');
const logger = require('../services/logger.service');
const orderReqLogger = require('../services/order.request.logger');
const idGenerator = require('../services/idGenerator.service');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const { updateUserUsedMargin } = require('../services/user.margin.service');
const portfolioEvents = require('../services/events/portfolio.events');
const { redisCluster } = require('../../config/redis');
const groupsCache = require('../services/groups.cache.service');
const redisUserCache = require('../services/redis.user.cache.service');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const { applyOrderClosePayout } = require('../services/order.payout.service');

function getTokenUserId(user) {
  return user?.sub || user?.user_id || user?.id;
}

// Validate pending order payload and derive parsed fields
function validatePendingPayload(body) {
  const errors = [];
  const symbol = normalizeStr(body.symbol).toUpperCase();
  const order_type = normalizeStr(body.order_type).toUpperCase(); // BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP
  const user_type = normalizeStr(body.user_type).toLowerCase();
  const order_price = toNumber(body.order_price);
  const order_quantity = toNumber(body.order_quantity);
  const user_id = normalizeStr(body.user_id);

  if (!symbol) errors.push('symbol');
  if (!['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'].includes(order_type)) errors.push('order_type');
  if (!(order_price > 0)) errors.push('order_price');
  if (!(order_quantity > 0)) errors.push('order_quantity');
  if (!user_id) errors.push('user_id');
  if (!['live', 'demo'].includes(user_type)) errors.push('user_type');

  return { errors, parsed: { symbol, order_type, user_type, order_price, order_quantity, user_id } };
}

function normalizeStr(v) {
  return (v ?? '').toString();
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validatePayload(body) {
  const errors = [];
  const symbol = normalizeStr(body.symbol).toUpperCase();
  const order_type = normalizeStr(body.order_type).toUpperCase();
  const user_type = normalizeStr(body.user_type).toLowerCase();
  const order_price = toNumber(body.order_price);
  const order_quantity = toNumber(body.order_quantity);
  const user_id = normalizeStr(body.user_id);

  if (!symbol) errors.push('symbol');
  if (!['BUY', 'SELL'].includes(order_type)) errors.push('order_type');
  if (!(order_price > 0)) errors.push('order_price');
  if (!(order_quantity > 0)) errors.push('order_quantity');
  if (!user_id) errors.push('user_id');
  if (!['live', 'demo'].includes(user_type)) errors.push('user_type');

  return { errors, parsed: { symbol, order_type, user_type, order_price, order_quantity, user_id } };
}

async function placeInstantOrder(req, res) {
  const operationId = `instant_place_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'placeInstantOrder',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    // JWT checks
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed for order placement' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    // Validate payload
    const { errors, parsed } = validatePayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Invalid payload fields', fields: errors });
    }

    // Ensure user places orders only for themselves (if token has id)
    if (tokenUserId && normalizeStr(parsed.user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot place orders for another user' });
    }

    // Generate order_id in ord_YYYYMMDD_seq format using IdGeneratorService
    const order_id = await idGenerator.generateOrderId();
    const hasIdempotency = !!req.body.idempotency_key;

    // Persist initial order (QUEUED) unless request is idempotent
    const OrderModel = parsed.user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    let initialOrder;
    if (!hasIdempotency) {
      try {
        initialOrder = await OrderModel.create({
          order_id,
          order_user_id: parseInt(parsed.user_id),
          symbol: parsed.symbol,
          order_type: parsed.order_type,
          order_status: 'QUEUED',
          order_price: parsed.order_price,
          order_quantity: parsed.order_quantity,
          margin: 0,
          status: normalizeStr(req.body.status || 'OPEN'),
          placed_by: 'user'
        });
      } catch (dbErr) {
        logger.error('Order DB create failed', { error: dbErr.message, fields: {
          order_id,
          order_user_id: parsed.user_id,
          symbol: parsed.symbol,
          order_type: parsed.order_type,
          order_status: 'QUEUED',
          order_price: parsed.order_price,
          order_quantity: parsed.order_quantity,
          margin: 0,
          status: normalizeStr(req.body.status || 'OPEN'),
          placed_by: 'user'
        }});
        return res.status(500).json({ success: false, message: 'DB error', db_error: dbErr.message, operationId });
      }
    }

    // Build payload to Python
    const pyPayload = {
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      user_id: parsed.user_id,
      user_type: parsed.user_type,
      order_id,
      status: normalizeStr(req.body.status || 'OPEN'),
      order_status: normalizeStr(req.body.order_status || 'OPEN'),
    };
    if (req.body.idempotency_key) {
      pyPayload.idempotency_key = normalizeStr(req.body.idempotency_key);
    }

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

    logger.transactionStart('instant_place', { operationId, order_id, userId: parsed.user_id });

    let pyResp;
    try {
      pyResp = await axios.post(
        `${baseUrl}/api/orders/instant/execute`,
        pyPayload,
        {
          timeout: 15000,
          headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' },
        }
      );
    } catch (err) {
      // Python returned error (4xx/5xx)
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };

      // Update DB as REJECTED with reason
      try {
        const reasonStr = normalizeStr(detail?.detail?.reason || detail?.reason || 'execution_failed');
        const rejectStatus = {
          order_status: 'REJECTED',
          close_message: reasonStr,
        };
        if (initialOrder) {
          await initialOrder.update(rejectStatus);
        } else {
          // Upsert a row for idempotent path where we skipped pre-insert
          const [row, created] = await OrderModel.findOrCreate({
            where: { order_id },
            defaults: {
              order_id,
              order_user_id: parseInt(parsed.user_id),
              symbol: parsed.symbol,
              order_type: parsed.order_type,
              order_status: 'QUEUED',
              order_price: parsed.order_price,
              order_quantity: parsed.order_quantity,
              margin: 0,
              status: normalizeStr(req.body.status || 'OPEN'),
              placed_by: 'user'
            }
          });
          await row.update(rejectStatus);
        }
      } catch (uErr) {
        logger.error('Failed to update order after Python error', { error: uErr.message, order_id });
      }

      // Map 409 specially if duplicate
      if (statusCode === 409) {
        return res.status(409).json({
          success: false,
          order_id,
          reason: detail?.detail?.reason || detail?.reason || 'conflict',
        });
      }

      return res.status(statusCode).json({
        success: false,
        order_id,
        reason: detail?.detail?.reason || detail?.reason || 'execution_failed',
        error: detail?.detail || detail
      });
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow; // 'local' or 'provider'
    const exec_price = result.exec_price;
    const margin_usd = result.margin_usd;
    const contract_value = result.contract_value;
    const commission_entry = result.commission_entry; // optional for local flow
    // New fields from Python service; keep fallback for older responses
    const used_margin_executed = (result.used_margin_executed !== undefined) ? result.used_margin_executed : result.used_margin_usd;
    const used_margin_all = result.used_margin_all;

    // Post-success DB update
    const updateFields = {};
    if (typeof exec_price === 'number') {
      updateFields.order_price = exec_price;
    }
    // Persist margin only for local (immediate) execution.
    // For provider flow, margin is reserved/managed in Redis and finalized on provider confirmation.
    if (flow === 'local' && typeof margin_usd === 'number') {
      updateFields.margin = margin_usd;
    }
    if (typeof contract_value === 'number') {
      updateFields.contract_value = contract_value;
    }
    if (flow === 'local' && typeof commission_entry === 'number') {
      updateFields.commission = commission_entry;
    }
    // Map to requested statuses
    if (flow === 'local') {
      // Executed instantly -> OPEN
      updateFields.order_status = 'OPEN';
    } else if (flow === 'provider') {
      // Waiting for provider confirmation -> QUEUED
      updateFields.order_status = 'QUEUED';
    } else {
      updateFields.order_status = 'OPEN'; // sane default
    }

    // Upsert by final order_id to avoid duplicate rows on idempotent replays
    const finalOrderId = normalizeStr(result.order_id || order_id);
    if (initialOrder) {
      try {
        // If IDs diverge (shouldn't for non-idempotent), fall back to updating by final ID
        if (normalizeStr(initialOrder.order_id) !== finalOrderId) {
          const [row, created] = await OrderModel.findOrCreate({
            where: { order_id: finalOrderId },
            defaults: {
              order_id: finalOrderId,
              order_user_id: parseInt(parsed.user_id),
              symbol: parsed.symbol,
              order_type: parsed.order_type,
              order_status: 'QUEUED',
              order_price: parsed.order_price,
              order_quantity: parsed.order_quantity,
              margin: 0,
              status: normalizeStr(req.body.status || 'OPEN'),
              placed_by: 'user'
            }
          });
          await row.update(updateFields);
        } else {
          await initialOrder.update(updateFields);
        }
      } catch (uErr) {
        logger.error('Failed to update order after success', { error: uErr.message, order_id: finalOrderId });
      }
    } else {
      try {
        const [row, created] = await OrderModel.findOrCreate({
          where: { order_id: finalOrderId },
          defaults: {
            order_id: finalOrderId,
            order_user_id: parseInt(parsed.user_id),
            symbol: parsed.symbol,
            order_type: parsed.order_type,
            order_status: 'QUEUED',
            order_price: parsed.order_price,
            order_quantity: parsed.order_quantity,
            margin: 0,
            status: normalizeStr(req.body.status || 'OPEN'),
            placed_by: 'user'
          }
        });
        await row.update(updateFields);
      } catch (uErr) {
        logger.error('Failed to upsert order after success', { error: uErr.message, order_id: finalOrderId });
      }
    }

    // Emit WS event for local execution order update
    if (flow === 'local') {
      try {
        portfolioEvents.emitUserUpdate(parsed.user_type, parsed.user_id, {
          type: 'order_update',
          order_id: finalOrderId,
          update: updateFields,
        });
      } catch (e) {
        logger.warn('Failed to emit portfolio event for local order update', { error: e.message, order_id: finalOrderId });
      }
    }

    // Persist user's overall used margin only for local execution here.
    // For provider flow, the async worker (on provider confirmation) will persist to SQL instead.
    if (flow === 'local' && typeof used_margin_executed === 'number') {
      try {
        await updateUserUsedMargin({
          userType: parsed.user_type,
          userId: parseInt(parsed.user_id),
          usedMargin: used_margin_executed,
        });
        // Emit WS event for margin change
        try {
          portfolioEvents.emitUserUpdate(parsed.user_type, parsed.user_id, {
            type: 'user_margin_update',
            used_margin_usd: used_margin_executed,
          });
        } catch (e) {
          logger.warn('Failed to emit portfolio event after local margin update', { error: e.message, userId: parsed.user_id });
        }
      } catch (mErr) {
        logger.error('Failed to update user used margin', {
          error: mErr.message,
          userId: parsed.user_id,
          userType: parsed.user_type,
        });
        // Do not fail the request; SQL margin is an eventual-consistency mirror of Redis
      }
    }

    // Build frontend response
    return res.status(201).json({
      success: true,
      order_id: finalOrderId,
      order_status: updateFields.order_status,
      execution_mode: flow,
      margin: margin_usd,
      exec_price: exec_price,
      contract_value: typeof contract_value === 'number' ? contract_value : undefined,
      commission: typeof commission_entry === 'number' ? commission_entry : undefined,
    });
  } catch (error) {
    logger.transactionFailure('instant_place', error, { operationId });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

// Place a pending order: validate constraints, compute compare_price, persist SQL+Redis
async function placePendingOrder(req, res) {
  const operationId = `pending_place_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'placePendingOrder',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    // JWT checks
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;
    const userGroup = user && user.group ? String(user.group) : 'Standard';

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed for pending order placement' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    // Validate payload
    const { errors, parsed } = validatePendingPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Invalid payload fields', fields: errors });
    }

    // Ensure user places orders only for themselves (if token has id)
    if (tokenUserId && String(parsed.user_id) !== String(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot place orders for another user' });
    }

    // Normalize for Redis keys and cross-service compatibility
    const symbol = String(parsed.symbol).toUpperCase();
    const orderType = String(parsed.order_type).toUpperCase();

    // Fetch current market prices from Redis
    let bid = null, ask = null;
    try {
      const arr = await redisCluster.hmget(`market:${symbol}`, 'bid', 'ask');
      if (arr && arr.length >= 2) {
        bid = arr[0] != null ? Number(arr[0]) : null;
        ask = arr[1] != null ? Number(arr[1]) : null;
      }
    } catch (e) {
      logger.error('Failed to read market price from Redis', { error: e.message, symbol: parsed.symbol });
    }
    if (!(bid > 0) || !(ask > 0)) {
      return res.status(503).json({ success: false, message: 'Market price unavailable for symbol' });
    }

    // Price constraints removed as per requirement; placement no longer checks against current bid/ask

    // Compute half_spread from group cache
    let half_spread = null;
    try {
      const gf = await groupsCache.getGroupFields(userGroup, symbol, ['spread', 'spread_pip']);
      if (gf && gf.spread != null && gf.spread_pip != null) {
        const spread = Number(gf.spread);
        const spread_pip = Number(gf.spread_pip);
        if (Number.isFinite(spread) && Number.isFinite(spread_pip)) {
          half_spread = (spread * spread_pip) / 2.0;
        }
      }
    } catch (e) {
      logger.warn('Failed to get group spread config for pending', { error: e.message, group: userGroup, symbol: parsed.symbol });
    }
    if (!(half_spread >= 0)) {
      return res.status(400).json({ success: false, message: 'Group spread configuration missing for symbol/group' });
    }

    // Pending monitoring is ask-based for all types: store compare = user_price - half_spread
    // Trigger direction is handled by the worker (ask >= or <= compare) per type
    const hs = Number.isFinite(Number(half_spread)) ? Number(half_spread) : 0;
    const compare_price = Number((parsed.order_price - hs).toFixed(8));
    if (!(compare_price > 0)) {
      return res.status(400).json({ success: false, message: 'Computed compare_price invalid' });
    }

    // Determine if provider flow (before DB create) to set proper order_status
    let isProviderFlow = false;
    try {
      const userCfgKey = `user:{${parsed.user_type}:${parsed.user_id}}:config`;
      const ucfg = await redisCluster.hgetall(userCfgKey);
      const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = (so === 'barclays');
    } catch (_) {
      isProviderFlow = false;
    }

    // Generate order_id and persist SQL row
    const OrderModel = parsed.user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    const order_id = await idGenerator.generateOrderId();
    try {
      await OrderModel.create({
        order_id,
        order_user_id: parseInt(parsed.user_id, 10),
        symbol: parsed.symbol,
        order_type: parsed.order_type,
        order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
        order_price: parsed.order_price,
        order_quantity: parsed.order_quantity,
        margin: 0,
        status: 'PENDING',
        placed_by: 'user',
      });
    } catch (dbErr) {
      logger.error('Pending order DB create failed', { error: dbErr.message, order_id });
      return res.status(500).json({ success: false, message: 'DB error', db_error: dbErr.message, operationId });
    }

    // Store pending order in Redis (local monitor only if not provider)
    const zkey = `pending_index:{${symbol}}:${orderType}`;
    const hkey = `pending_orders:${order_id}`;
    try {
      if (!isProviderFlow) {
        await redisCluster.zadd(zkey, compare_price, order_id);
        await redisCluster.hset(hkey, {
          symbol: symbol,
          order_type: orderType,
          user_type: parsed.user_type,
          user_id: parsed.user_id,
          order_price_user: String(parsed.order_price),
          order_price_compare: String(compare_price),
          order_quantity: String(parsed.order_quantity),
          status: 'PENDING',
          created_at: Date.now().toString(),
          group: userGroup,
        });
      }
      // Mirror minimal PENDING into user holdings and index for immediate WS visibility
      try {
        const hashTag = `${parsed.user_type}:${parsed.user_id}`;
        const orderKey = `user_holdings:{${hashTag}}:${order_id}`;
        const indexKey = `user_orders_index:{${hashTag}}`;
        const pipe = redisCluster.pipeline();
        pipe.sadd(indexKey, order_id);
        pipe.hset(orderKey, {
          order_id: String(order_id),
          symbol: symbol,
          order_type: orderType, // pending type (e.g., BUY_LIMIT)
          order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
          status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
          execution_status: 'QUEUED',
          order_price: String(parsed.order_price),
          order_quantity: String(parsed.order_quantity),
          group: userGroup,
          created_at: Date.now().toString(),
        });
        await pipe.exec();
      } catch (e3) {
        logger.warn('Failed to mirror pending into user holdings/index', { error: e3.message, order_id });
      }
      // Also write canonical order_data for downstream consumers
      try {
        const odKey = `order_data:${String(order_id)}`;
        await redisCluster.hset(
          odKey,
          {
          order_id: String(order_id),
          user_type: String(parsed.user_type),
          user_id: String(parsed.user_id),
          symbol: symbol,
          order_type: orderType, // pending type
          order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
          status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
          order_price: String(parsed.order_price),
          order_quantity: String(parsed.order_quantity),
          group: userGroup,
          compare_price: String(compare_price),
          half_spread: String(hs),
        });
      } catch (e4) {
        logger.warn('Failed to write canonical order_data for pending', { error: e4.message, order_id });
      }
      // Ensure symbol is tracked for periodic scanning by the worker (local only)
      try {
        if (!isProviderFlow) {
          await redisCluster.sadd('pending_active_symbols', symbol);
        }
      } catch (e2) {
        logger.warn('Failed to add symbol to pending_active_symbols set', { error: e2.message, symbol });
      }
    } catch (e) {
      logger.error('Failed to write pending order to Redis', { error: e.message, order_id, zkey });
      return res.status(500).json({ success: false, message: 'Cache error', operationId });
    }

 
    try {
      await redisCluster.publish('market_price_updates', symbol);
      logger.info('Published market_price_updates for pending placement', { symbol, zkey, order_id });
    } catch (e) {
      logger.warn('Failed to publish market_price_updates after pending placement', { error: e.message, symbol, order_id });
    }

    // Notify WS layer
    try {
      portfolioEvents.emitUserUpdate(parsed.user_type, parsed.user_id, {
        type: 'order_update',
        order_id,
        update: { order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING' },
      });
    } catch (e) {
      logger.warn('Failed to emit portfolio event for pending order', { error: e.message, order_id });
    }

    // Provider flow: if user's sending_orders is provider, send pending placement to provider
    try {
      // Use previously determined provider flow flag
      if (isProviderFlow) {
        // 1) Generate cancel_id in Node and persist to SQL
        let cancel_id = null;
        try {
          cancel_id = await idGenerator.generateCancelOrderId();
        } catch (eGen) {
          logger.warn('Failed to generate cancel_id for provider pending', { error: eGen.message, order_id });
        }
        if (cancel_id) {
          try {
            await OrderModel.update({ cancel_id }, { where: { order_id } });
          } catch (eUpd) {
            logger.warn('Failed to persist cancel_id in SQL for provider pending', { error: eUpd.message, order_id });
          }
          // Persist in Redis holdings and canonical for Python monitor access
          // IMPORTANT: Avoid cross-slot pipelines in Redis Cluster. Write per-key.
          try {
            const hashTag = `${parsed.user_type}:${parsed.user_id}`;
            const orderKey = `user_holdings:{${hashTag}}:${order_id}`;
            const odKey = `order_data:${order_id}`;
            await redisCluster.hset(orderKey, 'cancel_id', String(cancel_id));
            try {
              await redisCluster.hset(odKey, 'cancel_id', String(cancel_id));
            } catch (e2) {
              logger.warn('Failed to set cancel_id on order_data', { error: e2.message, order_id });
            }
          } catch (eRedis) {
            logger.warn('Failed to mirror cancel_id into Redis for provider pending', { error: eRedis.message, order_id });
          }
          // Also register lifecycle id mapping in Python for provider dispatcher quick lookup (fire-and-forget)
          try {
            const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
            axios.post(`${baseUrl}/api/orders/registry/lifecycle-id`, {
              order_id,
              new_id: cancel_id,
              id_type: 'cancel_id',
            }, { timeout: 5000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } })
              .then(() => {
                logger.info('Registered cancel_id lifecycle mapping in Python', { order_id });
              })
              .catch((eMap) => {
                logger.warn('Failed to register cancel_id lifecycle mapping in Python', { error: eMap.message, order_id });
              });
          } catch (eMapOuter) {
            logger.warn('Unable to initiate cancel_id lifecycle registration', { error: eMapOuter.message, order_id });
          }
        }
        // 2) Call Python to place provider pending order (Python will half-spread adjust before sending)
        try {
          const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
          const payload = {
            order_id,
            symbol,
            order_type: orderType,
            order_price: parsed.order_price,
            order_quantity: parsed.order_quantity,
            user_id: parsed.user_id,
            user_type: parsed.user_type,
          };
          axios.post(
            `${baseUrl}/api/orders/pending/place`,
            payload,
            { timeout: 5000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
          )
            .then(() => {
              logger.info('Dispatched provider pending placement', { order_id, symbol, orderType });
            })
            .catch((ePy) => {
              logger.error('Python provider pending placement failed', { error: ePy.message, order_id });
            });
        } catch (ePyOuter) {
          logger.warn('Unable to initiate provider pending placement call', { error: ePyOuter.message, order_id });
        }
      }
    } catch (eProv) {
      logger.warn('Provider pending dispatch block failed', { error: eProv.message, order_id });
    }

    return res.status(201).json({
      success: true,
      order_id,
      order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
      compare_price,
      group: userGroup,
    });
  } catch (error) {
    logger.error('placePendingOrder internal error', { error: error.message, operationId });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function _getCanonicalOrder(order_id) {
  try {
    const key = `order_data:${String(order_id)}`;
    const od = await redisCluster.hgetall(key);
    if (od && Object.keys(od).length > 0) return od;
  } catch (e) {
    logger.warn('Failed to fetch canonical order from Redis', { order_id, error: e.message });
  }
  return null;
}

function _isMarketOpenByType(typeVal) {
  // type==4 => crypto (24/7)
  try {
    const t = parseInt(typeVal);
    if (t === 4) return true;
  } catch (_) {}
  const day = new Date().getUTCDay(); // 0 Sunday, 6 Saturday
  if (day === 0 || day === 6) return false;
  return true;
}

// Modify a pending order's price
async function modifyPendingOrder(req, res) {
  const operationId = `pending_modify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'modifyPendingOrder',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});

    // JWT checks
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;
    const userGroupFromToken = user && user.group ? String(user.group) : 'Standard';

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed for pending modify' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    // Validate payload
    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const symbol = normalizeStr(body.symbol).toUpperCase();
    const order_type = normalizeStr(body.order_type).toUpperCase(); // BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP
    const user_type = normalizeStr(body.user_type).toLowerCase();
    const order_price = toNumber(body.order_price);
    const order_quantity = toNumber(body.order_quantity);
    const user_id = normalizeStr(body.user_id);
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id is required' });
    if (!symbol) return res.status(400).json({ success: false, message: 'symbol is required' });
    if (!['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'].includes(order_type)) return res.status(400).json({ success: false, message: 'Invalid order_type' });
    if (!(order_price > 0)) return res.status(400).json({ success: false, message: 'Invalid order_price' });
    if (!(order_quantity > 0)) return res.status(400).json({ success: false, message: 'Invalid order_quantity' });
    if (!user_id) return res.status(400).json({ success: false, message: 'user_id is required' });
    if (!['live', 'demo'].includes(user_type)) return res.status(400).json({ success: false, message: 'Invalid user_type' });

    // Ensure user can only modify own orders
    if (tokenUserId && String(user_id) !== String(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot modify orders for another user' });
    }

    // Load canonical order (prefer Redis)
    let canonical = await _getCanonicalOrder(order_id);
    let sqlRow = null;
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    if (!canonical) {
      // Fallback to SQL
      sqlRow = await OrderModel.findOne({ where: { order_id } });
      if (!sqlRow) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }
      if (String(sqlRow.order_user_id) !== String(user_id)) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      // Must be pending
      const st = (sqlRow.order_status || '').toString().toUpperCase();
      if (!['PENDING', 'PENDING-QUEUED', 'MODIFY'].includes(st)) {
        return res.status(409).json({ success: false, message: `Order is not pending (current: ${st})` });
      }
      canonical = {
        order_id,
        user_id: String(user_id),
        user_type: String(user_type),
        symbol: String(sqlRow.symbol || sqlRow.order_company_name).toUpperCase(),
        order_type: String(sqlRow.order_type).toUpperCase(),
        order_status: st,
        status: st,
        group: userGroupFromToken,
      };
    } else {
      // Basic ownership and type checks from canonical
      if (String(canonical.user_id) !== String(user_id) || String(canonical.user_type).toLowerCase() !== String(user_type)) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      const st = String(canonical.order_status || canonical.status || '').toUpperCase();
      if (!['PENDING', 'PENDING-QUEUED', 'MODIFY'].includes(st)) {
        return res.status(409).json({ success: false, message: `Order is not pending (current: ${st})` });
      }
      // Optional symbol/type match enforcement
      if (String(canonical.symbol || '').toUpperCase() !== symbol) {
        return res.status(400).json({ success: false, message: 'Symbol mismatch with existing order' });
      }
      if (String(canonical.order_type || '').toUpperCase() !== order_type) {
        return res.status(400).json({ success: false, message: 'order_type mismatch with existing order' });
      }
    }

    // Determine flow based on user config (sending_orders)
    let isProviderFlow = false;
    try {
      const userCfgKey = `user:{${user_type}:${user_id}}:config`;
      const ucfg = await redisCluster.hgetall(userCfgKey);
      const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = (so === 'barclays');
    } catch (_) { isProviderFlow = false; }

    // Fetch half_spread for compare price calculation
    const groupName = String(canonical.group || userGroupFromToken || 'Standard');
    let half_spread = null;
    try {
      const gf = await groupsCache.getGroupFields(groupName, symbol, ['spread', 'spread_pip']);
      if (gf && gf.spread != null && gf.spread_pip != null) {
        const spread = Number(gf.spread);
        const spread_pip = Number(gf.spread_pip);
        if (Number.isFinite(spread) && Number.isFinite(spread_pip)) {
          half_spread = (spread * spread_pip) / 2.0;
        }
      }
    } catch (e) {
      logger.warn('Failed to get group spread config for pending modify', { error: e.message, group: groupName, symbol });
    }
    if (!(half_spread >= 0)) {
      return res.status(400).json({ success: false, message: 'Group spread configuration missing for symbol/group' });
    }

    if (!isProviderFlow) {
      // Local flow: update monitoring keys and canonical immediately
      const compare_price = Number((order_price - Number(half_spread)).toFixed(8));
      if (!(compare_price > 0)) {
        return res.status(400).json({ success: false, message: 'Computed compare_price invalid' });
      }
      const zkey = `pending_index:{${symbol}}:${order_type}`;
      const hkey = `pending_orders:${order_id}`;
      try {
        // Update ZSET score (re-add with new score)
        await redisCluster.zadd(zkey, compare_price, order_id);
        // Update pending orders hash
        await redisCluster.hset(hkey, {
          order_price_user: String(order_price),
          order_price_compare: String(compare_price),
          updated_at: Date.now().toString(),
        });
        // Mirror to user holdings (same-slot pipeline)
        try {
          const tag = `${user_type}:${user_id}`;
          const orderKey = `user_holdings:{${tag}}:${order_id}`;
          const pUser = redisCluster.pipeline();
          pUser.hset(orderKey, 'order_price', String(order_price));
          pUser.hset(orderKey, 'status', 'PENDING');
          await pUser.exec();
        } catch (e) { logger.warn('Failed to mirror modify to user holdings', { error: e.message, order_id }); }
        // Update canonical (separate slot)
        try {
          const odKey = `order_data:${order_id}`;
          const pOd = redisCluster.pipeline();
          pOd.hset(odKey, 'order_price', String(order_price));
          pOd.hset(odKey, 'compare_price', String(compare_price));
          pOd.hset(odKey, 'half_spread', String(half_spread));
          pOd.hset(odKey, 'status', 'PENDING');
          await pOd.exec();
        } catch (e) { logger.warn('Failed to update canonical for pending modify', { error: e.message, order_id }); }
      } catch (e) {
        logger.error('Failed to update Redis for pending modify', { error: e.message, order_id, zkey });
        return res.status(500).json({ success: false, message: 'Cache error', operationId });
      }

      // Publish symbol for any monitoring recalculation and WS event
      try { await redisCluster.publish('market_price_updates', symbol); } catch (_) {}
      try {
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'order_update',
          order_id,
          update: { order_status: 'PENDING', order_price: String(order_price) },
        });
      } catch (_) {}

      // Persist SQL order_price
      try {
        await OrderModel.update({ order_price: order_price }, { where: { order_id } });
      } catch (dbErr) {
        logger.warn('SQL update failed for pending modify', { error: dbErr.message, order_id });
      }

      return res.status(200).json({ success: true, order_id, order_status: 'PENDING', compare_price, execution_mode: 'local' });
    }

    // Provider flow: generate modify_id, set status=MODIFY, store pending modify price, dispatch to Python
    let modify_id = null;
    try { modify_id = await idGenerator.generateModifyId(); } catch (e) { logger.warn('Failed to generate modify_id', { error: e.message }); }
    if (modify_id) {
      // Persist modify_id in SQL
      try { await OrderModel.update({ modify_id }, { where: { order_id } }); } catch (e) { logger.warn('Failed to persist modify_id in SQL', { error: e.message, order_id }); }
    }
    // Mirror status=MODIFY and store pending_modify_price_user for worker to apply on confirmation
    try {
      const tag = `${user_type}:${user_id}`;
      const orderKey = `user_holdings:{${tag}}:${order_id}`;
      const odKey = `order_data:${order_id}`;
      await redisCluster.hset(orderKey, {
        status: 'MODIFY',
        pending_modify_price_user: String(order_price),
      });
      // Separate slot updates
      const pOd = redisCluster.pipeline();
      pOd.hset(odKey, 'status', 'MODIFY');
      pOd.hset(odKey, 'pending_modify_price_user', String(order_price));
      if (modify_id) pOd.hset(odKey, 'modify_id', String(modify_id));
      await pOd.exec();
    } catch (e) {
      logger.warn('Failed to set MODIFY status in Redis for pending modify', { error: e.message, order_id });
    }

    // Register lifecycle id mapping in Python (fire-and-forget)
    if (modify_id) {
      try {
        const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
        axios.post(`${baseUrl}/api/orders/registry/lifecycle-id`, {
          order_id,
          new_id: modify_id,
          id_type: 'modify_id',
        }, { timeout: 5000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } })
          .then(() => { logger.info('Registered modify_id lifecycle mapping in Python', { order_id }); })
          .catch((eMap) => { logger.warn('Failed to register modify_id lifecycle mapping in Python', { error: eMap.message, order_id }); });
      } catch (e) { logger.warn('Unable to initiate modify_id lifecycle registration', { error: e.message, order_id }); }
    }

    // Dispatch to Python provider modify endpoint
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const payload = {
        order_id,
        modify_id,
        symbol,
        order_type,
        order_price,
        order_quantity,
        user_id,
        user_type,
      };
      axios.post(
        `${baseUrl}/api/orders/pending/modify`,
        payload,
        { timeout: 5000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      )
        .then(() => { logger.info('Dispatched provider pending modify', { order_id, symbol, order_type }); })
        .catch((ePy) => { logger.error('Python provider pending modify failed', { error: ePy.message, order_id }); });
    } catch (ePyOuter) {
      logger.warn('Unable to initiate provider pending modify call', { error: ePyOuter.message, order_id });
    }

    return res.status(202).json({ success: true, order_id, order_status: 'PENDING', status: 'MODIFY', modify_id, execution_mode: 'provider' });
  } catch (error) {
    logger.error('modifyPendingOrder internal error', { error: error.message, operationId });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function closeOrder(req, res) {
  const operationId = `close_order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'closeOrder',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed for close order' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const req_user_id = normalizeStr(body.user_id);
    const req_user_type = normalizeStr(body.user_type).toLowerCase();
    const provided_close_price = toNumber(body.close_price);
    const incomingStatus = normalizeStr(body.status || 'CLOSED');
    const incomingOrderStatus = normalizeStr(body.order_status || 'CLOSED');
    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!req_user_type || !['live', 'demo'].includes(req_user_type)) {
      return res.status(400).json({ success: false, message: 'user_type must be live or demo' });
    }
    if (!req_user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    if (tokenUserId && normalizeStr(req_user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot close orders for another user' });
    }
    if (!Number.isNaN(provided_close_price) && !(provided_close_price > 0)) {
      return res.status(400).json({ success: false, message: 'close_price must be greater than 0 when provided' });
    }

    // Load canonical order
    const canonical = await _getCanonicalOrder(order_id);
    let sqlRow = null;
    if (!canonical) {
      // Fallback to SQL
      const OrderModel = req_user_type === 'live' ? LiveUserOrder : DemoUserOrder;
      sqlRow = await OrderModel.findOne({ where: { order_id } });
      if (!sqlRow) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }
      // Basic ownership check with SQL row
      if (normalizeStr(sqlRow.order_user_id) !== normalizeStr(req_user_id)) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      // Must be currently OPEN
      const stRow = (sqlRow.order_status || '').toString().toUpperCase();
      if (stRow && stRow !== 'OPEN') {
        return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${stRow})` });
      }
      // Trading hours based on symbol and default group if canonical missing
      try {
        const sym = normalizeStr(sqlRow.symbol || sqlRow.order_company_name).toUpperCase();
        const gf = await groupsCache.getGroupFields('Standard', sym, ['type']);
        const gType = gf && gf.type != null ? gf.type : null;
        if (!_isMarketOpenByType(gType)) {
          return res.status(403).json({ success: false, message: 'Market is closed for this instrument' });
        }
      } catch (e) {
        logger.warn('GroupsCache trading-hours check failed (SQL fallback)', { error: e.message });
      }
    } else {
      // Ownership check using canonical
      if (normalizeStr(canonical.user_id) !== normalizeStr(req_user_id) || normalizeStr(canonical.user_type).toLowerCase() !== req_user_type) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      // Must be currently OPEN (engine/UI state). Do NOT use canonical.status here
      // because provider close flow may set status=CLOSED pre-ack for routing.
      const st = (canonical.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') {
        return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
      }
      // Trading hours check (if non-crypto, block weekends)
      const groupName = normalizeStr(canonical.group || 'Standard');
      const symbol = normalizeStr(canonical.symbol || canonical.order_company_name).toUpperCase();
      let gType = null;
      try {
        const gf = await groupsCache.getGroupFields(groupName, symbol, ['type']);
        gType = gf && gf.type != null ? gf.type : null;
      } catch (e) {
        logger.warn('GroupsCache getGroupFields failed for close check', { error: e.message, groupName, symbol });
      }
      if (!_isMarketOpenByType(gType)) {
        return res.status(403).json({ success: false, message: 'Market is closed for this instrument' });
      }
    }

    // Read triggers from canonical to decide cancel ids
    const symbol = (canonical && canonical.symbol)
      ? normalizeStr(canonical.symbol).toUpperCase()
      : (sqlRow ? normalizeStr(sqlRow.symbol || sqlRow.order_company_name).toUpperCase() : normalizeStr(body.symbol).toUpperCase());
    const order_type = (canonical && canonical.order_type)
      ? normalizeStr(canonical.order_type).toUpperCase()
      : (sqlRow ? normalizeStr(sqlRow.order_type).toUpperCase() : normalizeStr(body.order_type).toUpperCase());
    const willCancelTP = canonical
      ? (canonical.take_profit != null && Number(canonical.take_profit) > 0)
      : (sqlRow ? (sqlRow.take_profit != null && Number(sqlRow.take_profit) > 0) : false);
    const willCancelSL = canonical
      ? (canonical.stop_loss != null && Number(canonical.stop_loss) > 0)
      : (sqlRow ? (sqlRow.stop_loss != null && Number(sqlRow.stop_loss) > 0) : false);

    // Generate lifecycle ids
    const close_id = await idGenerator.generateCloseOrderId();
    const takeprofit_cancel_id = willCancelTP ? await idGenerator.generateTakeProfitCancelId() : undefined;
    const stoploss_cancel_id = willCancelSL ? await idGenerator.generateStopLossCancelId() : undefined;

    // Persist lifecycle ids into SQL row for traceability, and store incoming status field
    try {
      const OrderModel = req_user_type === 'live' ? LiveUserOrder : DemoUserOrder;
      // Reuse fetched sqlRow if available
      const rowToUpdate = sqlRow || await OrderModel.findOne({ where: { order_id } });
      if (rowToUpdate) {
        const idUpdates = { close_id };
        if (takeprofit_cancel_id) idUpdates.takeprofit_cancel_id = takeprofit_cancel_id;
        if (stoploss_cancel_id) idUpdates.stoploss_cancel_id = stoploss_cancel_id;
        idUpdates.status = incomingStatus; // persist whatever frontend sent as status
        await rowToUpdate.update(idUpdates);
      }
    } catch (e) {
      logger.warn('Failed to persist lifecycle ids before close', { order_id, error: e.message });
    }

    // Build payload to Python
    const pyPayload = {
      symbol,
      order_type,
      user_id: req_user_id,
      user_type: req_user_type,
      order_id,
      status: incomingStatus,
      order_status: incomingOrderStatus,
      close_id,
    };
    if (takeprofit_cancel_id) pyPayload.takeprofit_cancel_id = takeprofit_cancel_id;
    if (stoploss_cancel_id) pyPayload.stoploss_cancel_id = stoploss_cancel_id;
    if (!Number.isNaN(provided_close_price) && provided_close_price > 0) pyPayload.close_price = provided_close_price;
    if (body.idempotency_key) pyPayload.idempotency_key = normalizeStr(body.idempotency_key);

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    let pyResp;
    try {
      pyResp = await axios.post(
        `${baseUrl}/api/orders/close`,
        pyPayload,
        { timeout: 20000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      );
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      return res.status(statusCode).json({ success: false, order_id, reason: detail?.detail?.reason || detail?.reason || 'close_failed', error: detail?.detail || detail });
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow; // 'local' or 'provider'

    // If local flow, finalize DB immediately
    if (flow === 'local') {
      try {
        const OrderModel = req_user_type === 'live' ? LiveUserOrder : DemoUserOrder;
        const row = await OrderModel.findOne({ where: { order_id } });
        if (row) {
          const updateFields = {
            order_status: 'CLOSED',
          };
          if (result.close_price != null) updateFields.close_price = String(result.close_price);
          if (result.net_profit != null) updateFields.net_profit = String(result.net_profit);
          if (result.swap != null) updateFields.swap = String(result.swap);
          if (result.total_commission != null) updateFields.commission = String(result.total_commission);
          // Also persist incoming status string for historical trace
          updateFields.status = incomingStatus;
          await row.update(updateFields);

          // Apply wallet payout + user transactions (idempotent)
          try {
            const payoutKey = `close_payout_applied:${String(order_id)}`;
            const nx = await redisCluster.set(payoutKey, '1', 'EX', 7 * 24 * 3600, 'NX');
            if (nx) {
              await applyOrderClosePayout({
                userType: req_user_type,
                userId: parseInt(req_user_id, 10),
                orderPk: row?.id ?? null,
                orderIdStr: String(order_id),
                netProfit: Number(result.net_profit) || 0,
                commission: Number(result.total_commission) || 0,
                profitUsd: Number(result.profit_usd) || 0,
                swap: Number(result.swap) || 0,
                symbol,
                orderType: order_type,
              });
              try {
                portfolioEvents.emitUserUpdate(req_user_type, req_user_id, { type: 'wallet_balance_update', order_id });
              } catch (_) {}
            }
          } catch (e) {
            logger.warn('Failed to apply wallet payout on local close', { error: e.message, order_id });
          }

        }
      } catch (e) {
        logger.error('Failed to update SQL row after local close', { order_id, error: e.message });
      }

      // Update used margin mirror in SQL and emit portfolio events
      try {
        if (typeof result.used_margin_executed === 'number') {
          await updateUserUsedMargin({ userType: req_user_type, userId: parseInt(req_user_id, 10), usedMargin: result.used_margin_executed });
          try {
            portfolioEvents.emitUserUpdate(req_user_type, req_user_id, { type: 'user_margin_update', used_margin_usd: result.used_margin_executed });
          } catch (_) {}
        }
        try {
          portfolioEvents.emitUserUpdate(req_user_type, req_user_id, { type: 'order_update', order_id, update: { order_status: 'CLOSED' } });
        } catch (_) {}
      } catch (mErr) {
        logger.error('Failed to persist/emit margin updates after local close', { order_id, error: mErr.message });
      }

      // Increment user's aggregate net_profit with this close P/L
      try {
        if (typeof result.net_profit === 'number') {
          const UserModel = req_user_type === 'live' ? LiveUser : DemoUser;
          await UserModel.increment({ net_profit: result.net_profit }, { where: { id: parseInt(req_user_id, 10) } });
        }
      } catch (e) {
        logger.error('Failed to increment user net_profit after local close', { user_id: req_user_id, error: e.message });
      }
    } else {
      // provider flow: DB will be updated by worker_close via RabbitMQ; we already persisted lifecycle IDs
    }

    return res.status(200).json({ success: true, data: result, order_id });
  } catch (error) {
    logger.error('closeOrder internal error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function addStopLoss(req, res) {
  const operationId = `add_stoploss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'addStopLoss',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    // Basic auth checks
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const user_id = normalizeStr(body.user_id);
    const user_type = normalizeStr(body.user_type).toLowerCase();
    const symbolReq = normalizeStr(body.symbol).toUpperCase();
    const order_typeReq = normalizeStr(body.order_type).toUpperCase();
    const stop_loss = toNumber(body.stop_loss);
    const status = normalizeStr(body.status || 'STOPLOSS');
    const order_status_in = normalizeStr(body.order_status || 'OPEN');

    if (!order_id || !user_id || !user_type || !symbolReq || !['BUY', 'SELL'].includes(order_typeReq)) {
      return res.status(400).json({ success: false, message: 'Missing/invalid fields' });
    }
    if (!(stop_loss > 0)) {
      return res.status(400).json({ success: false, message: 'stop_loss must be > 0' });
    }
    if (tokenUserId && normalizeStr(user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot modify orders for another user' });
    }

    // Load canonical order; fallback to SQL
    const canonical = await _getCanonicalOrder(order_id);
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    let row = null;
    if (!canonical) {
      row = await OrderModel.findOne({ where: { order_id } });
      if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
      if (normalizeStr(row.order_user_id) !== normalizeStr(user_id)) return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      const st = (row.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    } else {
      if (normalizeStr(canonical.user_id) !== normalizeStr(user_id) || normalizeStr(canonical.user_type).toLowerCase() !== user_type) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      const st = (canonical.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    }

    const symbol = canonical ? normalizeStr(canonical.symbol || canonical.order_company_name).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();
    const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();
    let entry_price_num = toNumber(canonical ? canonical.order_price : row.order_price);
    const order_quantity_num = toNumber(canonical ? canonical.order_quantity : row.order_quantity);

    // Fallback: try user_holdings if canonical/SQL missing entry price
    if (!(entry_price_num > 0)) {
      try {
        const tag = `${user_type}:${user_id}`;
        const hkey = `user_holdings:{${tag}}:${order_id}`;
        const hold = await redisCluster.hgetall(hkey);
        const ep2 = toNumber(hold?.order_price);
        if (ep2 > 0) {
          entry_price_num = ep2;
        }
      } catch (e) {
        logger.warn('Fallback to user_holdings for entry price failed (SL)', { order_id, error: e.message });
      }
    }

    if (!(entry_price_num > 0)) {
      return res.status(400).json({ success: false, message: 'Invalid entry price' });
    }
    // Price logic: SL for BUY must be < entry; for SELL must be > entry
    if (order_type === 'BUY' && !(stop_loss < entry_price_num)) {
      return res.status(400).json({ success: false, message: 'For BUY, stop_loss must be less than entry price' });
    }
    if (order_type === 'SELL' && !(stop_loss > entry_price_num)) {
      return res.status(400).json({ success: false, message: 'For SELL, stop_loss must be greater than entry price' });
    }

    // Generate lifecycle id and persist to SQL for traceability
    const stoploss_id = await idGenerator.generateStopLossId();
    try {
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ stoploss_id, status });
      }
    } catch (e) {
      logger.warn('Failed to persist stoploss_id before send', { order_id, error: e.message });
    }
    // Build payload to Python
    const pyPayload = {
      order_id,
      symbol,
      user_id,
      user_type,
      order_type,
      order_price: entry_price_num,
      stoploss_id,
      stop_loss,
      status: 'STOPLOSS',
    };
    if (order_quantity_num > 0) pyPayload.order_quantity = order_quantity_num;
    if (order_status_in) pyPayload.order_status = order_status_in;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    let pyResp;
    try {
      pyResp = await axios.post(
        `${baseUrl}/api/orders/stoploss/add`,
        pyPayload,
        { timeout: 15000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      );
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      return res.status(statusCode).json({ success: false, order_id, reason: detail?.detail?.reason || detail?.reason || 'stoploss_failed', error: detail?.detail || detail });
    }

    const result = pyResp.data?.data || pyResp.data || {};

    // For local flow: persist to SQL immediately and notify websocket
    try {
      if (result && String(result.flow).toLowerCase() === 'local') {
        const OrderModelNow = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
        try {
          const rowNow = await OrderModelNow.findOne({ where: { order_id } });
          if (rowNow) {
            await rowNow.update({ stop_loss: String(stop_loss) });
          }
        } catch (e) {
          logger.warn('Failed to update SQL row for stoploss (local flow)', { order_id, error: e.message });
        }
        try {
          portfolioEvents.emitUserUpdate(user_type, user_id, {
            type: 'order_update',
            order_id,
            update: { stop_loss: String(stop_loss) },
            reason: 'local_stoploss_set',
          });
        } catch (e) {
          logger.warn('Failed to emit WS event after local stoploss set', { order_id, error: e.message });
        }
      }
    } catch (_) {}

    return res.status(200).json({ success: true, data: result, order_id, stoploss_id });
  } catch (error) {
    logger.error('addStopLoss internal error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function addTakeProfit(req, res) {
  const operationId = `add_takeprofit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'addTakeProfit',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const user_id = normalizeStr(body.user_id);
    const user_type = normalizeStr(body.user_type).toLowerCase();
    const symbolReq = normalizeStr(body.symbol).toUpperCase();
    const order_typeReq = normalizeStr(body.order_type).toUpperCase();
    const take_profit = toNumber(body.take_profit);
    const status = normalizeStr(body.status || 'TAKEPROFIT');
    const order_status_in = normalizeStr(body.order_status || 'OPEN');

    if (!order_id || !user_id || !user_type || !symbolReq || !['BUY', 'SELL'].includes(order_typeReq)) {
      return res.status(400).json({ success: false, message: 'Missing/invalid fields' });
    }
    if (!(take_profit > 0)) {
      return res.status(400).json({ success: false, message: 'take_profit must be > 0' });
    }
    if (tokenUserId && normalizeStr(user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot modify orders for another user' });
    }

    const canonical = await _getCanonicalOrder(order_id);
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    let row = null;
    if (!canonical) {
      row = await OrderModel.findOne({ where: { order_id } });
      if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
      if (normalizeStr(row.order_user_id) !== normalizeStr(user_id)) return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      const st = (row.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    } else {
      if (normalizeStr(canonical.user_id) !== normalizeStr(user_id) || normalizeStr(canonical.user_type).toLowerCase() !== user_type) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      const st = (canonical.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    }

    const symbol = canonical ? normalizeStr(canonical.symbol || canonical.order_company_name).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();
    const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();
    let entry_price_num = toNumber(canonical ? canonical.order_price : row.order_price);
    const order_quantity_num = toNumber(canonical ? canonical.order_quantity : row.order_quantity);

    // Fallback: try user_holdings if canonical/SQL missing entry price
    if (!(entry_price_num > 0)) {
      try {
        const tag = `${user_type}:${user_id}`;
        const hkey = `user_holdings:{${tag}}:${order_id}`;
        const hold = await redisCluster.hgetall(hkey);
        const ep2 = toNumber(hold?.order_price);
        if (ep2 > 0) {
          entry_price_num = ep2;
        }
      } catch (e) {
        logger.warn('Fallback to user_holdings for entry price failed (TP)', { order_id, error: e.message });
      }
    }

    if (!(entry_price_num > 0)) {
      return res.status(400).json({ success: false, message: 'Invalid entry price' });
    }
    // Price logic: TP for BUY must be > entry; for SELL must be < entry
    if (order_type === 'BUY' && !(take_profit > entry_price_num)) {
      return res.status(400).json({ success: false, message: 'For BUY, take_profit must be greater than entry price' });
    }
    if (order_type === 'SELL' && !(take_profit < entry_price_num)) {
      return res.status(400).json({ success: false, message: 'For SELL, take_profit must be less than entry price' });
    }

    const takeprofit_id = await idGenerator.generateTakeProfitId();
    try {
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ takeprofit_id, status });
      }
    } catch (e) {
      logger.warn('Failed to persist takeprofit_id before send', { order_id, error: e.message });
    }

    const pyPayload = {
      order_id,
      symbol,
      user_id,
      user_type,
      order_type,
      order_price: entry_price_num,
      takeprofit_id,
      take_profit,
      status: 'TAKEPROFIT',
    };
    if (order_quantity_num > 0) pyPayload.order_quantity = order_quantity_num;
    if (order_status_in) pyPayload.order_status = order_status_in;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    let pyResp;
    try {
      pyResp = await axios.post(
        `${baseUrl}/api/orders/takeprofit/add`,
        pyPayload,
        { timeout: 15000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      );
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      return res.status(statusCode).json({ success: false, order_id, reason: detail?.detail?.reason || detail?.reason || 'takeprofit_failed', error: detail?.detail || detail });
    }

    const result = pyResp.data?.data || pyResp.data || {};

    // For local flow: persist to SQL immediately and notify websocket
    try {
      if (result && String(result.flow).toLowerCase() === 'local') {
        const OrderModelNow = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
        try {
          const rowNow = await OrderModelNow.findOne({ where: { order_id } });
          if (rowNow) {
            await rowNow.update({ take_profit: String(take_profit) });
          }
        } catch (e) {
          logger.warn('Failed to update SQL row for takeprofit (local flow)', { order_id, error: e.message });
        }
        try {
          portfolioEvents.emitUserUpdate(user_type, user_id, {
            type: 'order_update',
            order_id,
            update: { take_profit: String(take_profit) },
            reason: 'local_takeprofit_set',
          });
        } catch (e) {
          logger.warn('Failed to emit WS event after local takeprofit set', { order_id, error: e.message });
        }
      }
    } catch (_) {}

    return res.status(200).json({ success: true, data: result, order_id, takeprofit_id });
  } catch (error) {
    logger.error('addTakeProfit internal error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function cancelStopLoss(req, res) {
  const operationId = `cancel_stoploss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'cancelStopLoss',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const user_id = normalizeStr(body.user_id);
    const user_type = normalizeStr(body.user_type).toLowerCase();
    const symbolReq = normalizeStr(body.symbol).toUpperCase();
    const order_typeReq = normalizeStr(body.order_type).toUpperCase();
    const statusIn = normalizeStr(body.status || 'STOPLOSS-CANCEL');
    const order_status_in = normalizeStr(body.order_status || 'OPEN');

    if (!order_id || !user_id || !user_type || !symbolReq || !['BUY', 'SELL'].includes(order_typeReq)) {
      return res.status(400).json({ success: false, message: 'Missing/invalid fields' });
    }
    if (tokenUserId && normalizeStr(user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot modify orders for another user' });
    }

    // Avoid cancel while close is processing or already finalized
    try {
      const proc = await redisCluster.get(`close_processing:${order_id}`);
      const fin = await redisCluster.get(`close_finalized:${order_id}`);
      if (proc || fin) {
        return res.status(409).json({ success: false, message: 'Order is closing/closed; cannot cancel stoploss' });
      }
    } catch (_) {}

    // Load canonical order; fallback to SQL
    const canonical = await _getCanonicalOrder(order_id);
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    let row = null;
    if (!canonical) {
      row = await OrderModel.findOne({ where: { order_id } });
      if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
      if (normalizeStr(row.order_user_id) !== normalizeStr(user_id)) return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      const st = (row.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    } else {
      if (normalizeStr(canonical.user_id) !== normalizeStr(user_id) || normalizeStr(canonical.user_type).toLowerCase() !== user_type) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      const st = (canonical.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    }

    const symbol = canonical ? normalizeStr(canonical.symbol || canonical.order_company_name).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();
    const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

    // Validate an active SL exists (DB or Redis canonical/holdings/triggers)
    let hasSL = false;
    // 1) SQL row
    if (row && row.stop_loss != null && Number(row.stop_loss) > 0) {
      hasSL = true;
    }
    // 2) Canonical Redis order_data
    if (!hasSL && canonical && canonical.stop_loss != null && Number(canonical.stop_loss) > 0) {
      hasSL = true;
    }
    // 3) User holdings (WS source of truth)
    if (!hasSL) {
      try {
        const tag = `${user_type}:${user_id}`;
        const hkey = `user_holdings:{${tag}}:${order_id}`;
        const hold = await redisCluster.hgetall(hkey);
        const slNum = hold && hold.stop_loss != null ? Number(hold.stop_loss) : NaN;
        if (!Number.isNaN(slNum) && slNum > 0) hasSL = true;
      } catch (e) {
        logger.warn('Fallback to user_holdings for SL cancel check failed', { error: e.message, order_id });
      }
    }
    // 4) Local trigger store
    if (!hasSL) {
      try {
        const trig = await redisCluster.hgetall(`order_triggers:${order_id}`);
        if (trig && (trig.stop_loss || trig.stop_loss_compare || trig.stop_loss_user)) hasSL = true;
      } catch (_) {}
    }
    if (!hasSL) {
      return res.status(409).json({ success: false, message: 'No active stoploss to cancel' });
    }

    // Determine sending flow to decide provider vs local behavior
    let sendingOrders = 'rock';
    try {
      const userCfg = await redisUserCache.getUser(user_type, parseInt(user_id, 10));
      if (userCfg && userCfg.sending_orders) {
        sendingOrders = String(userCfg.sending_orders).toLowerCase();
      }
    } catch (e) {
      logger.warn('Failed to fetch user config from cache', { error: e.message, user_type, user_id });
    }

    // Resolve stoploss_id from SQL or Redis canonical
    let resolvedStoplossId = normalizeStr(row?.stoploss_id);
    if (!resolvedStoplossId) {
      try {
        const fromRedis = await redisCluster.hget(`order_data:${order_id}`, 'stoploss_id');
        if (fromRedis) resolvedStoplossId = normalizeStr(fromRedis);
      } catch (_) {}
    }
    if (!resolvedStoplossId) {
      if (sendingOrders === 'barclays') {
        return res.status(409).json({ success: false, message: 'No stoploss_id found for provider cancel' });
      }
      // For local flow, a placeholder is acceptable (Python ignores it for local cancel flow)
      resolvedStoplossId = `SL-${order_id}`;
    }

    // Generate cancel id and persist to SQL
    const stoploss_cancel_id = await idGenerator.generateStopLossCancelId();
    try {
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ stoploss_cancel_id, status: statusIn });
      }
    } catch (e) {
      logger.warn('Failed to persist stoploss_cancel_id before send', { order_id, error: e.message });
    }

    // Build payload to Python
    const pyPayload = {
      order_id,
      symbol,
      user_id,
      user_type,
      order_type,
      status: 'STOPLOSS-CANCEL',
      order_status: order_status_in,
      stoploss_id: resolvedStoplossId,
      stoploss_cancel_id,
    };

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    let pyResp;
    try {
      pyResp = await axios.post(
        `${baseUrl}/api/orders/stoploss/cancel`,
        pyPayload,
        { timeout: 15000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      );
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      return res.status(statusCode).json({ success: false, order_id, reason: detail?.detail?.reason || detail?.reason || 'stoploss_cancel_failed', error: detail?.detail || detail });
    }

    const result = pyResp.data?.data || pyResp.data || {};

    // Local flow: immediately nullify SQL and notify websocket
    try {
      if (result && String(result.flow).toLowerCase() === 'local') {
        const OrderModelNow = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
        try {
          const rowNow = await OrderModelNow.findOne({ where: { order_id } });
          if (rowNow) {
            await rowNow.update({ stop_loss: null });
          }
        } catch (e) {
          logger.warn('Failed to update SQL row for stoploss cancel (local flow)', { order_id, error: e.message });
        }
        try {
          portfolioEvents.emitUserUpdate(user_type, user_id, { type: 'order_update', order_id, update: { stop_loss: null }, reason: 'local_stoploss_cancel' });
        } catch (e) {
          logger.warn('Failed to emit WS event after local stoploss cancel', { order_id, error: e.message });
        }
      }
    } catch (_) {}

    return res.status(200).json({ success: true, data: result, order_id, stoploss_cancel_id });
  } catch (error) {
    logger.error('cancelStopLoss internal error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function cancelTakeProfit(req, res) {
  const operationId = `cancel_takeprofit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (fire-and-forget)
    orderReqLogger.logOrderRequest({
      endpoint: 'cancelTakeProfit',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') {
      return res.status(403).json({ success: false, message: 'User role not allowed' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }

    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const user_id = normalizeStr(body.user_id);
    const user_type = normalizeStr(body.user_type).toLowerCase();
    const symbolReq = normalizeStr(body.symbol).toUpperCase();
    const order_typeReq = normalizeStr(body.order_type).toUpperCase();
    const statusIn = normalizeStr(body.status || 'TAKEPROFIT-CANCEL');
    const order_status_in = normalizeStr(body.order_status || 'OPEN');

    if (!order_id || !user_id || !user_type || !symbolReq || !['BUY', 'SELL'].includes(order_typeReq)) {
      return res.status(400).json({ success: false, message: 'Missing/invalid fields' });
    }
    if (tokenUserId && normalizeStr(user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot modify orders for another user' });
    }

    // Avoid cancel while close is processing or already finalized
    try {
      const proc = await redisCluster.get(`close_processing:${order_id}`);
      const fin = await redisCluster.get(`close_finalized:${order_id}`);
      if (proc || fin) {
        return res.status(409).json({ success: false, message: 'Order is closing/closed; cannot cancel takeprofit' });
      }
    } catch (_) {}

    // Load canonical order; fallback to SQL
    const canonical = await _getCanonicalOrder(order_id);
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    let row = null;
    if (!canonical) {
      row = await OrderModel.findOne({ where: { order_id } });
      if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
      if (normalizeStr(row.order_user_id) !== normalizeStr(user_id)) return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      const st = (row.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    } else {
      if (normalizeStr(canonical.user_id) !== normalizeStr(user_id) || normalizeStr(canonical.user_type).toLowerCase() !== user_type) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      const st = (canonical.order_status || '').toString().toUpperCase();
      if (st && st !== 'OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${st})` });
    }

    const symbol = canonical ? normalizeStr(canonical.symbol || canonical.order_company_name).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();
    const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

    // Validate an active TP exists (DB or Redis canonical/holdings/triggers)
    let hasTP = false;
    // 1) SQL row
    if (row && row.take_profit != null && Number(row.take_profit) > 0) {
      hasTP = true;
    }
    // 2) Canonical Redis order_data
    if (!hasTP && canonical && canonical.take_profit != null && Number(canonical.take_profit) > 0) {
      hasTP = true;
    }
    // 3) User holdings (WS source of truth)
    if (!hasTP) {
      try {
        const tag = `${user_type}:${user_id}`;
        const hkey = `user_holdings:{${tag}}:${order_id}`;
        const hold = await redisCluster.hgetall(hkey);
        const tpNum = hold && hold.take_profit != null ? Number(hold.take_profit) : NaN;
        if (!Number.isNaN(tpNum) && tpNum > 0) hasTP = true;
      } catch (e) {
        logger.warn('Fallback to user_holdings for TP cancel check failed', { error: e.message, order_id });
      }
    }
    // 4) Local trigger store
    if (!hasTP) {
      try {
        const trig = await redisCluster.hgetall(`order_triggers:${order_id}`);
        if (trig && (trig.take_profit || trig.take_profit_compare || trig.take_profit_user)) hasTP = true;
      } catch (_) {}
    }
    if (!hasTP) {
      return res.status(409).json({ success: false, message: 'No active takeprofit to cancel' });
    }

    // Determine sending flow
    let sendingOrders = 'rock';
    try {
      const userCfg = await redisUserCache.getUser(user_type, parseInt(user_id, 10));
      if (userCfg && userCfg.sending_orders) {
        sendingOrders = String(userCfg.sending_orders).toLowerCase();
      }
    } catch (e) {
      logger.warn('Failed to fetch user config from cache', { error: e.message, user_type, user_id });
    }

    // Resolve takeprofit_id from SQL or Redis canonical
    let resolvedTakeprofitId = normalizeStr(row?.takeprofit_id);
    if (!resolvedTakeprofitId) {
      try {
        const fromRedis = await redisCluster.hget(`order_data:${order_id}`, 'takeprofit_id');
        if (fromRedis) resolvedTakeprofitId = normalizeStr(fromRedis);
      } catch (_) {}
    }
    if (!resolvedTakeprofitId) {
      if (sendingOrders === 'barclays') {
        return res.status(409).json({ success: false, message: 'No takeprofit_id found for provider cancel' });
      }
      // For local flow, a placeholder is acceptable (Python ignores it for local cancel flow)
      resolvedTakeprofitId = `TP-${order_id}`;
    }

    // Generate cancel id and persist to SQL
    const takeprofit_cancel_id = await idGenerator.generateTakeProfitCancelId();
    try {
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ takeprofit_cancel_id, status: statusIn });
      }
    } catch (e) {
      logger.warn('Failed to persist takeprofit_cancel_id before send', { order_id, error: e.message });
    }

    // Build payload to Python
    const pyPayload = {
      order_id,
      symbol,
      user_id,
      user_type,
      order_type,
      status: 'TAKEPROFIT-CANCEL',
      order_status: order_status_in,
      takeprofit_id: resolvedTakeprofitId,
      takeprofit_cancel_id,
    };

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    let pyResp;
    try {
      pyResp = await axios.post(
        `${baseUrl}/api/orders/takeprofit/cancel`,
        pyPayload,
        { timeout: 15000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      );
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      return res.status(statusCode).json({ success: false, order_id, reason: detail?.detail?.reason || detail?.reason || 'takeprofit_cancel_failed', error: detail?.detail || detail });
    }

    const result = pyResp.data?.data || pyResp.data || {};

    // Local flow: immediately nullify SQL and notify WS
    try {
      if (result && String(result.flow).toLowerCase() === 'local') {
        const OrderModelNow = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
        try {
          const rowNow = await OrderModelNow.findOne({ where: { order_id } });
          if (rowNow) {
            await rowNow.update({ take_profit: null });
          }
        } catch (e) {
          logger.warn('Failed to update SQL row for takeprofit cancel (local flow)', { order_id, error: e.message });
        }
        try {
          portfolioEvents.emitUserUpdate(user_type, user_id, { type: 'order_update', order_id, update: { take_profit: null }, reason: 'local_takeprofit_cancel' });
        } catch (e) {
          logger.warn('Failed to emit WS event after local takeprofit cancel', { order_id, error: e.message });
        }
      }
    } catch (_) {}

    return res.status(200).json({ success: true, data: result, order_id, takeprofit_cancel_id });
  } catch (error) {
    logger.error('cancelTakeProfit internal error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

async function cancelPendingOrder(req, res) {
  const operationId = `pending_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    orderReqLogger.logOrderRequest({ endpoint: 'cancelPendingOrder', operationId, method: req.method, path: req.originalUrl || req.url, ip: req.ip, user: req.user, headers: req.headers, body: req.body }).catch(() => {});
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const isSelfTrading = user.is_self_trading;
    const userStatus = user.status;

    if (role && role !== 'trader') return res.status(403).json({ success: false, message: 'User role not allowed for pending cancel' });
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1') return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    if (userStatus !== undefined && String(userStatus) === '0') return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });

    const body = req.body || {};
    const order_id = normalizeStr(body.order_id);
    const user_id = normalizeStr(body.user_id);
    const user_type = normalizeStr(body.user_type).toLowerCase();
    const symbolReq = normalizeStr(body.symbol).toUpperCase();
    const order_type_req = normalizeStr(body.order_type).toUpperCase();
    const cancel_message = normalizeStr(body.cancel_message || 'User cancelled pending order');
    if (!order_id || !user_id || !user_type || !symbolReq || !['BUY_LIMIT','SELL_LIMIT','BUY_STOP','SELL_STOP'].includes(order_type_req)) {
      return res.status(400).json({ success: false, message: 'Missing/invalid fields' });
    }
    if (tokenUserId && normalizeStr(user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot cancel orders for another user' });
    }
    if (!['live','demo'].includes(user_type)) {
      return res.status(400).json({ success: false, message: 'user_type must be live or demo' });
    }

    const canonical = await _getCanonicalOrder(order_id);
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    let row = null;
    if (!canonical) {
      row = await OrderModel.findOne({ where: { order_id } });
      if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
      if (normalizeStr(row.order_user_id) !== normalizeStr(user_id)) return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      const st = (row.order_status || '').toString().toUpperCase();
      if (!['PENDING','PENDING-QUEUED','PENDING-CANCEL'].includes(st)) return res.status(409).json({ success: false, message: `Order is not pending (current: ${st})` });
    } else {
      if (normalizeStr(canonical.user_id) !== normalizeStr(user_id) || normalizeStr(canonical.user_type).toLowerCase() !== user_type) {
        return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      }
      const st = (canonical.order_status || '').toString().toUpperCase();
      if (!['PENDING','PENDING-QUEUED','PENDING-CANCEL'].includes(st)) return res.status(409).json({ success: false, message: `Order is not pending (current: ${st})` });
    }

    const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();
    const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

    // Flow determination
    let isProviderFlow = false;
    try {
      const ucfg = await redisCluster.hgetall(`user:{${user_type}:${user_id}}:config`);
      const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = (so === 'barclays');
    } catch (_) { isProviderFlow = false; }

    // Frontend-intended engine status to persist (do not touch SQL order_status here)
    const statusReq = normalizeStr(body.status || 'PENDING-CANCEL').toUpperCase();

    if (!isProviderFlow) {
      // Local finalize
      try {
        await redisCluster.zrem(`pending_index:{${symbol}}:${order_type}`, order_id);
        await redisCluster.delete(`pending_orders:${order_id}`);
      } catch (e) { logger.warn('Failed to remove from pending ZSET/HASH', { error: e.message, order_id }); }
      try {
        const tag = `${user_type}:${user_id}`;
        const idx = `user_orders_index:{${tag}}`;
        const h = `user_holdings:{${tag}}:${order_id}`;
        // Use pipeline only for same-slot keys (idx, h)
        const p1 = redisCluster.pipeline();
        p1.srem(idx, order_id);
        p1.delete(h);
        await p1.exec();
        // Delete canonical separately to avoid cross-slot pipeline error
        try { await redisCluster.delete(`order_data:${order_id}`); } catch (eDel) {
          logger.warn('Failed to delete order_data for pending cancel', { error: eDel.message, order_id });
        }
      } catch (e2) { logger.warn('Failed to remove holdings/index for pending cancel', { error: e2.message, order_id }); }
      try {
        const rowNow = await OrderModel.findOne({ where: { order_id } });
        if (rowNow) await rowNow.update({ order_status: 'CANCELLED', close_message: cancel_message });
      } catch (e3) { logger.warn('SQL update failed for pending cancel', { error: e3.message, order_id }); }
      try { portfolioEvents.emitUserUpdate(user_type, user_id, { type: 'order_update', order_id, update: { order_status: 'CANCELLED' }, reason: 'local_pending_cancel' }); } catch (_) {}
      return res.status(200).json({ success: true, order_id, order_status: 'CANCELLED' });
    }

    // Provider path
    let cancel_id = null;
    try { cancel_id = await idGenerator.generateCancelOrderId(); } catch (e) { logger.warn('Failed to generate cancel_id', { error: e.message, order_id }); }
    if (!cancel_id) return res.status(500).json({ success: false, message: 'Failed to generate cancel id' });
    try {
      const rowNow = await OrderModel.findOne({ where: { order_id } });
      if (rowNow) await rowNow.update({ cancel_id, status: statusReq });
    } catch (e) { logger.warn('Failed to persist cancel_id', { error: e.message, order_id }); }
    try {
      const tag = `${user_type}:${user_id}`;
      const h = `user_holdings:{${tag}}:${order_id}`;
      const od = `order_data:${order_id}`;
      // Avoid cross-slot pipelines in Redis Cluster: perform per-key writes
      try { await redisCluster.hset(h, 'cancel_id', String(cancel_id)); } catch (e1) { logger.warn('HSET cancel_id failed on user_holdings', { error: e1.message, order_id }); }
      try { await redisCluster.hset(od, 'cancel_id', String(cancel_id)); } catch (e2) { logger.warn('HSET cancel_id failed on order_data', { error: e2.message, order_id }); }
      // Mirror engine-intended status for dispatcher routing (do not touch order_status here)
      try { await redisCluster.hset(h, 'status', statusReq); } catch (e3) { logger.warn('HSET status failed on user_holdings', { error: e3.message, order_id }); }
      try { await redisCluster.hset(od, 'status', statusReq); } catch (e4) { logger.warn('HSET status failed on order_data', { error: e4.message, order_id }); }
    } catch (e) { logger.warn('Failed to mirror cancel status in Redis', { error: e.message, order_id }); }
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      axios.post(
        `${baseUrl}/api/orders/registry/lifecycle-id`,
        { order_id, new_id: cancel_id, id_type: 'cancel_id' },
        { timeout: 5000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      ).catch(() => {});
    } catch (_) {}
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const pyPayload = { order_id, cancel_id, order_type, user_id, user_type, status: 'CANCELLED' };
      axios.post(
        `${baseUrl}/api/orders/pending/cancel`,
        pyPayload,
        { timeout: 5000, headers: { 'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub' } }
      ).then(() => {
        logger.info('Dispatched provider pending cancel', { order_id, cancel_id, order_type });
      }).catch((ePy) => { logger.error('Python pending cancel failed', { error: ePy.message, order_id }); });
    } catch (_) {}
    return res.status(202).json({ success: true, order_id, order_status: 'PENDING-CANCEL', cancel_id });
  } catch (error) {
    logger.error('cancelPendingOrder internal error', { error: error.message, operationId });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

module.exports = { placeInstantOrder, placePendingOrder, closeOrder, addStopLoss, addTakeProfit, cancelStopLoss, cancelTakeProfit, cancelPendingOrder, modifyPendingOrder };
