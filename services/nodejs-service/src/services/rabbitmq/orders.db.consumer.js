const amqp = require('amqplib');
const { Op } = require('sequelize');
const logger = require('../logger.service');
const LiveUserOrder = require('../../models/liveUserOrder.model');
const MAMOrder = require('../../models/mamOrder.model');
const DemoUserOrder = require('../../models/demoUserOrder.model');
const StrategyProviderOrder = require('../../models/strategyProviderOrder.model');
const CopyFollowerOrder = require('../../models/copyFollowerOrder.model');
const LiveUser = require('../../models/liveUser.model');
const DemoUser = require('../../models/demoUser.model');
const StrategyProviderAccount = require('../../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../../models/copyFollowerAccount.model');
const OrderRejection = require('../../models/orderRejection.model');
const OrderLifecycleId = require('../../models/orderLifecycleId.model');
const { updateUserUsedMargin } = require('../user.margin.service');
// Redis cluster (used to fetch canonical order data if SQL row missing)
const { redisCluster } = require('../../../config/redis');
// Event bus for portfolio updates
const portfolioEvents = require('../events/portfolio.events');
// Wallet payout service
const { applyOrderClosePayout } = require('../order.payout.service');
// Copy trading service for strategy provider order distribution
const copyTradingService = require('../copyTrading.service');
const mamOrderService = require('../mamOrder.service');
// Performance fee service for copy followers and MAM derived helpers
const {
  calculateAndApplyPerformanceFee,
  calculateAndApplyMamPerformanceFee,
  recalculateMamOrderDerivedProfits
} = require('../performanceFee.service');
const { refreshMamAccountAggregates } = require('../mamAggregates.service');
// Strategy provider statistics service
const StrategyProviderStatsService = require('../strategyProviderStats.service');
// Sequelize for database transactions
const sequelize = require('../../config/db');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1/';
const ORDER_DB_UPDATE_QUEUE = process.env.ORDER_DB_UPDATE_QUEUE || 'order_db_update_queue';
const PENDING_CHILD_STATUSES = ['PENDING', 'PENDING-QUEUED', 'PENDING-CANCEL', 'MODIFY'];

// Performance monitoring for throughput tracking
let messageCount = 0;
let lastLogTime = Date.now();
const PERFORMANCE_LOG_INTERVAL = 60000; // Log performance every 60 seconds

// Global connection references for graceful shutdown
let rabbitConnection = null;
let rabbitChannel = null;

function logRedisAudit(event, context = {}) {
  try {
    logger.redis(event, context);
  } catch (err) {
    logger.warn('Failed to write redis audit log', { event, error: err.message });
  }

async function handleMamChildAutocutoffClose(msg) {
  const {
    mam_order_id,
    mam_account_id,
    order_id,
    child_user_id,
    user_type,
    reason
  } = msg || {};

  if (!mam_order_id) {
    logger.warn('MAM child autocutoff message missing parent id', { msg });
    return;
  }

  const parentId = Number(mam_order_id);
  const providedMamAccountId = mam_account_id != null ? Number(mam_account_id) : null;
  let parentOrder = null;
  let resolvedMamAccountId = providedMamAccountId;

  try {
    if (order_id) {
      try {
        await LiveUserOrder.update({
          order_status: 'CLOSED',
          status: 'CLOSED',
          close_message: reason || 'Autocutoff'
        }, {
          where: { order_id: String(order_id) }
        });
      } catch (orderUpdateError) {
        logger.warn('Failed to sync child order close after autocutoff', {
          order_id,
          error: orderUpdateError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate(String(user_type || 'live'), String(child_user_id || msg.user_id), {
          type: 'order_closed',
          order_id: String(order_id),
          reason: reason || 'autocutoff'
        });
      } catch (eventError) {
        logger.warn('Failed to emit child autocutoff event', {
          order_id,
          error: eventError.message
        });
      }
    }

    if (!resolvedMamAccountId || Number.isNaN(resolvedMamAccountId)) {
      try {
        parentOrder = await MAMOrder.findByPk(parentId, {
          attributes: ['id', 'mam_account_id', 'order_status', 'metadata']
        });
        resolvedMamAccountId = parentOrder?.mam_account_id || null;
      } catch (lookupError) {
        logger.warn('Failed to fetch MAM order while resolving account id (autocutoff)', {
          mam_order_id,
          error: lookupError.message
        });
      }
    }

    const remainingOpen = await LiveUserOrder.count({
      where: {
        parent_mam_order_id: parentId,
        order_status: { [Op.in]: ['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'] }
      }
    });

    if (remainingOpen === 0) {
      if (!parentOrder) {
        try {
          parentOrder = await MAMOrder.findByPk(parentId);
        } catch (fetchError) {
          logger.warn('Failed to fetch parent MAM order during autocutoff closure update', {
            mam_order_id,
            error: fetchError.message
          });
        }
      }

      if (parentOrder) {
        try {
          const metadata = {
            ...(parentOrder.metadata || {}),
            closed_at: new Date().toISOString(),
            closed_reason: reason || 'autocutoff_child_closes'
          };
          await parentOrder.update({
            order_status: 'CLOSED',
            metadata
          });
        } catch (parentUpdateError) {
          logger.warn('Failed to mark MAM order closed after autocutoff', {
            mam_order_id,
            error: parentUpdateError.message
          });
        }
      }
    }

    try {
      await mamOrderService.syncMamAggregates({
        mamOrderId: parentId,
        mamAccountId: resolvedMamAccountId
      });
    } catch (aggError) {
      logger.warn('Failed to refresh MAM aggregates after autocutoff child close', {
        mam_order_id,
        error: aggError.message
      });
    }

    try {
      portfolioEvents.emitUserUpdate('mam_account', String(resolvedMamAccountId || 'unknown'), {
        type: 'mam_child_autocutoff_closed',
        mam_order_id: parentId,
        child_order_id: order_id ? Number(order_id) : null,
        remaining_open_children: remainingOpen,
        reason: reason || 'autocutoff'
      });
    } catch (mamEventError) {
      logger.warn('Failed to emit mam account update for autocutoff', {
        mam_order_id,
        error: mamEventError.message
      });
    }
  } catch (error) {
    logger.error('Failed to handle MAM child autocutoff message', {
      mam_order_id,
      error: error.message
    });
    throw error;
  }
}
}

async function handleMamPendingChildCancel(msg) {
  const {
    mam_order_id,
    mam_account_id,
    child_order_id,
    user_id,
    user_type,
    symbol,
    order_type,
    reason
  } = msg || {};

  if (!mam_order_id) {
    logger.warn('MAM child cancellation missing parent id', { msg });
    return;
  }

  const parentId = Number(mam_order_id);
  const providedMamAccountId = mam_account_id != null ? Number(mam_account_id) : null;
  let parentOrder = null;
  let resolvedMamAccountId = providedMamAccountId;

  try {
    if (child_order_id) {
      try {
        await LiveUserOrder.update({
          order_status: 'CANCELLED',
          status: 'CANCELLED',
          close_message: reason || 'insufficient_margin_pretrigger'
        }, {
          where: { order_id: String(child_order_id) }
        });
      } catch (orderUpdateError) {
        logger.warn('Failed to sync child order cancellation from monitor', {
          child_order_id,
          error: orderUpdateError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate(String(user_type || 'live'), String(user_id), {
          type: 'order_pending_cancelled',
          order_id: String(child_order_id),
          reason: reason || 'insufficient_margin_pretrigger'
        });
      } catch (eventError) {
        logger.warn('Failed to emit live user update for MAM pending cancellation', {
          child_order_id,
          error: eventError.message
        });
      }
    }

    if (!resolvedMamAccountId || Number.isNaN(resolvedMamAccountId)) {
      try {
        parentOrder = await MAMOrder.findByPk(parentId, {
          attributes: ['id', 'mam_account_id', 'order_status', 'metadata']
        });
        resolvedMamAccountId = parentOrder?.mam_account_id || null;
      } catch (lookupError) {
        logger.warn('Failed to fetch MAM order while resolving account id', {
          mam_order_id,
          error: lookupError.message
        });
      }
    }

    const remaining = await LiveUserOrder.count({
      where: {
        parent_mam_order_id: parentId,
        order_status: { [Op.in]: PENDING_CHILD_STATUSES }
      }
    });

    if (remaining === 0) {
      if (!parentOrder) {
        try {
          parentOrder = await MAMOrder.findByPk(parentId);
        } catch (fetchError) {
          logger.warn('Failed to fetch parent MAM order during cancellation update', {
            mam_order_id,
            error: fetchError.message
          });
        }
      }

      if (parentOrder) {
        try {
          const metadata = {
            ...(parentOrder.metadata || {}),
            cancelled_at: new Date().toISOString(),
            cancelled_reason: reason || 'insufficient_margin_pretrigger',
            cancelled_by: 'system_pending_monitor'
          };
          await parentOrder.update({
            order_status: 'CANCELLED',
            metadata
          });
        } catch (parentUpdateError) {
          logger.warn('Failed to mark MAM order cancelled after child drains', {
            mam_order_id,
            error: parentUpdateError.message
          });
        }
      }
    }

    try {
      await mamOrderService.syncMamAggregates({
        mamOrderId: parentId,
        mamAccountId: resolvedMamAccountId
      });
    } catch (aggError) {
      logger.warn('Failed to refresh MAM aggregates after child cancellation', {
        mam_order_id,
        error: aggError.message
      });
    }

    try {
      portfolioEvents.emitUserUpdate('mam_account', String(resolvedMamAccountId || 'unknown'), {
        type: 'mam_pending_child_cancelled',
        mam_order_id: parentId,
        child_order_id: child_order_id ? Number(child_order_id) : null,
        remaining_pending_children: remaining,
        reason: reason || 'insufficient_margin_pretrigger'
      });
    } catch (mamEventError) {
      logger.warn('Failed to emit mam account update for child cancellation', {
        mam_order_id,
        error: mamEventError.message
      });
    }
  } catch (error) {
    logger.error('Failed to handle MAM pending child cancellation', {
      error: error.message,
      mam_order_id,
      child_order_id
    });
    throw error;
  }
}

function getOrderModel(userType) {
  switch (userType) {
    case 'live':
      return LiveUserOrder;
    case 'demo':
      return DemoUserOrder;
    case 'strategy_provider':
      return StrategyProviderOrder;
    case 'copy_follower':
      return CopyFollowerOrder;
    default:
      return LiveUserOrder; // Default fallback
  }
}

function getUserModel(userType) {
  switch (userType) {
    case 'live':
      return LiveUser;
    case 'demo':
      return DemoUser;
    case 'strategy_provider':
      return StrategyProviderAccount;
    case 'copy_follower':
      return CopyFollowerAccount;
    default:
      return LiveUser; // Default fallback
  }
}

function normalizeOrderType(t) {
  const s = String(t || '').toUpperCase().trim();
  if (s === 'B') return 'BUY';
  if (s === 'S') return 'SELL';
  if (s === 'BUY_LIMIT' || s === 'BUY_STOP' || s === 'B_LIMIT' || s === 'B_STOP') return 'BUY';
  if (s === 'SELL_LIMIT' || s === 'SELL_STOP' || s === 'S_LIMIT' || s === 'S_STOP') return 'SELL';
  return s;
}

async function handleOrderRejectionRecord(msg) {
  const {
    canonical_order_id,
    provider_order_id,
    user_id,
    user_type,
    symbol,
    rejection_type,
    redis_status,
    provider_ord_status,
    reason,
    provider_exec_id,
    provider_raw_data,
    order_type,
    order_price,
    order_quantity,
    margin_released
  } = msg || {};

  if (!canonical_order_id || !user_id || !user_type || !rejection_type) {
    throw new Error('Missing required fields in rejection record message');
  }

  logger.info('DB consumer creating rejection record', {
    canonical_order_id: String(canonical_order_id),
    user_id: String(user_id),
    user_type: String(user_type),
    rejection_type,
    redis_status,
    symbol
  });

  try {
    // Create rejection record
    await OrderRejection.create({
      canonical_order_id: String(canonical_order_id),
      provider_order_id: provider_order_id ? String(provider_order_id) : null,
      user_id: parseInt(String(user_id), 10),
      user_type: String(user_type),
      symbol: symbol ? String(symbol).toUpperCase() : '',
      rejection_type: String(rejection_type),
      redis_status: redis_status ? String(redis_status) : '',
      provider_ord_status: provider_ord_status ? String(provider_ord_status) : null,
      reason: reason ? String(reason) : null,
      provider_exec_id: provider_exec_id ? String(provider_exec_id) : null,
      provider_raw_data: provider_raw_data || null,
      order_type: order_type ? String(order_type) : null,
      order_price: order_price != null && Number.isFinite(Number(order_price)) ? Number(order_price) : null,
      order_quantity: order_quantity != null && Number.isFinite(Number(order_quantity)) ? Number(order_quantity) : null,
      margin_released: margin_released != null && Number.isFinite(Number(margin_released)) ? Number(margin_released) : null
    });

    logger.info('Created order rejection record', {
      canonical_order_id: String(canonical_order_id),
      rejection_type,
      user_id: String(user_id),
      user_type: String(user_type)
    });

    // Emit websocket event for rejection notification
    try {
      portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
        type: 'order_rejection_created',
        canonical_order_id: String(canonical_order_id),
        rejection_type: String(rejection_type),
        reason: reason ? String(reason) : null,
        symbol: symbol ? String(symbol).toUpperCase() : null
      });
    } catch (e) {
      logger.warn('Failed to emit rejection notification event', { error: e.message });
    }

  } catch (error) {
    logger.error('Failed to create order rejection record', {
      error: error.message,
      canonical_order_id: String(canonical_order_id),
      rejection_type
    });
    throw error;
  }
}

async function handleCloseIdUpdate(msg) {
  const { order_id, user_id, user_type, close_id } = msg || {};

  if (!order_id || !user_id || !user_type || !close_id) {
    throw new Error('Missing required fields in close_id update message');
  }

  const OrderModel = getOrderModel(String(user_type));

  logger.info('Processing close_id update', {
    order_id: String(order_id),
    user_id: String(user_id),
    user_type: String(user_type),
    close_id: String(close_id)
  });

  try {
    // Update main order table with close_id
    const [updatedRows] = await OrderModel.update(
      { close_id: String(close_id).trim() },
      { where: { order_id: String(order_id) } }
    );

    if (updatedRows === 0) {
      logger.warn('No order found to update with close_id', {
        order_id: String(order_id),
        close_id: String(close_id)
      });
    } else {
      logger.info('Order updated with close_id', {
        order_id: String(order_id),
        close_id: String(close_id),
        updated_rows: updatedRows
      });
    }

    // Create lifecycle record for complete audit trail
    const [lifecycleRecord, created] = await OrderLifecycleId.findOrCreate({
      where: {
        order_id: String(order_id),
        id_type: 'close_id',
        lifecycle_id: String(close_id)
      },
      defaults: {
        status: 'active',
        notes: 'Autocutoff close ID - saved before provider send'
      }
    });

    if (created) {
      logger.info('OrderLifecycleId record created', {
        order_id: String(order_id),
        close_id: String(close_id),
        lifecycle_record_id: lifecycleRecord.id
      });
    } else {
      logger.info('OrderLifecycleId record already exists', {
        order_id: String(order_id),
        close_id: String(close_id),
        existing_record_id: lifecycleRecord.id
      });
    }

  } catch (error) {
    logger.error('Failed to save close_id to database', {
      error: error.message,
      order_id: String(order_id),
      user_id: String(user_id),
      user_type: String(user_type),
      close_id: String(close_id)
    });
    throw error;
  }
}

async function applyDbUpdate(msg) {
  const updateStartTime = Date.now();
  const {
    type,
    order_id,
    user_id,
    user_type,
    order_type,
    order_status,
    order_price,
    order_quantity,
    margin,
    contract_value,
    commission,
    commission_entry: commission_entry_msg,
    commission_exit: commission_exit_msg,
    used_margin_usd,
    // Close-specific new fields
    close_price,
    net_profit,
    swap,
    used_margin_executed,
    used_margin_all,
    close_message,
    // For mapping close_message based on which lifecycle id triggered close
    trigger_lifecycle_id,
    // Trigger fields
    stop_loss,
    take_profit,
    // New fields from pending monitor
    symbol,
    close_origin,
  } = msg || {};

  const normalizedMargin = (
    margin != null ? margin
      : (msg?.single_margin_usd != null ? msg.single_margin_usd
        : (msg?.margin_usd != null ? msg.margin_usd
          : (msg?.margin_required != null ? msg.margin_required
            : (msg?.required_margin != null ? msg.required_margin : null))))
  );

  // Enhanced logging for DB update processing
  logger.info('DB update processing started', {
    messageType: type,
    orderId: String(order_id),
    userId: String(user_id),
    userType: String(user_type),
    orderStatus: order_status,
    updateFields: {
      hasClosePrice: close_price !== undefined && close_price !== null,
      closePrice: close_price,
      hasNetProfit: net_profit !== undefined && net_profit !== null,
      netProfit: net_profit,
      hasCommission: commission !== undefined && commission !== null,
      commission: commission,
      hasUsedMarginExecuted: used_margin_executed !== undefined && used_margin_executed !== null,
      usedMarginExecuted: used_margin_executed,
      hasSwap: swap !== undefined && swap !== null,
      swap: swap,
      closeMessage: close_message,
      triggerLifecycleId: trigger_lifecycle_id
    },
    timestamp: new Date().toISOString()
  });

  // Validate required fields - order_id is always required
  if (!order_id) {
    throw new Error('Missing order_id in DB update message');
  }

  // For some message types (like ORDER_PENDING_CANCEL), user_id and user_type might be empty
  // We'll look them up from the database if needed
  if (!user_id || !user_type) {
    logger.warn('Missing user_id or user_type in message, will attempt database lookup', {
      messageType: String(type),
      order_id: String(order_id),
      user_id: String(user_id || 'empty'),
      user_type: String(user_type || 'empty')
    });
  }

  // Enhanced deduplication for ALL message types to prevent race conditions and database locks
  const processingKey = `order_processing:${String(order_id)}`;
  let processingId = null;
  let lockAcquired = false;

  try {
    // Check if this order is currently being processed
    const isProcessing = await redisCluster.get(processingKey);
    if (isProcessing) {
      const err = new Error('ORDER_PROCESSING_LOCKED');
      err.code = 'ORDER_PROCESSING_LOCKED';
      logger.warn('Order is currently being processed, requeueing message to prevent database lock', {
        messageType: String(type),
        order_id: String(order_id),
        user_id: String(user_id),
        user_type: String(user_type),
        processingKey,
        currentProcessor: isProcessing,
        timestamp: new Date().toISOString()
      });
      throw err;
    }

    // Mark order as being processed (with 60-second timeout)
    processingId = `${process.pid}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await redisCluster.setex(processingKey, 60, processingId);
    lockAcquired = true;

    logger.info('Order processing lock acquired', {
      messageType: String(type),
      order_id: String(order_id),
      processingId,
      processingKey,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.warn('Failed to check order processing status', {
      messageType: String(type),
      order_id: String(order_id),
      error: error.message
    });
    // Continue processing if Redis fails (better to risk duplicate than lose message)
  }

  // Helper function to release processing lock
  const releaseProcessingLock = async () => {
    if (lockAcquired && processingId) {
      try {
        const currentProcessor = await redisCluster.get(processingKey);
        if (currentProcessor === processingId) {
          await redisCluster.del(processingKey);
          logger.info('Order processing lock released', {
            order_id: String(order_id),
            processingId,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        logger.warn('Failed to release processing lock', {
          order_id: String(order_id),
          processingId,
          error: error.message
        });
      }
    }
  };

  // If user_type is missing, try to get it from Redis canonical data
  let resolvedUserType = user_type;
  let resolvedUserId = user_id;

  if (!user_type || !user_id) {
    try {
      const canonicalKey = `order_data:${String(order_id)}`;
      const canonical = await redisCluster.hgetall(canonicalKey);

      if (canonical && Object.keys(canonical).length > 0) {
        resolvedUserType = resolvedUserType || canonical.user_type;
        resolvedUserId = resolvedUserId || canonical.user_id;

        logger.info('Resolved missing user info from Redis canonical data', {
          order_id: String(order_id),
          originalUserType: String(user_type || 'empty'),
          originalUserId: String(user_id || 'empty'),
          resolvedUserType: String(resolvedUserType || 'empty'),
          resolvedUserId: String(resolvedUserId || 'empty')
        });
      } else {
        logger.warn('Could not resolve user info from Redis - canonical data not found', {
          order_id: String(order_id),
          canonicalKey
        });

        // Fallback: Try to determine user_type from order_id pattern or database lookup
        // Copy follower orders typically have specific patterns or we can query the database
        try {
          // Try to find the order in copy follower table first (most likely case for missing canonical data)
          const CopyFollowerOrder = require('../../models/copyFollowerOrder.model');
          const copyFollowerOrder = await CopyFollowerOrder.findOne({
            where: { order_id: String(order_id) },
            attributes: ['order_user_id']
          });

          if (copyFollowerOrder) {
            resolvedUserType = 'copy_follower';
            resolvedUserId = String(copyFollowerOrder.order_user_id);
            logger.info('Resolved user info from copy follower database lookup', {
              order_id: String(order_id),
              resolvedUserType,
              resolvedUserId
            });
          } else {
            // Try strategy provider table
            const StrategyProviderOrder = require('../../models/strategyProviderOrder.model');
            const strategyProviderOrder = await StrategyProviderOrder.findOne({
              where: { order_id: String(order_id) },
              attributes: ['order_user_id']
            });

            if (strategyProviderOrder) {
              resolvedUserType = 'strategy_provider';
              resolvedUserId = String(strategyProviderOrder.order_user_id);
              logger.info('Resolved user info from strategy provider database lookup', {
                order_id: String(order_id),
                resolvedUserType,
                resolvedUserId
              });
            } else {
              // Try live user table as final fallback
              const LiveUserOrder = require('../../models/liveUserOrder.model');
              const liveUserOrder = await LiveUserOrder.findOne({
                where: { order_id: String(order_id) },
                attributes: ['order_user_id']
              });

              if (liveUserOrder) {
                resolvedUserType = 'live';
                resolvedUserId = String(liveUserOrder.order_user_id);
                logger.info('Resolved user info from live user database lookup', {
                  order_id: String(order_id),
                  resolvedUserType,
                  resolvedUserId
                });
              }
            }
          }
        } catch (dbError) {
          logger.error('Failed to resolve user info from database lookup', {
            order_id: String(order_id),
            error: dbError.message
          });
        }
      }
    } catch (redisError) {
      logger.error('Failed to lookup canonical data for missing user info', {
        order_id: String(order_id),
        error: redisError.message
      });
    }
  }

  // Final validation after attempted resolution
  if (!resolvedUserType) {
    throw new Error(`Cannot determine user_type for order ${order_id}. Message user_type: "${user_type}", Redis lookup failed.`);
  }

  const OrderModel = getOrderModel(String(resolvedUserType));
  logger.info('DB consumer received message', {
    type,
    order_id: String(order_id),
    user_id: String(resolvedUserId || user_id),
    user_type: String(resolvedUserType),
    originalUserId: String(user_id || 'empty'),
    originalUserType: String(user_type || 'empty'),
    order_status,
    order_price,
    order_quantity,
    margin: normalizedMargin,
    commission,
    used_margin_usd,
    close_price,
    net_profit,
    swap,
    used_margin_executed,
    used_margin_all,
    trigger_lifecycle_id,
    stop_loss,
    take_profit,
  });

  // Start database transaction with row-level locking to prevent race conditions
  const transaction = await sequelize.transaction();
  let row = null;

  try {
    logger.info('Starting database transaction for order update', {
      orderId: String(order_id),
      messageType: type,
      transactionId: transaction.id,
      timestamp: new Date().toISOString()
    });

    // Attempt to find existing row with row-level lock
    row = await OrderModel.findOne({
      where: { order_id: String(order_id) },
      lock: transaction.LOCK.UPDATE, // Row-level lock to prevent concurrent updates
      transaction
    });
    if (!row) {
      // If missing, fetch minimal required fields from Redis canonical order_data:{order_id}
      try {
        const key = `order_data:${String(order_id)}`;
        const canonical = await redisCluster.hgetall(key);
        if (!canonical || Object.keys(canonical).length === 0) {
          logger.warn('Canonical order not found in Redis for DB backfill', { order_id });
        } else {
          const symbol = canonical.symbol || canonical.order_company_name; // normalized by services
          const order_type = canonical.order_type;
          const order_quantity = canonical.order_quantity ?? '0';
          const price = order_price != null ? String(order_price) : (canonical.order_price ?? '0');
          const status = String(order_status || canonical.order_status || 'OPEN');
          // Round to 8 decimals to match DECIMAL(18,8)
          const marginStr = normalizedMargin != null && Number.isFinite(Number(normalizedMargin))
            ? Number(normalizedMargin).toFixed(8)
            : (canonical.margin ?? null);
          const contractValueStr = contract_value != null && Number.isFinite(Number(contract_value))
            ? Number(contract_value).toFixed(8)
            : (canonical.contract_value ?? null);
          const commissionStr = commission != null && Number.isFinite(Number(commission))
            ? Number(commission).toFixed(8)
            : (canonical.commission ?? canonical.commission_entry ?? null);

          if (!symbol || !order_type) {
            logger.warn('Missing required fields in canonical order for SQL create', { order_id, symbol, order_type });
          } else {
            row = await OrderModel.create({
              order_id: String(order_id),
              order_user_id: parseInt(String(user_id), 10),
              symbol: String(symbol).toUpperCase(),
              order_type: String(order_type).toUpperCase(),
              order_status: status,
              order_price: String(price),
              order_quantity: String(order_quantity),
              contract_value: contractValueStr != null ? String(contractValueStr) : null,
              margin: marginStr != null ? String(marginStr) : null,
              commission: commissionStr != null ? String(commissionStr) : null,
              placed_by: 'user'
            }, { transaction }); // Add transaction to create operation
            logger.info('Created SQL order row from Redis canonical for DB update', { order_id, transactionId: transaction.id });
          }
        }
      } catch (e) {
        logger.error('Failed to backfill SQL order from Redis canonical', { order_id, error: e.message });
      }
    }

    logOrderOpenCalculation(msg, {
      row,
      userId: resolvedUserId || user_id,
      userType: resolvedUserType,
    });

    // Emit calculation log for local close confirmations (Python already logs provider flows)
    logLocalCloseCalculation(msg, {
      row,
      userId: resolvedUserId || user_id,
      userType: resolvedUserType,
    });

    // Wallet payout and transaction records (idempotent per order)
    try {
      if (type === 'ORDER_CLOSE_CONFIRMED') {
        const payoutKey = `close_payout_applied:${String(order_id)}`;
        const nx = await redisCluster.set(payoutKey, '1', 'EX', 7 * 24 * 3600, 'NX');
        if (nx) {
          const OrderModelP = getOrderModel(String(user_type));
          let rowP = row;
          if (!rowP) {
            try { rowP = await OrderModelP.findOne({ where: { order_id: String(order_id) } }); } catch (_) { }
          }
          const orderPk = rowP?.id ?? null;
          const symbolP = rowP?.symbol ?? undefined;
          const orderTypeP = rowP?.order_type ?? undefined;

          // Apply payout for all user types (live, demo, strategy_provider, copy_follower)
          // Use original net profit - performance fee will be calculated after transaction
          await applyOrderClosePayout({
            userType: String(user_type),
            userId: parseInt(String(user_id), 10),
            orderPk,
            orderIdStr: String(order_id),
            netProfit: Number(net_profit) || 0,
            commission: Number(commission) || 0,
            profitUsd: Number(msg.profit_usd) || 0,
            swap: Number(swap) || 0,
            symbol: symbolP ? String(symbolP).toUpperCase() : undefined,
            orderType: orderTypeP ? String(orderTypeP).toUpperCase() : undefined,
          });

          // Trigger a WS snapshot refresh for wallet balance
          try {
            portfolioEvents.emitUserUpdate(String(user_type), String(user_id), {
              type: 'wallet_balance_update',
              order_id: String(order_id),
            });
          } catch (e) {
            logger.warn('Failed to emit WS after payout', { error: e.message, order_id: String(order_id) });
          }
        } else {
          logger.info('Skip payout; already applied for order', { order_id: String(order_id) });
        }
      }
    } catch (e) {
      logger.error('Failed to apply payout on close', { error: e.message, order_id: String(order_id) });
    }

    // User net_profit increment is now handled by applyOrderClosePayout service
    // Removed from here to avoid double accounting

    // If still no row, nothing else we can do; avoid throwing to prevent poison messages
    if (!row) {
      logger.warn('Skipping DB order update; SQL row not found and could not be created', { order_id });
    } else {
      const updateFields = {};
      if (order_status) updateFields.order_status = String(order_status);
      // Default for pending-cancel confirmations if publisher forgot to set order_status
      if (!order_status && String(type) === 'ORDER_PENDING_CANCEL') {
        updateFields.order_status = 'CANCELLED';
      }
      // Default for order rejection confirmations if publisher forgot to set order_status
      if (!order_status && String(type) === 'ORDER_REJECTED') {
        updateFields.order_status = 'REJECTED';
      }
      if (order_type) updateFields.order_type = normalizeOrderType(order_type);
      if (order_price != null) updateFields.order_price = String(order_price);
      if (order_quantity != null) updateFields.order_quantity = String(order_quantity);
      // Update symbol if provided (especially for ORDER_PENDING_TRIGGERED)
      if (symbol && String(type) === 'ORDER_PENDING_TRIGGERED') {
        updateFields.symbol = String(symbol).toUpperCase();
      }
      if (normalizedMargin != null && Number.isFinite(Number(normalizedMargin))) {
        updateFields.margin = Number(normalizedMargin).toFixed(8);
      }
      if (contract_value != null && Number.isFinite(Number(contract_value))) {
        updateFields.contract_value = Number(contract_value).toFixed(8);
      }
      if (commission != null && Number.isFinite(Number(commission))) {
        updateFields.commission = Number(commission).toFixed(8);
      }
      // Trigger fields
      if (stop_loss != null && Number.isFinite(Number(stop_loss))) {
        updateFields.stop_loss = Number(stop_loss).toFixed(8);
      }
      if (take_profit != null && Number.isFinite(Number(take_profit))) {
        updateFields.take_profit = Number(take_profit).toFixed(8);
      }
      // Cancel trigger messages: explicitly nullify columns
      if (type === 'ORDER_STOPLOSS_CANCEL') {
        updateFields.stop_loss = null;
      }
      if (type === 'ORDER_TAKEPROFIT_CANCEL') {
        updateFields.take_profit = null;
      }
      // Close-specific fields
      if (close_price != null && Number.isFinite(Number(close_price))) {
        updateFields.close_price = Number(close_price).toFixed(8);
      }
      if (net_profit != null && Number.isFinite(Number(net_profit))) {
        updateFields.net_profit = Number(net_profit).toFixed(8);
      }
      if (swap != null && Number.isFinite(Number(swap))) {
        updateFields.swap = Number(swap).toFixed(8);
      }

      // Enhanced close message mapping based on close scenario
      if (type === 'ORDER_CLOSE_CONFIRMED') {
        try {
          let closeMsg = null;

          // Priority 1: Use explicit close_message if provided in payload
          if (close_message && String(close_message).trim()) {
            closeMsg = String(close_message).trim();
          }
          // Priority 2: Determine from trigger_lifecycle_id
          else if (trigger_lifecycle_id) {
            let slId = row.stoploss_id || null;
            let tpId = row.takeprofit_id || null;
            let clsId = row.close_id || null;

            // Fallback to Redis canonical if SQL row lacks these ids
            if (!slId || !tpId || !clsId) {
              try {
                const canonical = await redisCluster.hgetall(`order_data:${String(order_id)}`);
                if (canonical) {
                  if (!slId && canonical.stoploss_id) slId = String(canonical.stoploss_id);
                  if (!tpId && canonical.takeprofit_id) tpId = String(canonical.takeprofit_id);
                  if (!clsId && canonical.close_id) clsId = String(canonical.close_id);
                }
              } catch (e) {
                // best effort only
              }
            }

            const trig = String(trigger_lifecycle_id);
            console.log("trigger_lifecycle_id:", trig, "slId:", slId, "tpId:", tpId, "clsId:", clsId);
            if (slId && trig === String(slId)) {
              closeMsg = 'Stoploss';
            } else if (tpId && trig === String(tpId)) {
              closeMsg = 'Takeprofit';
            } else if (clsId && trig === String(clsId)) {
              closeMsg = 'Closed';
            } else if (trig.includes('trigger_stoploss_')) {
              // Handle synthetic stoploss trigger IDs
              closeMsg = 'Stoploss';
            } else if (trig.includes('trigger_takeprofit_')) {
              // Handle synthetic takeprofit trigger IDs
              closeMsg = 'Takeprofit';
            } else {
              // Check if trigger ID indicates autocutoff
              if (trig.includes('autocutoff') || trig.includes('liquidation') || trig.includes('margin_call')) {
                closeMsg = 'Autocutoff';
              } else {
                closeMsg = 'Closed'; // Default for unknown triggers
              }
            }
          }
          // Priority 3: Default fallback
          else {
            closeMsg = 'Closed';
          }

          if (closeMsg) {
            updateFields.close_message = closeMsg;
            logger.info('Set close_message for order', {
              order_id: String(order_id),
              close_message: closeMsg,
              trigger_lifecycle_id: trigger_lifecycle_id || 'none',
              detection_method: close_message ? 'explicit' : (trigger_lifecycle_id ? 'trigger_id' : 'default')
            });
          }
        } catch (e) {
          logger.warn('Failed to set close_message', { error: e.message, order_id: String(order_id) });
          // Set default close_message on error
          updateFields.close_message = 'Closed';
        }
      }

      // Fallback: if status transitions to OPEN and no explicit order_type provided, convert existing pending type to BUY/SELL
      try {
        const willBeOpen = Object.prototype.hasOwnProperty.call(updateFields, 'order_status') && String(updateFields.order_status).toUpperCase() === 'OPEN';
        const lacksType = !Object.prototype.hasOwnProperty.call(updateFields, 'order_type');
        if (willBeOpen && lacksType && row && row.order_type) {
          const cur = String(row.order_type).toUpperCase();
          const norm = normalizeOrderType(cur);
          if (norm !== cur) {
            updateFields.order_type = norm;
          }
        }
      } catch (_) { }

      if (type === 'ORDER_CLOSE_CONFIRMED') {
        const requiredFields = ['close_price', 'net_profit', 'commission', 'profit_usd'];
        const missingCloseFields = requiredFields.filter((field) => msg[field] == null);
        if (missingCloseFields.length > 0) {
          logger.warn('Close confirmation missing expected financial fields', {
            order_id: String(order_id),
            missingCloseFields,
            payloadKeys: Object.keys(msg || {}),
            close_origin: close_origin || 'unknown',
          });
        }
        if (!row && close_origin === 'local') {
          logger.warn('Local close confirmation arrived without SQL row; will rely on payload only', {
            order_id: String(order_id),
            user_id: String(user_id),
            user_type: String(user_type),
          });
        }
      }

      if (Object.keys(updateFields).length > 0) {
        const dbUpdateStartTime = Date.now();
        if (close_origin) {
          logger.info('Processing close confirmation with origin metadata', {
            orderId: String(order_id),
            close_origin,
            messageType: type,
          });
        }
        const before = {
          margin: row.margin != null ? row.margin.toString() : null,
          commission: row.commission != null ? row.commission.toString() : null,
          order_price: row.order_price != null ? row.order_price.toString() : null,
          order_status: row.order_status,
          close_price: row.close_price != null ? row.close_price.toString() : null,
          net_profit: row.net_profit != null ? row.net_profit.toString() : null,
          swap: row.swap != null ? row.swap.toString() : null,
          stop_loss: row.stop_loss != null ? row.stop_loss.toString() : null,
          take_profit: row.take_profit != null ? row.take_profit.toString() : null,
        };

        logger.info('DB update about to execute with transaction', {
          orderId: String(order_id),
          messageType: type,
          updateFields: updateFields,
          beforeValues: before,
          transactionId: transaction.id,
          concurrentProcessing: {
            userId: String(user_id),
            userType: String(user_type),
            timestamp: new Date().toISOString()
          }
        });

        await row.update(updateFields, { transaction });
        const dbUpdateTime = Date.now() - dbUpdateStartTime;

        const after = {
          margin: row.margin != null ? row.margin.toString() : null,
          commission: row.commission != null ? row.commission.toString() : null,
          order_price: row.order_price != null ? row.order_price.toString() : null,
          order_status: row.order_status,
          close_price: row.close_price != null ? row.close_price.toString() : null,
          net_profit: row.net_profit != null ? row.net_profit.toString() : null,
          swap: row.swap != null ? row.swap.toString() : null,
          stop_loss: row.stop_loss != null ? row.stop_loss.toString() : null,
          take_profit: row.take_profit != null ? row.take_profit.toString() : null,
        };

        // Detect partial updates
        const partialUpdateDetection = {
          statusUpdated: before.order_status !== after.order_status,
          financialsUpdated: (before.net_profit !== after.net_profit ||
            before.commission !== after.commission ||
            before.close_price !== after.close_price),
          marginUpdated: before.margin !== after.margin,
          isCloseMessage: type === 'ORDER_CLOSE_CONFIRMED',
          hasAllCloseFields: !!(after.close_price && after.net_profit && after.commission)
        };

        logger.info('DB consumer applied order update', {
          orderId: String(order_id),
          messageType: type,
          before,
          updateFields,
          after,
          dbUpdateTimeMs: dbUpdateTime,
          partialUpdateDetection,
          timestamp: new Date().toISOString()
        });
        // Mirror updates into Redis except for pending cancel finalization (keys were deleted by worker)
        if (String(type) !== 'ORDER_PENDING_CANCEL') {
          try {
            const userTypeStr = String(user_type);
            const userIdStr = String(user_id);
            const hashTag = `${userTypeStr}:${userIdStr}`;
            const orderKey = `user_holdings:{${hashTag}}:${String(order_id)}`;
            const orderDataKey = `order_data:${String(order_id)}`;
            const indexKey = `user_orders_index:{${hashTag}}`;
            const symbolUpper = row?.symbol ? String(row.symbol).toUpperCase() : undefined;
            // 1) User-slot pipeline: user_holdings + user_orders_index share the same hash tag slot
            const pUser = redisCluster.pipeline();
            let redisIndexAction = null;
            // Maintain index membership based on order_status when provided
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_status')) {
              const st = String(updateFields.order_status).toUpperCase();
              if (st === 'REJECTED' || st === 'CLOSED' || st === 'CANCELLED' || st === 'QUEUED') {
                pUser.srem(indexKey, String(order_id));
                redisIndexAction = 'srem';
              } else if (st === 'OPEN' || st === 'PENDING') {
                // Ensure presence in index for OPEN and PENDING
                pUser.sadd(indexKey, String(order_id));
                redisIndexAction = 'sadd';
              }
              // Mirror order_status into user_holdings for immediate WS/UI visibility
              pUser.hset(orderKey, 'order_status', st);
            } else {
              // Default behavior (for trigger updates not changing status): ensure presence
              pUser.sadd(indexKey, String(order_id));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'stop_loss')) {
              if (updateFields.stop_loss === null) {
                pUser.hdel(orderKey, 'stop_loss');
              } else {
                pUser.hset(orderKey, 'stop_loss', String(updateFields.stop_loss));
              }
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'take_profit')) {
              if (updateFields.take_profit === null) {
                pUser.hdel(orderKey, 'take_profit');
              } else {
                pUser.hset(orderKey, 'take_profit', String(updateFields.take_profit));
              }
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_type')) {
              pUser.hset(orderKey, 'order_type', String(updateFields.order_type).toUpperCase());
            }
            // Mirror common numeric fields used by UI
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_price')) {
              pUser.hset(orderKey, 'order_price', String(updateFields.order_price));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_quantity')) {
              pUser.hset(orderKey, 'order_quantity', String(updateFields.order_quantity));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'contract_value')) {
              pUser.hset(orderKey, 'contract_value', String(updateFields.contract_value));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'commission')) {
              pUser.hset(orderKey, 'commission', String(updateFields.commission));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'net_profit')) {
              pUser.hset(orderKey, 'net_profit', String(updateFields.net_profit));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'close_price')) {
              pUser.hset(orderKey, 'close_price', String(updateFields.close_price));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'swap')) {
              pUser.hset(orderKey, 'swap', String(updateFields.swap));
            }
            await pUser.exec();

            logRedisAudit('order_redis_pipeline_applied', {
              hashTag,
              userType: userTypeStr,
              userId: userIdStr,
              orderId: String(order_id),
              orderKey,
              indexKey,
              orderDataKey,
              orderStatus: updateFields.order_status,
              indexAction: redisIndexAction || 'upsert',
              fieldsUpdated: Object.keys(updateFields || {})
            });

            const statusIsClosed = Object.prototype.hasOwnProperty.call(updateFields, 'order_status')
              && String(updateFields.order_status).toUpperCase() === 'CLOSED';
            if (statusIsClosed) {
              try {
                const cleanupPipe = redisCluster.pipeline();
                cleanupPipe.srem(indexKey, String(order_id));
                cleanupPipe.del(orderKey);
                await cleanupPipe.exec();
                logRedisAudit('order_redis_removed_after_close', {
                  hashTag,
                  userType: userTypeStr,
                  userId: userIdStr,
                  orderId: String(order_id),
                  orderKey,
                  indexKey,
                  reason: 'status_closed'
                });
              } catch (cleanupErr) {
                logger.warn('Failed to cleanup user holdings after close', { error: cleanupErr.message, order_id: String(order_id) });
              }

              try {
                await redisCluster.del(orderDataKey);
                logRedisAudit('order_redis_order_data_deleted', {
                  hashTag,
                  userType: userTypeStr,
                  userId: userIdStr,
                  orderId: String(order_id),
                  orderDataKey,
                  reason: 'status_closed'
                });
              } catch (delErr) {
                logger.warn('Failed to delete canonical order_data after close', { error: delErr.message, order_id: String(order_id) });
              }
            }

            // 2) order_data pipeline (separate slot)
            const pOd = redisCluster.pipeline();
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_status')) {
              pOd.hset(orderDataKey, 'order_status', String(updateFields.order_status).toUpperCase());
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'stop_loss')) {
              if (updateFields.stop_loss === null) pOd.hdel(orderDataKey, 'stop_loss');
              else pOd.hset(orderDataKey, 'stop_loss', String(updateFields.stop_loss));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'take_profit')) {
              if (updateFields.take_profit === null) pOd.hdel(orderDataKey, 'take_profit');
              else pOd.hset(orderDataKey, 'take_profit', String(updateFields.take_profit));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_type')) {
              pOd.hset(orderDataKey, 'order_type', String(updateFields.order_type).toUpperCase());
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_price')) {
              pOd.hset(orderDataKey, 'order_price', String(updateFields.order_price));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'order_quantity')) {
              pOd.hset(orderDataKey, 'order_quantity', String(updateFields.order_quantity));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'contract_value')) {
              pOd.hset(orderDataKey, 'contract_value', String(updateFields.contract_value));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'commission')) {
              pOd.hset(orderDataKey, 'commission', String(updateFields.commission));
              // For OPEN confirmations, also persist entry commission breakdown into canonical
              if (String(type) === 'ORDER_OPEN_CONFIRMED') {
                pOd.hset(orderDataKey, 'commission_entry', String(updateFields.commission));
              }
            }
            if (commission_entry_msg != null) {
              pOd.hset(orderDataKey, 'commission_entry', String(commission_entry_msg));
            }
            if (commission_exit_msg != null) {
              pOd.hset(orderDataKey, 'commission_exit', String(commission_exit_msg));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'net_profit')) {
              pOd.hset(orderDataKey, 'net_profit', String(updateFields.net_profit));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'close_price')) {
              pOd.hset(orderDataKey, 'close_price', String(updateFields.close_price));
            }
            if (Object.prototype.hasOwnProperty.call(updateFields, 'swap')) {
              pOd.hset(orderDataKey, 'swap', String(updateFields.swap));
            }
            await pOd.exec();

            // 3) symbol_holders (separate slot): only add for OPEN orders
            if (symbolUpper && String(updateFields.order_status || row.order_status).toUpperCase() === 'OPEN') {
              try {
                const symKey = `symbol_holders:${symbolUpper}:${userTypeStr}`;
                await redisCluster.sadd(symKey, hashTag);
              } catch (e2) {
                logger.warn('symbol_holders sadd failed', { error: e2.message, symbol: symbolUpper, user: hashTag });
              }
            }
          } catch (e) {
            logger.warn('Failed to mirror trigger to Redis holdings', { error: e.message, order_id: String(order_id) });
          }
        } else {
          logger.info('Skip Redis mirror for ORDER_PENDING_CANCEL (keys were removed by worker)', { order_id: String(order_id) });
        }

        // Emit event for this user's portfolio stream
        try {
          // Hydrate WS update for PENDING confirmation with core fields if not present
          let updateForWs = { ...updateFields };
          if (String(type) === 'ORDER_PENDING_CONFIRMED') {
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'symbol') && row?.symbol) {
              updateForWs.symbol = String(row.symbol).toUpperCase();
            }
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_type') && row?.order_type) {
              updateForWs.order_type = String(row.order_type).toUpperCase();
            }
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_price') && row?.order_price != null) {
              updateForWs.order_price = String(row.order_price);
            }
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_quantity') && row?.order_quantity != null) {
              updateForWs.order_quantity = String(row.order_quantity);
            }
          }
          // Hydrate WS update for ORDER_PENDING_TRIGGERED with fields from message
          if (String(type) === 'ORDER_PENDING_TRIGGERED') {
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'symbol') && symbol) {
              updateForWs.symbol = String(symbol).toUpperCase();
            }
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_quantity') && order_quantity) {
              updateForWs.order_quantity = String(order_quantity);
            }
            // Also include from row if message fields are missing
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'symbol') && row?.symbol) {
              updateForWs.symbol = String(row.symbol).toUpperCase();
            }
            if (!Object.prototype.hasOwnProperty.call(updateForWs, 'order_quantity') && row?.order_quantity != null) {
              updateForWs.order_quantity = String(row.order_quantity);
            }
          }
          const wsPayload = {
            type: 'order_update',
            order_id: String(order_id),
            update: updateForWs,
          };
          if (String(type) === 'ORDER_PENDING_CONFIRMED') {
            wsPayload.reason = 'pending_confirmed';
          }
          if (String(type) === 'ORDER_PENDING_CANCEL') {
            wsPayload.reason = 'pending_cancelled';
          }
          if (String(type) === 'ORDER_OPEN_CONFIRMED') {
            wsPayload.reason = 'order_opened';
          }
          if (String(type) === 'ORDER_CLOSE_CONFIRMED') {
            wsPayload.reason = 'order_closed';
          }
          if (String(type) === 'ORDER_STOPLOSS_CONFIRMED') {
            wsPayload.reason = 'stoploss_triggered';
          }
          if (String(type) === 'ORDER_TAKEPROFIT_CONFIRMED') {
            wsPayload.reason = 'takeprofit_triggered';
          }
          if (String(type) === 'ORDER_STOPLOSS_CANCEL') {
            wsPayload.reason = 'stoploss_cancelled';
          }
          if (String(type) === 'ORDER_TAKEPROFIT_CANCEL') {
            wsPayload.reason = 'takeprofit_cancelled';
          }
          portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), wsPayload);

          logger.info('WebSocket event emitted for order update', {
            messageType: String(type),
            orderId: String(order_id),
            userType: String(resolvedUserType),
            userId: String(resolvedUserId || user_id),
            wsPayloadType: wsPayload.type,
            wsPayloadReason: wsPayload.reason,
            updateFields: Object.keys(updateForWs)
          });

          // Emit dedicated events for specific order state changes to trigger immediate UI updates
          if (String(type) === 'ORDER_PENDING_CONFIRMED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'order_pending_confirmed',
              order_id: String(order_id),
              update: updateForWs,
              reason: 'pending_confirmed'
            });

            logger.info('Dedicated WebSocket event emitted for pending confirmation', {
              orderId: String(order_id),
              userType: String(resolvedUserType),
              userId: String(resolvedUserId || user_id),
              eventType: 'order_pending_confirmed',
              updateFields: Object.keys(updateForWs)
            });
          }
          if (String(type) === 'ORDER_PENDING_CANCEL') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'order_pending_cancelled',
              order_id: String(order_id),
              update: updateForWs,
              reason: 'pending_cancelled'
            });
          }
          // Emit a dedicated event when an order is rejected to trigger immediate DB refresh on WS
          if (String(type) === 'ORDER_REJECTED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'order_rejected',
              order_id: String(order_id),
            });
          }
          // Emit immediate event for order opened to refresh UI instantly
          if (String(type) === 'ORDER_OPEN_CONFIRMED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'order_opened',
              order_id: String(order_id),
              update: updateForWs,
            });
          }
          // Emit immediate event for order closed to refresh UI instantly
          if (String(type) === 'ORDER_CLOSE_CONFIRMED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'order_closed',
              order_id: String(order_id),
              update: updateForWs,
            });
          }
          // Emit immediate event for stoploss triggered to refresh UI instantly
          if (String(type) === 'ORDER_STOPLOSS_CONFIRMED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'stoploss_triggered',
              order_id: String(order_id),
              update: updateForWs,
            });
          }
          // Emit immediate event for takeprofit triggered to refresh UI instantly
          if (String(type) === 'ORDER_TAKEPROFIT_CONFIRMED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'takeprofit_triggered',
              order_id: String(order_id),
              update: updateForWs,
            });
          }
          // Emit immediate event for stoploss cancelled to refresh UI instantly
          if (String(type) === 'ORDER_STOPLOSS_CANCEL') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'stoploss_cancelled',
              order_id: String(order_id),
              update: updateForWs,
            });
          }
          // Emit immediate event for takeprofit cancelled to refresh UI instantly
          if (String(type) === 'ORDER_TAKEPROFIT_CANCEL') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'takeprofit_cancelled',
              order_id: String(order_id),
              update: updateForWs,
            });
          }
          // Emit immediate event for pending order triggers to refresh UI instantly
          if (String(type) === 'ORDER_PENDING_TRIGGERED') {
            portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
              type: 'order_update',
              order_id: String(order_id),
              reason: 'pending_triggered',
              update: updateForWs,
            });
          }
        } catch (e) {
          logger.warn('Failed to emit portfolio event after order update', { error: e.message });
        }
      }
    }

    // Handle post-close operations (margin updates, copy trading, etc.)
    // Use resolved user info for post-close operations
    const msgWithResolvedUser = {
      ...msg,
      user_id: resolvedUserId || user_id,
      user_type: resolvedUserType
    };
    await handlePostCloseOperations(msgWithResolvedUser, row);

    // NOTE: Copy trading replication is handled in the controller when the order is placed
    // Removing duplicate trigger that was causing double copy orders in provider flow
    // The replication should only happen once when the order is initially placed, not again on confirmation

    // Update user's used margin in SQL, if provided
    const mirrorUsedMargin = (used_margin_usd != null) ? used_margin_usd : (used_margin_executed != null ? used_margin_executed : null);
    if (mirrorUsedMargin != null) {
      try {
        logger.info('Updating user margin from DB consumer', {
          order_id: String(order_id),
          user_id: String(resolvedUserId || user_id),
          user_type: String(resolvedUserType),
          message_type: type,
          mirrorUsedMargin,
          used_margin_usd,
          used_margin_executed,
          transactionId: transaction.id
        });
        await updateUserUsedMargin({ userType: String(resolvedUserType), userId: parseInt(String(resolvedUserId || user_id), 10), usedMargin: mirrorUsedMargin });
      } catch (e) {
        logger.error('Failed to persist used margin in SQL', { error: e.message, user_id: resolvedUserId || user_id, user_type: resolvedUserType });
        // Do not fail the message solely due to mirror write; treat as non-fatal
      }
      // Emit separate event for margin change
      try {
        portfolioEvents.emitUserUpdate(String(resolvedUserType), String(resolvedUserId || user_id), {
          type: 'user_margin_update',
          used_margin_usd: mirrorUsedMargin,
        });
      } catch (e) {
        logger.warn('Failed to emit portfolio event after user margin update', { error: e.message });
      }
    }

    // Commit transaction if all operations succeeded
    try {
      await transaction.commit();

      logger.info('Database transaction committed successfully', {
        orderId: String(order_id),
        messageType: type,
        transactionId: transaction.id,
        processingTimeMs: Date.now() - updateStartTime,
        timestamp: new Date().toISOString()
      });
    } catch (commitError) {
      logger.error('Transaction commit failed', {
        orderId: String(order_id),
        messageType: type,
        transactionId: transaction.id,
        error: commitError.message,
        stack: commitError.stack,
        timestamp: new Date().toISOString()
      });

      // Release processing lock before throwing to allow retry
      await releaseProcessingLock();

      throw commitError; // Re-throw to trigger message requeue
    }

    // Release processing lock after successful completion
    await releaseProcessingLock();

    // 🆕 Clean up close_pending lock after successful CLOSE confirmation
    if (type === 'ORDER_CLOSE_CONFIRMED') {
      try {
        const closePendingKey = `order_close_pending:${String(order_id)}`;
        await redisCluster.del(closePendingKey);
        logger.info('Cleaned up close pending lock after successful close', {
          orderId: String(order_id),
          closePendingKey,
          timestamp: new Date().toISOString()
        });
      } catch (cleanupErr) {
        logger.warn('Failed to cleanup close pending lock', {
          orderId: String(order_id),
          error: cleanupErr.message
        });
        // Non-fatal - lock will expire after TTL
      }
    }
    // Post-commit async tasks for order close (performance fees, MAM aggregates)
    if (type === 'ORDER_CLOSE_CONFIRMED') {
      setImmediate(async () => {
        try {
          logger.info('Post-close async tasks started', {
            order_id: String(order_id),
            user_type: String(user_type),
            net_profit: Number(net_profit) || 0
          });

          // Copy follower performance fee
          if (String(user_type) === 'copy_follower' && (Number(net_profit) || 0) > 0) {
            const CopyFollowerOrder = require('../../models/copyFollowerOrder.model');
            const copyFollowerOrder = await CopyFollowerOrder.findOne({
              where: { order_id: String(order_id) }
            });

            if (copyFollowerOrder && copyFollowerOrder.strategy_provider_id) {
              logger.info('Calculating performance fee', {
                copyFollowerOrderId: String(order_id),
                copyFollowerUserId: parseInt(String(user_id), 10),
                strategyProviderId: copyFollowerOrder.strategy_provider_id,
                orderNetProfit: Number(net_profit) || 0
              });

              const performanceFeeResult = await calculateAndApplyPerformanceFee({
                copyFollowerOrderId: String(order_id),
                copyFollowerUserId: parseInt(String(user_id), 10),
                strategyProviderId: copyFollowerOrder.strategy_provider_id,
                orderNetProfit: Number(net_profit) || 0,
                symbol: copyFollowerOrder.symbol ? String(copyFollowerOrder.symbol).toUpperCase() : undefined,
                orderType: copyFollowerOrder.order_type ? String(copyFollowerOrder.order_type).toUpperCase() : undefined
              }, { adjustAccountNetProfit: true });

              if (performanceFeeResult.performanceFeeCharged) {
                logger.info('Performance fee applied successfully', {
                  order_id: String(order_id),
                  originalNetProfit: Number(net_profit) || 0,
                  adjustedNetProfit: performanceFeeResult.adjustedNetProfit,
                  performanceFeeAmount: performanceFeeResult.performanceFeeAmount
                });

                try {
                  portfolioEvents.emitUserUpdate('strategy_provider', String(copyFollowerOrder.strategy_provider_id), {
                    type: 'wallet_balance_update',
                    reason: 'performance_fee_earned',
                    order_id: String(order_id)
                  });
                } catch (wsError) {
                  logger.warn('Failed to emit strategy provider WS update for performance fee', {
                    error: wsError.message,
                    order_id: String(order_id),
                    strategyProviderId: copyFollowerOrder.strategy_provider_id
                  });
                }
              }
            }
          }

          // MAM parent recomputation + fee
          if (String(user_type) === 'live') {
            const orderIdStr = String(order_id);
            const liveOrderRow = row || await LiveUserOrder.findOne({ where: { order_id: orderIdStr } });

            if (!liveOrderRow) {
              logger.warn('Post-close async: Live order row not found for MAM processing', {
                order_id: orderIdStr
              });
              return;
            }

            const parentMamOrderId = liveOrderRow.parent_mam_order_id;

            if (!parentMamOrderId) {
              logger.info('Post-close async: No parent MAM order associated with child order', {
                order_id: orderIdStr
              });
              return;
            }

            logger.info('Post-close async: Processing MAM parent for child close', {
              order_id: orderIdStr,
              parent_mam_order_id: parentMamOrderId
            });

            try {
              await recalculateMamOrderDerivedProfits(parentMamOrderId);
            } catch (derivedError) {
              logger.error('Failed to recalculate MAM order derived profits after child close', {
                order_id: orderIdStr,
                parent_mam_order_id: parentMamOrderId,
                error: derivedError.message
              });
            }

            let parentMamOrder = null;
            try {
              parentMamOrder = await MAMOrder.findByPk(parentMamOrderId, { attributes: ['id', 'mam_account_id'] });
              await mamOrderService.syncMamAggregates({
                mamOrderId: parentMamOrderId,
                mamAccountId: parentMamOrder?.mam_account_id
              });
            } catch (aggregateError) {
              logger.error('Failed to refresh MAM aggregates after child close', {
                order_id: orderIdStr,
                parent_mam_order_id: parentMamOrderId,
                error: aggregateError.message
              });
            }

            try {
              if (parentMamOrder && parentMamOrder.mam_account_id) {
                portfolioEvents.emitUserUpdate('mam_account', String(parentMamOrder.mam_account_id), {
                  type: 'mam_parent_child_close_confirmed',
                  mam_order_id: parentMamOrderId,
                  child_order_id: Number(orderIdStr)
                });
              }
            } catch (mamEventError) {
              logger.warn('Failed to emit mam account update after child close', {
                order_id: orderIdStr,
                parent_mam_order_id: parentMamOrderId,
                error: mamEventError.message
              });
            }

            if ((Number(net_profit) || 0) > 0) {
              try {
                logger.info('Calculating MAM performance fee', {
                  liveOrderId: orderIdStr,
                  liveUserId: parseInt(String(user_id), 10),
                  parentMamOrderId,
                  orderNetProfit: Number(net_profit) || 0
                });

                const mamPerformanceFeeResult = await calculateAndApplyMamPerformanceFee({
                  liveOrderId: orderIdStr,
                  liveUserId: parseInt(String(user_id), 10),
                  parentMamOrderId,
                  orderNetProfit: Number(net_profit) || 0,
                  symbol: liveOrderRow.symbol ? String(liveOrderRow.symbol).toUpperCase() : undefined,
                  orderType: liveOrderRow.order_type ? String(liveOrderRow.order_type).toUpperCase() : undefined
                });

                if (mamPerformanceFeeResult.performanceFeeCharged) {
                  logger.info('MAM performance fee applied successfully', {
                    liveOrderId: orderIdStr,
                    parentMamOrderId: mamPerformanceFeeResult.parentMamOrderId,
                    mamAccountId: mamPerformanceFeeResult.mamAccountId,
                    performanceFeeAmount: mamPerformanceFeeResult.performanceFeeAmount,
                    adjustedNetProfit: mamPerformanceFeeResult.adjustedNetProfit
                  });
                }
              } catch (mamPerformanceFeeError) {
                logger.error('Failed to calculate and apply MAM performance fee', {
                  order_id: String(order_id),
                  live_user_id: parseInt(String(user_id), 10),
                  orderNetProfit: Number(net_profit) || 0,
                  error: mamPerformanceFeeError.message
                });
              }
            }
          }
        } catch (postCloseError) {
          logger.error('Failed to process post-close async tasks', {
            order_id: String(order_id),
            user_type: String(user_type),
            error: postCloseError.message
          });
        }
      });
    }

    // Post-commit async tasks for strategy provider OPEN -> copy follower replication
    if (String(type) === 'ORDER_OPEN_CONFIRMED') {
      setImmediate(async () => {
        try {
          const effectiveUserType = String(resolvedUserType || user_type || '').toLowerCase();
          if (effectiveUserType !== 'strategy_provider') {
            return;
          }

          const masterRow = row;
          if (!masterRow) {
            return;
          }

          // Only replicate master orders that have transitioned to OPEN
          const status = String(masterRow.order_status || '').toUpperCase();
          if (status !== 'OPEN') {
            return;
          }

          // StrategyProviderOrder model defaults is_master_order=true; still guard defensively
          if (masterRow.is_master_order === false) {
            return;
          }

          const dist = String(masterRow.copy_distribution_status || '').toLowerCase();
          if (dist === 'completed' || dist === 'distributing') {
            return;
          }

          try {
            await copyTradingService.processStrategyProviderOrder(masterRow);
          } catch (copyErr) {
            logger.error('Failed to replicate strategy provider master order to followers after OPEN', {
              order_id: String(masterRow.order_id || order_id),
              user_type: effectiveUserType,
              user_id: String(resolvedUserId || user_id),
              error: copyErr.message
            });
          }
        } catch (postOpenCopyError) {
          logger.error('Failed to process post-open copy trading tasks', {
            order_id: String(order_id),
            user_type: String(resolvedUserType || user_type),
            user_id: String(resolvedUserId || user_id),
            error: postOpenCopyError.message
          });
        }
      });
    }

    // Post-commit async tasks for MAM pending -> open transitions
    if (String(type) === 'ORDER_OPEN_CONFIRMED' || String(type) === 'ORDER_PENDING_TRIGGERED') {
      setImmediate(async () => {
        try {
          // We only care about live child orders that belong to a MAM parent
          const effectiveUserType = String(resolvedUserType || user_type || '').toLowerCase();
          if (effectiveUserType !== 'live') {
            return;
          }

          const orderIdStr = String(order_id);
          let liveOrderRow = row;

          if (!liveOrderRow || liveOrderRow.parent_mam_order_id == null || liveOrderRow.order_status == null) {
            try {
              liveOrderRow = await LiveUserOrder.findOne({ where: { order_id: orderIdStr } });
            } catch (lookupErr) {
              logger.warn('Post-open async: Failed to load live order row for MAM processing', {
                order_id: orderIdStr,
                error: lookupErr.message
              });
            }
          }

          if (!liveOrderRow) {
            logger.warn('Post-open async: Live order row not found for MAM processing', {
              order_id: orderIdStr
            });
            return;
          }

          const parentMamOrderId = liveOrderRow.parent_mam_order_id;
          if (!parentMamOrderId) {
            logger.info('Post-open async: No parent MAM order associated with child order', {
              order_id: orderIdStr
            });
            return;
          }

          const childStatus = String(liveOrderRow.order_status || '').toUpperCase();
          if (childStatus !== 'OPEN') {
            // Only refresh aggregates when child has actually become OPEN
            logger.info('Post-open async: Skipping MAM aggregate refresh because child status is not OPEN', {
              order_id: orderIdStr,
              order_status: childStatus,
              parent_mam_order_id: parentMamOrderId,
              messageType: String(type)
            });
            return;
          }

          logger.info('Post-open async: Processing MAM parent for child pending trigger/open', {
            order_id: orderIdStr,
            parent_mam_order_id: parentMamOrderId,
            messageType: String(type),
            order_status: childStatus
          });

          try {
            const parentMamOrder = await MAMOrder.findByPk(parentMamOrderId, { attributes: ['id', 'mam_account_id'] });
            await mamOrderService.syncMamAggregates({
              mamOrderId: parentMamOrderId,
              mamAccountId: parentMamOrder?.mam_account_id
            });
          } catch (aggregateError) {
            logger.error('Failed to refresh MAM aggregates after child pending trigger/open', {
              order_id: orderIdStr,
              parent_mam_order_id: parentMamOrderId,
              error: aggregateError.message
            });
          }
        } catch (postOpenError) {
          logger.error('Failed to process post-open MAM tasks', {
            order_id: String(order_id),
            user_type: String(resolvedUserType || user_type || ''),
            error: postOpenError.message
          });
        }
      });
    }

  } catch (transactionError) {
    // Rollback transaction on any error
    try {
      await transaction.rollback();
      logger.error('Database transaction rolled back due to error', {
        orderId: String(order_id),
        messageType: type,
        transactionId: transaction.id,
        error: transactionError.message,
        stack: transactionError.stack,
        timestamp: new Date().toISOString()
      });
    } catch (rollbackError) {
      logger.error('Failed to rollback transaction', {
        orderId: String(order_id),
        transactionError: transactionError.message,
        rollbackError: rollbackError.message,
        timestamp: new Date().toISOString()
      });
    }

    // Release processing lock on error
    await releaseProcessingLock();

    // Re-throw the original error to trigger message requeue
    throw transactionError;
  }
}

async function startOrdersDbConsumer() {
  try {
    rabbitConnection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await rabbitConnection.createChannel();
    await rabbitChannel.assertQueue(ORDER_DB_UPDATE_QUEUE, { durable: true });
    // SCALABILITY: Optimized for 100 orders/second with order-level locking
    const prefetchCount = process.env.RABBITMQ_PREFETCH_COUNT || 25;
    await rabbitChannel.prefetch(parseInt(prefetchCount)); // Allow concurrent processing while preventing same-order conflicts

    logger.info(`Orders DB consumer connected. Listening on ${ORDER_DB_UPDATE_QUEUE}`, {
      prefetchCount: parseInt(prefetchCount),
      targetThroughput: '100 orders/second',
      optimizations: ['order_level_locking', 'deferred_model_hooks', 'separate_redis_pipelines']
    });

    rabbitChannel.consume(ORDER_DB_UPDATE_QUEUE, async (msg) => {
      if (!msg) return;
      let payload = null;
      const messageStartTime = Date.now();
      try {
        payload = JSON.parse(msg.content.toString('utf8'));

        // Enhanced logging for message processing
        logger.info('RabbitMQ message received', {
          messageType: payload.type,
          orderId: payload.order_id,
          userId: payload.user_id,
          userType: payload.user_type,
          orderStatus: payload.order_status,
          hasClosePrice: !!payload.close_price,
          hasNetProfit: !!payload.net_profit,
          hasCommission: !!payload.commission,
          hasUsedMarginExecuted: !!payload.used_margin_executed,
          closeMessage: payload.close_message,
          triggerLifecycleId: payload.trigger_lifecycle_id,
          messageSize: msg.content.length,
          timestamp: new Date().toISOString()
        });

        // Route different message types
        if (payload.type === 'ORDER_REJECTION_RECORD') {
          await handleOrderRejectionRecord(payload);
        } else if (payload.type === 'ORDER_CLOSE_ID_UPDATE') {
          await handleCloseIdUpdate(payload);
        } else if (payload.type === 'MAM_PENDING_CHILD_CANCELLED') {
          await handleMamPendingChildCancel(payload);
        } else if (payload.type === 'MAM_CHILD_AUTOCUTOFF_CLOSED') {
          await handleMamChildAutocutoffClose(payload);
        } else {
          await applyDbUpdate(payload);
        }

        const processingTime = Date.now() - messageStartTime;
        logger.info('Orders DB consumer processed message successfully', {
          messageType: payload.type,
          orderId: payload.order_id,
          processingTimeMs: processingTime,
          timestamp: new Date().toISOString()
        });

        // Performance monitoring - track throughput
        messageCount++;
        const currentTime = Date.now();
        if (currentTime - lastLogTime >= PERFORMANCE_LOG_INTERVAL) {
          const timeElapsed = (currentTime - lastLogTime) / 1000; // seconds
          const messagesPerSecond = messageCount / timeElapsed;

          logger.info('RabbitMQ Consumer Performance Metrics', {
            messagesProcessed: messageCount,
            timeElapsedSeconds: timeElapsed,
            messagesPerSecond: messagesPerSecond.toFixed(2),
            targetThroughput: 100,
            performanceRatio: `${((messagesPerSecond / 100) * 100).toFixed(1)}%`,
            prefetchCount: parseInt(process.env.RABBITMQ_PREFETCH_COUNT || 25),
            timestamp: new Date().toISOString()
          });

          // Reset counters
          messageCount = 0;
          lastLogTime = currentTime;
        }

        rabbitChannel.ack(msg);
      } catch (err) {
        const processingTime = Date.now() - messageStartTime;
        logger.error('Orders DB consumer failed to handle message', {
          error: err.message,
          stack: err.stack,
          messageType: payload?.type || 'unknown',
          orderId: payload?.order_id || 'unknown',
          userId: payload?.user_id || 'unknown',
          userType: payload?.user_type || 'unknown',
          processingTimeMs: processingTime,
          rawMessage: msg.content.toString('utf8').substring(0, 500), // More chars for debugging
          timestamp: new Date().toISOString()
        });
        // Requeue to retry transient failures
        rabbitChannel.nack(msg, false, true);
      }
    }, { noAck: false });

    // Handle connection errors
    rabbitConnection.on('error', (e) => logger.error('AMQP connection error', { error: e.message }));
    rabbitConnection.on('close', () => logger.warn('AMQP connection closed'));
  } catch (err) {
    logger.error('Failed to start Orders DB consumer', { error: err.message });
    // Let the process continue; a supervisor can retry or we can add a backoff/retry here
  }
}

/**
 * Handle post-close and cancellation operations for all user types
 * Follows SOLID principles - Single Responsibility for order completion processing
 * @param {Object} payload - Order update payload
 * @param {Object} row - Updated order row
 */
async function handlePostCloseOperations(payload, row) {
  const { type, user_type, user_id, order_id, used_margin_executed, net_profit } = payload;

  // Process for close confirmations and cancellations
  if (type !== 'ORDER_CLOSE_CONFIRMED' && type !== 'ORDER_PENDING_CANCEL') {
    return;
  }

  try {
    const isCloseConfirmed = type === 'ORDER_CLOSE_CONFIRMED';
    const isCancellation = type === 'ORDER_PENDING_CANCEL';

    // 1. Update user margin for all user types (only for closures, not cancellations)
    if (isCloseConfirmed && typeof used_margin_executed === 'number') {
      await updateUserUsedMargin({
        userType: user_type,
        userId: parseInt(user_id, 10),
        usedMargin: used_margin_executed
      });

      // Emit portfolio events
      try {
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'user_margin_update',
          used_margin_usd: used_margin_executed
        });
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'order_update',
          order_id,
          update: { order_status: 'CLOSED' }
        });
      } catch (eventErr) {
        logger.warn('Failed to emit portfolio events', {
          order_id,
          error: eventErr.message
        });
      }
    }

    // Emit cancellation events
    if (isCancellation) {
      try {
        portfolioEvents.emitUserUpdate(user_type, user_id, {
          type: 'order_update',
          order_id,
          update: { order_status: 'CANCELLED' }
        });
      } catch (eventErr) {
        logger.warn('Failed to emit cancellation events', {
          order_id,
          error: eventErr.message
        });
      }
    }

    // 2. Net profit update is now handled by applyOrderClosePayout service
    // Removed from here to avoid double accounting

    // 3. Update comprehensive statistics for strategy providers (only for closures)
    if (isCloseConfirmed && user_type === 'strategy_provider') {
      await updateStrategyProviderStatistics(user_id, order_id);
    }

    // 4. Handle copy trading distribution for strategy providers (for both closures AND cancellations)
    if (user_type === 'strategy_provider' && row) {
      logger.info('Processing strategy provider order for copy trading', {
        orderId: order_id,
        orderStatus: row.order_status,
        messageType: type,
        isCloseConfirmed,
        isCancellation
      });
      await handleStrategyProviderCopyTrading(row);
    }

  } catch (error) {
    logger.error('Failed to handle post-close operations', {
      order_id,
      user_type,
      user_id,
      error: error.message
    });
  }
}

/**
 * Update comprehensive statistics for strategy provider account
 * @param {string} userId - Strategy provider user ID
 * @param {string} orderId - ID of the closed order
 */
async function updateStrategyProviderStatistics(userId, orderId) {
  try {
    // First, let's check the actual order to see what user_id it has
    const order = await StrategyProviderOrder.findOne({
      where: { order_id: orderId },
      attributes: ['id', 'order_id', 'order_user_id', 'order_status', 'net_profit']
    });

    logger.info('Looking for strategy provider account for statistics update', {
      userId,
      userIdType: typeof userId,
      parsedUserId: parseInt(userId, 10),
      orderId,
      orderDetails: order ? {
        id: order.id,
        order_id: order.order_id,
        order_user_id: order.order_user_id,
        order_status: order.order_status,
        net_profit: order.net_profit
      } : null
    });

    if (!order) {
      logger.warn('Strategy provider order not found for statistics update', {
        userId,
        orderId
      });
      return;
    }

    // The order_user_id is the strategy provider account ID, not the user ID
    // So we should find the strategy provider account by its ID (order_user_id)
    const strategyProvider = await StrategyProviderAccount.findByPk(order.order_user_id);

    if (!strategyProvider) {
      logger.warn('Strategy provider account not found for statistics update', {
        userId,
        orderId,
        orderUserId: order.order_user_id,
        message: 'Strategy provider account not found by order_user_id'
      });
      return;
    }

    logger.info('Found strategy provider account for statistics update', {
      userId,
      orderId,
      strategyProviderId: strategyProvider.id,
      strategyProviderUserId: strategyProvider.user_id,
      strategyName: strategyProvider.strategy_name
    });

    // Update comprehensive statistics using the dedicated service
    // This is done asynchronously to avoid blocking the DB consumer
    setImmediate(async () => {
      try {
        await StrategyProviderStatsService.updateStatisticsAfterOrderClose(
          strategyProvider.id,
          orderId
        );

        logger.info('Strategy provider statistics updated from DB consumer', {
          userId,
          strategyProviderId: strategyProvider.id,
          orderId
        });
      } catch (statsError) {
        logger.error('Failed to update strategy provider statistics from DB consumer', {
          userId,
          strategyProviderId: strategyProvider.id,
          orderId,
          error: statsError.message
        });
      }
    });

  } catch (error) {
    logger.error('Failed to initiate strategy provider statistics update', {
      userId,
      orderId,
      error: error.message
    });
  }
}

/**
 * Handle copy trading distribution for strategy provider order close
 * Follows Open/Closed principle - extensible without modifying existing code
 * @param {Object} masterOrder - Strategy provider order
 */
async function handleStrategyProviderCopyTrading(masterOrder) {
  try {
    logger.info('Processing strategy provider order close for copy trading', {
      orderId: masterOrder.order_id,
      orderStatus: masterOrder.order_status
    });

    // Use existing copy trading service to handle follower order distribution
    await copyTradingService.processStrategyProviderOrderUpdate(masterOrder);

    logger.info('Strategy provider copy trading distribution completed', {
      orderId: masterOrder.order_id
    });

  } catch (error) {
    logger.error('Failed to process strategy provider copy trading', {
      orderId: masterOrder.order_id,
      error: error.message
    });
  }
}

/**
 * Get user model based on user type
 * Follows Dependency Inversion - depends on abstraction
 * @param {string} userType - Type of user
 * @returns {Object} User model
 */
function getUserModel(userType) {
  switch (userType) {
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

// Graceful shutdown function for RabbitMQ connections
async function shutdownOrdersDbConsumer() {
  try {
    logger.info('🔄 Shutting down Orders DB consumer...');

    if (rabbitChannel) {
      await rabbitChannel.close();
      logger.info('✅ RabbitMQ channel closed');
    }

    if (rabbitConnection) {
      await rabbitConnection.close();
      logger.info('✅ RabbitMQ connection closed');
    }

    logger.info('✅ Orders DB consumer shutdown completed');
  } catch (err) {
    logger.error('❌ Error during Orders DB consumer shutdown:', err.message);
    throw err;
  }
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeConversionMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  return {
    from_currency: meta.from_currency ? String(meta.from_currency).toUpperCase() : null,
    pair: meta.pair ? String(meta.pair).toUpperCase() : null,
    rate: toNumber(meta.rate),
    invert: Boolean(meta.invert),
    source: meta.source ? String(meta.source) : null
  };
}

function logOrderOpenCalculation(message, context = {}) {
  try {
    if (!message || message.type !== 'ORDER_OPEN_CONFIRMED') {
      return;
    }

    const row = context.row || {};
    const userId = context.userId || message.user_id;
    const userType = context.userType || message.user_type;

    const flow = message.flow || row.execution || 'local';
    const symbol = row.symbol || message.symbol;
    const orderType = row.order_type || message.order_type;

    const logPayload = {
      type: 'ORDER_OPEN_CALC',
      source: 'node_orders_db_consumer',
      flow: flow || 'local',
      order_id: message.order_id != null ? String(message.order_id) : null,
      user_id: userId != null ? String(userId) : null,
      user_type: userType != null ? String(userType) : null,
      symbol: symbol ? String(symbol).toUpperCase() : null,
      side: orderType ? normalizeOrderType(orderType) : null,
      final_exec_price: toNumber(message.order_price ?? row.order_price),
      final_order_qty: toNumber(message.order_quantity ?? row.order_quantity),
      single_margin_usd: toNumber(message.margin ?? row.margin),
      commission_entry: toNumber(message.commission ?? row.commission),
      contract_value: toNumber(message.contract_value ?? row.contract_value),
      used_margin_usd: toNumber(message.used_margin_usd ?? message.used_margin_executed),
      used_margin_executed: toNumber(message.used_margin_executed),
      used_margin_all: toNumber(message.used_margin_all),
      timestamp: new Date().toISOString()
    };

    logger.ordersCalculated(logPayload);
  } catch (error) {
    logger.warn('Failed to log calculation for ORDER_OPEN_CONFIRMED', {
      error: error.message,
      order_id: message?.order_id
    });
  }
}

function logLocalCloseCalculation(message, context = {}) {
  try {
    if (!message || message.type !== 'ORDER_CLOSE_CONFIRMED') {
      return;
    }

    const flow = message.flow || message.close_origin || 'local';
    const origin = message.close_origin || flow;
    if (origin && origin !== 'local' && flow !== 'local') {
      return;
    }

    const row = context.row || {};
    const userId = context.userId || message.user_id;
    const userType = context.userType || message.user_type;
    const symbol = row.symbol || message.symbol;
    const orderType = row.order_type || message.order_type;

    const logPayload = {
      type: 'ORDER_CLOSE_CALC',
      stage: message.calculation_stage || 'db_consumer',
      source: 'node_orders_db_consumer',
      flow: flow || 'local',
      origin: origin || 'local',
      order_id: message.order_id != null ? String(message.order_id) : null,
      user_id: userId != null ? String(userId) : null,
      user_type: userType != null ? String(userType) : null,
      symbol: symbol ? String(symbol).toUpperCase() : null,
      order_type: orderType ? normalizeOrderType(orderType) : null,
      quantity: toNumber(message.quantity ?? row.order_quantity),
      contract_size: toNumber(message.contract_size),
      entry_price: toNumber(message.entry_price ?? row.order_price),
      market_close_price: toNumber(message.market_close_price),
      half_spread: toNumber(message.half_spread),
      close_price_adjusted: toNumber(message.close_price_adjusted),
      close_price: toNumber(message.close_price ?? row.close_price),
      pnl_native: toNumber(message.pnl_native),
      net_profit: toNumber(message.net_profit ?? row.net_profit),
      commission_total: toNumber(message.commission ?? row.commission),
      commission_entry: toNumber(message.commission_entry),
      commission_exit: toNumber(message.commission_exit),
      profit_usd: toNumber(message.profit_usd),
      swap: toNumber(message.swap ?? row.swap),
      used_margin_executed: toNumber(message.used_margin_executed),
      used_margin_all: toNumber(message.used_margin_all),
      contract_value: toNumber(row.contract_value ?? message.contract_value),
      margin: toNumber(row.margin ?? message.margin),
      profit_currency: message.profit_currency ? String(message.profit_currency).toUpperCase() : null,
      conversion: normalizeConversionMeta(message.conversion),
      close_message: message.close_message || null,
      trigger_lifecycle_id: message.trigger_lifecycle_id || null,
      timestamp: new Date().toISOString()
    };

    logger.ordersCalculated(logPayload);
  } catch (error) {
    logger.warn('Failed to log calculation for ORDER_CLOSE_CONFIRMED', {
      error: error.message,
      order_id: message?.order_id
    });
  }
}

module.exports = { startOrdersDbConsumer, shutdownOrdersDbConsumer };
