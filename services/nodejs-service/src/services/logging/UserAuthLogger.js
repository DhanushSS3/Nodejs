const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

/**
 * User Authentication Logger following Single Responsibility Principle
 * Handles all user authentication related logging operations
 */
class UserAuthLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('userAuth', {
      filename: 'userAuth.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    });
    super(logger);
  }

  /**
   * Log live user login
   * @param {Object} loginData 
   */
  logLiveUserLogin({ email, account_number, ip, userAgent, timestamp }) {
    this.info('Live user login', {
      type: 'live_user_login',
      email,
      account_number,
      ip,
      userAgent,
      timestamp
    });
  }

  /**
   * Log demo user login
   * @param {Object} loginData 
   */
  logDemoUserLogin({ email, account_number, ip, userAgent, timestamp }) {
    this.info('Demo user login', {
      type: 'demo_user_login',
      email,
      account_number,
      ip,
      userAgent,
      timestamp
    });
  }

  /**
   * Log authentication failure
   * @param {string} email 
   * @param {string} reason 
   * @param {string} ip 
   * @param {string} userAgent 
   */
  logAuthFailure(email, reason, ip, userAgent) {
    this.warn('Authentication failed', {
      type: 'auth_failure',
      email,
      reason,
      ip,
      userAgent
    });
  }

  /**
   * Log logout event
   * @param {string} email 
   * @param {string} account_number 
   * @param {string} ip 
   * @param {string} userAgent 
   */
  logLogout(email, account_number, ip, userAgent) {
    this.info('User logout', {
      type: 'user_logout',
      email,
      account_number,
      ip,
      userAgent
    });
  }
}

module.exports = UserAuthLogger;
