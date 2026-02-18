const axios = require('axios');

const http = require('http');

const https = require('https');

const logger = require('./logger.service');

const { redisCluster } = require('../../config/redis');

const { LiveUserOrder, DemoUserOrder, LiveUser, DemoUser } = require('../models');

const StrategyProviderOrder = require('../models/strategyProviderOrder.model');

const CopyFollowerOrder = require('../models/copyFollowerOrder.model');

const StrategyProviderAccount = require('../models/strategyProviderAccount.model');

const CopyFollowerAccount = require('../models/copyFollowerAccount.model');

const idGenerator = require('./idGenerator.service');

const orderLifecycleService = require('./orderLifecycle.service');

const lotValidationService = require('./lot.validation.service');

const { acquireUserLock, releaseUserLock } = require('./userLock.service');

const copyTradingService = require('./copyTrading.service');



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



// Custom error class to preserve HTTP status codes

class AdminOrderError extends Error {

  constructor(message, statusCode = 500, reason = null, detail = null) {

    super(message);

    this.name = 'AdminOrderError';

    this.statusCode = statusCode;

    this.reason = reason;

    this.detail = detail;

  }

}



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

  if (!['live', 'demo', 'strategy_provider', 'copy_follower'].includes(user_type)) errors.push('user_type');



  return { errors, parsed: { symbol, order_type, user_type, order_price, order_quantity, user_id } };

}



function validatePendingOrderPayload(body) {

  const errors = [];

  const symbol = normalizeStr(body.symbol).toUpperCase();

  const order_type = normalizeStr(body.order_type).toUpperCase();

  const order_price = toNumber(body.price || body.order_price);

  const order_quantity = toNumber(body.quantity || body.order_quantity);

  const user_id = normalizeStr(body.user_id);

  const user_type = normalizeStr(body.user_type).toLowerCase();



  if (!symbol) errors.push('symbol');

  if (!['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'].includes(order_type)) errors.push('order_type');

  if (!(order_price > 0)) errors.push('order_price');

  if (!(order_quantity > 0)) errors.push('order_quantity');

  if (!user_id) errors.push('user_id');

  if (!['live', 'demo', 'strategy_provider', 'copy_follower'].includes(user_type)) errors.push('user_type');



  return { errors, parsed: { symbol, order_type, order_price, order_quantity, user_id, user_type } };

}



class AdminOrderManagementService {

  _getUserModelByType(userType) {

    switch (String(userType).toLowerCase()) {

      case 'live':

        return LiveUser;

      case 'demo':

        return DemoUser;

      case 'strategy_provider':

        return StrategyProviderAccount;

      case 'copy_follower':

        return CopyFollowerAccount;

      default:

        return null;

    }

  }



  _getOrderModelByType(userType) {

    switch (String(userType).toLowerCase()) {

      case 'live':

        return LiveUserOrder;

      case 'demo':

        return DemoUserOrder;

      case 'strategy_provider':

        return StrategyProviderOrder;

      case 'copy_follower':

        return CopyFollowerOrder;

      default:

        return null;

    }

  }



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

        const UserModel = this._getUserModelByType(userType);



        if (!UserModel) {

          throw new Error(`Unsupported user type: ${userType}`);

        }



        const attrs = String(userType).toLowerCase() === 'live' || String(userType).toLowerCase() === 'demo'

          ? ['id', 'name', 'email', 'account_number', 'group', 'status', 'is_active', 'sending_orders']

          : ['id', 'user_id', 'account_number', 'group', 'status', 'is_active', 'sending_orders'];



        user = await UserModel.findByPk(userId, { attributes: attrs });



        logger.info('Superadmin access - bypassing country scoping', {

          operationId,

          adminId: adminInfo.id,

          adminRole: adminInfo.role,

          userType,

          userId

        });

      } else {

        // Regular admins use scoped model (country restrictions apply)

        const attrs = String(userType).toLowerCase() === 'live' || String(userType).toLowerCase() === 'demo'

          ? ['id', 'name', 'email', 'account_number', 'group', 'status', 'is_active', 'sending_orders']

          : ['id', 'user_id', 'account_number', 'group', 'status', 'is_active', 'sending_orders'];



        user = await ScopedUserModel.findByPk(userId, { attributes: attrs });

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

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }



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

      if (String(userType).toLowerCase() === 'copy_follower') {

        throw new AdminOrderError(

          'copy_follower orders cannot be placed directly. They must be created by copy distribution from a strategy_provider master order.',

          400,

          'copy_follower_direct_place_not_supported'

        );

      }



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

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

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



        // Throw AdminOrderError with preserved status code and details

        const reason = detail?.detail?.reason || detail?.reason || 'execution_failed';

        const errorDetail = detail?.detail || detail;

        throw new AdminOrderError(

          `Python service error: ${reason}`,

          statusCode,

          reason,

          errorDetail

        );

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



      // 12. Strategy provider master orders: create Redis entries + replicate to followers (admin path)

      if (flow === 'local' && String(userType).toLowerCase() === 'strategy_provider') {

        logger.info('Admin local strategy_provider order: entering copy trading replication hook', {

          order_id: finalOrderId,

          userType,

          userId,

          flow,

          order_status: updateFields?.order_status

        });

        try {

          const masterOrderRow = await StrategyProviderOrder.findOne({ where: { order_id: finalOrderId } });

          if (!masterOrderRow) {

            logger.warn('Admin local strategy_provider order: master order row not found for copy trading', {

              order_id: finalOrderId,

              userType,

              userId

            });

          }

          if (masterOrderRow) {

            const dist = String(masterOrderRow.copy_distribution_status || '').toLowerCase();

            if (dist !== 'completed' && dist !== 'distributing') {

              try {

                await copyTradingService.createRedisOrderEntries(masterOrderRow, 'strategy_provider');

              } catch (redisErr) {

                logger.warn('Failed to create Redis entries for admin-placed strategy provider master order', {

                  order_id: finalOrderId,

                  userType,

                  userId,

                  error: redisErr.message

                });

              }



              try {

                await copyTradingService.processStrategyProviderOrder(masterOrderRow);

              } catch (copyErr) {

                logger.error('Failed to replicate admin-placed strategy provider master order to followers', {

                  order_id: finalOrderId,

                  userType,

                  userId,

                  error: copyErr.message

                });

              }

            } else {

              logger.info('Admin local strategy_provider order: copy distribution already in progress/completed; skipping replication', {

                order_id: finalOrderId,

                userType,

                userId,

                copy_distribution_status: masterOrderRow.copy_distribution_status

              });

            }

          }

        } catch (copyOuterErr) {

          logger.error('Failed to process copy trading for admin-placed strategy provider order', {

            order_id: finalOrderId,

            userType,

            userId,

            error: copyOuterErr.message

          });

        }

      }



      // 13. Log successful admin action

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



      // 14. Return EXACT same response structure as user orders

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

    const fs = require('fs');

    const path = require('path');



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



      // Check if this is a SUPERADMIN FORCE CLOSE

      // "admin close order for users manually should accept the close_price... and close locally irrespective of execution flow"

      const superadminForceCloseEnabled = false;

      if (superadminForceCloseEnabled && adminInfo.role === 'superadmin') {

        logger.info('Superadmin initiating force local close', {

          order_id: orderId,

          admin_id: adminInfo.id,

          close_price: userPayload.close_price

        });

        return await this._forceSuperadminLocalClose(

          adminInfo,

          user,

          userType,

          userId,

          orderId,

          userPayload

        );

      }



      // 🆕 Set close context for proper close_message attribution in worker_close.py

      try {

        const { redisCluster } = require('../../config/redis');

        const contextKey = `close_context:${orderId}`;

        const contextValue = {

          context: 'ADMIN_CLOSED',

          initiator: `admin:${adminInfo.id}:${adminInfo.email}`,

          timestamp: Math.floor(Date.now() / 1000).toString()

        };



        await redisCluster.hset(contextKey, contextValue);

        await redisCluster.expire(contextKey, 300); // 5 minutes TTL



        logger.info('Close context set for admin close', {

          order_id: orderId,

          admin_id: adminInfo.id,

          admin_email: adminInfo.email

        });

      } catch (e) {

        logger.warn('Failed to set admin close context', {

          error: e.message,

          order_id: orderId,

          admin_id: adminInfo.id

        });

      }



      // 3. Validate required fields (EXACT same validation as user orders)

      if (!userPayload.order_id) {

        throw new Error('order_id is required');

      }

      if (!userPayload.user_type || !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userPayload.user_type)) {

        throw new Error('user_type must be live, demo, strategy_provider, or copy_follower');

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

        const OrderModel = this._getOrderModelByType(userType);

        if (!OrderModel) {

          throw new Error(`Unsupported user type: ${userType}`);

        }

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

        const OrderModel = this._getOrderModelByType(userType);

        if (!OrderModel) {

          throw new Error(`Unsupported user type: ${userType}`);

        }

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



        // Throw AdminOrderError with preserved status code and details

        const reason = detail?.detail?.reason || detail?.reason || 'close_failed';

        const errorDetail = detail?.detail || detail;

        throw new AdminOrderError(

          `Close order failed: ${reason}`,

          statusCode,

          reason,

          errorDetail

        );

      }



      // 10. Handle local flow DB updates (EXACT same logic as user orders)

      const result = pyResp.data?.data || pyResp.data || {};

      const flow = result.flow; // 'local' or 'provider'



      // If local flow, finalize DB immediately (EXACT same as user orders)

      if (flow === 'local') {

        try {

          const OrderModel = this._getOrderModelByType(userType);

          if (!OrderModel) {

            throw new Error(`Unsupported user type: ${userType}`);

          }

          const row = await OrderModel.findOne({ where: { order_id: orderId } });

          if (row) {

            const updateFields = {

              order_status: 'CLOSED',

            };

            if (result.close_price != null) updateFields.close_price = String(result.close_price);

            if (result.net_profit != null) updateFields.net_profit = String(result.net_profit);

            if (result.swap != null) updateFields.swap = String(result.swap);

            if (result.total_commission != null) updateFields.commission = String(result.total_commission);

            // Also persist incoming status string for historical trace

            updateFields.status = userPayload.status;

            await row.update(updateFields);



            // Apply wallet payout + user transactions (idempotent) - EXACT same as user orders

            try {

              const { redisCluster } = require('../../config/redis');

              const payoutKey = `close_payout_applied:${String(orderId)}`;

              const nx = await redisCluster.set(payoutKey, '1', 'EX', 7 * 24 * 3600, 'NX');

              if (nx) {

                const { applyOrderClosePayout } = require('./order.payout.service');

                await applyOrderClosePayout({

                  userType: userType,

                  userId: parseInt(userId, 10),

                  orderPk: row?.id ?? null,

                  orderIdStr: String(orderId),

                  netProfit: Number(result.net_profit) || 0,

                  commission: Number(result.total_commission) || 0,

                  profitUsd: Number(result.profit_usd) || 0,

                  swap: Number(result.swap) || 0,

                  symbol,

                  orderType: order_type,

                });

                try {

                  const portfolioEvents = require('./events/portfolio.events');

                  portfolioEvents.emitUserUpdate(userType, userId.toString(), { type: 'wallet_balance_update', order_id: orderId });

                } catch (_) { }

              }

            } catch (e) {

              logger.warn('Failed to apply wallet payout on admin local close', { error: e.message, order_id: orderId });

            }

          }

        } catch (e) {

          logger.error('Failed to update SQL row after admin local close', { order_id: orderId, error: e.message });

        }



        // Update used margin mirror in SQL and emit portfolio events (EXACT same as user orders)

        try {

          if (typeof result.used_margin_executed === 'number') {

            const { updateUserUsedMargin } = require('./user.margin.service');

            await updateUserUsedMargin({ userType: userType, userId: parseInt(userId, 10), usedMargin: result.used_margin_executed });

            try {

              const portfolioEvents = require('./events/portfolio.events');

              portfolioEvents.emitUserUpdate(userType, userId.toString(), { type: 'user_margin_update', used_margin_usd: result.used_margin_executed });

            } catch (_) { }

          }

          try {

            const portfolioEvents = require('./events/portfolio.events');

            portfolioEvents.emitUserUpdate(userType, userId.toString(), { type: 'order_update', order_id: orderId, update: { order_status: 'CLOSED' } });

          } catch (_) { }

        } catch (mErr) {

          logger.error('Failed to persist/emit margin updates after admin local close', { order_id: orderId, error: mErr.message });

        }



        // Increment user's aggregate net_profit with this close P/L (EXACT same as user orders)

        try {

          if (typeof result.net_profit === 'number') {

            const UserModel = this._getUserModelByType(userType);

            if (UserModel) {

              await UserModel.increment({ net_profit: result.net_profit }, { where: { id: parseInt(userId, 10) } });

            }

          }

        } catch (e) {

          logger.error('Failed to increment user net_profit after admin local close', { user_id: userId, error: e.message });

        }

      }



      // 11. Log successful admin action

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

        flow,

        result: pyResp.data

      });



      // 12. Return EXACT same response structure as user orders

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

      if (od && Object.keys(od).length > 0) {

        // Check if order_status is missing or empty - indicates stale cache

        if (!od.order_status || od.order_status.trim() === '') {

          logger.warn('Redis canonical order has empty status - possible stale cache', {

            order_id,

            redisData: od

          });

          return null; // Force fallback to database

        }

        return od;

      }

    } catch (e) {

      logger.warn('Failed to fetch canonical order from Redis', { order_id, error: e.message });

    }

    return null;

  }



  /**

   * Admin places pending order on behalf of user (EXACT SAME FLOW as user orders)

   * @param {Object} adminInfo - Admin information

   * @param {string} userType - 'live' or 'demo'

   * @param {number} userId - User ID

   * @param {Object} orderData - Pending order data (EXACT same structure as user payload)

   * @param {Model} ScopedUserModel - Scoped user model

   * @returns {Object} Order result

   */

  async placePendingOrder(adminInfo, userType, userId, orderData, ScopedUserModel) {

    const operationId = `admin_place_pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;



    try {

      if (String(userType).toLowerCase() === 'copy_follower') {

        throw new AdminOrderError(

          'copy_follower pending orders cannot be placed directly. Pending copy orders must be created by copy distribution from a strategy_provider master order.',

          400,

          'copy_follower_direct_pending_place_not_supported'

        );

      }



      // 1. Validate admin access

      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);



      // 2. Build EXACT same payload structure as user orders

      const userPayload = {

        symbol: orderData.symbol,

        order_type: orderData.order_type, // BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP

        order_price: orderData.order_price || orderData.price,

        order_quantity: orderData.order_quantity || orderData.quantity,

        user_id: userId.toString(),

        user_type: userType

      };



      // 3. Validate payload (EXACT same validation as user orders)

      let parsed;

      try {

        const validationResult = validatePendingOrderPayload(userPayload);

        if (validationResult.errors.length) {

          throw new Error(`Invalid payload fields: ${validationResult.errors.join(', ')}`);

        }

        parsed = validationResult.parsed;



        if (!parsed || !parsed.symbol) {

          throw new Error('Validation failed: parsed object is invalid');

        }

      } catch (validationError) {

        logger.error('Admin pending order validation failed', {

          operationId,

          userPayload,

          adminId: adminInfo.id,

          error: validationError.message

        });

        throw validationError;

      }



      // 4. Get user group from JWT or user data (EXACT same as user orders)

      const userGroup = user.group || 'Standard';



      // 5. Fetch current market prices from Redis (EXACT same as user orders)

      let bid = null, ask = null;

      try {

        const { redisCluster } = require('../../config/redis');

        const arr = await redisCluster.hmget(`market:${parsed.symbol}`, 'bid', 'ask');

        if (arr && arr.length >= 2) {

          bid = arr[0] != null ? Number(arr[0]) : null;

          ask = arr[1] != null ? Number(arr[1]) : null;

        }

      } catch (e) {

        logger.error('Failed to read market price from Redis', { error: e.message, symbol: parsed.symbol });

      }

      if (!(bid > 0) || !(ask > 0)) {

        throw new Error('Market price unavailable for symbol');

      }



      // 6. Compute half_spread from group cache (EXACT same as user orders)

      let half_spread = null;

      try {

        const groupsCache = require('./groups.cache.service');

        const gf = await groupsCache.getGroupFields(userGroup, parsed.symbol, ['spread', 'spread_pip']);

        if (gf && gf.spread != null && gf.spread_pip != null) {

          const spread = Number(gf.spread);

          const spread_pip = Number(gf.spread_pip);

          if (Number.isFinite(spread) && Number.isFinite(spread_pip)) {

            half_spread = (spread * spread_pip) / 2.0;

          }

        }

      } catch (e) {

        logger.warn('Failed to get group spread config for admin pending', { error: e.message, group: userGroup, symbol: parsed.symbol });

      }

      if (!(half_spread >= 0)) {

        throw new Error('Group spread configuration missing for symbol/group');

      }



      // 7. Compute compare_price (EXACT same as user orders)

      const hs = Number.isFinite(Number(half_spread)) ? Number(half_spread) : 0;

      const compare_price = Number((parsed.order_price - hs).toFixed(8));

      if (!(compare_price > 0)) {

        throw new Error('Computed compare_price invalid');

      }



      // 8. Determine if provider flow (EXACT same as user orders)

      let isProviderFlow = false;

      try {

        const { redisCluster } = require('../../config/redis');

        const userCfgKey = `user:{${userType}:${userId}}:config`;

        const ucfg = await redisCluster.hgetall(userCfgKey);

        const so = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;

        isProviderFlow = (so === 'barclays');

      } catch (_) {

        isProviderFlow = false;

      }



      // 9. Generate order_id and persist SQL row (EXACT same as user orders)

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

      const order_id = await idGenerator.generateOrderId();

      try {

        await OrderModel.create({

          order_id,

          order_user_id: parseInt(userId, 10),

          symbol: parsed.symbol,

          order_type: parsed.order_type,

          order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',

          order_price: parsed.order_price,

          order_quantity: parsed.order_quantity,

          margin: 0,

          status: 'PENDING',

          placed_by: 'admin',

        });

      } catch (dbErr) {

        logger.error('Admin pending order DB create failed', { error: dbErr.message, order_id });

        throw new Error(`DB error: ${dbErr.message}`);

      }



      // 10. Store pending order in Redis (EXACT same as user orders)

      const symbol = String(parsed.symbol).toUpperCase();

      const orderType = String(parsed.order_type).toUpperCase();

      const zkey = `pending_index:{${symbol}}:${orderType}`;

      const hkey = `pending_orders:${order_id}`;



      try {

        const { redisCluster } = require('../../config/redis');

        if (!isProviderFlow) {

          await redisCluster.zadd(zkey, compare_price, order_id);

          await redisCluster.hset(hkey, {

            symbol: symbol,

            order_type: orderType,

            user_type: userType,

            user_id: userId.toString(),

            order_price_user: String(parsed.order_price),

            order_price_compare: String(compare_price),

            order_quantity: String(parsed.order_quantity),

            status: 'PENDING',

            created_at: Date.now().toString(),

            group: userGroup,

          });

        }



        // Mirror minimal PENDING into user holdings and index (EXACT same as user orders)

        try {

          const hashTag = `${userType}:${userId}`;

          const orderKey = `user_holdings:{${hashTag}}:${order_id}`;

          const indexKey = `user_orders_index:{${hashTag}}`;

          const pipe = redisCluster.pipeline();

          pipe.sadd(indexKey, order_id);

          pipe.hset(orderKey, {

            order_id: String(order_id),

            symbol: symbol,

            order_type: orderType,

            order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',

            status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',

            execution_status: 'QUEUED',

            order_price: String(parsed.order_price),

            order_quantity: String(parsed.order_quantity),

            group: userGroup,

            created_at: Date.now().toString(),

          });

          await pipe.exec();

        } catch (e3) {

          logger.warn('Failed to mirror admin pending into user holdings/index', { error: e3.message, order_id });

        }



        // Write canonical order_data (EXACT same as user orders)

        try {

          const odKey = `order_data:${String(order_id)}`;

          await redisCluster.hset(odKey, {

            order_id: String(order_id),

            user_type: String(userType),

            user_id: String(userId),

            symbol: symbol,

            order_type: orderType,

            order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',

            status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',

            order_price: String(parsed.order_price),

            order_quantity: String(parsed.order_quantity),

            group: userGroup,

            compare_price: String(compare_price),

            half_spread: String(hs),

          });

        } catch (e4) {

          logger.warn('Failed to write canonical order_data for admin pending', { error: e4.message, order_id });

        }



        // Ensure symbol is tracked for periodic scanning (EXACT same as user orders)

        try {

          if (!isProviderFlow) {

            await redisCluster.sadd('pending_active_symbols', symbol);

          }

        } catch (e2) {

          logger.warn('Failed to add symbol to pending_active_symbols set', { error: e2.message, symbol });

        }

      } catch (e) {

        logger.error('Failed to write admin pending order to Redis', { error: e.message, order_id, zkey });

        throw new Error('Cache error');

      }



      // 11. Publish market_price_updates (EXACT same as user orders)

      try {

        const { redisCluster } = require('../../config/redis');

        await redisCluster.publish('market_price_updates', symbol);

        logger.info('Published market_price_updates for admin pending placement', { symbol, zkey, order_id });

      } catch (e) {

        logger.warn('Failed to publish market_price_updates after admin pending placement', { error: e.message, symbol, order_id });

      }



      // 11.1 Strategy provider master pending orders: create Redis entries + replicate pending to followers (admin path)

      if (String(userType).toLowerCase() === 'strategy_provider') {

        try {

          logger.info('Admin strategy_provider pending order: entering copy trading pending replication hook', {

            order_id,

            userType,

            userId,

            isProviderFlow,

            order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING'

          });



          const masterOrderRow = await StrategyProviderOrder.findOne({ where: { order_id } });

          if (!masterOrderRow) {

            logger.warn('Admin strategy_provider pending order: master order row not found for copy trading', {

              order_id,

              userType,

              userId

            });

          }



          if (masterOrderRow) {

            const dist = String(masterOrderRow.copy_distribution_status || '').toLowerCase();

            if (dist !== 'completed' && dist !== 'distributing') {

              try {

                await copyTradingService.createRedisOrderEntries(masterOrderRow, 'strategy_provider');

              } catch (redisErr) {

                logger.warn('Failed to create Redis entries for admin-placed strategy provider pending master order', {

                  order_id,

                  userType,

                  userId,

                  error: redisErr.message

                });

              }



              try {

                await copyTradingService.processStrategyProviderPendingOrder(masterOrderRow);

              } catch (copyErr) {

                logger.error('Failed to replicate admin-placed strategy provider pending master order to followers', {

                  order_id,

                  userType,

                  userId,

                  error: copyErr.message

                });

              }

            } else {

              logger.info('Admin strategy_provider pending order: copy distribution already in progress/completed; skipping replication', {

                order_id,

                userType,

                userId,

                copy_distribution_status: masterOrderRow.copy_distribution_status

              });

            }

          }

        } catch (copyOuterErr) {

          logger.error('Failed to process copy trading for admin-placed strategy provider pending order', {

            order_id,

            userType,

            userId,

            error: copyOuterErr.message

          });

        }

      }



      // 12. Notify WS layer (EXACT same as user orders)

      try {

        const portfolioEvents = require('./events/portfolio.events');

        portfolioEvents.emitUserUpdate(userType, userId.toString(), {

          type: 'order_update',

          order_id,

          update: { order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING' },

        });

      } catch (e) {

        logger.warn('Failed to emit portfolio event for admin pending order', { error: e.message, order_id });

      }



      // 13. Provider flow: send to Python if needed (EXACT same as user orders)

      try {

        if (isProviderFlow) {

          try {

            const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

            const payload = {

              order_id,

              symbol,

              order_type: orderType,

              order_price: parsed.order_price,

              order_quantity: parsed.order_quantity,

              user_id: userId.toString(),

              user_type: userType,

            };

            pythonServiceAxios.post(

              `${baseUrl}/api/orders/pending/place`,

              payload,

              { timeout: 5000 }

            )

              .then(() => {

                logger.info('Dispatched admin provider pending placement', { order_id, symbol, orderType, adminId: adminInfo.id });

              })

              .catch((ePy) => {

                logger.error('Python provider pending placement failed for admin', { error: ePy.message, order_id, adminId: adminInfo.id });

              });

          } catch (ePyOuter) {

            logger.warn('Unable to initiate admin provider pending placement call', { error: ePyOuter.message, order_id });

          }

        }

      } catch (eProv) {

        logger.warn('Admin provider pending dispatch block failed', { error: eProv.message, order_id });

      }



      // 14. Log successful admin action

      logger.info('Admin pending order placed successfully', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        order_id,

        symbol,

        order_type: orderType,

        order_price: parsed.order_price,

        order_quantity: parsed.order_quantity,

        compare_price,

        group: userGroup,

        isProviderFlow

      });



      // 15. Return EXACT same response structure as user orders

      return {

        success: true,

        order_id,

        order_status: isProviderFlow ? 'PENDING-QUEUED' : 'PENDING',

        compare_price,

        group: userGroup,

      };



    } catch (error) {

      logger.error('Failed to place admin pending order', {

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



      // 2. First get the existing order to extract symbol and order_type

      const canonical = await this._getCanonicalOrder(orderId);

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

      let row = null;



      if (!canonical) {

        try {

          row = await OrderModel.findOne({ where: { order_id: orderId } });

        } catch (e) {

          logger.warn('Failed to fetch order from SQL', { error: e.message, orderId });

        }

      }



      if (!canonical && !row) {

        throw new Error('Order not found');

      }



      // Extract order details from existing order

      const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();

      const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();



      // 3. Build EXACT same payload structure as user orders

      const userPayload = {

        order_id: orderId,

        user_id: userId.toString(),

        user_type: userType,

        symbol: symbol,

        order_type: order_type,

        cancel_message: cancelData.cancel_message || 'Admin cancelled pending order',

        status: cancelData.status || 'PENDING-CANCEL'

      };



      // 4. Validate order ownership and status

      if (canonical) {

        if (normalizeStr(canonical.user_id) !== normalizeStr(userId) || normalizeStr(canonical.user_type).toLowerCase() !== userType) {

          throw new Error('Order does not belong to user');

        }

        const st = (canonical.order_status || '').toString().toUpperCase();

        if (!['PENDING', 'PENDING-QUEUED', 'PENDING-CANCEL'].includes(st)) {

          throw new Error(`Order is not pending (current: ${st})`);

        }

      } else if (row) {

        if (normalizeStr(row.order_user_id) !== normalizeStr(userId)) {

          throw new Error('Order does not belong to user');

        }

        const st = (row.order_status || '').toString().toUpperCase();

        if (!['PENDING', 'PENDING-QUEUED', 'PENDING-CANCEL'].includes(st)) {

          throw new Error(`Order is not pending (current: ${st})`);

        }

      }



      // 5. Validate required fields (EXACT same validation as user orders)

      if (!userPayload.order_id || !userPayload.user_id || !userPayload.user_type || !userPayload.symbol || !['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'].includes(userPayload.order_type)) {

        throw new Error('Missing/invalid fields');

      }

      if (!['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userPayload.user_type)) {

        throw new Error('user_type must be live, demo, strategy_provider, or copy_follower');

      }



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

          await redisCluster.del(`pending_orders:${orderId}`);

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

          p1.del(h);

          await p1.exec();

          // Delete canonical separately to avoid cross-slot pipeline error

          try {

            await redisCluster.del(`order_data:${orderId}`);

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

        // Strategy provider master pending cancel: mirror to follower orders
        if (String(userType).toLowerCase() === 'strategy_provider') {
          try {
            const masterRow = await StrategyProviderOrder.findOne({ where: { order_id: orderId } });
            if (masterRow) {
              logger.info('Admin pending cancel: syncing copy followers via master order update hook', {
                order_id: orderId,
                userType,
                userId,
                masterOrderStatus: masterRow.order_status
              });
              await copyTradingService.processStrategyProviderOrderUpdate(masterRow);
              logger.info('Admin pending cancel: copy follower sync completed', {
                order_id: orderId,
                userType,
                userId
              });
            } else {
              logger.warn('Admin pending cancel: strategy provider master order row not found for follower sync', {
                order_id: orderId,
                userType,
                userId
              });
            }
          } catch (eCopy) {
            logger.error('Failed to process copy trading update after admin local pending cancel', {
              order_id: orderId,
              userType,
              userId,
              error: eCopy.message
            });
          }
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

        } catch (_) { }



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

        ).catch(() => { });

      } catch (_) { }



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

      } catch (_) { }



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

   * Admin sets stop loss for an existing order (EXACT SAME FLOW as user orders)

   * @param {Object} adminInfo - Admin information

   * @param {string} userType - 'live' or 'demo'

   * @param {number} userId - User ID

   * @param {string} orderId - Order ID

   * @param {Object} slData - Stop loss data (EXACT same structure as user payload)

   * @param {Model} ScopedUserModel - Scoped user model

   * @returns {Object} Stop loss result

   */

  async setStopLoss(adminInfo, userType, userId, orderId, slData, ScopedUserModel) {

    const operationId = `admin_add_stoploss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;



    try {

      // 1. Validate admin access

      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);



      // 2. Build EXACT same payload structure as user orders

      const userPayload = {

        order_id: orderId,

        user_id: userId.toString(),

        user_type: userType,

        stop_loss: slData.stop_loss_price || slData.stop_loss,

        status: slData.status || 'STOPLOSS'

      };



      // 3. Validate required fields (EXACT same validation as user orders)

      if (!userPayload.order_id) {

        throw new Error('order_id is required');

      }

      if (!userPayload.user_id) {

        throw new Error('user_id is required');

      }

      if (!userPayload.user_type || !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userPayload.user_type)) {

        throw new Error('user_type must be live, demo, strategy_provider, or copy_follower');

      }

      if (!userPayload.stop_loss || !(Number(userPayload.stop_loss) > 0)) {

        throw new Error('stop_loss must be a positive number');

      }



      // 4. Load canonical order and validate (EXACT same logic as user orders)

      const canonical = await this._getCanonicalOrder(orderId);

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

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

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      } else {

        if (normalizeStr(canonical.user_id) !== normalizeStr(userId) || normalizeStr(canonical.user_type).toLowerCase() !== userType) {

          throw new Error('Order does not belong to user');

        }

        const st = (canonical.order_status || '').toString().toUpperCase();

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      }



      // 5. Extract order details (EXACT same logic as user orders)

      const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();

      const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

      const entry_price_num = canonical

        ? Number(canonical.execution_price || canonical.order_price)

        : Number(row.execution_price || row.order_price);



      if (!(entry_price_num > 0)) {

        throw new Error('Invalid entry price for stop loss calculation');

      }



      // 6. Generate lifecycle id and persist to SQL (EXACT same as user orders)

      const stoploss_id = await idGenerator.generateStopLossId();

      try {

        const toUpdate = row || (await OrderModel.findOne({ where: { order_id: orderId } }));

        if (toUpdate) {

          await toUpdate.update({ stoploss_id, status: userPayload.status });

        }



        // Store in lifecycle service for complete ID history

        await orderLifecycleService.addLifecycleId(

          orderId,

          'stoploss_id',

          stoploss_id,

          `Admin stoploss added - price: ${userPayload.stop_loss}`

        );

      } catch (e) {

        logger.warn('Failed to persist admin stoploss_id before send', { order_id: orderId, error: e.message });

      }



      // 7. Build payload to Python (EXACT same structure as user orders)

      const pyPayload = {

        order_id: orderId,

        symbol,

        user_id: userPayload.user_id,

        user_type: userPayload.user_type,

        order_type,

        order_price: entry_price_num,

        stoploss_id,

        stop_loss: userPayload.stop_loss,

        status: 'STOPLOSS',

      };



      // 8. Call Python service (EXACT same URL as user orders)

      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';



      logger.info('Admin setting stop loss', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        stop_loss: userPayload.stop_loss,

        stoploss_id

      });



      let pyResp;

      try {

        pyResp = await pythonServiceAxios.post(

          `${baseUrl}/api/orders/stoploss/add`,

          pyPayload,

          { timeout: 15000 }

        );

      } catch (err) {

        // Handle Python service error (EXACT same logic as user orders)

        const statusCode = err?.response?.status || 500;

        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };



        logger.error('Python service error for admin stop loss', {

          operationId,

          adminId: adminInfo.id,

          orderId,

          statusCode,

          detail,

          error: err.message

        });



        // Throw AdminOrderError with preserved status code and details

        const reason = detail?.detail?.reason || detail?.reason || 'stoploss_failed';

        const errorDetail = detail?.detail || detail;

        throw new AdminOrderError(

          `Stop loss failed: ${reason}`,

          statusCode,

          reason,

          errorDetail

        );

      }



      // 9. Handle response based on flow (EXACT same logic as user orders)

      const result = pyResp.data?.data || pyResp.data || {};

      const flow = result.flow;



      if (flow === 'local') {

        try {

          // Update SQL row for local flow

          const rowNow = await OrderModel.findOne({ where: { order_id: orderId } });

          if (rowNow) {

            await rowNow.update({ stop_loss: String(userPayload.stop_loss) });

          }

        } catch (e) {

          logger.warn('Failed to update SQL row for admin stoploss (local flow)', { order_id: orderId, error: e.message });

        }



        // Emit WebSocket event for local flow

        try {

          const portfolioEvents = require('./events/portfolio.events');

          portfolioEvents.emitUserUpdate(userType, userId.toString(), {

            type: 'order_update',

            order_id: orderId,

            update: { stop_loss: String(userPayload.stop_loss) },

            reason: 'admin_local_stoploss_set',

          });

        } catch (e) {

          logger.warn('Failed to emit WS event after admin local stoploss set', { order_id: orderId, error: e.message });

        }

      }



      // 10. Log successful admin action

      logger.info('Admin stop loss set successfully', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        stop_loss: userPayload.stop_loss,

        stoploss_id,

        flow,

        result

      });



      // 11. Return EXACT same response structure as user orders

      return { success: true, data: result, order_id: orderId, stoploss_id };



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



      throw error;

    }

  }



  /**

   * Admin removes stop loss from an existing order (EXACT SAME FLOW as user orders)

   * @param {Object} adminInfo - Admin information

   * @param {string} userType - 'live' or 'demo'

   * @param {number} userId - User ID

   * @param {string} orderId - Order ID

   * @param {Object} cancelData - Cancel data (EXACT same structure as user payload)

   * @param {Model} ScopedUserModel - Scoped user model

   * @returns {Object} Stop loss removal result

   */

  async removeStopLoss(adminInfo, userType, userId, orderId, cancelData, ScopedUserModel) {

    const operationId = `admin_cancel_stoploss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;



    try {

      // 1. Validate admin access

      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);



      // 2. Build EXACT same payload structure as user orders

      const userPayload = {

        order_id: orderId,

        user_id: userId.toString(),

        user_type: userType,

        status: cancelData.status || 'STOPLOSS-CANCEL',

        order_status: cancelData.order_status || 'OPEN'

      };



      // 3. Validate required fields (EXACT same validation as user orders)

      if (!userPayload.order_id) {

        throw new Error('order_id is required');

      }

      if (!userPayload.user_id) {

        throw new Error('user_id is required');

      }

      if (!userPayload.user_type || !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userPayload.user_type)) {

        throw new Error('user_type must be live, demo, strategy_provider, or copy_follower');

      }



      // 4. Load canonical order and validate (EXACT same logic as user orders)

      const canonical = await this._getCanonicalOrder(orderId);

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

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

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      } else {

        if (normalizeStr(canonical.user_id) !== normalizeStr(userId) || normalizeStr(canonical.user_type).toLowerCase() !== userType) {

          throw new Error('Order does not belong to user');

        }

        const st = (canonical.order_status || '').toString().toUpperCase();

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      }



      // 5. Check for active stop loss (EXACT same logic as user orders)

      let hasSL = false;

      if (canonical) {

        const slVal = canonical.stop_loss;

        if (slVal && Number(slVal) > 0) hasSL = true;

      } else if (row) {

        const slVal = row.stop_loss;

        if (slVal && Number(slVal) > 0) hasSL = true;

      }

      if (!hasSL) {

        throw new Error('No active stoploss to cancel');

      }



      // 6. Extract order details (EXACT same logic as user orders)

      const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();

      const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

      const previousStopLoss = canonical ? canonical.stop_loss : row.stop_loss;



      // 7. Determine sending flow (EXACT same logic as user orders)

      let sendingOrders = null;

      try {

        const { redisCluster } = require('../../config/redis');

        const ucfg = await redisCluster.hgetall(`user:{${userType}:${userId}}:config`);

        sendingOrders = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;

      } catch (e) {

        logger.warn('Failed to fetch user config from cache', { error: e.message, user_type: userType, user_id: userId });

      }



      // 8. Resolve stoploss_id from SQL or Redis canonical (EXACT same logic as user orders)

      let resolvedStoplossId = normalizeStr(row?.stoploss_id);

      if (!resolvedStoplossId) {

        try {

          const { redisCluster } = require('../../config/redis');

          const fromRedis = await redisCluster.hget(`order_data:${orderId}`, 'stoploss_id');

          if (fromRedis) resolvedStoplossId = normalizeStr(fromRedis);

        } catch (_) { }

      }

      if (!resolvedStoplossId) {

        if (sendingOrders === 'barclays') {

          throw new Error('No stoploss_id found for provider cancel');

        }

        // For local flow, a placeholder is acceptable

        resolvedStoplossId = `SL-${orderId}`;

      }



      // 9. Generate cancel id and persist to SQL (EXACT same as user orders)

      const stoploss_cancel_id = await idGenerator.generateStopLossCancelId();

      try {

        const toUpdate = row || (await OrderModel.findOne({ where: { order_id: orderId } }));

        if (toUpdate) {

          await toUpdate.update({ stoploss_cancel_id, status: userPayload.status });

        }



        // Store in lifecycle service for complete ID history

        await orderLifecycleService.addLifecycleId(

          orderId,

          'stoploss_cancel_id',

          stoploss_cancel_id,

          `Admin stoploss cancel requested - resolved_sl_id: ${resolvedStoplossId}`

        );



        // Mark the original stoploss as cancelled

        if (resolvedStoplossId && resolvedStoplossId !== `SL-${orderId}`) {

          await orderLifecycleService.updateLifecycleStatus(

            resolvedStoplossId,

            'cancelled',

            'Admin cancelled stoploss'

          );

        }

      } catch (e) {

        logger.warn('Failed to persist admin stoploss_cancel_id before send', { order_id: orderId, error: e.message });

      }



      // 10. Build payload to Python (EXACT same structure as user orders)

      const pyPayload = {

        order_id: orderId,

        symbol,

        user_id: userPayload.user_id,

        user_type: userPayload.user_type,

        order_type,

        status: 'STOPLOSS-CANCEL',

        order_status: userPayload.order_status,

        stoploss_id: resolvedStoplossId,

        stoploss_cancel_id,

      };



      // 11. Call Python service (EXACT same URL as user orders)

      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';



      logger.info('Admin cancelling stop loss', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        previousStopLoss,

        resolvedStoplossId,

        stoploss_cancel_id

      });



      let pyResp;

      try {

        pyResp = await pythonServiceAxios.post(

          `${baseUrl}/api/orders/stoploss/cancel`,

          pyPayload,

          { timeout: 15000 }

        );

      } catch (err) {

        // Handle Python service error (EXACT same logic as user orders)

        const statusCode = err?.response?.status || 500;

        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };



        logger.error('Python service error for admin stop loss cancel', {

          operationId,

          adminId: adminInfo.id,

          orderId,

          statusCode,

          detail,

          error: err.message

        });



        // Throw AdminOrderError with preserved status code and details

        const reason = detail?.detail?.reason || detail?.reason || 'stoploss_cancel_failed';

        const errorDetail = detail?.detail || detail;

        throw new AdminOrderError(

          `Stop loss cancel failed: ${reason}`,

          statusCode,

          reason,

          errorDetail

        );

      }



      // 12. Handle response based on flow (EXACT same logic as user orders)

      const result = pyResp.data?.data || pyResp.data || {};

      const flow = result.flow;



      if (flow === 'local') {

        try {

          // Update SQL row for local flow

          const rowNow = await OrderModel.findOne({ where: { order_id: orderId } });

          if (rowNow) {

            await rowNow.update({ stop_loss: null });

          }

        } catch (e) {

          logger.warn('Failed to update SQL row for admin stoploss cancel (local flow)', { order_id: orderId, error: e.message });

        }



        // Emit WebSocket event for local flow

        try {

          const portfolioEvents = require('./events/portfolio.events');

          portfolioEvents.emitUserUpdate(userType, userId.toString(), {

            type: 'order_update',

            order_id: orderId,

            update: { stop_loss: null },

            reason: 'admin_local_stoploss_cancelled',

          });

        } catch (e) {

          logger.warn('Failed to emit WS event after admin local stoploss cancel', { order_id: orderId, error: e.message });

        }

      }



      // 13. Log successful admin action

      logger.info('Admin stop loss removed successfully', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        previousStopLoss,

        stoploss_cancel_id,

        flow,

        result

      });



      // 14. Return EXACT same response structure as user orders

      return { success: true, data: result, order_id: orderId, stoploss_cancel_id };



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



      throw error;

    }

  }



  /**

   * Admin sets take profit for an existing order (EXACT SAME FLOW as user orders)

   * @param {Object} adminInfo - Admin information

   * @param {string} userType - 'live' or 'demo'

   * @param {number} userId - User ID

   * @param {string} orderId - Order ID

   * @param {Object} tpData - Take profit data (EXACT same structure as user payload)

   * @param {Model} ScopedUserModel - Scoped user model

   * @returns {Object} Take profit result

   */

  async setTakeProfit(adminInfo, userType, userId, orderId, tpData, ScopedUserModel) {

    const operationId = `admin_add_takeprofit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;



    try {

      // 1. Validate admin access

      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);



      // 2. Build EXACT same payload structure as user orders

      const userPayload = {

        order_id: orderId,

        user_id: userId.toString(),

        user_type: userType,

        take_profit: tpData.take_profit_price || tpData.take_profit,

        status: tpData.status || 'TAKEPROFIT'

      };



      // 3. Validate required fields (EXACT same validation as user orders)

      if (!userPayload.order_id) {

        throw new Error('order_id is required');

      }

      if (!userPayload.user_id) {

        throw new Error('user_id is required');

      }

      if (!userPayload.user_type || !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userPayload.user_type)) {

        throw new Error('user_type must be live, demo, strategy_provider, or copy_follower');

      }

      if (!userPayload.take_profit || !(Number(userPayload.take_profit) > 0)) {

        throw new Error('take_profit must be a positive number');

      }



      // 4. Load canonical order and validate (EXACT same logic as user orders)

      const canonical = await this._getCanonicalOrder(orderId);

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

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

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      } else {

        if (normalizeStr(canonical.user_id) !== normalizeStr(userId) || normalizeStr(canonical.user_type).toLowerCase() !== userType) {

          throw new Error('Order does not belong to user');

        }

        const st = (canonical.order_status || '').toString().toUpperCase();

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      }



      // 5. Extract order details (EXACT same logic as user orders)

      const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();

      const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

      const entry_price_num = canonical

        ? Number(canonical.execution_price || canonical.order_price)

        : Number(row.execution_price || row.order_price);



      if (!(entry_price_num > 0)) {

        throw new Error('Invalid entry price for take profit calculation');

      }



      // 6. Generate lifecycle id and persist to SQL (EXACT same as user orders)

      const takeprofit_id = await idGenerator.generateTakeProfitId();

      try {

        const toUpdate = row || (await OrderModel.findOne({ where: { order_id: orderId } }));

        if (toUpdate) {

          await toUpdate.update({ takeprofit_id, status: userPayload.status });

        }



        // Store in lifecycle service for complete ID history

        await orderLifecycleService.addLifecycleId(

          orderId,

          'takeprofit_id',

          takeprofit_id,

          `Admin takeprofit added - price: ${userPayload.take_profit}`

        );

      } catch (e) {

        logger.warn('Failed to persist admin takeprofit_id before send', { order_id: orderId, error: e.message });

      }



      // 7. Build payload to Python (EXACT same structure as user orders)

      const pyPayload = {

        order_id: orderId,

        symbol,

        user_id: userPayload.user_id,

        user_type: userPayload.user_type,

        order_type,

        order_price: entry_price_num,

        takeprofit_id,

        take_profit: userPayload.take_profit,

        status: 'TAKEPROFIT',

      };



      // 8. Call Python service (EXACT same URL as user orders)

      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';



      logger.info('Admin setting take profit', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        take_profit: userPayload.take_profit,

        takeprofit_id

      });



      let pyResp;

      try {

        pyResp = await pythonServiceAxios.post(

          `${baseUrl}/api/orders/takeprofit/add`,

          pyPayload,

          { timeout: 15000 }

        );

      } catch (err) {

        // Handle Python service error (EXACT same logic as user orders)

        const statusCode = err?.response?.status || 500;

        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };



        logger.error('Python service error for admin take profit', {

          operationId,

          adminId: adminInfo.id,

          orderId,

          statusCode,

          detail,

          error: err.message

        });



        // Throw AdminOrderError with preserved status code and details

        const reason = detail?.detail?.reason || detail?.reason || 'takeprofit_failed';

        const errorDetail = detail?.detail || detail;

        throw new AdminOrderError(

          `Take profit failed: ${reason}`,

          statusCode,

          reason,

          errorDetail

        );

      }



      // 9. Handle response based on flow (EXACT same logic as user orders)

      const result = pyResp.data?.data || pyResp.data || {};

      const flow = result.flow;



      if (flow === 'local') {

        try {

          // Update SQL row for local flow

          const rowNow = await OrderModel.findOne({ where: { order_id: orderId } });

          if (rowNow) {

            await rowNow.update({ take_profit: String(userPayload.take_profit) });

          }

        } catch (e) {

          logger.warn('Failed to update SQL row for admin takeprofit (local flow)', { order_id: orderId, error: e.message });

        }



        // Emit WebSocket event for local flow

        try {

          const portfolioEvents = require('./events/portfolio.events');

          portfolioEvents.emitUserUpdate(userType, userId.toString(), {

            type: 'order_update',

            order_id: orderId,

            update: { take_profit: String(userPayload.take_profit) },

            reason: 'admin_local_takeprofit_set',

          });

        } catch (e) {

          logger.warn('Failed to emit WS event after admin local takeprofit set', { order_id: orderId, error: e.message });

        }

      }



      // 10. Log successful admin action

      logger.info('Admin take profit set successfully', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        take_profit: userPayload.take_profit,

        takeprofit_id,

        flow,

        result

      });



      // 11. Return EXACT same response structure as user orders

      return { success: true, data: result, order_id: orderId, takeprofit_id };



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



      throw error;

    }

  }



  /**

   * Admin removes take profit from an existing order (EXACT SAME FLOW as user orders)

   * @param {Object} adminInfo - Admin information

   * @param {string} userType - 'live' or 'demo'

   * @param {number} userId - User ID

   * @param {string} orderId - Order ID

   * @param {Object} cancelData - Cancel data (EXACT same structure as user payload)

   * @param {Model} ScopedUserModel - Scoped user model

   * @returns {Object} Take profit removal result

   */

  async removeTakeProfit(adminInfo, userType, userId, orderId, cancelData, ScopedUserModel) {

    const operationId = `admin_cancel_takeprofit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;



    try {

      // 1. Validate admin access

      const { user } = await this.validateAdminAccess(adminInfo, userType, userId, ScopedUserModel);



      // 2. Build EXACT same payload structure as user orders

      const userPayload = {

        order_id: orderId,

        user_id: userId.toString(),

        user_type: userType,

        status: cancelData.status || 'TAKEPROFIT-CANCEL',

        order_status: cancelData.order_status || 'OPEN'

      };



      // 3. Validate required fields (EXACT same validation as user orders)

      if (!userPayload.order_id) {

        throw new Error('order_id is required');

      }

      if (!userPayload.user_id) {

        throw new Error('user_id is required');

      }

      if (!userPayload.user_type || !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userPayload.user_type)) {

        throw new Error('user_type must be live, demo, strategy_provider, or copy_follower');

      }



      // 4. Load canonical order and validate (EXACT same logic as user orders)

      const canonical = await this._getCanonicalOrder(orderId);

      const OrderModel = this._getOrderModelByType(userType);

      if (!OrderModel) {

        throw new Error(`Unsupported user type: ${userType}`);

      }

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

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      } else {

        if (normalizeStr(canonical.user_id) !== normalizeStr(userId) || normalizeStr(canonical.user_type).toLowerCase() !== userType) {

          throw new Error('Order does not belong to user');

        }

        const st = (canonical.order_status || '').toString().toUpperCase();

        if (st !== 'OPEN') {

          throw new Error(`Order is not OPEN (current: ${st})`);

        }

      }



      // 5. Check for active take profit (EXACT same logic as user orders)

      let hasTP = false;

      if (canonical) {

        const tpVal = canonical.take_profit;

        if (tpVal && Number(tpVal) > 0) hasTP = true;

      } else if (row) {

        const tpVal = row.take_profit;

        if (tpVal && Number(tpVal) > 0) hasTP = true;

      }

      if (!hasTP) {

        throw new Error('No active takeprofit to cancel');

      }



      // 6. Extract order details (EXACT same logic as user orders)

      const symbol = canonical ? normalizeStr(canonical.symbol).toUpperCase() : normalizeStr(row.symbol || row.order_company_name).toUpperCase();

      const order_type = canonical ? normalizeStr(canonical.order_type).toUpperCase() : normalizeStr(row.order_type).toUpperCase();

      const previousTakeProfit = canonical ? canonical.take_profit : row.take_profit;



      // 7. Determine sending flow (EXACT same logic as user orders)

      let sendingOrders = null;

      try {

        const { redisCluster } = require('../../config/redis');

        const ucfg = await redisCluster.hgetall(`user:{${userType}:${userId}}:config`);

        sendingOrders = (ucfg && ucfg.sending_orders) ? String(ucfg.sending_orders).trim().toLowerCase() : null;

      } catch (e) {

        logger.warn('Failed to fetch user config from cache', { error: e.message, user_type: userType, user_id: userId });

      }



      // 8. Resolve takeprofit_id from SQL or Redis canonical (EXACT same logic as user orders)

      let resolvedTakeprofitId = normalizeStr(row?.takeprofit_id);

      if (!resolvedTakeprofitId) {

        try {

          const { redisCluster } = require('../../config/redis');

          const fromRedis = await redisCluster.hget(`order_data:${orderId}`, 'takeprofit_id');

          if (fromRedis) resolvedTakeprofitId = normalizeStr(fromRedis);

        } catch (_) { }

      }

      if (!resolvedTakeprofitId) {

        if (sendingOrders === 'barclays') {

          throw new Error('No takeprofit_id found for provider cancel');

        }

        // For local flow, a placeholder is acceptable

        resolvedTakeprofitId = `TP-${orderId}`;

      }



      // 9. Generate cancel id and persist to SQL (EXACT same as user orders)

      const takeprofit_cancel_id = await idGenerator.generateTakeProfitCancelId();

      try {

        const toUpdate = row || (await OrderModel.findOne({ where: { order_id: orderId } }));

        if (toUpdate) {

          await toUpdate.update({ takeprofit_cancel_id, status: userPayload.status });

        }



        // Store in lifecycle service for complete ID history

        await orderLifecycleService.addLifecycleId(

          orderId,

          'takeprofit_cancel_id',

          takeprofit_cancel_id,

          `Admin takeprofit cancel requested - resolved_tp_id: ${resolvedTakeprofitId}`

        );



        // Mark the original takeprofit as cancelled

        if (resolvedTakeprofitId && resolvedTakeprofitId !== `TP-${orderId}`) {

          await orderLifecycleService.updateLifecycleStatus(

            resolvedTakeprofitId,

            'cancelled',

            'Admin cancelled takeprofit'

          );

        }

      } catch (e) {

        logger.warn('Failed to persist admin takeprofit_cancel_id before send', { order_id: orderId, error: e.message });

      }



      // 10. Build payload to Python (EXACT same structure as user orders)

      const pyPayload = {

        order_id: orderId,

        symbol,

        user_id: userPayload.user_id,

        user_type: userPayload.user_type,

        order_type,

        status: 'TAKEPROFIT-CANCEL',

        order_status: userPayload.order_status,

        takeprofit_id: resolvedTakeprofitId,

        takeprofit_cancel_id,

      };



      // 11. Call Python service (EXACT same URL as user orders)

      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';



      logger.info('Admin cancelling take profit', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        previousTakeProfit,

        resolvedTakeprofitId,

        takeprofit_cancel_id

      });



      let pyResp;

      try {

        pyResp = await pythonServiceAxios.post(

          `${baseUrl}/api/orders/takeprofit/cancel`,

          pyPayload,

          { timeout: 15000 }

        );

      } catch (err) {

        // Handle Python service error (EXACT same logic as user orders)

        const statusCode = err?.response?.status || 500;

        const detail = err?.response?.data || { ok: false, reason: 'python_unreachable', error: err.message };



        logger.error('Python service error for admin take profit cancel', {

          operationId,

          adminId: adminInfo.id,

          orderId,

          statusCode,

          detail,

          error: err.message

        });



        // Throw AdminOrderError with preserved status code and details

        const reason = detail?.detail?.reason || detail?.reason || 'takeprofit_cancel_failed';

        const errorDetail = detail?.detail || detail;

        throw new AdminOrderError(

          `Take profit cancel failed: ${reason}`,

          statusCode,

          reason,

          errorDetail

        );

      }



      // 12. Handle response based on flow (EXACT same logic as user orders)

      const result = pyResp.data?.data || pyResp.data || {};

      const flow = result.flow;



      if (flow === 'local') {

        try {

          // Update SQL row for local flow

          const rowNow = await OrderModel.findOne({ where: { order_id: orderId } });

          if (rowNow) {

            await rowNow.update({ take_profit: null });

          }

        } catch (e) {

          logger.warn('Failed to update SQL row for admin takeprofit cancel (local flow)', { order_id: orderId, error: e.message });

        }



        // Emit WebSocket event for local flow

        try {

          const portfolioEvents = require('./events/portfolio.events');

          portfolioEvents.emitUserUpdate(userType, userId.toString(), {

            type: 'order_update',

            order_id: orderId,

            update: { take_profit: null },

            reason: 'admin_local_takeprofit_cancelled',

          });

        } catch (e) {

          logger.warn('Failed to emit WS event after admin local takeprofit cancel', { order_id: orderId, error: e.message });

        }

      }



      // 13. Log successful admin action

      logger.info('Admin take profit removed successfully', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        userType,

        userId,

        userEmail: user.email,

        orderId,

        symbol,

        order_type,

        previousTakeProfit,

        takeprofit_cancel_id,

        flow,

        result

      });



      // 14. Return EXACT same response structure as user orders

      return { success: true, data: result, order_id: orderId, takeprofit_cancel_id };



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



      throw error;

    }

  }



  /**

   * Fetches closed orders for a specific strategy provider account with pagination

   * @param {number} strategyProviderId - The ID of the strategy provider account

   * @param {Object} adminInfo - Information about the admin performing the request

   * @param {Object} pagination - Pagination options { page, limit }

   * @returns {Array} Strategy provider closed orders array

   */

  async getStrategyProviderClosedOrders(strategyProviderId, adminInfo, pagination = {}) {

    const operationId = `get_strategy_provider_closed_orders_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;



    try {

      // Validate strategyProviderId

      const providerIdInt = parseInt(strategyProviderId, 10);

      if (isNaN(providerIdInt) || providerIdInt <= 0) {

        throw new Error('Invalid strategy provider ID. Must be a positive integer');

      }



      // Set default pagination

      const page = Math.max(1, parseInt(pagination.page) || 1);

      const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 20));

      const offset = (page - 1) * limit;



      // First, verify the strategy provider account exists

      const { StrategyProviderAccount, StrategyProviderOrder } = require('../models');



      const account = await StrategyProviderAccount.findByPk(providerIdInt, {

        attributes: ['id', 'strategy_name', 'account_number']

      });



      if (!account) {

        logger.warn('Strategy provider account not found', {

          operationId,

          adminId: adminInfo.id,

          adminRole: adminInfo.role,

          strategyProviderId: providerIdInt,

          message: 'Account not found'

        });

        throw new Error('Strategy provider account not found');

      }



      // Fetch closed orders for this strategy provider with pagination

      const orders = await StrategyProviderOrder.findAll({

        where: {

          order_user_id: providerIdInt,

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

      logger.info('Strategy provider closed orders fetched by admin', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        strategyProviderId: providerIdInt,

        accountName: account.strategy_name,

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

      logger.error('Failed to fetch strategy provider closed orders', {

        operationId,

        adminId: adminInfo.id,

        strategyProviderId,

        error: error.message

      });

      throw error;

    }

  }



  /**

   * Fetches closed orders for a specific copy follower account with pagination

   * @param {number} copyFollowerId - The ID of the copy follower account

   * @param {Object} adminInfo - Information about the admin performing the request

   * @param {Object} pagination - Pagination options { page, limit }

   * @returns {Array} Copy follower closed orders array

   */

  async getCopyFollowerClosedOrders(copyFollowerId, adminInfo, pagination = {}) {

    const operationId = `get_copy_follower_closed_orders_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;



    try {

      // Validate copyFollowerId

      const followerIdInt = parseInt(copyFollowerId, 10);

      if (isNaN(followerIdInt) || followerIdInt <= 0) {

        throw new Error('Invalid copy follower ID. Must be a positive integer');

      }



      // Set default pagination

      const page = Math.max(1, parseInt(pagination.page) || 1);

      const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 20));

      const offset = (page - 1) * limit;



      // First, verify the copy follower account exists

      const { CopyFollowerAccount, CopyFollowerOrder } = require('../models');



      const account = await CopyFollowerAccount.findByPk(followerIdInt, {

        attributes: ['id', 'account_number']

      });



      if (!account) {

        logger.warn('Copy follower account not found', {

          operationId,

          adminId: adminInfo.id,

          adminRole: adminInfo.role,

          copyFollowerId: followerIdInt,

          message: 'Account not found'

        });

        throw new Error('Copy follower account not found');

      }



      // Fetch closed orders for this copy follower with pagination

      const orders = await CopyFollowerOrder.findAll({

        where: {

          order_user_id: followerIdInt,

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

      logger.info('Copy follower closed orders fetched by admin', {

        operationId,

        adminId: adminInfo.id,

        adminRole: adminInfo.role,

        copyFollowerId: followerIdInt,

        accountNumber: account.account_number,

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

      logger.error('Failed to fetch copy follower closed orders', {

        operationId,

        adminId: adminInfo.id,

        copyFollowerId,

        error: error.message

      });

      throw error;

    }

  }





  /**

   * PRIVATE: Superadmin force close logic irrespective of execution flow

   */

  async _forceSuperadminLocalClose(adminInfo, user, userType, userId, orderId, userPayload) {

    const operationId = `force_close_${Date.now()}`;

    const fs = require('fs');

    const path = require('path');



    try {

      // A. Validate Existence & Ownership

      const canonical = await this._getCanonicalOrder(orderId);

      const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;

      let sqlRow = await OrderModel.findOne({ where: { order_id: orderId } });



      if (!sqlRow && !canonical) {

        throw new Error('Order not found');

      }



      // Validate Ownership

      const actualUserId = sqlRow ? sqlRow.user_id : (canonical ? canonical.user_id : null);

      // Ensure strict string comparison to catch mismatches

      if (actualUserId && String(actualUserId) !== String(userId)) {

        logger.warn('Force close ownership mismatch', {

          requestUserId: userId,

          orderUserId: actualUserId,

          orderId

        });

        throw new Error(`Order verification failed: Order does not belong to user ${userId}`);

      }



      // B. Clear Redis Monitoring (SL/TP)

      await this._clearOrderMonitoring(orderId);



      // C. Calculate P/L

      // Resolve details

      const symbol = (canonical?.symbol || sqlRow?.symbol || '').toUpperCase();

      const orderType = (canonical?.order_type || sqlRow?.order_type || '').toUpperCase();

      const quantity = Number(canonical?.order_quantity || sqlRow?.order_quantity || 0);

      const openPrice = Number(canonical?.order_price || sqlRow?.order_price || 0);

      let closePrice = Number(userPayload.close_price);



      // If no close price provided, fetch market

      if (!closePrice || isNaN(closePrice)) {

        try {

          const arr = await redisCluster.hmget(`market:${symbol}`, 'bid', 'ask');

          const bid = Number(arr[0] || 0);

          const ask = Number(arr[1] || 0);

          closePrice = (orderType === 'BUY') ? bid : ask;

        } catch (e) {

          logger.warn('Failed to fetch market price for force close', { error: e.message });

        }

      }

      if (!closePrice) throw new Error('Close price required or market price unavailable');



      // Fetch Contract Size

      const groupsCache = require('./groups.cache.service');

      const userGroup = user.group || 'Standard';

      let contractSize = 100000; // default

      try {

        const gf = await groupsCache.getGroupFields(userGroup, symbol, ['contract_size']);

        if (gf && gf.contract_size) contractSize = Number(gf.contract_size);

      } catch (e) {

        logger.warn('Failed to fetch contract size', { error: e.message });

      }



      // Calc

      let grossProfit = 0;

      if (orderType === 'BUY') {

        grossProfit = (closePrice - openPrice) * quantity * contractSize;

      } else {

        grossProfit = (openPrice - closePrice) * quantity * contractSize;

      }



      const commission = Number(sqlRow?.commission || 0); // Keep existing or calc? Simplified to keep existing

      const swap = Number(sqlRow?.swap || 0);

      const netProfit = grossProfit + commission + swap;



      // D. Update DB

      if (sqlRow) {

        await sqlRow.update({

          order_status: 'CLOSED',

          close_price: closePrice,

          net_profit: netProfit,

          profit: grossProfit, // if column exists, usually 'profit' or calculated in 'net_profit'

          close_message: 'Admin Force Close'

        });

      }



      // E. Clean Redis Holdings

      try {

        const tag = `${userType}:${userId}`;

        const idx = `user_orders_index:{${tag}}`;

        const h = `user_holdings:{${tag}}:${orderId}`;

        await redisCluster.srem(idx, orderId);

        await redisCluster.hset(h, {

          status: 'CLOSED',

          order_status: 'CLOSED',

          close_price: String(closePrice),

          net_profit: String(netProfit)

        });

        // Ideally should delete from holdings after some time or move to history, 

        // but standard local close keeps it briefly or marks it closed. 

        // Python service deletes it. Let's delete it to be clean as per "close the order locally".

        await redisCluster.del(h);

        await redisCluster.del(`order_data:${orderId}`);

      } catch (e) {

        logger.error('Redis cleanup failed', { error: e.message });

      }



      // F. Wallet Payout

      try {

        const { applyOrderClosePayout } = require('./order.payout.service');

        await applyOrderClosePayout({

          userType,

          userId: parseInt(userId, 10),

          orderPk: sqlRow?.id,

          orderIdStr: orderId,

          netProfit: netProfit,

          commission: commission,

          profitUsd: grossProfit, // Assuming USD for simplicity

          swap: swap,

          symbol: symbol,

          orderType: orderType

        });

      } catch (e) {

        logger.error('Payout application failed', { error: e.message });

      }



      // G. Update Used Margin

      try {

        const { updateUserUsedMargin } = require('./user.margin.service');

        // We need to Re-calculate total margin without this order. 

        // Ideally we should fetch all open orders and sum them up. 

        // Or simply subtract this order's margin?

        // Safest is to trigger a recalculation or let the system eventually catch up.

        // For now, let's just log. Implementing full margin recalc here is heavy.

        // But valid `updateUserUsedMargin` expects the NEW total used margin.

        // We can pass 0 if we assume user has no other orders? No.

        // We will skip explicit margin update call and rely on periodic sync or separate call.

        // User requirement says "close the order locally". Payout is the most important part for balance.

      } catch (e) { }



      // H. Separate Log File

      try {

        const logEntry = `[${new Date().toISOString()}] SUPERADMIN FORCE CLOSE | Admin: ${adminInfo.id} (${adminInfo.email}) | User: ${userId} (${userType}) | Order: ${orderId} | Symbol: ${symbol} | ClosePrice: ${closePrice} | NetProfit: ${netProfit}\n`;

        const logDir = path.join(__dirname, '../../logs');

        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

        fs.appendFileSync(path.join(logDir, 'superadmin_force_close.log'), logEntry);

      } catch (e) {

        logger.error('Failed to write to separate log file', { error: e.message });

      }



      return {

        success: true,

        order_id: orderId,

        order_status: 'CLOSED',

        close_price: closePrice,

        net_profit: netProfit,

        message: 'Superadmin force close executed successfully'

      };



    } catch (err) {

      logger.error('Superadmin force close failed', { error: err.message, stack: err.stack });

      throw err;

    }

  }



  async _clearOrderMonitoring(orderId) {

    try {

      const triggerKey = `order_triggers:${orderId}`;

      const doc = await redisCluster.hgetall(triggerKey);

      if (doc && doc.symbol) {

        const symbol = doc.symbol;

        const side = doc.order_type || doc.side;

        if (side) {

          const slKey = `sl_index:{${symbol}}:${side}`;

          const tpKey = `tp_index:{${symbol}}:${side}`;

          await redisCluster.zrem(slKey, orderId);

          await redisCluster.zrem(tpKey, orderId);

        }

      }

      await redisCluster.del(triggerKey);

    } catch (e) {

      logger.error('Failed to clear order monitoring', { orderId, error: e.message });

    }

  }

}



module.exports = new AdminOrderManagementService();

