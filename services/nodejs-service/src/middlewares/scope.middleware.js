const { LiveUser, DemoUser } = require('../models'); // Import all scoped models

const applyScope = (req, res, next) => {
  const { admin } = req;

  // If there's no authenticated admin or the admin is a superadmin, do nothing.
  if (!admin || admin.role === 'superadmin') {
    return next();
  }

  // For other roles, apply the country scope.
  const countryId = admin.country_id;
  if (!countryId) {
    // This case should ideally not happen for non-superadmins, but as a safeguard:
    return res.status(403).json({ message: 'Forbidden: Your role requires a country assignment.' });
  }

  // Apply scope to all relevant models
  req.scopedModels = {
    LiveUser: LiveUser.scope({ method: ['countryScoped', countryId] }),
    DemoUser: DemoUser.scope({ method: ['countryScoped', countryId] }),
    // Add other models here as they become country-scoped
  };

  next();
};

module.exports = { applyScope };
