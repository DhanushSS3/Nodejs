const { redisCluster } = require('../../config/redis');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function norm(v) {
  return (v ?? '').toString();
}

function isCanonicalIncomplete(canonical) {
  if (!canonical) return true;
  return (
    !canonical.user_id ||
    !canonical.user_type ||
    !(canonical.symbol || canonical.order_company_name) ||
    !canonical.order_type ||
    !(toNum(canonical.order_price) > 0)
  );
}

async function repopulateFromSql(order_id, row, user_type) {
  const key = `order_data:${String(order_id)}`;
  const payload = {
    order_id: String(order_id),
    user_id: String(row.order_user_id),
    user_type: String(user_type),
    symbol: norm(row.symbol || row.order_company_name).toUpperCase(),
    order_type: norm(row.order_type).toUpperCase(),
    order_price: String(row.order_price ?? ''),
    order_quantity: String(row.order_quantity ?? ''),
    order_status: norm(row.order_status).toUpperCase(),
  };
  await redisCluster.hset(key, payload);
}

async function fetchCanonicalOrder(order_id) {
  try {
    const key = `order_data:${String(order_id)}`;
    const od = await redisCluster.hgetall(key);
    if (od && Object.keys(od).length > 0) return od;
  } catch (_) {}
  return null;
}

function chooseSymbolOrderType(canonical, row, symbolReq, orderTypeReq) {
  let symbol = symbolReq;
  let order_type = orderTypeReq;
  if (canonical) {
    if (canonical.symbol || canonical.order_company_name) {
      symbol = norm(canonical.symbol || canonical.order_company_name).toUpperCase();
    }
    if (canonical.order_type) {
      order_type = norm(canonical.order_type).toUpperCase();
    }
  }
  if (row) {
    if (row.symbol || row.order_company_name) {
      symbol = norm(row.symbol || row.order_company_name).toUpperCase();
    }
    if (row.order_type) {
      order_type = norm(row.order_type).toUpperCase();
    }
  }
  return { symbol, order_type };
}

function chooseEntryAndQuantity(canonical, row, preferRow) {
  const entry_price = preferRow
    ? toNum(row ? row.order_price : NaN)
    : toNum(canonical ? canonical.order_price : NaN);
  const order_quantity = preferRow
    ? toNum(row ? row.order_quantity : NaN)
    : toNum(canonical ? canonical.order_quantity : NaN);
  return { entry_price, order_quantity };
}

module.exports = {
  isCanonicalIncomplete,
  repopulateFromSql,
  fetchCanonicalOrder,
  chooseSymbolOrderType,
  chooseEntryAndQuantity,
};
