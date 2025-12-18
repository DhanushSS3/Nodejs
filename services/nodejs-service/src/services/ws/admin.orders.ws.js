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

// --- Helper Functions (Adapted from portfolio.ws.js) ---

// Safely convert to ISO string
function toIsoTimeSafe(v) {
    if (v === undefined || v === null || v === '') return undefined;
    if (v instanceof Date) return !Number.isNaN(v.getTime()) ? v.toISOString() : undefined;
    const n = Number(v);
    if (Number.isFinite(n)) {
        const d = new Date(n);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const d2 = new Date(String(v));
    if (!Number.isNaN(d2.getTime())) return d2.toISOString();
    return undefined;
}

// Fetch Account Summary
async function fetchAccountSummary(userType, userId) {
    let Model, row;
    if (userType === 'strategy_provider') {
        Model = StrategyProviderAccount;
        row = await Model.findByPk(parseInt(userId, 10));
    } else if (userType === 'copy_follower') {
        const CopyFollowerAccount = require('../../models/copyFollowerAccount.model');
        row = await CopyFollowerAccount.findByPk(parseInt(userId, 10));
    } else {
        Model = userType === 'live' ? LiveUser : DemoUser;
        row = await Model.findByPk(parseInt(userId, 10));
    }

    if (!row) return { balance: '0', margin: '0' };
    return {
        balance: (row.wallet_balance ?? 0).toString(),
        margin: (row.margin ?? 0).toString(),
    };
}

// Fetch Orders from DB (Pending/Rejected)
async function fetchOrdersFromDB(userType, userId) {
    let OrderModel, rows;
    const uid = parseInt(userId, 10);

    if (userType === 'strategy_provider') {
        OrderModel = StrategyProviderOrder;
        rows = await OrderModel.findAll({ where: { order_user_id: uid } });
    } else if (userType === 'copy_follower') {
        OrderModel = CopyFollowerOrder;
        rows = await OrderModel.findAll({ where: { copy_follower_account_id: uid } });
    } else {
        OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
        rows = await OrderModel.findAll({ where: { order_user_id: uid } });
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

        if (userType === 'copy_follower') {
            base.master_order_id = r.master_order_id;
            base.copy_status = r.copy_status;
            base.strategy_provider_id = r.strategy_provider_id;
        }
        if (userType === 'strategy_provider') {
            base.copy_distribution_status = r.copy_distribution_status;
            base.is_master_order = r.is_master_order;
        }

        const status = String(r.order_status).toUpperCase();
        if (status === 'OPEN') open.push(base);
        else if (status === 'PENDING') pending.push(base);
        else if (status === 'REJECTED') rejected.push(base);
    }
    return { open, pending, rejected };
}

// Fetch Open Orders from Redis
async function fetchOpenOrdersFromRedis(userType, userId) {
    const tag = userType === 'copy_follower' ? `copy_follower:${userId}` : `${userType}:${userId}`;
    const indexKey = `user_orders_index:{${tag}}`;

    let ids;
    try {
        ids = await redisCluster.smembers(indexKey);
    } catch (e) {
        logger.error('AdminWS: Redis error reading orders index', { error: e.message, indexKey });
        return [];
    }

    if (!ids || ids.length === 0) return [];

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
            if (err || !data) return null;
            const row = data;
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
        logger.error('AdminWS: Redis pipeline error reading holdings', { error: e.message });
    }
    return results;
}

function buildPayload(userType, userId, { balance, margin, openOrders, pendingOrders, rejectedOrders }) {
    return {
        type: 'admin_portfolio_update',
        userType,
        userId,
        timestamp: new Date().toISOString(),
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


// --- Main Server Function ---

function startAdminOrdersWSServer(server) {
    const wss = new WebSocketServer({ server, path: '/ws/admin/orders' });
    const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

    wss.on('connection', async (ws, req) => {
        const params = url.parse(req.url, true);
        const token = params.query.token;

        // 1. Authenticate Admin
        let admin;
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (!decoded || !decoded.role || !decoded.is_active) {
                ws.close(4401, 'Invalid admin token');
                return;
            }
            // Check JTI revoke
            const jtiKey = `jti:${decoded.sub}:${decoded.jti}`;
            const isValid = await redisCluster.get(jtiKey);
            if (!isValid) {
                ws.close(4401, 'Token revoked');
                return;
            }

            // Basic permission check (optional, matching middleware logic)
            if (decoded.role !== 'superadmin') {
                // Check if they have orders:read permission? 
                // For now, let's allow all active admins to connect, 
                // but strictly we should check permissions.
                if (!decoded.permissions || !decoded.permissions.includes('orders:read')) {
                    ws.close(4403, 'Insufficient permissions');
                    return;
                }
            }

            admin = decoded;
        } catch (e) {
            ws.close(4401, 'Authentication failed');
            return;
        }

        const adminId = admin.sub || admin.id;
        logger.info('WS Admin connected', { adminId, role: admin.role });

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        // State for this connection
        // We allow subscribing to ONE user at a time per WS connection, or Multiple?
        // "fetch respective user" implies selecting a user.
        // Let's support subscribing to separate users.
        // Map<UserKey, UnsubscribeFunction>
        const subscriptions = new Map();

        // Heartbeat
        const pingInterval = setInterval(() => {
            if (ws.readyState === ws.CLOSED) { clearInterval(pingInterval); return; }
            if (ws.isAlive === false) { ws.terminate(); return; }
            ws.isAlive = false;
            ws.ping();
        }, 30000);

        // Handle Incoming Messages
        ws.on('message', async (message) => {
            try {
                const msg = JSON.parse(message);

                if (msg.action === 'subscribe') {
                    const { userType, userId } = msg; // live, demo, strategy_provider, copy_follower
                    if (!userType || !userId) return;

                    const uType = String(userType).toLowerCase();
                    const uId = parseInt(userId, 10);
                    const userKey = `${uType}:${uId}`;

                    // If already subscribed, ignore or resend snapshot? Let's resend snapshot.
                    if (subscriptions.has(userKey)) {
                        // unsubscribe old to refresh clean
                        const unsubscribe = subscriptions.get(userKey);
                        if (unsubscribe) unsubscribe();
                        subscriptions.delete(userKey);
                    }

                    logger.info('WS Admin subscribing to user', { adminId, targetUser: userKey });

                    // 1. Send Initial Snapshot
                    const sendSnapshot = async () => {
                        try {
                            const [summary, openOrders, dbOrders] = await Promise.all([
                                fetchAccountSummary(uType, uId),
                                fetchOpenOrdersFromRedis(uType, uId),
                                fetchOrdersFromDB(uType, uId)
                            ]);

                            const payload = buildPayload(uType, uId, {
                                balance: summary.balance,
                                margin: summary.margin,
                                openOrders,
                                pendingOrders: dbOrders.pending,
                                rejectedOrders: dbOrders.rejected
                            });

                            if (ws.readyState === ws.OPEN) {
                                ws.send(JSON.stringify(payload));
                            }
                        } catch (err) {
                            logger.error('WS Admin snapshot failed', { error: err.message, userKey });
                            if (ws.readyState === ws.OPEN) {
                                ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch data' }));
                            }
                        }
                    };

                    await sendSnapshot();

                    // 2. Subscribe to Events
                    const unsubscribe = portfolioEvents.onUserUpdate(uType, uId, async (evt) => {
                        if (ws.readyState !== ws.OPEN) return;

                        // Forward the event directly? 
                        // Or send a full snapshot on specific critical events?
                        // The user WS sends a full snapshot on almost everything (to keep things simple/sync).
                        // We should probably do the same for consistency.

                        // Reuse logic from portfolio.ws.js: determine if we need full snapshot or just event.
                        // Actually, portfolio.ws.js sends TWO things: 
                        // 1. sendSnapshot('event', evt) -> Sends FULL payload.
                        // So we should just call sendSnapshot() again.

                        await sendSnapshot();
                    });

                    subscriptions.set(userKey, unsubscribe);
                    ws.send(JSON.stringify({ type: 'subscribed', userKey }));

                } else if (msg.action === 'unsubscribe') {
                    const { userType, userId } = msg; // optional, if missing unsub all?
                    if (userType && userId) {
                        const userKey = `${String(userType).toLowerCase()}:${userId}`;
                        const unsubscribe = subscriptions.get(userKey);
                        if (unsubscribe) {
                            unsubscribe();
                            subscriptions.delete(userKey);
                            ws.send(JSON.stringify({ type: 'unsubscribed', userKey }));
                        }
                    } else {
                        // Unsubscribe all
                        for (const [key, unsub] of subscriptions.entries()) {
                            unsub();
                        }
                        subscriptions.clear();
                        ws.send(JSON.stringify({ type: 'unsubscribed_all' }));
                    }
                }

            } catch (err) {
                logger.warn('WS Admin message error', { error: err.message });
            }
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            for (const unsub of subscriptions.values()) {
                try { unsub(); } catch (_) { }
            }
            subscriptions.clear();
            logger.info('WS Admin disconnected', { adminId });
        });
    });

    logger.info('WebSocket /ws/admin/orders started');
    return wss;
}

module.exports = { startAdminOrdersWSServer };
