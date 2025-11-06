const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../utils/logger');
const copyTradingService = require('../services/copyTrading.service');
const StrategyProviderStatsService = require('../services/strategyProviderStats.service');
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
const idGenerator = require('../services/idGenerator.service');
const portfolioEvents = require('../services/events/portfolio.events');

// Helper function to emit copy follower account events
function emitCopyFollowerEvent(copyFollowerAccountId, eventType, payload = {}) {
  try {
    portfolioEvents.emitCopyFollowerAccountUpdate(copyFollowerAccountId, {
      type: eventType,
      ...payload
    });
  } catch (error) {
    logger.warn('Failed to emit copy follower event', {
      error: error.message,
      copyFollowerAccountId,
      eventType,
      payload
    });
  }
}
const orderLifecycleService = require('../services/orderLifecycle.service');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const copyTradingRedisService = require('../services/copyTradingRedis.service');
const { updateUserUsedMargin } = require('../services/user.margin.service');
const { applyOrderClosePayout } = require('../services/order.payout.service');
const redisUserCache = require('../services/redis.user.cache.service');
const lotValidationService = require('../services/lot.validation.service');
const groupsCache = require('../services/groups.cache.service');
const orderReqLogger = require('../services/order.request.logger');


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

    // Get strategy provider group for lot validation
    const strategyProviderGroup = 'Standard'; // Default group for strategy providers
    
    // Validate lot size against group constraints
    const lotValidation = await lotValidationService.validateLotSize(strategyProviderGroup, parsed.symbol, parsed.order_quantity);
    if (!lotValidation.valid) {
      return res.status(400).json({
        success: false,
        message: lotValidation.message,
        lot_constraints: {
          provided_lot: lotValidation.lotSize,
          min_lot: lotValidation.minLot,
          max_lot: lotValidation.maxLot,
          user_group: strategyProviderGroup,
          symbol: parsed.symbol
        }
      });
    }

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
    // IMPORTANT: Use strategy provider account ID for config lookup
    // The Redis cache is now correctly populated with strategy_provider:{strategy_provider_account_id}
    const pyPayload = {
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      user_id: tokenStrategyProviderId.toString(), // Use strategy provider account ID for config lookup
      user_type: 'strategy_provider', // Use strategy_provider user type
      order_id,
      stop_loss: req.body.stop_loss || null,
      take_profit: req.body.take_profit || null,
      status: 'OPEN',
      order_status: 'OPEN',
      strategy_provider_id: tokenStrategyProviderId.toString() // Add strategy provider ID for reference
    };
    
    logger.info('Strategy provider order payload', {
      operationId,
      order_id,
      tokenUserId,
      tokenStrategyProviderId,
      user_id_for_config: tokenUserId.toString(),
      strategy_provider_id: tokenStrategyProviderId.toString()
    });

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
    // For provider flow, keep status as QUEUED until provider confirmation
    // For local flow, set to OPEN immediately (same as live users)
    const flow = pyData.flow || 'local';
    const orderStatus = flow === 'provider' ? 'QUEUED' : 'OPEN';
    
    // For provider flow, only update price and reserve margin (like live users)
    // For local flow, update all fields immediately
    const updateFields = {
      order_status: orderStatus,
      order_price: pyData.exec_price || parsed.order_price,
    };
    
    if (flow === 'local') {
      // Local execution: update all fields immediately
      updateFields.margin = pyData.margin_usd || 0;
      updateFields.contract_value = pyData.contract_value || 0;
      updateFields.commission = pyData.commission_entry || 0;
    } else {
      // Provider flow: margin is reserved/managed in Redis and finalized on provider confirmation
      // Only update basic fields, margin will be updated by worker when provider confirms
    }
    
    await masterOrder.update(updateFields);
    
    logger.info('Strategy provider order status set based on flow', {
      order_id: masterOrder.order_id,
      flow,
      orderStatus,
      updateFields,
      operationId
    });
    mark('after_order_update');

    // Update strategy provider margin for local execution
    if (flow === 'local' && typeof pyData.used_margin_executed === 'number') {
      try {
        await updateUserUsedMargin({
          userType: 'strategy_provider',
          userId: parseInt(tokenStrategyProviderId), // Use tokenStrategyProviderId (account ID) to avoid ambiguity
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

    // Increment total trades counter asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        await StrategyProviderStatsService.incrementTotalTrades(
          tokenStrategyProviderId, 
          order_id
        );
      } catch (statsError) {
        logger.error('Failed to increment total trades counter', {
          strategyProviderId: tokenStrategyProviderId,
          orderId: order_id,
          operationId,
          error: statsError.message
        });
      }
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
  const operationId = `close_sp_order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (same as live users)
    orderReqLogger.logOrderRequest({
      endpoint: 'closeStrategyProviderOrder',
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
    const role = user.role;
    
    // Strategy provider role validation
    if (role && role !== 'strategy_provider') {
      return res.status(403).json({ success: false, message: 'User role not allowed for strategy provider orders' });
    }

    // Get the strategy provider account ID from JWT token (same as place operation)
    const tokenStrategyProviderId = user.strategy_provider_id || user.strategyProviderId;
    
    if (!tokenStrategyProviderId) {
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account ID not found in token' 
      });
    }

    const body = req.body || {};
    const order_id = body.order_id; // Get from request body (same as live users)
    const provided_close_price = parseFloat(body.close_price);
    const incomingStatus = body.status || 'CLOSED';
    const incomingOrderStatus = body.order_status || 'CLOSED';

    // Determine execution flow early (same as live users)
    let isProviderFlow = false;
    try {
      const userCfgKey = `user:{strategy_provider:${tokenStrategyProviderId}}:config`;
      const ucfg = await redisCluster.hgetall(userCfgKey);
      const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = (so === 'barclays');
      
      logger.info('Strategy provider execution flow determined', {
        order_id,
        user_id: tokenStrategyProviderId,
        isProviderFlow,
        operationId
      });
    } catch (_) { 
      isProviderFlow = false; 
    }

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!Number.isNaN(provided_close_price) && !(provided_close_price > 0)) {
      return res.status(400).json({ success: false, message: 'close_price must be greater than 0 when provided' });
    }

    // Find the order using the strategy provider account ID (consistent with place operation)
    const order = await StrategyProviderOrder.findOne({
      where: { 
        order_id,
        order_user_id: parseInt(tokenStrategyProviderId)  // Use same logic as place operation
      }
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

    // Generate lifecycle IDs (same as live users)
    const close_id = await idGenerator.generateOrderId();
    let stoploss_cancel_id = null;
    let takeprofit_cancel_id = null;

    // Generate cancel IDs if SL/TP exist
    if (order.stop_loss) {
      stoploss_cancel_id = await idGenerator.generateOrderId();
    }
    if (order.take_profit) {
      takeprofit_cancel_id = await idGenerator.generateOrderId();
    }

    // Persist lifecycle IDs (same as live users)
    try {
      if (close_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'close_id', close_id);
      }
      if (stoploss_cancel_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'stoploss_cancel_id', stoploss_cancel_id);
      }
      if (takeprofit_cancel_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'takeprofit_cancel_id', takeprofit_cancel_id);
      }
    } catch (e) {
      logger.warn('Failed to persist lifecycle ids before close', { order_id, error: e.message });
    }

    // Store order data in Redis for Python service (same as live users)
    try {
      const odKey = `order_data:${order_id}`;
      await redisCluster.hset(odKey, {
        order_id: String(order_id),
        user_type: 'strategy_provider',
        user_id: String(tokenStrategyProviderId), // Use strategy provider account ID, not live user ID
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        status: order.status || 'OPEN',
        order_price: String(order.order_price),
        order_quantity: String(order.order_quantity),
        close_id: String(close_id),
        sending_orders: isProviderFlow ? 'barclays' : 'rock' // Explicit flow information for Python service
      });
      
      logger.info('Order data stored in Redis for Python service', {
        order_id,
        user_id: tokenStrategyProviderId, // Log strategy provider account ID for consistency
        isProviderFlow,
        operationId
      });
    } catch (e) {
      logger.warn('Failed to store order data in Redis', { 
        error: e.message, 
        order_id,
        operationId
      });
    }

    // Ensure user config is available in Redis for Python service
    try {
      const userCfgKey = `user:{strategy_provider:${tokenStrategyProviderId}}:config`;
      const existingConfig = await redisCluster.hgetall(userCfgKey);
      
      // Only update if sending_orders is not already set correctly
      if (!existingConfig.sending_orders || existingConfig.sending_orders !== (isProviderFlow ? 'barclays' : 'rock')) {
        await redisCluster.hset(userCfgKey, {
          sending_orders: isProviderFlow ? 'barclays' : 'rock',
          user_type: 'strategy_provider',
          user_id: String(tokenStrategyProviderId),
          group: 'Standard', // Default group
          last_updated: new Date().toISOString()
        });
        
        logger.info('Updated strategy provider config in Redis', {
          user_id: tokenUserId,
          sending_orders: isProviderFlow ? 'barclays' : 'rock',
          operationId
        });
      }
    } catch (e) {
      logger.warn('Failed to update user config in Redis', { 
        error: e.message, 
        user_id: tokenUserId,
        operationId
      });
    }

    // Set close context (same as live users)
    try {
      const contextKey = `close_context:${order_id}`;
      const contextValue = {
        context: 'USER_CLOSED',
        initiator: `user:strategy_provider:${tokenStrategyProviderId}`, // Use account ID for consistency
        timestamp: new Date().toISOString()
      };
      await redisCluster.set(contextKey, JSON.stringify(contextValue), 'EX', 300);
      
      logger.info('Close context set for strategy provider close', {
        order_id,
        user_id: tokenStrategyProviderId, // Log account ID for consistency
        user_type: 'strategy_provider'
      });
    } catch (e) {
      logger.warn('Failed to set strategy provider close context', { 
        error: e.message, 
        order_id,
        user_id: tokenStrategyProviderId // Use account ID for consistency
      });
    }

    // Flow already determined earlier

    logger.info('Strategy provider execution flow determined', {
      order_id,
      user_id: tokenStrategyProviderId, // Use account ID for consistency
      isProviderFlow,
      operationId
    });

    // Build payload to Python (same pattern as live users)
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: tokenStrategyProviderId.toString(), // Use strategy provider account ID, not live user ID
      user_type: 'strategy_provider',
      order_id,
      status: incomingStatus,
      order_status: incomingOrderStatus,
      close_id,
      order_quantity: parseFloat(order.order_quantity), // Include quantity from existing order
    };
    if (takeprofit_cancel_id) pyPayload.takeprofit_cancel_id = takeprofit_cancel_id;
    if (stoploss_cancel_id) pyPayload.stoploss_cancel_id = stoploss_cancel_id;
    // Only include close_price for provider flow; local flow should calculate from market data
    if (isProviderFlow && !Number.isNaN(provided_close_price) && provided_close_price > 0) {
      pyPayload.close_price = provided_close_price;
      logger.info('Including close_price for provider flow', {
        order_id,
        isProviderFlow,
        provided_close_price,
        operationId
      });
    } else {
      logger.info('Excluding close_price for local flow', {
        order_id,
        isProviderFlow,
        provided_close_price,
        operationId
      });
    }
    if (body.idempotency_key) pyPayload.idempotency_key = body.idempotency_key;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

    // Debug: Log the payload we're sending
    logger.info('Sending payload to Python service', {
      order_id,
      pyPayload,
      operationId
    });

    // Call Python service (same as live users)
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
      
      logger.error('Python service call failed for strategy provider close', {
        error: err.message,
        statusCode,
        detail,
        order_id,
        operationId
      });
      
      return res.status(statusCode).json({ 
        success: false, 
        order_id, 
        reason: detail?.detail?.reason || detail?.reason || 'close_failed', 
        error: detail?.detail || detail,
        operationId
      });
    }

    const result = pyResp.data?.data || {};
    const flow = result.flow; // 'local' or 'provider'

    logger.info('Strategy provider close result received', {
      order_id,
      flow,
      used_margin_executed: result.used_margin_executed,
      net_profit: result.net_profit,
      operationId
    });

    // Update order status (same pattern as live users)
    // For provider flow: use frontend close_price, for local flow: use backend calculated close_price
    const finalClosePrice = (flow === 'provider' && provided_close_price) ? provided_close_price : result.close_price;
    
    await order.update({
      order_status: 'CLOSED',
      close_price: finalClosePrice,
      net_profit: result.net_profit || 0,
      commission: result.total_commission || 0,
      swap: result.swap || 0,
      copy_distribution_status: 'pending', // Will be updated after copy trading
      copy_distribution_completed_at: null
    });
    
    logger.info('Strategy provider order updated with close price', {
      order_id,
      flow,
      provided_close_price,
      result_close_price: result.close_price,
      final_close_price: finalClosePrice,
      operationId
    });

    // Handle flow-specific post-close operations (same pattern as live users)
    if (flow === 'local') {
      logger.info('Processing local flow post-close operations', {
        order_id,
        operationId
      });
      // Local flow: Handle updates directly (same as live users)
      await handleLocalFlowPostClose(result, order, tokenStrategyProviderId, order_id, operationId);
    } else if (flow === 'provider') {
      // Provider flow: Updates will be handled by RabbitMQ consumer when worker confirms
      logger.info('Provider flow close initiated, waiting for worker confirmation', {
        order_id,
        flow,
        operationId
      });
    } else {
      // Fallback: if flow is undefined or unknown, treat as local flow
      logger.warn('Unknown or missing flow type, defaulting to local flow processing', {
        order_id,
        flow,
        operationId
      });
      await handleLocalFlowPostClose(result, order, tokenStrategyProviderId, order_id, operationId);
    }

    logger.info('Strategy provider order closed successfully', {
      order_id,
      strategyProviderId: tokenStrategyProviderId, // Use account ID for consistency
      operationId
    });

    // Update strategy provider statistics asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        await StrategyProviderStatsService.updateStatisticsAfterOrderClose(
          tokenStrategyProviderId, 
          order_id
        );
        logger.info('Strategy provider statistics updated after order close', {
          strategyProviderId: tokenStrategyProviderId,
          orderId: order_id,
          operationId
        });
      } catch (statsError) {
        logger.error('Failed to update strategy provider statistics after order close', {
          strategyProviderId: tokenStrategyProviderId,
          orderId: order_id,
          operationId,
          error: statsError.message,
          stack: statsError.stack
        });
        // Don't throw - statistics update failure should not affect order closure response
      }
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      operationId
    });

  } catch (error) {
    logger.error('Close strategy provider order error', {
      error: error.message,
      order_id: req.body?.order_id,
      operationId,
      req_body: req.body,
      has_body: !!req.body,
      body_type: typeof req.body
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      operationId
    });
  }
}

/**
 * Validate strategy provider pending order payload
 */
function validateStrategyProviderPendingPayload(body) {
  const errors = [];
  const symbol = normalizeStr(body.symbol).toUpperCase();
  const order_type = normalizeStr(body.order_type).toUpperCase(); // BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP
  const order_price = toNumber(body.order_price);
  const order_quantity = toNumber(body.order_quantity);
  // Note: strategy_provider_id will come from JWT token, not request body

  if (!symbol) errors.push('symbol');
  if (!['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'].includes(order_type)) errors.push('order_type');
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
 * Place strategy provider pending order (master pending order for copy trading)
 */
async function placeStrategyProviderPendingOrder(req, res) {
  const operationId = `strategy_provider_pending_place_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    const t0 = process.hrtime.bigint();
    const marks = {};
    const mark = (name) => { try { marks[name] = process.hrtime.bigint(); } catch (_) {} };
    const msBetween = (a, b) => Number((b - a) / 1000000n);

    // Log request
    orderReqLogger.logOrderRequest({
      endpoint: 'placeStrategyProviderPendingOrder',
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
        message: 'Only strategy providers can place master pending orders' 
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
    const { errors, parsed } = validateStrategyProviderPendingPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid payload fields', 
        fields: errors 
      });
    }
    mark('after_validate');

    // Get strategy provider group for lot validation
    const strategyProviderGroup = 'Standard'; // Default group for strategy providers
    
    // Validate lot size against group constraints
    const lotValidation = await lotValidationService.validateLotSize(strategyProviderGroup, parsed.symbol, parsed.order_quantity);
    if (!lotValidation.valid) {
      return res.status(400).json({
        success: false,
        message: lotValidation.message,
        lot_constraints: {
          provided_lot: lotValidation.lotSize,
          min_lot: lotValidation.minLot,
          max_lot: lotValidation.maxLot,
          user_group: strategyProviderGroup,
          symbol: parsed.symbol
        }
      });
    }

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
    
    // Accepting orders even if bid/ask price is missing or stale for flexibility
    if (!(bid > 0) || !(ask > 0)) {
      return res.status(503).json({ success: false, message: 'Market price unavailable for symbol' });
    }

    // Compute half_spread from group cache
    let half_spread = null;
    try {
      const gf = await groupsCache.getGroupFields(strategyProviderGroup, symbol, ['spread', 'spread_pip']);
      if (gf && gf.spread != null && gf.spread_pip != null) {
        const spread = Number(gf.spread);
        const spread_pip = Number(gf.spread_pip);
        if (Number.isFinite(spread) && Number.isFinite(spread_pip)) {
          half_spread = (spread * spread_pip) / 2.0;
        }
      }
    } catch (e) {
      logger.warn('Failed to get group spread config for pending', { error: e.message, group: strategyProviderGroup, symbol: parsed.symbol });
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
      const userCfgKey = `user:{strategy_provider:${tokenStrategyProviderId}}:config`;
      const ucfg = await redisCluster.hgetall(userCfgKey);
      const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = (so === 'barclays');
    } catch (_) {
      isProviderFlow = false;
    }

    // Generate order_id and persist SQL row
    const order_id = await idGenerator.generateOrderId();
    mark('after_id_generated');

    // Store lifecycle ID
    try {
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'order_id', 
        order_id, 
        `Strategy Provider Pending Order - ${parsed.order_type} ${parsed.symbol} @ ${parsed.order_price}`
      );
    } catch (lifecycleErr) {
      logger.warn('Failed to store order_id in lifecycle service', { 
        order_id, 
        error: lifecycleErr.message 
      });
    }

    // Create strategy provider pending order in database
    const masterOrder = await StrategyProviderOrder.create({
      order_id,
      order_user_id: parseInt(tokenStrategyProviderId),
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      stop_loss: req.body.stop_loss || null,
      take_profit: req.body.take_profit || null,
      is_master_order: true,
      copy_distribution_status: 'pending',
      status: 'PENDING',
      placed_by: 'strategy_provider'
    });
    mark('after_db_insert');

    // For provider flow, send to Python service to forward to provider
    if (isProviderFlow) {
      try {
        const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
        
        const pyPayload = {
          order_id,
          symbol: parsed.symbol,
          order_type: parsed.order_type,
          order_price: parsed.order_price,
          order_quantity: parsed.order_quantity,
          user_id: tokenStrategyProviderId.toString(),
          user_type: 'strategy_provider'
        };

        await pythonServiceAxios.post(
          `${baseUrl}/api/orders/pending/place`,
          pyPayload
        );
        
        logger.info('Strategy provider pending order sent to provider', {
          order_id,
          strategyProviderId: tokenStrategyProviderId,
          operationId
        });
      } catch (providerErr) {
        logger.error('Failed to send strategy provider pending order to provider', {
          order_id,
          strategyProviderId: tokenStrategyProviderId,
          error: providerErr.message,
          operationId
        });
        
        // Update order status to failed
        await masterOrder.update({
          order_status: 'REJECTED',
          copy_distribution_status: 'failed'
        });
        
        return res.status(503).json({
          success: false,
          order_id,
          message: 'Failed to send order to provider',
          operationId
        });
      }
    } else {
      // Local flow: Store pending order in Redis for monitoring (same as live users)
      const zkey = `pending_index:{${symbol}}:${orderType}`;
      const hkey = `pending_orders:${order_id}`;
      try {
        await redisCluster.zadd(zkey, compare_price, order_id);
        await redisCluster.hset(hkey, {
          symbol: symbol,
          order_type: orderType,
          user_type: 'strategy_provider',
          user_id: tokenStrategyProviderId.toString(),
          order_price_user: String(parsed.order_price),
          order_price_compare: String(compare_price),
          order_quantity: String(parsed.order_quantity),
          status: 'PENDING',
          created_at: Date.now().toString(),
          group: strategyProviderGroup,
        });
        
        // Ensure symbol is tracked for periodic scanning by the worker
        await redisCluster.sadd('pending_active_symbols', symbol);
      } catch (e) {
        logger.error('Failed to write pending order to Redis', { error: e.message, order_id, zkey });
        return res.status(500).json({ success: false, message: 'Cache error', operationId });
      }
    }

    // Mirror minimal PENDING into user holdings and index for immediate WS visibility
    try {
      const hashTag = `strategy_provider:${tokenStrategyProviderId}`;
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
        group: strategyProviderGroup,
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
        user_type: 'strategy_provider',
        user_id: String(tokenStrategyProviderId),
        symbol: symbol,
        order_type: orderType, // pending type
        order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
        status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
        order_price: String(parsed.order_price),
        order_quantity: String(parsed.order_quantity),
        group: strategyProviderGroup,
        compare_price: String(compare_price),
        half_spread: String(hs),
      });
    } catch (e4) {
      logger.warn('Failed to write canonical order_data for pending', { error: e4.message, order_id });
    }
    mark('after_redis_entries');

    // Trigger copy trading replication to followers for pending orders
    try {
      const replicationResult = await copyTradingService.processStrategyProviderPendingOrder(masterOrder);
      mark('after_replication');
      
      logger.info('Strategy provider pending order replication completed', {
        order_id,
        strategyProviderId: parseInt(tokenStrategyProviderId),
        replicationResult
      });
    } catch (replicationErr) {
      logger.error('Pending order replication failed', {
        order_id,
        strategyProviderId: parseInt(tokenStrategyProviderId),
        error: replicationErr.message
      });
      // Don't fail the main order, just log the replication failure
    }

    // Publish market_price_updates for pending placement
    try {
      await redisCluster.publish('market_price_updates', symbol);
      logger.info('Published market_price_updates for pending placement', { symbol, order_id });
    } catch (e) {
      logger.warn('Failed to publish market_price_updates after pending placement', { error: e.message, symbol, order_id });
    }

    // Notify WS layer
    try {
      portfolioEvents.emitUserUpdate('strategy_provider', tokenStrategyProviderId.toString(), {
        type: 'order_update',
        order_id,
        update: { order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING' },
      });
    } catch (e) {
      logger.warn('Failed to emit portfolio event for pending order', { error: e.message, order_id });
    }

    // Log timing
    try {
      const tEnd = process.hrtime.bigint();
      const durations = {
        total_ms: msBetween(t0, tEnd),
        validate_ms: marks.after_validate ? msBetween(t0, marks.after_validate) : undefined,
        id_generate_ms: marks.after_id_generated ? msBetween(marks.after_validate || t0, marks.after_id_generated) : undefined,
        db_insert_ms: marks.after_db_insert ? msBetween(marks.after_id_generated || t0, marks.after_db_insert) : undefined,
        redis_entries_ms: marks.after_redis_entries ? msBetween(marks.after_db_insert || t0, marks.after_redis_entries) : undefined,
        replication_ms: marks.after_replication ? msBetween(marks.after_redis_entries || t0, marks.after_replication) : undefined,
      };

      await timingLogger.logTiming({
        endpoint: 'placeStrategyProviderPendingOrder',
        operationId,
        order_id,
        status: 'success',
        durations_ms: durations,
      });
    } catch (_) {}

    logger.transactionSuccess('strategy_provider_pending_place', { 
      operationId, 
      order_id
    });

    // Increment total trades counter asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        await StrategyProviderStatsService.incrementTotalTrades(
          tokenStrategyProviderId, 
          order_id
        );
      } catch (statsError) {
        logger.error('Failed to increment total trades counter for pending order', {
          strategyProviderId: tokenStrategyProviderId,
          orderId: order_id,
          operationId,
          error: statsError.message
        });
      }
    });

    return res.status(201).json({
      success: true,
      order_id,
      strategy_provider_id: parseInt(tokenStrategyProviderId),
      symbol: parsed.symbol,
      order_type: parsed.order_type,
      order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',
      order_price: parsed.order_price,
      order_quantity: parsed.order_quantity,
      compare_price,
      group: strategyProviderGroup,
      operationId
    });

  } catch (error) {
    logger.error('Strategy provider pending order placement error', {
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
 * Get closed orders for a specific copy follower account
 * GET /api/copy-trading/accounts/:copy_follower_account_id/closed-orders
 */
async function getCopyFollowerClosedOrders(req, res) {
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { copy_follower_account_id } = req.params;

    if (!tokenUserId) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }

    // Validate copy_follower_account_id parameter
    const copyFollowerAccountId = parseInt(copy_follower_account_id);
    if (!copyFollowerAccountId || copyFollowerAccountId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid copy_follower_account_id parameter'
      });
    }

    // Verify copy follower account belongs to the authenticated user
    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: copyFollowerAccountId,
        user_id: tokenUserId
        // Removed status and is_active filters to allow access to inactive accounts
      },
      attributes: ['id', 'account_name', 'account_number', 'status', 'is_active', 'strategy_provider_id'],
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        attributes: ['id', 'strategy_name', 'account_number'],
        required: false
      }]
    });

    if (!followerAccount) {
      return res.status(404).json({ 
        success: false, 
        message: 'Copy follower account not found or access denied' 
      });
    }

    // Pagination parameters
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(Math.max(1, parseInt(req.query.page_size || req.query.limit || '20', 10)), 100);
    const offset = (page - 1) * pageSize;

    // Get closed orders for this copy follower account
    const { count, rows: orders } = await CopyFollowerOrder.findAndCountAll({
      where: {
        copy_follower_account_id: copyFollowerAccountId,
        order_status: 'CLOSED'
      },
      order: [['updated_at', 'DESC']],
      limit: pageSize,
      offset: offset,
      attributes: [
        'id', 'order_id', 'master_order_id', 'symbol', 'order_type', 'order_status',
        'order_price', 'order_quantity', 'close_price', 'net_profit', 'commission', 'swap',
        'stop_loss', 'take_profit', 'contract_value', 'margin', 'close_message',
        'copy_status', 'copy_timestamp', 'failure_reason',
        'master_lot_size', 'final_lot_size', 'lot_ratio',
        'performance_fee_amount', 'net_profit_after_fees', 'gross_profit',
        'fee_status', 'fee_calculation_date', 'fee_payment_date',
        'created_at', 'updated_at'
      ]
    });

    // Format the response data
    const formattedOrders = orders.map(order => ({
      order_id: order.order_id,
      master_order_id: order.master_order_id,
      symbol: order.symbol?.toString?.().toUpperCase() || order.symbol,
      order_type: order.order_type,
      order_status: order.order_status,
      order_price: parseFloat(order.order_price) || 0,
      order_quantity: parseFloat(order.order_quantity) || 0,
      close_price: parseFloat(order.close_price) || 0,
      net_profit: parseFloat(order.net_profit) || 0,
      commission: parseFloat(order.commission) || 0,
      swap: parseFloat(order.swap) || 0,
      stop_loss: order.stop_loss ? parseFloat(order.stop_loss) : null,
      take_profit: order.take_profit ? parseFloat(order.take_profit) : null,
      contract_value: parseFloat(order.contract_value) || 0,
      margin: parseFloat(order.margin) || 0,
      close_message: order.close_message,
      copy_status: order.copy_status,
      copy_timestamp: order.copy_timestamp,
      failure_reason: order.failure_reason,
      master_lot_size: parseFloat(order.master_lot_size) || 0,
      final_lot_size: parseFloat(order.final_lot_size) || 0,
      lot_ratio: parseFloat(order.lot_ratio) || 0,
      performance_fee_amount: parseFloat(order.performance_fee_amount) || 0,
      net_profit_after_fees: parseFloat(order.net_profit_after_fees) || 0,
      gross_profit: parseFloat(order.gross_profit) || 0,
      fee_status: order.fee_status,
      fee_calculation_date: order.fee_calculation_date,
      fee_payment_date: order.fee_payment_date,
      created_at: order.created_at,
      updated_at: order.updated_at
    }));

    // Calculate pagination info
    const totalPages = Math.ceil(count / pageSize);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    logger.info('Copy follower closed orders retrieved successfully', {
      userId: tokenUserId,
      copyFollowerAccountId,
      ordersCount: orders.length,
      totalOrders: count,
      page,
      pageSize
    });

    return res.status(200).json({
      success: true,
      message: 'Closed orders retrieved successfully',
      data: {
        copy_follower_account: {
          id: followerAccount.id,
          account_name: followerAccount.account_name,
          account_number: followerAccount.account_number,
          status: followerAccount.status,
          is_active: followerAccount.is_active,
          strategy_provider: followerAccount.strategyProvider ? {
            id: followerAccount.strategyProvider.id,
            strategy_name: followerAccount.strategyProvider.strategy_name,
            account_number: followerAccount.strategyProvider.account_number
          } : null
        },
        orders: formattedOrders,
        pagination: {
          current_page: page,
          page_size: pageSize,
          total_orders: count,
          total_pages: totalPages,
          has_next_page: hasNextPage,
          has_previous_page: hasPreviousPage
        }
      }
    });

  } catch (error) {
    logger.error('Get copy follower closed orders error', {
      error: error.message,
      stack: error.stack,
      copy_follower_account_id: req.params.copy_follower_account_id,
      userId: req.user?.sub || req.user?.user_id || req.user?.id
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving closed orders'
    });
  }
}

/**
 * Cancel strategy provider order
 */
async function cancelStrategyProviderOrder(req, res) {
  const operationId = `strategy_provider_pending_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    const user = req.user || {};
    const tokenUserId = getTokenUserId(user);
    const { order_id } = req.params;

    logger.info(`🔍 [CANCEL DEBUG] Starting cancel operation`, {
      operationId,
      tokenUserId,
      order_id,
      userObject: user,
      params: req.params
    });

    // First, find the strategy provider account for this user
    // Use strategy_provider_id from JWT token if available, otherwise fall back to user_id
    const strategyProviderId = user.strategy_provider_id;
    
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { id: strategyProviderId }
    });

    logger.info(`🔍 [CANCEL DEBUG] Strategy account lookup`, {
      operationId,
      tokenUserId,
      strategyAccountFound: !!strategyAccount,
      strategyAccountId: strategyAccount?.id,
      strategyAccountData: strategyAccount?.toJSON()
    });

    if (!strategyAccount) {
      logger.warn(`❌ [CANCEL DEBUG] Strategy provider account not found`, {
        operationId,
        tokenUserId
      });
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found' 
      });
    }

    // Find the order using the strategy provider account ID
    const order = await StrategyProviderOrder.findOne({
      where: { 
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    logger.info(`🔍 [CANCEL DEBUG] Order lookup`, {
      operationId,
      order_id,
      strategyAccountId: strategyAccount.id,
      orderFound: !!order,
      orderData: order?.toJSON(),
      searchCriteria: {
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    if (!order) {
      logger.warn(`❌ [CANCEL DEBUG] Order not found or access denied`, {
        operationId,
        order_id,
        strategyAccountId: strategyAccount.id,
        tokenUserId
      });
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied' 
      });
    }

    if (!['PENDING', 'PENDING-QUEUED', 'QUEUED'].includes(order.order_status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Order cannot be cancelled in current status' 
      });
    }

    // Determine flow type (local vs provider)
    let isProviderFlow = false;
    try {
      const ucfg = await redisCluster.hgetall(`user:{strategy_provider:${strategyAccount.id}}:config`);
      const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = (so === 'barclays');
      
      logger.info('Strategy provider flow detection', {
        strategyProviderId: strategyAccount.id,
        sending_orders: so,
        isProviderFlow,
        order_id
      });
    } catch (_) { 
      isProviderFlow = false; 
    }

    const symbol = order.symbol;
    const order_type = order.order_type;
    const user_id = strategyAccount.id.toString();
    const user_type = 'strategy_provider';

    if (!isProviderFlow) {
      // LOCAL FLOW: Remove from Redis directly and update DB
      try {
        // Remove from pending monitoring
        await redisCluster.zrem(`pending_index:{${symbol}}:${order_type}`, order_id);
        await redisCluster.del(`pending_orders:${order_id}`);
      } catch (e) { 
        logger.warn('Failed to remove from pending ZSET/HASH', { error: e.message, order_id }); 
      }

      try {
        const tag = `${user_type}:${user_id}`;
        const idx = `user_orders_index:{${tag}}`;
        const h = `user_holdings:{${tag}}:${order_id}`;
        
        // Use pipeline for same-slot keys
        const p1 = redisCluster.pipeline();
        p1.srem(idx, order_id);
        p1.del(h);
        await p1.exec();
        
        // Delete canonical separately
        try { 
          await redisCluster.del(`order_data:${order_id}`); 
        } catch (eDel) {
          logger.warn('Failed to delete order_data for pending cancel', { error: eDel.message, order_id });
        }
      } catch (e2) { 
        logger.warn('Failed to remove holdings/index for pending cancel', { error: e2.message, order_id }); 
      }

      // Update strategy provider order in DB
      await order.update({
        order_status: 'CANCELLED',
        copy_distribution_status: 'failed',
        close_message: 'User cancelled pending order'
      });

      // Cancel follower orders (local flow)
      logger.info('Triggering follower order cancellations', {
        masterOrderId: order_id,
        masterOrderStatus: order.order_status
      });
      await copyTradingService.processStrategyProviderOrderUpdate(order);

      // Emit WebSocket update
      try {
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'order_update',
          order_id,
          update: { order_status: 'CANCELLED' },
          reason: 'local_pending_cancel'
        });
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'pending_cancelled',
          order_id,
          reason: 'local_pending_cancel'
        });
      } catch (_) {}

      return res.status(200).json({
        success: true,
        order_id,
        order_status: 'CANCELLED',
        message: 'Order cancelled successfully'
      });
    }

    // PROVIDER FLOW: Generate cancel_id and send to Python service
    let cancel_id = null;
    try { 
      cancel_id = await idGenerator.generateCancelOrderId(); 
    } catch (e) { 
      logger.warn('Failed to generate cancel_id', { error: e.message, order_id }); 
    }
    
    if (!cancel_id) {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to generate cancel id' 
      });
    }

    // Update order with cancel_id
    await order.update({
      cancel_id,
      order_status: 'PENDING-CANCEL',
      copy_distribution_status: 'distributing'
    });

    // Update Redis with cancel_id
    try {
      const tag = `${user_type}:${user_id}`;
      const h = `user_holdings:{${tag}}:${order_id}`;
      const od = `order_data:${order_id}`;
      
      // Store cancel_id in Redis
      try { 
        await redisCluster.hset(h, 'cancel_id', String(cancel_id)); 
      } catch (e1) { 
        logger.warn('HSET cancel_id failed on user_holdings', { error: e1.message, order_id }); 
      }
      try { 
        await redisCluster.hset(od, 'cancel_id', String(cancel_id)); 
      } catch (e2) { 
        logger.warn('HSET cancel_id failed on order_data', { error: e2.message, order_id }); 
      }
      try { 
        await redisCluster.hset(h, 'status', 'PENDING-CANCEL'); 
      } catch (e3) { 
        logger.warn('HSET status failed on user_holdings', { error: e3.message, order_id }); 
      }
      try { 
        await redisCluster.hset(od, 'status', 'PENDING-CANCEL'); 
      } catch (e4) { 
        logger.warn('HSET status failed on order_data', { error: e4.message, order_id }); 
      }
    } catch (e) { 
      logger.warn('Failed to mirror cancel status in Redis', { error: e.message, order_id }); 
    }

    // Register cancel_id with lifecycle service
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      pythonServiceAxios.post(
        `${baseUrl}/api/orders/registry/lifecycle-id`,
        { order_id, new_id: cancel_id, id_type: 'cancel_id' }
      ).catch(() => {});
    } catch (_) {}

    // Send cancel request to Python service
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const pyPayload = { 
        order_id, 
        cancel_id, 
        order_type, 
        user_id, 
        user_type, 
        status: 'CANCELLED',
        symbol 
      };
      
      pythonServiceAxios.post(
        `${baseUrl}/api/orders/pending/cancel`,
        pyPayload
      ).then(() => {
        logger.info('Dispatched provider pending cancel for strategy provider', { order_id, cancel_id, order_type });
      }).catch((ePy) => { 
        logger.error('Python pending cancel failed for strategy provider', { error: ePy.message, order_id }); 
      });
    } catch (_) {}

    // Cancel follower orders (provider flow - will be handled by worker after confirmation)
    logger.info('Triggering follower order cancellations (provider flow)', {
      masterOrderId: order_id,
      masterOrderStatus: order.order_status,
      cancel_id
    });
    await copyTradingService.processStrategyProviderOrderUpdate(order);

    return res.status(202).json({
      success: true,
      order_id,
      order_status: 'PENDING-CANCEL',
      cancel_id,
      message: 'Cancel request submitted successfully'
    });

  } catch (error) {
    logger.error('Cancel strategy provider order error', {
      error: error.message,
      order_id: req.params.order_id,
      operationId
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      operationId
    });
  }
}

/**
 * Add stop loss to strategy provider order
 */
async function addStopLossToOrder(req, res) {
  const operationId = `add_sp_stoploss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (same as live users)
    orderReqLogger.logOrderRequest({
      endpoint: 'addStopLossToOrder',
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
    const role = user.role;
    
    
    // Strategy provider role validation
    if (role && role !== 'strategy_provider') {
      logger.warn(` [STOPLOSS DEBUG] Invalid role`, {
        operationId,
        tokenUserId,
        role
      });
      return res.status(403).json({ success: false, message: 'User role not allowed for strategy provider orders' });
    }

    const body = req.body || {};
    const order_id = body.order_id; // Get from request body (same as live users)
    const stop_loss = parseFloat(body.stop_loss);
    const status = body.status || 'STOPLOSS';
    const order_status_in = body.order_status || 'OPEN';

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!stop_loss || stop_loss <= 0) {
      return res.status(400).json({ success: false, message: 'stop_loss must be a positive number' });
    }

    // First, find the strategy provider account for this user
    // Use strategy_provider_id from JWT token if available, otherwise fall back to user_id
    const strategyProviderId = user.strategy_provider_id || tokenUserId;
    
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { id: strategyProviderId }
    });

    logger.info(`🔍 [STOPLOSS DEBUG] Strategy account lookup`, {
      operationId,
      tokenUserId,
      strategyAccountFound: !!strategyAccount,
      strategyAccountId: strategyAccount?.id,
      strategyAccountData: strategyAccount?.toJSON()
    });

    if (!strategyAccount) {
      logger.warn(`❌ [STOPLOSS DEBUG] Strategy provider account not found`, {
        operationId,
        tokenUserId
      });
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found' 
      });
    }

    // Find the order using the strategy provider account ID
    const order = await StrategyProviderOrder.findOne({
      where: { 
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    logger.info(`🔍 [STOPLOSS DEBUG] Order lookup`, {
      operationId,
      order_id,
      strategyAccountId: strategyAccount.id,
      orderFound: !!order,
      orderData: order?.toJSON(),
      searchCriteria: {
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    if (!order) {
      logger.warn(`❌ [STOPLOSS DEBUG] Order not found or access denied`, {
        operationId,
        order_id,
        strategyAccountId: strategyAccount.id,
        tokenUserId
      });
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

    // Check if stoploss already exists - user must cancel existing one first
    try {
      // Check SQL row
      if (order.stop_loss !== null && order.stop_loss !== undefined && parseFloat(order.stop_loss) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one.',
          error_code: 'STOPLOSS_ALREADY_EXISTS'
        });
      }

      // Check Redis canonical order data
      const canonicalData = await redisCluster.hgetall(`order_data:${order_id}`);
      if (canonicalData && canonicalData.stop_loss && parseFloat(canonicalData.stop_loss) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one.',
          error_code: 'STOPLOSS_ALREADY_EXISTS'
        });
      }

      // Check user holdings in Redis
      const userTag = `strategy_provider:${tokenUserId}`;
      const holdingsData = await redisCluster.hgetall(`user_holdings:{${userTag}}:${order_id}`);
      if (holdingsData && holdingsData.stop_loss && parseFloat(holdingsData.stop_loss) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one.',
          error_code: 'STOPLOSS_ALREADY_EXISTS'
        });
      }

      // Check order triggers in Redis
      const triggersData = await redisCluster.hgetall(`order_triggers:${order_id}`);
      if (triggersData && (triggersData.stop_loss || triggersData.stop_loss_compare || triggersData.stop_loss_user)) {
        return res.status(409).json({
          success: false,
          message: 'Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one.',
          error_code: 'STOPLOSS_ALREADY_EXISTS'
        });
      }
    } catch (error) {
      logger.warn('Failed to check existing stoploss', { order_id, error: error.message, operationId });
      // Continue with the operation if check fails to avoid blocking valid requests
    }

    // Generate stop loss ID (same as live users)
    const stoploss_id = await idGenerator.generateStopLossId();
    
    // Update SQL row with stoploss_id and status (same as live users)
    try {
      await order.update({ stoploss_id, status });
      
      // Store in lifecycle service for complete ID history (same as live users)
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'stoploss_id', 
        stoploss_id, 
        `Stoploss added - price: ${stop_loss}`
      );
    } catch (e) {
      logger.warn('Failed to persist stoploss_id before send', { order_id, stoploss_id, error: e.message });
    }

    // Build payload to Python (same pattern as live users)
    // IMPORTANT: Use strategy provider account ID for config lookup (same as order placement)
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: strategyAccount.id.toString(), // Use strategy provider account ID for config lookup
      user_type: 'strategy_provider',
      order_id,
      stop_loss,
      status,
      order_status: order_status_in,
      stoploss_id
    };
    if (body.idempotency_key) pyPayload.idempotency_key = body.idempotency_key;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    // Call Python service (same as live users)
    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/stoploss/add`,
      pyPayload
    );

    const result = pyResp.data?.data || {};

    // Update order with stop loss (same pattern as live users)
    await order.update({
      stop_loss: stop_loss
    });

    logger.info('Strategy provider stop loss added successfully', {
      order_id,
      stoploss_id,
      strategyProviderId: tokenUserId,
      operationId
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      stoploss_id,
      operationId
    });

  } catch (error) {
    logger.error('Add stop loss error', {
      error: error.message,
      order_id: req.body?.order_id,
      operationId,
      stack: error.stack
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
  const operationId = `add_sp_takeprofit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (same as live users)
    orderReqLogger.logOrderRequest({
      endpoint: 'addTakeProfitToOrder',
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
    const role = user.role;
    
    logger.info(`🔍 [TAKEPROFIT DEBUG] Starting add take profit operation`, {
      operationId,
      tokenUserId,
      role,
      userObject: user,
      body: req.body
    });
    
    // Strategy provider role validation
    if (role && role !== 'strategy_provider') {
      logger.warn(`❌ [TAKEPROFIT DEBUG] Invalid role`, {
        operationId,
        tokenUserId,
        role
      });
      return res.status(403).json({ success: false, message: 'User role not allowed for strategy provider orders' });
    }

    const body = req.body || {};
    const order_id = body.order_id; // Get from request body (same as live users)
    const take_profit = parseFloat(body.take_profit);
    const status = body.status || 'TAKEPROFIT';
    const order_status_in = body.order_status || 'OPEN';

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!take_profit || take_profit <= 0) {
      return res.status(400).json({ success: false, message: 'take_profit must be a positive number' });
    }

    // First, find the strategy provider account for this user
    // Use strategy_provider_id from JWT token if available, otherwise fall back to user_id
    const strategyProviderId = user.strategy_provider_id || tokenUserId;
    
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { id: strategyProviderId }
    });

    logger.info(`🔍 [TAKEPROFIT DEBUG] Strategy account lookup`, {
      operationId,
      tokenUserId,
      strategyAccountFound: !!strategyAccount,
      strategyAccountId: strategyAccount?.id,
      strategyAccountData: strategyAccount?.toJSON()
    });

    if (!strategyAccount) {
      logger.warn(`❌ [TAKEPROFIT DEBUG] Strategy provider account not found`, {
        operationId,
        tokenUserId
      });
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found' 
      });
    }

    // Find the order using the strategy provider account ID
    const order = await StrategyProviderOrder.findOne({
      where: { 
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    logger.info(`🔍 [TAKEPROFIT DEBUG] Order lookup`, {
      operationId,
      order_id,
      strategyAccountId: strategyAccount.id,
      orderFound: !!order,
      orderData: order?.toJSON(),
      searchCriteria: {
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    if (!order) {
      logger.warn(`❌ [TAKEPROFIT DEBUG] Order not found or access denied`, {
        operationId,
        order_id,
        strategyAccountId: strategyAccount.id,
        tokenUserId
      });
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

    // Check if takeprofit already exists - user must cancel existing one first
    try {
      // Check SQL row
      if (order.take_profit !== null && order.take_profit !== undefined && parseFloat(order.take_profit) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one.',
          error_code: 'TAKEPROFIT_ALREADY_EXISTS'
        });
      }

      // Check Redis canonical order data
      const canonicalData = await redisCluster.hgetall(`order_data:${order_id}`);
      if (canonicalData && canonicalData.take_profit && parseFloat(canonicalData.take_profit) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one.',
          error_code: 'TAKEPROFIT_ALREADY_EXISTS'
        });
      }

      // Check user holdings in Redis
      const userTag = `strategy_provider:${tokenUserId}`;
      const holdingsData = await redisCluster.hgetall(`user_holdings:{${userTag}}:${order_id}`);
      if (holdingsData && holdingsData.take_profit && parseFloat(holdingsData.take_profit) > 0) {
        return res.status(409).json({
          success: false,
          message: 'Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one.',
          error_code: 'TAKEPROFIT_ALREADY_EXISTS'
        });
      }

      // Check order triggers in Redis
      const triggersData = await redisCluster.hgetall(`order_triggers:${order_id}`);
      if (triggersData && (triggersData.take_profit || triggersData.take_profit_compare || triggersData.take_profit_user)) {
        return res.status(409).json({
          success: false,
          message: 'Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one.',
          error_code: 'TAKEPROFIT_ALREADY_EXISTS'
        });
      }
    } catch (error) {
      logger.warn('Failed to check existing takeprofit', { order_id, error: error.message, operationId });
      // Continue with the operation if check fails to avoid blocking valid requests
    }

    // Generate take profit ID (same as live users)
    const takeprofit_id = await idGenerator.generateTakeProfitId();
    
    // Update SQL row with takeprofit_id and status (same as live users)
    try {
      await order.update({ takeprofit_id, status });
      
      // Store in lifecycle service for complete ID history (same as live users)
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'takeprofit_id', 
        takeprofit_id, 
        `Takeprofit added - price: ${take_profit}`
      );
    } catch (e) {
      logger.warn('Failed to persist takeprofit_id before send', { order_id, takeprofit_id, error: e.message });
    }

    // Build payload to Python
    // IMPORTANT: Use strategy provider account ID for config lookup (same as order placement)
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: strategyAccount.id.toString(), // Use strategy provider account ID for config lookup
      user_type: 'strategy_provider',
      order_id,
      take_profit,
      status,
      order_status: order_status_in,
      takeprofit_id
    };
    if (body.idempotency_key) pyPayload.idempotency_key = body.idempotency_key;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/takeprofit/add`,
      pyPayload
    );

    const result = pyResp.data?.data || {};

    // Update order with take profit
    await order.update({
      take_profit: take_profit
    });

    logger.info('Strategy provider take profit added successfully', {
      order_id,
      takeprofit_id,
      strategyProviderId: tokenUserId,
      operationId
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      takeprofit_id,
      operationId
    });

  } catch (error) {
    logger.error('Add take profit error', {
      error: error.message,
      order_id: req.body?.order_id,
      operationId
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      operationId
    });
  }
}

/**
 * Cancel stop loss from strategy provider order
 */
async function cancelStopLossFromOrder(req, res) {
  const operationId = `cancel_sp_stoploss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Structured request log (same as live users)
    orderReqLogger.logOrderRequest({
      endpoint: 'cancelStopLossFromOrder',
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
    const role = user.role;
    
    // Strategy provider role validation
    if (role && role !== 'strategy_provider') {
      return res.status(403).json({ success: false, message: 'User role not allowed for strategy provider orders' });
    }

    const body = req.body || {};
    const order_id = body.order_id; // Get from request body (same as live users)
    const status = body.status || 'STOPLOSS-CANCEL';

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }

    // First, find the strategy provider account for this user
    const strategyProviderId = user.strategy_provider_id || tokenUserId;

    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { id: strategyProviderId }
    });

    if (!strategyAccount) {
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found' 
      });
    }

    // Find the order using the strategy provider account ID
    const order = await StrategyProviderOrder.findOne({
      where: { 
        order_id,
        order_user_id: strategyAccount.id
      }
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

    // Determine sending flow to decide provider vs local behavior (same as live users)
    let sendingOrders = 'barclays'; // Default for copy trading
    try {
      const userCfg = await redisUserCache.getUser('strategy_provider', strategyAccount.id);
      if (userCfg && userCfg.sending_orders) {
        sendingOrders = String(userCfg.sending_orders).toLowerCase();
      }
    } catch (e) {
      logger.warn('Failed to fetch strategy provider config from cache', { error: e.message, user_id: strategyAccount.id });
    }

    // Resolve stoploss_id from SQL or Redis canonical (same as live users)
    let resolvedStoplossId = order.stoploss_id;
    if (!resolvedStoplossId) {
      try {
        const fromRedis = await redisCluster.hget(`order_data:${order_id}`, 'stoploss_id');
        if (fromRedis) resolvedStoplossId = fromRedis;
      } catch (_) {}
    }
    if (!resolvedStoplossId) {
      if (sendingOrders === 'barclays') {
        return res.status(409).json({ success: false, message: 'No stoploss_id found for provider cancel' });
      }
      // For local flow, a placeholder is acceptable (Python ignores it for local cancel flow)
      resolvedStoplossId = `SL-${order_id}`;
    }

    // Generate cancel id and persist to SQL (same as live users)
    const stoploss_cancel_id = await idGenerator.generateStopLossCancelId();
    try {
      await order.update({ stoploss_cancel_id, status });
      
      // Store in lifecycle service for complete ID history (same as live users)
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'stoploss_cancel_id', 
        stoploss_cancel_id, 
        `Stoploss cancel requested - resolved_sl_id: ${resolvedStoplossId}`
      );
    } catch (e) {
      logger.warn('Failed to persist stoploss_cancel_id before send', { order_id, stoploss_cancel_id, error: e.message });
    }

    // Build payload to Python
    // IMPORTANT: Use strategy provider account ID for config lookup (same as order placement)
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: strategyAccount.id.toString(), // Use strategy provider account ID for config lookup
      user_type: 'strategy_provider',
      order_id,
      status: 'STOPLOSS-CANCEL',
      order_status: 'OPEN',
      stoploss_id: resolvedStoplossId,
      stoploss_cancel_id
    };
    if (body.idempotency_key) pyPayload.idempotency_key = body.idempotency_key;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/stoploss/cancel`,
      pyPayload
    );

    const result = pyResp.data?.data || {};

    // Remove stop loss from order
    await order.update({
      stop_loss: null
    });

    logger.info('Strategy provider stop loss cancelled successfully', {
      order_id,
      stoploss_id: resolvedStoplossId,
      stoploss_cancel_id,
      strategyProviderId: tokenUserId,
      operationId
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      stoploss_cancel_id,
      operationId
    });

  } catch (error) {
    logger.error('Cancel stop loss error', {
      error: error.message,
      order_id: req.body?.order_id,
      operationId
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
  const operationId = `cancel_sp_takeprofit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    // Structured request log (same as live users)
    orderReqLogger.logOrderRequest({
      endpoint: 'cancelTakeProfitFromOrder',
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
    const role = user.role;
    
    // Strategy provider role validation
    if (role && role !== 'strategy_provider') {
      return res.status(403).json({ success: false, message: 'User role not allowed for strategy provider orders' });
    }

    const body = req.body || {};
    const order_id = body.order_id; // Get from request body (same as live users)
    const status = body.status || 'TAKEPROFIT-CANCEL';

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }

    // First, find the strategy provider account for this user
    const strategyProviderId = user.strategy_provider_id || tokenUserId;

    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { id: strategyProviderId }
    });

    if (!strategyAccount) {
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found' 
      });
    }

    let order = await StrategyProviderOrder.findOne({
      where: { 
        order_id,
        order_user_id: strategyAccount.id
      }
    });

    // If not found, try with user ID (legacy format for backward compatibility)
    if (!order) {
      order = await StrategyProviderOrder.findOne({
        where: { 
          order_id,
          order_user_id: strategyProviderId  // ✅ Correct!
        }
      });
    }


    if (!order) {
      return res.status(404).json({ 
        success: false, 
        message: 'Order not found or access denied!' 
      });
    }

    if (!order.take_profit) {
      return res.status(400).json({ 
        success: false, 
        message: 'No take profit to cancel' 
      });
    }

    // Determine sending flow to decide provider vs local behavior (same as live users)
    let sendingOrders = 'barclays'; // Default for copy trading
    try {
      const userCfg = await redisUserCache.getUser('strategy_provider', strategyAccount.id);
      if (userCfg && userCfg.sending_orders) {
        sendingOrders = String(userCfg.sending_orders).toLowerCase();
      }
    } catch (e) {
      logger.warn('Failed to fetch strategy provider config from cache', { error: e.message, user_id: strategyAccount.id });
    }

    // Resolve takeprofit_id from SQL or Redis canonical (same as live users)
    let resolvedTakeprofitId = order.takeprofit_id;
    if (!resolvedTakeprofitId) {
      try {
        const fromRedis = await redisCluster.hget(`order_data:${order_id}`, 'takeprofit_id');
        if (fromRedis) resolvedTakeprofitId = fromRedis;
      } catch (_) {}
    }
    if (!resolvedTakeprofitId) {
      if (sendingOrders === 'barclays') {
        return res.status(409).json({ success: false, message: 'No takeprofit_id found for provider cancel' });
      }
      // For local flow, a placeholder is acceptable (Python ignores it for local cancel flow)
      resolvedTakeprofitId = `TP-${order_id}`;
    }

    // Generate cancel id and persist to SQL (same as live users)
    const takeprofit_cancel_id = await idGenerator.generateTakeProfitCancelId();
    try {
      await order.update({ takeprofit_cancel_id, status });
      
      // Store in lifecycle service for complete ID history (same as live users)
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'takeprofit_cancel_id', 
        takeprofit_cancel_id, 
        `Takeprofit cancel requested - resolved_tp_id: ${resolvedTakeprofitId}`
      );
    } catch (e) {
      logger.warn('Failed to persist takeprofit_cancel_id before send', { order_id, takeprofit_cancel_id, error: e.message });
    }

    // Build payload to Python
    // IMPORTANT: Use strategy provider account ID for config lookup (same as order placement)
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: strategyAccount.id.toString(), // Use strategy provider account ID for config lookup
      user_type: 'strategy_provider',
      order_id,
      status: 'TAKEPROFIT-CANCEL',
      order_status: 'OPEN',
      takeprofit_id: resolvedTakeprofitId,
      takeprofit_cancel_id
    };
    if (body.idempotency_key) pyPayload.idempotency_key = body.idempotency_key;

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    
    const pyResp = await pythonServiceAxios.post(
      `${baseUrl}/api/orders/takeprofit/cancel`,
      pyPayload
    );

    const result = pyResp.data?.data || {};

    // Remove take profit from order
    await order.update({
      take_profit: null
    });

    logger.info('Strategy provider take profit cancelled successfully', {
      order_id,
      takeprofit_id: resolvedTakeprofitId,
      takeprofit_cancel_id,
      strategyProviderId: tokenUserId,
      operationId
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      takeprofit_cancel_id,
      operationId
    });

  } catch (error) {
    logger.error('Cancel take profit error', {
      error: error.message,
      order_id: req.body?.order_id,
      operationId
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      operationId
    });
  }
}

/**
 * Handle post-close operations for local flow (same pattern as live users)
 * Follows Single Responsibility Principle
 * @param {Object} result - Python service response
 * @param {Object} order - Strategy provider order
 * @param {number} userId - User ID
 * @param {string} orderId - Order ID
 * @param {string} operationId - Operation ID for logging
 */
async function handleLocalFlowPostClose(result, order, userId, orderId, operationId) {
  logger.info('handleLocalFlowPostClose called', {
    order_id: orderId,
    user_id: userId,
    used_margin_executed: result.used_margin_executed,
    net_profit: result.net_profit,
    operationId
  });
  
  try {
    // 1. Update user margin (same as live users)
    if (typeof result.used_margin_executed === 'number') {
      await updateUserUsedMargin({
        userType: 'strategy_provider',
        userId: order.order_user_id, // Use the specific strategy provider account ID from the order
        usedMargin: result.used_margin_executed
      });
      
      logger.info('Strategy provider margin updated after local close', {
        order_id: orderId,
        user_id: userId,
        used_margin: result.used_margin_executed,
        operationId
      });
    }

    // 2. Emit portfolio events (same as live users)
    try {
      if (typeof result.used_margin_executed === 'number') {
        portfolioEvents.emitUserUpdate('strategy_provider', userId.toString(), {
          type: 'user_margin_update',
          used_margin_usd: result.used_margin_executed
        });
      }
      
      portfolioEvents.emitUserUpdate('strategy_provider', userId.toString(), {
        type: 'order_update',
        order_id: orderId,
        update: { order_status: 'CLOSED' }
      });
    } catch (eventErr) {
      logger.warn('Failed to emit portfolio events for strategy provider', {
        order_id: orderId,
        error: eventErr.message,
        operationId
      });
    }

    // 3. Apply wallet payout + user transactions (same as live users)
    try {
      const payoutKey = `close_payout_applied:${String(orderId)}`;
      const nx = await redisCluster.set(payoutKey, '1', 'EX', 7 * 24 * 3600, 'NX');
      if (nx) {
        await applyOrderClosePayout({
          userType: 'strategy_provider',
          userId: order.order_user_id, // Use the specific strategy provider account ID
          orderPk: order?.id ?? null,
          orderIdStr: String(orderId),
          netProfit: Number(result.net_profit) || 0,
          commission: Number(result.total_commission) || 0,
          profitUsd: Number(result.profit_usd) || 0,
          swap: Number(result.swap) || 0,
          symbol: order.symbol,
          orderType: order.order_type,
        });
        
        logger.info('Strategy provider wallet payout applied after local close', {
          order_id: orderId,
          user_id: userId,
          net_profit: result.net_profit,
          operationId
        });
        
        // Emit wallet balance update event
        try {
          portfolioEvents.emitUserUpdate('strategy_provider', userId.toString(), { 
            type: 'wallet_balance_update', 
            order_id: orderId 
          });
        } catch (_) {}
      }
    } catch (e) {
      logger.warn('Failed to apply wallet payout on strategy provider local close', { 
        error: e.message, 
        order_id: orderId,
        operationId
      });
    }

    // 4. Update strategy provider net profit (same as live users)
    if (typeof result.net_profit === 'number') {
      await StrategyProviderAccount.increment(
        { net_profit: result.net_profit },
        { where: { id: order.order_user_id } } // Use the specific strategy provider account ID
      );
      
      logger.info('Strategy provider net profit updated after local close', {
        order_id: orderId,
        user_id: userId,
        net_profit: result.net_profit,
        operationId
      });
    }

    // 4. Process copy trading distribution (strategy provider specific)
    await processCopyTradingDistribution(order, operationId);

  } catch (error) {
    logger.error('Failed to handle local flow post-close operations', {
      order_id: orderId,
      user_id: userId,
      error: error.message,
      operationId
    });
  }
}

/**
 * Process copy trading distribution for strategy provider order close
 * Follows Open/Closed Principle - extensible without modification
 * @param {Object} masterOrder - Strategy provider order
 * @param {string} operationId - Operation ID for logging
 */
async function processCopyTradingDistribution(masterOrder, operationId) {
  try {
    logger.info('Processing copy trading distribution for strategy provider close', {
      orderId: masterOrder.order_id,
      orderStatus: masterOrder.order_status,
      operationId
    });

    // Use existing copy trading service
    await copyTradingService.processStrategyProviderOrderUpdate(masterOrder);

    // Update copy distribution status
    await masterOrder.update({
      copy_distribution_status: 'completed',
      copy_distribution_completed_at: new Date()
    });

    logger.info('Copy trading distribution completed successfully', {
      orderId: masterOrder.order_id,
      operationId
    });

  } catch (error) {
    logger.error('Failed to process copy trading distribution', {
      orderId: masterOrder.order_id,
      error: error.message,
      operationId
    });
    
    // Update status to failed but don't throw - this is non-critical
    try {
      await masterOrder.update({
        copy_distribution_status: 'failed',
        copy_distribution_completed_at: new Date()
      });
    } catch (updateErr) {
      logger.error('Failed to update copy distribution status to failed', {
        orderId: masterOrder.order_id,
        error: updateErr.message,
        operationId
      });
    }
  }
}

module.exports = {
  placeStrategyProviderOrder,
  placeStrategyProviderPendingOrder,
  getStrategyProviderOrders,
  closeStrategyProviderOrder,
  getCopyFollowerOrders,
  getCopyFollowerClosedOrders,
  cancelStrategyProviderOrder,
  addStopLossToOrder,
  addTakeProfitToOrder,
  cancelStopLossFromOrder,
  cancelTakeProfitFromOrder
};
