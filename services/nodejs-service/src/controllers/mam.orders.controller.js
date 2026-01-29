const mamOrderService = require('../services/mamOrder.service');

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
