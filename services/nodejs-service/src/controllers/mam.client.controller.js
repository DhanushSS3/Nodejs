const mamAccountService = require('../services/mamAccount.service');
const mamAssignmentService = require('../services/mamAssignment.service');
const LiveUser = require('../models/liveUser.model');
const { ASSIGNMENT_INITIATORS } = require('../constants/mamAssignment.constants');

function getClientId(req) {
  return req.user?.sub || req.user?.user_id || req.user?.id;
}

class MAMClientController {

  async listAvailableAccounts(req, res) {
    try {
      const clientId = getClientId(req);
      const client = await LiveUser.findByPk(clientId, { attributes: ['group'] });
      if (!client) {
        return res.status(404).json({
          success: false,
          message: 'Client account not found'
        });
      }

      const accounts = await mamAccountService.listActiveAccountsForClient({
        ...req.query,
        group: client.group
      });
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
      const clientId = getClientId(req);
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
      const clientId = getClientId(req);
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
      const clientId = getClientId(req);
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
      const clientId = getClientId(req);
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

  async declineAssignment(req, res) {
    try {
      const clientId = getClientId(req);
      const assignment = await mamAssignmentService.declineAssignment({
        assignmentId: req.params.id,
        clientId,
        declinedIp: req.ip,
        reason: req.body?.reason
      });

      return res.status(200).json({
        success: true,
        message: 'Assignment request declined.',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to decline assignment',
        code: error.code
      });
    }
  }

  async unsubscribeAssignment(req, res) {
    try {
      const clientId = getClientId(req);
      const assignment = await mamAssignmentService.unsubscribeAssignment({
        assignmentId: req.params.id,
        clientId,
        reason: req.body?.reason,
        requestIp: req.ip
      });

      return res.status(200).json({
        success: true,
        message: 'MAM account unsubscribed. Manual control restored.',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to unsubscribe from MAM account'
      });
    }
  }
}

module.exports = new MAMClientController();
