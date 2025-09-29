const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('./logger.service');
const { redisCluster } = require('../../config/redis');
const { LiveUserOrder, DemoUserOrder } = require('../models');
const idGenerator = require('./idGenerator.service');
const orderLifecycleService = require('./orderLifecycle.service');

// Create reusable axios instance for Python service calls
const pythonServiceAxios = axios.create({
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Auth': process.env.INTERNAL_PROVIDER_SECRET || process.env.INTERNAL_API_SECRET || 'livefxhub'
  },
  httpAgent: new http.Agent({ 
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10
  }),
  httpsAgent: new https.Agent({ 
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10
  })
});

// Validation functions (same as orders.controller.js)
function normalizeStr(v) {
  return (v ?? '').toString();
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validateInstantOrderPayload(body) {
  const errors = [];
  const symbol = normalizeStr(body.symbol).toUpperCase();
  const order_type = normalizeStr(body.order_type).toUpperCase();
  const order_price = toNumber(body.order_price);
  const order_quantity = toNumber(body.order_quantity);

  if (!symbol) errors.push('symbol');
  if (!['BUY', 'SELL'].includes(order_type)) errors.push('order_type');
  if (!(order_price > 0)) errors.push('order_price');
  if (!(order_quantity > 0)) errors.push('order_quantity');

  return { errors, parsed: { symbol, order_type, order_price, order_quantity } };
}

function validatePendingOrderPayload(body) {
  const errors = [];
  const symbol = normalizeStr(body.symbol).toUpperCase();
  const order_type = normalizeStr(body.order_type).toUpperCase();
  const order_price = toNumber(body.price || body.order_price);
  const order_quantity = toNumber(body.quantity || body.order_quantity);

  if (!symbol) errors.push('symbol');
  if (!['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'].includes(order_type)) errors.push('order_type');
  if (!(order_price > 0)) errors.push('order_price');
  if (!(order_quantity > 0)) errors.push('order_quantity');

  return { errors, parsed: { symbol, order_type, order_price, order_quantity } };
}

class AdminOrderManagementService {
  /**
   * Determines user's execution flow (provider vs local)
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @returns {Object} Flow information
   */
  async getUserExecutionFlow(userType, userId) {
    const operationId = `get_user_flow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      const userCfgKey = `user:{${userType}:${userId}}:config`;
      const ucfg = await redisCluster.hgetall(userCfgKey);
      const sendingOrders = (ucfg?.sending_orders || 'rock').toLowerCase().trim();
      
      const flowInfo = {
        isProviderFlow: sendingOrders === 'barclays',
        sendingOrders,
        userConfig: ucfg,
        operationId
      };

      logger.info('User execution flow determined', {
        operationId,
        userType,
        userId,
        sendingOrders,
        isProviderFlow: flowInfo.isProviderFlow
      });

      return flowInfo;
    } catch (error) {
      logger.error('Failed to determine user execution flow', {
        operationId,
        userType,
        userId,
        error: error.message
      });
      // Default to local flow on error
      return {
        isProviderFlow: false,
        sendingOrders: 'rock',
        userConfig: {},
        operationId
      };
    }
  }

  /**
   * Validates admin access to manage user's orders
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {Model} ScopedUserModel - Scoped user model for access control (ignored for superadmins)
   * @returns {Object} User information
   */
  async validateAdminAccess(adminInfo, userType, userId, ScopedUserModel) {
    const operationId = `validate_admin_access_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      let user;
      
      // Superadmins can access any user regardless of country scoping
      if (adminInfo.role === 'superadmin') {
        const { LiveUser, DemoUser } = require('../models');
        const UserModel = userType === 'live' ? LiveUser : DemoUser;
        
        user = await UserModel.findByPk(userId, {
          attributes: ['id', 'name', 'email', 'account_number', 'group', 'status', 'is_active', 'sending_orders']
        });
        
        logger.info('Superadmin access - bypassing country scoping', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId
        });
      } else {
        // Regular admins use scoped model (country restrictions apply)
        user = await ScopedUserModel.findByPk(userId, {
          attributes: ['id', 'name', 'email', 'account_number', 'group', 'status', 'is_active', 'sending_orders']
        });
      }

      if (!user) {
        logger.warn('Admin access denied - user not found', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId,
          isSuperadmin: adminInfo.role === 'superadmin'
        });
        throw new Error('User not found or access denied');
      }

      logger.info('Admin access validated', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        accessType: adminInfo.role === 'superadmin' ? 'global' : 'scoped'
      });

      return { user, operationId };
    } catch (error) {
      logger.error('Admin access validation failed', {
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
   * Validates order exists and belongs to user
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID
   * @returns {Object} Order information
   */
  async validateOrderAccess(userType, userId, orderId) {
    const operationId = `validate_order_access_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      
      const order = await OrderModel.findOne({
        where: {
          order_id: orderId,
          order_user_id: userId
        }
      });

      if (!order) {
        logger.warn('Order not found or access denied', {
          operationId,
          userType,
          userId,
          orderId
        });
        throw new Error('Order not found or access denied');
      }

      logger.info('Order access validated', {
        operationId,
        userType,
        userId,
        orderId,
        orderStatus: order.order_status
      });

      return { order, operationId };
    } catch (error) {
      logger.error('Order access validation failed', {
        operationId,
        userType,
        userId,
        orderId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Admin places instant order on behalf of user (follows exact same flow as user orders)
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {Object} orderData - Order data
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Order result
   */
  async placeInstantOrder(adminInfo, userType, userId, orderData, ScopedUserModel) {
    const operationId = `admin_place_instant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order payload (same validation as user orders)
      const { errors, parsed } = validateInstantOrderPayload(orderData);
      if (errors.length) {
        throw new Error(`Invalid payload fields: ${errors.join(', ')}`);
      }

      // 3. Generate order_id in ord_YYYYMMDD_seq format (same as user orders)
      const order_id = await idGenerator.generateOrderId();
      
      // 4. Store main order_id in lifecycle service (same as user orders)
      try {
        await orderLifecycleService.addLifecycleId(
          order_id, 
          'order_id', 
          order_id, 
          `Admin Order placed - ${parsed.order_type} ${parsed.symbol} @ ${parsed.order_price}`
        );
      } catch (lifecycleErr) {
        logger.warn('Failed to store order_id in lifecycle service', { 
          order_id, error: lifecycleErr.message 
        });
      }

      // 5. Persist initial order (QUEUED) - same as user orders
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      let initialOrder;
      try {
        initialOrder = await OrderModel.create({
          order_id,
          order_user_id: parseInt(userId),
          symbol: parsed.symbol,
          order_type: parsed.order_type,
          order_status: 'QUEUED',
          order_price: parsed.order_price,
          order_quantity: parsed.order_quantity,
          margin: 0,
          status: normalizeStr(orderData.status || 'OPEN'),
          placed_by: 'admin'  // Mark as admin-placed
        });
      } catch (dbErr) {
        logger.error('Admin order DB create failed', { 
          error: dbErr.message, 
          order_id,
          adminId: adminInfo.id,
          userId
        });
        throw new Error(`DB error: ${dbErr.message}`);
      }

      // 6. Build payload to Python (exact same structure as user orders)
      const pyPayload = {
        symbol: parsed.symbol,
        order_type: parsed.order_type,
        order_price: parsed.order_price,
        order_quantity: parsed.order_quantity,
        user_id: userId.toString(),
        user_type: userType,
        order_id,
        status: normalizeStr(orderData.status || 'OPEN'),
        order_status: normalizeStr(orderData.order_status || 'OPEN'),
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role
      };

      // 7. Call Python service (same URL and endpoint as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      
      logger.info('Admin placing instant order', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        order_id,
        symbol: parsed.symbol,
        order_type: parsed.order_type,
        order_price: parsed.order_price,
        order_quantity: parsed.order_quantity
      });

      let pyResp;
      try {
        pyResp = await pythonServiceAxios.post(
          `${baseUrl}/api/orders/instant/execute`,
          pyPayload
        );
      } catch (err) {
        // Handle Python service error (same as user orders)
        const statusCode = err?.response?.status || 500;
        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };

        // Update DB as REJECTED with reason
        try {
          const reasonStr = normalizeStr(detail?.detail?.reason || detail?.reason || 'execution_failed');
          await initialOrder.update({
            order_status: 'REJECTED',
            close_message: reasonStr,
          });
        } catch (uErr) {
          logger.error('Failed to update admin order after Python error', { 
            error: uErr.message, 
            order_id,
            adminId: adminInfo.id
          });
        }

        logger.error('Python service error for admin order', {
          operationId,
          adminId: adminInfo.id,
          order_id,
          statusCode,
          detail,
          error: err.message
        });

        if (statusCode === 409) {
          throw new Error(`Order conflict: ${detail?.detail?.reason || detail?.reason || 'conflict'}`);
        }
        
        throw new Error(`Python service error: ${detail?.detail?.reason || detail?.reason || err.message}`);
      }

      // 8. Post-success DB update (same logic as user orders)
      const result = pyResp.data?.data || pyResp.data || {};
      const flow = result.flow; // 'local' or 'provider'
      const exec_price = result.exec_price;
      const margin_usd = result.margin_usd;
      const contract_value = result.contract_value;
      const commission_entry = result.commission_entry;
      const used_margin_executed = (result.used_margin_executed !== undefined) ? result.used_margin_executed : result.used_margin_usd;

      // Build update fields based on flow (same as user orders)
      const updateFields = {};
      if (typeof exec_price === 'number') {
        updateFields.order_price = exec_price;
      }
      // Persist margin only for local (immediate) execution
      if (flow === 'local' && typeof margin_usd === 'number') {
        updateFields.margin = margin_usd;
      }
      if (typeof contract_value === 'number') {
        updateFields.contract_value = contract_value;
      }
      if (flow === 'local' && typeof commission_entry === 'number') {
        updateFields.commission = commission_entry;
      }
      
      // Map to requested statuses (CRITICAL: This is what was missing!)
      if (flow === 'local') {
        // Executed instantly -> OPEN
        updateFields.order_status = 'OPEN';
      } else if (flow === 'provider') {
        // Waiting for provider confirmation -> QUEUED
        updateFields.order_status = 'QUEUED';
      } else {
        updateFields.order_status = 'OPEN'; // sane default
      }

      // Update the order with execution results
      const finalOrderId = normalizeStr(result.order_id || order_id);
      try {
        if (normalizeStr(initialOrder.order_id) !== finalOrderId) {
          // Handle ID mismatch (shouldn't happen for admin orders but keeping consistency)
          const [row, created] = await OrderModel.findOrCreate({
            where: { order_id: finalOrderId },
            defaults: {
              order_id: finalOrderId,
              order_user_id: parseInt(userId),
              symbol: parsed.symbol,
              order_type: parsed.order_type,
              order_status: 'QUEUED',
              order_price: parsed.order_price,
              order_quantity: parsed.order_quantity,
              margin: 0,
              status: normalizeStr(orderData.status || 'OPEN'),
              placed_by: 'admin'
            }
          });
          await row.update(updateFields);
        } else {
          await initialOrder.update(updateFields);
        }
      } catch (uErr) {
        logger.error('Failed to update admin order after success', { 
          error: uErr.message, 
          order_id: finalOrderId,
          adminId: adminInfo.id
        });
      }

      // 9. Emit WS event for local execution order update (same as user orders)
      if (flow === 'local') {
        try {
          const portfolioEvents = require('./events/portfolio.events');
          portfolioEvents.emitUserUpdate(userType, userId.toString(), {
            type: 'order_update',
            order_id: finalOrderId,
            update: updateFields,
          });
        } catch (e) {
          logger.warn('Failed to emit portfolio event for admin local order update', { 
            error: e.message, 
            order_id: finalOrderId,
            adminId: adminInfo.id
          });
        }
      }

      // 10. Update user margin for local execution (same as user orders)
      if (flow === 'local' && typeof used_margin_executed === 'number') {
        try {
          const { updateUserUsedMargin } = require('./user.margin.service');
          await updateUserUsedMargin({
            userType: userType,
            userId: parseInt(userId),
            usedMargin: used_margin_executed,
          });
          
          // Emit WS event for margin change
          try {
            const portfolioEvents = require('./events/portfolio.events');
            portfolioEvents.emitUserUpdate(userType, userId.toString(), {
              type: 'user_margin_update',
              used_margin_usd: used_margin_executed,
            });
          } catch (e) {
            logger.warn('Failed to emit portfolio event after admin margin update', { 
              error: e.message, 
              userId: userId,
              adminId: adminInfo.id
            });
          }
        } catch (mErr) {
          logger.error('Failed to update user used margin for admin order', {
            error: mErr.message,
            userId: userId,
            userType: userType,
            adminId: adminInfo.id
          });
        }
      }

      // 11. Log successful admin action
      logger.info('Admin instant order placed successfully', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        order_id: finalOrderId,
        flow: flow,
        exec_price: exec_price,
        order_status: updateFields.order_status,
        result: result
      });

      return pyResp.data;

    } catch (error) {
      logger.error('Failed to place admin instant order', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }

  /**
   * Admin closes order on behalf of user
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID to close
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Close result
   */
  async closeOrder(adminInfo, userType, userId, orderId, ScopedUserModel) {
    const operationId = `admin_close_order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      // 3. Check if order can be closed
      if (!['OPEN', 'PENDING'].includes(order.order_status)) {
        throw new Error(`Cannot close order with status: ${order.order_status}`);
      }

      // 4. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 5. Prepare payload for Python service (must match CloseOrderRequest schema)
      const payload = {
        symbol: order.symbol,
        order_type: order.order_type,
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        status: "CLOSED",
        order_status: "CLOSED",
        // Admin context (additional fields)
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 6. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/close`,
        payload
      );

      // 7. Log admin action
      logger.info('Admin order closed', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        orderSymbol: order.symbol,
        orderType: order.order_type,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to close admin order', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Order close failed');
      }
      throw error;
    }
  }

  /**
   * Admin places pending order on behalf of user
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {Object} orderData - Pending order data
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Order result
   */
  async placePendingOrder(adminInfo, userType, userId, orderData, ScopedUserModel) {
    const operationId = `admin_place_pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 3. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        symbol: orderData.symbol,
        order_type: orderData.order_type, // BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP
        quantity: orderData.quantity,
        price: orderData.price,
        leverage: orderData.leverage || user.leverage || 100,
        stop_loss: orderData.stop_loss || null,
        take_profit: orderData.take_profit || null,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 4. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/pending/place`,
        payload
      );

      // 5. Log admin action
      logger.info('Admin pending order placed', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderData: {
          symbol: payload.symbol,
          order_type: payload.order_type,
          quantity: payload.quantity,
          price: payload.price,
          leverage: payload.leverage
        },
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to place admin pending order', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Pending order placement failed');
      }
      throw error;
    }
  }

  /**
   * Admin modifies pending order on behalf of user
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID to modify
   * @param {Object} updateData - Update data
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Modify result
   */
  async modifyPendingOrder(adminInfo, userType, userId, orderId, updateData, ScopedUserModel) {
    const operationId = `admin_modify_pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access and status
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      if (order.order_status !== 'PENDING') {
        throw new Error(`Cannot modify order with status: ${order.order_status}`);
      }

      // 3. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 4. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        new_price: updateData.price,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 5. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/pending/modify`,
        payload
      );

      // 6. Log admin action
      logger.info('Admin pending order modified', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        oldPrice: order.order_price,
        newPrice: updateData.price,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to modify admin pending order', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Pending order modification failed');
      }
      throw error;
    }
  }

  /**
   * Admin cancels pending order on behalf of user
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID to cancel
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Cancel result
   */
  async cancelPendingOrder(adminInfo, userType, userId, orderId, ScopedUserModel) {
    const operationId = `admin_cancel_pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access and status
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      if (order.order_status !== 'PENDING') {
        throw new Error(`Cannot cancel order with status: ${order.order_status}`);
      }

      // 3. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 4. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 5. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/pending/cancel`,
        payload
      );

      // 6. Log admin action
      logger.info('Admin pending order cancelled', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        orderSymbol: order.symbol,
        orderType: order.order_type,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to cancel admin pending order', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Pending order cancellation failed');
      }
      throw error;
    }
  }

  /**
   * Admin sets stop loss for an existing order
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID
   * @param {Object} slData - Stop loss data
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Stop loss result
   */
  async setStopLoss(adminInfo, userType, userId, orderId, slData, ScopedUserModel) {
    const operationId = `admin_set_stoploss_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      // 3. Check if order can have stop loss
      if (!['OPEN'].includes(order.order_status)) {
        throw new Error(`Cannot set stop loss for order with status: ${order.order_status}`);
      }

      // 4. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 5. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        stop_loss_price: slData.stop_loss_price,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 6. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/stoploss/add`,
        payload
      );

      // 7. Log admin action
      logger.info('Admin stop loss set', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        stopLossPrice: slData.stop_loss_price,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to set admin stop loss', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Stop loss setting failed');
      }
      throw error;
    }
  }

  /**
   * Admin removes stop loss from an existing order
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Stop loss removal result
   */
  async removeStopLoss(adminInfo, userType, userId, orderId, ScopedUserModel) {
    const operationId = `admin_remove_stoploss_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      // 3. Check if order has stop loss
      if (!order.stop_loss || parseFloat(order.stop_loss) === 0) {
        throw new Error('Order does not have an active stop loss');
      }

      // 4. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 5. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 6. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/stoploss/cancel`,
        payload
      );

      // 7. Log admin action
      logger.info('Admin stop loss removed', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        previousStopLoss: order.stop_loss,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to remove admin stop loss', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Stop loss removal failed');
      }
      throw error;
    }
  }

  /**
   * Admin sets take profit for an existing order
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID
   * @param {Object} tpData - Take profit data
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Take profit result
   */
  async setTakeProfit(adminInfo, userType, userId, orderId, tpData, ScopedUserModel) {
    const operationId = `admin_set_takeprofit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      // 3. Check if order can have take profit
      if (!['OPEN'].includes(order.order_status)) {
        throw new Error(`Cannot set take profit for order with status: ${order.order_status}`);
      }

      // 4. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 5. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        take_profit_price: tpData.take_profit_price,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 6. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/takeprofit/add`,
        payload
      );

      // 7. Log admin action
      logger.info('Admin take profit set', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        takeProfitPrice: tpData.take_profit_price,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to set admin take profit', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Take profit setting failed');
      }
      throw error;
    }
  }

  /**
   * Admin removes take profit from an existing order
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Take profit removal result
   */
  async removeTakeProfit(adminInfo, userType, userId, orderId, ScopedUserModel) {
    const operationId = `admin_remove_takeprofit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Validate order access
      const { order } = await this.validateOrderAccess(userType, userId, orderId);
      
      // 3. Check if order has take profit
      if (!order.take_profit || parseFloat(order.take_profit) === 0) {
        throw new Error('Order does not have an active take profit');
      }

      // 4. Get user execution flow
      const flowInfo = await this.getUserExecutionFlow(userType, userId);
      
      // 5. Prepare payload for Python service
      const payload = {
        user_id: userId.toString(),
        user_type: userType,
        order_id: orderId,
        // Admin context
        admin_initiated: true,
        admin_id: adminInfo.id,
        admin_role: adminInfo.role,
        operation_id: operationId
      };

      // 6. Call Python service (same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const response = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/takeprofit/cancel`,
        payload
      );

      // 7. Log admin action
      logger.info('Admin take profit removed', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        previousTakeProfit: order.take_profit,
        executionFlow: flowInfo.isProviderFlow ? 'provider' : 'local',
        result: response.data
      });

      return response.data;

    } catch (error) {
      logger.error('Failed to remove admin take profit', {
        operationId,
        adminId: adminInfo.id,
        userType,
        userId,
        orderId,
        error: error.message,
        stack: error.stack
      });
      
      if (error.response?.data) {
        throw new Error(error.response.data.message || 'Take profit removal failed');
      }
      throw error;
    }
  }
}

module.exports = new AdminOrderManagementService();
