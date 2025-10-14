const SuperadminFreePassService = require('../services/superadmin.freepass.service');
const logger = require('../services/logger.service');

/**
 * Get admin ID from JWT token
 * @param {Object} admin - Admin object from JWT
 * @returns {number} Admin ID
 */
function getAdminId(admin) {
  return admin?.id || admin?.sub || admin?.user_id;
}

/**
 * Grant catalog free pass to a strategy provider
 * POST /api/superadmin/strategy-providers/:id/catalog-free-pass
 */
async function grantCatalogFreePass(req, res) {
  try {
    const adminId = getAdminId(req.admin);
    const strategyProviderId = parseInt(req.params.id);
    const { reason } = req.body;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    if (!strategyProviderId || isNaN(strategyProviderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid strategy provider ID'
      });
    }

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Reason is required and must be at least 10 characters'
      });
    }

    const result = await SuperadminFreePassService.grantCatalogFreePass(
      strategyProviderId, 
      adminId, 
      reason.trim()
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Catalog free pass granted via API', {
      strategyProviderId,
      adminId,
      adminEmail: req.admin.email,
      reason: reason.trim(),
      ip: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Catalog free pass granted successfully',
      data: result.data
    });

  } catch (error) {
    logger.error('Failed to grant catalog free pass via API', {
      strategyProviderId: req.params.id,
      adminId: getAdminId(req.admin),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while granting catalog free pass'
    });
  }
}

/**
 * Revoke catalog free pass from a strategy provider
 * DELETE /api/superadmin/strategy-providers/:id/catalog-free-pass
 */
async function revokeCatalogFreePass(req, res) {
  try {
    const adminId = getAdminId(req.admin);
    const strategyProviderId = parseInt(req.params.id);

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    if (!strategyProviderId || isNaN(strategyProviderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid strategy provider ID'
      });
    }

    const result = await SuperadminFreePassService.revokeCatalogFreePass(
      strategyProviderId, 
      adminId
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Catalog free pass revoked via API', {
      strategyProviderId,
      adminId,
      adminEmail: req.admin.email,
      ip: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Catalog free pass revoked successfully',
      data: result.data
    });

  } catch (error) {
    logger.error('Failed to revoke catalog free pass via API', {
      strategyProviderId: req.params.id,
      adminId: getAdminId(req.admin),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while revoking catalog free pass'
    });
  }
}

/**
 * Get all strategy providers with catalog free pass
 * GET /api/superadmin/strategy-providers/catalog-free-pass
 */
async function getFreePassAccounts(req, res) {
  try {
    const adminId = getAdminId(req.admin);

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    // Parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    // Parse filters
    const filters = {};
    
    if (req.query.search && req.query.search.trim()) {
      filters.search = req.query.search.trim();
    }
    
    if (req.query.granted_by) {
      const grantedBy = parseInt(req.query.granted_by);
      if (!isNaN(grantedBy)) {
        filters.granted_by = grantedBy;
      }
    }

    const result = await SuperadminFreePassService.getFreePassAccounts(filters, page, limit);

    logger.info('Free pass accounts retrieved via API', {
      adminId,
      filters,
      page,
      limit,
      totalFound: result.pagination.total_items,
      ip: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Free pass accounts retrieved successfully',
      data: result
    });

  } catch (error) {
    logger.error('Failed to get free pass accounts via API', {
      adminId: getAdminId(req.admin),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving free pass accounts'
    });
  }
}

/**
 * Get free pass history for a specific strategy provider
 * GET /api/superadmin/strategy-providers/:id/catalog-free-pass/history
 */
async function getFreePassHistory(req, res) {
  try {
    const adminId = getAdminId(req.admin);
    const strategyProviderId = parseInt(req.params.id);

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    if (!strategyProviderId || isNaN(strategyProviderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid strategy provider ID'
      });
    }

    const result = await SuperadminFreePassService.getFreePassHistory(strategyProviderId);

    return res.status(200).json({
      success: true,
      message: 'Free pass history retrieved successfully',
      data: result
    });

  } catch (error) {
    logger.error('Failed to get free pass history via API', {
      strategyProviderId: req.params.id,
      adminId: getAdminId(req.admin),
      error: error.message,
      ip: req.ip
    });

    if (error.message === 'Strategy provider not found') {
      return res.status(404).json({
        success: false,
        message: 'Strategy provider not found'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving free pass history'
    });
  }
}

/**
 * Get free pass statistics
 * GET /api/superadmin/strategy-providers/catalog-free-pass/statistics
 */
async function getFreePassStatistics(req, res) {
  try {
    const adminId = getAdminId(req.admin);

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    const result = await SuperadminFreePassService.getFreePassStatistics();

    return res.status(200).json({
      success: true,
      message: 'Free pass statistics retrieved successfully',
      data: result
    });

  } catch (error) {
    logger.error('Failed to get free pass statistics via API', {
      adminId: getAdminId(req.admin),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving free pass statistics'
    });
  }
}

module.exports = {
  grantCatalogFreePass,
  revokeCatalogFreePass,
  getFreePassAccounts,
  getFreePassHistory,
  getFreePassStatistics
};
