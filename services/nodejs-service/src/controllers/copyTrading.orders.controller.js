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
const lotValidationService = require('../services/lot.validation.service');
const groupsCache = require('../services/groups.cache.service');

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
    if (!Number.isNaN(provided_close_price) && provided_close_price > 0) pyPayload.close_price = provided_close_price;
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
    await order.update({
      order_status: 'CLOSED',
      close_price: provided_close_price || result.close_price,
      net_profit: result.net_profit || 0,
      commission: result.total_commission || 0,
      swap: result.swap || 0,
      copy_distribution_status: 'pending', // Will be updated after copy trading
      copy_distribution_completed_at: null
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

    // First, find the strategy provider account for this user
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { user_id: tokenUserId }
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
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { user_id: tokenUserId }
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

    if (order.order_status !== 'OPEN') {
      return res.status(400).json({ 
        success: false, 
        message: 'Can only add stop loss to open orders' 
      });
    }

    // Generate stop loss ID (same as live users)
    const stoploss_id = await idGenerator.generateOrderId();

    // Persist lifecycle ID (same as live users)
    try {
      if (stoploss_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'stoploss_id', stoploss_id);
      }
    } catch (e) {
      logger.warn('Failed to persist stoploss lifecycle id', { order_id, stoploss_id, error: e.message });
    }

    // Build payload to Python (same pattern as live users)
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: tokenUserId.toString(),
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
      operationId
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
    
    // Strategy provider role validation
    if (role && role !== 'strategy_provider') {
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
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { user_id: tokenUserId }
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

    if (order.order_status !== 'OPEN') {
      return res.status(400).json({ 
        success: false, 
        message: 'Can only add take profit to open orders' 
      });
    }

    // Generate take profit ID
    const takeprofit_id = await idGenerator.generateOrderId();

    // Persist lifecycle ID
    try {
      if (takeprofit_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'takeprofit_id', takeprofit_id);
      }
    } catch (e) {
      logger.warn('Failed to persist takeprofit lifecycle id', { order_id, takeprofit_id, error: e.message });
    }

    // Build payload to Python
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: tokenUserId.toString(),
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
    const stoploss_id = body.stoploss_id || await idGenerator.generateOrderId();

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }

    // First, find the strategy provider account for this user
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { user_id: tokenUserId }
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

    // Persist lifecycle ID
    try {
      if (stoploss_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'stoploss_cancel_id', stoploss_id);
      }
    } catch (e) {
      logger.warn('Failed to persist stoploss cancel lifecycle id', { order_id, stoploss_id, error: e.message });
    }

    // Build payload to Python
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: tokenUserId.toString(),
      user_type: 'strategy_provider',
      order_id,
      status: 'STOPLOSS_CANCEL',
      order_status: 'OPEN',
      stoploss_id
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
      stoploss_id,
      strategyProviderId: tokenUserId,
      operationId
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      stoploss_cancel_id: stoploss_id,
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
    const takeprofit_id = body.takeprofit_id || await idGenerator.generateOrderId();

    if (!order_id) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }

    // First, find the strategy provider account for this user
    const strategyAccount = await StrategyProviderAccount.findOne({
      where: { user_id: tokenUserId }
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

    if (!order.take_profit) {
      return res.status(400).json({ 
        success: false, 
        message: 'No take profit to cancel' 
      });
    }

    // Persist lifecycle ID
    try {
      if (takeprofit_id) {
        await orderLifecycleService.addLifecycleId(order_id, 'takeprofit_cancel_id', takeprofit_id);
      }
    } catch (e) {
      logger.warn('Failed to persist takeprofit cancel lifecycle id', { order_id, takeprofit_id, error: e.message });
    }

    // Build payload to Python
    const pyPayload = {
      symbol: order.symbol,
      order_type: order.order_type,
      user_id: tokenUserId.toString(),
      user_type: 'strategy_provider',
      order_id,
      status: 'TAKEPROFIT_CANCEL',
      order_status: 'OPEN',
      takeprofit_id
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
      takeprofit_id,
      strategyProviderId: tokenUserId,
      operationId
    });

    return res.status(200).json({
      success: true,
      data: result,
      order_id,
      takeprofit_cancel_id: takeprofit_id,
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

    // 3. Update strategy provider net profit (same as live users)
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
  getStrategyProviderOrders,
  closeStrategyProviderOrder,
  getCopyFollowerOrders,
  cancelStrategyProviderOrder,
  addStopLossToOrder,
  addTakeProfitToOrder,
  cancelStopLossFromOrder,
  cancelTakeProfitFromOrder
};
