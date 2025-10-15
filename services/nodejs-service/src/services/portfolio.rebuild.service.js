const axios = require('axios');
const { redisCluster } = require('../../config/redis');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const logger = require('./logger.service');
const { updateUserUsedMargin } = require('./user.margin.service');

/**
 * Portfolio Rebuild Service
 * Recalculates user balance, margin, equity and all portfolio metrics from database orders
 */
class PortfolioRebuildService {
  constructor() {
    this.pythonServiceUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
  }

  /**
   * Rebuild complete user portfolio from database orders
   * @param {string} userType - 'live' or 'demo'
   * @param {string|number} userId - User ID
   * @param {Object} options - Rebuild options
   * @param {string} authToken - Authorization token for Python service
   * @returns {Promise<Object>} Rebuild result
   */
  async rebuildUserPortfolio(userType, userId, options = {}, authToken = null) {
    const {
      recalculateMargin = true,
      updateRedisPortfolio = true,
      updateSqlMargin = true,
      forceRefresh = false
    } = options;

    logger.info('Starting portfolio rebuild', { userType, userId, options });

    try {
      // Step 1: Fetch user data from database
      const userData = await this._fetchUserData(userType, userId);
      if (!userData) {
        throw new Error(`User not found: ${userType}:${userId}`);
      }

      // Step 2: Fetch all orders from database
      const orders = await this._fetchUserOrders(userType, userId);

      // Step 3: Calculate portfolio metrics
      const portfolioMetrics = await this._calculatePortfolioMetrics(
        userType, 
        userId, 
        userData, 
        orders,
        { recalculateMargin, forceRefresh, authToken }
      );

      // Step 4: Update Redis portfolio cache
      if (updateRedisPortfolio) {
        await this._updateRedisPortfolio(userType, userId, portfolioMetrics);
      }

      // Step 5: Update SQL margin if changed
      if (updateSqlMargin && portfolioMetrics.used_margin !== userData.margin) {
        await updateUserUsedMargin({
          userType,
          userId: parseInt(userId),
          usedMargin: portfolioMetrics.used_margin
        });
      }

      // Step 6: Trigger Python portfolio recalculation if needed
      if (recalculateMargin) {
        await this._triggerPythonPortfolioUpdate(userType, userId);
      }

      const result = {
        user_type: userType,
        user_id: userId,
        before: {
          balance: userData.wallet_balance,
          margin: userData.margin,
          orders_count: orders.length
        },
        after: portfolioMetrics,
        updated: {
          redis_portfolio: updateRedisPortfolio,
          sql_margin: updateSqlMargin && portfolioMetrics.used_margin !== userData.margin,
          python_triggered: recalculateMargin
        }
      };

      logger.info('Portfolio rebuild completed', result);
      return result;

    } catch (error) {
      logger.error('Portfolio rebuild failed', { 
        error: error.message, 
        userType, 
        userId, 
        options 
      });
      throw error;
    }
  }

  /**
   * Fetch user data from database
   */
  async _fetchUserData(userType, userId) {
    const Model = userType === 'live' ? LiveUser : DemoUser;
    const user = await Model.findByPk(parseInt(userId));
    
    if (!user) return null;

    return {
      id: user.id,
      wallet_balance: parseFloat(user.wallet_balance || 0),
      margin: parseFloat(user.margin || 0),
      group: user.group,
      leverage: user.leverage,
      status: user.status
    };
  }

  /**
   * Fetch all user orders from database
   */
  async _fetchUserOrders(userType, userId) {
    const OrderModel = userType === 'live' ? LiveUserOrder : DemoUserOrder;
    const orders = await OrderModel.findAll({
      where: { order_user_id: parseInt(userId) },
      order: [['created_at', 'ASC']]
    });

    return orders.map(order => ({
      order_id: order.order_id,
      symbol: order.symbol,
      order_type: order.order_type,
      order_status: order.order_status,
      order_price: parseFloat(order.order_price || 0),
      order_quantity: parseFloat(order.order_quantity || 0),
      margin: parseFloat(order.margin || 0),
      contract_value: parseFloat(order.contract_value || 0),
      commission: parseFloat(order.commission || 0),
      swap: parseFloat(order.swap || 0),
      net_profit: parseFloat(order.net_profit || 0),
      stop_loss: order.stop_loss ? parseFloat(order.stop_loss) : null,
      take_profit: order.take_profit ? parseFloat(order.take_profit) : null,
      created_at: order.created_at,
      updated_at: order.updated_at
    }));
  }

  /**
   * Calculate portfolio metrics from orders
   */
  async _calculatePortfolioMetrics(userType, userId, userData, orders, options) {
    const { recalculateMargin, forceRefresh, authToken } = options;

    // Separate orders by status
    const openOrders = orders.filter(o => o.order_status === 'OPEN');
    const pendingOrders = orders.filter(o => o.order_status === 'PENDING');
    const closedOrders = orders.filter(o => o.order_status === 'CLOSED');

    // Calculate basic metrics
    let usedMargin = 0;
    let openPnL = 0;
    let openCommission = 0;
    let openSwap = 0;
    let historicalPnL = 0;
    let historicalCommission = 0;
    let historicalSwap = 0;

    // Get real-time P&L and swap from Redis for OPEN orders
    const realTimeData = await this._getRealTimeDataFromRedis(userType, userId, openOrders);

    // Calculate from OPEN orders (use real-time data from Redis)
    for (const order of openOrders) {
      usedMargin += order.margin;
      // Use real-time P&L from Redis instead of database net_profit (which is 0 for OPEN orders)
      const realTimeOrderPnL = realTimeData.pnl[order.order_id] || 0;
      const realTimeOrderSwap = realTimeData.swap[order.order_id] || order.swap;
      openPnL += realTimeOrderPnL;
      openCommission += order.commission;
      openSwap += realTimeOrderSwap;
    }

    // Add pending orders margin
    for (const order of pendingOrders) {
      usedMargin += order.margin;
    }

    // Calculate from CLOSED orders (historical performance)
    for (const order of closedOrders) {
      historicalPnL += order.net_profit;
      historicalCommission += order.commission;
      historicalSwap += order.swap;
    }

    // If recalculate margin is requested, call Python service for precise calculation
    if (recalculateMargin) {
      try {
        const preciseMargin = await this._getPreciseMarginFromPython(userType, userId, forceRefresh, authToken);
        if (preciseMargin !== null) {
          usedMargin = preciseMargin;
        }
      } catch (error) {
        logger.warn('Failed to get precise margin from Python, using calculated value', {
          error: error.message,
          userType,
          userId,
          calculatedMargin: usedMargin
        });
      }
    }

    // Calculate derived metrics
    const balance = userData.wallet_balance;
    const equity = balance + openPnL;
    const freeMargin = Math.max(0, balance - usedMargin);
    const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : 999999;

    return {
      balance: parseFloat(balance.toFixed(2)),
      used_margin: parseFloat(usedMargin.toFixed(2)),
      free_margin: parseFloat(freeMargin.toFixed(2)),
      equity: parseFloat(equity.toFixed(2)),
      margin_level: parseFloat(marginLevel.toFixed(2)),
      // Current portfolio metrics (OPEN orders only)
      open_pnl: parseFloat(openPnL.toFixed(2)),
      open_commission: parseFloat(openCommission.toFixed(2)),
      open_swap: parseFloat(openSwap.toFixed(2)),
      // Historical performance metrics (CLOSED orders)
      historical_pnl: parseFloat(historicalPnL.toFixed(2)),
      historical_commission: parseFloat(historicalCommission.toFixed(2)),
      historical_swap: parseFloat(historicalSwap.toFixed(2)),
      // Legacy fields for backward compatibility
      total_pnl: parseFloat((openPnL + historicalPnL).toFixed(2)),
      total_commission: parseFloat((openCommission + historicalCommission).toFixed(2)),
      total_swap: parseFloat((openSwap + historicalSwap).toFixed(2)),
      // Order counts
      open_orders_count: openOrders.length,
      pending_orders_count: pendingOrders.length,
      closed_orders_count: closedOrders.length,
      last_calculated: new Date().toISOString(),
      calculation_source: recalculateMargin ? 'python_service_with_redis_data' : 'database_with_redis_data',
      redis_pnl_orders: Object.keys(realTimeData.pnl).length,
      redis_swap_orders: Object.keys(realTimeData.swap).length
    };
  }

  /**
   * Get precise margin calculation from Python service
   */
  async _getPreciseMarginFromPython(userType, userId, forceRefresh = false, authToken = null) {
    try {
      const headers = {};
      if (authToken) {
        headers.Authorization = authToken;
      }

      const response = await axios.get(
        `${this.pythonServiceUrl}/api/admin/orders/margin-status/${userType}/${userId}`,
        {
          timeout: 10000,
          params: { force_refresh: forceRefresh },
          headers
        }
      );

      const data = response.data?.data;
      if (data && typeof data.used_margin_all === 'number') {
        return data.used_margin_all;
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to fetch precise margin from Python', {
        error: error.message,
        userType,
        userId
      });
      return null;
    }
  }

  /**
   * Update Redis portfolio cache
   */
  async _updateRedisPortfolio(userType, userId, metrics) {
    const portfolioKey = `user_portfolio:{${userType}:${userId}}`;
    
    const portfolioData = {
      balance: metrics.balance.toString(),
      used_margin: metrics.used_margin.toString(),
      used_margin_executed: metrics.used_margin.toString(), // Same for now
      used_margin_all: metrics.used_margin.toString(),
      free_margin: metrics.free_margin.toString(),
      equity: metrics.equity.toString(),
      margin_level: metrics.margin_level.toString(),
      open_pnl: metrics.open_pnl.toString(),
      total_pl: metrics.total_pnl.toString(),
      ts: Math.floor(Date.now() / 1000).toString(),
      last_update_source: 'portfolio_rebuild_service'
    };

    await redisCluster.hset(portfolioKey, portfolioData);
    
    logger.info('Redis portfolio updated', { 
      userType, 
      userId, 
      portfolioKey,
      metrics: Object.keys(portfolioData).length 
    });
  }

  /**
   * Get real-time P&L from Redis user_portfolio (where portfolio calculator stores it)
   */
  async _getRealTimeDataFromRedis(userType, userId, openOrders) {
    const realTimeData = {
      pnl: {},
      swap: {}
    };
    
    if (openOrders.length === 0) {
      return realTimeData;
    }

    try {
      // Get portfolio data from Redis (where portfolio calculator stores real-time P&L)
      const portfolioKey = `user_portfolio:{${userType}:${userId}}`;
      const portfolioData = await redisCluster.hgetall(portfolioKey);
      
      if (portfolioData && portfolioData.open_pnl !== undefined) {
        const totalOpenPnL = parseFloat(portfolioData.open_pnl) || 0;
        
        // Distribute the total P&L across open orders proportionally by margin
        // This is an approximation since portfolio calculator stores total P&L, not per-order P&L
        const totalMargin = openOrders.reduce((sum, order) => sum + order.margin, 0);
        
        if (totalMargin > 0) {
          for (const order of openOrders) {
            const orderPnLProportion = (order.margin / totalMargin) * totalOpenPnL;
            realTimeData.pnl[order.order_id] = orderPnLProportion;
            // For swap, use database value as portfolio calculator doesn't separate it
            realTimeData.swap[order.order_id] = order.swap;
          }
        } else {
          // If no margin, distribute equally
          const pnlPerOrder = totalOpenPnL / openOrders.length;
          for (const order of openOrders) {
            realTimeData.pnl[order.order_id] = pnlPerOrder;
            realTimeData.swap[order.order_id] = order.swap;
          }
        }
        
        logger.info('Retrieved real-time P&L from user_portfolio', {
          userType,
          userId,
          portfolioKey,
          totalOpenPnL,
          orderCount: openOrders.length,
          totalMargin,
          portfolioData: {
            open_pnl: portfolioData.open_pnl,
            equity: portfolioData.equity,
            margin_level: portfolioData.margin_level
          }
        });
        
      } else {
        // Fallback to database values if portfolio data not available
        logger.warn('No portfolio data found in Redis, using database values', {
          userType,
          userId,
          portfolioKey,
          portfolioDataExists: !!portfolioData,
          hasOpenPnL: portfolioData ? portfolioData.hasOwnProperty('open_pnl') : false
        });
        
        for (const order of openOrders) {
          realTimeData.pnl[order.order_id] = order.net_profit;
          realTimeData.swap[order.order_id] = order.swap;
        }
      }
      
    } catch (error) {
      logger.error('Failed to fetch real-time data from user_portfolio', {
        error: error.message,
        userType,
        userId,
        orderCount: openOrders.length
      });
      
      // Fallback to database values
      for (const order of openOrders) {
        realTimeData.pnl[order.order_id] = order.net_profit;
        realTimeData.swap[order.order_id] = order.swap;
      }
    }
    
    return realTimeData;
  }

  /**
   * Trigger Python portfolio calculation update
   */
  async _triggerPythonPortfolioUpdate(userType, userId) {
    try {
      // Add user to dirty users for immediate recalculation
      await redisCluster.sadd(`portfolio_dirty_users:${userType}`, `${userType}:${userId}`);
      
      logger.info('Added user to Python portfolio dirty queue', { userType, userId });
    } catch (error) {
      logger.warn('Failed to trigger Python portfolio update', {
        error: error.message,
        userType,
        userId
      });
    }
  }

  /**
   * Rebuild multiple users' portfolios in batch
   */
  async rebuildMultipleUsers(requests, options = {}, authToken = null) {
    const results = [];
    const errors = [];

    for (const request of requests) {
      try {
        const result = await this.rebuildUserPortfolio(
          request.user_type,
          request.user_id,
          { ...options, ...request.options },
          authToken
        );
        results.push(result);
      } catch (error) {
        errors.push({
          user_type: request.user_type,
          user_id: request.user_id,
          error: error.message
        });
      }
    }

    return {
      success_count: results.length,
      error_count: errors.length,
      results,
      errors
    };
  }
}

module.exports = new PortfolioRebuildService();
