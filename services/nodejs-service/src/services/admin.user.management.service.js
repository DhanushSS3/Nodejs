const { LiveUser, DemoUser, LiveUserOrder, DemoUserOrder, StrategyProviderAccount, CopyFollowerAccount } = require('../models');
const { Op } = require('sequelize');
const logger = require('./logger.service');
const redisUserCache = require('./redis.user.cache.service');
const redisSyncService = require('./redis.sync.service');

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

      // Store old values for comparison (especially group changes)
      const oldValues = {
        group: user.group,
        leverage: user.leverage,
        status: user.status,
        is_active: user.is_active,
        wallet_balance: user.wallet_balance,
        margin: user.margin,
        net_profit: user.net_profit
      };

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

      // Extract cacheable fields for Redis update
      const cacheableFields = this.extractCacheableFields(sanitizedData, 'live');
      
      // Comprehensive Redis sync after database update
      if (Object.keys(cacheableFields).length > 0) {
        try {
          // Check if group changed for special handling
          const groupChanged = sanitizedData.hasOwnProperty('group') && oldValues.group !== sanitizedData.group;
          
          // Use comprehensive Redis sync service
          await redisSyncService.syncUserAfterAdminUpdate(userId, 'live', cacheableFields, {
            oldGroup: oldValues.group,
            admin_id: adminInfo.id,
            operation_type: 'admin_user_update',
            group_changed: groupChanged
          });
          
          // Also maintain backward compatibility with existing pub/sub
          await redisUserCache.publishUserUpdate('live', userId, cacheableFields);
          
        } catch (redisSyncError) {
          logger.error('Redis sync failed after live user update - database is consistent', {
            operationId,
            userId,
            error: redisSyncError.message,
            updatedFields: Object.keys(cacheableFields)
          });
          // Don't throw - database is authoritative
        }
      }

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

      // Store old values for comparison (especially group changes)
      const oldValues = {
        group: user.group,
        leverage: user.leverage,
        status: user.status,
        is_active: user.is_active,
        wallet_balance: user.wallet_balance,
        margin: user.margin,
        net_profit: user.net_profit
      };

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

      // Extract cacheable fields for Redis update
      const cacheableFields = this.extractCacheableFields(sanitizedData, 'demo');
      
      // Comprehensive Redis sync after database update
      if (Object.keys(cacheableFields).length > 0) {
        try {
          // Check if group changed for special handling
          const groupChanged = sanitizedData.hasOwnProperty('group') && oldValues.group !== sanitizedData.group;
          
          // Use comprehensive Redis sync service
          await redisSyncService.syncUserAfterAdminUpdate(userId, 'demo', cacheableFields, {
            oldGroup: oldValues.group,
            admin_id: adminInfo.id,
            operation_type: 'admin_user_update',
            group_changed: groupChanged
          });
          
          // Also maintain backward compatibility with existing pub/sub
          await redisUserCache.publishUserUpdate('demo', userId, cacheableFields);
          
        } catch (redisSyncError) {
          logger.error('Redis sync failed after demo user update - database is consistent', {
            operationId,
            userId,
            error: redisSyncError.message,
            updatedFields: Object.keys(cacheableFields)
          });
          // Don't throw - database is authoritative
        }
      }

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

  /**
   * Extract cacheable fields from update data based on user type
   * @param {Object} updateData - The update data
   * @param {string} userType - 'live' or 'demo'
   * @returns {Object} Cacheable fields only
   */
  extractCacheableFields(updateData, userType) {
    const cacheableFields = {};
    
    // Common fields for both user types
    const commonFields = [
      'wallet_balance', 'leverage', 'margin', 'account_number',
      'group', 'status', 'is_active', 'country_id'
    ];
    
    // Additional fields for live users only
    const liveOnlyFields = [
      'mam_id', 'mam_status', 'pam_id', 'pam_status',
      'copy_trading_wallet', 'copytrader_id', 'copytrading_status', 'copytrading_alloted_time',
      'sending_orders'
    ];
    
    // Extract common fields
    commonFields.forEach(field => {
      if (updateData.hasOwnProperty(field)) {
        cacheableFields[field] = updateData[field];
      }
    });
    
    // Extract live-only fields if user type is live
    if (userType === 'live') {
      liveOnlyFields.forEach(field => {
        if (updateData.hasOwnProperty(field)) {
          cacheableFields[field] = updateData[field];
        }
      });
    }
    
    return cacheableFields;
  }

  /**
   * Fetches open and queued orders for a specific user (live or demo)
   * Only returns orders with status 'OPEN' or 'QUEUED' (excludes 'PENDING')
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - The ID of the user
   * @param {Model} ScopedUserModel - The scoped user model for access control
   * @param {Object} adminInfo - Information about the admin performing the request
   * @returns {Object} User orders and metadata
   */
  async getUserOpenOrders(userType, userId, ScopedUserModel, adminInfo) {
    const operationId = `get_user_orders_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Validate userType
      if (!['live', 'demo'].includes(userType)) {
        throw new Error('Invalid user type. Must be "live" or "demo"');
      }

      // Validate userId
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        throw new Error('Invalid user ID. Must be a positive integer');
      }

      // First, verify the user exists and is accessible to this admin (respects country scoping)
      const user = await ScopedUserModel.findByPk(userIdInt, {
        attributes: ['id', 'name', 'email', 'account_number', 'group', 'status', 'is_active']
      });

      if (!user) {
        logger.warn('User not found or access denied for admin', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId: userIdInt,
          message: 'User not found in accessible scope'
        });
        throw new Error('User not found or access denied');
      }

      // Select the appropriate order model
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      
      // Debug logging to check if models are properly loaded
      logger.info('Order model selection debug', {
        operationId,
        userType,
        LiveUserOrderExists: !!LiveUserOrder,
        DemoUserOrderExists: !!DemoUserOrder,
        SelectedModelExists: !!OrderModel,
        SelectedModelName: OrderModel?.name
      });

      // Safety check for model existence
      if (!OrderModel || typeof OrderModel.findAll !== 'function') {
        logger.error('Order model not properly loaded', {
          operationId,
          userType,
          OrderModel: OrderModel?.toString(),
          LiveUserOrder: LiveUserOrder?.toString(),
          DemoUserOrder: DemoUserOrder?.toString()
        });
        throw new Error(`${userType} order model not properly initialized`);
      }

      // Fetch only OPEN and QUEUED orders for this user (excluding PENDING orders)
      const orders = await OrderModel.findAll({
        where: {
          order_user_id: userIdInt,
          order_status: {
            [Op.in]: ['OPEN', 'QUEUED']
          }
        },
        attributes: [
          'id', 'order_id', 'symbol', 'order_type', 'order_status',
          'order_price', 'order_quantity', 'contract_value', 'margin',
          'commission', 'swap', 'stop_loss', 'take_profit', 'net_profit',
          'created_at', 'updated_at', 'close_message'
        ],
        order: [['created_at', 'DESC']]
      });

      // Calculate summary statistics (only OPEN and QUEUED orders)
      const summary = {
        total_orders: orders.length,
        open_orders: orders.filter(o => o.order_status === 'OPEN').length,
        queued_orders: orders.filter(o => o.order_status === 'QUEUED').length,
        total_margin_used: orders.reduce((sum, order) => {
          const margin = parseFloat(order.margin) || 0;
          return sum + margin;
        }, 0),
        total_contract_value: orders.reduce((sum, order) => {
          const contractValue = parseFloat(order.contract_value) || 0;
          return sum + contractValue;
        }, 0),
        symbols_traded: [...new Set(orders.map(o => o.symbol))],
        order_types: [...new Set(orders.map(o => o.order_type))]
      };

      // Log the operation for audit purposes
      logger.info('User open orders fetched by admin (OPEN and QUEUED only)', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId: userIdInt,
        userEmail: user.email,
        ordersCount: orders.length,
        filterApplied: 'OPEN and QUEUED orders only (PENDING excluded)',
        summary
      });

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          account_number: user.account_number,
          group: user.group,
          status: user.status,
          is_active: user.is_active,
          user_type: userType
        },
        orders: orders.map(order => ({
          id: order.id,
          order_id: order.order_id,
          symbol: order.symbol,
          order_type: order.order_type,
          order_status: order.order_status,
          order_price: parseFloat(order.order_price) || 0,
          order_quantity: parseFloat(order.order_quantity) || 0,
          contract_value: parseFloat(order.contract_value) || 0,
          margin: parseFloat(order.margin) || 0,
          commission: parseFloat(order.commission) || 0,
          swap: parseFloat(order.swap) || 0,
          stop_loss: order.stop_loss ? parseFloat(order.stop_loss) : null,
          take_profit: order.take_profit ? parseFloat(order.take_profit) : null,
          net_profit: parseFloat(order.net_profit) || 0,
          created_at: order.created_at,
          updated_at: order.updated_at,
          close_message: order.close_message
        })),
        summary,
        metadata: {
          operation_id: operationId,
          fetched_at: new Date().toISOString(),
          fetched_by_admin: {
            id: adminInfo.id,
            role: adminInfo.role
          }
        }
      };

    } catch (error) {
      logger.error('Failed to fetch user orders', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetches closed orders for a specific user (live or demo) with pagination
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - The ID of the user
   * @param {Model} ScopedUserModel - The scoped user model for access control
   * @param {Object} adminInfo - Information about the admin performing the request
   * @param {Object} pagination - Pagination options { page, limit }
   * @returns {Array} User closed orders array
   */
  async getUserClosedOrders(userType, userId, ScopedUserModel, adminInfo, pagination = {}) {
    const operationId = `get_user_closed_orders_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Validate userType
      if (!['live', 'demo'].includes(userType)) {
        throw new Error('Invalid user type. Must be "live" or "demo"');
      }

      // Validate userId
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        throw new Error('Invalid user ID. Must be a positive integer');
      }

      // Set default pagination
      const page = Math.max(1, parseInt(pagination.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 20));
      const offset = (page - 1) * limit;

      // First, verify the user exists and is accessible to this admin (respects country scoping)
      const user = await ScopedUserModel.findByPk(userIdInt, {
        attributes: ['id', 'name', 'email']
      });

      if (!user) {
        logger.warn('User not found or access denied for admin', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId: userIdInt,
          message: 'User not found in accessible scope'
        });
        throw new Error('User not found or access denied');
      }

      // Select the appropriate order model
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      
      // Safety check for model existence
      if (!OrderModel || typeof OrderModel.findAll !== 'function') {
        logger.error('Order model not properly loaded', {
          operationId,
          userType,
          OrderModel: OrderModel?.toString()
        });
        throw new Error(`${userType} order model not properly initialized`);
      }

      // Fetch closed orders for this user with pagination
      const orders = await OrderModel.findAll({
        where: {
          order_user_id: userIdInt,
          order_status: 'CLOSED'
        },
        attributes: [
          'id', 'order_id', 'symbol', 'order_type', 'order_status',
          'order_price', 'order_quantity', 'contract_value', 'margin',
          'commission', 'swap', 'stop_loss', 'take_profit', 'net_profit',
          'created_at', 'updated_at', 'close_message', 'close_price'
        ],
        order: [['updated_at', 'DESC']], // Most recently closed first
        limit: limit,
        offset: offset
      });

      // Log the operation for audit purposes
      logger.info('User closed orders fetched by admin', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId: userIdInt,
        userEmail: user.email,
        ordersCount: orders.length,
        page,
        limit,
        offset
      });

      // Return only the orders array with parsed numeric values
      return orders.map(order => ({
        id: order.id,
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: parseFloat(order.order_price) || 0,
        order_quantity: parseFloat(order.order_quantity) || 0,
        contract_value: parseFloat(order.contract_value) || 0,
        margin: parseFloat(order.margin) || 0,
        commission: parseFloat(order.commission) || 0,
        swap: parseFloat(order.swap) || 0,
        stop_loss: order.stop_loss ? parseFloat(order.stop_loss) : null,
        take_profit: order.take_profit ? parseFloat(order.take_profit) : null,
        net_profit: parseFloat(order.net_profit) || 0,
        close_price: order.close_price ? parseFloat(order.close_price) : null,
        created_at: order.created_at,
        updated_at: order.updated_at,
        close_message: order.close_message
      }));

    } catch (error) {
      logger.error('Failed to fetch user closed orders', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetches pending orders for a specific user (live or demo) with pagination
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - The ID of the user
   * @param {Model} ScopedUserModel - The scoped user model for access control
   * @param {Object} adminInfo - Information about the admin performing the request
   * @param {Object} pagination - Pagination options { page, limit }
   * @returns {Array} User pending orders array
   */
  async getUserPendingOrders(userType, userId, ScopedUserModel, adminInfo, pagination = {}) {
    const operationId = `get_user_pending_orders_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Validate userType
      if (!['live', 'demo'].includes(userType)) {
        throw new Error('Invalid user type. Must be "live" or "demo"');
      }

      // Validate userId
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        throw new Error('Invalid user ID. Must be a positive integer');
      }

      // Set default pagination
      const page = Math.max(1, parseInt(pagination.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 20));
      const offset = (page - 1) * limit;

      // First, verify the user exists and is accessible to this admin (respects country scoping)
      const user = await ScopedUserModel.findByPk(userIdInt, {
        attributes: ['id', 'name', 'email']
      });

      if (!user) {
        logger.warn('User not found or access denied for admin', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId: userIdInt,
          message: 'User not found in accessible scope'
        });
        throw new Error('User not found or access denied');
      }

      // Select the appropriate order model
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      
      // Safety check for model existence
      if (!OrderModel || typeof OrderModel.findAll !== 'function') {
        logger.error('Order model not properly loaded', {
          operationId,
          userType,
          OrderModel: OrderModel?.toString()
        });
        throw new Error(`${userType} order model not properly initialized`);
      }

      // Fetch pending orders for this user with pagination
      const orders = await OrderModel.findAll({
        where: {
          order_user_id: userIdInt,
          order_status: 'PENDING'
        },
        attributes: [
          'id', 'order_id', 'symbol', 'order_type', 'order_status',
          'order_price', 'order_quantity', 'contract_value', 'margin',
          'commission', 'swap', 'stop_loss', 'take_profit', 'net_profit',
          'created_at', 'updated_at', 'close_message'
        ],
        order: [['created_at', 'DESC']], // Most recently created first
        limit: limit,
        offset: offset
      });

      // Log the operation for audit purposes
      logger.info('User pending orders fetched by admin', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId: userIdInt,
        userEmail: user.email,
        ordersCount: orders.length,
        page,
        limit,
        offset
      });

      // Return only the orders array with parsed numeric values
      return orders.map(order => ({
        id: order.id,
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: parseFloat(order.order_price) || 0,
        order_quantity: parseFloat(order.order_quantity) || 0,
        contract_value: parseFloat(order.contract_value) || 0,
        margin: parseFloat(order.margin) || 0,
        commission: parseFloat(order.commission) || 0,
        swap: parseFloat(order.swap) || 0,
        stop_loss: order.stop_loss ? parseFloat(order.stop_loss) : null,
        take_profit: order.take_profit ? parseFloat(order.take_profit) : null,
        net_profit: parseFloat(order.net_profit) || 0,
        created_at: order.created_at,
        updated_at: order.updated_at,
        close_message: order.close_message
      }));

    } catch (error) {
      logger.error('Failed to fetch user pending orders', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetches rejected orders for a specific user (live or demo) with pagination
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - The ID of the user
   * @param {Model} ScopedUserModel - The scoped user model for access control
   * @param {Object} adminInfo - Information about the admin performing the request
   * @param {Object} pagination - Pagination options { page, limit }
   * @returns {Array} User rejected orders array
   */
  async getUserRejectedOrders(userType, userId, ScopedUserModel, adminInfo, pagination = {}) {
    const operationId = `get_user_rejected_orders_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Validate userType
      if (!['live', 'demo'].includes(userType)) {
        throw new Error('Invalid user type. Must be "live" or "demo"');
      }

      // Validate userId
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        throw new Error('Invalid user ID. Must be a positive integer');
      }

      // Set default pagination
      const page = Math.max(1, parseInt(pagination.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 20));
      const offset = (page - 1) * limit;

      // First, verify the user exists and is accessible to this admin (respects country scoping)
      const user = await ScopedUserModel.findByPk(userIdInt, {
        attributes: ['id', 'name', 'email']
      });

      if (!user) {
        logger.warn('User not found or access denied for admin', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId: userIdInt,
          message: 'User not found in accessible scope'
        });
        throw new Error('User not found or access denied');
      }

      // Select the appropriate order model
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      
      // Safety check for model existence
      if (!OrderModel || typeof OrderModel.findAll !== 'function') {
        logger.error('Order model not properly loaded', {
          operationId,
          userType,
          OrderModel: OrderModel?.toString()
        });
        throw new Error(`${userType} order model not properly initialized`);
      }

      // Fetch rejected orders for this user with pagination
      const orders = await OrderModel.findAll({
        where: {
          order_user_id: userIdInt,
          order_status: 'REJECTED'
        },
        attributes: [
          'id', 'order_id', 'symbol', 'order_type', 'order_status',
          'order_price', 'order_quantity', 'contract_value', 'margin',
          'commission', 'swap', 'stop_loss', 'take_profit', 'net_profit',
          'created_at', 'updated_at', 'close_message'
        ],
        order: [['updated_at', 'DESC']], // Most recently rejected first
        limit: limit,
        offset: offset
      });

      // Log the operation for audit purposes
      logger.info('User rejected orders fetched by admin', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId: userIdInt,
        userEmail: user.email,
        ordersCount: orders.length,
        page,
        limit,
        offset
      });

      // Return only the orders array with parsed numeric values
      return orders.map(order => ({
        id: order.id,
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: parseFloat(order.order_price) || 0,
        order_quantity: parseFloat(order.order_quantity) || 0,
        contract_value: parseFloat(order.contract_value) || 0,
        margin: parseFloat(order.margin) || 0,
        commission: parseFloat(order.commission) || 0,
        swap: parseFloat(order.swap) || 0,
        stop_loss: order.stop_loss ? parseFloat(order.stop_loss) : null,
        take_profit: order.take_profit ? parseFloat(order.take_profit) : null,
        net_profit: parseFloat(order.net_profit) || 0,
        created_at: order.created_at,
        updated_at: order.updated_at,
        close_message: order.close_message
      }));

    } catch (error) {
      logger.error('Failed to fetch user rejected orders', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetches all strategy provider accounts associated with a live user
   * @param {number} liveUserId - Live user identifier
   * @param {Model} ScopedLiveUser - Scoped LiveUser model honoring country restrictions
   * @param {Object} adminInfo - Authenticated admin details
   * @returns {Object} Live user summary and associated accounts
   */
  async getStrategyProviderAccountsForLiveUser(liveUserId, ScopedLiveUser, adminInfo) {
    const operationId = `get_live_user_strategy_providers_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      if (!ScopedLiveUser || typeof ScopedLiveUser.findByPk !== 'function') {
        logger.error('Scoped LiveUser model unavailable for strategy provider lookup', {
          operationId,
          liveUserId,
          adminId: adminInfo?.id
        });
        throw new Error('Scoped LiveUser model unavailable');
      }

      const user = await ScopedLiveUser.findByPk(liveUserId, {
        attributes: [
          'id',
          'name',
          'email',
          'account_number',
          'group',
          'status',
          'is_active',
          'country_id'
        ]
      });

      if (!user) {
        logger.warn('Live user not found or access denied for strategy provider lookup', {
          operationId,
          liveUserId,
          adminId: adminInfo?.id,
          adminRole: adminInfo?.role
        });
        throw new Error('Live user not found or access denied');
      }

      const accounts = await StrategyProviderAccount.findAll({
        where: { user_id: liveUserId },
        order: [['created_at', 'DESC']]
      });

      logger.info('Retrieved strategy provider accounts for live user', {
        operationId,
        liveUserId,
        adminId: adminInfo?.id,
        accountsCount: accounts.length
      });

      return {
        // user: user.toJSON(),
        accounts: accounts.map(account => account.toJSON())
      };
    } catch (error) {
      logger.error('Failed to fetch live user strategy provider accounts', {
        operationId,
        liveUserId,
        adminId: adminInfo?.id,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetches all copy follower accounts associated with a strategy provider
   * @param {number} strategyProviderId - Strategy provider identifier
   * @param {Model} ScopedLiveUser - Scoped LiveUser model for access validation
   * @param {Object} adminInfo - Authenticated admin details
   * @returns {Object} Strategy provider summary and follower accounts
   */
  async getCopyFollowersForStrategyProvider(strategyProviderId, ScopedLiveUser, adminInfo) {
    const operationId = `get_strategy_provider_copy_followers_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      if (!Number.isInteger(strategyProviderId) || strategyProviderId <= 0) {
        throw new Error('Invalid strategy provider ID');
      }

      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId, {
        attributes: [
          'id',
          'user_id',
          'strategy_name',
          'account_number',
          'status',
          'is_active',
          'group',
          'total_followers',
          'total_investment',
          'created_at',
          'updated_at'
        ]
      });

      if (!strategyProvider) {
        logger.warn('Strategy provider not found for copy follower lookup', {
          operationId,
          strategyProviderId,
          adminId: adminInfo?.id
        });
        throw new Error('Strategy provider not found or access denied');
      }

      if (ScopedLiveUser && typeof ScopedLiveUser.findByPk === 'function') {
        const accessibleOwner = await ScopedLiveUser.findByPk(strategyProvider.user_id, {
          attributes: ['id']
        });

        if (!accessibleOwner) {
          logger.warn('Strategy provider owner not accessible for admin', {
            operationId,
            strategyProviderId,
            adminId: adminInfo?.id
          });
          throw new Error('Strategy provider not found or access denied');
        }
      }

      const followers = await CopyFollowerAccount.findAll({
        where: { strategy_provider_id: strategyProviderId },
        order: [['created_at', 'DESC']]
      });

      logger.info('Retrieved copy follower accounts for strategy provider', {
        operationId,
        strategyProviderId,
        adminId: adminInfo?.id,
        followersCount: followers.length
      });

      return {
        strategy_provider: strategyProvider.toJSON(),
        copy_followers: followers.map(follower => follower.toJSON())
      };
    } catch (error) {
      if (error.message === 'Strategy provider not found or access denied' || error.message === 'Invalid strategy provider ID') {
        throw error;
      }

      logger.error('Failed to fetch copy follower accounts for strategy provider', {
        operationId,
        strategyProviderId,
        adminId: adminInfo?.id,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new AdminUserManagementService();
