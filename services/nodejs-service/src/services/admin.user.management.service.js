const { LiveUser, DemoUser } = require('../models');
const { Op } = require('sequelize');
const logger = require('./logger.service');

class AdminUserManagementService {
  /**
   * Lists live users. It expects a scoped model to be passed from the controller.
   * @param {Model} ScopedLiveUser - The Sequelize LiveUser model, potentially with a scope applied.
   */
  async listLiveUsers(ScopedLiveUser) {
    return ScopedLiveUser.findAll({
      order: [['created_at', 'DESC']],
    });
  }

  /**
   * Lists demo users. It expects a scoped model to be passed from the controller.
   * @param {Model} ScopedDemoUser - The Sequelize DemoUser model, potentially with a scope applied.
   */
  async listDemoUsers(ScopedDemoUser) {
    return ScopedDemoUser.findAll({
      order: [['created_at', 'DESC']],
    });
  }

  /**
   * Updates a live user's information (excluding sensitive fields)
   * @param {number} userId - The ID of the user to update
   * @param {Object} updateData - The data to update
   * @param {Model} ScopedLiveUser - The scoped LiveUser model
   * @param {Object} adminInfo - Information about the admin performing the update
   * @returns {Object} Updated user information
   */
  async updateLiveUser(userId, updateData, ScopedLiveUser, adminInfo) {
    const operationId = `update_live_user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {

      // Find the user first to ensure it exists and is accessible
      const user = await ScopedLiveUser.findByPk(userId);
      if (!user) {
        logger.error('Live user not found', {
          operationId,
          userId,
          adminRole: adminInfo.role,
          message: 'The specified user ID does not exist in the live_users table'
        });
        throw new Error('User not found');
      }

      // Define fields that cannot be updated via this endpoint
      const restrictedFields = ['id', 'password', 'account_number', 'created_at', 'updated_at'];
      
      // Remove restricted fields from update data
      const sanitizedData = { ...updateData };
      restrictedFields.forEach(field => delete sanitizedData[field]);

      // Handle country_id lookup if country name is provided
      if (sanitizedData.country) {
        const Country = require('../models/country.model');
        const Sequelize = require('sequelize');
        const countryRecord = await Country.findOne({
          where: Sequelize.where(
            Sequelize.fn('LOWER', Sequelize.col('name')),
            sanitizedData.country.toLowerCase()
          )
        });
        if (countryRecord) {
          sanitizedData.country_id = countryRecord.id;
        }
      }

      // Update the user
      await user.update(sanitizedData);

      // Log the update operation
      logger.info('Live user updated by admin', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userId: user.id,
        updatedFields: Object.keys(sanitizedData),
        userEmail: user.email
      });

      // Return updated user (excluding sensitive fields)
      const { password, ...userResponse } = user.toJSON();
      return userResponse;

    } catch (error) {
      logger.error('Failed to update live user', {
        operationId,
        adminId: adminInfo.id,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Updates a demo user's information (excluding sensitive fields)
   * @param {number} userId - The ID of the user to update
   * @param {Object} updateData - The data to update
   * @param {Model} ScopedDemoUser - The scoped DemoUser model
   * @param {Object} adminInfo - Information about the admin performing the update
   * @returns {Object} Updated user information
   */
  async updateDemoUser(userId, updateData, ScopedDemoUser, adminInfo) {
    const operationId = `update_demo_user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Find the user first to ensure it exists and is accessible
      const user = await ScopedDemoUser.findByPk(userId);
      if (!user) {
        logger.error('Demo user not found', {
          operationId,
          userId,
          adminRole: adminInfo.role,
          message: 'The specified user ID does not exist in the demo_users table'
        });
        throw new Error('User not found');
      }

      // Define fields that cannot be updated via this endpoint
      const restrictedFields = ['id', 'password', 'account_number', 'created_at', 'updated_at'];
      
      // Remove restricted fields from update data
      const sanitizedData = { ...updateData };
      restrictedFields.forEach(field => delete sanitizedData[field]);

      // Handle country_id lookup if country name is provided
      if (sanitizedData.country) {
        const Country = require('../models/country.model');
        const Sequelize = require('sequelize');
        const countryRecord = await Country.findOne({
          where: Sequelize.where(
            Sequelize.fn('LOWER', Sequelize.col('name')),
            sanitizedData.country.toLowerCase()
          )
        });
        if (countryRecord) {
          sanitizedData.country_id = countryRecord.id;
        }
      }

      // Update the user
      await user.update(sanitizedData);

      // Log the update operation
      logger.info('Demo user updated by admin', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userId: user.id,
        updatedFields: Object.keys(sanitizedData),
        userEmail: user.email
      });

      // Return updated user (excluding sensitive fields)
      const { password, ...userResponse } = user.toJSON();
      return userResponse;

    } catch (error) {
      logger.error('Failed to update demo user', {
        operationId,
        adminId: adminInfo.id,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validates update data for user information
   * @param {Object} updateData - The data to validate
   * @param {string} userType - 'live' or 'demo'
   * @returns {Object} Validation result
   */
  validateUpdateData(updateData, userType = 'live') {
    const errors = [];
    
    // Email validation
    if (updateData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updateData.email)) {
      errors.push('Invalid email format');
    }

    // Phone number validation
    if (updateData.phone_number && !/^\+?[\d\s\-\(\)]{10,}$/.test(updateData.phone_number)) {
      errors.push('Invalid phone number format');
    }

    // Leverage validation (for live users)
    if (userType === 'live' && updateData.leverage && (updateData.leverage < 1 || updateData.leverage > 1000)) {
      errors.push('Leverage must be between 1 and 1000');
    }

    // Status validation
    if (updateData.status !== undefined && ![0, 1].includes(updateData.status)) {
      errors.push('Status must be 0 or 1');
    }

    // is_active validation
    if (updateData.is_active !== undefined && ![0, 1].includes(updateData.is_active)) {
      errors.push('is_active must be 0 or 1');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

module.exports = new AdminUserManagementService();
