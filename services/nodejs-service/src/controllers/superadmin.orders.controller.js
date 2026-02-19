const axios = require('axios');
const { Op } = require('sequelize');
const OrdersIndexRebuildService = require('../services/orders.index.rebuild.service');
const OrdersBackfillService = require('../services/orders.backfill.service');
const { redisCluster } = require('../../config/redis');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const MAMAccount = require('../models/mamAccount.model');
const MAMOrder = require('../models/mamOrder.model');
const UserTransaction = require('../models/userTransaction.model');
const logger = require('../services/logger.service');
const adminAuditService = require('../services/admin.audit.service');
const adminOrderManagementService = require('../services/admin.order.management.service');
const mamOrderService = require('../services/mamOrder.service');

function ok(res, data, message = 'OK') {
  return res.status(200).json({ success: true, message, data });
}
function bad(res, message, code = 400) {
  return res.status(code).json({ success: false, message });
}

const SUPPORTED_USER_TYPES = new Set(['live', 'demo', 'strategy_provider', 'copy_follower']);
const BACKFILL_SUPPORTED_TYPES = new Set(['live', 'demo', 'strategy_provider', 'copy_follower']);

// GET /api/superadmin/orders/mam/closed
async function getMamClosedOrders(req, res) {
  const operationId = `superadmin_mam_closed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const adminId = req.admin?.id;
  try {
    const mamAccountIdRaw = req.query.mam_account_id || req.body?.mam_account_id;
    const mamAccountId = parseInt(String(mamAccountIdRaw || ''), 10);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const page = Math.max(1, parseInt(req.query.page || req.body?.page || '1', 10));
    const pageSizeRaw = parseInt(req.query.page_size || req.query.limit || req.body?.page_size || req.body?.limit || '20', 10);
    const pageSize = Math.min(Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 20), 100);
    const offset = (page - 1) * pageSize;

    const startDateRaw = req.query.start_date || req.body?.start_date;
    const endDateRaw = req.query.end_date || req.body?.end_date;

    let updatedAtFilter = null;
    if (startDateRaw || endDateRaw) {
      const startDate = startDateRaw ? new Date(startDateRaw) : null;
      const endDate = endDateRaw ? new Date(endDateRaw) : null;

      if ((startDateRaw && Number.isNaN(startDate.getTime())) || (endDateRaw && Number.isNaN(endDate.getTime()))) {
        return bad(res, 'Invalid start_date or end_date', 400);
      }

      updatedAtFilter = {};
      if (startDate) updatedAtFilter[Op.gte] = startDate;
      if (endDate) updatedAtFilter[Op.lte] = endDate;
    }

    const where = { mam_account_id: mamAccountId, order_status: 'CLOSED' };
    if (updatedAtFilter) {
      where.updated_at = updatedAtFilter;
    }

    const { rows } = await MAMOrder.findAndCountAll({
      where,
      order: [['updated_at', 'DESC']],
      offset,
      limit: pageSize,
    });

    const data = rows.map((r) => ({
      mam_order_id: r.id,
      mam_account_id: r.mam_account_id,
      symbol: r.symbol,
      order_type: r.order_type,
      order_status: r.order_status,
      requested_volume: r.requested_volume?.toString?.() ?? String(r.requested_volume ?? ''),
      executed_volume: r.executed_volume?.toString?.() ?? String(r.executed_volume ?? ''),
      average_entry_price: r.average_entry_price?.toString?.() ?? null,
      average_exit_price: r.average_exit_price?.toString?.() ?? null,
      gross_profit: r.gross_profit?.toString?.() ?? null,
      net_profit_after_fees: r.net_profit_after_fees?.toString?.() ?? null,
      stop_loss: r.stop_loss?.toString?.() ?? null,
      take_profit: r.take_profit?.toString?.() ?? null,
      close_message: r.close_message ?? null,
      metadata: r.metadata ?? null,
      created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString()) : null,
      updated_at: r.updated_at ? (r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString()) : null,
    }));

    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_CLOSED_LIST',
        ipAddress: req.ip,
        requestBody: { query: req.query },
        status: 'SUCCESS',
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    logger.error('getMamClosedOrders internal error', { error: err.message, operationId });
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_CLOSED_LIST',
        ipAddress: req.ip,
        requestBody: { query: req.query },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

// GET /api/superadmin/orders/mam/wallet-transactions
async function getMamWalletTransactions(req, res) {
  const operationId = `superadmin_mam_wallet_txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const adminId = req.admin?.id;
  try {
    const mamAccountIdRaw = req.query.mam_account_id || req.body?.mam_account_id;
    const mamAccountId = parseInt(String(mamAccountIdRaw || ''), 10);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const pageRaw = Number.parseInt(req.query.page || req.body?.page, 10);
    const pageSizeRaw = Number.parseInt(req.query.page_size || req.body?.page_size, 10);
    let limitRaw = Number.parseInt(req.query.limit || req.body?.limit, 10);
    let offsetRaw = Number.parseInt(req.query.offset || req.body?.offset, 10);

    const pageSize = Math.min(
      Math.max(1, Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : (Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50)),
      100
    );

    let page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : null;
    if (!page && Number.isFinite(offsetRaw) && offsetRaw >= 0) {
      page = Math.floor(offsetRaw / pageSize) + 1;
    }
    if (!page) page = 1;

    const offset = (page - 1) * pageSize;

    const startDateRaw = req.query.start_date || req.body?.start_date;
    const endDateRaw = req.query.end_date || req.body?.end_date;
    let createdAtFilter = null;
    if (startDateRaw || endDateRaw) {
      const startDate = startDateRaw ? new Date(startDateRaw) : null;
      const endDate = endDateRaw ? new Date(endDateRaw) : null;
      if ((startDateRaw && Number.isNaN(startDate.getTime())) || (endDateRaw && Number.isNaN(endDate.getTime()))) {
        return bad(res, 'Invalid start_date or end_date', 400);
      }
      createdAtFilter = {};
      if (startDate) createdAtFilter[Op.gte] = startDate;
      if (endDate) createdAtFilter[Op.lte] = endDate;
    }

    const where = {
      user_id: mamAccountId,
      user_type: 'mam_account',
      type: 'performance_fee_earned',
    };
    if (createdAtFilter) {
      where.created_at = createdAtFilter;
    }

    const { rows, count } = await UserTransaction.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      attributes: ['transaction_id', 'type', 'amount', 'status', 'reference_id', 'notes', 'created_at'],
      limit: pageSize,
      offset,
    });

    const transactions = rows.map((r) => ({
      transaction_id: r.transaction_id,
      type: r.type,
      amount: r.amount,
      status: r.status,
      reference_id: r.reference_id,
      notes: r.notes,
      created_at: r.created_at,
      source: 'wallet_transaction',
    }));

    const total = Number(count || 0);
    const totalPages = Math.ceil(total / pageSize) || 1;

    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_WALLET_TRANSACTIONS_LIST',
        ipAddress: req.ip,
        requestBody: { query: req.query },
        status: 'SUCCESS',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Wallet transactions retrieved successfully',
      data: {
        transactions,
        pagination: {
          total,
          page,
          page_size: pageSize,
          total_pages: totalPages,
          has_next_page: page < totalPages,
          has_previous_page: page > 1,
        }
      }
    });
  } catch (err) {
    logger.error('getMamWalletTransactions internal error', { error: err.message, operationId });
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_WALLET_TRANSACTIONS_LIST',
        ipAddress: req.ip,
        requestBody: { query: req.query },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    return res.status(500).json({ success: false, message: 'Internal server error', operationId });
  }
}

// POST /api/superadmin/orders/place-instant
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, symbol: string, order_type: string, order_price: number, order_quantity: number, idempotency_key?: string }
async function placeInstantOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }

    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }

    const orderData = { ...(req.body || {}) };

    const result = await adminOrderManagementService.placeInstantOrder(
      req.admin,
      user_type,
      userIdInt,
      orderData,
      null
    );

    const response = ok(res, result?.data || result, 'Instant order accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_PLACE_INSTANT',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_PLACE_INSTANT',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to place instant order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/sl/add
// body: { mam_account_id: string|number, mam_order_id: string|number, stop_loss: number }
async function addMamStopLoss(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountId = Number(req.body.mam_account_id);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const mamOrderIdRaw = req.body.mam_order_id ?? req.body.order_id;
    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      return bad(res, 'mam_order_id must be a positive integer', 400);
    }

    const stopLossRaw = req.body.stop_loss;
    const stopLoss = stopLossRaw != null ? Number(stopLossRaw) : NaN;
    if (!(stopLoss > 0)) {
      return bad(res, 'stop_loss must be > 0', 400);
    }

    const result = await mamOrderService.addStopLoss({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: { order_id: String(mamOrderId), stop_loss: stopLoss }
    });

    const response = ok(res, result, 'MAM stoploss accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_STOPLOSS_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_STOPLOSS_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || 500;
    return bad(res, `Failed to add MAM stoploss: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/sl/cancel
// body: { mam_account_id: string|number, mam_order_id: string|number }
async function cancelMamStopLoss(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountId = Number(req.body.mam_account_id);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const mamOrderIdRaw = req.body.mam_order_id ?? req.body.order_id;
    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      return bad(res, 'mam_order_id must be a positive integer', 400);
    }

    const result = await mamOrderService.cancelStopLoss({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: { order_id: String(mamOrderId) }
    });

    const response = ok(res, result, 'MAM stoploss cancel accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_STOPLOSS_CANCEL',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_STOPLOSS_CANCEL',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || 500;
    return bad(res, `Failed to cancel MAM stoploss: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/tp/add
// body: { mam_account_id: string|number, mam_order_id: string|number, take_profit: number }
async function addMamTakeProfit(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountId = Number(req.body.mam_account_id);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const mamOrderIdRaw = req.body.mam_order_id ?? req.body.order_id;
    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      return bad(res, 'mam_order_id must be a positive integer', 400);
    }

    const takeProfitRaw = req.body.take_profit;
    const takeProfit = takeProfitRaw != null ? Number(takeProfitRaw) : NaN;
    if (!(takeProfit > 0)) {
      return bad(res, 'take_profit must be > 0', 400);
    }

    const result = await mamOrderService.addTakeProfit({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: { order_id: String(mamOrderId), take_profit: takeProfit }
    });

    const response = ok(res, result, 'MAM takeprofit accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_TAKEPROFIT_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_TAKEPROFIT_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || 500;
    return bad(res, `Failed to add MAM takeprofit: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/tp/cancel
// body: { mam_account_id: string|number, mam_order_id: string|number }
async function cancelMamTakeProfit(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountId = Number(req.body.mam_account_id);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const mamOrderIdRaw = req.body.mam_order_id ?? req.body.order_id;
    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      return bad(res, 'mam_order_id must be a positive integer', 400);
    }

    const result = await mamOrderService.cancelTakeProfit({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: { order_id: String(mamOrderId) }
    });

    const response = ok(res, result, 'MAM takeprofit cancel accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_TAKEPROFIT_CANCEL',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_TAKEPROFIT_CANCEL',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || 500;
    return bad(res, `Failed to cancel MAM takeprofit: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/close-all
// body: { mam_account_id: string|number }
async function closeAllMamOrders(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountId = Number(req.body.mam_account_id);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const result = await mamOrderService.closeAllMamOrders({
      mamAccountId,
      managerId: req.admin?.id || 0,
    });

    const response = ok(res, result, 'MAM close-all accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_CLOSE_ALL',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_CLOSE_ALL',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || 500;
    return bad(res, `Failed to close all MAM orders: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/pending/place
// body: { mam_account_id: string|number, symbol: string, order_type: string, order_price?: number, price?: number, volume?: number, order_quantity?: number }
async function placeMamPendingOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountIdRaw = req.body.mam_account_id;
    const mamAccountId = Number(mamAccountIdRaw);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const symbol = String(req.body.symbol || req.body.order_company_name || '').trim().toUpperCase();
    const order_type = String(req.body.order_type || '').trim().toUpperCase();
    const order_price = req.body.order_price != null ? Number(req.body.order_price) : (req.body.price != null ? Number(req.body.price) : NaN);
    const volume = req.body.volume != null ? Number(req.body.volume) : (req.body.order_quantity != null ? Number(req.body.order_quantity) : NaN);

    if (!symbol) return bad(res, 'symbol is required', 400);
    if (!order_type) return bad(res, 'order_type is required', 400);
    if (!(order_price > 0)) return bad(res, 'order_price (or price) must be > 0', 400);
    if (!(volume > 0)) return bad(res, 'volume (or order_quantity) must be > 0', 400);

    const result = await mamOrderService.placePendingOrder({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: {
        symbol,
        order_type,
        order_price,
        volume,
      }
    });

    const response = ok(res, result, 'MAM pending order accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_PLACE_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_PLACE_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to place MAM pending order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/pending/cancel
// body: { mam_account_id: string|number, mam_order_id: string|number, cancel_message?: string, status?: string }
async function cancelMamPendingOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountIdRaw = req.body.mam_account_id;
    const mamAccountId = Number(mamAccountIdRaw);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const mamOrderIdRaw = req.body.mam_order_id ?? req.body.order_id;
    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      return bad(res, 'mam_order_id must be a positive integer', 400);
    }

    const cancel_message = req.body.cancel_message ? String(req.body.cancel_message).trim() : undefined;
    const status = req.body.status ? String(req.body.status).trim().toUpperCase() : undefined;

    const result = await mamOrderService.cancelPendingOrder({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: {
        order_id: String(mamOrderId),
        cancel_message,
        status,
      }
    });

    const response = ok(res, result, 'MAM pending cancel accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_CANCEL_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_CANCEL_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to cancel MAM pending order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/place-instant
// body: { mam_account_id: string|number, symbol: string, order_type: string, order_price: number, volume: number, stop_loss?: number, take_profit?: number }
async function placeMamInstantOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const mamAccountIdRaw = req.body.mam_account_id;
    const mamAccountId = Number(mamAccountIdRaw);
    if (!Number.isInteger(mamAccountId) || mamAccountId <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }

    const symbol = String(req.body.symbol || req.body.order_company_name || '').trim().toUpperCase();
    const order_type = String(req.body.order_type || '').trim().toUpperCase();
    const order_price = req.body.order_price != null ? Number(req.body.order_price) : null;
    const volume = req.body.volume != null ? Number(req.body.volume) : (req.body.order_quantity != null ? Number(req.body.order_quantity) : NaN);
    const stop_loss = req.body.stop_loss != null ? Number(req.body.stop_loss) : null;
    const take_profit = req.body.take_profit != null ? Number(req.body.take_profit) : null;

    if (!symbol) return bad(res, 'symbol is required', 400);
    if (!order_type) return bad(res, 'order_type is required', 400);
    if (order_price != null && !(order_price > 0)) return bad(res, 'order_price must be > 0', 400);
    if (!(volume > 0)) return bad(res, 'volume must be > 0', 400);

    const result = await mamOrderService.placeInstantOrder({
      mamAccountId,
      managerId: req.admin?.id || 0,
      payload: {
        symbol,
        order_type,
        ...(order_price != null ? { order_price } : {}),
        volume,
        stop_loss: (stop_loss != null && Number.isFinite(stop_loss) && stop_loss > 0) ? stop_loss : null,
        take_profit: (take_profit != null && Number.isFinite(take_profit) && take_profit > 0) ? take_profit : null,
      }
    });

    const response = ok(res, result, 'MAM instant order accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_PLACE_INSTANT',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MAM_PLACE_INSTANT',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to place MAM instant order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/sl/add
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string, stop_loss?: number, stop_loss_price?: number }
async function addStopLoss(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }
    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }
    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const sl = req.body.stop_loss_price ?? req.body.stop_loss;
    const slNum = sl != null ? Number(sl) : NaN;
    if (!(slNum > 0)) {
      return bad(res, 'stop_loss must be > 0', 400);
    }

    const slData = { ...(req.body || {}), stop_loss: slNum };
    const result = await adminOrderManagementService.setStopLoss(req.admin, user_type, userIdInt, order_id, slData, null);

    const response = ok(res, result?.data || result, 'Stop loss accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_STOPLOSS_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_STOPLOSS_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to add stop loss: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/sl/remove
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string }
async function removeStopLoss(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }
    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }
    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const result = await adminOrderManagementService.removeStopLoss(req.admin, user_type, userIdInt, order_id, req.body || {}, null);
    const response = ok(res, result?.data || result, 'Stop loss removal accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_STOPLOSS_REMOVE',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_STOPLOSS_REMOVE',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to remove stop loss: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/tp/add
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string, take_profit?: number, take_profit_price?: number }
async function addTakeProfit(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }
    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }
    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const tp = req.body.take_profit_price ?? req.body.take_profit;
    const tpNum = tp != null ? Number(tp) : NaN;
    if (!(tpNum > 0)) {
      return bad(res, 'take_profit must be > 0', 400);
    }

    const tpData = { ...(req.body || {}), take_profit: tpNum };
    const result = await adminOrderManagementService.setTakeProfit(req.admin, user_type, userIdInt, order_id, tpData, null);

    const response = ok(res, result?.data || result, 'Take profit accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_TAKEPROFIT_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_TAKEPROFIT_ADD',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to add take profit: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/tp/remove
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string }
async function removeTakeProfit(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }
    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }
    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const result = await adminOrderManagementService.removeTakeProfit(req.admin, user_type, userIdInt, order_id, req.body || {}, null);
    const response = ok(res, result?.data || result, 'Take profit removal accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_TAKEPROFIT_REMOVE',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_TAKEPROFIT_REMOVE',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to remove take profit: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/pending/place
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, symbol: string, order_type: string, price?: number, order_price?: number, quantity?: number, order_quantity?: number }
async function placePendingOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }

    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }

    const orderData = { ...(req.body || {}) };
    if (orderData.order_price == null && orderData.price != null) orderData.order_price = orderData.price;
    if (orderData.order_quantity == null && orderData.quantity != null) orderData.order_quantity = orderData.quantity;

    const result = await adminOrderManagementService.placePendingOrder(
      req.admin,
      user_type,
      userIdInt,
      orderData,
      null
    );

    const response = ok(res, result?.data || result, 'Pending order accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_PLACE_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_PLACE_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to place pending order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/pending/cancel
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string, cancel_message?: string, status?: string }
async function cancelPendingOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }
    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }
    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const cancelData = { ...(req.body || {}) };
    const result = await adminOrderManagementService.cancelPendingOrder(
      req.admin,
      user_type,
      userIdInt,
      order_id,
      cancelData,
      null
    );

    const response = ok(res, result?.data || result, 'Pending cancel accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_CANCEL_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_CANCEL_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to cancel pending order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/pending/modify
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string, new_price?: number, price?: number, order_price?: number }
async function modifyPendingOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }
    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }
    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const rawNewPrice = req.body.new_price ?? req.body.price ?? req.body.order_price;
    const newPrice = rawNewPrice != null ? Number(rawNewPrice) : NaN;
    if (!(newPrice > 0)) {
      return bad(res, 'new_price (or price/order_price) must be > 0', 400);
    }

    const updateData = { ...(req.body || {}), price: newPrice };

    const result = await adminOrderManagementService.modifyPendingOrder(
      req.admin,
      user_type,
      userIdInt,
      order_id,
      updateData,
      null
    );

    const response = ok(res, result?.data || result, 'Pending modify accepted');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MODIFY_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_MODIFY_PENDING',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to modify pending order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/close
// body: { user_type: 'live'|'demo'|'strategy_provider'|'copy_follower', user_id: string|number, order_id: string, close_price?: number, reason?: string, status?: string, order_status?: string }
async function closeOrder(req, res) {
  const adminId = req.admin?.id;
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id_raw = req.body.user_id;
    const order_id = String(req.body.order_id || '').trim();
    const reason = req.body.reason ? String(req.body.reason).trim() : undefined;

    if (!SUPPORTED_USER_TYPES.has(user_type)) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower', 400);
    }

    const userIdInt = parseInt(String(user_id_raw), 10);
    if (!Number.isInteger(userIdInt) || userIdInt <= 0) {
      return bad(res, 'user_id must be a positive integer', 400);
    }

    if (!order_id) {
      return bad(res, 'order_id is required', 400);
    }

    const closeData = { ...(req.body || {}) };
    closeData.close_message = 'Admin-Closed';

    const result = await adminOrderManagementService.closeOrder(
      req.admin,
      user_type,
      userIdInt,
      order_id,
      closeData,
      null
    );

    const response = ok(res, result?.data || result, 'Order close dispatched');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_CLOSE_ORDER',
        ipAddress: req.ip,
        requestBody: { request: req.body, reason, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_CLOSE_ORDER',
        ipAddress: req.ip,
        requestBody: { request: req.body, reason },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || err?.response?.status || 500;
    return bad(res, `Failed to close order: ${err.message}`, status);
  }
}

// POST /api/superadmin/orders/mam/close
// body: { mam_account_id: string|number, mam_order_id: string|number, close_price?: number, close_message?: string }
async function closeMamOrder(req, res) {
  const adminId = req.admin?.id;
  let close_message;
  try {
    const mam_account_id = Number(req.body.mam_account_id);
    const mam_order_id = Number(req.body.mam_order_id);
    close_message = req.body.close_message ? String(req.body.close_message).trim() : undefined;
    const close_price = req.body.close_price != null ? Number(req.body.close_price) : undefined;

    if (!Number.isInteger(mam_account_id) || mam_account_id <= 0) {
      return bad(res, 'mam_account_id must be a positive integer', 400);
    }
    if (!Number.isInteger(mam_order_id) || mam_order_id <= 0) {
      return bad(res, 'mam_order_id must be a positive integer', 400);
    }

    const mamAccount = await MAMAccount.findByPk(mam_account_id);
    if (!mamAccount || mamAccount.status !== 'active') {
      return bad(res, 'MAM account not found or inactive', 404);
    }

    const mamOrder = await MAMOrder.findByPk(mam_order_id);
    if (!mamOrder || Number(mamOrder.mam_account_id) !== Number(mam_account_id)) {
      return bad(res, 'MAM order not found for this account', 404);
    }

    const result = await mamOrderService.closeMamOrder({
      mamAccountId: mam_account_id,
      managerId: req.admin?.id || 0,
      payload: {
        order_id: String(mam_order_id),
        symbol: String(mamOrder.symbol).toUpperCase(),
        order_type: String(mamOrder.order_type).toUpperCase(),
        status: 'CLOSED',
        order_status: 'CLOSED',
        close_price: Number.isFinite(close_price) && close_price > 0 ? close_price : undefined,
        close_message: 'Admin-Closed'
      }
    });

    const response = ok(res, result, 'MAM order close dispatched');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_CLOSE_MAM_ORDER',
        ipAddress: req.ip,
        requestBody: { request: req.body, close_message, response: result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_SUPERADMIN_CLOSE_MAM_ORDER',
        ipAddress: req.ip,
        requestBody: { request: req.body, close_message },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    const status = err?.statusCode || 500;
    return bad(res, `Failed to close MAM order: ${err.message}`, status);
  }
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
    const adminId = req.admin?.id;
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const includeQueued = Boolean(req.body.include_queued);
    const backfill = Boolean(req.body.backfill);
    const deep = (req.body.deep === undefined) ? true : Boolean(req.body.deep);
    const prune = Boolean(req.body.prune);
    const pruneSymbolHolders = Boolean(req.body.prune_symbol_holders);

    if (!SUPPORTED_USER_TYPES.has(user_type) || !user_id) {
      return bad(res, 'user_type must be one of live|demo|strategy_provider|copy_follower and user_id is required');
    }

    const processed = new Set([`${user_type}:${user_id}`]);
    const rebuildOptions = { includeQueued, backfill, deep, prune, pruneSymbolHolders };

    const primary = await performUserRebuildFlow(user_type, user_id, rebuildOptions);
    const relatedRebuilds = await rebuildAssociatedCopyTradingAccounts(
      user_type,
      user_id,
      rebuildOptions,
      processed
    );

    const responseData = typeof primary.data === 'object' && primary.data !== null
      ? { ...primary.data }
      : primary.data;

    if (responseData && typeof responseData === 'object' && relatedRebuilds.length) {
      responseData.related_rebuilds = relatedRebuilds;
    }

    let responseMessage = primary.message;
    if (relatedRebuilds.length) {
      responseMessage = `${responseMessage}; ${relatedRebuilds.length} associated copy-trading account(s) rebuilt`;
    }

    const response = ok(res, responseData, responseMessage);
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_REBUILD_USER',
        ipAddress: req.ip,
        requestBody: { request: req.body, response: responseData },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (req.admin?.id) {
      await adminAuditService.logAction({
        adminId: Number(req.admin.id),
        action: 'ORDERS_REBUILD_USER',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    return bad(res, `Failed to rebuild user indices: ${err.message}`, 500);
  }
}

async function performUserRebuildFlow(user_type, user_id, options = {}) {
  const normalizedId = String(user_id).trim();
  const includeQueued = Boolean(options.includeQueued);
  const canBackfill = BACKFILL_SUPPORTED_TYPES.has(user_type);
  const shouldBackfill = Boolean(options.backfill) && canBackfill;

  let baseResult;
  if (shouldBackfill) {
    baseResult = await OrdersBackfillService.backfillUserHoldingsFromSql(
      user_type,
      normalizedId,
      { includeQueued }
    );
  } else {
    if (options.backfill && !canBackfill) {
      logger.info('Backfill not supported for user type; running index rebuild only', { user_type, user_id: normalizedId });
    }
    baseResult = await OrdersIndexRebuildService.rebuildUserIndices(user_type, normalizedId);
  }

  let data = { base: baseResult };
  let message = shouldBackfill
    ? 'User holdings backfilled from SQL and indices rebuilt'
    : 'User indices rebuilt from holdings';

  const shouldDeep = Boolean(options.deep);
  if (shouldDeep && canBackfill) {
    try {
      const deepResult = await OrdersBackfillService.rebuildUserExecutionCaches(
        user_type,
        normalizedId,
        { includeQueued: true }
      );
      data.deep = deepResult;
      message = `${message}; execution caches rebuilt`;
    } catch (e) {
      logger.warn('Deep execution-cache rebuild failed', { error: e.message, user_type, user_id: normalizedId });
    }
  } else if (shouldDeep && !canBackfill) {
    logger.info('Deep rebuild skipped for unsupported user type', { user_type, user_id: normalizedId });
  }

  const shouldPrune = Boolean(options.prune);
  if (shouldPrune && canBackfill) {
    try {
      const pruneResult = await OrdersBackfillService.pruneUserRedisAgainstSql(
        user_type,
        normalizedId,
        { deep: true, pruneSymbolHolders: Boolean(options.pruneSymbolHolders) }
      );
      data.prune = pruneResult;
      message = `${message}; stale Redis pruned`;
    } catch (e) {
      logger.warn('Prune against SQL failed', { error: e.message, user_type, user_id: normalizedId });
    }
  } else if (shouldPrune && !canBackfill) {
    logger.info('Prune skipped for unsupported user type', { user_type, user_id: normalizedId });
  }

  return { data, message };
}

async function rebuildAssociatedCopyTradingAccounts(user_type, user_id, options, processedSet) {
  const related = [];
  const sharedChildOptions = {
    includeQueued: Boolean(options.includeQueued),
    backfill: Boolean(options.backfill),
    deep: Boolean(options.deep),
    prune: Boolean(options.prune),
    pruneSymbolHolders: Boolean(options.pruneSymbolHolders),
  };

  if (user_type === 'live' || user_type === 'demo') {
    const owned = await rebuildAccountsOwnedByUser(user_id, sharedChildOptions, processedSet);
    related.push(...owned);
  }

  if (user_type === 'strategy_provider') {
    const followers = await rebuildFollowersForStrategyProvider(user_id, sharedChildOptions, processedSet);
    related.push(...followers);
  }

  return related;
}

async function rebuildAccountsOwnedByUser(ownerUserId, options, processedSet) {
  const results = [];
  const ownerPk = Number(ownerUserId);
  if (Number.isNaN(ownerPk)) {
    return results;
  }

  const strategyAccounts = await StrategyProviderAccount.findAll({ where: { user_id: ownerPk } });
  for (const account of strategyAccounts) {
    const rebuilt = await rebuildChildAccount('strategy_provider', account.id, options, processedSet);
    if (rebuilt) results.push(rebuilt);
  }

  const followerAccounts = await CopyFollowerAccount.findAll({ where: { user_id: ownerPk } });
  for (const account of followerAccounts) {
    const rebuilt = await rebuildChildAccount('copy_follower', account.id, options, processedSet);
    if (rebuilt) results.push(rebuilt);
  }

  return results;
}

async function rebuildFollowersForStrategyProvider(strategyProviderId, options, processedSet) {
  const results = [];
  const providerPk = Number(strategyProviderId);
  if (Number.isNaN(providerPk)) {
    return results;
  }

  const followerAccounts = await CopyFollowerAccount.findAll({ where: { strategy_provider_id: providerPk } });
  for (const account of followerAccounts) {
    const rebuilt = await rebuildChildAccount('copy_follower', account.id, options, processedSet);
    if (rebuilt) results.push(rebuilt);
  }

  return results;
}

async function rebuildChildAccount(user_type, user_id, options, processedSet) {
  const key = `${user_type}:${user_id}`;
  if (processedSet.has(key)) {
    return null;
  }
  processedSet.add(key);

  try {
    const result = await performUserRebuildFlow(user_type, String(user_id), options);
    return {
      user_type,
      user_id: String(user_id),
      message: result.message,
      data: result.data,
    };
  } catch (error) {
    logger.error('Failed to rebuild associated account', { user_type, user_id, error: error.message });
    return {
      user_type,
      user_id: String(user_id),
      error: error.message,
    };
  }
}

// POST /api/superadmin/orders/prune/user
// body: { user_type: 'live'|'demo', user_id: string|number, deep?: boolean, prune_symbol_holders?: boolean }
async function pruneUser(req, res) {
  try {
    const adminId = req.admin?.id;
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const deep = (req.body.deep === undefined) ? true : Boolean(req.body.deep);
    const pruneSymbolHolders = Boolean(req.body.prune_symbol_holders);

    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type must be live|demo and user_id is required');
    }

    const result = await OrdersBackfillService.pruneUserRedisAgainstSql(user_type, user_id, { deep, pruneSymbolHolders });
    const response = ok(res, result, 'Stale Redis entries pruned');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_PRUNE_USER',
        ipAddress: req.ip,
        requestBody: { request: req.body, result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (req.admin?.id) {
      await adminAuditService.logAction({
        adminId: Number(req.admin.id),
        action: 'ORDERS_PRUNE_USER',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
    return bad(res, `Failed to prune user Redis: ${err.message}`, 500);
  }
}

// POST /api/superadmin/orders/rebuild/symbol
// body: { symbol: string, scope?: 'live'|'demo'|'both' }
async function rebuildSymbol(req, res) {
  try {
    const adminId = req.admin?.id;
    const symbol = String(req.body.symbol || '').trim();
    const scope = req.body.scope ? String(req.body.scope).toLowerCase() : 'both';
    if (!symbol) return bad(res, 'symbol is required');
    if (!['live', 'demo', 'both'].includes(scope)) return bad(res, 'scope must be live|demo|both');

    const result = await OrdersIndexRebuildService.rebuildSymbolHolders(symbol, scope);
    const response = ok(res, result, 'Symbol holders ensured from indices');
    if (adminId) {
      await adminAuditService.logAction({
        adminId: Number(adminId),
        action: 'ORDERS_REBUILD_SYMBOL',
        ipAddress: req.ip,
        requestBody: { request: req.body, result },
        status: 'SUCCESS',
      });
    }
    return response;
  } catch (err) {
    if (req.admin?.id) {
      await adminAuditService.logAction({
        adminId: Number(req.admin.id),
        action: 'ORDERS_REBUILD_SYMBOL',
        ipAddress: req.ip,
        requestBody: { request: req.body },
        status: 'FAILURE',
        errorMessage: err.message,
      });
    }
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
  getMamClosedOrders,
  getMamWalletTransactions,
  placeInstantOrder,
  placePendingOrder,
  cancelPendingOrder,
  modifyPendingOrder,
  addStopLoss,
  removeStopLoss,
  addTakeProfit,
  removeTakeProfit,
  placeMamInstantOrder,
  placeMamPendingOrder,
  cancelMamPendingOrder,
  addMamStopLoss,
  cancelMamStopLoss,
  addMamTakeProfit,
  cancelMamTakeProfit,
  closeAllMamOrders,
  rejectQueued,
  getQueuedOrders,
  getMarginStatus,
  pruneUser,
  closeOrder,
  closeMamOrder,
};
