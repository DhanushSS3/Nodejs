const requireMamManager = (req, res, next) => {
  if (!req.user || req.user.account_type !== 'mam_manager') {
    return res.status(403).json({ success: false, message: 'MAM manager authentication required' });
  }

  if (!req.user.is_active) {
    return res.status(403).json({ success: false, message: 'MAM manager account inactive' });
  }

  if (!req.user.mam_account_id) {
    return res.status(403).json({ success: false, message: 'MAM manager does not have an active account' });
  }

  return next();
};

module.exports = {
  requireMamManager
};
