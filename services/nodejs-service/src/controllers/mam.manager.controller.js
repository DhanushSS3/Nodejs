const { Op } = require('sequelize');
const MAMAssignment = require('../models/mamAssignment.model');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const MAMOrder = require('../models/mamOrder.model');
const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');

class MAMManagerController {
  async getAssignedClients(req, res) {
    try {
      const mamAccountId = req.user?.mam_account_id;
      const pageRaw = parseInt(req.query.page, 10);
      const limitRaw = parseInt(req.query.limit, 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const pageSize = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
      const offset = (page - 1) * pageSize;
      const status = req.query.status ? String(req.query.status) : null;
      const searchTerm = req.query.search ? String(req.query.search).trim() : null;

      const whereClause = { mam_account_id: mamAccountId };
      if (status) {
        whereClause.status = status;
      }

      const searchClause = searchTerm
        ? {
            [Op.or]: [
              { '$client.name$': { [Op.like]: `%${searchTerm}%` } },
              { '$client.email$': { [Op.like]: `%${searchTerm}%` } },
              { '$client.account_number$': { [Op.like]: `%${searchTerm}%` } }
            ]
          }
        : null;

      const { rows, count } = await MAMAssignment.findAndCountAll({
        where: searchClause ? { [Op.and]: [whereClause, searchClause] } : whereClause,
        include: [
          {
            model: LiveUser,
            as: 'client',
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'group', 'country']
          }
        ],
        order: [['created_at', 'DESC']],
        offset,
        limit: pageSize,
        distinct: true
      });

      const assignments = rows.map((assignment) => ({
        assignment_id: assignment.id,
        status: assignment.status,
        initiated_by: assignment.initiated_by,
        initiated_reason: assignment.initiated_reason,
        created_at: assignment.created_at,
        updated_at: assignment.updated_at,
        client: assignment.client
          ? {
              id: assignment.client.id,
              name: assignment.client.name,
              email: assignment.client.email,
              account_number: assignment.client.account_number,
              wallet_balance: parseFloat(assignment.client.wallet_balance) || 0,
              group: assignment.client.group,
              country: assignment.client.country
            }
          : null
      }));

      return res.status(200).json({
        success: true,
        message: 'Assigned clients retrieved successfully',
        data: {
          assignments,
          pagination: {
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize) || 1
          }
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to load assigned clients'
      });
    }
  }

  async getClientClosedOrders(req, res) {
    try {
      const mamAccountId = req.user?.mam_account_id;
      const clientId = parseInt(req.params.client_id, 10);

      const assignments = await MAMAssignment.findAll({
        where: {
          mam_account_id: mamAccountId,
          client_live_user_id: clientId,
          status: {
            [Op.in]: [
              ASSIGNMENT_STATUS.ACTIVE,
              ASSIGNMENT_STATUS.UNSUBSCRIBED,
              ASSIGNMENT_STATUS.SUSPENDED
            ]
          }
        }
      });

      if (!assignments.length) {
        return res.status(404).json({
          success: false,
          message: 'Client has no MAM assignments for this account'
        });
      }

      const pageRaw = parseInt(req.query.page, 10);
      const limitRaw = parseInt(req.query.limit, 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const pageSize = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
      const offset = (page - 1) * pageSize;

      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      const orderType = req.query.order_type ? String(req.query.order_type).toUpperCase() : null;
      const startDateStr = req.query.start_date ? String(req.query.start_date) : null;
      const endDateStr = req.query.end_date ? String(req.query.end_date) : null;

      const baseWhere = {
        order_user_id: clientId,
        order_status: 'CLOSED',
        order_source: 'mam'
      };

      if (symbol) {
        baseWhere.symbol = symbol;
      }
      if (orderType) {
        baseWhere.order_type = orderType;
      }

      const andConditions = [];

      // Assignment interval logic: order.created_at >= activated_at AND
      // (deactivated_at IS NULL OR updated_at <= deactivated_at)
      const intervalConditions = assignments
        .filter((assignment) => assignment.activated_at)
        .map((assignment) => {
          const perAssignmentAnd = [
            { created_at: { [Op.gte]: assignment.activated_at } }
          ];
          if (assignment.deactivated_at) {
            perAssignmentAnd.push({ updated_at: { [Op.lte]: assignment.deactivated_at } });
          }
          return { [Op.and]: perAssignmentAnd };
        });

      if (intervalConditions.length) {
        andConditions.push({ [Op.or]: intervalConditions });
      }

      // Optional closed-date range filters (using updated_at as closed_at proxy)
      if (startDateStr) {
        const startDate = new Date(startDateStr);
        if (!Number.isNaN(startDate.getTime())) {
          andConditions.push({ updated_at: { [Op.gte]: startDate } });
        }
      }
      if (endDateStr) {
        const endDate = new Date(endDateStr);
        if (!Number.isNaN(endDate.getTime())) {
          andConditions.push({ updated_at: { [Op.lte]: endDate } });
        }
      }

      const whereClause = andConditions.length
        ? { ...baseWhere, [Op.and]: andConditions }
        : baseWhere;

      const { rows, count } = await LiveUserOrder.findAndCountAll({
        where: whereClause,
        include: [
          {
            model: MAMOrder,
            as: 'parentMAMOrder',
            attributes: ['id', 'symbol', 'order_type', 'order_status', 'requested_volume', 'executed_volume', 'created_at'],
            where: { mam_account_id: mamAccountId }
          }
        ],
        order: [['updated_at', 'DESC']],
        offset,
        limit: pageSize,
        distinct: true
      });

      const orders = rows.map((order) => ({
        order_id: order.order_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price?.toString?.() ?? null,
        order_quantity: order.order_quantity?.toString?.() ?? null,
        margin: order.margin?.toString?.() ?? null,
        net_profit: order.net_profit?.toString?.() ?? null,
        net_profit_after_fees: order.net_profit_after_fees?.toString?.() ?? null,
        performance_fee_amount: order.performance_fee_amount?.toString?.() ?? null,
        commission: order.commission?.toString?.() ?? null,
        swap: order.swap?.toString?.() ?? null,
        stop_loss: order.stop_loss?.toString?.() ?? null,
        take_profit: order.take_profit?.toString?.() ?? null,
        close_price: order.close_price?.toString?.() ?? null,
        created_at: order.created_at,
        updated_at: order.updated_at,
        parent_mam_order_id: order.parent_mam_order_id,
        mam_order: order.parentMAMOrder
          ? {
              id: order.parentMAMOrder.id,
              symbol: order.parentMAMOrder.symbol,
              order_type: order.parentMAMOrder.order_type,
              order_status: order.parentMAMOrder.order_status,
              requested_volume: order.parentMAMOrder.requested_volume,
              executed_volume: order.parentMAMOrder.executed_volume,
              created_at: order.parentMAMOrder.created_at
            }
          : null
      }));

      return res.status(200).json({
        success: true,
        message: 'Client closed orders retrieved successfully',
        data: {
          orders,
          pagination: {
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize) || 1
          }
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to load client closed orders'
      });
    }
  }

  async getClosedOrders(req, res) {
    try {
      const mamAccountId = req.user?.mam_account_id;

      const clientIdFilter = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
      const pageRaw = parseInt(req.query.page, 10);
      const limitRaw = parseInt(req.query.limit, 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const pageSize = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      const orderType = req.query.order_type ? String(req.query.order_type).toUpperCase() : null;
      const startDateStr = req.query.start_date ? String(req.query.start_date) : null;
      const endDateStr = req.query.end_date ? String(req.query.end_date) : null;

      const baseWhere = {
        order_status: 'CLOSED',
        order_source: 'mam'
      };

      if (clientIdFilter) {
        baseWhere.order_user_id = clientIdFilter;
      }
      if (symbol) {
        baseWhere.symbol = symbol;
      }
      if (orderType) {
        baseWhere.order_type = orderType;
      }

      if (startDateStr) {
        const startDate = new Date(startDateStr);
        if (!Number.isNaN(startDate.getTime())) {
          baseWhere.updated_at = { ...(baseWhere.updated_at || {}), [Op.gte]: startDate };
        }
      }
      if (endDateStr) {
        const endDate = new Date(endDateStr);
        if (!Number.isNaN(endDate.getTime())) {
          baseWhere.updated_at = { ...(baseWhere.updated_at || {}), [Op.lte]: endDate, ...(baseWhere.updated_at || {}) };
        }
      }

      // Fetch candidate orders for this MAM account
      const orders = await LiveUserOrder.findAll({
        where: baseWhere,
        include: [
          {
            model: MAMOrder,
            as: 'parentMAMOrder',
            attributes: ['id', 'symbol', 'order_type', 'order_status', 'requested_volume', 'executed_volume', 'created_at', 'mam_account_id'],
            where: { mam_account_id: mamAccountId }
          }
        ],
        order: [['updated_at', 'DESC']]
      });

      if (!orders.length) {
        return res.status(200).json({
          success: true,
          message: 'Closed orders retrieved successfully',
          data: {
            orders: [],
            pagination: {
              total: 0,
              page,
              page_size: pageSize,
              total_pages: 0
            }
          }
        });
      }

      const clientIds = Array.from(new Set(orders.map((o) => o.order_user_id)));

      const assignments = await MAMAssignment.findAll({
        where: {
          mam_account_id: mamAccountId,
          client_live_user_id: { [Op.in]: clientIds },
          status: {
            [Op.in]: [
              ASSIGNMENT_STATUS.ACTIVE,
              ASSIGNMENT_STATUS.UNSUBSCRIBED,
              ASSIGNMENT_STATUS.SUSPENDED
            ]
          }
        }
      });

      const assignmentsByClient = new Map();
      for (const assignment of assignments) {
        const key = assignment.client_live_user_id;
        if (!assignmentsByClient.has(key)) {
          assignmentsByClient.set(key, []);
        }
        assignmentsByClient.get(key).push(assignment);
      }

      const eligible = orders.filter((order) => {
        const clientAssignments = assignmentsByClient.get(order.order_user_id) || [];
        if (!clientAssignments.length) return false;

        const openedAt = order.created_at;
        const closedAt = order.updated_at;
        if (!openedAt || !closedAt) return false;

        return clientAssignments.some((assignment) => {
          if (!assignment.activated_at) return false;
          if (openedAt < assignment.activated_at) return false;
          if (assignment.deactivated_at && closedAt > assignment.deactivated_at) return false;
          return true;
        });
      });

      const total = eligible.length;
      const totalPages = Math.ceil(total / pageSize) || 1;
      const startIndex = (page - 1) * pageSize;
      const pageItems = eligible.slice(startIndex, startIndex + pageSize);

      const serialized = pageItems.map((order) => ({
        order_id: order.order_id,
        client_id: order.order_user_id,
        symbol: order.symbol,
        order_type: order.order_type,
        order_status: order.order_status,
        order_price: order.order_price?.toString?.() ?? null,
        order_quantity: order.order_quantity?.toString?.() ?? null,
        margin: order.margin?.toString?.() ?? null,
        net_profit: order.net_profit?.toString?.() ?? null,
        net_profit_after_fees: order.net_profit_after_fees?.toString?.() ?? null,
        performance_fee_amount: order.performance_fee_amount?.toString?.() ?? null,
        commission: order.commission?.toString?.() ?? null,
        swap: order.swap?.toString?.() ?? null,
        stop_loss: order.stop_loss?.toString?.() ?? null,
        take_profit: order.take_profit?.toString?.() ?? null,
        close_price: order.close_price?.toString?.() ?? null,
        created_at: order.created_at,
        updated_at: order.updated_at,
        parent_mam_order_id: order.parent_mam_order_id,
        mam_order: order.parentMAMOrder
          ? {
              id: order.parentMAMOrder.id,
              symbol: order.parentMAMOrder.symbol,
              order_type: order.parentMAMOrder.order_type,
              order_status: order.parentMAMOrder.order_status,
              requested_volume: order.parentMAMOrder.requested_volume,
              executed_volume: order.parentMAMOrder.executed_volume,
              created_at: order.parentMAMOrder.created_at
            }
          : null
      }));

      return res.status(200).json({
        success: true,
        message: 'Closed orders retrieved successfully',
        data: {
          orders: serialized,
          pagination: {
            total,
            page,
            page_size: pageSize,
            total_pages: totalPages
          }
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to load closed orders'
      });
    }
  }
}

module.exports = new MAMManagerController();
