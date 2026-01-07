const mamAccountService = require('../services/mamAccount.service');
const mamAssignmentService = require('../services/mamAssignment.service');
const { ASSIGNMENT_INITIATORS } = require('../constants/mamAssignment.constants');

class MAMClientController {
  _getClientId(req) {
    return req.user?.sub || req.user?.user_id || req.user?.id;
  }

  async listAvailableAccounts(req, res) {
    try {
      const accounts = await mamAccountService.listActiveAccountsForClient(req.query);
      return res.status(200).json({
        success: true,
        message: 'Active MAM accounts retrieved successfully',
        data: accounts
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to load MAM accounts'
      });
    }
  }

  async requestAssignment(req, res) {
    try {
      const clientId = this._getClientId(req);
      const assignment = await mamAssignmentService.createClientAssignment({
        mamAccountId: req.body.mam_account_id,
        clientId,
        initiatedBy: ASSIGNMENT_INITIATORS.CLIENT
      });

      return res.status(201).json({
        success: true,
        message: 'Assignment request submitted. Awaiting approval.',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to request assignment',
        code: error.code
      });
    }
  }

  async listAssignments(req, res) {
    try {
      const clientId = this._getClientId(req);
      const result = await mamAssignmentService.listAssignmentsForClient(clientId, req.query);
      return res.status(200).json({
        success: true,
        message: 'Assignments retrieved successfully',
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to retrieve assignments'
      });
    }
  }

  async getAssignment(req, res) {
    try {
      const clientId = this._getClientId(req);
      const assignment = await mamAssignmentService.getAssignmentForClient(clientId, req.params.id);
      return res.status(200).json({
        success: true,
        message: 'Assignment retrieved successfully',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to retrieve assignment'
      });
    }
  }

  async acceptAssignment(req, res) {
    try {
      const clientId = this._getClientId(req);
      const assignment = await mamAssignmentService.acceptAssignment({
        assignmentId: req.params.id,
        clientId,
        acceptedIp: req.ip
      });

      return res.status(200).json({
        success: true,
        message: 'Assignment accepted. Manual trading disabled.',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to accept assignment',
        code: error.code
      });
    }
  }
}

module.exports = new MAMClientController();
