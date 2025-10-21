const cron = require('node-cron');
const { Op } = require('sequelize');
const LiveUserOrder = require('../models/liveUserOrder.model');
const DemoUserOrder = require('../models/demoUserOrder.model');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const swapCalculationService = require('./swap.calculation.service');
const logger = require('../utils/logger');
const sequelize = require('../config/db');
const portfolioEvents = require('./events/portfolio.events');
const { redisCluster } = require('../../config/redis');
const { 
  logSwapApplication, 
  logDailyProcessingSummary,
  logSwapError,
  logManualSwapProcessing
} = require('../utils/swap.logger');

// Import winston logger for swap-specific debug logs
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create dedicated debug logger that writes to swap.log
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const swapDebugLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'swap-service' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'swap.log'),
      maxsize: 100 * 1024 * 1024, // 100MB
      maxFiles: 10,
      tailable: true
    })
  ]
});

class SwapSchedulerService {
  constructor() {
    this.isRunning = false;
    this.cronJob = null;
  }

  /**
   * Start the swap scheduler
   * Runs daily at 00:01 UTC
   */
  start() {
    if (this.cronJob) {
      logger.warn('Swap scheduler is already running');
      return;
    }

    // Schedule to run daily at 00:01 UTC
    this.cronJob = cron.schedule('7 8 * * *', async () => {
      await this.processDaily();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    logger.info('Swap scheduler started - will run daily at 00:01 UTC');
  }

  /**
   * Stop the swap scheduler
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.destroy();
      this.cronJob = null;
      logger.info('Swap scheduler stopped');
    }
  }

  /**
   * Process daily swap charges
   */
  async processDaily(targetDate = new Date()) {
    if (this.isRunning) {
      logger.warn('Swap processing is already running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    let totalSwapAmount = 0;
    
    try {
      logger.info(`Starting daily swap processing for ${targetDate.toDateString()}`);

      // Process live orders
      const liveResults = await this.processOrdersSwap(LiveUserOrder, 'live', targetDate);
      
      // Process demo orders  
      const demoResults = await this.processOrdersSwap(DemoUserOrder, 'demo', targetDate);

      const totalProcessed = liveResults.processed + demoResults.processed;
      const totalUpdated = liveResults.updated + demoResults.updated;
      const totalErrors = liveResults.errors + demoResults.errors;
      const totalSkipped = liveResults.skipped + demoResults.skipped;
      totalSwapAmount = liveResults.totalSwapAmount + demoResults.totalSwapAmount;
      const processingTime = Date.now() - startTime;

      // Log comprehensive daily summary
      logDailyProcessingSummary({
        processing_date: targetDate.toISOString(),
        total_orders_processed: totalProcessed,
        live_orders: {
          processed: liveResults.processed,
          updated: liveResults.updated,
          errors: liveResults.errors,
          skipped: liveResults.skipped,
          swap_amount: liveResults.totalSwapAmount
        },
        demo_orders: {
          processed: demoResults.processed,
          updated: demoResults.updated,
          errors: demoResults.errors,
          skipped: demoResults.skipped,
          swap_amount: demoResults.totalSwapAmount
        },
        total_swap_amount: totalSwapAmount,
        successful_updates: totalUpdated,
        failed_updates: totalErrors,
        skipped_orders: totalSkipped,
        processing_time_ms: processingTime,
        errors: totalErrors > 0 ? 'Check error logs for details' : null
      });

      logger.info(`Daily swap processing completed:`, {
        date: targetDate.toDateString(),
        totalProcessed,
        totalUpdated,
        totalErrors,
        totalSkipped,
        totalSwapAmount,
        liveOrders: liveResults,
        demoOrders: demoResults,
        processingTimeMs: processingTime
      });

    } catch (error) {
      logSwapError(error, {
        operation: 'processDaily',
        target_date: targetDate.toISOString()
      });
      logger.error('Error in daily swap processing:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process swap charges for a specific order type (live/demo)
   */
  async processOrdersSwap(OrderModel, orderType, targetDate) {
    const results = {
      processed: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
      totalSwapAmount: 0
    };

    try {
      logger.info(`Processing ${orderType} orders for swap charges`);

      // Get all open orders
      const openOrders = await this.getOpenOrders(OrderModel);
      results.processed = openOrders.length;

      if (openOrders.length === 0) {
        logger.info(`No open ${orderType} orders found`);
        return results;
      }

      logger.info(`Found ${openOrders.length} open ${orderType} orders`);

      // Process orders in batches to avoid memory issues
      const batchSize = 100;
      for (let i = 0; i < openOrders.length; i += batchSize) {
        const batch = openOrders.slice(i, i + batchSize);
        const batchResults = await this.processBatch(OrderModel, batch, targetDate, orderType);
        
        results.updated += batchResults.updated;
        results.errors += batchResults.errors;
        results.skipped += batchResults.skipped;
      }

    } catch (error) {
      swapDebugLogger.error(`[DEBUG] Error processing ${orderType} orders:`, error);
      results.errors++;
    }

    if (results.updated > 0 || results.errors > 0) {
      swapDebugLogger.info(`[DEBUG] ${orderType} results: ${results.updated} updated, ${results.skipped} skipped, ${results.errors} errors`);
    }
    return results;
  }

  /**
   * Get all open orders with user group information
   * NOTE: Orders are ALWAYS fetched from DATABASE (MySQL/PostgreSQL) using Sequelize ORM
   * This ensures we get the most up-to-date order information, not cached Redis data
   */
  async getOpenOrders(OrderModel) {
    const isLiveOrder = OrderModel.name === 'LiveUserOrder';
    const UserModel = isLiveOrder ? LiveUser : DemoUser;
    const orderType = isLiveOrder ? 'live' : 'demo';
    
    // Get order status distribution for monitoring
    const statusCounts = await OrderModel.findAll({
      attributes: [
        'order_status',
        [sequelize.fn('COUNT', sequelize.col('id')), 'count']
      ],
      group: ['order_status'],
      raw: true
    });
    
    // IMPORTANT: This query fetches orders directly from DATABASE, not Redis cache
    const orders = await OrderModel.findAll({
      where: {
        order_status: {
          [Op.in]: ['OPEN', 'PENDING', 'PARTIAL_FILLED'] // Add other open statuses as needed
        }
      },
      attributes: [
        'id', 'order_id', 'symbol', 'order_type', 'order_quantity', 'order_price',
        'swap', 'order_user_id', 'created_at', 'updated_at', 'order_status',
        'contract_value', 'margin', 'commission', 'stop_loss', 'take_profit'
      ],
      include: [{
        model: UserModel,
        as: 'user',
        attributes: ['group'],
        required: true // Inner join to ensure we only get orders with valid users
      }]
    });
    
    if (orders.length > 0) {
      swapDebugLogger.info(`[DEBUG] Processing ${orders.length} open ${orderType} orders`);
    } else {
      swapDebugLogger.info(`[DEBUG] No open ${orderType} orders found`);
    }
    
    return orders;
  }

  /**
   * Process a batch of orders
   */
  async processBatch(OrderModel, orders, targetDate, orderType) {
    const results = {
      updated: 0,
      errors: 0,
      skipped: 0,
      totalSwapAmount: 0
    };

    const transaction = await sequelize.transaction();
    const redisUpdates = []; // Store Redis updates to perform after DB transaction

    try {
      for (const order of orders) {
        try {
          // Get group from user association
          const userGroup = order.user?.group;
          if (!userGroup) {
            swapDebugLogger.warn(`[DEBUG] Skipping order ${order.order_id} - missing user group`);
            results.skipped++;
            continue;
          }

          // Add group_name and user_type to order for swap calculation
          order.group_name = userGroup;
          order.user_type = orderType;

          // Calculate swap charge
          const swapCharge = await swapCalculationService.calculateSwapCharge(order, targetDate);

          if (swapCharge === 0) {
            results.skipped++;
            continue;
          }

          // Update order with new swap charge
          const currentSwap = parseFloat(order.swap || 0);
          const newSwap = currentSwap + swapCharge;

          await OrderModel.update(
            { swap: newSwap },
            { 
              where: { id: order.id },
              transaction
            }
          );

          // Store Redis update data for after transaction commit
          redisUpdates.push({
            orderType,
            order_user_id: order.order_user_id,
            order_id: order.order_id,
            symbol: order.symbol,
            order_type: order.order_type,
            order_price: order.order_price,
            order_quantity: order.order_quantity,
            contract_value: order.contract_value,
            margin: order.margin,
            commission: order.commission,
            order_status: order.order_status,
            stop_loss: order.stop_loss,
            take_profit: order.take_profit,
            created_at: order.created_at,
            updated_at: order.updated_at,
            newSwap,
            swapCharge,
            currentSwap
          });

          // Note: We don't create UserTransaction records here
          // Swap transactions are only created when the order is closed
          // via the order.payout.service.js which handles the final swap amount

          // Log swap application
          logSwapApplication({
            order_id: order.order_id,
            user_id: order.order_user_id,
            user_type: orderType,
            swap_amount: swapCharge,
            previous_swap: currentSwap,
            new_swap: newSwap,
            transaction_id: null, // No transaction created during daily processing
            application_date: targetDate.toISOString(),
            success: true
          });

          results.totalSwapAmount += swapCharge;
          logger.debug(`Updated ${orderType} order ${order.order_id}: swap ${currentSwap} + ${swapCharge} = ${newSwap}`);
          results.updated++;

        } catch (error) {
          logSwapError(error, {
            order_id: order.order_id,
            user_id: order.order_user_id,
            symbol: order.symbol,
            group_name: order.group_name,
            operation: 'processBatch'
          });
          logger.error(`Error processing ${orderType} order ${order.order_id}:`, error);
          results.errors++;
        }
      }

      await transaction.commit();
      
      // After successful DB transaction, update Redis cache
      for (const update of redisUpdates) {
        try {
          const userTypeStr = update.orderType;
          const userIdStr = String(update.order_user_id);
          const hashTag = `${userTypeStr}:${userIdStr}`;
          const orderKey = `user_holdings:{${hashTag}}:${update.order_id}`;
          const orderDataKey = `order_data:${update.order_id}`;
          
          // Create complete Redis hash mapping like the rebuild process does
          const holdingMapping = {
            order_id: update.order_id,
            symbol: update.symbol || '',
            order_type: update.order_type || '',
            order_price: update.order_price?.toString() || '',
            order_quantity: update.order_quantity?.toString() || '',
            order_status: update.order_status || 'OPEN',
            swap: String(update.newSwap)
          };
          
          // Add optional fields if they exist (same as rebuild process)
          if (update.contract_value != null) holdingMapping.contract_value = String(update.contract_value);
          if (update.margin != null) holdingMapping.margin = String(update.margin);
          if (update.commission != null) holdingMapping.commission = String(update.commission);
          if (update.stop_loss != null) holdingMapping.stop_loss = String(update.stop_loss);
          if (update.take_profit != null) holdingMapping.take_profit = String(update.take_profit);
          if (update.created_at) holdingMapping.created_at = update.created_at;
          if (update.updated_at) holdingMapping.updated_at = update.updated_at;
          
          // Update user_holdings key with complete mapping (like rebuild process)
          await redisCluster.hset(orderKey, holdingMapping);
          
          // Update order_data key with swap value
          await redisCluster.hset(orderDataKey, 'swap', String(update.newSwap));
          
          // Notify WebSocket clients about the swap update
          try {
            portfolioEvents.emitUserUpdate(update.orderType, update.order_user_id, {
              type: 'swap_update',
              order_id: update.order_id,
              symbol: update.symbol || 'unknown',
              swap_amount: update.swapCharge,
              new_total_swap: update.newSwap,
              timestamp: new Date().toISOString()
            });
          } catch (wsError) {
            logger.warn(`Failed to emit WebSocket update for order ${update.order_id}:`, wsError);
          }
          
        } catch (redisError) {
          swapDebugLogger.error(`[DEBUG] Redis update failed for order ${update.order_id}: ${redisError.message}`);
          // Continue processing other Redis updates even if one fails
        }
      }
      
    } catch (error) {
      await transaction.rollback();
      logSwapError(error, {
        operation: 'processBatch',
        order_type: orderType,
        batch_size: orders.length
      });
      logger.error(`Error in batch processing ${orderType} orders:`, error);
      results.errors += orders.length;
    }

    return results;
  }

  /**
   * Manual trigger for swap processing (for testing or manual runs)
   */
  async triggerManual(targetDate = new Date(), adminId = null, reason = 'Manual trigger') {
    const startTime = Date.now();
    logger.info(`Manual trigger for swap processing on ${targetDate.toDateString()}`);
    
    const results = await this.processDaily(targetDate);
    const processingTime = Date.now() - startTime;
    
    // Log manual processing
    logManualSwapProcessing({
      admin_id: adminId,
      target_date: targetDate.toISOString(),
      orders_processed: results?.totalProcessed || 0,
      total_swap_applied: results?.totalSwapAmount || 0,
      processing_time_ms: processingTime,
      trigger_reason: reason
    });
    
    return results;
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isScheduled: !!this.cronJob,
      isRunning: this.isRunning,
      nextRun: this.cronJob ? this.cronJob.nextDate() : null
    };
  }

  /**
   * Process swap for a specific order (for testing)
   */
  async processSpecificOrder(orderType, orderId, targetDate = new Date()) {
    try {
      const OrderModel = orderType === 'live' ? LiveUserOrder : DemoUserOrder;
      const UserModel = orderType === 'live' ? LiveUser : DemoUser;
      
      const order = await OrderModel.findOne({
        where: { order_id: orderId },
        attributes: [
          'id', 'order_id', 'symbol', 'order_type', 'order_quantity', 
          'swap', 'order_user_id', 'created_at'
        ],
        include: [{
          model: UserModel,
          as: 'user',
          attributes: ['group'],
          required: true
        }]
      });

      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      // Get group from user association
      const userGroup = order.user?.group;
      if (!userGroup) {
        throw new Error(`User group not found for order ${orderId}`);
      }

      // Add group_name and user_type to order for swap calculation
      order.group_name = userGroup;
      order.user_type = orderType;

      const swapCharge = await swapCalculationService.calculateSwapCharge(order, targetDate);
      
      if (swapCharge !== 0) {
        const currentSwap = parseFloat(order.swap || 0);
        const newSwap = currentSwap + swapCharge;

        await OrderModel.update(
          { swap: newSwap },
          { where: { id: order.id } }
        );

        logger.info(`Updated order ${orderId}: swap ${currentSwap} + ${swapCharge} = ${newSwap}`);
      }

      return {
        order_id: orderId,
        group_name: userGroup,
        current_swap: parseFloat(order.swap || 0),
        calculated_swap: swapCharge,
        new_swap: parseFloat(order.swap || 0) + swapCharge
      };

    } catch (error) {
      logger.error(`Error processing specific order ${orderId}:`, error);
      throw error;
    }
  }
}

module.exports = new SwapSchedulerService();
