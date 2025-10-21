const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../services/logger.service');
const orderReqLogger = require('../services/order.request.logger');
const timingLogger = require('../services/perf.timing.logger');
const idGenerator = require('../services/idGenerator.service');
const orderLifecycleService = require('../services/orderLifecycle.service');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const copyTradingService = require('../services/copyTrading.service');
const copyTradingRedisService = require('../services/copyTradingRedis.service');
const { updateUserUsedMargin } = require('../services/user.margin.service');
const portfolioEvents = require('../services/events/portfolio.events');
const { redisCluster } = require('../../config/redis');

// Create reusable axios instance for Python service calls
const pythonServiceAxios = axios.create({
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub'
  },
  httpAgent: new http.Agent({ 
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10
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

function normalizeStr(v) {
  return (v ?? '').toString();
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Validate strategy provider order payload
 */
function validateStrategyProviderPayload(body) {
  const errors = [];
  const symbol = normalizeStr(body.symbol).toUpperCase();
  const order_type = normalizeStr(body.order_type).toUpperCase();
  const order_price = toNumber(body.order_price);
  const order_quantity = toNumber(body.order_quantity);
  // Note: strategy_provider_id will come from JWT token, not request body

  if (!symbol) errors.push('symbol');
  if (!['BUY', 'SELL'].includes(order_type)) errors.push('order_type');
  if (!(order_price > 0)) errors.push('order_price');
  if (!(order_quantity > 0)) errors.push('order_quantity');

  return { 
    errors, 
    parsed: { 
      symbol, 
      order_type, 
      order_price, 
      order_quantity
    } 
  };
}

/**
 * Place strategy provider order (master order for copy trading)
 */
async function placeStrategyProviderOrder(req, res) {
  const operationId = `strategy_provider_place_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    const t0 = process.hrtime.bigint();
    const marks = {};
    const mark = (name) => { try { marks[name] = process.hrtime.bigint(); } catch (_) {} };
    const msBetween = (a, b) => Number((b - a) / 1000000n);

    // Log request
    orderReqLogger.logOrderRequest({
      endpoint: 'placeStrategyProviderOrder',
      operationId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      user: req.user,
      headers: req.headers,
      body: req.body,
    }).catch(() => {});

    // JWT validation for strategy provider
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const role = user.role || user.user_role;
    const userStatus = user.status;
    const tokenStrategyProviderId = user.strategy_provider_id || user.strategyProviderId;

    // Check if user is a strategy provider and has strategy provider ID in token
    if (role !== 'strategy_provider' && role !== 'trader') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only strategy providers can place master orders' 
      });
    }

    if (!tokenStrategyProviderId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Strategy provider ID not found in token. Please switch to a strategy provider account first.' 
      });
    }

    if (userStatus !== undefined && String(userStatus) === '0') {
      return res.status(403).json({ 
        success: false, 
        message: 'User status is not allowed to trade' 
      });
    }

    // Validate payload
    const { errors, parsed } = validateStrategyProviderPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid payload fields', 
        fields: errors 
      });
    }
    mark('after_validate');

    // Verify strategy provider account exists and belongs to user
    const strategyProvider = await StrategyProviderAccount.findOne({
      where: {
        id: parseInt(tokenStrategyProviderId),
        user_id: tokenUserId,
        status: 1,
        is_active: 1
      }
    });

    if (!strategyProvider) {
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found or access denied' 
      });
    }

    // Generate order ID
    const order_id = await idGenerator.generateOrderId();
    mark('after_id_generated');

    // Store lifecycle ID
    try {
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'order_id', 
        order_id, 
        `Strategy Provider Order - ${parsed.order_type} ${parsed.symbol} @ ${parsed.order_price}`
      );
    } catch (lifecycleErr) {
      logger.warn('Failed to store order_id in lifecycle service', { 
        order_id, 
        error: lifecycleErr.message 
      });
    }

    // Create strategy provider order in database
    const masterOrder = await StrategyProviderOrder.create({
      order_id,
      order_user_id: parseInt(tokenStrategyProviderId),
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_status: 'QUEUED',
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      stop_loss: req.body.stop_loss || null,
      take_profit: req.body.take_profit || null,
      is_master_order: true,
      copy_distribution_status: 'pending',
      status: 'OPEN',
      placed_by: 'strategy_provider'
    });
    mark('after_db_insert');

    // Build payload for Python execution service
    const pyPayload = {
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      user_id: tokenStrategyProviderId.toString(),
      user_type: 'strategy_provider', // Use strategy_provider user type
      order_id,
      stop_loss: req.body.stop_loss || null,
      take_profit: req.body.take_profit || null,
      status: 'OPEN',
      order_status: 'OPEN'
    };

    if (req.body.idempotency_key) {
      pyPayload.idempotency_key = normalizeStr(req.body.idempotency_key);
    }

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

    logger.transactionStart('strategy_provider_place', { 
      operationId, 
      order_id, 
      strategyProviderId: parseInt(tokenStrategyProviderId) 
    });

    // Execute order through Python service
    let pyResp;
    try {
      mark('py_req_start');
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/instant/execute`,
        pyPayload
      );
      mark('py_req_end');
    } catch (err) {
      const statusCode = err?.response?.status || 500;
      const detail = err?.response?.data || { 
        ok: false, 
        reason: 'python_unreachable', 
        error: err.message 
      };

      // Update order status to REJECTED
      await masterOrder.update({
        order_status: 'REJECTED',
        close_message: detail?.reason || 'execution_failed',
        copy_distribution_status: 'failed'
      });

      logger.error('Strategy provider order execution failed', {
        order_id,
        strategyProviderId: parseInt(tokenStrategyProviderId),
        error: err.message,
        pyResponse: detail
      });

      return res.status(statusCode >= 400 && statusCode < 500 ? statusCode : 500).json({
        success: false,
        order_id,
        message: 'Order execution failed',
        reason: detail?.reason || 'execution_failed',
        operationId
      });
    }

    const pyData = pyResp.data?.data || pyResp.data || {};
    
    // Update order with execution results
    await masterOrder.update({
      order_status: 'OPEN',
      order_price: pyData.exec_price || parsed.order_price,
      margin: pyData.margin_usd || 0,
      contract_value: pyData.contract_value || 0,
      commission: pyData.commission_entry || 0
    });
    mark('after_order_update');

    // Update strategy provider margin for local execution
    const flow = pyData.flow || 'local';
    if (flow === 'local' && typeof pyData.used_margin_executed === 'number') {
      try {
        await updateUserUsedMargin({
          userType: 'strategy_provider',
          userId: parseInt(tokenStrategyProviderId),
          usedMargin: pyData.used_margin_executed,
        });
        
        // Emit portfolio event for strategy provider margin update
        try {
          portfolioEvents.emitUserUpdate('strategy_provider', tokenStrategyProviderId, {
            type: 'user_margin_update',
            used_margin_usd: pyData.used_margin_executed,
          });
        } catch (e) {
          logger.warn('Failed to emit portfolio event after strategy provider margin update', { 
            error: e.message, 
            strategyProviderId: tokenStrategyProviderId 
          });
        }
      } catch (mErr) {
        logger.error('Failed to update strategy provider used margin', {
          error: mErr.message,
          strategyProviderId: tokenStrategyProviderId,
          userType: 'strategy_provider',
        });
        // Do not fail the request; SQL margin is an eventual-consistency mirror of Redis
      }
    }
    mark('after_margin_update');

    // Create Redis entries for strategy provider after successful execution
    await copyTradingService.createRedisOrderEntries(masterOrder, 'strategy_provider');
    mark('after_redis_entries');

    // Trigger copy trading replication to followers
    try {
      const replicationResult = await copyTradingService.processStrategyProviderOrder(masterOrder);
      mark('after_replication');
      
      logger.info('Strategy provider order replication completed', {
        order_id,
        strategyProviderId: parseInt(tokenStrategyProviderId),
        replicationResult
      });
    } catch (replicationErr) {
      logger.error('Order replication failed', {
        order_id,
        strategyProviderId: parseInt(tokenStrategyProviderId),
        error: replicationErr.message
      });
      // Don't fail the main order, just log the replication failure
    }

    // Log timing
    try {
      const tEnd = process.hrtime.bigint();
      const durations = {
        total_ms: msBetween(t0, tEnd),
        validate_ms: marks.after_validate ? msBetween(t0, marks.after_validate) : undefined,
        id_generate_ms: marks.after_id_generated ? msBetween(marks.after_validate || t0, marks.after_id_generated) : undefined,
        db_insert_ms: marks.after_db_insert ? msBetween(marks.after_id_generated || t0, marks.after_db_insert) : undefined,
        order_update_ms: marks.after_order_update ? msBetween(marks.py_req_end || t0, marks.after_order_update) : undefined,
        margin_update_ms: marks.after_margin_update ? msBetween(marks.after_order_update || t0, marks.after_margin_update) : undefined,
        redis_entries_ms: marks.after_redis_entries ? msBetween(marks.after_margin_update || t0, marks.after_redis_entries) : undefined,
        py_roundtrip_ms: (marks.py_req_start && marks.py_req_end) ? msBetween(marks.py_req_start, marks.py_req_end) : undefined,
        replication_ms: marks.after_replication ? msBetween(marks.after_redis_entries || t0, marks.after_replication) : undefined,
      };

      await timingLogger.logTiming({
        endpoint: 'placeStrategyProviderOrder',
        operationId,
        order_id,
        status: 'success',
        durations_ms: durations,
      });
    } catch (_) {}

    logger.transactionSuccess('strategy_provider_place', { 
      operationId, 
      order_id
    });

    return res.status(200).json({
      success: true,
      order_id,
      strategy_provider_id: parseInt(tokenStrategyProviderId),
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_status: 'OPEN',
      exec_price: pyData.exec_price || parsed.order_price,
      order_quantity: parsed.order_quantity,
      margin: pyData.margin_usd || 0,
      commission: pyData.commission_entry || 0,
      operationId,
      data: pyData
    });

  } catch (error) {
    logger.error('Strategy provider order placement error', {
      operationId,
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      operationId
    });
  }
}

/**
 * Get strategy provider orders
 */
async function getStrategyProviderOrders(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { strategy_provider_id } = req.params;

    // Verify strategy provider account belongs to user
    const strategyProvider = await StrategyProviderAccount.findOne({
      where: {
        id: parseInt(strategy_provider_id),
        user_id: tokenUserId,
        status: 1,
        is_active: 1
      }
    });

    if (!strategyProvider) {
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found or access denied' 
      });
    }

    // Get orders from database
    const orders = await StrategyProviderOrder.findAll({
      where: {
        order_user_id: parseInt(strategy_provider_id)
      },
      order: [['created_at', 'DESC']],
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });

    return res.status(200).json({
      success: true,
      strategy_provider_id: parseInt(strategy_provider_id),
      orders: orders.map(order => ({
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price,
        order_quantity: order.order_quantity,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
        close_price: order.close_price,
        net_profit: order.net_profit,
        commission: order.commission,
        swap: order.swap,
        margin: order.margin,
        contract_value: order.contract_value,
        copy_distribution_status: order.copy_distribution_status,
        total_followers_copied: order.total_followers_copied,
        successful_copies_count: order.successful_copies_count,
        failed_copies_count: order.failed_copies_count,
        created_at: order.created_at,
        updated_at: order.updated_at
      }))
    });

  } catch (error) {
    logger.error('Get strategy provider orders error', {
      error: error.message,
      strategy_provider_id: req.params.strategy_provider_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Close strategy provider order
 */
async function closeStrategyProviderOrder(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;
    const { close_price } = req.body;

    // Find the order
    const order = await StrategyProviderOrder.findOne({
      where: { order_id },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        where: { user_id: tokenUserId }
      }]
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (!['OPEN', 'PENDING'].includes(order.order_status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Order cannot be closed in current status' 
      });
    }

    // Close order through Python service
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyPayload = {
      order_id,
      user_id: order.order_user_id.toString(),
      user_type: 'strategy_provider',
      close_price: close_price || null
    };

    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/close`,
      pyPayload
    );

    // Update order status
    await order.update({
      order_status: 'CLOSED',
      close_price: close_price || pyResp.data?.close_price,
      copy_distribution_status: 'completed',
      copy_distribution_completed_at: new Date()
    });

    // Handle follower order closures
    await copyTradingService.processStrategyProviderOrderUpdate(order);

    return res.status(200).json({
      success: true,
      order_id,
      message: 'Order closed successfully',
      close_price: close_price || pyResp.data?.close_price
    });

  } catch (error) {
    logger.error('Close strategy provider order error', {
      error: error.message,
      order_id: req.params.order_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Get copy follower orders for a specific follower account
 */
async function getCopyFollowerOrders(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { copy_follower_account_id } = req.params;

    // Verify copy follower account belongs to user
    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: parseInt(copy_follower_account_id),
        user_id: tokenUserId,
        status: 1,
        is_active: 1
      }
    });

    if (!followerAccount) {
      return res.status(404).json({ 
        success: false, 
        message: 'Copy follower account not found or access denied' 
      });
    }

    // Get orders from database
    const orders = await CopyFollowerOrder.findAll({
      where: {
        copy_follower_account_id: parseInt(copy_follower_account_id)
      },
      order: [['created_at', 'DESC']],
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    });

    return res.status(200).json({
      success: true,
      copy_follower_account_id: parseInt(copy_follower_account_id),
      orders: orders.map(order => ({
        order_id: order.order_id,
        master_order_id: order.master_order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price,
        order_quantity: order.order_quantity,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
        close_price: order.close_price,
        net_profit: order.net_profit,
        commission: order.commission,
        swap: order.swap,
        copy_status: order.copy_status,
        copy_timestamp: order.copy_timestamp,
        failure_reason: order.failure_reason,
        master_lot_size: order.master_lot_size,
        final_lot_size: order.final_lot_size,
        lot_ratio: order.lot_ratio,
        performance_fee_amount: order.performance_fee_amount,
        net_profit_after_fees: order.net_profit_after_fees,
        created_at: order.created_at,
        updated_at: order.updated_at
      }))
    });

  } catch (error) {
    logger.error('Get copy follower orders error', {
      error: error.message,
      copy_follower_account_id: req.params.copy_follower_account_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Cancel strategy provider order
 */
async function cancelStrategyProviderOrder(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;

    // Find the order
    const order = await StrategyProviderOrder.findOne({
      where: { order_id },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        where: { user_id: tokenUserId }
      }]
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (!['PENDING', 'QUEUED'].includes(order.order_status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Order cannot be cancelled in current status' 
      });
    }

    // Cancel order through Python service
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyPayload = {
      order_id,
      user_id: order.order_user_id.toString(),
      user_type: 'strategy_provider',
      symbol: order.symbol,
      order_type: order.order_type
    };

    await pythonServiceAxios.post(
      `${baseUrl}/api/orders/pending/cancel`,
      pyPayload
    );

    // Update order status
    await order.update({
      order_status: 'CANCELLED',
      copy_distribution_status: 'cancelled'
    });

    // Handle follower order cancellations
    await copyTradingService.processStrategyProviderOrderUpdate(order);

    return res.status(200).json({
      success: true,
      order_id,
      message: 'Order cancelled successfully'
    });

  } catch (error) {
    logger.error('Cancel strategy provider order error', {
      error: error.message,
      order_id: req.params.order_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Add stop loss to strategy provider order
 */
async function addStopLossToOrder(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;
    const { stop_loss } = req.body;

    // Find the order
    const order = await StrategyProviderOrder.findOne({
      where: { order_id },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        where: { user_id: tokenUserId }
      }]
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (order.order_status !== 'OPEN') {
      return res.status(400).json({ 
        success: false, 
        message: 'Can only add stop loss to open orders' 
      });
    }

    // Generate stop loss ID
    const stoploss_id = await idGenerator.generateOrderId();

    // Add stop loss through Python service
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyPayload = {
      order_id,
      user_id: order.order_user_id.toString(),
      user_type: 'strategy_provider',
      symbol: order.symbol,
      order_type: order.order_type,
      stop_loss: parseFloat(stop_loss),
      order_quantity: order.order_quantity,
      stoploss_id
    };

    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/stoploss/add`,
      pyPayload
    );

    // Update order with stop loss
    await order.update({
      stop_loss: parseFloat(stop_loss)
    });

    // Note: No need to replicate SL to followers - they close when master closes

    return res.status(200).json({
      success: true,
      order_id,
      stop_loss: parseFloat(stop_loss),
      stoploss_id,
      message: 'Stop loss added successfully'
    });

  } catch (error) {
    logger.error('Add stop loss error', {
      error: error.message,
      order_id: req.params.order_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Add take profit to strategy provider order
 */
async function addTakeProfitToOrder(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;
    const { take_profit } = req.body;

    // Find the order
    const order = await StrategyProviderOrder.findOne({
      where: { order_id },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        where: { user_id: tokenUserId }
      }]
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (order.order_status !== 'OPEN') {
      return res.status(400).json({ 
        success: false, 
        message: 'Can only add take profit to open orders' 
      });
    }

    // Generate take profit ID
    const takeprofit_id = await idGenerator.generateOrderId();

    // Add take profit through Python service
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyPayload = {
      order_id,
      user_id: order.order_user_id.toString(),
      user_type: 'strategy_provider',
      symbol: order.symbol,
      order_type: order.order_type,
      take_profit: parseFloat(take_profit),
      order_quantity: order.order_quantity,
      takeprofit_id
    };

    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/takeprofit/add`,
      pyPayload
    );

    // Update order with take profit
    await order.update({
      take_profit: parseFloat(take_profit)
    });

    // Note: No need to replicate TP to followers - they close when master closes

    return res.status(200).json({
      success: true,
      order_id,
      take_profit: parseFloat(take_profit),
      takeprofit_id,
      message: 'Take profit added successfully'
    });

  } catch (error) {
    logger.error('Add take profit error', {
      error: error.message,
      order_id: req.params.order_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Cancel stop loss from strategy provider order
 */
async function cancelStopLossFromOrder(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;
    const { stoploss_id } = req.body;

    // Find the order
    const order = await StrategyProviderOrder.findOne({
      where: { order_id },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        where: { user_id: tokenUserId }
      }]
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (!order.stop_loss) {
      return res.status(400).json({ 
        success: false, 
        message: 'No stop loss to cancel' 
      });
    }

    // Cancel stop loss through Python service
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyPayload = {
      order_id,
      user_id: order.order_user_id.toString(),
      user_type: 'strategy_provider',
      symbol: order.symbol,
      order_type: order.order_type,
      stoploss_id: stoploss_id || await idGenerator.generateOrderId()
    };

    await pythonServiceAxios.post(
      `${baseUrl}/api/orders/stoploss/cancel`,
      pyPayload
    );

    // Remove stop loss from order
    await order.update({
      stop_loss: null
    });

    // Note: No need to cancel SL for followers - they close when master closes

    return res.status(200).json({
      success: true,
      order_id,
      message: 'Stop loss cancelled successfully'
    });

  } catch (error) {
    logger.error('Cancel stop loss error', {
      error: error.message,
      order_id: req.params.order_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

/**
 * Cancel take profit from strategy provider order
 */
async function cancelTakeProfitFromOrder(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;
    const { takeprofit_id } = req.body;

    // Find the order
    const order = await StrategyProviderOrder.findOne({
      where: { order_id },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        where: { user_id: tokenUserId }
      }]
    });

    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (!order.take_profit) {
      return res.status(400).json({ 
        success: false, 
        message: 'No take profit to cancel' 
      });
    }

    // Cancel take profit through Python service
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyPayload = {
      order_id,
      user_id: order.order_user_id.toString(),
      user_type: 'strategy_provider',
      symbol: order.symbol,
      order_type: order.order_type,
      takeprofit_id: takeprofit_id || await idGenerator.generateOrderId()
    };

    await pythonServiceAxios.post(
      `${baseUrl}/api/orders/takeprofit/cancel`,
      pyPayload
    );

    // Remove take profit from order
    await order.update({
      take_profit: null
    });

    // Note: No need to cancel TP for followers - they close when master closes

    return res.status(200).json({
      success: true,
      order_id,
      message: 'Take profit cancelled successfully'
    });

  } catch (error) {
    logger.error('Cancel take profit error', {
      error: error.message,
      order_id: req.params.order_id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}

module.exports = {
  placeStrategyProviderOrder,
  getStrategyProviderOrders,
  closeStrategyProviderOrder,
  getCopyFollowerOrders,
  cancelStrategyProviderOrder,
  addStopLossToOrder,
  addTakeProfitToOrder,
  cancelStopLossFromOrder,
  cancelTakeProfitFromOrder
};
