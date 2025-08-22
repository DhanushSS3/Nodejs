const adminUserManagementService = require('../services/admin.user.management.service');
const { validationResult } = require('express-validator');

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

  /**
   * Updates a live user's information
   * Requires 'user:update' permission
   * Country-level admins can only update users from their country
   * Superadmins can update any user
   */
  async updateLiveUser(req, res, next) {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const updateData = req.body;
      const admin = req.admin;

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID. Must be a positive integer.'
        });
      }

      // Validate update data
      const validation = adminUserManagementService.validateUpdateData(updateData, 'live');
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid update data',
          errors: validation.errors
        });
      }

      // Use scoped model to ensure country-level access control
      const ScopedLiveUser = req.scopedModels.LiveUser;
      
      const updatedUser = await adminUserManagementService.updateLiveUser(
        userIdInt,
        updateData,
        ScopedLiveUser,
        admin
      );

      res.status(200).json({
        success: true,
        message: 'Live user updated successfully',
        data: updatedUser
      });

    } catch (error) {
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'Live user not found with the specified ID'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Failed to update live user',
        error: error.message
      });
    }
  }

  /**
   * Updates a demo user's information
   * Requires 'user:update' permission
   * Country-level admins can only update users from their country
   * Superadmins can update any user
   */
  async updateDemoUser(req, res, next) {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const updateData = req.body;
      const admin = req.admin;

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID. Must be a positive integer.'
        });
      }

      // Validate update data
      const validation = adminUserManagementService.validateUpdateData(updateData, 'demo');
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid update data',
          errors: validation.errors
        });
      }

      // Use scoped model to ensure country-level access control
      const ScopedDemoUser = req.scopedModels.DemoUser;
      
      const updatedUser = await adminUserManagementService.updateDemoUser(
        userIdInt,
        updateData,
        ScopedDemoUser,
        admin
      );

      res.status(200).json({
        success: true,
        message: 'Demo user updated successfully',
        data: updatedUser
      });

    } catch (error) {
      if (error.message === 'User not found') {
        return res.status(404).json({
          success: false,
          message: 'Demo user not found with the specified ID'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Failed to update demo user',
        error: error.message
      });
    }
  }
}

module.exports = new AdminUserManagementController();
