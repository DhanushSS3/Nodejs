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

// Generate Stop Loss ID with Redis-backed atomic counter to avoid collisions across workers
async function generateStopLossId() {
  const key = 'sl_seq';
  const seq = await redisCluster.incr(key);
  const seqStr = pad(seq, 9); // at least 9 digits; may grow beyond as seq increases
  return `SL${seqStr}`;
}

// Generate Take Profit ID with Redis-backed atomic counter to avoid collisions across workers
async function generateTakeProfitId() {
  const key = 'tp_seq';
  const seq = await redisCluster.incr(key);
  const seqStr = pad(seq, 9); // at least 9 digits; may grow beyond as seq increases
  return `TP${seqStr}`;
}

// Helpers for per-day numeric IDs with PREFIX + digits-only pattern if needed
async function generateDailyPrefixed(prefix, baseKey, padLen = 6) {
  const dateStr = yyyymmdd();
  const key = `${baseKey}:${dateStr}`;
  const seq = await redisCluster.incr(key);
  if (seq === 1) {
    try { await redisCluster.expire(key, 3 * 24 * 60 * 60); } catch (e) {}
  }
  const seqStr = pad(seq, padLen);
  // Keep digits-only after prefix for compatibility: PREFIX + YYYYMMDD + seq
  return `${prefix}${dateStr}${seqStr}`;
}

async function generateCancelOrderId() {
  return generateDailyPrefixed('CXL', 'cxl_seq', 6);
}

async function generateCloseOrderId() {
  return generateDailyPrefixed('CLS', 'cls_seq', 6);
}

async function generateStopLossCancelId() {
  return generateDailyPrefixed('SLC', 'slc_seq', 6);
}

async function generateTakeProfitCancelId() {
  return generateDailyPrefixed('TPC', 'tpc_seq', 6);
}

async function generateModifyId() {
  return generateDailyPrefixed('MOD', 'mod_seq', 6);
}

async function generateTransactionId() {
  return generateDailyPrefixed('TXN', 'txn_seq', 6);
}

module.exports = {
  generateOrderId,
  generateStopLossId,
  generateTakeProfitId,
  generateCancelOrderId,
  generateCloseOrderId,
  generateStopLossCancelId,
  generateTakeProfitCancelId,
  generateModifyId,
  generateTransactionId,
};
