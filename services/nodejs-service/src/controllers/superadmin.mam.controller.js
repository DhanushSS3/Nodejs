const mamAccountService = require('../services/mamAccount.service');
const mamAssignmentService = require('../services/mamAssignment.service');

class SuperadminMAMController {
  async createMAMAccount(req, res) {
    try {
      const adminId = req.admin?.id;
      const account = await mamAccountService.createMAMAccount(req.body, adminId);
      return res.status(201).json({
        success: true,
        message: 'MAM account created successfully',
        data: account
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to create MAM account'
      });
    }
  }

  async listMAMAccounts(req, res) {
    try {
      const result = await mamAccountService.listMAMAccounts(req.query);
      return res.status(200).json({
        success: true,
        message: 'MAM accounts retrieved successfully',
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to retrieve MAM accounts'
      });
    }
  }

  async getMAMAccount(req, res) {
    try {
      const account = await mamAccountService.getMAMAccountById(req.params.id);
      return res.status(200).json({
        success: true,
        message: 'MAM account retrieved successfully',
        data: account
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to retrieve MAM account'
      });
    }
  }

  async updateMAMAccount(req, res) {
    try {
      const account = await mamAccountService.updateMAMAccount(req.params.id, req.body);
      return res.status(200).json({
        success: true,
        message: 'MAM account updated successfully',
        data: account
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to update MAM account'
      });
    }
  }
}

module.exports = new SuperadminMAMController();
