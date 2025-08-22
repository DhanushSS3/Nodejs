const { LiveUser, DemoUser } = require('../models'); // Import all scoped models

const applyScope = (req, res, next) => {
  const { admin } = req;

  // If there's no authenticated admin, do nothing.
  if (!admin) {
    return next();
  }

  // If the admin is a superadmin, provide unscoped models.
  if (admin.role === 'superadmin') {
    req.scopedModels = {
      LiveUser,
      DemoUser
    };
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

// Enhanced scope filtering that automatically applies country filtering to queries
const autoApplyCountryFilter = (req, res, next) => {
  const { admin } = req;

  // Skip filtering for superadmin (country_id = null)
  if (!admin || admin.role === 'superadmin' || !admin.country_id) {
    return next();
  }

  // Store the country filter for use in controllers
  req.countryFilter = { country_id: admin.country_id };
  
  // Add helper function to apply country filter to Sequelize queries
  req.applyCountryFilter = (whereClause = {}) => {
    return {
      ...whereClause,
      country_id: admin.country_id
    };
  };

  next();
};

// Middleware to ensure country-scoped admins can only access their country's data
const enforceCountryScope = (req, res, next) => {
  const { admin } = req;
  const { country_id } = req.params;

  // Superadmin can access any country
  if (!admin || admin.role === 'superadmin') {
    return next();
  }

  // If country_id is provided in params, ensure it matches admin's country
  if (country_id && parseInt(country_id) !== admin.country_id) {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied: You can only access data from your assigned country.' 
    });
  }

  next();
};

module.exports = { 
  applyScope, 
  autoApplyCountryFilter,
  enforceCountryScope 
};
