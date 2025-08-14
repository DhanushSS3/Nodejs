const { LiveUser, DemoUser } = require('../models');

class AdminUserManagementService {
  /**
   * Lists live users. It expects a scoped model to be passed from the controller.
   * @param {Model} ScopedLiveUser - The Sequelize LiveUser model, potentially with a scope applied.
   */
  async listLiveUsers(ScopedLiveUser) {
    return ScopedLiveUser.findAll({
      order: [['createdAt', 'DESC']],
    });
  }

  /**
   * Lists demo users. It expects a scoped model to be passed from the controller.
   * @param {Model} ScopedDemoUser - The Sequelize DemoUser model, potentially with a scope applied.
   */
  async listDemoUsers(ScopedDemoUser) {
    return ScopedDemoUser.findAll({
      order: [['createdAt', 'DESC']],
    });
  }
}

module.exports = new AdminUserManagementService();
