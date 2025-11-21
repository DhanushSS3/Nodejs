const url = require('url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { redisCluster } = require('../../../config/redis');
const LiveUser = require('../../models/liveUser.model');
const DemoUser = require('../../models/demoUser.model');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const StrategyProviderOrder = require('../../models/strategyProviderOrder.model');
const CopyFollowerOrder = require('../../models/copyFollowerOrder.model');
const StrategyProviderAccount = require('../../models/strategyProviderAccount.model');
const logger = require('../logger.service');
const portfolioEvents = require('../events/portfolio.events');

// Connection tracking and limits
const userConnCounts = new Map(); // key: user_type:user_id -> count
const userConnections = new Map(); // key: user_type:user_id -> array of WebSocket objects
const MAX_CONNECTIONS_PER_USER = 5; // Maximum WebSocket connections per user

function getUserKey(userType, userId) {
  return `${String(userType).toLowerCase()}:${String(userId)}`;
}

function shouldRemovePendingImmediately(evt) {
  if (!evt) return false;
  if (evt.type === 'order_opened') {
    return true;
  }
  if (evt.type === 'order_update') {
    const reason = String(evt.reason || '').toLowerCase();
    const status = String(evt.update && evt.update.order_status ? evt.update.order_status : '').toUpperCase();
    if (reason === 'order_opened' || reason === 'pending_triggered' || status === 'OPEN') {
      return true;
    }
  }
  return false;
}

function addConnection(userKey, ws) {
  // Add to connections array
  if (!userConnections.has(userKey)) {
    userConnections.set(userKey, []);
  }
  userConnections.get(userKey).push(ws);
  
  // Update count
  const c = userConnCounts.get(userKey) || 0;
  userConnCounts.set(userKey, c + 1);
  return c + 1;
}

function removeConnection(userKey, ws) {
  // Remove from connections array
  if (userConnections.has(userKey)) {
    const connections = userConnections.get(userKey);
    const index = connections.indexOf(ws);
    if (index > -1) {
      connections.splice(index, 1);
    }
    if (connections.length === 0) {
      userConnections.delete(userKey);
    }
  }
  
  // Update count
  const c = userConnCounts.get(userKey) || 0;
  const n = Math.max(0, c - 1);
  if (n === 0) userConnCounts.delete(userKey);
  else userConnCounts.set(userKey, n);
  return n;
}

function closeOldestConnection(userKey) {
  if (userConnections.has(userKey)) {
    const connections = userConnections.get(userKey);
    if (connections.length > 0) {
      const oldestWs = connections[0]; // First connection is oldest
      logger.info('Closing oldest WebSocket connection due to limit', {
        userKey,
        totalConnections: connections.length,
        maxAllowed: MAX_CONNECTIONS_PER_USER
      });
      try {
        oldestWs.close(1000, 'Connection replaced by newer connection');
      } catch (e) {
        logger.warn('Failed to close oldest connection', { error: e.message, userKey });
      }
    }
  }
}

// Legacy functions for backward compatibility
function incConn(userKey) {
  const c = userConnCounts.get(userKey) || 0;
  userConnCounts.set(userKey, c + 1);
  return c + 1;
}

function decConn(userKey) {
  const c = userConnCounts.get(userKey) || 0;
  const n = Math.max(0, c - 1);
  if (n === 0) userConnCounts.delete(userKey);
  else userConnCounts.set(userKey, n);
  return n;
}

// Safely convert various timestamp representations to ISO string
function toIsoTimeSafe(v) {
  if (v === undefined || v === null || v === '') return undefined;
  
  // If it's already a Date object
  if (v instanceof Date) {
    return !Number.isNaN(v.getTime()) ? v.toISOString() : undefined;
  }
  
  // numeric (ms) or numeric string
  const n = Number(v);
  if (Number.isFinite(n)) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  
  // try parse ISO or other string formats
  const d2 = new Date(String(v));
  if (!Number.isNaN(d2.getTime())) return d2.toISOString();
  
  return undefined;
}

async function fetchAccountSummary(userType, userId) {
  let Model, row;
  
  if (userType === 'strategy_provider') {
    // For strategy providers, get data from StrategyProviderAccount model
    Model = StrategyProviderAccount;
    row = await Model.findByPk(parseInt(userId, 10));
    if (!row) return { balance: '0', margin: '0' };
    return {
      balance: (row.wallet_balance ?? 0).toString(),
      margin: (row.margin ?? 0).toString(),
    };
  } else if (userType === 'copy_follower') {
    // For copy followers, get data from CopyFollowerAccount model using account ID
    const CopyFollowerAccount = require('../../models/copyFollowerAccount.model');
    row = await CopyFollowerAccount.findByPk(parseInt(userId, 10));
    if (!row) return { balance: '0', margin: '0' };
    return {
      balance: (row.wallet_balance ?? 0).toString(),
      margin: (row.margin ?? 0).toString(),
    };
  } else {
    // For live/demo users
    Model = userType === 'live' ? LiveUser : DemoUser;
    row = await Model.findByPk(parseInt(userId, 10));
    if (!row) return { balance: '0', margin: '0' };
    return {
      balance: (row.wallet_balance ?? 0).toString(),
      margin: (row.margin ?? 0).toString(),
    };
  }
}

async function fetchOrdersFromDB(userType, userId) {
  let OrderModel, rows;
  
  if (userType === 'strategy_provider') {
    // For strategy providers, get orders from StrategyProviderOrder model
    OrderModel = StrategyProviderOrder;
    rows = await OrderModel.findAll({ where: { order_user_id: parseInt(userId, 10) } });
  } else if (userType === 'copy_follower') {
    // For copy followers, get orders from CopyFollowerOrder model using copy_follower_account_id
    OrderModel = CopyFollowerOrder;
    rows = await OrderModel.findAll({ where: { copy_follower_account_id: parseInt(userId, 10) } });
  } else {
    // For live/demo users
    OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
    rows = await OrderModel.findAll({ where: { order_user_id: parseInt(userId, 10) } });
  }
  
  const open = [];
  const pending = [];
  const rejected = [];
  
  for (const r of rows) {
    const base = {
      order_id: r.order_id,
      order_company_name: String(r.symbol).toUpperCase(),
      order_type: r.order_type,
      order_quantity: r.order_quantity?.toString?.() ?? String(r.order_quantity ?? ''),
      order_price: r.order_price?.toString?.() ?? String(r.order_price ?? ''),
      margin: r.margin?.toString?.() ?? undefined,
      contract_value: r.contract_value?.toString?.() ?? undefined,
      stop_loss: r.stop_loss?.toString?.() ?? null,
      take_profit: r.take_profit?.toString?.() ?? null,
      order_user_id: r.order_user_id,
      order_status: r.order_status,
      commission: r.commission?.toString?.() ?? null,
      swap: r.swap?.toString?.() ?? null,
      close_message: r.close_message,
      created_at: toIsoTimeSafe(r.created_at),
    };
    
    // Add copy trading specific fields for copy followers
    if (userType === 'copy_follower') {
      base.master_order_id = r.master_order_id;
      base.copy_status = r.copy_status;
      base.strategy_provider_id = r.strategy_provider_id;
    }
    
    // Add copy trading specific fields for strategy providers
    if (userType === 'strategy_provider') {
      base.copy_distribution_status = r.copy_distribution_status;
      base.is_master_order = r.is_master_order;
    }
    
    const status = String(r.order_status).toUpperCase();
    if (status === 'OPEN') open.push(base);
    else if (status === 'PENDING') pending.push(base);
    else if (status === 'REJECTED') rejected.push(base);
    // Note: CANCELLED orders are not included in any category (they're removed from UI)
    // Note: CLOSED orders are not included in any category (they're in order history)
  }
  return { open, pending, rejected };
}

async function fetchOpenOrdersFromRedis(userType, userId) {
  // For copy followers, use copy_follower:account_id format for Redis keys
  const tag = userType === 'copy_follower' ? `copy_follower:${userId}` : `${userType}:${userId}`;
  const indexKey = `user_orders_index:{${tag}}`;
  let ids;
  try {
    ids = await redisCluster.smembers(indexKey);
  } catch (e) {
    logger.error('Redis error reading orders index', { error: e.message, indexKey });
    return [];
  }
  const pipe = redisCluster.pipeline();
  const keys = [];
  for (const id of ids) {
    const k = `user_holdings:{${tag}}:${id}`;
    keys.push({ id, k });
    pipe.hgetall(k);
  }
  let results = [];
  try {
    const res = await pipe.exec();
    results = (res || []).map(([err, data], i) => {
      if (err) return null;
      const row = data || {};
      if (userType === 'copy_follower') {
        logger.info('Copy follower open-order snapshot row', {
          userType,
          userId,
          orderId: keys[i]?.id,
          hasCreatedAt: row.created_at != null,
          created_at: row.created_at,
        });
      }
      // Only include OPEN orders
      if (String(row.order_status || '').toUpperCase() !== 'OPEN') return null;
      return {
        order_id: row.order_id || keys[i].id,
        order_company_name: (row.symbol || '').toString().toUpperCase(),
        order_type: row.order_type,
        order_quantity: row.order_quantity,
        order_price: row.order_price,
        margin: row.margin,
        contract_value: row.contract_value,
        stop_loss: row.stop_loss ?? null,
        take_profit: row.take_profit ?? null,
        order_user_id: parseInt(userId, 10),
        order_status: row.order_status,
        commission: row.commission ?? null,
        swap: row.swap ?? null,
        created_at: toIsoTimeSafe(row.created_at),
      };
    }).filter(Boolean);
  } catch (e) {
    logger.error('Redis pipeline error reading holdings', { error: e.message });
  }
  return results;
}

function buildPayload({ balance, margin, openOrders, pendingOrders, rejectedOrders }) {
  return {
    type: 'market_update',
    data: {
      account_summary: {
        balance: balance ?? '0',
        margin: margin ?? '0',
        open_orders: openOrders || [],
        pending_orders: pendingOrders || [],
        rejected_orders: rejectedOrders || [],
      }
    }
  };
}

function startPortfolioWSServer(server) {
  // By default, ws allows connections from all origins.
  // If you want to restrict, use verifyClient or handle 'origin' header manually.
  const wss = new WebSocketServer({ server, path: '/ws/portfolio' });
  const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

  wss.on('connection', async (ws, req) => {
    const params = url.parse(req.url, true);
    const token = params.query.token;
    const copyFollowerAccountId = params.query.copy_follower_account_id;

    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
      if (!user || !user.is_active) {
        ws.close(4401, 'Inactive or invalid user');
        return;
      }
    } catch (e) {
      ws.close(4401, 'Invalid token');
      return;
    }

    // Determine user ID and type based on JWT structure and parameters
    let userId, userType, copyFollowerAccount = null;
    
    if (copyFollowerAccountId) {
      // Copy follower account connection - validate ownership
      const mainUserId = user.sub || user.user_id || user.id;
      
      try {
        const CopyFollowerAccount = require('../../models/copyFollowerAccount.model');
        copyFollowerAccount = await CopyFollowerAccount.findOne({
          where: {
            id: parseInt(copyFollowerAccountId, 10),
            user_id: mainUserId,
            status: 1,
            is_active: 1
          }
        });
        
        if (!copyFollowerAccount) {
          ws.close(4403, 'Copy follower account not found or access denied');
          return;
        }
        
        userId = copyFollowerAccount.id; // Use copy follower account ID as userId
        userType = 'copy_follower';
        
      } catch (error) {
        logger.error('Copy follower account validation failed', { 
          error: error.message, 
          copyFollowerAccountId,
          mainUserId 
        });
        ws.close(4500, 'Internal server error during account validation');
        return;
      }
      
    } else if (user.account_type === 'strategy_provider' && user.strategy_provider_id) {
      // Strategy provider: use strategy_provider_id as userId
      userId = user.strategy_provider_id;
      userType = 'strategy_provider';
    } else {
      // Live/Demo user: use regular user ID and account type
      userId = user.sub || user.user_id || user.id;
      userType = (user.account_type || user.user_type || 'live').toString().toLowerCase();
    }
    
    const userKey = getUserKey(userType, userId);

    // Check connection limit and close oldest if needed
    const currentCount = userConnCounts.get(userKey) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_USER) {
      logger.info('WebSocket connection limit reached, closing oldest connection', { 
        userId, 
        userType, 
        currentConnections: currentCount, 
        maxAllowed: MAX_CONNECTIONS_PER_USER 
      });
      closeOldestConnection(userKey);
    }

    // Add new connection
    const cnt = addConnection(userKey, ws);

    logger.info('WS portfolio connected', { userId, userType, connections: cnt, maxAllowed: MAX_CONNECTIONS_PER_USER });

    let alive = true;
    ws.on('close', () => {
      alive = false;
      removeConnection(userKey, ws);
      logger.info('WS portfolio closed', { 
        userId, 
        userType, 
        remainingConnections: userConnCounts.get(userKey) || 0 
      });
    });

    // Ping-pong keepalive
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const pingInterval = setInterval(() => {
      if (!alive) { clearInterval(pingInterval); return; }
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }, 30000);

    // Helper: send a snapshot
    const sendSnapshot = async (reason, evt) => {
      try {
        const [summary, openOrders] = await Promise.all([
          fetchAccountSummary(userType, userId),
          fetchOpenOrdersFromRedis(userType, userId),
        ]);
        // Refresh pending/rejected orders from DB at most every 10s
        const now = Date.now();
        // Force DB refresh when pending is confirmed/cancelled so UI reflects immediately
        const isOrderUpdate = evt && evt.type === 'order_update';
        const reasonStr = evt && evt.reason ? String(evt.reason) : '';
        const updateStatus = isOrderUpdate && evt.update && evt.update.order_status ? String(evt.update.order_status).toUpperCase() : '';
        const forceDbRefresh = (
          (evt && evt.type === 'order_rejected') ||
          (evt && evt.type === 'order_opened') ||
          (evt && evt.type === 'order_closed') ||
          (evt && evt.type === 'stoploss_triggered') ||
          (evt && evt.type === 'takeprofit_triggered') ||
          (evt && evt.type === 'stoploss_cancelled') ||
          (evt && evt.type === 'takeprofit_cancelled') ||
          (evt && evt.type === 'order_rejection_created') ||
          (evt && evt.type === 'pending_cancelled') ||
          (evt && evt.type === 'order_pending_confirmed') ||
          (isOrderUpdate && (reasonStr === 'pending_confirmed' || reasonStr === 'pending_cancelled' || reasonStr === 'local_pending_cancel' || reasonStr === 'pending_modified' || reasonStr === 'pending_triggered' || reasonStr === 'order_opened' || reasonStr === 'order_closed' || reasonStr === 'stoploss_triggered' || reasonStr === 'takeprofit_triggered' || reasonStr === 'stoploss_cancelled' || reasonStr === 'takeprofit_cancelled')) ||
          (isOrderUpdate && (updateStatus === 'PENDING' || updateStatus === 'REJECTED' || updateStatus === 'CANCELLED' || updateStatus === 'OPEN' || updateStatus === 'CLOSED'))
        );
        
        // Debug logging for pending confirmation events
        if (evt && (evt.type === 'order_update' && evt.reason === 'pending_confirmed')) {
          logger.info('WebSocket processing pending confirmation - force refresh check', {
            userId,
            userType,
            eventType: evt.type,
            reason: evt.reason,
            orderId: evt.order_id,
            forceDbRefresh,
            isOrderUpdate,
            reasonStr,
            updateStatus
          });
        }
        
        if (evt && evt.type === 'order_pending_confirmed') {
          logger.info('WebSocket processing dedicated pending confirmation - force refresh check', {
            userId,
            userType,
            eventType: evt.type,
            orderId: evt.order_id,
            forceDbRefresh
          });
        }
        const shouldDropPending = shouldRemovePendingImmediately(evt);
        const resolvedOrderId = shouldDropPending && evt && evt.order_id ? String(evt.order_id) : null;

        if (resolvedOrderId && ws._lastPending && ws._lastPending.length) {
          const beforeCount = ws._lastPending.length;
          ws._lastPending = ws._lastPending.filter(o => String(o.order_id) !== resolvedOrderId);
          if (beforeCount !== ws._lastPending.length) {
            logger.info('Removed pending order from cached snapshot due to open transition', {
              userId,
              userType,
              orderId: resolvedOrderId,
              beforeCount,
              afterCount: ws._lastPending.length,
            });
          }
        }

        if (forceDbRefresh || !ws._lastPendingFetch || (now - ws._lastPendingFetch) > 10000) {
          // Add small delay for pending confirmations to ensure database consistency
          if (evt && (evt.type === 'order_update' && evt.reason === 'pending_confirmed')) {
            logger.info('Adding delay for pending confirmation database fetch to ensure consistency', {
              userId,
              userType,
              orderId: evt.order_id
            });
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
          }
          
          if (evt && evt.type === 'order_pending_confirmed') {
            logger.info('Adding delay for dedicated pending confirmation database fetch to ensure consistency', {
              userId,
              userType,
              orderId: evt.order_id
            });
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
          }
          
          const dbOrders = await fetchOrdersFromDB(userType, userId);
          ws._lastPending = dbOrders.pending;
          ws._lastRejected = dbOrders.rejected;
          ws._lastPendingFetch = now;

          if (resolvedOrderId && ws._lastPending && ws._lastPending.length) {
            const beforeCount = ws._lastPending.length;
            ws._lastPending = ws._lastPending.filter(o => String(o.order_id) !== resolvedOrderId);
            if (beforeCount !== ws._lastPending.length) {
              logger.info('Filtered pending order from DB snapshot due to open transition', {
                userId,
                userType,
                orderId: resolvedOrderId,
                beforeCount,
                afterCount: ws._lastPending.length,
              });
            }
          }

          // Debug logging for pending confirmation database fetch results
          if (evt && (evt.type === 'order_update' && evt.reason === 'pending_confirmed')) {
            logger.info('Database fetch completed for pending confirmation', {
              userId,
              userType,
              orderId: evt.order_id,
              pendingOrdersFound: dbOrders.pending.length,
              rejectedOrdersFound: dbOrders.rejected.length,
              pendingOrderIds: dbOrders.pending.map(o => o.order_id)
            });
          }
          
          if (evt && evt.type === 'order_pending_confirmed') {
            logger.info('Database fetch completed for dedicated pending confirmation', {
              userId,
              userType,
              orderId: evt.order_id,
              pendingOrdersFound: dbOrders.pending.length,
              rejectedOrdersFound: dbOrders.rejected.length,
              pendingOrderIds: dbOrders.pending.map(o => o.order_id)
            });
          }
        }
        const payload = buildPayload({
          balance: summary.balance,
          margin: summary.margin,
          openOrders,
          pendingOrders: ws._lastPending || [],
          rejectedOrders: ws._lastRejected || [],
        });
        
        // Debug logging for pending confirmation WebSocket sends
        if (evt && (evt.type === 'order_update' && evt.reason === 'pending_confirmed')) {
          logger.info('WebSocket sending pending confirmation update to client', {
            userId,
            userType,
            eventType: evt.type,
            eventReason: evt.reason,
            orderId: evt.order_id,
            pendingOrdersCount: (ws._lastPending || []).length,
            snapshotReason: reason
          });
        }
        
        if (evt && evt.type === 'order_pending_confirmed') {
          logger.info('WebSocket sending dedicated pending confirmation update to client', {
            userId,
            userType,
            eventType: evt.type,
            orderId: evt.order_id,
            pendingOrdersCount: (ws._lastPending || []).length,
            snapshotReason: reason
          });
        }
        
        ws.send(JSON.stringify(payload));
      } catch (e) {
        logger.error('WS sendSnapshot failed', { error: e.message, userId, userType, reason, evt });
      }
    };

    // Initial snapshot
    await sendSnapshot('initial');

    // Event-driven updates: subscribe to user events
    const unsubscribe = portfolioEvents.onUserUpdate(userType, userId, async (evt) => {
      if (!alive) return;
      
      // Debug logging for pending order events
      if (evt && (evt.type === 'order_update' && evt.reason === 'pending_confirmed')) {
        logger.info('WebSocket received pending confirmation event', {
          userId,
          userType,
          eventType: evt.type,
          reason: evt.reason,
          orderId: evt.order_id
        });
      }
      
      if (evt && evt.type === 'order_pending_confirmed') {
        logger.info('WebSocket received dedicated pending confirmation event', {
          userId,
          userType,
          eventType: evt.type,
          orderId: evt.order_id
        });
      }
      
      await sendSnapshot('event', evt);
    });

    // Periodic safety resync every 30s
    const resync = setInterval(async () => {
      if (!alive) { clearInterval(resync); return; }
      await sendSnapshot('resync');
    }, 30000);

    // Cleanup on close
    ws.on('close', () => {
      try { unsubscribe && unsubscribe(); } catch (_) {}
      try { clearInterval(resync); } catch (_) {}
    });
  });

  logger.info('WebSocket /ws/portfolio started');
  return wss;
}

module.exports = { startPortfolioWSServer };
