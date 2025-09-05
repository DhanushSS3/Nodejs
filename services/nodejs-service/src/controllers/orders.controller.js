const axios = require('axios');
const logger = require('../services/logger.service');
const idGenerator = require('../services/idGenerator.service');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');

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

    // Persist initial order (PENDING_VALIDATION)
    const OrderModel = parsed.user_type === 'live' ? LiveUserOrder : DemoUserOrder;
    const initialOrder = await OrderModel.create({
      order_id,
      order_user_id: parseInt(parsed.user_id),
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_status: 'PENDING_VALIDATION',
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      margin: 0,
      status: normalizeStr(req.body.status || 'OPEN'),
      placed_by: 'user'
    });

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
        await initialOrder.update({
          order_status: 'REJECTED',
          status: normalizeStr(detail?.detail?.reason || detail?.reason || 'execution_failed')
        });
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

    // Post-success DB update
    const updateFields = {};
    if (typeof exec_price === 'number') {
      updateFields.order_price = exec_price;
    }
    if (typeof margin_usd === 'number') {
      updateFields.margin = margin_usd;
    }
    if (flow === 'local') {
      updateFields.order_status = 'PLACED';
    } else if (flow === 'provider') {
      updateFields.order_status = 'QUEUED_PROVIDER';
    } else {
      updateFields.order_status = 'PLACED'; // default
    }

    try {
      await initialOrder.update(updateFields);
    } catch (uErr) {
      logger.error('Failed to update order after success', { error: uErr.message, order_id });
    }

    // Build frontend response
    return res.status(201).json({
      success: true,
      order_id,
      status: updateFields.order_status,
      execution_mode: flow,
      margin: margin_usd,
      exec_price: exec_price
    });
  } catch (error) {
    logger.transactionFailure('instant_place', error, { operationId });
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

module.exports = { placeInstantOrder };
