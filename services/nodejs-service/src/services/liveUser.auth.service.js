const { comparePassword, compareViewPassword } = require('./password.service');

/**
 * Authentication service for live users following SOLID principles
 */
class LiveUserAuthService {
  
  /**
   * Validate credentials against both master password and view password
   * @param {string} password - Plain text password from login request
   * @param {Object} user - User object from database
   * @returns {Promise<Object>} - { isValid: boolean, loginType: 'master'|'view'|null }
   */
  static async validateCredentials(password, user) {
    try {
      // First check master password
      const validMasterPassword = await comparePassword(password, user.password);
      if (validMasterPassword) {
        return { isValid: true, loginType: 'master' };
      }

      // If master password fails, check view_password (if exists)
      if (user.view_password) {
        const validViewPassword = await compareViewPassword(password, user.view_password);
        if (validViewPassword) {
          return { isValid: true, loginType: 'view' };
        }
      }

      return { isValid: false, loginType: null };
    } catch (error) {
      throw new Error(`Credential validation failed: ${error.message}`);
    }
  }

  /**
   * Determine user role based on login type
   * @param {string} loginType - 'master' or 'view'
   * @returns {string} - 'trader' or 'viewer'
   */
  static getUserRole(loginType) {
    switch (loginType) {
      case 'master':
        return 'trader';
      case 'view':
        return 'viewer';
      default:
        throw new Error(`Invalid login type: ${loginType}`);
    }
  }

  /**
   * Generate JWT payload for live users
   * @param {Object} user - User object from database
   * @param {string} loginType - 'master' or 'view'
   * @param {string} sessionId - Session ID for the token
   * @returns {Object} - JWT payload object
   */
  static generateJWTPayload(user, loginType, sessionId) {
    const role = this.getUserRole(loginType);
    
    return {
      sub: user.id,
      user_type: user.user_type,
      mam_status: user.mam_status,
      pam_status: user.pam_status,
      sending_orders: user.sending_orders,
      group: user.group,
      account_number: user.account_number,
      session_id: sessionId,
      user_id: user.id,
      status: user.status,
      role: role,
      is_self_trading: user.is_self_trading,
      is_active: user.is_active,
      account_type: 'live'
    };
  }
}

module.exports = LiveUserAuthService;
