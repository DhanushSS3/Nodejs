const url = require('url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { Op, fn, col } = require('sequelize');

const logger = require('../logger.service');
const { getSession } = require('../../utils/redisSession.util');
const portfolioEvents = require('../events/portfolio.events');

const MAMAccount = require('../../models/mamAccount.model');
const MAMAssignment = require('../../models/mamAssignment.model');
const LiveUser = require('../../models/liveUser.model');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const MAMOrder = require('../../models/mamOrder.model');

const { ASSIGNMENT_STATUS } = require('../../constants/mamAssignment.constants');

const MAX_ASSIGNMENT_REFRESH_INTERVAL_MS = 30_000;
const SNAPSHOT_RESYNC_INTERVAL_MS = 30_000;

const mamConnections = new Map(); // mam_account_id -> Set<WebSocket>

async function fetchMamAccountSummary(mamAccountId) {
  const account = await MAMAccount.findByPk(mamAccountId, {
    attributes: ['id', 'mam_name', 'total_balance', 'total_used_margin', 'mam_balance', 'total_investors']
  });

  if (!account) return null;

  return {
    mam_account_id: account.id,
    mam_name: account.mam_name,
    balance: (account.total_balance ?? 0).toString(),
    margin: (account.total_used_margin ?? 0).toString(),
    mam_balance: (account.mam_balance ?? 0).toString(),
    total_investors: account.total_investors ?? 0
  };
}

async function fetchActiveAssignments(mamAccountId) {
  const assignments = await MAMAssignment.findAll({
    where: {
      mam_account_id: mamAccountId,
      status: ASSIGNMENT_STATUS.ACTIVE
    },
    include: [
      {
        model: LiveUser,
        as: 'client',
        attributes: ['id', 'name', 'account_number', 'email']
      }
    ]
  });

  return assignments.map((assignment) => ({
    assignment_id: assignment.id,
    client_live_user_id: assignment.client_live_user_id,
    client_name: assignment.client?.name ?? null,
    client_account_number: assignment.client?.account_number ?? null,
    client_email: assignment.client?.email ?? null
  }));
}

async function fetchMamOrders(mamAccountId) {
  const orders = await MAMOrder.findAll({
    where: {
      mam_account_id: mamAccountId
    },
    order: [['created_at', 'DESC']]
  });

  const openOrderIds = orders
    .filter((o) => String(o.order_status || '').toUpperCase() === 'OPEN')
    .map((o) => o.id);

  const contractValueByMamOrderId = new Map();
  const commissionByMamOrderId = new Map();
  const swapByMamOrderId = new Map();
  if (openOrderIds.length) {
    try {
      const rows = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: { [Op.in]: openOrderIds },
          order_status: 'OPEN'
        },
        attributes: [
          'parent_mam_order_id',
          [fn('SUM', col('contract_value')), 'total_contract_value'],
          [fn('SUM', col('commission')), 'total_commission'],
          [fn('SUM', col('swap')), 'total_swap']
        ],
        group: ['parent_mam_order_id']
      });

      for (const r of rows || []) {
        const pid = r.parent_mam_order_id;
        const total = r.get ? r.get('total_contract_value') : r.total_contract_value;
        const totalCommission = r.get ? r.get('total_commission') : r.total_commission;
        const totalSwap = r.get ? r.get('total_swap') : r.total_swap;
        if (pid != null && total != null && Number.isFinite(Number(total))) {
          contractValueByMamOrderId.set(Number(pid), String(Number(total).toFixed(8)));
        }
        if (pid != null && totalCommission != null && Number.isFinite(Number(totalCommission))) {
          commissionByMamOrderId.set(Number(pid), String(Number(totalCommission).toFixed(8)));
        }
        if (pid != null && totalSwap != null && Number.isFinite(Number(totalSwap))) {
          swapByMamOrderId.set(Number(pid), String(Number(totalSwap).toFixed(8)));
        }
      }
    } catch (e) {
      logger.warn('Failed to aggregate contract_value for MAM WS orders', {
        error: e.message,
        mamAccountId
      });
    }
  }

  const open = [];
  const pending = [];
  const rejected = [];

  for (const order of orders) {
    const status = String(order.order_status || '').toUpperCase();
    let bucket = null;

    if (status === 'OPEN') {
      bucket = open;
    } else if (['PENDING', 'MODIFY'].includes(status)) {
      bucket = pending;
    } else if (['REJECTED'].includes(status)) {
      bucket = rejected;
    }

    if (!bucket) continue;

    const pendingRequestedPrice = (() => {
      try {
        const raw = order?.metadata?.order_price;
        const n = Number(raw);
        return Number.isFinite(n) ? String(raw) : null;
      } catch (_) {
        return null;
      }
    })();

    const pendingAllocatedQty = (() => {
      try {
        const snap = Array.isArray(order.allocation_snapshot) ? order.allocation_snapshot : [];
        const sum = snap
          .filter((e) => String(e?.status || '').toLowerCase() === 'pending_submitted')
          .reduce((acc, e) => acc + (Number(e?.allocated_volume || 0) || 0), 0);
        return Number.isFinite(sum) && sum > 0 ? String(Number(sum.toFixed(8))) : null;
      } catch (_) {
        return null;
      }
    })();

    let createdAtIso = null;
    const rawCreatedAt = order.created_at;
    if (rawCreatedAt) {
      try {
        const dateObj = rawCreatedAt instanceof Date ? rawCreatedAt : new Date(rawCreatedAt);
        if (!Number.isNaN(dateObj.getTime())) {
          createdAtIso = dateObj.toISOString();
        }
      } catch (_) {
        createdAtIso = null;
      }
    }

    const base = {
      // Core fields aligned with live /ws/portfolio order schema
      order_id: order.id,
      order_company_name: String(order.symbol || '').toUpperCase(),
      order_type: order.order_type,
      order_quantity: status === 'OPEN'
        ? (order.executed_volume?.toString?.() ?? order.requested_volume?.toString?.() ?? '')
        : (pendingAllocatedQty ?? order.requested_volume?.toString?.() ?? ''),
      order_price: status === 'OPEN'
        ? (order.average_entry_price?.toString?.() ?? null)
        : (pendingRequestedPrice ?? null),
      margin: order.total_aggregated_margin?.toString?.() ?? undefined,
      contract_value: status === 'OPEN'
        ? (contractValueByMamOrderId.get(Number(order.id)) ?? undefined)
        : undefined,
      stop_loss: order.stop_loss?.toString?.() ?? null,
      take_profit: order.take_profit?.toString?.() ?? null,
      order_user_id: order.mam_account_id,
      order_status: order.order_status,
      commission: status === 'OPEN'
        ? (commissionByMamOrderId.get(Number(order.id)) ?? '0.00000000')
        : null,
      swap: status === 'OPEN'
        ? (swapByMamOrderId.get(Number(order.id)) ?? '0.00000000')
        : null,
      close_message: order.close_message || null,
      created_at: createdAtIso,

      // MAM-specific extras kept for richer UI
      mam_account_id: order.mam_account_id,
      symbol: order.symbol,
      requested_volume: order.requested_volume?.toString?.() ?? String(order.requested_volume ?? ''),
      executed_volume: order.executed_volume?.toString?.() ?? String(order.executed_volume ?? ''),
      average_entry_price: order.average_entry_price?.toString?.() ?? null,
      average_exit_price: order.average_exit_price?.toString?.() ?? null,
      gross_profit: order.gross_profit?.toString?.() ?? null,
      net_profit_after_fees: order.net_profit_after_fees?.toString?.() ?? null,
      slippage_bps: order.slippage_bps?.toString?.() ?? null,
      rejected_investors_count: order.rejected_investors_count,
      rejected_volume: order.rejected_volume?.toString?.() ?? null
    };

    bucket.push(base);
  }

  return { open, pending, rejected };
}

function buildPayload(summary, orders) {
  const safeSummary = summary || {
    mam_account_id: null,
    mam_name: null,
    balance: '0',
    margin: '0',
    mam_balance: '0',
    total_investors: 0
  };

  return {
    type: 'market_update',
    data: {
      account_summary: {
        balance: safeSummary.balance ?? '0',
        margin: safeSummary.margin ?? '0',
        mam_balance: safeSummary.mam_balance ?? '0',
        total_investors: safeSummary.total_investors ?? 0,
        mam_account_id: safeSummary.mam_account_id,
        mam_name: safeSummary.mam_name,
        open_orders: orders.open,
        pending_orders: orders.pending,
        rejected_orders: orders.rejected
      }
    }
  };
}

async function syncAssignments(ws, mamAccountId, force = false) {
  const now = Date.now();
  if (!force && ws._lastAssignmentSync && (now - ws._lastAssignmentSync) < MAX_ASSIGNMENT_REFRESH_INTERVAL_MS) {
    return ws._assignmentCache || [];
  }

  const assignments = await fetchActiveAssignments(mamAccountId);
  const nextIds = new Set(assignments.map((a) => String(a.client_live_user_id)));
  const existingIds = ws._clientListeners ? new Set(ws._clientListeners.keys()) : new Set();

  // Initialize storage
  if (!ws._clientListeners) {
    ws._clientListeners = new Map();
  }

  // Add new listeners
  for (const assignment of assignments) {
    const clientId = String(assignment.client_live_user_id);
    if (ws._clientListeners.has(clientId)) continue;

    const unsubscribe = portfolioEvents.onUserUpdate('live', clientId, async (evt) => {
      if (ws.readyState !== ws.OPEN) return;
      await queueSnapshot(ws, mamAccountId, 'client_event', evt);
    });

    ws._clientListeners.set(clientId, unsubscribe);
  }

  // Remove listeners for unassigned clients
  for (const [clientId, unsubscribe] of ws._clientListeners.entries()) {
    if (nextIds.has(clientId)) continue;
    try { unsubscribe && unsubscribe(); } catch (_) { /* noop */ }
    ws._clientListeners.delete(clientId);
  }

  ws._assignmentCache = assignments;
  ws._lastAssignmentSync = now;
  return assignments;
}

async function sendSnapshot(ws, mamAccountId, reason = 'snapshot') {
  if (ws.readyState !== ws.OPEN) return;

  try {
    const assignments = await syncAssignments(ws, mamAccountId, reason !== 'client_event');

    const [summary, orders] = await Promise.all([
      fetchMamAccountSummary(mamAccountId),
      fetchMamOrders(mamAccountId)
    ]);

    const payload = buildPayload(summary, orders);
    ws.send(JSON.stringify(payload));
  } catch (error) {
    logger.error('MAM WS snapshot failed', {
      error: error.message,
      mamAccountId,
      reason
    });
  }
}

function queueSnapshot(ws, mamAccountId, reason) {
  ws._snapshotChain = (ws._snapshotChain || Promise.resolve())
    .then(() => sendSnapshot(ws, mamAccountId, reason))
    .catch((error) => {
      logger.error('MAM WS snapshot chain error', { error: error.message, mamAccountId });
    });
  return ws._snapshotChain;
}

function trackConnection(mamAccountId, ws) {
  if (!mamConnections.has(mamAccountId)) {
    mamConnections.set(mamAccountId, new Set());
  }
  mamConnections.get(mamAccountId).add(ws);
  return mamConnections.get(mamAccountId).size;
}

function untrackConnection(mamAccountId, ws) {
  if (!mamConnections.has(mamAccountId)) return 0;
  const set = mamConnections.get(mamAccountId);
  set.delete(ws);
  if (set.size === 0) mamConnections.delete(mamAccountId);
  return set.size;
}

function cleanupClientListeners(ws) {
  if (ws._mamAccountListener) {
    try { ws._mamAccountListener(); } catch (_) { /* noop */ }
    ws._mamAccountListener = null;
  }

  if (!ws._clientListeners) return;
  for (const unsubscribe of ws._clientListeners.values()) {
    try { unsubscribe && unsubscribe(); } catch (_) { /* noop */ }
  }
  ws._clientListeners.clear();
}

function createMamPortfolioWSServer() {
  const wss = new WebSocketServer({ noServer: true, path: '/ws/mam/portfolio' });
  const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

  wss.on('connection', async (ws, req) => {
    const params = url.parse(req.url, true);
    const token = params.query.token;

    if (!token) {
      ws.close(4401, 'Token required');
      return;
    }

    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      ws.close(4401, 'Invalid token');
      return;
    }

    if (!user || user.account_type !== 'mam_manager' || !user.is_active) {
      ws.close(4403, 'Not authorized for MAM portfolio');
      return;
    }

    const sessionOwnerId = user.sub || user.user_id || user.id;
    const sessionOwnerType = user.account_type || 'mam_manager';
    const sessionIdFromToken = user.session_id || user.sessionId || user.jwtid || user.jti;

    if (!sessionOwnerId || !sessionIdFromToken) {
      ws.close(4401, 'Invalid token session');
      return;
    }

    try {
      const activeSession = await getSession(sessionOwnerId, sessionIdFromToken, sessionOwnerType);
      if (!activeSession) {
        ws.close(4401, 'Token revoked');
        return;
      }
    } catch (err) {
      logger.error('Failed to validate MAM manager session for WebSocket', {
        error: err.message,
        sessionOwnerId,
        sessionOwnerType
      });
      ws.close(4500, 'Unable to validate session');
      return;
    }

    const tokenMamAccountId = user.mam_account_id;
    const requestedMamAccountId = params.query.mam_account_id ? Number(params.query.mam_account_id) : tokenMamAccountId;

    if (!requestedMamAccountId) {
      ws.close(4403, 'mam_account_id missing');
      return;
    }

    if (tokenMamAccountId && Number(tokenMamAccountId) !== Number(requestedMamAccountId)) {
      ws.close(4403, 'Cannot access another MAM account');
      return;
    }

    const mamAccountId = Number(requestedMamAccountId);
    const mamAccount = await MAMAccount.findByPk(mamAccountId);
    if (!mamAccount || mamAccount.status !== 'active') {
      ws.close(4404, 'MAM account not active');
      return;
    }

    ws._mamAccountId = mamAccountId;
    ws._snapshotChain = Promise.resolve();

    const connections = trackConnection(mamAccountId, ws);
    logger.info('MAM portfolio WS connected', { mamAccountId, connections });

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
      cleanupClientListeners(ws);
      const remaining = untrackConnection(mamAccountId, ws);
      logger.info('MAM portfolio WS closed', { mamAccountId, remainingConnections: remaining });
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(pingInterval);
        return;
      }
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (_) { /* noop */ }
        clearInterval(pingInterval);
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* noop */ }
    }, 30_000);

    ws.on('close', () => {
      clearInterval(pingInterval);
      if (ws._resyncInterval) clearInterval(ws._resyncInterval);
    });

    await queueSnapshot(ws, mamAccountId, 'initial');

    ws._mamAccountListener = portfolioEvents.onUserUpdate('mam_account', mamAccountId, async () => {
      if (ws.readyState !== ws.OPEN) return;
      await queueSnapshot(ws, mamAccountId, 'mam_event');
    });

    ws._resyncInterval = setInterval(async () => {
      if (ws.readyState !== ws.OPEN) return;
      await queueSnapshot(ws, mamAccountId, 'resync');
    }, SNAPSHOT_RESYNC_INTERVAL_MS);
  });

  logger.info('WebSocket /ws/mam/portfolio started');
  return wss;
}

module.exports = { createMamPortfolioWSServer };
