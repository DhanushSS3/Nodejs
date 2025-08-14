const adminUserManagementService = require('../services/admin.user.management.service');

class AdminUserManagementController {
  async listLiveUsers(req, res, next) {
    try {
      // The applyScope middleware provides the correctly scoped model
      const ScopedLiveUser = req.scopedModels.LiveUser;
      const users = await adminUserManagementService.listLiveUsers(ScopedLiveUser);
      res.status(200).json(users);
    } catch (error) {
      res.status(500).json({ message: 'Failed to retrieve live users', error: error.message });
    }
  }

  async listDemoUsers(req, res, next) {
    try {
      // The applyScope middleware provides the correctly scoped model
      const ScopedDemoUser = req.scopedModels.DemoUser;
      const users = await adminUserManagementService.listDemoUsers(ScopedDemoUser);
      res.status(200).json(users);
    } catch (error) {
      res.status(500).json({ message: 'Failed to retrieve demo users', error: error.message });
    }
  }
}

module.exports = new AdminUserManagementController();
