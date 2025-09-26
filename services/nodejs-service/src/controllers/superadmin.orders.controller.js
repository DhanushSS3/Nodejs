const axios = require('axios');
const OrdersIndexRebuildService = require('../services/orders.index.rebuild.service');
const OrdersBackfillService = require('../services/orders.backfill.service');
const { redisCluster } = require('../../config/redis');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const logger = require('../services/logger.service');

function ok(res, data, message = 'OK') {
  return res.status(200).json({ success: true, message, data });
}
function bad(res, message, code = 400) {
  return res.status(code).json({ success: false, message });
}

// POST /api/superadmin/orders/reject-queued
// body: { order_id: string, user_type: 'live'|'demo', user_id: string|number, reason?: string }
async function rejectQueued(req, res) {
  try {
    const order_id = String(req.body.order_id || '').trim();
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const reason = req.body.reason ? String(req.body.reason) : undefined;

    if (!order_id || !['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'order_id, user_type (live|demo) and user_id are required');
    }

    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    const payload = { order_id, user_type, user_id, reason };
    const pyResp = await axios.post(
      `${baseUrl}/api/admin/orders/reject-queued`,
      payload,
      { timeout: 15000, headers: { Authorization: req.headers['authorization'] || '' } }
    );
    const data = pyResp?.data || { success: true };

    // Best-effort DB update: mark order as REJECTED and set close_message
    try {
      const Model = user_type === 'live' ? LiveUserOrder : DemoUserOrder;
      const closeMessage = reason || 'Manual rejection by admin';
      const [affected] = await Model.update(
        { order_status: 'REJECTED', close_message: closeMessage },
        { where: { order_id } }
      );
      if (!affected) {
        logger.warn('DB update for rejected order affected 0 rows', { order_id, user_type, user_id });
      }
    } catch (dbErr) {
      logger.error('Failed to update DB after queued order rejection', { error: dbErr.message, order_id, user_type, user_id });
    }

    return ok(res, data?.data || data, data?.message || 'Queued order rejected');
  } catch (err) {
    const status = err?.response?.status || 500;
    const detail = err?.response?.data || { message: err.message };
    return bad(res, `Failed to reject queued order: ${detail?.message || err.message}`, status);
  }
}

// GET /api/superadmin/orders/queued
// query: { user_type: 'live'|'demo', user_id: string|number }
async function getQueuedOrders(req, res) {
  try {
    const user_type = String((req.query.user_type ?? req.body?.user_type) || '').toLowerCase();
    const user_id = String((req.query.user_id ?? req.body?.user_id) || '').trim();
    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type (live|demo) and user_id are required');
    }
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    const pyResp = await axios.get(
      `${baseUrl}/api/admin/orders/queued/${user_type}/${user_id}`,
      { timeout: 15000, headers: { Authorization: req.headers['authorization'] || '' } }
    );
    const data = pyResp?.data || { success: true };
    return ok(res, data?.data || data, data?.message || 'Queued orders fetched');
  } catch (err) {
    const status = err?.response?.status || 500;
    const detail = err?.response?.data || { message: err.message };
    return bad(res, `Failed to fetch queued orders: ${detail?.message || err.message}`, status);
  }
}

// GET /api/superadmin/orders/margin-status
// query: { user_type: 'live'|'demo', user_id: string|number }
async function getMarginStatus(req, res) {
  try {
    const user_type = String((req.query.user_type ?? req.body?.user_type) || '').toLowerCase();
    const user_id = String((req.query.user_id ?? req.body?.user_id) || '').trim();
    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type (live|demo) and user_id are required');
    }
    const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
    const pyResp = await axios.get(
      `${baseUrl}/api/admin/orders/margin-status/${user_type}/${user_id}`,
      { timeout: 15000, headers: { Authorization: req.headers['authorization'] || '' } }
    );
    const data = pyResp?.data || { success: true };
    return ok(res, data?.data || data, data?.message || 'Margin status fetched');
  } catch (err) {
    const status = err?.response?.status || 500;
    const detail = err?.response?.data || { message: err.message };
    return bad(res, `Failed to fetch margin status: ${detail?.message || err.message}`, status);
  }
}

// POST /api/superadmin/orders/rebuild/user
// body: { user_type: 'live'|'demo', user_id: string|number, include_queued?: boolean, backfill?: boolean, deep?: boolean, prune?: boolean, prune_symbol_holders?: boolean }
async function rebuildUser(req, res) {
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const includeQueued = Boolean(req.body.include_queued);
    const backfill = Boolean(req.body.backfill);
    const deep = (req.body.deep === undefined) ? true : Boolean(req.body.deep);
    const prune = Boolean(req.body.prune);
    const pruneSymbolHolders = Boolean(req.body.prune_symbol_holders);

    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type must be live|demo and user_id is required');
    }

    let result;
    if (backfill) {
      // Backfill holdings from SQL, then ensure index and symbol holders
      result = await OrdersBackfillService.backfillUserHoldingsFromSql(user_type, user_id, { includeQueued });
    } else {
      // Only rebuild indices from existing holdings
      result = await OrdersIndexRebuildService.rebuildUserIndices(user_type, user_id);
    }

    // Perform deep rebuild of execution-related caches (pending, triggers, order_data, user config)
    let deepResult = null;
    if (deep) {
      try {
        deepResult = await OrdersBackfillService.rebuildUserExecutionCaches(user_type, user_id, { includeQueued: true });
      } catch (e) {
        logger.warn('Deep execution-cache rebuild failed', { error: e.message, user_type, user_id });
      }
    }

    // Optional prune of Redis entries not present in SQL
    let pruneResult = null;
    if (prune) {
      try {
        pruneResult = await OrdersBackfillService.pruneUserRedisAgainstSql(user_type, user_id, { deep: true, pruneSymbolHolders });
      } catch (e) {
        logger.warn('Prune against SQL failed', { error: e.message, user_type, user_id });
      }
    }

    const message = backfill
      ? 'User holdings backfilled from SQL and indices rebuilt'
      : 'User indices rebuilt from holdings';
    let data = deep ? { base: result, deep: deepResult } : result;
    if (prune) data = { ...data, prune: pruneResult };
    let msg = deep ? `${message}; execution caches rebuilt` : message;
    if (prune) msg = `${msg}; stale Redis pruned`;
    return ok(res, data, msg);
  } catch (err) {
    return bad(res, `Failed to rebuild user indices: ${err.message}`, 500);
  }
}

// POST /api/superadmin/orders/prune/user
// body: { user_type: 'live'|'demo', user_id: string|number, deep?: boolean, prune_symbol_holders?: boolean }
async function pruneUser(req, res) {
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const deep = (req.body.deep === undefined) ? true : Boolean(req.body.deep);
    const pruneSymbolHolders = Boolean(req.body.prune_symbol_holders);

    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type must be live|demo and user_id is required');
    }

    const result = await OrdersBackfillService.pruneUserRedisAgainstSql(user_type, user_id, { deep, pruneSymbolHolders });
    return ok(res, result, 'Stale Redis entries pruned');
  } catch (err) {
    return bad(res, `Failed to prune user Redis: ${err.message}`, 500);
  }
}

// POST /api/superadmin/orders/rebuild/symbol
// body: { symbol: string, scope?: 'live'|'demo'|'both' }
async function rebuildSymbol(req, res) {
  try {
    const symbol = String(req.body.symbol || '').trim();
    const scope = req.body.scope ? String(req.body.scope).toLowerCase() : 'both';
    if (!symbol) return bad(res, 'symbol is required');
    if (!['live', 'demo', 'both'].includes(scope)) return bad(res, 'scope must be live|demo|both');

    const result = await OrdersIndexRebuildService.rebuildSymbolHolders(symbol, scope);
    return ok(res, result, 'Symbol holders ensured from indices');
  } catch (err) {
    return bad(res, `Failed to rebuild symbol holders: ${err.message}`, 500);
  }
}

// POST /api/superadmin/orders/ensure/holding
// body: { user_type: 'live'|'demo', user_id: string|number, order_id: string }
async function ensureHolding(req, res) {
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const order_id = String(req.body.order_id || '').trim();
    if (!['live', 'demo'].includes(user_type) || !user_id || !order_id) {
      return bad(res, 'user_type (live|demo), user_id and order_id are required');
    }
    const result = await OrdersBackfillService.ensureHoldingFromSql(user_type, user_id, order_id);
    return ok(res, result, 'Holding ensured from SQL');
  } catch (err) {
    return bad(res, `Failed to ensure holding: ${err.message}`, 500);
  }
}

// POST /api/superadmin/orders/ensure/symbol-holder
// body: { user_type: 'live'|'demo', user_id: string|number, symbol: string }
async function ensureSymbolHolder(req, res) {
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const symbol = String(req.body.symbol || '').trim();
    if (!['live', 'demo'].includes(user_type) || !user_id || !symbol) {
      return bad(res, 'user_type (live|demo), user_id and symbol are required');
    }
    const result = await OrdersIndexRebuildService.ensureSymbolHolder(user_type, user_id, symbol);
    return ok(res, result, 'Symbol holder ensured');
  } catch (err) {
    return bad(res, `Failed to ensure symbol holder: ${err.message}`, 500);
  }
}

// GET /api/superadmin/orders/portfolio
// query: { user_type: 'live'|'demo', user_id: string|number }
async function getUserPortfolio(req, res) {
  try {
    // Accept from query (GET) or body (if someone posts)
    const user_type = String((req.query.user_type ?? req.body?.user_type) || '').toLowerCase();
    const user_id = String((req.query.user_id ?? req.body?.user_id) || '').trim();
    const detailed = Boolean(req.query.detailed || req.body?.detailed);

    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type (live|demo) and user_id are required');
    }

    const portfolioKey = `user_portfolio:{${user_type}:${user_id}}`;
    const portfolioData = await redisCluster.hgetall(portfolioKey);

    if (!portfolioData || Object.keys(portfolioData).length === 0) {
      return bad(res, 'Portfolio snapshot not found in Redis for this user', 404);
    }

    // Normalize numeric fields where possible
    const numericFields = ['equity', 'balance', 'free_margin', 'used_margin', 'margin_level', 'open_pnl', 'total_pl', 'ts'];
    const portfolio = { ...portfolioData };
    for (const f of numericFields) {
      if (portfolio[f] !== undefined) {
        const n = Number(portfolio[f]);
        if (!Number.isNaN(n)) portfolio[f] = n;
      }
    }

    // Add calculated fields for better analysis
    const analysis = {
      margin_utilization_percent: portfolio.used_margin && portfolio.balance ? 
        ((portfolio.used_margin / portfolio.balance) * 100).toFixed(2) : null,
      risk_level: portfolio.margin_level >= 100 ? 'LOW' : 
                 portfolio.margin_level >= 50 ? 'MEDIUM' : 'HIGH',
      portfolio_performance: portfolio.open_pnl >= 0 ? 'POSITIVE' : 'NEGATIVE',
      last_updated: portfolio.ts ? new Date(portfolio.ts * 1000).toISOString() : null
    };

    let result = {
      user_type,
      user_id,
      redis_key: portfolioKey,
      portfolio,
      analysis
    };

    // If detailed=true, fetch additional information
    if (detailed) {
      try {
        // Get user configuration
        const userConfigKey = `user:{${user_type}:${user_id}}:config`;
        const userConfig = await redisCluster.hgetall(userConfigKey);

        // Get user orders count
        const indexKey = `user_orders_index:{${user_type}:${user_id}}`;
        const orderIds = await redisCluster.smembers(indexKey);
        
        // Get order details for active orders
        const orderDetails = [];
        if (orderIds && orderIds.length > 0) {
          for (const orderId of orderIds.slice(0, 10)) { // Limit to first 10 for performance
            try {
              const orderKey = `user_holdings:{${user_type}:${user_id}}:${orderId}`;
              const orderData = await redisCluster.hgetall(orderKey);
              if (orderData && Object.keys(orderData).length > 0) {
                orderDetails.push({
                  order_id: orderId,
                  symbol: orderData.symbol,
                  order_type: orderData.order_type,
                  order_status: orderData.order_status,
                  order_price: orderData.order_price,
                  order_quantity: orderData.order_quantity,
                  margin: orderData.margin,
                  created_at: orderData.created_at
                });
              }
            } catch (e) {
              // Skip failed order lookups
            }
          }
        }

        // Get pending orders count
        const pendingKey = `pending_local:{${user_type}:${user_id}}`;
        const pendingOrders = await redisCluster.smembers(pendingKey);

        result.detailed_info = {
          user_config: userConfig || {},
          active_orders_count: orderIds ? orderIds.length : 0,
          pending_orders_count: pendingOrders ? pendingOrders.length : 0,
          recent_orders: orderDetails,
          redis_keys: {
            portfolio: portfolioKey,
            user_config: userConfigKey,
            orders_index: indexKey,
            pending_local: pendingKey
          }
        };
      } catch (detailError) {
        logger.warn('Failed to fetch detailed portfolio info', { 
          error: detailError.message, 
          user_type, 
          user_id 
        });
        result.detailed_info_error = detailError.message;
      }
    }

    return ok(res, result, detailed ? 'Detailed user portfolio fetched from Redis' : 'User portfolio snapshot fetched from Redis');
  } catch (err) {
    return bad(res, `Failed to fetch user portfolio: ${err.message}`, 500);
  }
}

module.exports = {
  rebuildUser,
  rebuildSymbol,
  ensureHolding,
  ensureSymbolHolder,
  getUserPortfolio,
  rejectQueued,
  getQueuedOrders,
  getMarginStatus,
  pruneUser,
};
