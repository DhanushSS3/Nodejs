const axios = require('axios');
const logger = require('../services/logger.service');
const idGenerator = require('../services/idGenerator.service');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const { updateUserUsedMargin } = require('../services/user.margin.service');
const portfolioEvents = require('../services/events/portfolio.events');
const { redisCluster } = require('../../config/redis');
const groupsCache = require('../services/groups.cache.service');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');

function getTokenUserId(user) {
  return user?.sub || user?.user_id || user?.id;
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
      pyResp = await axios.post(`${baseUrl}/api/orders/instant/execute`, pyPayload, { timeout: 15000 });
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

module.exports = { placeInstantOrder };

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

async function closeOrder(req, res) {
  const operationId = `close_order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
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
      pyResp = await axios.post(`${baseUrl}/api/orders/close`, pyPayload, { timeout: 20000 });
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
      pyResp = await axios.post(`${baseUrl}/api/orders/stoploss/add`, pyPayload, { timeout: 15000 });
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
      pyResp = await axios.post(`${baseUrl}/api/orders/takeprofit/add`, pyPayload, { timeout: 15000 });
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

module.exports = { placeInstantOrder, closeOrder, addStopLoss, addTakeProfit };
