const adminAuthService = require('../services/admin.auth.service');

class AdminAuthController {
  async login(req, res, next) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
      }

      const { adminId } = await adminAuthService.login(email, password);

      res.status(200).json({
        message: 'OTP has been sent to your email.',
        adminId, // Sent for the next step (OTP verification)
      });
    } catch (error) {
      res.status(401).json({ message: error.message });
    }
  }

  async verifyOtp(req, res, next) {
    try {
      const { adminId, otp } = req.body;
      if (!adminId || !otp) {
        return res.status(400).json({ message: 'Admin ID and OTP are required' });
      }

      const tokens = await adminAuthService.verifyOtp(adminId, otp);

      res.status(200).json(tokens);
    } catch (error) {
      res.status(401).json({ message: error.message });
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ message: 'Refresh token is required' });
      }

      const newTokens = await adminAuthService.refreshToken(refreshToken);

      res.status(200).json(newTokens);
    } catch (error) {
      res.status(401).json({ message: error.message });
    }
  }

  async logout(req, res, next) {
    try {
      const { sub, jti } = req.admin;
      await adminAuthService.logout(sub, jti);
      res.status(200).json({ message: 'Successfully logged out' });
    } catch (error) {
      res.status(500).json({ message: 'Logout failed', error: error.message });
    }
  }
}

module.exports = new AdminAuthController();
