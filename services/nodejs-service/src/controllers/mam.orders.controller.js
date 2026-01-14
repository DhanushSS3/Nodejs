const mamOrderService = require('../services/mamOrder.service');

class MAMOrdersController {
  async placeInstantOrder(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    try {
      const result = await mamOrderService.placeInstantOrder({
        mamAccountId,
        managerId: req.user?.sub || req.user?.id,
        payload: {
          symbol: String(req.body.symbol || '').toUpperCase(),
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

  async closeMamOrder(req, res) {
    const mamAccountId = req.user?.mam_account_id || req.user?.sub;
    if (!mamAccountId) {
      return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
    }

    const payload = {
      order_id: String(req.body.order_id || '').trim(),
      symbol: String(req.body.symbol || '').trim().toUpperCase(),
      order_type: String(req.body.order_type || '').trim().toUpperCase(),
      status: req.body.status ? String(req.body.status) : 'CLOSED',
      order_status: req.body.order_status ? String(req.body.order_status) : 'CLOSED',
      close_price: req.body.close_price != null ? Number(req.body.close_price) : undefined
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
}

module.exports = new MAMOrdersController();
