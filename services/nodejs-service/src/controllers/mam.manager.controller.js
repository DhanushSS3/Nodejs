const { Op } = require('sequelize');
const MAMAssignment = require('../models/mamAssignment.model');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const MAMOrder = require('../models/mamOrder.model');
const UserTransaction = require('../models/userTransaction.model');
const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');

class MAMManagerController {
  async getWalletTransactions(req, res) {
    try {
      const mamAccountId = req.user?.mam_account_id;
      if (!mamAccountId) {
        return res.status(403).json({ success: false, message: 'No MAM account bound to manager session' });
      }

      const pageRaw = Number.parseInt(req.query.page, 10);
      const pageSizeRaw = Number.parseInt(req.query.page_size, 10);
      let limitRaw = Number.parseInt(req.query.limit, 10);
      let offsetRaw = Number.parseInt(req.query.offset, 10);

      const pageSize = Math.min(
        Math.max(1, Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : (Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50)),
        100
      );

      let page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : null;

      if (!page && Number.isFinite(offsetRaw) && offsetRaw >= 0) {
        page = Math.floor(offsetRaw / pageSize) + 1;
      }

      if (!page) page = 1;

      const offset = (page - 1) * pageSize;

      const startDateRaw = req.query.start_date;
      const endDateRaw = req.query.end_date;
      let createdAtFilter = null;
      if (startDateRaw || endDateRaw) {
        const startDate = startDateRaw ? new Date(startDateRaw) : null;
        const endDate = endDateRaw ? new Date(endDateRaw) : null;
        if ((startDateRaw && Number.isNaN(startDate.getTime())) || (endDateRaw && Number.isNaN(endDate.getTime()))) {
          return res.status(400).json({ success: false, message: 'Invalid start_date or end_date' });
        }
        createdAtFilter = {};
        if (startDate) createdAtFilter[Op.gte] = startDate;
        if (endDate) createdAtFilter[Op.lte] = endDate;
      }

      const where = {
        user_id: mamAccountId,
        user_type: 'mam_account',
        type: 'performance_fee_earned',
      };
      if (createdAtFilter) {
        where.created_at = createdAtFilter;
      }

      const { rows, count } = await UserTransaction.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        attributes: ['transaction_id', 'type', 'amount', 'status', 'reference_id', 'notes', 'created_at'],
        limit: pageSize,
        offset,
      });

      const transactions = rows.map((r) => ({
        transaction_id: r.transaction_id,
        type: r.type,
        amount: r.amount,
        status: r.status,
        reference_id: r.reference_id,
        notes: r.notes,
        created_at: r.created_at,
        source: 'wallet_transaction',
      }));

      const total = Number(count || 0);
      const totalPages = Math.ceil(total / pageSize) || 1;

      return res.status(200).json({
        success: true,
        message: 'Wallet transactions retrieved successfully',
        data: {
          transactions,
          pagination: {
            total,
            page,
            page_size: pageSize,
            total_pages: totalPages,
            has_next_page: page < totalPages,
            has_previous_page: page > 1,
          }
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to load wallet transactions'
      });
    }
  }

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

      // ----------------------------------------------------------------
      // Step 1: Fetch all CLOSED MAM orders for this account
      // ----------------------------------------------------------------
      const mamOrderWhere = {
        mam_account_id: mamAccountId,
        order_status: 'CLOSED'
      };
      if (symbol) mamOrderWhere.symbol = symbol;
      if (orderType) mamOrderWhere.order_type = orderType;

      if (startDateStr || endDateStr) {
        mamOrderWhere.updated_at = {};
        if (startDateStr) {
          const d = new Date(startDateStr);
          if (!Number.isNaN(d.getTime())) mamOrderWhere.updated_at[Op.gte] = d;
        }
        if (endDateStr) {
          const d = new Date(endDateStr);
          if (!Number.isNaN(d.getTime())) mamOrderWhere.updated_at[Op.lte] = d;
        }
      }

      const closedMamOrders = await MAMOrder.findAll({
        where: mamOrderWhere,
        order: [['updated_at', 'DESC']]
      });

      if (!closedMamOrders.length) {
        return res.status(200).json({
          success: true,
          message: 'Closed orders retrieved successfully',
          data: {
            orders: [],
            pagination: { total: 0, page, page_size: pageSize, total_pages: 0 }
          }
        });
      }

      const mamOrderIds = closedMamOrders.map((o) => o.id);

      // ----------------------------------------------------------------
      // Step 2: Fetch all matching closed child orders in one query
      // ----------------------------------------------------------------
      const childWhere = {
        parent_mam_order_id: { [Op.in]: mamOrderIds },
        order_status: 'CLOSED',
        order_source: 'mam'
      };
      if (clientIdFilter) childWhere.order_user_id = clientIdFilter;

      const childOrders = await LiveUserOrder.findAll({ where: childWhere });

      // ----------------------------------------------------------------
      // Step 3: Aggregate child orders by parent_mam_order_id
      // ----------------------------------------------------------------
      const aggMap = new Map(); // mam_order_id -> aggregated summary

      for (const child of childOrders) {
        const pid = child.parent_mam_order_id;
        if (!aggMap.has(pid)) {
          aggMap.set(pid, {
            total_quantity: 0,
            total_quantity_x_open_price: 0,   // for weighted avg open price
            total_quantity_x_close_price: 0,  // for weighted avg close price
            commission: 0,
            swap: 0,
            net_profit: 0,
            close_message: null,
            client_count: 0
          });
        }
        const agg = aggMap.get(pid);
        const qty = Number(child.order_quantity) || 0;
        const openPrice = Number(child.order_price) || 0;
        const closePrice = Number(child.close_price) || 0;
        agg.total_quantity += qty;
        agg.total_quantity_x_open_price += qty * openPrice;
        agg.total_quantity_x_close_price += qty * closePrice;
        agg.commission += Number(child.commission) || 0;
        agg.swap += Number(child.swap) || 0;
        agg.net_profit += Number(child.net_profit) || 0;
        if (!agg.close_message && child.close_message) {
          agg.close_message = child.close_message;
        }
        agg.client_count += 1;
      }

      // ----------------------------------------------------------------
      // Step 4: Build paginated result rows keyed by MAM order
      // ----------------------------------------------------------------
      const total = closedMamOrders.length;
      const totalPages = Math.ceil(total / pageSize) || 1;
      const startIndex = (page - 1) * pageSize;
      const pageItems = closedMamOrders.slice(startIndex, startIndex + pageSize);

      const serialized = pageItems.map((mamOrder) => {
        const agg = aggMap.get(mamOrder.id);
        const totalQty = agg ? agg.total_quantity : 0;
        const avgOpenPrice = agg && totalQty > 0
          ? agg.total_quantity_x_open_price / totalQty
          : Number(mamOrder.average_entry_price) || 0;
        const avgClosePrice = agg && totalQty > 0
          ? agg.total_quantity_x_close_price / totalQty
          : Number(mamOrder.average_exit_price) || 0;

        return {
          order_id: mamOrder.id,
          symbol: mamOrder.symbol,
          order_type: mamOrder.order_type,
          order_status: mamOrder.order_status,
          // Aggregated across all client child orders
          order_quantity: totalQty.toFixed(8),
          order_price: avgOpenPrice > 0 ? avgOpenPrice.toFixed(8) : null,
          close_price: avgClosePrice > 0 ? avgClosePrice.toFixed(8) : null,
          commission: agg ? agg.commission.toFixed(8) : '0.00000000',
          swap: agg ? agg.swap.toFixed(8) : '0.00000000',
          net_profit: agg ? agg.net_profit.toFixed(8) : '0.00000000',
          close_message: agg ? agg.close_message : null,
          client_count: agg ? agg.client_count : 0,
          // MAM order level metadata
          requested_volume: mamOrder.requested_volume?.toString?.() ?? null,
          executed_volume: mamOrder.executed_volume?.toString?.() ?? null,
          stop_loss: mamOrder.stop_loss?.toString?.() ?? null,
          take_profit: mamOrder.take_profit?.toString?.() ?? null,
          gross_profit: mamOrder.gross_profit?.toString?.() ?? null,
          net_profit_after_fees: mamOrder.net_profit_after_fees?.toString?.() ?? null,
          rejected_investors_count: mamOrder.rejected_investors_count ?? 0,
          rejected_volume: mamOrder.rejected_volume?.toString?.() ?? null,
          created_at: mamOrder.created_at,
          updated_at: mamOrder.updated_at
        };
      });

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
