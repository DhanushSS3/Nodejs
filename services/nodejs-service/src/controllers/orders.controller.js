const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../services/logger.service');
const orderReqLogger = require('../services/order.request.logger');
const timingLogger = require('../services/perf.timing.logger');
const idGenerator = require('../services/idGenerator.service');
const orderLifecycleService = require('../services/orderLifecycle.service');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const { updateUserUsedMargin } = require('../services/user.margin.service');
const { acquireUserLock, releaseUserLock } = require('../services/userLock.service');
const portfolioEvents = require('../services/events/portfolio.events');
const { redisCluster } = require('../../config/redis');
const groupsCache = require('../services/groups.cache.service');
const redisUserCache = require('../services/redis.user.cache.service');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const { applyOrderClosePayout } = require('../services/order.payout.service');
const lotValidationService = require('../services/lot.validation.service');
const { resolveOpenOrder } = require('../services/order.resolver.service');

// Create reusable axios instance with HTTP keep-alive for Python service calls
const pythonServiceAxios = axios.create({
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub'
  },
  httpAgent: new http.Agent({ 
    keepAlive: true,
    keepAliveMsecs: 30000,  // Keep connections alive for 30 seconds
    maxSockets: 50,         // Max concurrent connections per host
    maxFreeSockets: 10      // Max idle connections to keep open
  }),
  httpsAgent: new https.Agent({ 
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10
  })
});

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
  let userLock;
  try {
    // Timing start
    const t0 = process.hrtime.bigint();
    const marks = {};
    const mark = (name) => { try { marks[name] = process.hrtime.bigint(); } catch (_) {} };
    const msBetween = (a, b) => Number((b - a) / 1000000n);

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
    const userGroup = user && user.group ? String(user.group) : 'Standard';

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

    // Validate lot size against group constraints
    const lotValidation = await lotValidationService.validateLotSize(userGroup, parsed.symbol, parsed.order_quantity);
    if (!lotValidation.valid) {
      return res.status(400).json({
        success: false,
        message: lotValidation.message,
        lot_constraints: {
          provided_lot: lotValidation.lotSize,
          min_lot: lotValidation.minLot,
          max_lot: lotValidation.maxLot,
          user_group: userGroup,
          symbol: parsed.symbol
        }
      });
    }
    // Trading hours check for non-crypto instruments (Mon-Fri only, UTC). Crypto (type=4) always open
    try {
      const gf = await groupsCache.getGroupFields(userGroup, parsed.symbol, ['type']);
      const gType = gf && gf.type != null ? gf.type : null;
      if (!_isMarketOpenByType(gType)) {
        return res.status(403).json({ success: false, message: 'Market is closed for this instrument' });
      }
    } catch (e) {
      // If groups lookup fails, proceed; do not hard-block
    }
    mark('after_validate');

    // Ensure user places orders only for themselves (if token has id)
    if (tokenUserId && normalizeStr(parsed.user_id) !== normalizeStr(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Cannot place orders for another user' });
    }

    // Acquire per-user lock to serialize order operations
    logger.debug('Attempting to acquire user lock for placement', {
      userType: parsed.user_type,
      userId: parsed.user_id,
      operationId
    });
    userLock = await acquireUserLock(parsed.user_type, parsed.user_id);
    if (!userLock) {
      return res.status(409).json({
        success: false,
        message: 'Another order action is in progress for this user. Please retry shortly.'
      });
    }

    // Generate order_id in ord_YYYYMMDD_seq format using IdGeneratorService
    const order_id = await idGenerator.generateOrderId();
    mark('after_id_generated');
    const hasIdempotency = !!req.body.idempotency_key;
    
    // Store main order_id in lifecycle service
    try {
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'order_id', 
        order_id, 
        `Order placed - ${parsed.order_type} ${parsed.symbol} @ ${parsed.order_price}`
      );
    } catch (lifecycleErr) {
      logger.warn('Failed to store order_id in lifecycle service', { 
        order_id, error: lifecycleErr.message 
      });
    }

    // Persist initial order (QUEUED) unless request is idempotent
    let OrderModel;
    if (parsed.user_type === 'live') {
      OrderModel = LiveUserOrder;
    } else if (parsed.user_type === 'demo') {
      OrderModel = DemoUserOrder;
    } else if (parsed.user_type === 'strategy_provider') {
      const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
      OrderModel = StrategyProviderOrder;
    } else if (parsed.user_type === 'copy_follower') {
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      OrderModel = CopyFollowerOrder;
    } else {
      return res.status(400).json({ success: false, message: 'Invalid user_type', operationId });
    }
    let initialOrder;
    if (!hasIdempotency) {
      try {
        mark('before_db_preinsert'); // Add timing mark before DB operation
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
        mark('after_db_preinsert');
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
    let pyReqStarted = false;
    try {
      mark('py_req_start');
      pyReqStarted = true;
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/instant/execute`,
        pyPayload
      );
      mark('py_req_end');
    } catch (err) {
      // Python returned error (4xx/5xx)
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      if (pyReqStarted) mark('py_req_end');

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
        try {
          const tEnd = process.hrtime.bigint();
          const durations = {
            total_ms: msBetween(t0, tEnd),
            validate_ms: marks.after_validate ? msBetween(t0, marks.after_validate) : undefined,
            id_generate_ms: marks.after_id_generated ? msBetween(marks.after_validate || t0, marks.after_id_generated) : undefined,
            db_preinsert_ms: marks.after_db_preinsert ? msBetween(marks.after_id_generated || t0, marks.after_db_preinsert) : undefined,
            py_roundtrip_ms: (marks.py_req_start && marks.py_req_end) ? msBetween(marks.py_req_start, marks.py_req_end) : undefined,
          };
          await timingLogger.logTiming({
            endpoint: 'placeInstantOrder',
            operationId,
            order_id,
            status: 'error_conflict',
            py_status: statusCode,
            py_reason: detail?.detail?.reason || detail?.reason,
            durations_ms: durations,
          });
        } catch (_) {}
        return res.status(409).json({
          success: false,
          order_id,
          reason: detail?.detail?.reason || detail?.reason || 'conflict',
        });
      }

      try {
        const tEnd = process.hrtime.bigint();
        const durations = {
          total_ms: msBetween(t0, tEnd),
          validate_ms: marks.after_validate ? msBetween(t0, marks.after_validate) : undefined,
          id_generate_ms: marks.after_id_generated ? msBetween(marks.after_validate || t0, marks.after_id_generated) : undefined,
          db_preinsert_ms: marks.after_db_preinsert ? msBetween(marks.after_id_generated || t0, marks.after_db_preinsert) : undefined,
          py_roundtrip_ms: (marks.py_req_start && marks.py_req_end) ? msBetween(marks.py_req_start, marks.py_req_end) : undefined,
        };
        await timingLogger.logTiming({
          endpoint: 'placeInstantOrder',
          operationId,
          order_id,
          status: 'error',
          py_status: statusCode,
          py_reason: detail?.detail?.reason || detail?.reason,
          durations_ms: durations,
        });
      } catch (_) {}
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
    mark('after_db_post_success');

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
    mark('after_user_margin');

    // Build frontend response
    try {
      const tEnd = process.hrtime.bigint();
      const durations = {
        total_ms: msBetween(t0, tEnd),
        validate_ms: marks.after_validate ? msBetween(t0, marks.after_validate) : undefined,
        id_generate_ms: marks.after_id_generated ? msBetween(marks.after_validate || t0, marks.after_id_generated) : undefined,
        db_preinsert_ms: (marks.before_db_preinsert && marks.after_db_preinsert) ? msBetween(marks.before_db_preinsert, marks.after_db_preinsert) : undefined,
        py_roundtrip_ms: (marks.py_req_start && marks.py_req_end) ? msBetween(marks.py_req_start, marks.py_req_end) : undefined,
        db_post_success_ms: marks.after_db_post_success ? msBetween(marks.py_req_end || marks.after_id_generated || t0, marks.after_db_post_success) : undefined,
        user_margin_ms: marks.after_user_margin ? msBetween(marks.after_db_post_success || marks.py_req_end || t0, marks.after_user_margin) : undefined,
      };
      // Fire-and-forget timing log to avoid tail latency
      timingLogger.logTiming({
        endpoint: 'placeInstantOrder',
        operationId,
        order_id: finalOrderId,
        status: 'success',
        flow,
        durations_ms: durations,
      }).catch(() => {}); // Ignore logging errors
    } catch (_) {}
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
  } finally {
    if (userLock) {
      logger.debug('Releasing user lock for placement', {
        lockKey: userLock.lockKey,
        userType: userLock.userType,
        userId: userLock.userId,
        operationId
      });
      await releaseUserLock(userLock);
    }
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

    // Validate lot size against group constraints
    const lotValidation = await lotValidationService.validateLotSize(userGroup, parsed.symbol, parsed.order_quantity);
    if (!lotValidation.valid) {
      return res.status(400).json({
        success: false,
        message: lotValidation.message,
        lot_constraints: {
          provided_lot: lotValidation.lotSize,
          min_lot: lotValidation.minLot,
          max_lot: lotValidation.maxLot,
          user_group: userGroup,
          symbol: parsed.symbol
        }
      });
    }
    // Trading hours check for non-crypto instruments (Mon-Fri only, UTC). Crypto (type=4) always open
    try {
      const gf = await groupsCache.getGroupFields(userGroup, String(parsed.symbol).toUpperCase(), ['type']);
      const gType = gf && gf.type != null ? gf.type : null;
      if (!_isMarketOpenByType(gType)) {
        return res.status(403).json({ success: false, message: 'Market is closed for this instrument' });
      }
    } catch (e) {
      // If groups lookup fails, proceed; do not hard-block
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
    // Accepting orders even if bid/ask price is missing or stale for flexibility; see Oct 2025 requirement.
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
    // Defensive: We still block nonsensical placement if compare_price <= 0 (math/preparation error)
    if (!(compare_price > 0)) {
      return res.status(400).json({ success: false, message: 'Computed compare_price invalid (order price or config error)' });
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
        // NOTE: No longer generate cancel_id during order placement for provider flow
        // cancel_id will be generated only when actually needed for cancellation by provider_pending_monitor
        // Call Python to place provider pending order (Python will half-spread adjust before sending)
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
  } finally {
    if (userLock) {
      await releaseUserLock(userLock);
    }
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

async function _getValidCanonicalOrFallback(order_id, user_type) {
  const canonical = await _getCanonicalOrder(order_id);
  
  // Check if canonical data is incomplete (missing ids or essential fields)
  const isCanonicalIncomplete = canonical && (
    !canonical.user_id ||
    !canonical.user_type ||
    !(canonical.symbol || canonical.order_company_name) ||
    !canonical.order_type ||
    !(toNumber(canonical.order_price) > 0)
  );
  
  if (isCanonicalIncomplete) {
    logger.warn('🔧 CANONICAL_INCOMPLETE_FALLBACK_TO_SQL', {
      order_id,
      canonical_user_id: canonical.user_id,
      canonical_user_type: canonical.user_type,
      reason: 'Incomplete canonical data, falling back to SQL'
    });
  }
  
  return {
    canonical: (!canonical || isCanonicalIncomplete) ? null : canonical,
    shouldFallbackToSQL: !canonical || isCanonicalIncomplete
  };
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
          order_quantity: String(order_quantity),
          updated_at: Date.now().toString(),
        });
        // Mirror to user holdings (same-slot pipeline)
        try {
          const tag = `${user_type}:${user_id}`;
          const orderKey = `user_holdings:{${tag}}:${order_id}`;
          const pUser = redisCluster.pipeline();
          pUser.hset(orderKey, 'order_price', String(order_price));
          pUser.hset(orderKey, 'order_quantity', String(order_quantity));
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
          pOd.hset(odKey, 'order_quantity', String(order_quantity));
          pOd.hset(odKey, 'status', 'PENDING');
          await pOd.exec();
        } catch (e) { logger.warn('Failed to update canonical for pending modify', { error: e.message, order_id }); }
      } catch (e) {
        logger.error('Failed to update Redis for pending modify', { error: e.message, order_id, zkey });
        return res.status(500).json({ success: false, message: 'Cache error', operationId });
      }

      // Publish symbol for any monitoring recalculation
      try { await redisCluster.publish('market_price_updates', symbol); } catch (_) {}

      // Persist SQL order_price BEFORE emitting WS event so snapshot reflects new price immediately
      try {
        await OrderModel.update({ order_price: order_price, order_quantity: order_quantity }, { where: { order_id } });
      } catch (dbErr) {
        logger.warn('SQL update failed for pending modify', { error: dbErr.message, order_id });
      }

      // Emit WS event after SQL update; portfolio.ws will force-fetch pending from DB on PENDING updates
      try {
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'order_update',
          order_id,
          update: { order_status: 'PENDING', order_price: String(order_price), order_quantity: String(order_quantity) },
          reason: 'pending_modified',
        });
      } catch (_) {}

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
        pending_modify_quantity_user: String(order_quantity),
      });
      // Separate slot updates
      const pOd = redisCluster.pipeline();
      pOd.hset(odKey, 'status', 'MODIFY');
      pOd.hset(odKey, 'pending_modify_price_user', String(order_price));
      pOd.hset(odKey, 'pending_modify_quantity_user', String(order_quantity));
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
  let userLock;
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

    const body = req.body || {};
    const req_user_type = normalizeStr(body.user_type).toLowerCase();

    // Allow internal copy trading calls (no JWT token) and trader role
    const isInternalAuth = req.headers['x-internal-auth'];
    const isCopyTradingCall = req_user_type === 'copy_follower' || req_user_type === 'strategy_provider';
    
    if (role && role !== 'trader' && !isInternalAuth && !isCopyTradingCall) {
      return res.status(403).json({ success: false, message: 'User role not allowed for close order' });
    }
    if (isSelfTrading !== undefined && String(isSelfTrading) !== '1' && !isInternalAuth && !isCopyTradingCall) {
      return res.status(403).json({ success: false, message: 'Self trading is disabled for this user' });
    }
    if (userStatus !== undefined && String(userStatus) === '0' && !isInternalAuth && !isCopyTradingCall) {
      return res.status(403).json({ success: false, message: 'User status is not allowed to trade' });
    }
    const order_id = normalizeStr(body.order_id);
    const req_user_id = normalizeStr(body.user_id);
    const provided_close_price = toNumber(body.close_price);
    const incomingStatus = normalizeStr(body.status || 'CLOSED');
    const incomingOrderStatus = normalizeStr(body.order_status || 'CLOSED');
    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!req_user_type || !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(req_user_type)) {
      return res.status(400).json({ success: false, message: 'user_type must be live, demo, strategy_provider, or copy_follower' });
    }
    if (!req_user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    if (tokenUserId && normalizeStr(req_user_id) !== normalizeStr(tokenUserId) && !isInternalAuth) {
      return res.status(403).json({ success: false, message: 'Cannot close orders for another user' });
    }
    if (!Number.isNaN(provided_close_price) && !(provided_close_price > 0)) {
      return res.status(400).json({ success: false, message: 'close_price must be greater than 0 when provided' });
    }

    // Acquire per-user lock to ensure serialized closes
    userLock = await acquireUserLock(req_user_type, req_user_id);
    if (!userLock) {
      return res.status(409).json({
        success: false,
        message: 'Another close operation is running for this user. Please retry shortly.'
      });
    }

    // Resolve via unified resolver (handles canonical fallback + SQL + repopulation)
    let ctx;
    try {
      ctx = await resolveOpenOrder({
        order_id,
        user_id: req_user_id,
        user_type: req_user_type,
        symbolReq: normalizeStr(body.symbol).toUpperCase(),
        orderTypeReq: normalizeStr(body.order_type).toUpperCase()
      });
    } catch (e) {
      if (e && e.code === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Order not found' });
      if (e && e.code === 'ORDER_NOT_BELONG_TO_USER') return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      if (e && e.code === 'ORDER_NOT_OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${e.status || 'UNKNOWN'})` });
      logger.warn('Resolver error in closeOrder', { order_id, error: e?.message });
      return res.status(500).json({ success: false, message: 'Failed to resolve order' });
    }
    const canonical = ctx.canonical;
    const sqlRow = ctx.row;
    // Trading hours check (using resolved symbol and canonical group when available)
    try {
      const symbolForHours = ctx.symbol;
      const groupName = normalizeStr(canonical?.group || 'Standard');
      const gf = await groupsCache.getGroupFields(groupName, symbolForHours, ['type']);
      const gType = gf && gf.type != null ? gf.type : null;
      if (!_isMarketOpenByType(gType)) {
        return res.status(403).json({ success: false, message: 'Market is closed for this instrument' });
      }
    } catch (e) {
      logger.warn('GroupsCache trading-hours check failed (resolver)', { error: e.message });
    }

    // Read triggers from canonical to decide cancel ids
    let symbol = (canonical && canonical.symbol)
      ? normalizeStr(canonical.symbol).toUpperCase()
      : (sqlRow ? normalizeStr(sqlRow.symbol || sqlRow.order_company_name).toUpperCase() : normalizeStr(body.symbol).toUpperCase());
    let order_type = (canonical && canonical.order_type)
      ? normalizeStr(canonical.order_type).toUpperCase()
      : (sqlRow ? normalizeStr(sqlRow.order_type).toUpperCase() : normalizeStr(body.order_type).toUpperCase());
    // Override from resolver to guarantee normalized values
    try {
      if (ctx && ctx.symbol) symbol = ctx.symbol;
      if (ctx && ctx.order_type) order_type = ctx.order_type;
    } catch (_) {}
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
      
      // Store in lifecycle service for complete ID history
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'close_id', 
        close_id, 
        `Close order initiated - status: ${incomingStatus}`
      );
      
      if (takeprofit_cancel_id) {
        await orderLifecycleService.addLifecycleId(
          order_id, 
          'takeprofit_cancel_id', 
          takeprofit_cancel_id, 
          'Takeprofit cancel during close'
        );
      }
      
      if (stoploss_cancel_id) {
        await orderLifecycleService.addLifecycleId(
          order_id, 
          'stoploss_cancel_id', 
          stoploss_cancel_id, 
          'Stoploss cancel during close'
        );
      }
    } catch (e) {
      logger.warn('Failed to persist lifecycle ids before close', { order_id, error: e.message });
    }

    // 🆕 Set close context for proper close_message attribution in worker_close.py
    try {
      const contextKey = `close_context:${order_id}`;
      const contextValue = {
        context: 'USER_CLOSED',
        initiator: `user:${req_user_type}:${req_user_id}`,
        timestamp: Math.floor(Date.now() / 1000).toString()
      };
      
      await redisCluster.hset(contextKey, contextValue);
      await redisCluster.expire(contextKey, 300); // 5 minutes TTL
      
      logger.info('Close context set for user close', { 
        order_id, 
        user_id: req_user_id,
        user_type: req_user_type
      });
    } catch (e) {
      logger.warn('Failed to set user close context', { 
        error: e.message, 
        order_id,
        user_id: req_user_id
      });
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
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/close`,
        pyPayload,
        { timeout: 20000 }
      );
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };
      return res.status(statusCode).json({ success: false, order_id, reason: detail?.detail?.reason || detail?.reason || 'close_failed', error: detail?.detail || detail });
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow; // 'local' or 'provider'

    // If local flow, rely on RabbitMQ close confirmation to finalize SQL/Redis/payout
    if (flow === 'local') {
      logger.info('Local close delegated to RabbitMQ consumer', { order_id, user_id: req_user_id, user_type: req_user_type });
    }

    return res.status(200).json({ success: true, data: result, order_id });
  } catch (error) {
    logger.error('closeOrder internal error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  } finally {
    if (userLock) {
      await releaseUserLock(userLock);
    }
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

    // Resolve via unified resolver (handles canonical fallback + SQL + repopulation)
    let ctx;
    try {
      ctx = await resolveOpenOrder({ order_id, user_id, user_type, symbolReq, orderTypeReq });
    } catch (e) {
      if (e && e.code === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Order not found' });
      if (e && e.code === 'ORDER_NOT_BELONG_TO_USER') return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      if (e && e.code === 'ORDER_NOT_OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${e.status || 'UNKNOWN'})` });
      logger.warn('Resolver error in addStopLoss', { order_id, error: e?.message });
      return res.status(500).json({ success: false, message: 'Failed to resolve order' });
    }

    const canonical = ctx.canonical;
    const row = ctx.row;
    const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;

    let symbol = ctx.symbol;
    let order_type = ctx.order_type;
    let entry_price_num = Number(ctx.entry_price);
    let order_quantity_num = Number(ctx.order_quantity);

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

    // Check if stoploss already exists - user must cancel existing one first
    let hasExistingSL = false;
    // 1) Check SQL row
    if (row && row.stop_loss != null && Number(row.stop_loss) > 0) {
      hasExistingSL = true;
    }
    // 2) Check canonical Redis order_data
    if (!hasExistingSL && canonical && canonical.stop_loss != null && Number(canonical.stop_loss) > 0) {
      hasExistingSL = true;
    }
    // 3) Check user holdings (WS source of truth)
    if (!hasExistingSL) {
      try {
        const tag = `${user_type}:${user_id}`;
        const hkey = `user_holdings:{${tag}}:${order_id}`;
        const hold = await redisCluster.hgetall(hkey);
        const slNum = hold && hold.stop_loss != null ? Number(hold.stop_loss) : NaN;
        if (!Number.isNaN(slNum) && slNum > 0) hasExistingSL = true;
      } catch (e) {
        logger.warn('Failed to check user_holdings for existing SL', { error: e.message, order_id });
      }
    }
    // 4) Check local trigger store
    if (!hasExistingSL) {
      try {
        const trig = await redisCluster.hgetall(`order_triggers:${order_id}`);
        if (trig && (trig.stop_loss || trig.stop_loss_compare || trig.stop_loss_user)) hasExistingSL = true;
      } catch (e) {
        logger.warn('Failed to check order_triggers for existing SL', { error: e.message, order_id });
      }
    }
    
    if (hasExistingSL) {
      return res.status(409).json({ 
        success: false, 
        message: 'Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one.',
        error_code: 'STOPLOSS_ALREADY_EXISTS'
      });
    }

    // Generate lifecycle id and persist to SQL for traceability
    const stoploss_id = await idGenerator.generateStopLossId();
    try {
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ stoploss_id, status });
      }
      
      // Store in lifecycle service for complete ID history
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'stoploss_id', 
        stoploss_id, 
        `Stoploss added - price: ${stop_loss}`
      );
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

    // Resolve via unified resolver (handles canonical fallback + SQL + repopulation)
    let ctx;
    try {
      ctx = await resolveOpenOrder({ order_id, user_id, user_type, symbolReq, orderTypeReq });
    } catch (e) {
      if (e && e.code === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Order not found' });
      if (e && e.code === 'ORDER_NOT_BELONG_TO_USER') return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      if (e && e.code === 'ORDER_NOT_OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${e.status || 'UNKNOWN'})` });
      logger.warn('Resolver error in addTakeProfit', { order_id, error: e?.message });
      return res.status(500).json({ success: false, message: 'Failed to resolve order' });
    }

    const canonical = ctx.canonical;
    const row = ctx.row;

    // Debug logging to understand the data flow (use WARN level to ensure visibility in prod logs)
    logger.warn('TakeProfit Debug Info', {
      order_id,
      user_id,
      user_type,
      canonical_exists: !!canonical,
      canonical_data: canonical ? {
        symbol: canonical.symbol,
        order_company_name: canonical.order_company_name,
        order_type: canonical.order_type,
        order_price: canonical.order_price,
        user_id: canonical.user_id,
        user_type: canonical.user_type
      } : null,
      row_exists: !!row,
      row_data: row ? {
        symbol: row.symbol,
        order_company_name: row.order_company_name,
        order_type: row.order_type,
        order_price: row.order_price,
        order_user_id: row.order_user_id
      } : null
    });

    // Use resolved values from resolver
    let symbol = ctx.symbol;
    let order_type = ctx.order_type;

    if (!symbol || !order_type) {
      logger.warn('TakeProfit: Missing symbol/order_type even after layered fallback', {
        order_id,
        symbolReq,
        order_typeReq,
        canonical_exists: !!canonical,
        row_exists: !!row,
        canonical_symbol: canonical?.symbol || canonical?.order_company_name,
        canonical_order_type: canonical?.order_type,
        row_symbol: row?.symbol || row?.order_company_name,
        row_order_type: row?.order_type,
      });
    }

    let entry_price_num = Number(ctx.entry_price);
    let order_quantity_num = Number(ctx.order_quantity);

    // Validate that symbol and order_type are available
    if (!symbol || !order_type) {
      logger.error('TakeProfit: Critical validation failure - symbol or order_type still missing after all fallbacks', {
        order_id,
        user_id,
        user_type,
        final_symbol: symbol,
        final_order_type: order_type,
        request_body_symbol: symbolReq,
        request_body_order_type: order_typeReq,
        canonical_available: !!canonical,
        row_available: !!row,
        canonical_details: canonical ? {
          symbol: canonical.symbol,
          order_company_name: canonical.order_company_name,
          order_type: canonical.order_type
        } : null,
        row_details: row ? {
          symbol: row.symbol,
          order_company_name: row.order_company_name,
          order_type: row.order_type
        } : null
      });
      return res.status(400).json({ 
        success: false, 
        message: 'Unable to determine order symbol or type',
        debug_info: {
          order_id,
          request_symbol: symbolReq,
          request_order_type: order_typeReq,
          canonical_exists: !!canonical,
          row_exists: !!row
        }
      });
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

    // Check if takeprofit already exists - user must cancel existing one first
    let hasExistingTP = false;
    // 1) Check SQL row
    if (row && row.take_profit != null && Number(row.take_profit) > 0) {
      hasExistingTP = true;
    }
    // 2) Check canonical Redis order_data
    if (!hasExistingTP && canonical && canonical.take_profit != null && Number(canonical.take_profit) > 0) {
      hasExistingTP = true;
    }
    // 3) Check user holdings (WS source of truth)
    if (!hasExistingTP) {
      try {
        const tag = `${user_type}:${user_id}`;
        const hkey = `user_holdings:{${tag}}:${order_id}`;
        const hold = await redisCluster.hgetall(hkey);
        const tpNum = hold && hold.take_profit != null ? Number(hold.take_profit) : NaN;
        if (!Number.isNaN(tpNum) && tpNum > 0) hasExistingTP = true;
      } catch (e) {
        logger.warn('Failed to check user_holdings for existing TP', { error: e.message, order_id });
      }
    }
    // 4) Check local trigger store
    if (!hasExistingTP) {
      try {
        const trig = await redisCluster.hgetall(`order_triggers:${order_id}`);
        if (trig && (trig.take_profit || trig.take_profit_compare || trig.take_profit_user)) hasExistingTP = true;
      } catch (e) {
        logger.warn('Failed to check order_triggers for existing TP', { error: e.message, order_id });
      }
    }
    
    if (hasExistingTP) {
      return res.status(409).json({ 
        success: false, 
        message: 'Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one.',
        error_code: 'TAKEPROFIT_ALREADY_EXISTS'
      });
    }

    const takeprofit_id = await idGenerator.generateTakeProfitId();
    try {
      const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ takeprofit_id, status });
      }
      
      // Store in lifecycle service for complete ID history
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'takeprofit_id', 
        takeprofit_id, 
        `Takeprofit added - price: ${take_profit}`
      );
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
    // Resolve via unified resolver (handles canonical fallback + SQL + repopulation)
    let ctx;
    try {
      ctx = await resolveOpenOrder({ order_id, user_id, user_type, symbolReq, orderTypeReq });
    } catch (e) {
      if (e && e.code === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Order not found' });
      if (e && e.code === 'ORDER_NOT_BELONG_TO_USER') return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      if (e && e.code === 'ORDER_NOT_OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${e.status || 'UNKNOWN'})` });
      logger.warn('Resolver error in cancelStopLoss', { order_id, error: e?.message });
      return res.status(500).json({ success: false, message: 'Failed to resolve order' });
    }

    const canonical = ctx.canonical;
    const row = ctx.row;

    let symbol = ctx.symbol;
    let order_type = ctx.order_type;

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
      const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ stoploss_cancel_id, status: statusIn });
      }
      
      // Store in lifecycle service for complete ID history
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'stoploss_cancel_id', 
        stoploss_cancel_id, 
        `Stoploss cancel requested - resolved_sl_id: ${resolvedStoplossId}`
      );
      
      // Mark the original stoploss as cancelled
      if (resolvedStoplossId && resolvedStoplossId !== `SL-${order_id}`) {
        await orderLifecycleService.updateLifecycleStatus(
          resolvedStoplossId, 
          'cancelled', 
          'Cancelled by user request'
        );
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

    // Resolve via unified resolver (handles canonical fallback + SQL + repopulation)
    let ctx;
    try {
      ctx = await resolveOpenOrder({ order_id, user_id, user_type, symbolReq, orderTypeReq });
    } catch (e) {
      if (e && e.code === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, message: 'Order not found' });
      if (e && e.code === 'ORDER_NOT_BELONG_TO_USER') return res.status(403).json({ success: false, message: 'Order does not belong to user' });
      if (e && e.code === 'ORDER_NOT_OPEN') return res.status(409).json({ success: false, message: `Order is not OPEN (current: ${e.status || 'UNKNOWN'})` });
      logger.warn('Resolver error in cancelTakeProfit', { order_id, error: e?.message });
      return res.status(500).json({ success: false, message: 'Failed to resolve order' });
    }

    const canonical = ctx.canonical;
    const row = ctx.row;

    let symbol = ctx.symbol;
    let order_type = ctx.order_type;

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
      const OrderModel = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
      const toUpdate = row || (await OrderModel.findOne({ where: { order_id } }));
      if (toUpdate) {
        await toUpdate.update({ takeprofit_cancel_id, status: statusIn });
      }
      
      // Store in lifecycle service for complete ID history
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'takeprofit_cancel_id', 
        takeprofit_cancel_id, 
        `Takeprofit cancel requested - resolved_tp_id: ${resolvedTakeprofitId}`
      );
      
      // Mark the original takeprofit as cancelled
      if (resolvedTakeprofitId && resolvedTakeprofitId !== `TP-${order_id}`) {
        await orderLifecycleService.updateLifecycleStatus(
          resolvedTakeprofitId, 
          'cancelled', 
          'Cancelled by user request'
        );
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
        await redisCluster.del(`pending_orders:${order_id}`);
      } catch (e) { logger.warn('Failed to remove from pending ZSET/HASH', { error: e.message, order_id }); }
      try {
        const tag = `${user_type}:${user_id}`;
        const idx = `user_orders_index:{${tag}}`;
        const h = `user_holdings:{${tag}}:${order_id}`;
        // Use pipeline only for same-slot keys (idx, h)
        const p1 = redisCluster.pipeline();
        p1.srem(idx, order_id);
        p1.del(h);
        await p1.exec();
        // Delete canonical separately to avoid cross-slot pipeline error
        try { await redisCluster.del(`order_data:${order_id}`); } catch (eDel) {
          logger.warn('Failed to delete order_data for pending cancel', { error: eDel.message, order_id });
        }
      } catch (e2) { logger.warn('Failed to remove holdings/index for pending cancel', { error: e2.message, order_id }); }
      try {
        const rowNow = await OrderModel.findOne({ where: { order_id } });
        if (rowNow) await rowNow.update({ order_status: 'CANCELLED', close_message: cancel_message });
      } catch (e3) { logger.warn('SQL update failed for pending cancel', { error: e3.message, order_id }); }
      
      // Small delay to ensure database transaction is committed before WebSocket update
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Emit immediate WebSocket update for local pending cancellation
      try { 
        portfolioEvents.emitUserUpdate(user_type, user_id, { 
          type: 'order_update', 
          order_id, 
          update: { order_status: 'CANCELLED' }, 
          reason: 'local_pending_cancel' 
        }); 
        // Also emit a dedicated pending_cancelled event for immediate UI refresh
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'pending_cancelled',
          order_id,
          reason: 'local_pending_cancel'
        });
      } catch (_) {}
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

async function getClosedOrders(req, res) {
  const operationId = `closed_orders_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // JWT user
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    if (!tokenUserId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    // Block inactive users
    const userStatus = user.status;
    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ success: false, message: 'User status is not allowed' });
    }
    // Resolve account type from JWT and determine order model
    const userType = String(user.account_type || user.user_type || 'live').toLowerCase();
    let OrderModel;
    let queryUserId = parseInt(tokenUserId, 10);
    
    if (user.account_type === 'strategy_provider' && user.strategy_provider_id) {
      // For strategy providers, use StrategyProviderOrder model and strategy_provider_id
      OrderModel = StrategyProviderOrder;
      queryUserId = parseInt(user.strategy_provider_id, 10);
    } else if (userType === 'live') {
      OrderModel = LiveUserOrder;
    } else {
      OrderModel = DemoUserOrder;
    }

    // Pagination
    const page = Math.max(1, parseInt(req.query.page || req.body?.page || '1', 10));
    const pageSizeRaw = parseInt(req.query.page_size || req.query.limit || req.body?.page_size || req.body?.limit || '20', 10);
    const pageSize = Math.min(Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 20), 100);
    const offset = (page - 1) * pageSize;

    const { count, rows } = await OrderModel.findAndCountAll({
      where: { order_user_id: queryUserId, order_status: 'CLOSED' },
      order: [['updated_at', 'DESC']],
      offset,
      limit: pageSize,
    });

    const data = rows.map((r) => ({
      order_id: r.order_id,
      order_company_name: String(r.symbol).toUpperCase(),
      order_type: r.order_type,
      order_quantity: r.order_quantity?.toString?.() ?? String(r.order_quantity ?? ''),
      order_price: r.order_price?.toString?.() ?? String(r.order_price ?? ''),
      close_price: r.close_price?.toString?.() ?? null,
      net_profit: r.net_profit?.toString?.() ?? null,
      margin: r.margin?.toString?.() ?? undefined,
      contract_value: r.contract_value?.toString?.() ?? undefined,
      stop_loss: r.stop_loss?.toString?.() ?? null,
      take_profit: r.take_profit?.toString?.() ?? null,
      order_user_id: r.order_user_id,
      order_status: r.order_status,
      commission: r.commission?.toString?.() ?? null,
      swap: r.swap?.toString?.() ?? null,
      close_message: r.close_message ?? null,
      created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString()) : null,
      updated_at: r.updated_at ? (r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString()) : null,
    }));

    return res.status(200).json(data);
  } catch (error) {
    logger.error('getClosedOrders internal error', { error: error.message, operationId });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

module.exports = { placeInstantOrder, placePendingOrder, closeOrder, addStopLoss, addTakeProfit, cancelStopLoss, cancelTakeProfit, cancelPendingOrder, modifyPendingOrder, getClosedOrders };
