const { redisCluster } = require('../../config/redis');

function pad(num, size) {
  let s = String(num);
  while (s.length < size) s = '0' + s;
  return s;
}

function yyyymmdd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function generateOrderId() {
  const dateStr = yyyymmdd();
  const key = `order_seq:${dateStr}`;
  const seq = await redisCluster.incr(key);
  // Set a TTL so old counters expire (3 days)
  if (seq === 1) {
    try { await redisCluster.expire(key, 3 * 24 * 60 * 60); } catch (e) {}
  }
  const seqStr = pad(seq, 3);
  return `ord_${dateStr}_${seqStr}`;
}

module.exports = { generateOrderId };
