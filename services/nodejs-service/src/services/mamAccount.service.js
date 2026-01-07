const { Op } = require('sequelize');
const MAMAccount = require('../models/mamAccount.model');
const { hashPassword, comparePassword } = require('./password.service');
const { storeSession, validateRefreshToken, deleteRefreshToken, deleteSession } = require('../utils/redisSession.util');
const jwt = require('jsonwebtoken');

class MAMAccountService {
  async createMAMAccount(payload, adminId) {
    const data = {
      ...payload,
      created_by_admin_id: adminId
    };

    if (data.login_email) {
      data.login_email = data.login_email.toLowerCase();
    }

    if (payload.login_password) {
      data.login_password_hash = await hashPassword(payload.login_password);
    }

    delete data.login_password;

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

    if (payload.login_password) {
      account.login_password_hash = await hashPassword(payload.login_password);
    }

    if (payload.login_email) {
      payload.login_email = payload.login_email.toLowerCase();
    }

    const updatableFields = { ...payload };
    delete updatableFields.login_password;

    Object.assign(account, updatableFields);
    await account.save();
    return account;
  }

  async listActiveAccountsForClient(query = {}) {
    const {
      search,
      limit = 100
    } = query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);

    const where = { status: 'active' };

    if (search) {
      const searchTerm = `%${search.trim()}%`;
      where[Op.or] = [
        { mam_name: { [Op.like]: searchTerm } },
        { account_number: { [Op.like]: searchTerm } },
        { group: { [Op.like]: searchTerm } }
      ];
    }

    return MAMAccount.findAll({
      where,
      order: [['mam_name', 'ASC']],
      limit: parsedLimit
    });
  }

  async authenticateManager({ email, password, ip, userAgent }) {
    const normalizedEmail = email ? email.toLowerCase() : null;
    const account = normalizedEmail
      ? await MAMAccount.scope('withSecrets').findOne({
        where: { login_email: normalizedEmail }
      })
      : null;

    if (!account || !account.login_password_hash) {
      const error = new Error('Invalid credentials');
      error.statusCode = 401;
      throw error;
    }

    const valid = await comparePassword(password, account.login_password_hash);
    if (!valid) {
      const error = new Error('Invalid credentials');
      error.statusCode = 401;
      throw error;
    }

    if (account.status !== 'active') {
      const error = new Error('MAM account is not active');
      error.statusCode = 403;
      throw error;
    }

    const jwtSecret = process.env.JWT_SECRET || 'your_jwt_secret';
    const { v4: uuidv4 } = require('uuid');
    const sessionId = uuidv4();

    const payload = {
      sub: account.id,
      account_type: 'mam_manager',
      mam_account_id: account.id,
      mam_name: account.mam_name,
      account_number: account.account_number,
      role: 'mam_manager',
      status: account.status,
      session_id: sessionId,
      is_active: account.status === 'active'
    };

    const accessToken = jwt.sign(payload, jwtSecret, { expiresIn: '7d', jwtid: sessionId });
    const refreshToken = jwt.sign(
      { mamAccountId: account.id, sessionId },
      `${jwtSecret}_REFRESH`,
      { expiresIn: '7d' }
    );

    await storeSession(account.id, sessionId, {
      ...payload,
      jwt: accessToken,
      refresh_token: refreshToken
    }, 'mam_manager', refreshToken);

    const mergedMetadata = {
      ...(account.metadata || {}),
      last_login_ip: ip,
      last_login_user_agent: userAgent
    };

    await account.update({ last_login_at: new Date(), metadata: mergedMetadata });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 1800,
      token_type: 'Bearer',
      session_id: sessionId
    };
  }

  async refreshManagerToken(refreshToken) {
    if (!refreshToken) {
      const error = new Error('refresh_token is required');
      error.statusCode = 400;
      throw error;
    }

    const jwtSecret = process.env.JWT_SECRET || 'your_jwt_secret';
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, `${jwtSecret}_REFRESH`);
    } catch (error) {
      await deleteRefreshToken(refreshToken);
      const err = new Error('Invalid or expired refresh token');
      err.statusCode = 401;
      throw err;
    }

    const tokenData = await validateRefreshToken(refreshToken);
    if (!tokenData || tokenData.userType !== 'mam_manager' || tokenData.sessionId !== decoded.sessionId) {
      await deleteRefreshToken(refreshToken);
      const err = new Error('Invalid or expired refresh token');
      err.statusCode = 401;
      throw err;
    }

    const account = await MAMAccount.scope('withSecrets').findByPk(decoded.mamAccountId);
    if (!account) {
      await deleteRefreshToken(refreshToken);
      const err = new Error('MAM account not found');
      err.statusCode = 404;
      throw err;
    }

    const payload = {
      sub: account.id,
      account_type: 'mam_manager',
      mam_account_id: account.id,
      mam_name: account.mam_name,
      account_number: account.account_number,
      role: 'mam_manager',
      status: account.status,
      session_id: decoded.sessionId,
      is_active: account.status === 'active'
    };

    const newAccessToken = jwt.sign(payload, jwtSecret, { expiresIn: '7d', jwtid: decoded.sessionId });
    const newRefreshToken = jwt.sign(
      { mamAccountId: account.id, sessionId: decoded.sessionId },
      `${jwtSecret}_REFRESH`,
      { expiresIn: '7d' }
    );

    await storeSession(account.id, decoded.sessionId, {
      ...payload,
      jwt: newAccessToken,
      refresh_token: newRefreshToken
    }, 'mam_manager', newRefreshToken);

    await deleteRefreshToken(refreshToken);

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_in: 1800,
      token_type: 'Bearer',
      session_id: decoded.sessionId
    };
  }

  async logoutManager({ mamAccountId, sessionId, refreshToken }) {
    if (!mamAccountId || !sessionId) {
      const error = new Error('Invalid session context');
      error.statusCode = 400;
      throw error;
    }

    await deleteSession(mamAccountId, sessionId, 'mam_manager', refreshToken || null);
    return { success: true };
  }
}

module.exports = new MAMAccountService();
