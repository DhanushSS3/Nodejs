const Group = require('../models/group.model');

function ok(res, data, message = 'OK') {
  return res.status(200).json({ success: true, message, data });
}
function bad(res, message, code = 400) {
  return res.status(code).json({ success: false, message });
}

// GET /api/internal/provider/groups/:group/:symbol
// Look up group config by (group name, symbol) and return margin-related fields
async function lookupGroupConfig(req, res) {
  try {
    const group = String(req.params.group || '').trim();
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!group || !symbol) return bad(res, 'group and symbol are required', 400);

    const row = await Group.findOne({ where: { name: group, symbol } });
    if (!row) return bad(res, 'group config not found', 404);

    const data = {
      name: row.name,
      symbol: row.symbol.toUpperCase(),
      type: row.type != null ? Number(row.type) : null,
      contract_size: row.contract_size?.toString?.() ?? null,
      profit: row.profit ?? null,
      spread: row.spread?.toString?.() ?? null,
      spread_pip: row.spread_pip?.toString?.() ?? null,
      margin: row.margin?.toString?.() ?? null,
      commision: row.commision?.toString?.() ?? null,
      commision_type: row.commision_type != null ? Number(row.commision_type) : null,
      commision_value_type: row.commision_value_type != null ? Number(row.commision_value_type) : null,
      pips: row.pips?.toString?.() ?? null,
    };

    return ok(res, data, 'group config');
  } catch (err) {
    return bad(res, `lookup failed: ${err.message}`, 500);
  }
}

module.exports = { lookupGroupConfig };
