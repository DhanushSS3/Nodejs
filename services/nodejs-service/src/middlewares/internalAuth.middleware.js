const logger = require('../services/logger.service');

// Simple shared-secret middleware for internal routes
// Header: X-Internal-Auth: <secret>
// Env: INTERNAL_PROVIDER_SECRET or INTERNAL_API_SECRET
module.exports = function internalAuth(req, res, next) {
  try {
    const secret = process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || '';
    if (!secret) {
      // If not configured, deny by default to avoid accidental exposure
      return res.status(503).json({ success: false, message: 'Internal auth not configured' });
    }
    const hdr = req.get('X-Internal-Auth') || req.get('x-internal-auth') || '';
    if (!hdr || hdr !== secret) {
      return res.status(401).json({ success: false, message: 'Unauthorized (internal)' });
    }
    return next();
  } catch (e) {
    logger.error('internalAuth middleware error', { error: e.message });
    return res.status(500).json({ success: false, message: 'Internal auth error' });
  }
};
