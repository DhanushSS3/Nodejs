const url = require('url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { redisCluster } = require('../../../config/redis');
const LiveUser = require('../../models/liveUser.model');
const DemoUser = require('../../models/demoUser.model');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const logger = require('../logger.service');

// In-memory connection tracking: limit to 2 connections per user
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
      created_at: r.created_at?.toISOString?.() ?? undefined,
    };
    if (String(r.order_status).toUpperCase() === 'OPEN') open.push(base);
    else if (String(r.order_status).toUpperCase() === 'PENDING') pending.push(base);
  }
  return { open, pending };
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
        created_at: row.created_at ? new Date(Number(row.created_at)).toISOString() : undefined,
      };
    }).filter(Boolean);
  } catch (e) {
    logger.error('Redis pipeline error reading holdings', { error: e.message });
  }
  return results;
}

function buildPayload({ balance, margin, openOrders, pendingOrders }) {
  return {
    type: 'market_update',
    data: {
      account_summary: {
        balance: balance ?? '0',
        margin: margin ?? '0',
        open_orders: openOrders || [],
        pending_orders: pendingOrders || [],
      }
    }
  };
}

function startPortfolioWSServer(server) {
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

    // Rate limit: max 2 concurrent per user
    const cnt = incConn(userKey);
    if (cnt > 2) {
      decConn(userKey);
      ws.close(4429, 'Too many connections for this user');
      return;
    }

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

    // Initial snapshot from DB
    try {
      const [summary, dbOrders] = await Promise.all([
        fetchAccountSummary(userType, userId),
        fetchOrdersFromDB(userType, userId),
      ]);
      const payload = buildPayload({
        balance: summary.balance,
        margin: summary.margin,
        openOrders: dbOrders.open,
        pendingOrders: dbOrders.pending,
      });
      ws.send(JSON.stringify(payload));
    } catch (e) {
      logger.error('WS initial snapshot failed', { error: e.message, userId, userType });
    }

    // Periodic incremental updates from Redis (open orders) and DB refresh for pending (lightweight)
    const loop = setInterval(async () => {
      if (!alive) { clearInterval(loop); return; }
      try {
        const [summary, openOrders] = await Promise.all([
          fetchAccountSummary(userType, userId),
          fetchOpenOrdersFromRedis(userType, userId),
        ]);
        // Optional: refresh pending orders from DB every 10s
        const now = Date.now();
        if (!ws._lastPendingFetch || (now - ws._lastPendingFetch) > 10000) {
          const dbOrders = await fetchOrdersFromDB(userType, userId);
          ws._lastPending = dbOrders.pending;
          ws._lastPendingFetch = now;
        }
        const payload = buildPayload({
          balance: summary.balance,
          margin: summary.margin,
          openOrders,
          pendingOrders: ws._lastPending || [],
        });
        ws.send(JSON.stringify(payload));
      } catch (e) {
        logger.error('WS periodic update failed', { error: e.message, userId, userType });
      }
    }, 1000);
  });

  logger.info('WebSocket /ws/portfolio started');
  return wss;
}

module.exports = { startPortfolioWSServer };
