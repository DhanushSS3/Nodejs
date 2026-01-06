const { Op } = require('sequelize');
const MAMAccount = require('../models/mamAccount.model');

class MAMAccountService {
  async createMAMAccount(payload, adminId) {
    const data = {
      ...payload,
      created_by_admin_id: adminId
    };

    return MAMAccount.create(data);
  }

  async listMAMAccounts(query) {
    const {
      page = 1,
      limit = 20,
      status,
      allocation_method,
      search
    } = query;

    const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const where = {};

    if (status) {
      where.status = status;
    }

    if (allocation_method) {
      where.allocation_method = allocation_method;
    }

    if (search) {
      const searchTerm = `%${search.trim()}%`;
      where[Op.or] = [
        { mam_name: { [Op.like]: searchTerm } },
        { account_number: { [Op.like]: searchTerm } }
      ];
    }

    const { rows, count } = await MAMAccount.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      offset,
      limit: parsedLimit
    });

    return {
      items: rows,
      total: count,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(count / parsedLimit) || 1
    };
  }

  async getMAMAccountById(id) {
    const account = await MAMAccount.findByPk(id);
    if (!account) {
      const error = new Error('MAM account not found');
      error.statusCode = 404;
      throw error;
    }
    return account;
  }

  async updateMAMAccount(id, payload) {
    const account = await this.getMAMAccountById(id);
    Object.assign(account, payload);
    await account.save();
    return account;
  }
}

module.exports = new MAMAccountService();
