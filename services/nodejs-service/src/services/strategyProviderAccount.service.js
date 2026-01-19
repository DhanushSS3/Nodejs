const StrategyProviderAccount = require('../models/strategyProviderAccount.model');

class StrategyProviderAccountService {
  /**
   * Ensures the provided strategy provider account exists, belongs to the user, and is active
   * @param {Object} params
   * @param {number} params.userId - Owner live user ID from JWT
   * @param {number} params.strategyProviderAccountId - Strategy provider account ID
   * @param {string} [params.context]
   */
  async assertActiveStrategyProviderAccount({ userId, strategyProviderAccountId, context }) {
    if (!Number.isInteger(userId) || userId <= 0) {
      const error = new Error('Live user ID is required for strategy provider validation');
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isInteger(strategyProviderAccountId) || strategyProviderAccountId <= 0) {
      const error = new Error('Strategy provider account ID is invalid');
      error.statusCode = 400;
      throw error;
    }

    const strategyProvider = await StrategyProviderAccount.findOne({
      where: {
        id: strategyProviderAccountId,
        user_id: userId
      }
    });

    if (!strategyProvider) {
      const error = new Error('Strategy provider account not found');
      error.statusCode = 404;
      error.context = context;
      throw error;
    }

    if (Number(strategyProvider.status) !== 1 || Number(strategyProvider.is_active) !== 1) {
      const error = new Error('Strategy provider account is inactive');
      error.statusCode = 403;
      error.context = context;
      throw error;
    }

    return strategyProvider;
  }
}

module.exports = new StrategyProviderAccountService();
