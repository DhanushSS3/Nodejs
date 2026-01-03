const adminUserManagementService = require('../services/admin.user.management.service');
const adminOrderManagementService = require('../services/admin.order.management.service');
const adminOrdersListService = require('../services/admin.orders.list.service');
const { validationResult } = require('express-validator');

class AdminUserManagementController {
  /**
   * Lists open orders across user types with pagination/filter/search for admins
   */
  async getAdminOpenOrdersList(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array(),
        });
      }

      const {
        user_type: userType,
        group,
        instrument,
        search,
        sort_by: sortBy,
        sort_dir: sortDir,
      } = req.query;

      const result = await adminOrdersListService.getAdminOpenOrders({
        entityTypes: userType ? [userType] : undefined,
        group,
        instrument,
        search,
        sortBy,
        sortDir,
        admin: req.admin,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch open orders',
        error: error.message,
      });
    }
  }

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

  /**
   * Fetches open and queued orders for a specific user (live or demo)
   * Only returns orders with status 'OPEN' or 'QUEUED' (excludes 'PENDING')
   * Requires 'orders:read' permission
   * Country-level admins can only view orders for users from their country
   * Superadmins can view orders for any user
   */
  async getUserOpenOrders(req, res, next) {
    try {
      const { userType, userId } = req.params;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminUserManagementService.getUserOpenOrders(
        userType,
        userIdInt,
        ScopedUserModel,
        admin
      );

      // Return only the orders array directly
      res.status(200).json(result.orders);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message.includes('Invalid user type') || error.message.includes('Invalid user ID')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to retrieve user orders' });
    }
  }

  /**
   * Fetches closed orders for a specific user (live or demo) with pagination
   * Requires 'orders:read' permission
   * Country-level admins can only view orders for users from their country
   * Superadmins can view orders for any user
   */
  async getUserClosedOrders(req, res, next) {
    try {
      const { userType, userId } = req.params;
      const { page, limit } = req.query;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const orders = await adminUserManagementService.getUserClosedOrders(
        userType,
        userIdInt,
        ScopedUserModel,
        admin,
        { page, limit }
      );

      // Return only the orders array directly
      res.status(200).json(orders);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message.includes('Invalid user type') || error.message.includes('Invalid user ID')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to retrieve user closed orders' });
    }
  }

  /**
   * Fetches pending orders for a specific user (live or demo) with pagination
   * Requires 'orders:read' permission
   * Country-level admins can only view orders for users from their country
   * Superadmins can view orders for any user
   */
  async getUserPendingOrders(req, res, next) {
    try {
      const { userType, userId } = req.params;
      const { page, limit } = req.query;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const orders = await adminUserManagementService.getUserPendingOrders(
        userType,
        userIdInt,
        ScopedUserModel,
        admin,
        { page, limit }
      );

      // Return only the orders array directly
      res.status(200).json(orders);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message.includes('Invalid user type') || error.message.includes('Invalid user ID')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to retrieve user pending orders' });
    }
  }

  /**
   * Admin places instant order on behalf of user
   * Requires 'orders:place' permission
   */
  async adminPlaceInstantOrder(req, res, next) {
    try {
      const { userType, userId } = req.params;
      const orderData = req.body;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user type. Must be "live" or "demo"'
        });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID. Must be a positive integer.'
        });
      }

      // Basic payload validation
      if (!orderData.symbol || !orderData.order_type || !orderData.order_price || !orderData.order_quantity) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: symbol, order_type, order_price, order_quantity'
        });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.placeInstantOrder(
        admin,
        userType,
        userIdInt,
        orderData,
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({
          success: false,
          message: `${req.params.userType} user not found or access denied`
        });
      }

      if (error.message.includes('Invalid payload fields')) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }

      if (error.message.includes('DB error')) {
        return res.status(500).json({
          success: false,
          message: 'Database error occurred'
        });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      if (error.message.includes('Python service error')) {
        return res.status(500).json({
          success: false,
          message: error.message
        });
      }

      if (error.message.includes('Order conflict')) {
        return res.status(409).json({
          success: false,
          message: error.message
        });
      }

      res.status(500).json({
        success: false,
        message: error.message || 'Failed to place instant order'
      });
    }
  }

  /**
   * Admin closes order on behalf of user
   * Requires 'orders:close' permission
   */
  async adminCloseOrder(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.closeOrder(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        req.body || {}, // closeData parameter
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('Cannot close order')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to close order' });
    }
  }

  /**
   * Admin places pending order on behalf of user
   * Requires 'orders:place' permission
   */
  async adminPlacePendingOrder(req, res, next) {
    try {
      const { userType, userId } = req.params;
      const orderData = req.body;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.placePendingOrder(
        admin,
        userType,
        userIdInt,
        orderData,
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message.includes('Invalid user type') || error.message.includes('Invalid user ID')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to place pending order' });
    }
  }

  /**
   * Admin modifies pending order on behalf of user
   * Requires 'orders:modify' permission
   */
  async adminModifyPendingOrder(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const updateData = req.body;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.modifyPendingOrder(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        updateData,
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('Cannot modify order')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: error.message || 'Failed to modify pending order' });
    }
  }

  /**
   * Admin cancels pending order on behalf of user
   * Requires 'orders:modify' permission
   */
  async adminCancelPendingOrder(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      // For DELETE requests, cancelData can be empty or from query params
      const cancelData = req.body || {};

      const result = await adminOrderManagementService.cancelPendingOrder(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        cancelData,
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('Cannot cancel order')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to cancel pending order' });
    }
  }

  /**
   * Admin sets stop loss for an existing order
   * Requires 'orders:stoploss' permission
   */
  async adminSetStopLoss(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const slData = req.body;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Validate stop loss price
      if (!slData.stop_loss_price || isNaN(parseFloat(slData.stop_loss_price))) {
        return res.status(400).json({ error: 'Valid stop loss price is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.setStopLoss(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        slData,
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('Cannot set stop loss')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to set stop loss' });
    }
  }

  /**
   * Admin removes stop loss from an existing order
   * Requires 'orders:stoploss' permission
   */
  async adminRemoveStopLoss(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.removeStopLoss(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        req.body || {}, // cancelData parameter
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('does not have an active stop loss')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to remove stop loss' });
    }
  }

  /**
   * Admin sets take profit for an existing order
   * Requires 'orders:takeprofit' permission
   */
  async adminSetTakeProfit(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const tpData = req.body;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Validate take profit price
      if (!tpData.take_profit_price || isNaN(parseFloat(tpData.take_profit_price))) {
        return res.status(400).json({ error: 'Valid take profit price is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.setTakeProfit(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        tpData,
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('Cannot set take profit')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to set take profit' });
    }
  }

  /**
   * Admin removes take profit from an existing order
   * Requires 'orders:takeprofit' permission
   */
  async adminRemoveTakeProfit(req, res, next) {
    try {
      const { userType, userId, orderId } = req.params;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Validate orderId parameter
      if (!orderId || orderId.trim() === '') {
        return res.status(400).json({ error: 'Order ID is required' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const result = await adminOrderManagementService.removeTakeProfit(
        admin,
        userType,
        userIdInt,
        orderId.trim(),
        req.body || {}, // cancelData parameter
        ScopedUserModel
      );

      res.status(200).json(result);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message === 'Order not found or access denied') {
        return res.status(404).json({ error: 'Order not found or access denied' });
      }

      if (error.message.includes('does not have an active take profit')) {
        return res.status(400).json({ error: error.message });
      }

      // Handle AdminOrderError with preserved status codes
      if (error.name === 'AdminOrderError') {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
          reason: error.reason,
          error: error.detail
        });
      }

      res.status(500).json({ error: error.message || 'Failed to remove take profit' });
    }
  }

  /**
   * Fetches rejected orders for a specific user (live or demo) with pagination
   * Requires 'orders:read' permission
   * Country-level admins can only view orders for users from their country
   * Superadmins can view orders for any user
   */
  async getUserRejectedOrders(req, res, next) {
    try {
      const { userType, userId } = req.params;
      const { page, limit } = req.query;
      const admin = req.admin;

      // Validate userType parameter
      if (!['live', 'demo'].includes(userType)) {
        return res.status(400).json({ error: 'Invalid user type. Must be "live" or "demo"' });
      }

      // Validate userId parameter
      const userIdInt = parseInt(userId, 10);
      if (isNaN(userIdInt) || userIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid user ID. Must be a positive integer.' });
      }

      // Use scoped model to ensure country-level access control
      const ScopedUserModel = userType === 'live'
        ? req.scopedModels.LiveUser
        : req.scopedModels.DemoUser;

      const orders = await adminUserManagementService.getUserRejectedOrders(
        userType,
        userIdInt,
        ScopedUserModel,
        admin,
        { page, limit }
      );

      // Return only the orders array directly
      res.status(200).json(orders);

    } catch (error) {
      if (error.message === 'User not found or access denied') {
        return res.status(404).json({ error: `${req.params.userType} user not found or access denied` });
      }

      if (error.message.includes('Invalid user type') || error.message.includes('Invalid user ID')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to retrieve user rejected orders' });
    }
  }

  /**
   * Fetch strategy provider accounts for a live user
   * Requires 'strategy_provider:read' permission
   */
  async getLiveUserStrategyProviders(req, res, next) {
    try {
      const { live_user_id: liveUserIdRaw } = req.query;
      const admin = req.admin;

      if (!liveUserIdRaw) {
        return res.status(400).json({
          success: false,
          message: 'live_user_id query parameter is required'
        });
      }

      const liveUserId = parseInt(liveUserIdRaw, 10);
      if (!Number.isInteger(liveUserId) || liveUserId <= 0) {
        return res.status(400).json({
          success: false,
          message: 'live_user_id must be a positive integer'
        });
      }

      const ScopedLiveUser = req.scopedModels?.LiveUser;

      const result = await adminUserManagementService.getStrategyProviderAccountsForLiveUser(
        liveUserId,
        ScopedLiveUser,
        admin
      );

      return res.status(200).json({
        data: result
      });
    } catch (error) {
      if (error.message === 'Live user not found or access denied') {
        return res.status(404).json({
          success: false,
          message: 'Live user not found or access denied'
        });
      }

      if (error.message === 'Scoped LiveUser model unavailable') {
        return res.status(500).json({
          success: false,
          message: 'Scoped LiveUser model unavailable for this request'
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve strategy provider accounts',
        error: error.message
      });
    }
  }

  /**
   * Fetch copy follower accounts for a strategy provider
   * Requires 'copy_follower:read' permission
   */
  async getCopyFollowersForStrategyProvider(req, res, next) {
    try {
      const { strategy_provider_id: strategyProviderIdRaw } = req.query;
      const admin = req.admin;

      if (!strategyProviderIdRaw) {
        return res.status(400).json({
          success: false,
          message: 'strategy_provider_id query parameter is required'
        });
      }

      const strategyProviderId = parseInt(strategyProviderIdRaw, 10);
      if (!Number.isInteger(strategyProviderId) || strategyProviderId <= 0) {
        return res.status(400).json({
          success: false,
          message: 'strategy_provider_id must be a positive integer'
        });
      }

      const ScopedLiveUser = req.scopedModels?.LiveUser;

      const result = await adminUserManagementService.getCopyFollowersForStrategyProvider(
        strategyProviderId,
        ScopedLiveUser,
        admin
      );

      return res.status(200).json({
        data: result
      });
    } catch (error) {
      if (error.message === 'Strategy provider not found or access denied') {
        return res.status(404).json({
          success: false,
          message: 'Strategy provider not found or access denied'
        });
      }

      if (error.message === 'Invalid strategy provider ID') {
        return res.status(400).json({
          success: false,
          message: 'strategy_provider_id must be a positive integer'
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve copy follower accounts',
        error: error.message
      });
    }
  }

  /**
   * Fetches closed orders for a specific strategy provider with pagination
   * Requires 'copytrading:orders:read' permission
   */
  async getStrategyProviderClosedOrders(req, res, next) {
    try {
      const { strategyProviderId } = req.params;
      const { page, limit } = req.query;
      const admin = req.admin;

      // Validate strategyProviderId parameter
      const providerIdInt = parseInt(strategyProviderId, 10);
      if (isNaN(providerIdInt) || providerIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid strategy provider ID. Must be a positive integer.' });
      }

      const orders = await adminOrderManagementService.getStrategyProviderClosedOrders(
        providerIdInt,
        admin,
        { page, limit }
      );

      // Return only the orders array directly
      res.status(200).json(orders);

    } catch (error) {
      if (error.message === 'Strategy provider account not found') {
        return res.status(404).json({ error: 'Strategy provider account not found' });
      }

      if (error.message.includes('Invalid strategy provider ID')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to retrieve strategy provider closed orders' });
    }
  }

  /**
   * Fetches closed orders for a specific copy follower with pagination
   * Requires 'copytrading:orders:read' permission
   */
  async getCopyFollowerClosedOrders(req, res, next) {
    try {
      const { copyFollowerId } = req.params;
      const { page, limit } = req.query;
      const admin = req.admin;

      // Validate copyFollowerId parameter
      const followerIdInt = parseInt(copyFollowerId, 10);
      if (isNaN(followerIdInt) || followerIdInt <= 0) {
        return res.status(400).json({ error: 'Invalid copy follower ID. Must be a positive integer.' });
      }

      const orders = await adminOrderManagementService.getCopyFollowerClosedOrders(
        followerIdInt,
        admin,
        { page, limit }
      );

      // Return only the orders array directly
      res.status(200).json(orders);

    } catch (error) {
      if (error.message === 'Copy follower account not found') {
        return res.status(404).json({ error: 'Copy follower account not found' });
      }

      if (error.message.includes('Invalid copy follower ID')) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to retrieve copy follower closed orders' });
    }
  }
}

module.exports = new AdminUserManagementController();
