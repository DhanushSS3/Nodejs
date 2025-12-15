const logger = require('./logger.service');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const {
  fetchCanonicalOrder,
  isCanonicalIncomplete,
  repopulateFromSql,
  chooseSymbolOrderType,
  chooseEntryAndQuantity,
} = require('./order.canonical.util');

function getOrderModel(user_type) {
  const ut = String(user_type || '').toLowerCase();
  if (ut === 'live') return LiveUserOrder;
  if (ut === 'demo') return DemoUserOrder;
  throw new Error('unsupported_user_type');
}

async function resolveOpenOrder({ order_id, user_id, user_type, symbolReq, orderTypeReq }) {
  const canonical = await fetchCanonicalOrder(order_id);
  const OrderModel = getOrderModel(user_type);
  const incomplete = isCanonicalIncomplete(canonical);

  let row = null;
  let repopulated = false;
  let preferRow = false;

  if (!canonical || incomplete) {
    // SQL fallback path
    row = await OrderModel.findOne({ where: { order_id: String(order_id) } });
    if (!row) {
      const err = new Error('order_not_found');
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }
    if (String(row.order_user_id) !== String(user_id)) {
      const err = new Error('order_does_not_belong_to_user');
      err.code = 'ORDER_NOT_BELONG_TO_USER';
      throw err;
    }
    const st = (row.order_status || '').toString().toUpperCase();
    if (st && st !== 'OPEN') {
      const err = new Error('order_not_open');
      err.code = 'ORDER_NOT_OPEN';
      err.status = st;
      throw err;
    }
    // Heal legacy canonical
    try {
      await repopulateFromSql(order_id, row, user_type);
      repopulated = true;
    } catch (e) {
      logger.warn('Resolver: Failed to repopulate canonical from SQL', { order_id, error: e.message });
    }
    preferRow = true;
  } else {
    // Canonical path
    if (String(canonical.user_id) !== String(user_id) || String(canonical.user_type).toLowerCase() !== String(user_type).toLowerCase()) {
      const err = new Error('order_does_not_belong_to_user');
      err.code = 'ORDER_NOT_BELONG_TO_USER';
      throw err;
    }
    const st = (canonical.order_status || '').toString().toUpperCase();
    if (st && st !== 'OPEN') {
      const err = new Error('order_not_open');
      err.code = 'ORDER_NOT_OPEN';
      err.status = st;
      throw err;
    }
  }

  const { symbol, order_type } = chooseSymbolOrderType(canonical, row, symbolReq, orderTypeReq);
  const { entry_price, order_quantity } = chooseEntryAndQuantity(canonical, row, preferRow);

  return {
    source: preferRow ? 'sql' : 'canonical',
    canonical,
    row,
    repopulated,
    symbol,
    order_type,
    entry_price,
    order_quantity,
  };
}

module.exports = {
  getOrderModel,
  resolveOpenOrder,
};
