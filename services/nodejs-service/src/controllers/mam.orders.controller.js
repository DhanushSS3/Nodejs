const { Op } = require('sequelize');
const mamOrderService = require('../services/mamOrder.service');
const MAMOrder = require('../models/mamOrder.model');

class MAMOrdersController {
  async placeInstantOrder(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    try {
      const normalizedSymbol = String(req.body.symbol || req.body.order_company_name || '').toUpperCase();
      const result = await mamOrderService.placeInstantOrder({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload: {
          symbol: normalizedSymbol,
          order_type: String(req.body.order_type || '').toUpperCase(),
          order_price: Number(req.body.order_price),
          volume: Number(req.body.volume || req.body.order_quantity),
          stop_loss: req.body.stop_loss ? Number(req.body.stop_loss) : null,
          take_profit: req.body.take_profit ? Number(req.body.take_profit) : null
        }
      });

      return res.status(201).json({
        success: true,
        message: 'MAM order placed',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to place MAM order'
      });
    }
  }

  async getClosedMamOrders(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
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
        return res.status(400).json({ success: false, message: 'Invalid start_date or end_date' });
      }

      updatedAtFilter = {};
      if (startDate) {
        updatedAtFilter[Op.gte] = startDate;
      }
      if (endDate) {
        updatedAtFilter[Op.lte] = endDate;
      }
    }

    try {
      const where = { mam_account_id: parseInt(mamAccountId, 10), order_status: 'CLOSED' };
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
        order_id: r.id,
        mam_account_id: r.mam_account_id,
        order_company_name: String(r.symbol).toUpperCase(),
        symbol: r.symbol,
        order_type: r.order_type,
        order_status: r.order_status,
        order_quantity: r.requested_volume?.toString?.() ?? String(r.requested_volume ?? ''),
        requested_volume: r.requested_volume?.toString?.() ?? String(r.requested_volume ?? ''),
        executed_volume: r.executed_volume?.toString?.() ?? String(r.executed_volume ?? ''),
        average_entry_price: r.average_entry_price?.toString?.() ?? null,
        average_exit_price: r.average_exit_price?.toString?.() ?? null,
        gross_profit: r.gross_profit?.toString?.() ?? null,
        net_profit_after_fees: r.net_profit_after_fees?.toString?.() ?? null,
        stop_loss: r.stop_loss?.toString?.() ?? null,
        take_profit: r.take_profit?.toString?.() ?? null,
        slippage_bps: r.slippage_bps?.toString?.() ?? null,
        rejected_investors_count: r.rejected_investors_count,
        rejected_volume: r.rejected_volume?.toString?.() ?? null,
        close_message: r.close_message ?? null,
        created_at: r.created_at ? (r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString()) : null,
        updated_at: r.updated_at ? (r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString()) : null,
      }));

      return res.status(200).json(data);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch MAM closed orders'
      });
    }
  }

  async placePendingOrder(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    try {
      const normalizedSymbol = String(req.body.symbol || req.body.order_company_name || '').toUpperCase();
      const result = await mamOrderService.placePendingOrder({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload: {
          symbol: normalizedSymbol,
          order_type: String(req.body.order_type || '').toUpperCase(),
          order_price: Number(req.body.order_price),
          volume: Number(req.body.volume || req.body.order_quantity)
        }
      });

      return res.status(201).json({
        success: true,
        message: 'MAM pending order placed',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to place MAM pending order'
      });
    }
  }

  async cancelPendingOrder(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: Number(req.body.order_id),
      cancel_message: req.body.cancel_message ? String(req.body.cancel_message).trim() : undefined,
      status: req.body.status ? String(req.body.status).trim().toUpperCase() : undefined
    };

    try {
      const result = await mamOrderService.cancelPendingOrder({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload
      });

      return res.status(200).json({
        success: true,
        message: 'MAM pending order cancellation dispatched',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to cancel MAM pending order',
        details: error.details || undefined
      });
    }
  }

  async closeMamOrder(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: String(req.body.order_id || '').trim(),
      symbol: String(req.body.symbol || req.body.order_company_name || '').trim().toUpperCase(),
      order_type: String(req.body.order_type || '').trim().toUpperCase(),
      status: req.body.status ? String(req.body.status) : 'CLOSED',
      order_status: req.body.order_status ? String(req.body.order_status) : 'CLOSED',
      close_price: req.body.close_price != null ? Number(req.body.close_price) : undefined,
      close_message: req.body.close_message ? String(req.body.close_message).trim() : undefined
    };

    try {
      const result = await mamOrderService.closeMamOrder({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload
      });

      return res.status(200).json({
        success: true,
        message: 'MAM order close accepted',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to close MAM order'
      });
    }
  }

  async closeAllMamOrders(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    try {
      const result = await mamOrderService.closeAllMamOrders({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id
      });

      return res.status(200).json({
        success: true,
        message: 'MAM close all accepted',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to close all MAM orders',
        details: error.details || undefined
      });
    }
  }

  async addStopLoss(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: Number(req.body.order_id),
      stop_loss: Number(req.body.stop_loss)
    };

    try {
      const result = await mamOrderService.addStopLoss({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload
      });

      return res.status(200).json({
        success: true,
        message: 'MAM stoploss update accepted',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to add stoploss for MAM order',
        details: error.details || undefined
      });
    }
  }

  async addTakeProfit(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: Number(req.body.order_id),
      take_profit: Number(req.body.take_profit)
    };

    try {
      const result = await mamOrderService.addTakeProfit({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload
      });

      return res.status(200).json({
        success: true,
        message: 'MAM takeprofit update accepted',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to add takeprofit for MAM order',
        details: error.details || undefined
      });
    }
  }

  async cancelStopLoss(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: Number(req.body.order_id)
    };

    try {
      const result = await mamOrderService.cancelStopLoss({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload
      });

      return res.status(200).json({
        success: true,
        message: 'MAM stoploss cancel accepted',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to cancel stoploss for MAM order',
        details: error.details || undefined
      });
    }
  }

  async cancelTakeProfit(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: Number(req.body.order_id)
    };

    try {
      const result = await mamOrderService.cancelTakeProfit({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload
      });

      return res.status(200).json({
        success: true,
        message: 'MAM takeprofit cancel accepted',
        data: result
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to cancel takeprofit for MAM order',
        details: error.details || undefined
      });
    }
  }
}

module.exports = new MAMOrdersController();
