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

module.exports = {
  isCanonicalIncomplete,
  repopulateFromSql,
};
