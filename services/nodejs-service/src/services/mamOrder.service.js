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
const OPEN_CHILD_STATUSES = ['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'];

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
    const groupFields = await groupsCache.getGroupFields(groupName, symbol, ['type', 'contract_size']);
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

    const executionSummary = await this._executeAllocations({
      mamOrder,
      allocation,
      mamAccount,
      symbol,
      order_type,
      order_price,
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

    await this._updateMamAccountAggregates(mamAccount, executionSummary);

    try {
      portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
        type: 'mam_order_update',
        mam_order_id: mamOrder.id,
        executed_volume: executionSummary.executedVolume,
        rejected_investors: executionSummary.rejectedCount
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

  async closeMamOrder({ mamAccountId, managerId, payload }) {
    const {
      order_id: mamOrderIdRaw,
      symbol,
      order_type,
      status = 'CLOSED',
      order_status = 'CLOSED',
      close_price
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

      await this._refreshMamOrderState(mamOrderId);
      await this._refreshMamAccountAggregates(mamAccountId);

      try {
        portfolioEvents.emitUserUpdate('mam_account', mamAccountId, {
          type: 'mam_order_close_progress',
          mam_order_id: mamOrderId,
          summary
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

    const requiredMargin = this._estimateMargin({
      lots,
      order_price,
      contractSize: Number(groupFields?.contract_size) || 100000,
      leverage: Number(client.leverage) || 100
    });

    logger.debug('MAM allocation margin evaluation', {
      mam_order_id: mamOrderId,
      client_id: clientId,
      lots,
      symbol,
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
      const margin = Number(result.margin_usd ?? result.used_margin_usd ?? 0);
      const contract_value = Number(result.contract_value ?? 0);

      await liveOrder.update({
        order_status: flow === 'provider' ? ORDER_STATUS.QUEUED : ORDER_STATUS.OPEN,
        order_price: exec_price,
        margin,
        contract_value,
        commission: result.commission_entry ?? null
      });

      await updateUserUsedMargin('live', clientId).catch((error) => {
        logger.warn('Failed to update user margin after MAM order', { clientId, error: error.message });
      });

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

  _estimateMargin({ lots, order_price, contractSize, leverage }) {
    if (!(lots > 0)) return 0;
    const contractValue = contractSize * lots;
    const notional = contractValue * order_price;
    if (!(leverage > 0)) return notional;
    return notional / leverage;
  }

  async _updateMamAccountAggregates(mamAccount, executionSummary) {
    try {
      const totalBalance = await LiveUser.sum('wallet_balance', {
        where: {
          mam_id: mamAccount.id
        }
      });

      await mamAccount.update({
        total_balance: Number(totalBalance || 0),
        mam_balance: Number(totalBalance || 0),
        total_used_margin: executionSummary.totalMargin
      });
    } catch (error) {
      logger.warn('Failed to update MAM account aggregates after order', {
        mam_account_id: mamAccount.id,
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
      if (closePayload.close_price) pyPayload.close_price = closePayload.close_price;

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
}

module.exports = new MAMOrderService();
