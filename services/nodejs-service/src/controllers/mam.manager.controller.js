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

  async getClientOrders(req, res) {
    try {
      const mamAccountId = req.user?.mam_account_id;
      const clientId = parseInt(req.params.client_id, 10);
      const assignment = await MAMAssignment.findOne({
        where: {
          mam_account_id: mamAccountId,
          client_live_user_id: clientId,
          status: ASSIGNMENT_STATUS.ACTIVE
        }
      });

      if (!assignment) {
        return res.status(404).json({
          success: false,
          message: 'Client is not actively assigned to this MAM account'
        });
      }

      const pageRaw = parseInt(req.query.page, 10);
      const limitRaw = parseInt(req.query.limit, 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const pageSize = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
      const offset = (page - 1) * pageSize;

      const whereClause = {
        order_user_id: clientId,
        order_source: 'mam'
      };

      if (req.query.status) {
        whereClause.order_status = String(req.query.status);
      }
      if (req.query.symbol) {
        whereClause.symbol = String(req.query.symbol).toUpperCase();
      }
      if (req.query.order_type) {
        whereClause.order_type = String(req.query.order_type).toUpperCase();
      }

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
        order: [['created_at', 'DESC']],
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
        commission: order.commission?.toString?.() ?? null,
        swap: order.swap?.toString?.() ?? null,
        stop_loss: order.stop_loss?.toString?.() ?? null,
        take_profit: order.take_profit?.toString?.() ?? null,
        close_price: order.close_price?.toString?.() ?? null,
        created_at: order.created_at,
        updated_at: order.updated_at,
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
        message: 'Client orders retrieved successfully',
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
        message: error.message || 'Failed to load client orders'
      });
    }
  }
}

module.exports = new MAMManagerController();
