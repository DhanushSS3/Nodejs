const { Op } = require('sequelize');
const sequelize = require('../config/db');
const { redisCluster } = require('../../config/redis');
const logger = require('./logger.service');
const { pythonServiceAxios } = require('./python.service');
const groupsCache = require('./groups.cache.service');
const lotValidationService = require('./lot.validation.service');
const { acquireUserLock, releaseUserLock } = require('./userLock.service');
const { updateUserUsedMargin } = require('./user.margin.service');
const idGenerator = require('./idGenerator.service');
const portfolioEvents = require('./events/portfolio.events');
const orderLifecycleService = require('./orderLifecycle.service');
const { resolveOpenOrder } = require('./order.resolver.service');
const { refreshMamAccountAggregates } = require('./mamAggregates.service');

const MAMAccount = require('../models/mamAccount.model');
const MAMAssignment = require('../models/mamAssignment.model');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const MAMOrder = require('../models/mamOrder.model');

const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');

const ORDER_STATUS = {
  QUEUED: 'QUEUED',
  OPEN: 'OPEN',
  REJECTED: 'REJECTED'
};
const VALID_ORDER_TYPES = ['BUY', 'SELL'];
const VALID_PENDING_ORDER_TYPES = ['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'];
const OPEN_CHILD_STATUSES = ['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'];
const PENDING_CHILD_STATUSES = ['PENDING', 'PENDING-QUEUED', 'PENDING-CANCEL', 'MODIFY'];

class MAMOrderService {
  async placeInstantOrder({
    mamAccountId,
    managerId,
    payload
  }) {
    const validation = this._validatePayload(payload);
    if (!validation.valid) {
      const error = new Error(validation.message);
      error.statusCode = 400;
      throw error;
    }

    const {
      symbol,
      order_type,
      order_price,
      volume,
      stop_loss,
      take_profit
    } = validation.data;

    const mamAccount = await MAMAccount.findByPk(mamAccountId);
    if (!mamAccount || mamAccount.status !== 'active') {
      const error = new Error('MAM account is not active or not found');
      error.statusCode = 404;
      throw error;
    }

    const assignments = await this._getActiveAssignments(mamAccountId);
    if (!assignments.length) {
      const error = new Error('No active investors assigned to this MAM');
      error.statusCode = 409;
      throw error;
    }

    const groupName = mamAccount.group;
    const groupFields = await groupsCache.getGroupFields(
      groupName,
      symbol,
      ['type', 'contract_size', 'margin', 'group_margin', 'crypto_margin_factor']
    );
    await this._assertMarketOpen(groupFields?.type);

    const freeMarginSnapshots = await this._fetchFreeMargins(assignments);
    const totalFreeMargin = freeMarginSnapshots.reduce((acc, snap) => acc + snap.free_margin, 0);
    if (!(totalFreeMargin > 0)) {
      const error = new Error('All investors have zero free margin. Cannot allocate order.');
      error.statusCode = 409;
      throw error;
    }

    const allocation = this._computeAllocation({
      assignments,
      freeMarginSnapshots,
      totalVolume: volume,
      precision: Number(mamAccount.allocation_precision || 0.01)
    });

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    const transaction = await sequelize.transaction();
    let mamOrder = null;
    try {
      mamOrder = await MAMOrder.create({
        mam_account_id: mamAccountId,
        symbol,
        order_type,
        order_status: ORDER_STATUS.QUEUED,
        requested_volume: volume,
        allocation_method: mamAccount.allocation_method || 'free_margin',
        total_balance_snapshot: freeMarginSnapshots.reduce((acc, snap) => acc + snap.balance, 0),
        total_free_margin_snapshot: totalFreeMargin,
        // Persist initial SL/TP on the MAM order itself
        stop_loss: stop_loss != null ? Number(stop_loss) : null,
        take_profit: take_profit != null ? Number(take_profit) : null,
        metadata: {
          initiated_by: managerId,
          stop_loss,
          take_profit
        }
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      logger.error('Failed to create MAM order', { error: error.message, mamAccountId });
      await releaseUserLock(mamLock);
      throw error;
    }

    const executionPrice = await this._resolveExecutionPrice({
      symbol,
      order_type,
      fallbackPrice: order_price
    });

    const executionSummary = await this._executeAllocations({
      mamOrder,
      allocation,
      mamAccount,
      symbol,
      order_type,
      order_price: executionPrice,
      stop_loss,
      take_profit,
      groupFields
    });

    logger.info('MAM order execution completed', {
      mam_account_id: mamAccountId,
      mam_order_id: mamOrder.id,
      requested_volume: volume,
      executed_volume: executionSummary.executedVolume,
      rejected_investors: executionSummary.rejectedCount,
      rejected_volume: executionSummary.rejectedVolume,
      allocation_preview: executionSummary.allocationSnapshot?.map((entry) => ({
        client_id: entry.client_id,
        allocated_volume: entry.allocated_volume,
        status: entry.status,
        reason: entry.reason
      }))
    });

    await mamOrder.update({
      execution_summary: executionSummary.executionSnapshot,
      allocation_snapshot: executionSummary.allocationSnapshot,
      executed_volume: executionSummary.executedVolume,
      rejected_investors_count: executionSummary.rejectedCount,
      rejected_volume: executionSummary.rejectedVolume,
      total_aggregated_margin: executionSummary.totalMargin,
      order_status: executionSummary.executedVolume > 0 ? ORDER_STATUS.OPEN : ORDER_STATUS.QUEUED
    });

    await this._updateMamAccountAggregates(mamAccount.id);

    try {
      // Emit initial MAM order state including current SL/TP
      portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
        type: 'mam_order_update',
        mam_order_id: mamOrder.id,
        executed_volume: executionSummary.executedVolume,
        rejected_investors: executionSummary.rejectedCount,
        stop_loss: mamOrder.stop_loss != null ? Number(mamOrder.stop_loss) : null,
        take_profit: mamOrder.take_profit != null ? Number(mamOrder.take_profit) : null,
      });
    } catch (error) {
      logger.warn('Failed to emit MAM order update event', {
        mam_account_id: mamAccountId,
        mam_order_id: mamOrder.id,
        error: error.message
      });
    } finally {
      await releaseUserLock(mamLock);
    }

    return {
      mam_order_id: mamOrder.id,
      requested_volume: volume,
      executed_volume: executionSummary.executedVolume,
      rejected_investors: executionSummary.rejectedCount,
      rejected_volume: executionSummary.rejectedVolume,
      allocation: executionSummary.allocationSnapshot
    };
  }

  async placePendingOrder({
    mamAccountId,
    managerId,
    payload
  }) {
    const validation = this._validatePendingPayload(payload);
    if (!validation.valid) {
      const error = new Error(validation.message);
      error.statusCode = 400;
      throw error;
    }

    const {
      symbol,
      order_type,
      order_price,
      volume
    } = validation.data;

    const mamAccount = await MAMAccount.findByPk(mamAccountId);
    if (!mamAccount || mamAccount.status !== 'active') {
      const error = new Error('MAM account is not active or not found');
      error.statusCode = 404;
      throw error;
    }

    const assignments = await this._getActiveAssignments(mamAccountId);
    if (!assignments.length) {
      const error = new Error('No active investors assigned to this MAM');
      error.statusCode = 409;
      throw error;
    }

    const groupName = mamAccount.group;
    const groupFields = await groupsCache.getGroupFields(
      groupName,
      symbol,
      ['type', 'contract_size', 'margin', 'group_margin', 'crypto_margin_factor', 'spread', 'spread_pip']
    );
    await this._assertMarketOpen(groupFields?.type);

    const halfSpread = this._computeHalfSpreadFromGroupFields(groupFields);
    if (!(halfSpread >= 0)) {
      const error = new Error('Group spread configuration missing for pending orders');
      error.statusCode = 400;
      throw error;
    }

    const freeMarginSnapshots = await this._fetchFreeMargins(assignments);
    const totalFreeMargin = freeMarginSnapshots.reduce((acc, snap) => acc + snap.free_margin, 0);
    if (!(totalFreeMargin > 0)) {
      const error = new Error('All investors have zero free margin. Cannot allocate order.');
      error.statusCode = 409;
      throw error;
    }

    const allocation = this._computeAllocation({
      assignments,
      freeMarginSnapshots,
      totalVolume: volume,
      precision: Number(mamAccount.allocation_precision || 0.01)
    });

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    const transaction = await sequelize.transaction();
    let mamOrder = null;
    try {
      mamOrder = await MAMOrder.create({
        mam_account_id: mamAccountId,
        symbol,
        order_type,
        order_status: 'PENDING',
        requested_volume: volume,
        allocation_method: mamAccount.allocation_method || 'free_margin',
        total_balance_snapshot: freeMarginSnapshots.reduce((acc, snap) => acc + snap.balance, 0),
        total_free_margin_snapshot: totalFreeMargin,
        metadata: {
          initiated_by: managerId,
          order_price,
          order_kind: 'pending'
        }
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      await releaseUserLock(mamLock);
      logger.error('Failed to create MAM pending order', { error: error.message, mamAccountId });
      throw error;
    }

    const allocationSnapshot = [];
    const pendingOrders = [];
    let rejectedCount = 0;
    let rejectedVolume = 0;
    let acceptedVolume = 0;

    try {
      for (const slot of allocation) {
        const lots = Number(slot.allocated_volume || 0);
        const snapshot = slot.snapshot || freeMarginSnapshots.find((s) => s.client_id === slot.assignment?.client_live_user_id);

        if (!(lots > 0)) {
          allocationSnapshot.push(this._buildSnapshotEntry({
            assignment: slot.assignment,
            snapshot,
            lots,
            status: 'rejected',
            reason: 'zero_allocation_after_rounding'
          }));
          rejectedCount += 1;
          rejectedVolume += lots;
          continue;
        }

        const result = await this._placeClientPendingOrder({
          mamOrderId: mamOrder.id,
          assignment: slot.assignment,
          mamAccount,
          symbol,
          order_type,
          order_price,
          lots,
          halfSpread
        });

        allocationSnapshot.push(this._buildSnapshotEntry({
          assignment: slot.assignment,
          snapshot,
          lots,
          status: result.success ? 'pending_submitted' : 'rejected',
          reason: result.reason,
          order_id: result.order_id
        }));

        if (result.success) {
          acceptedVolume += lots;
          pendingOrders.push({
            client_id: slot.assignment.client_live_user_id,
            order_id: result.order_id,
            compare_price: result.compare_price,
            flow: result.flow,
            order_status: result.order_status,
            allocated_volume: lots
          });
        } else {
          rejectedCount += 1;
          rejectedVolume += lots;
        }
      }

      if (!pendingOrders.length) {
        await mamOrder.update({
          order_status: 'REJECTED',
          allocation_snapshot: allocationSnapshot,
          rejected_investors_count: rejectedCount,
          rejected_volume: rejectedVolume
        });
        const error = new Error('Failed to submit pending orders for any investor');
        error.statusCode = 502;
        error.details = allocationSnapshot;
        throw error;
      }

      await mamOrder.update({
        order_status: 'PENDING',
        allocation_snapshot: allocationSnapshot,
        rejected_investors_count: rejectedCount,
        rejected_volume: rejectedVolume,
        executed_volume: 0,
        total_aggregated_margin: 0,
        metadata: {
          ...(mamOrder.metadata || {}),
          pending_submissions: pendingOrders.length
        }
      });

      await this._updateMamAccountAggregates(mamAccount.id);

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_pending_order_update',
          mam_order_id: mamOrder.id,
          pending_orders: pendingOrders.length,
          rejected_investors: rejectedCount
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM pending order event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrder.id,
          error: eventError.message
        });
      }

      return {
        mam_order_id: mamOrder.id,
        requested_volume: volume,
        accepted_volume: acceptedVolume,
        pending_orders: pendingOrders,
        rejected_investors: rejectedCount,
        rejected_volume: rejectedVolume,
        allocation: allocationSnapshot
      };
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async cancelPendingOrder({ mamAccountId, managerId, payload }) {
    const {
      order_id: mamOrderIdRaw,
      cancel_message,
      status
    } = payload || {};

    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      const error = new Error('order_id must be a valid MAM order id');
      error.statusCode = 400;
      throw error;
    }

    const mamOrder = await MAMOrder.findByPk(mamOrderId);
    if (!mamOrder || mamOrder.mam_account_id !== mamAccountId) {
      const error = new Error('MAM order not found for this account');
      error.statusCode = 404;
      throw error;
    }

    const currentStatus = String(mamOrder.order_status || '').toUpperCase();
    if (!PENDING_CHILD_STATUSES.includes(currentStatus)) {
      const error = new Error(`MAM order is not pending (status=${currentStatus})`);
      error.statusCode = 409;
      throw error;
    }

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    try {
      const childOrders = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: {
            [Op.in]: PENDING_CHILD_STATUSES
          }
        }
      });

      if (!childOrders.length) {
        const error = new Error('No pending child orders to cancel for this MAM order');
        error.statusCode = 409;
        throw error;
      }

      const effectiveStatus = String(status || 'CANCELLED').toUpperCase();
      const cancelMessage = cancel_message || 'Cancelled by MAM manager';

      const results = await Promise.allSettled(childOrders.map((order) => (
        this._cancelChildPendingOrder({
          order,
          cancelMessage,
          status: effectiveStatus,
          mamOrderId,
          mamAccountId
        })
      )));

      const summary = results.reduce((acc, result, idx) => {
        const order = childOrders[idx];
        if (result.status === 'fulfilled') {
          const value = result.value || {};
          if (value.skipped) {
            acc.skipped += 1;
            acc.skippedOrders.push({ order_id: order.order_id, reason: value.reason });
          } else if (value.success) {
            acc.cancelled += 1;
            acc.cancelledOrders.push({ order_id: order.order_id, flow: value.flow || 'local' });
          } else {
            acc.failed += 1;
            acc.failedOrders.push({ order_id: order.order_id, reason: value.reason || 'unknown_error' });
          }
        } else {
          acc.failed += 1;
          acc.failedOrders.push({ order_id: order.order_id, reason: result.reason?.message || 'cancel_failed' });
        }
        return acc;
      }, {
        total: childOrders.length,
        cancelled: 0,
        failed: 0,
        skipped: 0,
        cancelledOrders: [],
        failedOrders: [],
        skippedOrders: []
      });

      // Update parent MAM order status/metadata when no pending children remain
      try {
        const remaining = await LiveUserOrder.count({
          where: {
            parent_mam_order_id: mamOrderId,
            order_status: {
              [Op.in]: PENDING_CHILD_STATUSES
            }
          }
        });

        const updates = {};
        if (!remaining) {
          updates.order_status = 'CANCELLED';
        }
        updates.metadata = {
          ...(mamOrder.metadata || {}),
          last_cancelled_by: `mam_manager:${managerId}`,
          last_cancel_message: cancelMessage,
          last_cancel_at: new Date().toISOString()
        };

        await mamOrder.update(updates);
      } catch (updateError) {
        logger.warn('Failed to update MAM parent order after pending cancel', {
          mam_order_id: mamOrderId,
          error: updateError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_pending_cancel_summary',
          mam_order_id: mamOrderId,
          summary
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM pending cancel summary event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrderId,
          error: eventError.message
        });
      }

      return summary;
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async _cancelChildPendingOrder({ order, cancelMessage, status, mamAccountId, mamOrderId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;
    const currentStatus = String(order.order_status || '').toUpperCase();
    if (!PENDING_CHILD_STATUSES.includes(currentStatus)) {
      return { skipped: true, reason: `status_${currentStatus}` };
    }

    let canonical = null;
    try {
      canonical = await redisCluster.hgetall(`order_data:${orderId}`);
      if (canonical && Object.keys(canonical).length === 0) {
        canonical = null;
      }
    } catch (error) {
      logger.warn('Failed to fetch canonical order for pending cancel', {
        order_id: orderId,
        error: error.message
      });
    }

    const symbol = canonical?.symbol
      ? String(canonical.symbol).toUpperCase()
      : String(order.symbol || order.order_company_name).toUpperCase();
    const orderType = canonical?.order_type
      ? String(canonical.order_type).toUpperCase()
      : String(order.order_type).toUpperCase();

    let isProviderFlow = false;
    try {
      const cfg = await redisCluster.hgetall(`user:{live:${userId}}:config`);
      const sendPref = cfg?.sending_orders ? String(cfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = sendPref === 'barclays';
    } catch (error) {
      logger.warn('Failed to read provider config for pending cancel', {
        order_id: orderId,
        error: error.message
      });
    }

    if (!isProviderFlow) {
      await this._finalizeLocalPendingCancel({
        order,
        symbol,
        orderType,
        cancelMessage,
        mamOrderId,
        mamAccountId
      });
      return { success: true, flow: 'local' };
    }

    const cancel_id = await idGenerator.generateCancelOrderId();
    if (!cancel_id) {
      return { success: false, reason: 'cancel_id_generation_failed' };
    }

    try {
      await order.update({ cancel_id, status });
    } catch (error) {
      logger.warn('Failed to persist cancel_id on child pending order', {
        order_id: orderId,
        error: error.message
      });
    }

    await this._mirrorPendingCancelStatus({ userId, orderId, status, cancel_id });

    const pyPayload = {
      order_id: orderId,
      cancel_id,
      order_type: orderType,
      user_id: String(userId),
      user_type: 'live',
      status: 'CANCELLED',
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      source: 'mam'
    };

    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      await pythonServiceAxios.post(
        `${baseUrl}/api/orders/pending/cancel`,
        pyPayload,
        { timeout: 5000 }
      );
      return { success: true, flow: 'provider', cancel_id };
    } catch (error) {
      logger.error('Python pending cancel failed for MAM child order', {
        order_id: orderId,
        parent_mam_order_id: mamOrderId,
        error: error.message
      });
      return { success: false, reason: error?.response?.data?.message || 'python_pending_cancel_failed' };
    }
  }

  async _finalizeLocalPendingCancel({ order, symbol, orderType, cancelMessage, mamOrderId, mamAccountId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;

    try {
      await redisCluster.zrem(`pending_index:{${symbol}}:${orderType}`, orderId);
    } catch (error) {
      logger.warn('Failed to remove order from pending index during cancel', {
        order_id: orderId,
        error: error.message
      });
    }

    try {
      await redisCluster.del(`pending_orders:${orderId}`);
    } catch (error) {
      logger.warn('Failed to delete pending order hash during cancel', {
        order_id: orderId,
        error: error.message
      });
    }

    try {
      const tag = `live:${userId}`;
      const idxKey = `user_orders_index:{${tag}}`;
      const holdingKey = `user_holdings:{${tag}}:${orderId}`;
      const pipeline = redisCluster.pipeline();
      pipeline.srem(idxKey, orderId);
      pipeline.del(holdingKey);
      await pipeline.exec();
    } catch (error) {
      logger.warn('Failed to cleanup user holdings during pending cancel', {
        order_id: orderId,
        error: error.message
      });
    }

    try {
      await redisCluster.del(`order_data:${orderId}`);
    } catch (error) {
      logger.warn('Failed to delete order_data during pending cancel', {
        order_id: orderId,
        error: error.message
      });
    }

    try {
      await order.update({
        order_status: 'CANCELLED',
        status: 'CANCELLED',
        close_message: cancelMessage
      });
    } catch (error) {
      logger.warn('Failed to persist SQL cancel status for child order', {
        order_id: orderId,
        error: error.message
      });
    }

    try {
      portfolioEvents.emitUserUpdate('live', String(order.order_user_id), {
        type: 'order_update',
        order_id: orderId,
        update: {
          order_status: 'CANCELLED',
          parent_mam_order_id: mamOrderId
        },
        reason: 'mam_pending_cancel'
      });
      portfolioEvents.emitUserUpdate('live', String(order.order_user_id), {
        type: 'pending_cancelled',
        order_id: orderId,
        reason: 'mam_pending_cancel'
      });
    } catch (error) {
      logger.warn('Failed to emit user update for pending cancel', {
        order_id: orderId,
        error: error.message
      });
    }
  }

  async _mirrorPendingCancelStatus({ userId, orderId, status, cancel_id }) {
    const tag = `live:${userId}`;
    const holdingKey = `user_holdings:{${tag}}:${orderId}`;
    const canonicalKey = `order_data:${orderId}`;

    try {
      await redisCluster.hset(holdingKey, {
        cancel_id: String(cancel_id),
        status
      });
    } catch (error) {
      logger.warn('Failed to mirror cancel info to holdings', {
        order_id: orderId,
        error: error.message
      });
    }

    try {
      await redisCluster.hset(canonicalKey, {
        cancel_id: String(cancel_id),
        status
      });
    } catch (error) {
      logger.warn('Failed to mirror cancel info to canonical data', {
        order_id: orderId,
        error: error.message
      });
    }
  }

  async _resolveExecutionPrice({ symbol, order_type, fallbackPrice }) {
    const normalizedSymbol = (symbol || '').toUpperCase();
    const side = (order_type || '').toUpperCase();

    try {
      const [bidRaw, askRaw] = await redisCluster.hmget(`market:${normalizedSymbol}`, 'bid', 'ask');
      const bid = bidRaw != null ? Number(bidRaw) : null;
      const ask = askRaw != null ? Number(askRaw) : null;

      if (side === 'SELL' && Number.isFinite(bid) && bid > 0) {
        return bid;
      }

      if (Number.isFinite(ask) && ask > 0) {
        return ask;
      }

      if (Number.isFinite(bid) && bid > 0) {
        return bid;
      }
    } catch (error) {
      logger.warn('Failed to fetch market price for MAM order, using fallback price', {
        symbol: normalizedSymbol,
        error: error.message
      });
    }

    if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
      return Number(fallbackPrice);
    }

    const err = new Error('Market price unavailable for symbol');
    err.statusCode = 503;
    throw err;
  }

  async _resolveClosePrice({ symbol, orderType, fallbackPrice }) {
    const normalizedSymbol = (symbol || '').toUpperCase();
    const baseSide = (orderType || '').toUpperCase();
    const prefersBid = baseSide === 'BUY'; // Closing BUY means SELL -> bid

    try {
      const [bidRaw, askRaw] = await redisCluster.hmget(`market:${normalizedSymbol}`, 'bid', 'ask');
      const bid = bidRaw != null ? Number(bidRaw) : null;
      const ask = askRaw != null ? Number(askRaw) : null;

      const preferred = prefersBid ? bid : ask;
      const secondary = prefersBid ? ask : bid;

      if (Number.isFinite(preferred) && preferred > 0) {
        return preferred;
      }
      if (Number.isFinite(secondary) && secondary > 0) {
        return secondary;
      }
    } catch (error) {
      logger.warn('Failed to fetch market close price', { symbol: normalizedSymbol, error: error.message });
    }

    if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
      return Number(fallbackPrice);
    }

    const err = new Error('Market close price unavailable for symbol');
    err.statusCode = 503;
    throw err;
  }

  async closeMamOrder({ mamAccountId, managerId, payload }) {
    const {
      order_id: mamOrderIdRaw,
      symbol,
      order_type,
      status = 'CLOSED',
      order_status = 'CLOSED',
      close_price,
      close_message
    } = payload || {};

    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      const error = new Error('order_id must be a valid MAM order id');
      error.statusCode = 400;
      throw error;
    }

    const mamOrder = await MAMOrder.findByPk(mamOrderId);
    if (!mamOrder || mamOrder.mam_account_id !== mamAccountId) {
      const error = new Error('MAM order not found for this account');
      error.statusCode = 404;
      throw error;
    }

    const mamAccount = await MAMAccount.findByPk(mamAccountId);
    if (!mamAccount || mamAccount.status !== 'active') {
      const error = new Error('MAM account is not active or not found');
      error.statusCode = 403;
      throw error;
    }

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    try {
      const childOrders = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: {
            [Op.in]: OPEN_CHILD_STATUSES
          }
        }
      });

      if (!childOrders.length) {
        const error = new Error('No active child orders to close for this MAM order');
        error.statusCode = 409;
        throw error;
      }

      const closePayload = {
        symbol,
        order_type,
        status: status || 'CLOSED',
        order_status: order_status || 'CLOSED',
        close_price: Number.isFinite(close_price) && close_price > 0 ? Number(close_price) : undefined
      };

      const closeResults = await Promise.allSettled(childOrders.map((order) => (
        this._closeChildOrder({
          order,
          closePayload,
          mamAccountId,
          mamOrderId,
          managerId
        })
      )));

      const summary = closeResults.reduce((acc, result, idx) => {
        const order = childOrders[idx];
        if (result.status === 'fulfilled') {
          const value = result.value || {};
          if (value.skipped) {
            acc.skipped += 1;
            acc.skippedOrders.push({ order_id: order.order_id, reason: value.reason });
          } else if (value.success) {
            acc.successful += 1;
            acc.successOrders.push({ order_id: order.order_id, close_id: value.close_id, flow: value.flow });
          } else {
            acc.failed += 1;
            acc.failedOrders.push({ order_id: order.order_id, reason: value.reason || 'unknown_error' });
          }
        } else {
          acc.failed += 1;
          acc.failedOrders.push({ order_id: order.order_id, reason: result.reason?.message || 'close_failed' });
        }
        return acc;
      }, {
        total: childOrders.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        successOrders: [],
        failedOrders: [],
        skippedOrders: []
      });

      if (!summary.successful) {
        const error = new Error('Failed to close any child orders. See details for errors.');
        error.statusCode = 502;
        error.details = summary;
        throw error;
      }

      await this.syncMamAggregates({ mamOrderId, mamAccountId });

      // Store a high-level close message on the MAM order if provided
      if (close_message && String(close_message).trim()) {
        try {
          await mamOrder.update({ close_message: String(close_message).trim() });
        } catch (e) {
          logger.warn('Failed to update MAM order close_message', {
            mam_order_id: mamOrderId,
            error: e.message
          });
        }
      }

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_order_close_progress',
          mam_order_id: mamOrderId,
          summary,
          close_message: mamOrder.close_message || (close_message ? String(close_message).trim() : null)
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM order close progress event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrderId,
          error: eventError.message
        });
      }

      return summary;
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async _getActiveAssignments(mamAccountId) {
    return MAMAssignment.findAll({
      where: {
        mam_account_id: mamAccountId,
        status: ASSIGNMENT_STATUS.ACTIVE
      },
      include: [{
        model: LiveUser,
        as: 'client'
      }]
    });
  }

  async _fetchFreeMargins(assignments) {
    const pipelines = [];
    for (const assignment of assignments) {
      const clientId = assignment.client_live_user_id;
      const redisKey = `user_portfolio:{live:${clientId}}`;
      pipelines.push(redisCluster.hgetall(redisKey).then((data) => {
        const freeMargin = this._toNumber(data?.free_margin);
        const balance = this._toNumber(data?.balance);
        const usedMargin = this._toNumber(data?.used_margin);
        return {
          client_id: clientId,
          free_margin: Number.isFinite(freeMargin) ? freeMargin : Math.max(Number(assignment?.client?.wallet_balance) || 0, 0),
          balance: Number.isFinite(balance) ? balance : Number(assignment?.client?.wallet_balance) || 0,
          used_margin: Number.isFinite(usedMargin) ? usedMargin : 0
        };
      }).catch((error) => {
        logger.warn('Failed to fetch portfolio snapshot for client', { clientId, error: error.message });
        return {
          client_id: clientId,
          free_margin: Math.max(Number(assignment?.client?.wallet_balance) || 0, 0),
          balance: Number(assignment?.client?.wallet_balance) || 0,
          used_margin: 0
        };
      }));
    }
    return Promise.all(pipelines);
  }

  _computeAllocation({ assignments, freeMarginSnapshots, totalVolume, precision }) {
    const snapshotMap = new Map(freeMarginSnapshots.map((snap) => [snap.client_id, snap]));
    const totalFreeMargin = freeMarginSnapshots.reduce((acc, snap) => acc + snap.free_margin, 0);
    const precisionValue = Number.isFinite(precision) && precision > 0 ? precision : 0.01;

    if (!(totalFreeMargin > 0)) {
      return [];
    }

    return assignments.map((assignment) => {
      const snap = snapshotMap.get(assignment.client_live_user_id) || { free_margin: 0, balance: 0 };
      const ratio = snap.free_margin / totalFreeMargin;
      const rawLots = totalVolume * ratio;
      const roundedLots = this._roundTo(rawLots, precisionValue);
      return {
        assignment,
        snapshot: snap,
        ratio,
        allocated_volume: roundedLots
      };
    });
  }

  async _placeClientPendingOrder({
    mamOrderId,
    assignment,
    mamAccount,
    symbol,
    order_type,
    order_price,
    lots,
    groupFields,
    halfSpread
  }) {
    const client = assignment?.client;
    if (!client) {
      return { success: false, reason: 'Client profile missing' };
    }

    const clientId = client.id;
    const userGroup = client.group || mamAccount.group;
    if (userGroup !== mamAccount.group) {
      return { success: false, reason: 'Client group mismatch' };
    }

    const lotValidation = await lotValidationService.validateLotSize(userGroup, symbol, lots);
    if (!lotValidation.valid) {
      return {
        success: false,
        reason: `Lot validation failed: ${lotValidation.message}`
      };
    }

    const comparePrice = this._computeComparePrice(order_price, halfSpread);
    if (!(comparePrice > 0)) {
      return { success: false, reason: 'compare_price_invalid' };
    }

    let isProviderFlow = false;
    try {
      const userCfgKey = `user:{live:${clientId}}:config`;
      const cfg = await redisCluster.hgetall(userCfgKey);
      const sendPref = cfg?.sending_orders ? String(cfg.sending_orders).trim().toLowerCase() : null;
      isProviderFlow = sendPref === 'barclays';
    } catch (error) {
      logger.warn('Failed to read user provider config for pending order flow', {
        client_id: clientId,
        error: error.message
      });
    }

    let userLock;
    try {
      userLock = await acquireUserLock('live', clientId);
      if (!userLock) {
        return { success: false, reason: 'Client is busy with another trading operation' };
      }
    } catch (error) {
      logger.warn('Failed to acquire client lock for MAM pending order', {
        client_id: clientId,
        error: error.message
      });
      return { success: false, reason: 'Unable to acquire client lock' };
    }

    let liveOrder;
    const order_id = await idGenerator.generateOrderId();
    const orderStatus = isProviderFlow ? 'PENDING-QUEUED' : 'PENDING';

    try {
      liveOrder = await LiveUserOrder.create({
        order_id,
        order_user_id: clientId,
        parent_mam_order_id: mamOrderId,
        order_source: 'mam',
        symbol,
        order_type,
        order_status: orderStatus,
        order_price,
        order_quantity: lots,
        margin: 0,
        status: 'PENDING',
        placed_by: 'mam_manager'
      });
    } catch (error) {
      await releaseUserLock(userLock);
      logger.error('Failed to create child pending order for MAM', {
        mam_order_id: mamOrderId,
        client_id: clientId,
        error: error.message
      });
      return { success: false, reason: 'Failed to persist client order' };
    }

    try {
      await this._mirrorPendingOrderToCaches({
        isProviderFlow,
        symbol,
        order_type,
        order_id,
        clientId,
        lots,
        order_price,
        comparePrice,
        userGroup,
        halfSpread,
        mamOrderId,
        mamAccountId: mamAccount.id
      });
    } catch (cacheError) {
      logger.error('Failed to mirror pending order to cache layers', {
        order_id,
        client_id: clientId,
        error: cacheError.message
      });
      await liveOrder.update({
        order_status: ORDER_STATUS.REJECTED,
        status: ORDER_STATUS.REJECTED,
        close_message: 'Cache error during pending placement'
      }).catch(() => { });
      await releaseUserLock(userLock);
      return { success: false, reason: 'cache_error' };
    }

    try {
      await redisCluster.publish('market_price_updates', symbol);
    } catch (pubError) {
      logger.warn('Failed to publish market price update for pending placement', {
        symbol,
        error: pubError.message
      });
    }

    try {
      portfolioEvents.emitUserUpdate('live', clientId, {
        type: 'order_update',
        order_id,
        update: {
          order_status: orderStatus,
          parent_mam_order_id: mamOrderId,
          source: 'mam'
        },
        reason: 'mam_pending_place'
      });
    } catch (eventError) {
      logger.warn('Failed to emit portfolio event for MAM pending order', {
        client_id: clientId,
        order_id,
        error: eventError.message
      });
    }

    if (isProviderFlow) {
      this._dispatchProviderPendingOrder({
        order_id,
        symbol,
        order_type,
        order_price,
        order_quantity: lots,
        clientId
      });
    }

    await releaseUserLock(userLock);
    return {
      success: true,
      order_id,
      compare_price: comparePrice,
      flow: isProviderFlow ? 'provider' : 'local',
      order_status: orderStatus
    };
  }

  async _mirrorPendingOrderToCaches({
    isProviderFlow,
    symbol,
    order_type,
    order_id,
    clientId,
    lots,
    order_price,
    comparePrice,
    userGroup,
    halfSpread,
    mamOrderId,
    mamAccountId
  }) {
    const orderStatus = isProviderFlow ? 'PENDING-QUEUED' : 'PENDING';
    const timestamp = Date.now().toString();
    const zkey = `pending_index:{${symbol}}:${order_type}`;
    const hkey = `pending_orders:${order_id}`;

    if (!isProviderFlow) {
      try {
        await redisCluster.zadd(zkey, comparePrice, order_id);
        await redisCluster.hset(hkey, {
          symbol,
          order_type,
          user_type: 'live',
          user_id: String(clientId),
          order_price_user: String(order_price),
          order_price_compare: String(comparePrice),
          order_quantity: String(lots),
          status: orderStatus,
          created_at: timestamp,
          group: userGroup,
          parent_mam_order_id: String(mamOrderId),
          mam_account_id: String(mamAccountId)
        });
        await redisCluster.sadd('pending_active_symbols', symbol);
      } catch (error) {
        throw error;
      }
    }

    const hashTag = `live:${clientId}`;
    const orderKey = `user_holdings:{${hashTag}}:${order_id}`;
    const indexKey = `user_orders_index:{${hashTag}}`;

    const holdingsPipe = redisCluster.pipeline();
    holdingsPipe.sadd(indexKey, order_id);
    holdingsPipe.hset(orderKey, {
      order_id: String(order_id),
      symbol,
      order_type,
      order_status: orderStatus,
      status: orderStatus,
      execution_status: 'QUEUED',
      order_price: String(order_price),
      order_quantity: String(lots),
      group: userGroup,
      created_at: timestamp,
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      source: 'mam'
    });
    await holdingsPipe.exec();

    await redisCluster.hset(`order_data:${order_id}`, {
      order_id: String(order_id),
      user_type: 'live',
      user_id: String(clientId),
      symbol,
      order_type,
      order_status: orderStatus,
      status: orderStatus,
      order_price: String(order_price),
      order_quantity: String(lots),
      group: userGroup,
      compare_price: String(comparePrice),
      half_spread: String(Number.isFinite(halfSpread) ? halfSpread : 0),
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      source: 'mam'
    });
  }

  _dispatchProviderPendingOrder({ order_id, symbol, order_type, order_price, order_quantity, clientId }) {
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      pythonServiceAxios.post(`${baseUrl}/api/orders/pending/place`, {
        order_id,
        symbol,
        order_type,
        order_price,
        order_quantity,
        user_id: String(clientId),
        user_type: 'live',
        order_source: 'mam'
      }).then(() => {
        logger.info('Dispatched provider pending placement for MAM child order', {
          order_id,
          symbol
        });
      }).catch((error) => {
        logger.error('Python provider pending placement failed for MAM child', {
          order_id,
          symbol,
          error: error.message
        });
      });
    } catch (error) {
      logger.warn('Unable to initiate provider pending placement call', {
        order_id,
        error: error.message
      });
    }
  }

  async _executeAllocations({
    mamOrder,
    allocation,
    mamAccount,
    symbol,
    order_type,
    order_price,
    stop_loss,
    take_profit,
    groupFields
  }) {
    const allocationSnapshot = [];
    let executedVolume = 0;
    let rejectedVolume = 0;
    let rejectedCount = 0;
    let totalMargin = 0;

    for (const slot of allocation) {
      const { assignment, snapshot } = slot;
      const lots = Number(slot.allocated_volume || 0);
      if (!(lots > 0)) {
        allocationSnapshot.push(this._buildSnapshotEntry({
          assignment,
          snapshot,
          status: 'rejected',
          reason: 'Zero allocation after rounding'
        }));
        rejectedCount += 1;
        continue;
      }

      const result = await this._placeClientOrder({
        mamOrderId: mamOrder.id,
        assignment,
        mamAccount,
        symbol,
        order_type,
        order_price,
        lots,
        stop_loss,
        take_profit,
        groupFields,
        snapshot
      });

      allocationSnapshot.push(this._buildSnapshotEntry({
        assignment,
        snapshot,
        lots,
        status: result.success ? 'submitted' : 'rejected',
        reason: result.reason,
        order_id: result.order_id
      }));

      if (result.success) {
        executedVolume += lots;
        totalMargin += Number(result.margin || 0);
      } else {
        rejectedVolume += lots;
        rejectedCount += 1;
      }
    }

    return {
      executedVolume,
      rejectedVolume,
      rejectedCount,
      totalMargin,
      allocationSnapshot,
      executionSnapshot: {
        executedVolume,
        rejectedVolume,
        rejectedCount
      }
    };
  }

  async _placeClientOrder({
    mamOrderId,
    assignment,
    mamAccount,
    symbol,
    order_type,
    order_price,
    lots,
    stop_loss,
    take_profit,
    groupFields,
    snapshot
  }) {
    const client = assignment.client;
    if (!client) {
      return { success: false, reason: 'Client profile missing' };
    }

    const clientId = client.id;
    const userGroup = client.group || mamAccount.group;
    if (userGroup !== mamAccount.group) {
      return { success: false, reason: 'Client group mismatch' };
    }

    const lotValidation = await lotValidationService.validateLotSize(userGroup, symbol, lots);
    if (!lotValidation.valid) {
      return {
        success: false,
        reason: `Lot validation failed: ${lotValidation.message}`
      };
    }

    const instrumentType = Number(groupFields?.type) || 0;
    const contractSize = Number(groupFields?.contract_size) || 100000;
    const orderPrice = Number(order_price);
    const contractValue = contractSize * lots;
    const marginFactor = this._resolveMarginFactor({ instrumentType, groupFields });

    const requiredMargin = this._estimateMargin({
      lots,
      order_price: orderPrice,
      contractSize,
      leverage: Number(client.leverage) || 100,
      marginFactor
    });

    logger.debug('MAM allocation margin evaluation', {
      mam_order_id: mamOrderId,
      client_id: clientId,
      lots,
      symbol,
      order_price: Number(orderPrice),
      contract_size: contractSize,
      contract_value: Number(contractValue.toFixed(6)),
      instrument_type: instrumentType || null,
      margin_factor: marginFactor,
      required_margin: Number(requiredMargin.toFixed(6)),
      wallet_balance: Number(assignment.client.wallet_balance || 0),
      free_margin_snapshot: snapshot?.free_margin
    });

    if (requiredMargin > assignment.client.wallet_balance) {
      logger.warn('MAM allocation rejected - insufficient wallet', {
        mam_order_id: mamOrderId,
        client_id: clientId,
        lots,
        required_margin: Number(requiredMargin.toFixed(6)),
        wallet_balance: Number(assignment.client.wallet_balance || 0)
      });
      return { success: false, reason: 'Insufficient wallet balance for margin' };
    }

    let userLock = null;
    try {
      userLock = await acquireUserLock('live', clientId);
      if (!userLock) {
        return { success: false, reason: 'Client is busy with another trading operation' };
      }
    } catch (error) {
      logger.warn('Failed to acquire client lock for MAM order', { clientId, error: error.message });
      return { success: false, reason: 'Unable to acquire client lock' };
    }

    let liveOrder = null;
    const order_id = await idGenerator.generateOrderId();

    try {
      liveOrder = await LiveUserOrder.create({
        order_id,
        order_user_id: clientId,
        parent_mam_order_id: mamOrderId,
        order_source: 'mam',
        symbol,
        order_type,
        order_status: ORDER_STATUS.QUEUED,
        order_price,
        order_quantity: lots,
        margin: 0,
        status: 'OPEN',
        placed_by: 'mam_manager'
      });
    } catch (error) {
      logger.error('Failed to create child LiveUserOrder for MAM order', {
        mam_order_id: mamOrderId,
        clientId,
        error: error.message
      });
      await releaseUserLock(userLock);
      return { success: false, reason: 'Failed to persist client order' };
    }

    const pyPayload = {
      symbol,
      order_type,
      order_price,
      order_quantity: lots,
      user_id: clientId.toString(),
      user_type: 'live',
      order_id,
      stop_loss: stop_loss || null,
      take_profit: take_profit || null,
      order_source: 'mam'
    };

    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      const pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/instant/execute`,
        pyPayload
      );
      const result = pyResp.data?.data || {};
      const flow = result.flow;
      const exec_price = Number.isFinite(Number(result.exec_price)) ? Number(result.exec_price) : order_price;
      const pythonMargin = Number(result.margin_usd ?? result.used_margin_usd);
      const margin = Number.isFinite(pythonMargin) && pythonMargin > 0 ? pythonMargin : Number(requiredMargin);
      const contract_value = Number(result.contract_value ?? 0);
      const totalUsedMargin = Number(result.used_margin_executed);

      await liveOrder.update({
        order_status: flow === 'provider' ? ORDER_STATUS.QUEUED : ORDER_STATUS.OPEN,
        order_price: exec_price,
        margin,
        contract_value,
        commission: result.commission_entry ?? null
      });

      if (Number.isFinite(totalUsedMargin)) {
        try {
          await updateUserUsedMargin({ userType: 'live', userId: clientId, usedMargin: totalUsedMargin });
        } catch (error) {
          logger.warn('Failed to update user margin after MAM order', { clientId, error: error.message });
        }
      } else {
        logger.warn('Skipped user margin mirror update - missing total margin', {
          clientId,
          mam_order_id: mamOrderId
        });
      }

      try {
        portfolioEvents.emitUserUpdate('live', clientId, {
          type: 'order_update',
          order_id,
          update: { order_status: liveOrder.order_status, parent_mam_order_id: mamOrderId },
          reason: 'mam_order_place'
        });
      } catch (error) {
        logger.warn('Failed to emit portfolio event for client MAM order', { clientId, error: error.message });
      }

      await releaseUserLock(userLock);
      return {
        success: true,
        order_id,
        margin
      };
    } catch (error) {
      logger.error('Python order execution failed for client MAM order', {
        clientId,
        mam_order_id: mamOrderId,
        error: error.message
      });

      await liveOrder.update({
        order_status: ORDER_STATUS.REJECTED,
        close_message: error?.response?.data?.message || 'Execution rejected'
      }).catch(() => { });

      await releaseUserLock(userLock);
      return {
        success: false,
        reason: error?.response?.data?.message || 'Execution rejected by provider'
      };
    }
  }

  _validatePayload(payload = {}) {
    const data = {
      symbol: String(payload.symbol || '').trim().toUpperCase(),
      order_type: String(payload.order_type || '').trim().toUpperCase(),
      order_price: Number(payload.order_price),
      volume: Number(payload.volume ?? payload.order_quantity),
      stop_loss: payload.stop_loss != null ? Number(payload.stop_loss) : null,
      take_profit: payload.take_profit != null ? Number(payload.take_profit) : null
    };

    if (!data.symbol) {
      return { valid: false, message: 'symbol is required' };
    }
    if (!VALID_ORDER_TYPES.includes(data.order_type)) {
      return { valid: false, message: 'order_type must be BUY or SELL' };
    }
    if (!Number.isFinite(data.order_price) || !(data.order_price > 0)) {
      return { valid: false, message: 'order_price must be greater than 0' };
    }
    if (!Number.isFinite(data.volume) || !(data.volume > 0)) {
      return { valid: false, message: 'volume must be greater than 0' };
    }
    if (data.stop_loss != null && !Number.isFinite(data.stop_loss)) {
      return { valid: false, message: 'stop_loss must be numeric' };
    }
    if (data.take_profit != null && !Number.isFinite(data.take_profit)) {
      return { valid: false, message: 'take_profit must be numeric' };
    }

    return { valid: true, data };
  }

  _validatePendingPayload(payload = {}) {
    const data = {
      symbol: String(payload.symbol || '').trim().toUpperCase(),
      order_type: String(payload.order_type || '').trim().toUpperCase(),
      order_price: Number(payload.order_price),
      volume: Number(payload.volume ?? payload.order_quantity)
    };

    if (!data.symbol) {
      return { valid: false, message: 'symbol is required' };
    }
    if (!VALID_PENDING_ORDER_TYPES.includes(data.order_type)) {
      return { valid: false, message: 'order_type must be a pending order type' };
    }
    if (!Number.isFinite(data.order_price) || !(data.order_price > 0)) {
      return { valid: false, message: 'order_price must be greater than 0' };
    }
    if (!Number.isFinite(data.volume) || !(data.volume > 0)) {
      return { valid: false, message: 'volume must be greater than 0' };
    }

    return { valid: true, data };
  }

  _computeHalfSpreadFromGroupFields(groupFields = {}) {
    if (!groupFields) {
      return null;
    }
    const spread = Number(groupFields.spread);
    const spreadPip = Number(groupFields.spread_pip);
    if (Number.isFinite(spread) && Number.isFinite(spreadPip)) {
      return (spread * spreadPip) / 2;
    }
    return null;
  }

  _computeComparePrice(orderPrice, halfSpread) {
    const price = Number(orderPrice) - (Number(halfSpread) || 0);
    if (!Number.isFinite(price)) {
      return NaN;
    }
    return Number(price.toFixed(8));
  }

  _buildSnapshotEntry({
    assignment,
    snapshot,
    lots = 0,
    status,
    reason = null,
    order_id = null
  }) {
    return {
      client_id: assignment.client_live_user_id,
      client_account_number: assignment?.client?.account_number,
      allocated_volume: lots,
      ratio: snapshot?.ratio,
      free_margin_snapshot: snapshot?.free_margin,
      balance_snapshot: snapshot?.balance,
      status,
      reason,
      order_id
    };
  }

  async _assertMarketOpen(groupType) {
    const day = new Date().getUTCDay();
    if (groupType && Number(groupType) === 4) {
      return;
    }
    if (day === 0 || day === 6) {
      const error = new Error('Market is closed for this instrument');
      error.statusCode = 403;
      throw error;
    }
  }

  _resolveMarginFactor({ instrumentType, groupFields }) {
    if (Number(instrumentType) !== 4) {
      return 1;
    }

    const candidates = [
      groupFields?.crypto_margin_factor,
      groupFields?.group_margin,
      groupFields?.margin
    ];

    for (const value of candidates) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return 1;
  }

  _estimateMargin({ lots, order_price, contractSize, leverage, marginFactor = 1 }) {
    if (!(lots > 0)) return 0;
    const contractValue = contractSize * lots;
    const notional = contractValue * order_price * (Number.isFinite(marginFactor) ? marginFactor : 1);
    if (!(leverage > 0)) return notional;
    return notional / leverage;
  }

  async _updateMamAccountAggregates(mamAccountId, transaction) {
    try {
      await refreshMamAccountAggregates(mamAccountId, { transaction });
    } catch (error) {
      logger.warn('Failed to update MAM account aggregates after order', {
        mam_account_id: mamAccountId,
        error: error.message
      });
    }
  }

  _roundTo(value, precision) {
    if (!(precision > 0)) return value;
    return Math.round(value / precision) * precision;
  }

  _toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  async _closeChildOrder({ order, closePayload, mamAccountId, mamOrderId, managerId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;
    const currentStatus = String(order.order_status || '').toUpperCase();
    if (!OPEN_CHILD_STATUSES.includes(currentStatus)) {
      return { skipped: true, reason: `status_${currentStatus}` };
    }

    let userLock = null;
    try {
      userLock = await acquireUserLock('live', userId);
      if (!userLock) {
        return { success: false, reason: 'user_lock_unavailable' };
      }
    } catch (lockError) {
      logger.warn('Failed to acquire child user lock for MAM close', {
        order_id: orderId,
        user_id: userId,
        error: lockError.message
      });
      return { success: false, reason: 'user_lock_error' };
    }

    try {
      let resolved;
      try {
        resolved = await resolveOpenOrder({
          order_id: orderId,
          user_id: userId,
          user_type: 'live',
          symbolReq: order.symbol,
          orderTypeReq: order.order_type
        });
      } catch (resolveError) {
        if (['ORDER_NOT_OPEN', 'ORDER_NOT_FOUND'].includes(resolveError?.code)) {
          return { skipped: true, reason: resolveError.code };
        }
        logger.warn('resolveOpenOrder failed for child MAM close', {
          order_id: orderId,
          user_id: userId,
          error: resolveError.message
        });
        return { success: false, reason: resolveError.message };
      }

      const canonical = resolved.canonical;
      const row = resolved.row || order;
      const hasTP = canonical
        ? (canonical.take_profit != null && Number(canonical.take_profit) > 0)
        : (row?.take_profit != null && Number(row.take_profit) > 0);
      const hasSL = canonical
        ? (canonical.stop_loss != null && Number(canonical.stop_loss) > 0)
        : (row?.stop_loss != null && Number(row.stop_loss) > 0);

      let closePrice;
      try {
        closePrice = await this._resolveClosePrice({
          symbol: resolved.symbol,
          orderType: resolved.order_type,
          fallbackPrice: closePayload.close_price
        });
      } catch (priceError) {
        logger.warn('Unable to resolve close price for MAM child order', {
          order_id: orderId,
          symbol: resolved.symbol,
          error: priceError.message
        });
        return { success: false, reason: 'close_price_unavailable' };
      }

      const close_id = await idGenerator.generateCloseOrderId();
      const takeprofit_cancel_id = hasTP ? await idGenerator.generateTakeProfitCancelId() : undefined;
      const stoploss_cancel_id = hasSL ? await idGenerator.generateStopLossCancelId() : undefined;

      const idUpdates = {
        close_id,
        status: closePayload.status
      };
      if (takeprofit_cancel_id) idUpdates.takeprofit_cancel_id = takeprofit_cancel_id;
      if (stoploss_cancel_id) idUpdates.stoploss_cancel_id = stoploss_cancel_id;
      await order.update(idUpdates);

      await orderLifecycleService.addLifecycleId(orderId, 'close_id', close_id, 'MAM parent close');
      if (takeprofit_cancel_id) {
        await orderLifecycleService.addLifecycleId(orderId, 'takeprofit_cancel_id', takeprofit_cancel_id, 'MAM parent close');
      }
      if (stoploss_cancel_id) {
        await orderLifecycleService.addLifecycleId(orderId, 'stoploss_cancel_id', stoploss_cancel_id, 'MAM parent close');
      }

      await this._setCloseContext(orderId, {
        initiator: `mam_manager:${mamAccountId}`,
        mam_account_id: mamAccountId,
        mam_order_id: mamOrderId
      });

      const closePendingKey = `order_close_pending:${orderId}`;
      try {
        await redisCluster.setex(closePendingKey, 60, JSON.stringify({
          close_id,
          mam_order_id: mamOrderId,
          mam_account_id: mamAccountId,
          manager_id: managerId,
          timestamp: Date.now()
        }));
      } catch (pendingErr) {
        logger.warn('Failed to set close pending lock for child order', {
          order_id: orderId,
          error: pendingErr.message
        });
      }

      const pyPayload = {
        symbol: resolved.symbol,
        order_type: resolved.order_type,
        user_id: String(userId),
        user_type: 'live',
        order_id: orderId,
        status: closePayload.status,
        order_status: closePayload.order_status,
        close_id
      };
      if (resolved.order_quantity) pyPayload.order_quantity = resolved.order_quantity;
      if (resolved.entry_price) pyPayload.entry_price = resolved.entry_price;
      if (takeprofit_cancel_id) pyPayload.takeprofit_cancel_id = takeprofit_cancel_id;
      if (stoploss_cancel_id) pyPayload.stoploss_cancel_id = stoploss_cancel_id;
      pyPayload.close_price = closePrice;

      let pyResp;
      try {
        const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
        pyResp = await pythonServiceAxios.post(`${baseUrl}/api/orders/close`, pyPayload, { timeout: 20000 });
      } catch (pyError) {
        try {
          await redisCluster.del(closePendingKey);
        } catch (_) { /* ignore */ }
        logger.error('Python close call failed for MAM child order', {
          order_id: orderId,
          parent_mam_order_id: mamOrderId,
          user_id: userId,
          error: pyError.message
        });
        return { success: false, reason: pyError?.response?.data?.message || 'python_close_failed' };
      }

      try {
        portfolioEvents.emitUserUpdate('live', String(userId), {
          type: 'order_update',
          order_id: orderId,
          update: { close_id, parent_mam_order_id: mamOrderId },
          reason: 'mam_order_close_requested'
        });
      } catch (eventErr) {
        logger.warn('Failed to emit user update for child MAM close', {
          order_id: orderId,
          user_id: userId,
          error: eventErr.message
        });
      }

      const flow = pyResp.data?.data?.flow || pyResp.data?.flow || 'local';
      return { success: true, close_id, flow };
    } finally {
      if (userLock) {
        await releaseUserLock(userLock);
      }
    }
  }

  async _setCloseContext(orderId, context = {}) {
    try {
      const contextKey = `close_context:${orderId}`;
      const value = {
        context: 'MAM_MANAGER_CLOSED',
        ...context,
        timestamp: Math.floor(Date.now() / 1000).toString()
      };
      await redisCluster.hset(contextKey, value);
      await redisCluster.expire(contextKey, 300);
    } catch (error) {
      logger.warn('Failed to set close context for MAM child order', {
        order_id: orderId,
        error: error.message
      });
    }
  }

  async _refreshMamOrderState(mamOrderId) {
    const [mamOrder, openChildren] = await Promise.all([
      MAMOrder.findByPk(mamOrderId),
      LiveUserOrder.count({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: { [Op.in]: OPEN_CHILD_STATUSES }
        }
      })
    ]);

    if (!mamOrder) return;

    const newStatus = openChildren > 0 ? 'OPEN' : 'CLOSED';
    const updates = { order_status: newStatus };
    if (newStatus === 'CLOSED') {
      updates.metadata = {
        ...(mamOrder.metadata || {}),
        closed_at: new Date().toISOString()
      };
    }

    try {
      await mamOrder.update(updates);
    } catch (error) {
      logger.warn('Failed to refresh MAM order state after close', {
        mam_order_id: mamOrderId,
        error: error.message
      });
    }
  }

  async _refreshMamAccountAggregates(mamAccountId) {
    const mamAccount = await MAMAccount.findByPk(mamAccountId);
    if (!mamAccount) return;

    try {
      const clients = await LiveUser.findAll({
        where: { mam_id: mamAccountId },
        attributes: ['id', 'wallet_balance']
      });
      const clientIds = clients.map((client) => client.id);
      const totalBalance = clients.reduce((acc, client) => acc + Number(client.wallet_balance || 0), 0);

      let totalMargin = 0;
      if (clientIds.length) {
        totalMargin = await LiveUserOrder.sum('margin', {
          where: {
            order_user_id: { [Op.in]: clientIds },
            order_status: { [Op.in]: OPEN_CHILD_STATUSES }
          }
        }) || 0;
      }

      await mamAccount.update({
        total_balance: Number(totalBalance || 0),
        mam_balance: Number(totalBalance || 0),
        total_used_margin: Number(totalMargin || 0)
      });
    } catch (error) {
      logger.warn('Failed to refresh MAM account aggregates after close', {
        mam_account_id: mamAccountId,
        error: error.message
      });
    }
  }

  async syncMamAggregates({ mamOrderId, mamAccountId }) {
    await Promise.all([
      mamOrderId ? this._refreshMamOrderState(mamOrderId) : Promise.resolve(),
      mamAccountId ? refreshMamAccountAggregates(mamAccountId) : Promise.resolve()
    ]);
  }

  async addStopLoss({ mamAccountId, managerId, payload }) {
    const { order_id: mamOrderIdRaw, stop_loss } = payload || {};

    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      const error = new Error('order_id must be a valid MAM order id');
      error.statusCode = 400;
      throw error;
    }

    if (!(Number(stop_loss) > 0)) {
      const error = new Error('stop_loss must be greater than 0');
      error.statusCode = 400;
      throw error;
    }

    const mamOrder = await MAMOrder.findByPk(mamOrderId);
    if (!mamOrder || mamOrder.mam_account_id !== mamAccountId) {
      const error = new Error('MAM order not found for this account');
      error.statusCode = 404;
      throw error;
    }

    const status = String(mamOrder.order_status || '').toUpperCase();
    if (status && !['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'].includes(status)) {
      const error = new Error(`MAM order is not active (status=${status})`);
      error.statusCode = 409;
      throw error;
    }

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    try {
      const childOrders = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: {
            [Op.in]: OPEN_CHILD_STATUSES
          }
        }
      });

      if (!childOrders.length) {
        const error = new Error('No active child orders to apply stoploss for this MAM order');
        error.statusCode = 409;
        throw error;
      }

      const results = await Promise.allSettled(childOrders.map((order) => (
        this._applyStopLossToChild({
          order,
          stop_loss: Number(stop_loss),
          mamAccountId,
          mamOrderId
        })
      )));

      const summary = results.reduce((acc, result, idx) => {
        const order = childOrders[idx];
        if (result.status === 'fulfilled') {
          const value = result.value || {};
          if (value.skipped) {
            acc.skipped += 1;
            acc.skippedOrders.push({ order_id: order.order_id, reason: value.reason });
          } else if (value.success) {
            acc.successful += 1;
            acc.successOrders.push({ order_id: order.order_id, stoploss_id: value.stoploss_id, flow: value.flow || 'local' });
          } else {
            acc.failed += 1;
            acc.failedOrders.push({ order_id: order.order_id, reason: value.reason || 'unknown_error' });
          }
        } else {
          acc.failed += 1;
          acc.failedOrders.push({ order_id: order.order_id, reason: result.reason?.message || 'stoploss_failed' });
        }
        return acc;
      }, {
        total: childOrders.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        successOrders: [],
        failedOrders: [],
        skippedOrders: []
      });

      try {
        const metadata = {
          ...(mamOrder.metadata || {}),
          stop_loss: Number(stop_loss),
          last_stoploss_update_at: new Date().toISOString(),
          last_stoploss_updated_by: `mam_manager:${managerId}`
        };
        await mamOrder.update({
          metadata,
          stop_loss: Number(stop_loss)
        });
      } catch (metaError) {
        logger.warn('Failed to update MAM order metadata after stoploss add', {
          mam_order_id: mamOrderId,
          error: metaError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_order_stoploss_update',
          mam_order_id: mamOrderId,
          stop_loss: Number(stop_loss),
          summary
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM order stoploss update event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrderId,
          error: eventError.message
        });
      }

      return summary;
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async _applyStopLossToChild({ order, stop_loss, mamAccountId, mamOrderId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;
    const currentStatus = String(order.order_status || '').toUpperCase();
    if (!OPEN_CHILD_STATUSES.includes(currentStatus)) {
      return { skipped: true, reason: `status_${currentStatus}` };
    }

    let resolved;
    try {
      resolved = await resolveOpenOrder({
        order_id: orderId,
        user_id: userId,
        user_type: 'live',
        symbolReq: order.symbol,
        orderTypeReq: order.order_type
      });
    } catch (e) {
      if (['ORDER_NOT_OPEN', 'ORDER_NOT_FOUND'].includes(e?.code)) {
        return { skipped: true, reason: e.code };
      }
      logger.warn('resolveOpenOrder failed for child MAM stoploss', {
        order_id: orderId,
        user_id: userId,
        error: e.message
      });
      return { success: false, reason: e.message };
    }

    const canonical = resolved.canonical;
    const row = resolved.row || order;

    let symbol = resolved.symbol;
    let order_type = resolved.order_type;
    let entry_price_num = Number(resolved.entry_price);
    let order_quantity_num = Number(resolved.order_quantity);

    if (!(entry_price_num > 0)) {
      return { success: false, reason: 'invalid_entry_price' };
    }

    if (order_type === 'BUY' && !(stop_loss < entry_price_num)) {
      return { success: false, reason: 'invalid_price_for_buy' };
    }
    if (order_type === 'SELL' && !(stop_loss > entry_price_num)) {
      return { success: false, reason: 'invalid_price_for_sell' };
    }

    let hasExistingSL = false;
    if (row && row.stop_loss != null && Number(row.stop_loss) > 0) {
      hasExistingSL = true;
    }
    if (!hasExistingSL && canonical && canonical.stop_loss != null && Number(canonical.stop_loss) > 0) {
      hasExistingSL = true;
    }
    if (hasExistingSL) {
      return { skipped: true, reason: 'STOPLOSS_ALREADY_EXISTS' };
    }

    const stoploss_id = await idGenerator.generateStopLossId();
    try {
      await order.update({ stoploss_id, status: 'STOPLOSS' });
      await orderLifecycleService.addLifecycleId(
        orderId,
        'stoploss_id',
        stoploss_id,
        `Stoploss added via MAM - price: ${stop_loss}`
      );
    } catch (e) {
      logger.warn('Failed to persist stoploss_id for MAM child before send', { order_id: orderId, error: e.message });
    }

    const pyPayload = {
      order_id: orderId,
      symbol,
      user_id: String(userId),
      user_type: 'live',
      order_type,
      order_price: entry_price_num,
      stoploss_id,
      stop_loss,
      status: 'STOPLOSS',
      order_status: currentStatus,
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      order_source: 'mam'
    };
    if (order_quantity_num > 0) pyPayload.order_quantity = order_quantity_num;

    let pyResp;
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/stoploss/add`,
        pyPayload
      );
    } catch (err) {
      logger.error('Python stoploss call failed for MAM child order', {
        order_id: orderId,
        parent_mam_order_id: mamOrderId,
        user_id: userId,
        error: err.message
      });
      return { success: false, reason: err?.response?.data?.message || 'python_stoploss_failed' };
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow || 'local';

    if (String(flow).toLowerCase() === 'local') {
      try {
        await order.update({ stop_loss: String(stop_loss) });
      } catch (e) {
        logger.warn('Failed to update SQL row for MAM child stoploss (local flow)', { order_id: orderId, error: e.message });
      }
      try {
        portfolioEvents.emitUserUpdate('live', String(userId), {
          type: 'order_update',
          order_id: orderId,
          update: { stop_loss: String(stop_loss), parent_mam_order_id: mamOrderId },
          reason: 'mam_stoploss_set'
        });
      } catch (e) {
        logger.warn('Failed to emit WS event after MAM child stoploss set', { order_id: orderId, error: e.message });
      }
    }

    return { success: true, stoploss_id, flow };
  }

  async addTakeProfit({ mamAccountId, managerId, payload }) {
    const { order_id: mamOrderIdRaw, take_profit } = payload || {};

    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      const error = new Error('order_id must be a valid MAM order id');
      error.statusCode = 400;
      throw error;
    }

    if (!(Number(take_profit) > 0)) {
      const error = new Error('take_profit must be greater than 0');
      error.statusCode = 400;
      throw error;
    }

    const mamOrder = await MAMOrder.findByPk(mamOrderId);
    if (!mamOrder || mamOrder.mam_account_id !== mamAccountId) {
      const error = new Error('MAM order not found for this account');
      error.statusCode = 404;
      throw error;
    }

    const status = String(mamOrder.order_status || '').toUpperCase();
    if (status && !['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'].includes(status)) {
      const error = new Error(`MAM order is not active (status=${status})`);
      error.statusCode = 409;
      throw error;
    }

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    try {
      const childOrders = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: {
            [Op.in]: OPEN_CHILD_STATUSES
          }
        }
      });

      if (!childOrders.length) {
        const error = new Error('No active child orders to apply takeprofit for this MAM order');
        error.statusCode = 409;
        throw error;
      }

      const results = await Promise.allSettled(childOrders.map((order) => (
        this._applyTakeProfitToChild({
          order,
          take_profit: Number(take_profit),
          mamAccountId,
          mamOrderId
        })
      )));

      const summary = results.reduce((acc, result, idx) => {
        const order = childOrders[idx];
        if (result.status === 'fulfilled') {
          const value = result.value || {};
          if (value.skipped) {
            acc.skipped += 1;
            acc.skippedOrders.push({ order_id: order.order_id, reason: value.reason });
          } else if (value.success) {
            acc.successful += 1;
            acc.successOrders.push({ order_id: order.order_id, takeprofit_id: value.takeprofit_id, flow: value.flow || 'local' });
          } else {
            acc.failed += 1;
            acc.failedOrders.push({ order_id: order.order_id, reason: value.reason || 'unknown_error' });
          }
        } else {
          acc.failed += 1;
          acc.failedOrders.push({ order_id: order.order_id, reason: result.reason?.message || 'takeprofit_failed' });
        }
        return acc;
      }, {
        total: childOrders.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        successOrders: [],
        failedOrders: [],
        skippedOrders: []
      });

      try {
        const metadata = {
          ...(mamOrder.metadata || {}),
          take_profit: Number(take_profit),
          last_takeprofit_update_at: new Date().toISOString(),
          last_takeprofit_updated_by: `mam_manager:${managerId}`
        };
        await mamOrder.update({
          metadata,
          take_profit: Number(take_profit)
        });
      } catch (metaError) {
        logger.warn('Failed to update MAM order metadata after takeprofit add', {
          mam_order_id: mamOrderId,
          error: metaError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_order_takeprofit_update',
          mam_order_id: mamOrderId,
          take_profit: Number(take_profit),
          summary
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM order takeprofit update event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrderId,
          error: eventError.message
        });
      }

      return summary;
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async _applyTakeProfitToChild({ order, take_profit, mamAccountId, mamOrderId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;
    const currentStatus = String(order.order_status || '').toUpperCase();
    if (!OPEN_CHILD_STATUSES.includes(currentStatus)) {
      return { skipped: true, reason: `status_${currentStatus}` };
    }

    let resolved;
    try {
      resolved = await resolveOpenOrder({
        order_id: orderId,
        user_id: userId,
        user_type: 'live',
        symbolReq: order.symbol,
        orderTypeReq: order.order_type
      });
    } catch (e) {
      if (['ORDER_NOT_OPEN', 'ORDER_NOT_FOUND'].includes(e?.code)) {
        return { skipped: true, reason: e.code };
      }
      logger.warn('resolveOpenOrder failed for child MAM takeprofit', {
        order_id: orderId,
        user_id: userId,
        error: e.message
      });
      return { success: false, reason: e.message };
    }

    const canonical = resolved.canonical;
    const row = resolved.row || order;

    let symbol = resolved.symbol;
    let order_type = resolved.order_type;
    let entry_price_num = Number(resolved.entry_price);
    let order_quantity_num = Number(resolved.order_quantity);

    if (!(entry_price_num > 0)) {
      return { success: false, reason: 'invalid_entry_price' };
    }

    if (order_type === 'BUY' && !(take_profit > entry_price_num)) {
      return { success: false, reason: 'invalid_price_for_buy' };
    }
    if (order_type === 'SELL' && !(take_profit < entry_price_num)) {
      return { success: false, reason: 'invalid_price_for_sell' };
    }

    let hasExistingTP = false;
    if (row && row.take_profit != null && Number(row.take_profit) > 0) {
      hasExistingTP = true;
    }
    if (!hasExistingTP && canonical && canonical.take_profit != null && Number(canonical.take_profit) > 0) {
      hasExistingTP = true;
    }
    if (hasExistingTP) {
      return { skipped: true, reason: 'TAKEPROFIT_ALREADY_EXISTS' };
    }

    const takeprofit_id = await idGenerator.generateTakeProfitId();
    try {
      await order.update({ takeprofit_id, status: 'TAKEPROFIT' });
      await orderLifecycleService.addLifecycleId(
        orderId,
        'takeprofit_id',
        takeprofit_id,
        `Takeprofit added via MAM - price: ${take_profit}`
      );
    } catch (e) {
      logger.warn('Failed to persist takeprofit_id for MAM child before send', { order_id: orderId, error: e.message });
    }

    const pyPayload = {
      order_id: orderId,
      symbol,
      user_id: String(userId),
      user_type: 'live',
      order_type,
      order_price: entry_price_num,
      takeprofit_id,
      take_profit,
      status: 'TAKEPROFIT',
      order_status: currentStatus,
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      order_source: 'mam'
    };
    if (order_quantity_num > 0) pyPayload.order_quantity = order_quantity_num;

    let pyResp;
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/takeprofit/add`,
        pyPayload
      );
    } catch (err) {
      logger.error('Python takeprofit call failed for MAM child order', {
        order_id: orderId,
        parent_mam_order_id: mamOrderId,
        user_id: userId,
        error: err.message
      });
      return { success: false, reason: err?.response?.data?.message || 'python_takeprofit_failed' };
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow || 'local';

    if (String(flow).toLowerCase() === 'local') {
      try {
        await order.update({ take_profit: String(take_profit) });
      } catch (e) {
        logger.warn('Failed to update SQL row for MAM child takeprofit (local flow)', { order_id: orderId, error: e.message });
      }
      try {
        portfolioEvents.emitUserUpdate('live', String(userId), {
          type: 'order_update',
          order_id: orderId,
          update: { take_profit: String(take_profit), parent_mam_order_id: mamOrderId },
          reason: 'mam_takeprofit_set'
        });
      } catch (e) {
        logger.warn('Failed to emit WS event after MAM child takeprofit set', { order_id: orderId, error: e.message });
      }
    }

    return { success: true, takeprofit_id, flow };
  }
 
  async cancelStopLoss({ mamAccountId, managerId, payload }) {
    const { order_id: mamOrderIdRaw } = payload || {};

    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      const error = new Error('order_id must be a valid MAM order id');
      error.statusCode = 400;
      throw error;
    }

    const mamOrder = await MAMOrder.findByPk(mamOrderId);
    if (!mamOrder || mamOrder.mam_account_id !== mamAccountId) {
      const error = new Error('MAM order not found for this account');
      error.statusCode = 404;
      throw error;
    }

    const status = String(mamOrder.order_status || '').toUpperCase();
    if (status && !['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'].includes(status)) {
      const error = new Error(`MAM order is not active (status=${status})`);
      error.statusCode = 409;
      throw error;
    }

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    try {
      const childOrders = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: {
            [Op.in]: OPEN_CHILD_STATUSES
          }
        }
      });

      if (!childOrders.length) {
        const error = new Error('No active child orders to cancel stoploss for this MAM order');
        error.statusCode = 409;
        throw error;
      }

      const results = await Promise.allSettled(childOrders.map((order) => (
        this._cancelStopLossForChild({
          order,
          mamAccountId,
          mamOrderId
        })
      )));

      const summary = results.reduce((acc, result, idx) => {
        const order = childOrders[idx];
        if (result.status === 'fulfilled') {
          const value = result.value || {};
          if (value.skipped) {
            acc.skipped += 1;
            acc.skippedOrders.push({ order_id: order.order_id, reason: value.reason });
          } else if (value.success) {
            acc.successful += 1;
            acc.successOrders.push({ order_id: order.order_id, stoploss_cancel_id: value.stoploss_cancel_id, flow: value.flow || 'local' });
          } else {
            acc.failed += 1;
            acc.failedOrders.push({ order_id: order.order_id, reason: value.reason || 'unknown_error' });
          }
        } else {
          acc.failed += 1;
          acc.failedOrders.push({ order_id: order.order_id, reason: result.reason?.message || 'stoploss_cancel_failed' });
        }
        return acc;
      }, {
        total: childOrders.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        successOrders: [],
        failedOrders: [],
        skippedOrders: []
      });

      try {
        const metadata = {
          ...(mamOrder.metadata || {}),
          last_stoploss_cancel_at: new Date().toISOString(),
          last_stoploss_cancelled_by: `mam_manager:${managerId}`
        };
        const updates = { metadata };
        if (summary.failed === 0 && summary.skipped === 0) {
          metadata.stop_loss = null;
          updates.stop_loss = null;
        }
        await mamOrder.update(updates);
      } catch (metaError) {
        logger.warn('Failed to update MAM order metadata after stoploss cancel', {
          mam_order_id: mamOrderId,
          error: metaError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_order_stoploss_cancel',
          mam_order_id: mamOrderId,
          // For UI convenience, expose the updated stop_loss (likely null when fully cancelled)
          stop_loss: mamOrder.stop_loss != null ? Number(mamOrder.stop_loss) : null,
          summary
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM order stoploss cancel event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrderId,
          error: eventError.message
        });
      }

      return summary;
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async _cancelStopLossForChild({ order, mamAccountId, mamOrderId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;
    const currentStatus = String(order.order_status || '').toUpperCase();
    if (!OPEN_CHILD_STATUSES.includes(currentStatus)) {
      return { skipped: true, reason: `status_${currentStatus}` };
    }

    let ctx;
    try {
      ctx = await resolveOpenOrder({
        order_id: orderId,
        user_id: userId,
        user_type: 'live',
        symbolReq: order.symbol,
        orderTypeReq: order.order_type
      });
    } catch (e) {
      if (['ORDER_NOT_OPEN', 'ORDER_NOT_FOUND'].includes(e?.code)) {
        return { skipped: true, reason: e.code };
      }
      logger.warn('resolveOpenOrder failed for child MAM stoploss cancel', {
        order_id: orderId,
        user_id: userId,
        error: e.message
      });
      return { success: false, reason: e.message };
    }

    const canonical = ctx.canonical;
    const row = ctx.row || order;

    const symbol = ctx.symbol;
    const order_type = ctx.order_type;

    let hasSL = false;
    if (row && row.stop_loss != null && Number(row.stop_loss) > 0) {
      hasSL = true;
    }
    if (!hasSL && canonical && canonical.stop_loss != null && Number(canonical.stop_loss) > 0) {
      hasSL = true;
    }
    if (!hasSL) {
      return { skipped: true, reason: 'NO_ACTIVE_STOPLOSS' };
    }

    let resolvedStoplossId = (row && row.stoploss_id ? String(row.stoploss_id) : '').trim();
    if (!resolvedStoplossId) {
      try {
        const fromRedis = await redisCluster.hget(`order_data:${orderId}`, 'stoploss_id');
        if (fromRedis) resolvedStoplossId = String(fromRedis).trim();
      } catch (e) {
        logger.warn('Failed to fetch stoploss_id from redis for MAM child cancel', {
          order_id: orderId,
          error: e.message
        });
      }
    }
    if (!resolvedStoplossId) {
      resolvedStoplossId = `SL-${orderId}`;
    }

    const stoploss_cancel_id = await idGenerator.generateStopLossCancelId();
    try {
      await order.update({ stoploss_cancel_id, status: 'STOPLOSS-CANCEL' });
      await orderLifecycleService.addLifecycleId(
        orderId,
        'stoploss_cancel_id',
        stoploss_cancel_id,
        `Stoploss cancel requested via MAM - resolved_sl_id: ${resolvedStoplossId}`
      );

      if (resolvedStoplossId && resolvedStoplossId !== `SL-${orderId}`) {
        await orderLifecycleService.updateLifecycleStatus(
          resolvedStoplossId,
          'cancelled',
          'Cancelled by MAM manager'
        );
      }
    } catch (e) {
      logger.warn('Failed to persist stoploss_cancel_id for MAM child before send', { order_id: orderId, error: e.message });
    }

    const pyPayload = {
      order_id: orderId,
      symbol,
      user_id: String(userId),
      user_type: 'live',
      order_type,
      status: 'STOPLOSS-CANCEL',
      order_status: currentStatus,
      stoploss_id: resolvedStoplossId,
      stoploss_cancel_id,
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      order_source: 'mam'
    };

    let pyResp;
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/stoploss/cancel`,
        pyPayload
      );
    } catch (err) {
      logger.error('Python stoploss cancel call failed for MAM child order', {
        order_id: orderId,
        parent_mam_order_id: mamOrderId,
        user_id: userId,
        error: err.message
      });
      return { success: false, reason: err?.response?.data?.message || 'python_stoploss_cancel_failed' };
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow || 'local';

    if (String(flow).toLowerCase() === 'local') {
      try {
        await order.update({ stop_loss: null });
      } catch (e) {
        logger.warn('Failed to update SQL row for MAM child stoploss cancel (local flow)', { order_id: orderId, error: e.message });
      }
      try {
        portfolioEvents.emitUserUpdate('live', String(userId), {
          type: 'order_update',
          order_id: orderId,
          update: { stop_loss: null, parent_mam_order_id: mamOrderId },
          reason: 'mam_stoploss_cancel'
        });
      } catch (e) {
        logger.warn('Failed to emit WS event after MAM child stoploss cancel', { order_id: orderId, error: e.message });
      }
    }

    return { success: true, stoploss_cancel_id, flow };
  }

  async cancelTakeProfit({ mamAccountId, managerId, payload }) {
    const { order_id: mamOrderIdRaw } = payload || {};

    const mamOrderId = Number(mamOrderIdRaw);
    if (!Number.isInteger(mamOrderId) || mamOrderId <= 0) {
      const error = new Error('order_id must be a valid MAM order id');
      error.statusCode = 400;
      throw error;
    }

    const mamOrder = await MAMOrder.findByPk(mamOrderId);
    if (!mamOrder || mamOrder.mam_account_id !== mamAccountId) {
      const error = new Error('MAM order not found for this account');
      error.statusCode = 404;
      throw error;
    }

    const status = String(mamOrder.order_status || '').toUpperCase();
    if (status && !['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'].includes(status)) {
      const error = new Error(`MAM order is not active (status=${status})`);
      error.statusCode = 409;
      throw error;
    }

    const mamLock = await acquireUserLock('mam_account', mamAccountId, 10);
    if (!mamLock) {
      const error = new Error('Another MAM order action is in progress. Please retry shortly.');
      error.statusCode = 409;
      throw error;
    }

    try {
      const childOrders = await LiveUserOrder.findAll({
        where: {
          parent_mam_order_id: mamOrderId,
          order_status: {
            [Op.in]: OPEN_CHILD_STATUSES
          }
        }
      });

      if (!childOrders.length) {
        const error = new Error('No active child orders to cancel takeprofit for this MAM order');
        error.statusCode = 409;
        throw error;
      }

      const results = await Promise.allSettled(childOrders.map((order) => (
        this._cancelTakeProfitForChild({
          order,
          mamAccountId,
          mamOrderId
        })
      )));

      const summary = results.reduce((acc, result, idx) => {
        const order = childOrders[idx];
        if (result.status === 'fulfilled') {
          const value = result.value || {};
          if (value.skipped) {
            acc.skipped += 1;
            acc.skippedOrders.push({ order_id: order.order_id, reason: value.reason });
          } else if (value.success) {
            acc.successful += 1;
            acc.successOrders.push({ order_id: order.order_id, takeprofit_cancel_id: value.takeprofit_cancel_id, flow: value.flow || 'local' });
          } else {
            acc.failed += 1;
            acc.failedOrders.push({ order_id: order.order_id, reason: value.reason || 'unknown_error' });
          }
        } else {
          acc.failed += 1;
          acc.failedOrders.push({ order_id: order.order_id, reason: result.reason?.message || 'takeprofit_cancel_failed' });
        }
        return acc;
      }, {
        total: childOrders.length,
        successful: 0,
        failed: 0,
        skipped: 0,
        successOrders: [],
        failedOrders: [],
        skippedOrders: []
      });

      try {
        const metadata = {
          ...(mamOrder.metadata || {}),
          last_takeprofit_cancel_at: new Date().toISOString(),
          last_takeprofit_cancelled_by: `mam_manager:${managerId}`
        };
        const updates = { metadata };
        if (summary.failed === 0 && summary.skipped === 0) {
          metadata.take_profit = null;
          updates.take_profit = null;
        }
        await mamOrder.update(updates);
      } catch (metaError) {
        logger.warn('Failed to update MAM order metadata after takeprofit cancel', {
          mam_order_id: mamOrderId,
          error: metaError.message
        });
      }

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_order_takeprofit_cancel',
          mam_order_id: mamOrderId,
          // Expose the updated take_profit (likely null when fully cancelled)
          take_profit: mamOrder.take_profit != null ? Number(mamOrder.take_profit) : null,
          summary
        });
      } catch (eventError) {
        logger.warn('Failed to emit MAM order takeprofit cancel event', {
          mam_account_id: mamAccountId,
          mam_order_id: mamOrderId,
          error: eventError.message
        });
      }

      return summary;
    } finally {
      await releaseUserLock(mamLock);
    }
  }

  async _cancelTakeProfitForChild({ order, mamAccountId, mamOrderId }) {
    const orderId = order.order_id;
    const userId = order.order_user_id;
    const currentStatus = String(order.order_status || '').toUpperCase();
    if (!OPEN_CHILD_STATUSES.includes(currentStatus)) {
      return { skipped: true, reason: `status_${currentStatus}` };
    }

    let ctx;
    try {
      ctx = await resolveOpenOrder({
        order_id: orderId,
        user_id: userId,
        user_type: 'live',
        symbolReq: order.symbol,
        orderTypeReq: order.order_type
      });
    } catch (e) {
      if (['ORDER_NOT_OPEN', 'ORDER_NOT_FOUND'].includes(e?.code)) {
        return { skipped: true, reason: e.code };
      }
      logger.warn('resolveOpenOrder failed for child MAM takeprofit cancel', {
        order_id: orderId,
        user_id: userId,
        error: e.message
      });
      return { success: false, reason: e.message };
    }

    const canonical = ctx.canonical;
    const row = ctx.row || order;

    const symbol = ctx.symbol;
    const order_type = ctx.order_type;

    let hasTP = false;
    if (row && row.take_profit != null && Number(row.take_profit) > 0) {
      hasTP = true;
    }
    if (!hasTP && canonical && canonical.take_profit != null && Number(canonical.take_profit) > 0) {
      hasTP = true;
    }
    if (!hasTP) {
      return { skipped: true, reason: 'NO_ACTIVE_TAKEPROFIT' };
    }

    let resolvedTakeprofitId = (row && row.takeprofit_id ? String(row.takeprofit_id) : '').trim();
    if (!resolvedTakeprofitId) {
      try {
        const fromRedis = await redisCluster.hget(`order_data:${orderId}`, 'takeprofit_id');
        if (fromRedis) resolvedTakeprofitId = String(fromRedis).trim();
      } catch (e) {
        logger.warn('Failed to fetch takeprofit_id from redis for MAM child cancel', {
          order_id: orderId,
          error: e.message
        });
      }
    }
    if (!resolvedTakeprofitId) {
      resolvedTakeprofitId = `TP-${orderId}`;
    }

    const takeprofit_cancel_id = await idGenerator.generateTakeProfitCancelId();
    try {
      await order.update({ takeprofit_cancel_id, status: 'TAKEPROFIT-CANCEL' });
      await orderLifecycleService.addLifecycleId(
        orderId,
        'takeprofit_cancel_id',
        takeprofit_cancel_id,
        `Takeprofit cancel requested via MAM - resolved_tp_id: ${resolvedTakeprofitId}`
      );

      if (resolvedTakeprofitId && resolvedTakeprofitId !== `TP-${orderId}`) {
        await orderLifecycleService.updateLifecycleStatus(
          resolvedTakeprofitId,
          'cancelled',
          'Cancelled by MAM manager'
        );
      }
    } catch (e) {
      logger.warn('Failed to persist takeprofit_cancel_id for MAM child before send', { order_id: orderId, error: e.message });
    }

    const pyPayload = {
      order_id: orderId,
      symbol,
      user_id: String(userId),
      user_type: 'live',
      order_type,
      status: 'TAKEPROFIT-CANCEL',
      order_status: currentStatus,
      takeprofit_id: resolvedTakeprofitId,
      takeprofit_cancel_id,
      parent_mam_order_id: String(mamOrderId),
      mam_account_id: String(mamAccountId),
      order_source: 'mam'
    };

    let pyResp;
    try {
      const baseUrl = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
      pyResp = await pythonServiceAxios.post(
        `${baseUrl}/api/orders/takeprofit/cancel`,
        pyPayload
      );
    } catch (err) {
      logger.error('Python takeprofit cancel call failed for MAM child order', {
        order_id: orderId,
        parent_mam_order_id: mamOrderId,
        user_id: userId,
        error: err.message
      });
      return { success: false, reason: err?.response?.data?.message || 'python_takeprofit_cancel_failed' };
    }

    const result = pyResp.data?.data || pyResp.data || {};
    const flow = result.flow || 'local';

    if (String(flow).toLowerCase() === 'local') {
      try {
        await order.update({ take_profit: null });
      } catch (e) {
        logger.warn('Failed to update SQL row for MAM child takeprofit cancel (local flow)', { order_id: orderId, error: e.message });
      }
      try {
        portfolioEvents.emitUserUpdate('live', String(userId), {
          type: 'order_update',
          order_id: orderId,
          update: { take_profit: null, parent_mam_order_id: mamOrderId },
          reason: 'mam_takeprofit_cancel'
        });
      } catch (e) {
        logger.warn('Failed to emit WS event after MAM child takeprofit cancel', { order_id: orderId, error: e.message });
      }
    }

    return { success: true, takeprofit_cancel_id, flow };
  }
}

module.exports = new MAMOrderService();
