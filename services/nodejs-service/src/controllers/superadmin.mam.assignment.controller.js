const mamAssignmentService = require('../services/mamAssignment.service');
const { ASSIGNMENT_INITIATORS } = require('../constants/mamAssignment.constants');

class SuperadminMAMAssignmentController {
  async createAssignment(req, res) {
    try {
      const adminId = req.admin?.id;
      const assignment = await mamAssignmentService.createAssignment({
        mamAccountId: req.body.mam_account_id,
        clientId: req.body.client_live_user_id,
        initiatedBy: ASSIGNMENT_INITIATORS.ADMIN,
        initiatedByAdminId: adminId,
        initiatedReason: req.body.initiated_reason
      });

      return res.status(201).json({
        success: true,
        message: 'Assignment created and pending client review',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to create assignment',
        code: error.code
      });
    }
  }

  async listAssignments(req, res) {
    try {
      const result = await mamAssignmentService.listAssignments({
        status: req.query.status,
        mamAccountId: req.query.mam_account_id,
        clientId: req.query.client_id,
        page: req.query.page,
        limit: req.query.limit
      });

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
      const assignment = await mamAssignmentService.getAssignmentById(req.params.id);
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

  async cancelAssignment(req, res) {
    try {
      const assignment = await mamAssignmentService.cancelAssignment({
        assignmentId: req.params.id,
        actor: 'admin'
      });

      return res.status(200).json({
        success: true,
        message: 'Assignment cancelled successfully',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to cancel assignment'
      });
    }
  }

  async approveAssignment(req, res) {
    try {
      const assignment = await mamAssignmentService.adminApproveAssignment({
        assignmentId: req.params.id,
        adminId: req.admin?.id,
        notes: req.body?.notes
      });

      return res.status(200).json({
        success: true,
        message: 'Assignment approved and awaiting client acceptance',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to approve assignment'
      });
    }
  }

  async rejectAssignment(req, res) {
    try {
      const assignment = await mamAssignmentService.adminRejectAssignment({
        assignmentId: req.params.id,
        adminId: req.admin?.id,
        reason: req.body?.reason
      });

      return res.status(200).json({
        success: true,
        message: 'Assignment rejected',
        data: assignment
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to reject assignment'
      });
    }
  }
}

module.exports = new SuperadminMAMAssignmentController();
