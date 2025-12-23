const DEFAULT_ADMIN_SECRET = 'admin@livefxhub@123';

function getExpectedAdminSecret() {
  return process.env.ADMIN_LIVE_USERS_SECRET || DEFAULT_ADMIN_SECRET;
}

function extractAdminSecret(req) {
  if (!req) {
    return null;
  }

  const headerSecret =
    req.headers?.['x-admin-secret'] ||
    req.headers?.['x_admin_secret'] ||
    req.headers?.['xAdminSecret'];

  return headerSecret || req.query?.secret || req.body?.secret || null;
}

function isValidAdminSecret(providedSecret) {
  if (!providedSecret) {
    return false;
  }
  return providedSecret === getExpectedAdminSecret();
}

function enforceAdminSecret(req, res) {
  const providedSecret = extractAdminSecret(req);
  if (!providedSecret) {
    res.status(401).json({
      success: false,
      message: 'Unauthorized: admin secret is required'
    });
    return false;
  }

  if (!isValidAdminSecret(providedSecret)) {
    res.status(401).json({
      success: false,
      message: 'Unauthorized: invalid admin secret'
    });
    return false;
  }

  return true;
}

function requireAdminSecret(req, res, next) {
  if (enforceAdminSecret(req, res)) {
    return next();
  }
  return undefined;
}

module.exports = {
  extractAdminSecret,
  isValidAdminSecret,
  enforceAdminSecret,
  requireAdminSecret
};
