const mamAccountService = require('../services/mamAccount.service');

class MAMAuthController {
  async login(req, res) {
    try {
      const result = await mamAccountService.authenticateManager({
        email: req.body.email,
        password: req.body.password,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        ...result
      });
    } catch (error) {
      return res.status(error.statusCode || 401).json({
        success: false,
        message: error.message || 'Unable to login'
      });
    }
  }

  async refreshToken(req, res) {
    try {
      const result = await mamAccountService.refreshManagerToken(req.body.refresh_token);
      return res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        ...result
      });
    } catch (error) {
      return res.status(error.statusCode || 401).json({
        success: false,
        message: error.message || 'Failed to refresh token'
      });
    }
  }

  async logout(req, res) {
    try {
      const mamAccountId = req.user?.mam_account_id || req.user?.sub;
      const sessionId = req.user?.session_id || req.user?.jti;

      await mamAccountService.logoutManager({
        mamAccountId,
        sessionId,
        refreshToken: req.body.refresh_token
      });

      return res.status(200).json({
        success: true,
        message: 'Logout successful'
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Failed to logout'
      });
    }
  }
}

module.exports = new MAMAuthController();
