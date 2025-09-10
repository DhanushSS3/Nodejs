const { Op } = require('sequelize');
const LiveUserOrder = require('../models/liveUserOrder.model');
const LiveUser = require('../models/liveUser.model');
const Group = require('../models/group.model');

function ok(res, data, message = 'OK') {
  return res.status(200).json({ success: true, message, data });
}
function bad(res, message, code = 400) {
  return res.status(code).json({ success: false, message });
}

// GET /api/internal/provider/orders/lookup/:id
// Looks up an order in live_user_orders by any lifecycle ID field and returns
// order + user + group config needed by provider connection fallback.
async function lookupOrderByAnyId(req, res) {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return bad(res, 'id is required', 400);

    const where = {
      [Op.or]: [
        { order_id: id },
        { close_id: id },
        { cancel_id: id },
        { modify_id: id },
        { takeprofit_id: id },
        { stoploss_id: id },
        { takeprofit_cancel_id: id },
        { stoploss_cancel_id: id },
      ]
    };

    const order = await LiveUserOrder.findOne({ where });
    if (!order) return bad(res, 'order not found', 404);

    const userId = parseInt(order.order_user_id, 10);
    const user = await LiveUser.findByPk(userId);

    // Resolve group config by symbol + user.group
    const symbol = String(order.symbol || order.order_company_name || '').toUpperCase();
    const groupName = (user?.group || 'Standard');

    const group = await Group.findOne({ where: { symbol: symbol, name: groupName } });

    const payload = {
      order: {
        order_id: String(order.order_id),
        symbol,
        order_type: order.order_type,
        order_quantity: order.order_quantity?.toString?.() ?? String(order.order_quantity ?? ''),
        order_price: order.order_price?.toString?.() ?? String(order.order_price ?? ''),
        contract_value: order.contract_value?.toString?.() ?? null,
        // lifecycle ids for diagnostics
        close_id: order.close_id,
        cancel_id: order.cancel_id,
        modify_id: order.modify_id,
        takeprofit_id: order.takeprofit_id,
        stoploss_id: order.stoploss_id,
        takeprofit_cancel_id: order.takeprofit_cancel_id,
        stoploss_cancel_id: order.stoploss_cancel_id,
      },
      user: {
        user_id: userId,
        leverage: user?.leverage != null ? Number(user.leverage) : null,
        group: groupName,
        sending_orders: user?.sending_orders || null,
      },
      group_config: group ? {
        spread: group.spread?.toString?.() ?? null,
        spread_pip: group.spread_pip?.toString?.() ?? null,
        contract_size: group.contract_size?.toString?.() ?? null,
        profit: group.profit ?? null,
        type: group.type != null ? Number(group.type) : null,
      } : null,
    };

    return ok(res, payload, 'order lookup successful');
  } catch (err) {
    return bad(res, `lookup failed: ${err.message}`, 500);
  }
}

module.exports = { lookupOrderByAnyId };
