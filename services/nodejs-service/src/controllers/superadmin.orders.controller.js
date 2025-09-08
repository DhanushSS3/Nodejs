const OrdersIndexRebuildService = require('../services/orders.index.rebuild.service');
const OrdersBackfillService = require('../services/orders.backfill.service');

function ok(res, data, message = 'OK') {
  return res.status(200).json({ success: true, message, data });
}
function bad(res, message, code = 400) {
  return res.status(code).json({ success: false, message });
}

// POST /api/superadmin/orders/rebuild/user
// body: { user_type: 'live'|'demo', user_id: string|number, include_queued?: boolean, backfill?: boolean }
async function rebuildUser(req, res) {
  try {
    const user_type = String(req.body.user_type || '').toLowerCase();
    const user_id = String(req.body.user_id || '').trim();
    const includeQueued = Boolean(req.body.include_queued);
    const backfill = Boolean(req.body.backfill);

    if (!['live', 'demo'].includes(user_type) || !user_id) {
      return bad(res, 'user_type must be live|demo and user_id is required');
    }

    let result;
    if (backfill) {
      // Backfill holdings from SQL, then ensure index and symbol holders
      result = await OrdersBackfillService.backfillUserHoldingsFromSql(user_type, user_id, { includeQueued });
    } else {
      // Only rebuild indices from existing holdings
      result = await OrdersIndexRebuildService.rebuildUserIndices(user_type, user_id);
    }

    return ok(res, result, backfill ? 'User holdings backfilled from SQL and indices rebuilt' : 'User indices rebuilt from holdings');
  } catch (err) {
    return bad(res, `Failed to rebuild user indices: ${err.message}`, 500);
  }
}

// POST /api/superadmin/orders/rebuild/symbol
// body: { symbol: string, scope?: 'live'|'demo'|'both' }
async function rebuildSymbol(req, res) {
  try {
    const symbol = String(req.body.symbol || '').trim();
    const scope = req.body.scope ? String(req.body.scope).toLowerCase() : 'both';
    if (!symbol) return bad(res, 'symbol is required');
    if (!['live', 'demo', 'both'].includes(scope)) return bad(res, 'scope must be live|demo|both');

    const result = await OrdersIndexRebuildService.rebuildSymbolHolders(symbol, scope);
    return ok(res, result, 'Symbol holders ensured from indices');
  } catch (err) {
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

module.exports = {
  rebuildUser,
  rebuildSymbol,
  ensureHolding,
  ensureSymbolHolder,
};
