const CatalogEligibilityCronService = require('../services/cron/catalogEligibility.cron.service');
const logger = require('../services/logger.service');

/**
 * Get user ID from JWT token
 * @param {Object} user - User object from JWT
 * @returns {number} User ID
 */
function getUserId(user) {
  return user?.sub || user?.user_id || user?.id;
}

/**
 * Manually trigger catalog eligibility update (Admin only)
 * POST /api/admin/cron/catalog-eligibility/trigger
 */
async function triggerCatalogEligibilityUpdate(req, res) {
  try {
    const adminId = getUserId(req.user);
    
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    logger.info('Manual catalog eligibility update triggered by admin', {
      adminId,
      adminEmail: req.user.email,
      ip: req.ip
    });

    // Trigger the update (this runs asynchronously)
    const result = await CatalogEligibilityCronService.manualTriggerUpdate();

    return res.status(200).json({
      success: true,
      message: 'Catalog eligibility update triggered successfully',
      data: {
        triggered_at: new Date().toISOString(),
        triggered_by: req.user.email,
        status: 'Update job started - check logs for progress'
      }
    });

  } catch (error) {
    logger.error('Failed to trigger catalog eligibility update', {
      adminId: getUserId(req.user),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while triggering catalog eligibility update'
    });
  }
}

/**
 * Get catalog eligibility cron job status (Admin only)
 * GET /api/admin/cron/catalog-eligibility/status
 */
async function getCatalogEligibilityStatus(req, res) {
  try {
    const adminId = getUserId(req.user);
    
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    const status = CatalogEligibilityCronService.getCronJobStatus();

    return res.status(200).json({
      success: true,
      message: 'Catalog eligibility cron job status retrieved successfully',
      data: {
        cron_job: status,
        last_checked: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Failed to get catalog eligibility cron status', {
      adminId: getUserId(req.user),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving cron job status'
    });
  }
}

module.exports = {
  triggerCatalogEligibilityUpdate,
  getCatalogEligibilityStatus
};
