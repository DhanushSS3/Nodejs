const LiveUser = require('../models/liveUser.model');

class LiveUserStatusService {
  /**
   * Ensure the provided live user exists and is active (status === 1 and is_active === 1)
   * @param {number|Object} userOrRecord - Live user ID or an existing LiveUser record/plain object
   * @param {Object} [options]
   * @param {import('sequelize').Transaction} [options.transaction]
   * @param {string} [options.context] - Optional context string for error messages/logs
   * @returns {Promise<import('../models/liveUser.model')|Object>} LiveUser instance (or the provided record)
   */
  async assertActive(userOrRecord, options = {}) {
    const { transaction, context } = options;

    if (!userOrRecord) {
      const error = new Error('Live user reference is required');
      error.statusCode = 400;
      throw error;
    }

    let liveUser = null;

    if (typeof userOrRecord === 'object' && userOrRecord.id) {
      liveUser = userOrRecord;

      // If the provided record is missing status/is_active, fall back to DB fetch
      if (liveUser.status === undefined || liveUser.is_active === undefined) {
        liveUser = await LiveUser.findByPk(liveUser.id, { transaction });
      }
    } else {
      const userId = Number(userOrRecord);
      if (!Number.isFinite(userId)) {
        const error = new Error('Live user ID is invalid');
        error.statusCode = 400;
        throw error;
      }
      liveUser = await LiveUser.findByPk(userId, { transaction });
    }

    if (!liveUser) {
      const error = new Error('Live user account not found');
      error.statusCode = 404;
      throw error;
    }

    if (Number(liveUser.status) !== 1 || Number(liveUser.is_active) !== 1) {
      const error = new Error('Live user account is inactive');
      error.statusCode = 403;
      error.context = context || 'live_user_status';
      throw error;
    }

    return liveUser;
  }
}

module.exports = new LiveUserStatusService();
