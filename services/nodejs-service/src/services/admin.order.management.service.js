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
  const user_type = normalizeStr(body.user_type).toLowerCase();
  const order_price = toNumber(body.order_price);
  const order_quantity = toNumber(body.order_quantity);
  const user_id = normalizeStr(body.user_id);

  if (!symbol) errors.push('symbol');
  if (!['BUY', 'SELL'].includes(order_type)) errors.push('order_type');
  if (!(order_price > 0)) errors.push('order_price');
  if (!(order_quantity > 0)) errors.push('order_quantity');
  if (!user_id) errors.push('user_id');
  if (!['live', 'demo'].includes(user_type)) errors.push('user_type');

  return { errors, parsed: { symbol, order_type, user_type, order_price, order_quantity, user_id } };
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
   * Admin places instant order on behalf of user (EXACT SAME FLOW as user orders)
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {Object} orderData - Order data (EXACT same structure as user payload)
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Order result
   */
  async placeInstantOrder(adminInfo, userType, userId, orderData, ScopedUserModel) {
    const operationId = `admin_place_instant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Build EXACT same payload structure as user orders
      const userPayload = {
        symbol: orderData.symbol,
        order_type: orderData.order_type,
        order_price: orderData.order_price || orderData.price,
        order_quantity: orderData.order_quantity || orderData.quantity,
        user_id: userId.toString(),
        user_type: userType,
        status: orderData.status || 'OPEN',
        order_status: orderData.order_status || 'OPEN'
      };
      
      // Add optional fields if provided
      if (orderData.idempotency_key) {
        userPayload.idempotency_key = orderData.idempotency_key;
      }

      // 3. Validate payload (same validation as user orders)
      const { errors, parsed } = validateInstantOrderPayload(userPayload);
      if (errors.length) {
        throw new Error(`Invalid payload fields: ${errors.join(', ')}`);
      }

      // 4. Generate order_id in ord_YYYYMMDD_seq format (same as user orders)
      const order_id = await idGenerator.generateOrderId();
      
      // 5. Store main order_id in lifecycle service (same as user orders)
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

      // 6. Persist initial order (QUEUED) - same as user orders
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      let initialOrder;
      const hasIdempotency = !!userPayload.idempotency_key;
      
      if (!hasIdempotency) {
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
            status: normalizeStr(userPayload.status || 'OPEN'),
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
      }

      // 7. Build payload to Python (EXACT same structure as user orders)
      const pyPayload = {
        symbol: parsed.symbol,
        order_type: parsed.order_type,
        order_price: parsed.order_price,
        order_quantity: parsed.order_quantity,
        user_id: parsed.user_id,
        user_type: parsed.user_type,
        order_id,
        status: normalizeStr(userPayload.status || 'OPEN'),
        order_status: normalizeStr(userPayload.order_status || 'OPEN')
      };
      
      if (userPayload.idempotency_key) {
        pyPayload.idempotency_key = normalizeStr(userPayload.idempotency_key);
      }

      // 8. Call Python service (EXACT same URL and endpoint as user orders)
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
        // Handle Python service error (EXACT same logic as user orders)
        const statusCode = err?.response?.status || 500;
        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };

        // Update DB as REJECTED with reason
        try {
          const reasonStr = normalizeStr(detail?.detail?.reason || detail?.reason || 'execution_failed');
          const rejectStatus = {
            order_status: 'REJECTED',
            close_message: reasonStr,
          };
          if (initialOrder) {
            await initialOrder.update(rejectStatus);
          } else {
            // Upsert a row for idempotent path where we skipped pre-insert
            const [row, created] = await OrderModel.findOrCreate({
              where: { order_id },
              defaults: {
                order_id,
                order_user_id: parseInt(userId),
                symbol: parsed.symbol,
                order_type: parsed.order_type,
                order_status: 'QUEUED',
                order_price: parsed.order_price,
                order_quantity: parsed.order_quantity,
                margin: 0,
                status: normalizeStr(userPayload.status || 'OPEN'),
                placed_by: 'admin'
              }
            });
            await row.update(rejectStatus);
          }
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

      // 9. Post-success DB update (EXACT same logic as user orders)
      const result = pyResp.data?.data || pyResp.data || {};
      const flow = result.flow; // 'local' or 'provider'
      const exec_price = result.exec_price;
      const margin_usd = result.margin_usd;
      const contract_value = result.contract_value;
      const commission_entry = result.commission_entry;
      const used_margin_executed = (result.used_margin_executed !== undefined) ? result.used_margin_executed : result.used_margin_usd;

      // Build update fields based on flow (EXACT same as user orders)
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
      
      // Map to requested statuses (EXACT same as user orders)
      if (flow === 'local') {
        // Executed instantly -> OPEN
        updateFields.order_status = 'OPEN';
      } else if (flow === 'provider') {
        // Waiting for provider confirmation -> QUEUED
        updateFields.order_status = 'QUEUED';
      } else {
        updateFields.order_status = 'OPEN'; // sane default
      }

      // Upsert by final order_id to avoid duplicate rows on idempotent replays (EXACT same as user orders)
      const finalOrderId = normalizeStr(result.order_id || order_id);
      if (initialOrder) {
        try {
          // If IDs diverge (shouldn't for non-idempotent), fall back to updating by final ID
          if (normalizeStr(initialOrder.order_id) !== finalOrderId) {
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
                status: normalizeStr(userPayload.status || 'OPEN'),
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
      } else {
        try {
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
              status: normalizeStr(userPayload.status || 'OPEN'),
              placed_by: 'admin'
            }
          });
          await row.update(updateFields);
        } catch (uErr) {
          logger.error('Failed to upsert admin order after success', { 
            error: uErr.message, 
            order_id: finalOrderId,
            adminId: adminInfo.id
          });
        }
      }

      // 10. Emit WS event for local execution order update (EXACT same as user orders)
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

      // 11. Update user margin for local execution (EXACT same as user orders)
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

      // 12. Log successful admin action
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

      // 13. Return EXACT same response structure as user orders
      return {
        success: true,
        order_id: finalOrderId,
        order_status: updateFields.order_status,
        execution_mode: flow,
        margin: margin_usd,
        exec_price: exec_price,
        contract_value: typeof contract_value === 'number' ? contract_value : undefined,
        commission: typeof commission_entry === 'number' ? commission_entry : undefined,
      };

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
   * Admin closes order on behalf of user (EXACT SAME FLOW as user orders)
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID to close
   * @param {Object} closeData - Close data (EXACT same structure as user payload)
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Close result
   */
  async closeOrder(adminInfo, userType, userId, orderId, closeData, ScopedUserModel) {
    const operationId = `admin_close_order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Build EXACT same payload structure as user orders
      const userPayload = {
        order_id: orderId,
        user_id: userId.toString(),
        user_type: userType,
        status: closeData.status || 'CLOSED',
        order_status: closeData.order_status || 'CLOSED'
      };
      
      // Add optional fields if provided
      if (closeData.close_price && closeData.close_price > 0) {
        userPayload.close_price = closeData.close_price;
      }
      if (closeData.idempotency_key) {
        userPayload.idempotency_key = closeData.idempotency_key;
      }
      if (closeData.symbol) {
        userPayload.symbol = closeData.symbol;
      }
      if (closeData.order_type) {
        userPayload.order_type = closeData.order_type;
      }

      // 3. Validate required fields (EXACT same validation as user orders)
      if (!userPayload.order_id) {
        throw new Error('order_id is required');
      }
      if (!userPayload.user_type || !['live', 'demo'].includes(userPayload.user_type)) {
        throw new Error('user_type must be live or demo');
      }
      if (!userPayload.user_id) {
        throw new Error('user_id is required');
      }
      if (userPayload.close_price && !(userPayload.close_price > 0)) {
        throw new Error('close_price must be greater than 0 when provided');
      }

      // 4. Load canonical order (EXACT same logic as user orders)
      const canonical = await this._getCanonicalOrder(orderId);
      let sqlRow = null;
      
      if (!canonical) {
        // Fallback to SQL
        const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
        sqlRow = await OrderModel.findOne({ where: { order_id: orderId } });
        if (!sqlRow) {
          throw new Error('Order not found');
        }
        // Basic ownership check with SQL row
        const sqlUserId = normalizeStr(sqlRow.order_user_id);
        const reqUserId = normalizeStr(userId);
        if (sqlUserId !== reqUserId) {
          throw new Error('Order does not belong to user');
        }
        // Must be currently OPEN
        const stRow = (sqlRow.order_status || '').toString().toUpperCase();
        if (stRow && stRow !== 'OPEN') {
          throw new Error(`Order is not OPEN (current: ${stRow})`);
        }
      } else {
        // Ownership check using canonical
        const canonicalUserId = normalizeStr(canonical.user_id);
        const reqUserId = normalizeStr(userId);
        const canonicalUserType = normalizeStr(canonical.user_type).toLowerCase();
        if (canonicalUserId !== reqUserId || canonicalUserType !== userType) {
          throw new Error('Order does not belong to user');
        }
        // Must be currently OPEN
        const st = (canonical.order_status || '').toString().toUpperCase();
        if (st && st !== 'OPEN') {
          throw new Error(`Order is not OPEN (current: ${st})`);
        }
      }

      // 5. Extract order details (EXACT same logic as user orders)
      const symbol = (canonical && canonical.symbol)
        ? normalizeStr(canonical.symbol).toUpperCase()
        : (sqlRow ? normalizeStr(sqlRow.symbol || sqlRow.order_company_name).toUpperCase() : normalizeStr(userPayload.symbol).toUpperCase());
      const order_type = (canonical && canonical.order_type)
        ? normalizeStr(canonical.order_type).toUpperCase()
        : (sqlRow ? normalizeStr(sqlRow.order_type).toUpperCase() : normalizeStr(userPayload.order_type).toUpperCase());
      const willCancelTP = canonical
        ? (canonical.take_profit != null && Number(canonical.take_profit) > 0)
        : (sqlRow ? (sqlRow.take_profit != null && Number(sqlRow.take_profit) > 0) : false);
      const willCancelSL = canonical
        ? (canonical.stop_loss != null && Number(canonical.stop_loss) > 0)
        : (sqlRow ? (sqlRow.stop_loss != null && Number(sqlRow.stop_loss) > 0) : false);

      // 6. Generate lifecycle ids (EXACT same as user orders)
      const close_id = await idGenerator.generateCloseOrderId();
      const takeprofit_cancel_id = willCancelTP ? await idGenerator.generateTakeProfitCancelId() : undefined;
      const stoploss_cancel_id = willCancelSL ? await idGenerator.generateStopLossCancelId() : undefined;

      // 7. Persist lifecycle ids into SQL row (EXACT same as user orders)
      try {
        const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
        const rowToUpdate = sqlRow || await OrderModel.findOne({ where: { order_id: orderId } });
        if (rowToUpdate) {
          const idUpdates = { close_id };
          if (takeprofit_cancel_id) idUpdates.takeprofit_cancel_id = takeprofit_cancel_id;
          if (stoploss_cancel_id) idUpdates.stoploss_cancel_id = stoploss_cancel_id;
          idUpdates.status = userPayload.status; // persist whatever admin sent as status
          await rowToUpdate.update(idUpdates);
        }
        
        // Store in lifecycle service for complete ID history
        await orderLifecycleService.addLifecycleId(
          orderId, 
          'close_id', 
          close_id, 
          `Admin close order initiated - status: ${userPayload.status}`
        );
        
        if (takeprofit_cancel_id) {
          await orderLifecycleService.addLifecycleId(
            orderId, 
            'takeprofit_cancel_id', 
            takeprofit_cancel_id, 
            'Admin takeprofit cancel during close'
          );
        }
        
        if (stoploss_cancel_id) {
          await orderLifecycleService.addLifecycleId(
            orderId, 
            'stoploss_cancel_id', 
            stoploss_cancel_id, 
            'Admin stoploss cancel during close'
          );
        }
      } catch (e) {
        logger.warn('Failed to persist lifecycle ids before admin close', { order_id: orderId, error: e.message });
      }

      // 8. Build payload to Python (EXACT same structure as user orders)
      const pyPayload = {
        symbol,
        order_type,
        user_id: userPayload.user_id,
        user_type: userPayload.user_type,
        order_id: orderId,
        status: userPayload.status,
        order_status: userPayload.order_status,
        close_id,
      };
      if (takeprofit_cancel_id) pyPayload.takeprofit_cancel_id = takeprofit_cancel_id;
      if (stoploss_cancel_id) pyPayload.stoploss_cancel_id = stoploss_cancel_id;
      if (userPayload.close_price) pyPayload.close_price = userPayload.close_price;
      if (userPayload.idempotency_key) pyPayload.idempotency_key = normalizeStr(userPayload.idempotency_key);

      // 9. Call Python service (EXACT same URL as user orders)
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      
      logger.info('Admin closing order', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        symbol,
        order_type,
        close_id,
        willCancelTP,
        willCancelSL
      });

      let pyResp;
      try {
        pyResp = await pythonServiceAxios.post(
          `${baseUrl}/api/orders/close`,
          pyPayload,
          { timeout: 20000 }
        );
      } catch (err) {
        // Handle Python service error (EXACT same logic as user orders)
        const statusCode = err?.response?.status || 500;
        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };

        logger.error('Python service error for admin close order', {
          operationId,
          adminId: adminInfo.id,
          orderId,
          statusCode,
          detail,
          error: err.message
        });
        
        throw new Error(`Close order failed: ${detail?.detail?.reason || detail?.reason || err.message}`);
      }

      // 10. Log successful admin action
      logger.info('Admin order closed successfully', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        symbol,
        order_type,
        result: pyResp.data
      });

      // 11. Return EXACT same response structure as user orders
      return pyResp.data;

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
      
      throw error;
    }
  }

  /**
   * Helper method to get canonical order (EXACT same as user orders)
   */
  async _getCanonicalOrder(order_id) {
    try {
      const { redisCluster } = require('../../config/redis');
      const key = `order_data:${String(order_id)}`;
      const od = await redisCluster.hgetall(key);
      if (od && Object.keys(od).length > 0) return od;
    } catch (e) {
      logger.warn('Failed to fetch canonical order from Redis', { order_id, error: e.message });
    }
    return null;
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
   * Admin cancels pending order on behalf of user (EXACT SAME FLOW as user orders)
   * @param {Object} adminInfo - Admin information
   * @param {string} userType - 'live' or 'demo'
   * @param {number} userId - User ID
   * @param {string} orderId - Order ID to cancel
   * @param {Object} cancelData - Cancel data (EXACT same structure as user payload)
   * @param {Model} ScopedUserModel - Scoped user model
   * @returns {Object} Cancel result
   */
  async cancelPendingOrder(adminInfo, userType, userId, orderId, cancelData, ScopedUserModel) {
    const operationId = `admin_cancel_pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // 1. Validate admin access
      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);
      
      // 2. Build EXACT same payload structure as user orders
      const userPayload = {
        order_id: orderId,
        user_id: userId.toString(),
        user_type: userType,
        symbol: cancelData.symbol,
        order_type: cancelData.order_type,
        cancel_message: cancelData.cancel_message || 'Admin cancelled pending order',
        status: cancelData.status || 'PENDING-CANCEL'
      };

      // 3. Validate required fields (EXACT same validation as user orders)
      if (!userPayload.order_id || !userPayload.user_id || !userPayload.user_type || !userPayload.symbol || !['BUY_LIMIT','SELL_LIMIT','BUY_STOP','SELL_STOP'].includes(userPayload.order_type)) {
        throw new Error('Missing/invalid fields');
      }
      if (!['live','demo'].includes(userPayload.user_type)) {
        throw new Error('user_type must be live or demo');
      }

      // 4. Load canonical order and validate (EXACT same logic as user orders)
      const canonical = await this._getCanonicalOrder(orderId);
      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
      let row = null;
      
      if (!canonical) {
        row = await OrderModel.findOne({ where: { order_id: orderId } });
        if (!row) {
          throw new Error('Order not found');
        }
        if (normalizeStr(row.order_user_id) !== normalizeStr(userId)) {
          throw new Error('Order does not belong to user');
        }
        const st = (row.order_status || '').toString().toUpperCase();
        if (!['PENDING','PENDING-QUEUED','PENDING-CANCEL'].includes(st)) {
          throw new Error(`Order is not pending (current: ${st})`);
        }
      } else {
        if (normalizeStr(canonical.user_id) !== normalizeStr(userId) || normalizeStr(canonical.user_type).toLowerCase() !== userType) {
          throw new Error('Order does not belong to user');
        }
        const st = (canonical.order_status || '').toString().toUpperCase();
        if (!['PENDING','PENDING-QUEUED','PENDING-CANCEL'].includes(st)) {
          throw new Error(`Order is not pending (current: ${st})`);
        }
      }

      // 5. Extract order details (EXACT same logic as user orders)
      const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();
      const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

      // 6. Flow determination (EXACT same logic as user orders)
      let isProviderFlow = false;
      try {
        const { redisCluster } = require('../../config/redis');
        const ucfg = await redisCluster.hgetall(`user:{${userType}:${userId}}:config`);
        const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;
        isProviderFlow = (so === 'barclays');
      } catch (_) { 
        isProviderFlow = false; 
      }

      // 7. Frontend-intended engine status to persist (EXACT same as user orders)
      const statusReq = normalizeStr(userPayload.status || 'PENDING-CANCEL').toUpperCase();

      if (!isProviderFlow) {
        // 8. Local finalize (EXACT same logic as user orders)
        try {
          const { redisCluster } = require('../../config/redis');
          await redisCluster.zrem(`pending_index:{${symbol}}:${order_type}`, orderId);
          await redisCluster.delete(`pending_orders:${orderId}`);
        } catch (e) { 
          logger.warn('Failed to remove from pending ZSET/HASH', { error: e.message, order_id: orderId }); 
        }
        
        try {
          const { redisCluster } = require('../../config/redis');
          const tag = `${userType}:${userId}`;
          const idx = `user_orders_index:{${tag}}`;
          const h = `user_holdings:{${tag}}:${orderId}`;
          // Use pipeline only for same-slot keys (idx, h)
          const p1 = redisCluster.pipeline();
          p1.srem(idx, orderId);
          p1.delete(h);
          await p1.exec();
          // Delete canonical separately to avoid cross-slot pipeline error
          try { 
            await redisCluster.delete(`order_data:${orderId}`); 
          } catch (eDel) {
            logger.warn('Failed to delete order_data for admin pending cancel', { error: eDel.message, order_id: orderId });
          }
        } catch (e2) { 
          logger.warn('Failed to remove holdings/index for admin pending cancel', { error: e2.message, order_id: orderId }); 
        }
        
        try {
          const rowNow = await OrderModel.findOne({ where: { order_id: orderId } });
          if (rowNow) await rowNow.update({ order_status: 'CANCELLED', close_message: userPayload.cancel_message });
        } catch (e3) { 
          logger.warn('SQL update failed for admin pending cancel', { error: e3.message, order_id: orderId }); 
        }
        
        // Small delay to ensure database transaction is committed before WebSocket update
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Emit immediate WebSocket update for local pending cancellation
        try { 
          const portfolioEvents = require('./events/portfolio.events');
          portfolioEvents.emitUserUpdate(userType, userId.toString(), { 
            type: 'order_update', 
            order_id: orderId, 
            update: { order_status: 'CANCELLED' }, 
            reason: 'admin_local_pending_cancel' 
          }); 
          // Also emit a dedicated pending_cancelled event for immediate UI refresh
          portfolioEvents.emitUserUpdate(userType, userId.toString(), {
            type: 'pending_cancelled',
            order_id: orderId,
            reason: 'admin_local_pending_cancel'
          });
        } catch (_) {}
        
        logger.info('Admin local pending order cancelled', {
          operationId,
          adminId: adminInfo.id,
          adminRole: adminInfo.role,
          userType,
          userId,
          userEmail: user.email,
          orderId,
          symbol,
          order_type
        });
        
        return { success: true, order_id: orderId, order_status: 'CANCELLED' };
      }

      // 9. Provider path (EXACT same logic as user orders)
      let cancel_id = null;
      try { 
        cancel_id = await idGenerator.generateCancelOrderId(); 
      } catch (e) { 
        logger.warn('Failed to generate cancel_id', { error: e.message, order_id: orderId }); 
      }
      if (!cancel_id) {
        throw new Error('Failed to generate cancel id');
      }
      
      try {
        const rowNow = await OrderModel.findOne({ where: { order_id: orderId } });
        if (rowNow) await rowNow.update({ cancel_id, status: statusReq });
      } catch (e) { 
        logger.warn('Failed to persist cancel_id', { error: e.message, order_id: orderId }); 
      }
      
      try {
        const { redisCluster } = require('../../config/redis');
        const tag = `${userType}:${userId}`;
        const h = `user_holdings:{${tag}}:${orderId}`;
        const od = `order_data:${orderId}`;
        // Avoid cross-slot pipelines in Redis Cluster: perform per-key writes
        try { 
          await redisCluster.hset(h, 'cancel_id', String(cancel_id)); 
        } catch (e1) { 
          logger.warn('HSET cancel_id failed on user_holdings', { error: e1.message, order_id: orderId }); 
        }
        try { 
          await redisCluster.hset(od, 'cancel_id', String(cancel_id)); 
        } catch (e2) { 
          logger.warn('HSET cancel_id failed on order_data', { error: e2.message, order_id: orderId }); 
        }
        // Mirror engine-intended status for dispatcher routing (do not touch order_status here)
        try { 
          await redisCluster.hset(h, 'status', statusReq); 
        } catch (e3) { 
          logger.warn('HSET status failed on user_holdings', { error: e3.message, order_id: orderId }); 
        }
        try { 
          await redisCluster.hset(od, 'status', statusReq); 
        } catch (e4) { 
          logger.warn('HSET status failed on order_data', { error: e4.message, order_id: orderId }); 
        }
      } catch (e) { 
        logger.warn('Failed to mirror cancel status in Redis', { error: e.message, order_id: orderId }); 
      }
      
      // Register lifecycle ID
      try {
        const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
        pythonServiceAxios.post(
          `${baseUrl}/api/orders/registry/lifecycle-id`,
          { order_id: orderId, new_id: cancel_id, id_type: 'cancel_id' },
          { timeout: 5000 }
        ).catch(() => {});
      } catch (_) {}
      
      // Call Python service for provider cancellation
      try {
        const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
        const pyPayload = { order_id: orderId, cancel_id, order_type, user_id: userId.toString(), user_type: userType, status: 'CANCELLED' };
        pythonServiceAxios.post(
          `${baseUrl}/api/orders/pending/cancel`,
          pyPayload,
          { timeout: 5000 }
        ).then(() => {
          logger.info('Dispatched admin provider pending cancel', { order_id: orderId, cancel_id, order_type, adminId: adminInfo.id });
        }).catch((ePy) => { 
          logger.error('Python pending cancel failed for admin', { error: ePy.message, order_id: orderId, adminId: adminInfo.id }); 
        });
      } catch (_) {}
      
      logger.info('Admin provider pending order cancel initiated', {
        operationId,
        adminId: adminInfo.id,
        adminRole: adminInfo.role,
        userType,
        userId,
        userEmail: user.email,
        orderId,
        symbol,
        order_type,
        cancel_id
      });
      
      return { success: true, order_id: orderId, order_status: 'PENDING-CANCEL', cancel_id };

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
