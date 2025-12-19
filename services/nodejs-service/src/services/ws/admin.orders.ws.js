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

// --- Helper Functions (Same as before) ---
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

    if (!row) {
        logger.warn('AdminWS: Account summary not found', { userType, userId });
        return { balance: '0', margin: '0' };
    }
    logger.info('AdminWS: Fetched account summary', { userType, userId, balance: row.wallet_balance });
    return {
        balance: (row.wallet_balance ?? 0).toString(),
        margin: (row.margin ?? 0).toString(),
    };
}

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

    logger.debug('AdminWS: Redis index keys', { indexKey, count: ids ? ids.length : 0 });

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
        logger.debug('AdminWS: Redis pipeline executed', { resultsCount: res ? res.length : 0 });
        results = (res || []).map(([err, data], i) => {
            if (err || !data) return null;
            const row = data;
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

// --- Modified Server Function (no server option) ---

function createAdminOrdersWSServer() {
    // Use noServer mode so we can handle upgrade manually in index.js
    const wss = new WebSocketServer({ noServer: true, path: '/ws/admin/orders' });
    const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

    wss.on('connection', (ws, req) => {
        const params = url.parse(req.url, true);
        const token = params.query.token;

        ws.isAlive = true;
        ws.isAuthenticated = false;
        ws.adminId = null;

        // Heartbeat
        ws.on('pong', () => { ws.isAlive = true; });

        // Ping Interval
        const pingInterval = setInterval(() => {
            if (ws.readyState === ws.CLOSED) { clearInterval(pingInterval); return; }
            if (ws.isAlive === false) { ws.terminate(); return; }
            ws.isAlive = false;
            ws.ping();
        }, 30000);

        const subscriptions = new Map();

        // Attach Message Listener IMMEDIATELY to avoid race conditions
        ws.on('message', async (message) => {
            try {
                // Ensure message is string (handle Buffers from ws v8+)
                const rawMsg = message.toString();
                // Avoid logging raw token if possible, but helpful for debug
                // logger.debug('WS Admin raw message', { length: rawMsg.length });

                if (!ws.isAuthenticated) {
                    logger.warn('WS Admin ignored message before auth', { ip: req.socket.remoteAddress });
                    return;
                }

                const msg = JSON.parse(rawMsg);

                if (msg.action === 'subscribe') {
                    const { userType, userId } = msg;

                    logger.info(`WS Admin received subscribe request: ${JSON.stringify(msg)}`, { adminId: ws.adminId });

                    if (!userType || !userId) {
                        logger.warn('WS Admin subscribe missing userType or userId', { adminId: ws.adminId, msg });
                        return;
                    }

                    const uType = String(userType).toLowerCase();
                    const uId = parseInt(userId, 10);
                    const userKey = `${uType}:${uId}`;

                    if (subscriptions.has(userKey)) {
                        logger.info('WS Admin removing existing subscription', { adminId: ws.adminId, userKey });
                        const unsubscribe = subscriptions.get(userKey);
                        if (unsubscribe) unsubscribe();
                        subscriptions.delete(userKey);
                    }

                    logger.info('WS Admin subscribing to user', { adminId: ws.adminId, targetUser: userKey });

                    const sendSnapshot = async () => {
                        try {
                            const [summary, openOrders, dbOrders] = await Promise.all([
                                fetchAccountSummary(uType, uId),
                                fetchOpenOrdersFromRedis(uType, uId),
                                fetchOrdersFromDB(uType, uId)
                            ]);

                            logger.info('AdminWS: Snapshot data fetching complete', {
                                adminId: ws.adminId,
                                userKey,
                                openOrdersCount: openOrders.length,
                                pendingOrdersCount: dbOrders.pending.length,
                                rejectedOrdersCount: dbOrders.rejected.length
                            });

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

                    const unsubscribe = portfolioEvents.onUserUpdate(uType, uId, async (evt) => {
                        if (ws.readyState !== ws.OPEN) return;
                        await sendSnapshot();
                    });

                    subscriptions.set(userKey, unsubscribe);
                    ws.send(JSON.stringify({ type: 'subscribed', userKey }));

                } else if (msg.action === 'unsubscribe') {
                    const { userType, userId } = msg;
                    if (userType && userId) {
                        const userKey = `${String(userType).toLowerCase()}:${userId}`;
                        const unsubscribe = subscriptions.get(userKey);
                        if (unsubscribe) {
                            unsubscribe();
                            subscriptions.delete(userKey);
                            ws.send(JSON.stringify({ type: 'unsubscribed', userKey }));
                        }
                    } else {
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

        // Attach Close Listener IMMEDIATELY
        ws.on('close', () => {
            clearInterval(pingInterval);
            for (const unsub of subscriptions.values()) {
                try { unsub(); } catch (_) { }
            }
            subscriptions.clear();
            logger.info('WS Admin disconnected', { adminId: ws.adminId });
        });

        // Perform Async Authentication
        (async () => {
            let admin;
            try {
                if (!token) throw new Error('No token');
                const decoded = jwt.verify(token, JWT_SECRET);
                if (!decoded || !decoded.role || !decoded.is_active) {
                    throw new Error('Invalid token payload');
                }
                const jtiKey = `jti:${decoded.sub}:${decoded.jti}`;
                const isValid = await redisCluster.get(jtiKey);
                if (!isValid) {
                    throw new Error('Token revoked');
                }
                admin = decoded;
            } catch (e) {
                ws.close(4401, 'Authentication failed');
                return;
            }

            ws.adminId = admin.sub || admin.id;
            ws.isAuthenticated = true; // Enable message processing

            logger.info('WS Admin connected', { adminId: ws.adminId, role: admin.role });

            // Send welcome message
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'connected', message: 'Admin WebSocket Connected', adminId: ws.adminId }));
            }
        })();
    });

    return wss;
}

module.exports = { createAdminOrdersWSServer };
