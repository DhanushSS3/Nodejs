const moneyRequestService = require('../services/moneyRequest.service');
const logger = require('../services/logger.service');
const adminAuditService = require('../services/admin.audit.service');

function getAdmin(req) {
  const admin = req.admin || {};
  const adminId = admin.id || admin.sub || null;
  return { adminId };
}

// GET /api/superadmin/money-requests/pending?type=withdraw|deposit&limit=&offset=
async function getPending(req, res) {
  const operationId = `money_req_pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { type, limit, offset } = req.query || {};
    const allowedTypes = ['deposit', 'withdraw'];
    if (type && !allowedTypes.includes(String(type).toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Invalid type. Allowed: deposit, withdraw' });
    }
    const result = await moneyRequestService.getPendingRequests({ type, limit, offset });

    // Audit
    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUESTS_LIST_PENDING',
      ipAddress: req.ip,
      requestBody: { type, limit, offset },
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, message: 'Pending requests fetched', data: result });
  } catch (error) {
    logger.error('Failed to fetch pending money requests', { operationId, error: error.message });
    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUESTS_LIST_PENDING',
      ipAddress: req.ip,
      requestBody: { type: req.query?.type, limit: req.query?.limit, offset: req.query?.offset },
      status: 'FAILURE',
      errorMessage: error.message,
    });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /api/superadmin/money-requests/:requestId
async function getById(req, res) {
  const operationId = `money_req_get_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const id = parseInt(req.params.requestId, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const reqObj = await moneyRequestService.getRequestById(id);

    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUESTS_GET_BY_ID',
      ipAddress: req.ip,
      requestBody: { id },
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, data: reqObj });
  } catch (error) {
    logger.error('Failed to fetch money request by id', { operationId, error: error.message });
    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUESTS_GET_BY_ID',
      ipAddress: req.ip,
      requestBody: { id: parseInt(req.params.requestId, 10) },
      status: 'FAILURE',
      errorMessage: error.message,
    });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// POST /api/superadmin/money-requests/:requestId/approve
async function approve(req, res) {
  const operationId = `money_req_approve_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { adminId } = getAdmin(req);
    const id = parseInt(req.params.requestId, 10);
    const { notes } = req.body || {};
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const updated = await moneyRequestService.approveRequest(id, adminId, notes || null);

    await adminAuditService.logAction({
      adminId,
      action: 'MONEY_REQUEST_APPROVE',
      ipAddress: req.ip,
      requestBody: { id, notes },
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, message: 'Request approved', data: updated });
  } catch (error) {
    logger.error('Failed to approve money request', { operationId, error: error.message });
    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUEST_APPROVE',
      ipAddress: req.ip,
      requestBody: { id: parseInt(req.params.requestId, 10), notes: req.body?.notes },
      status: 'FAILURE',
      errorMessage: error.message,
    });
    return res.status(400).json({ success: false, message: error.message || 'Failed to approve request' });
  }
}

// POST /api/superadmin/money-requests/:requestId/reject
async function reject(req, res) {
  const operationId = `money_req_reject_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { adminId } = getAdmin(req);
    const id = parseInt(req.params.requestId, 10);
    const { notes } = req.body || {};
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const updated = await moneyRequestService.rejectRequest(id, adminId, notes || null);

    await adminAuditService.logAction({
      adminId,
      action: 'MONEY_REQUEST_REJECT',
      ipAddress: req.ip,
      requestBody: { id, notes },
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, message: 'Request rejected', data: updated });
  } catch (error) {
    logger.error('Failed to reject money request', { operationId, error: error.message });
    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUEST_REJECT',
      ipAddress: req.ip,
      requestBody: { id: parseInt(req.params.requestId, 10), notes: req.body?.notes },
      status: 'FAILURE',
      errorMessage: error.message,
    });
    return res.status(400).json({ success: false, message: error.message || 'Failed to reject request' });
  }
}

// POST /api/superadmin/money-requests/:requestId/hold
async function hold(req, res) {
  const operationId = `money_req_hold_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { adminId } = getAdmin(req);
    const id = parseInt(req.params.requestId, 10);
    const { notes } = req.body || {};
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const updated = await moneyRequestService.holdRequest(id, adminId, notes || null);

    await adminAuditService.logAction({
      adminId,
      action: 'MONEY_REQUEST_HOLD',
      ipAddress: req.ip,
      requestBody: { id, notes },
      status: 'SUCCESS',
    });
    return res.status(200).json({ success: true, message: 'Request put on hold', data: updated });
  } catch (error) {
    logger.error('Failed to hold money request', { operationId, error: error.message });
    await adminAuditService.logAction({
      adminId: req.admin?.id,
      action: 'MONEY_REQUEST_HOLD',
      ipAddress: req.ip,
      requestBody: { id: parseInt(req.params.requestId, 10), notes: req.body?.notes },
      status: 'FAILURE',
      errorMessage: error.message,
    });
    return res.status(400).json({ success: false, message: error.message || 'Failed to hold request' });
  }
}

module.exports = { getPending, getById, approve, reject, hold };
