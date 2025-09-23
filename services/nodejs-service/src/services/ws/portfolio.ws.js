const url = require('url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { redisCluster } = require('../../../config/redis');
const LiveUser = require('../../models/liveUser.model');
const DemoUser = require('../../models/demoUser.model');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const logger = require('../logger.service');
const portfolioEvents = require('../events/portfolio.events');

// Connection tracking for logging purposes only (no limits)
const userConnCounts = new Map(); // key: user_type:user_id -> count

function getUserKey(userType, userId) {
  return `${String(userType).toLowerCase()}:${String(userId)}`;
}

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
}

// Safely convert various timestamp representations to ISO string
function toIsoTimeSafe(v) {
  if (v === undefined || v === null || v === '') return undefined;
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
  const Model = userType === 'live' ? LiveUser : DemoUser;
  const row = await Model.findByPk(parseInt(userId, 10));
  if (!row) return { balance: '0', margin: '0' };
  return {
    balance: (row.wallet_balance ?? 0).toString(),
    margin: (row.margin ?? 0).toString(),
  };
}

async function fetchOrdersFromDB(userType, userId) {
  const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
  const rows = await OrderModel.findAll({ where: { order_user_id: parseInt(userId, 10) } });
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
      created_at: r.created_at?.toISOString?.() ?? undefined,
    };
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
  const tag = `${userType}:${userId}`;
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

    const userId = user.sub || user.user_id || user.id;
    const userType = (user.account_type || user.user_type || 'live').toString().toLowerCase();
    const userKey = getUserKey(userType, userId);

    // Track connections for logging (no limits enforced)
    const cnt = incConn(userKey);

    logger.info('WS portfolio connected', { userId, userType, connections: cnt });

    let alive = true;
    ws.on('close', () => {
      alive = false;
      decConn(userKey);
      logger.info('WS portfolio closed', { userId, userType });
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
          (evt && evt.type === 'order_rejection_created') ||
          (evt && evt.type === 'pending_cancelled') ||
          (isOrderUpdate && (reasonStr === 'pending_confirmed' || reasonStr === 'pending_cancelled' || reasonStr === 'local_pending_cancel' || reasonStr === 'pending_modified' || reasonStr === 'pending_triggered')) ||
          (isOrderUpdate && (updateStatus === 'PENDING' || updateStatus === 'REJECTED' || updateStatus === 'CANCELLED'))
        );
        if (forceDbRefresh || !ws._lastPendingFetch || (now - ws._lastPendingFetch) > 10000) {
          const dbOrders = await fetchOrdersFromDB(userType, userId);
          ws._lastPending = dbOrders.pending;
          ws._lastRejected = dbOrders.rejected;
          ws._lastPendingFetch = now;
        }
        const payload = buildPayload({
          balance: summary.balance,
          margin: summary.margin,
          openOrders,
          pendingOrders: ws._lastPending || [],
          rejectedOrders: ws._lastRejected || [],
        });
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
