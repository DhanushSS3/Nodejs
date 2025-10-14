const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const LiveUser = require('../models/liveUser.model');
const logger = require('./logger.service');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Op } = require('sequelize');

class StrategyProviderService {
  
  /**
   * Create a new strategy provider account for authenticated live user
   * @param {number} userId - Live user ID from JWT
   * @param {Object} strategyData - Strategy provider data
   * @returns {Object} Created strategy provider account
   */
  async createStrategyProviderAccount(userId, strategyData) {
    try {
      // Validate user exists and is active
      const user = await LiveUser.findOne({
        where: { 
          id: userId, 
          status: 1, 
          is_active: 1 
        }
      });
      
      if (!user) {
        throw new Error('User not found or inactive');
      }
      
      // Check if strategy name is already taken
      const existingStrategy = await StrategyProviderAccount.findOne({
        where: { strategy_name: strategyData.strategy_name }
      });
      
      if (existingStrategy) {
        throw new Error('Strategy name already exists');
      }
      
      // Validate Exness requirements
      this.validateStrategyRequirements(strategyData);
      
      // Prepare strategy provider data
      const strategyProviderData = {
        user_id: userId,
        strategy_name: strategyData.strategy_name,
        description: strategyData.description || null,
        
        // Financial settings - inherit from main account initially
        wallet_balance: 0, // Start with 0, user will transfer funds
        leverage: strategyData.leverage || user.leverage || 100,
        group: strategyData.group || user.group || 'Standard',
        
        // Strategy configuration
        visibility: strategyData.visibility || 'public',
        performance_fee: strategyData.performance_fee || 20.00,
        max_leverage: strategyData.max_leverage || strategyData.leverage || 100,
        
        // Investment requirements
        min_investment: strategyData.min_investment || 100.00,
        max_total_investment: strategyData.max_total_investment || 500000.00,
        max_followers: strategyData.max_followers || 1000,
        
        // Trading settings - inherit from main account
        sending_orders: user.sending_orders || 'barclays',
        auto_cutoff_level: strategyData.auto_cutoff_level || 50.00,
        
        // Initial status
        status: 1,
        is_active: 1,
        is_catalog_eligible: false, // Will be evaluated later based on performance
        is_trustworthy: false,
        is_kyc_verified: user.status === 1, // Inherit KYC status from main account
        
        // Profile image
        profile_image_url: strategyData.profile_image_url || null
      };
      
      // Generate account number explicitly (backup in case hook doesn't work)
      const timestamp = Date.now().toString();
      const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      strategyProviderData.account_number = `SP${timestamp}${random}`;
      
      // Handle private strategy settings
      if (strategyData.visibility === 'private') {
        if (strategyData.strategy_password) {
          strategyProviderData.strategy_password = await bcrypt.hash(strategyData.strategy_password, 12);
        }
        // Generate access link explicitly (backup in case hook doesn't work)
        const crypto = require('crypto');
        strategyProviderData.access_link = crypto.randomBytes(16).toString('hex');
      }
      
      // Create strategy provider account
      logger.info('Creating strategy provider with data', {
        userId,
        strategyProviderData: { ...strategyProviderData, strategy_password: '[HIDDEN]' }
      });
      
      const strategyProvider = await StrategyProviderAccount.create(strategyProviderData);
      
      logger.info('Strategy provider created with account number', {
        userId,
        accountNumber: strategyProvider.account_number,
        id: strategyProvider.id
      });
      
      logger.info('Strategy provider account created', {
        userId,
        strategyProviderId: strategyProvider.id,
        strategyName: strategyProvider.strategy_name,
        accountNumber: strategyProvider.account_number
      });
      
      // Return strategy provider without sensitive data
      return this.sanitizeStrategyProviderData(strategyProvider);
      
    } catch (error) {
      logger.error('Failed to create strategy provider account', {
        userId,
        error: error.message,
        strategyName: strategyData?.strategy_name
      });
      throw error;
    }
  }
  
  /**
   * Validate strategy provider requirements based on Exness rules
   * @param {Object} strategyData - Strategy data to validate
   */
  validateStrategyRequirements(strategyData) {
    const errors = [];
    
    // Strategy name validation
    if (!strategyData.strategy_name || strategyData.strategy_name.length < 10) {
      errors.push('Strategy name must be at least 10 characters long');
    }
    
    if (strategyData.strategy_name && strategyData.strategy_name.length > 100) {
      errors.push('Strategy name must not exceed 100 characters');
    }
    
    // Performance fee validation (5-50% as per Exness)
    if (strategyData.performance_fee !== undefined) {
      const fee = parseFloat(strategyData.performance_fee);
      if (isNaN(fee) || fee < 5.00 || fee > 50.00) {
        errors.push('Performance fee must be between 5% and 50%');
      }
    }
    
    // Leverage validation
    if (strategyData.leverage !== undefined) {
      const leverage = parseInt(strategyData.leverage);
      if (![50, 100, 200].includes(leverage)) {
        errors.push('Leverage must be 50, 100, or 200');
      }
    }
    
    if (strategyData.max_leverage !== undefined) {
      const maxLeverage = parseInt(strategyData.max_leverage);
      if (![50, 100, 200].includes(maxLeverage)) {
        errors.push('Max leverage must be 50, 100, or 200');
      }
    }
    
    // Investment amount validation
    if (strategyData.min_investment !== undefined) {
      const minInvestment = parseFloat(strategyData.min_investment);
      if (isNaN(minInvestment) || minInvestment < 100.00) {
        errors.push('Minimum investment must be at least $100');
      }
    }
    
    if (strategyData.max_total_investment !== undefined) {
      const maxInvestment = parseFloat(strategyData.max_total_investment);
      if (isNaN(maxInvestment) || maxInvestment > 500000.00) {
        errors.push('Maximum total investment cannot exceed $500,000');
      }
    }
    
    // Auto-cutoff validation
    if (strategyData.auto_cutoff_level !== undefined) {
      const cutoff = parseFloat(strategyData.auto_cutoff_level);
      if (isNaN(cutoff) || cutoff < 10.00 || cutoff > 90.00) {
        errors.push('Auto-cutoff level must be between 10% and 90%');
      }
    }
    
    // Visibility validation
    if (strategyData.visibility && !['public', 'private'].includes(strategyData.visibility)) {
      errors.push('Visibility must be either "public" or "private"');
    }
    
    // Private strategy password validation
    if (strategyData.visibility === 'private' && strategyData.strategy_password) {
      if (strategyData.strategy_password.length < 8) {
        errors.push('Strategy password must be at least 8 characters long');
      }
    }
    
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
  }
  
  /**
   * Get strategy provider account by ID for authenticated user
   * @param {number} userId - User ID from JWT
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Strategy provider account
   */
  async getStrategyProviderAccount(userId, strategyProviderId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findOne({
        where: { 
          id: strategyProviderId,
          user_id: userId 
        },
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email']
        }]
      });
      
      if (!strategyProvider) {
        throw new Error('Strategy provider account not found');
      }
      
      return this.sanitizeStrategyProviderData(strategyProvider);
      
    } catch (error) {
      logger.error('Failed to get strategy provider account', {
        userId,
        strategyProviderId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Get all strategy provider accounts for authenticated user
   * @param {number} userId - User ID from JWT
   * @returns {Array} List of strategy provider accounts
   */
  async getUserStrategyProviderAccounts(userId) {
    try {
      const strategyProviders = await StrategyProviderAccount.findAll({
        where: { user_id: userId },
        order: [['created_at', 'DESC']],
        attributes: { 
          exclude: ['strategy_password', 'view_password'] 
        }
      });
      
      return strategyProviders.map(sp => this.sanitizeStrategyProviderData(sp));
      
    } catch (error) {
      logger.error('Failed to get user strategy provider accounts', {
        userId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Remove sensitive data from strategy provider object
   * @param {Object} strategyProvider - Strategy provider instance
   * @returns {Object} Sanitized strategy provider data
   */
  sanitizeStrategyProviderData(strategyProvider) {
    const data = strategyProvider.toJSON ? strategyProvider.toJSON() : strategyProvider;
    
    // Remove sensitive fields
    delete data.strategy_password;
    delete data.view_password;
    
    // Only show access_link to owner for private strategies
    if (data.visibility === 'private' && data.access_link) {
      // Keep access_link for owner, will be filtered in controller if needed
    }
    
    return data;
  }
  
  /**
   * Get strategy provider by access link (for authenticated live users only)
   * @param {string} accessLink - Unique access link
   * @param {number} userId - Authenticated user ID
   * @returns {Object} Strategy provider account (full details for authenticated users)
   */
  async getStrategyProviderByAccessLink(accessLink, userId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findOne({
        where: { 
          access_link: accessLink,
          visibility: 'private',
          status: 1,
          is_active: 1
        },
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email', 'country']
        }]
      });
      
      if (!strategyProvider) {
        throw new Error('Private strategy not found or inactive');
      }
      
      // Check if user is trying to access their own strategy
      if (strategyProvider.user_id === userId) {
        throw new Error('Cannot follow your own strategy');
      }
      
      // Check if strategy provider meets private strategy requirements
      const meetsRequirements = await this.checkPrivateStrategyRequirements(strategyProvider.id);
      if (!meetsRequirements.eligible) {
        throw new Error(`Strategy does not meet requirements: ${meetsRequirements.reason}`);
      }
      
      logger.info('Private strategy accessed by authenticated user', {
        strategyProviderId: strategyProvider.id,
        userId,
        accessLink
      });
      
      // Return full strategy details (excluding sensitive data)
      const sanitizedData = this.sanitizeStrategyProviderData(strategyProvider);
      
      // Add additional info for private strategy access
      return {
        ...sanitizedData,
        is_private: true,
        can_follow: true,
        requirements_met: meetsRequirements
      };
      
    } catch (error) {
      logger.error('Failed to get strategy provider by access link', {
        accessLink,
        userId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Verify private strategy password and get full details
   * @param {string} accessLink - Unique access link
   * @param {string} password - Strategy password
   * @param {number} userId - User ID (for potential follower)
   * @returns {Object} Full strategy provider details
   */
  async verifyPrivateStrategyAccess(accessLink, password, userId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findOne({
        where: { 
          access_link: accessLink,
          visibility: 'private',
          status: 1,
          is_active: 1
        },
        include: [{
          model: LiveUser,
          as: 'owner',
          attributes: ['id', 'name', 'email', 'country']
        }]
      });
      
      if (!strategyProvider) {
        throw new Error('Private strategy not found');
      }
      
      // Verify password
      const isPasswordValid = await bcrypt.compare(password, strategyProvider.strategy_password);
      if (!isPasswordValid) {
        throw new Error('Invalid strategy password');
      }
      
      // Check if user is trying to access their own strategy
      if (strategyProvider.user_id === userId) {
        throw new Error('Cannot follow your own strategy');
      }
      
      // Check if strategy provider meets private strategy requirements
      const meetsRequirements = await this.checkPrivateStrategyRequirements(strategyProvider.id);
      if (!meetsRequirements.eligible) {
        throw new Error(`Strategy does not meet requirements: ${meetsRequirements.reason}`);
      }
      
      logger.info('Private strategy access verified', {
        strategyProviderId: strategyProvider.id,
        userId,
        accessLink
      });
      
      // Return full strategy details (excluding sensitive data)
      return this.sanitizeStrategyProviderData(strategyProvider);
      
    } catch (error) {
      logger.error('Failed to verify private strategy access', {
        accessLink,
        userId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Check if private strategy meets requirements for copy trading
   * Private strategies only need: equity > $100
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Eligibility result
   */
  async checkPrivateStrategyRequirements(strategyProviderId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
      
      if (!strategyProvider) {
        return { eligible: false, reason: 'Strategy not found' };
      }
      
      // Private strategy requirements: Only equity > $100
      const minEquity = 100.00;
      const currentEquity = parseFloat(strategyProvider.equity || 0);
      
      if (currentEquity < minEquity) {
        return { 
          eligible: false, 
          reason: `Minimum equity of $${minEquity} required. Current equity: $${currentEquity.toFixed(2)}`,
          requirements: {
            min_equity: minEquity,
            current_equity: currentEquity
          }
        };
      }
      
      return { 
        eligible: true, 
        requirements: {
          min_equity: minEquity,
          current_equity: currentEquity
        }
      };
      
    } catch (error) {
      logger.error('Failed to check private strategy requirements', {
        strategyProviderId,
        error: error.message
      });
      return { eligible: false, reason: 'Error checking requirements' };
    }
  }
  
  /**
   * Check if public strategy meets catalog requirements
   * Public strategies need: 10+ closed trades, 30+ days active, recent activity
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Eligibility result
   */
  async checkPublicStrategyRequirements(strategyProviderId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
      
      if (!strategyProvider) {
        return { eligible: false, reason: 'Strategy not found' };
      }
      
      const requirements = {
        min_closed_trades: 10,
        min_days_active: 30,
        max_days_since_last_trade: 7,
        min_equity: 100.00
      };
      
      const currentEquity = parseFloat(strategyProvider.equity || 0);
      const closedTrades = strategyProvider.closed_trades || 0;
      const createdAt = new Date(strategyProvider.created_at);
      const lastTradeDate = strategyProvider.last_trade_date ? new Date(strategyProvider.last_trade_date) : null;
      const now = new Date();
      
      // Check days active
      const daysActive = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      
      // Check days since last trade
      const daysSinceLastTrade = lastTradeDate ? 
        Math.floor((now - lastTradeDate) / (1000 * 60 * 60 * 24)) : 999;
      
      const failures = [];
      
      if (currentEquity < requirements.min_equity) {
        failures.push(`Minimum equity of $${requirements.min_equity} required`);
      }
      
      if (closedTrades < requirements.min_closed_trades) {
        failures.push(`Minimum ${requirements.min_closed_trades} closed trades required`);
      }
      
      if (daysActive < requirements.min_days_active) {
        failures.push(`Minimum ${requirements.min_days_active} days active required`);
      }
      
      if (daysSinceLastTrade > requirements.max_days_since_last_trade) {
        failures.push(`Must have traded within last ${requirements.max_days_since_last_trade} days`);
      }
      
      return {
        eligible: failures.length === 0,
        reason: failures.length > 0 ? failures.join(', ') : 'All requirements met',
        requirements,
        current: {
          equity: currentEquity,
          closed_trades: closedTrades,
          days_active: daysActive,
          days_since_last_trade: daysSinceLastTrade
        }
      };
      
    } catch (error) {
      logger.error('Failed to check public strategy requirements', {
        strategyProviderId,
        error: error.message
      });
      return { eligible: false, reason: 'Error checking requirements' };
    }
  }
  
  /**
   * Check if user can create more strategy provider accounts
   * @param {number} userId - User ID
   * @returns {boolean} Can create more accounts
   */
  async canCreateMoreAccounts(userId) {
    const count = await StrategyProviderAccount.count({
      where: { 
        user_id: userId,
        status: 1,
        is_active: 1
      }
    });
    
    // Allow up to 5 strategy provider accounts per user (configurable)
    const maxAccounts = process.env.MAX_STRATEGY_ACCOUNTS_PER_USER || 5;
    return count < maxAccounts;
  }

  /**
   * Check catalog eligibility for strategy provider
   * Eligibility Requirements:
   * - Minimum 10 closed trades
   * - 30 days after first trade
   * - Last trade within 7 days
   * - Return >= 0%
   * - Not archived (auto-cutoff not triggered)
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Eligibility result with detailed requirements
   */
  async checkCatalogEligibility(strategyProviderId) {
    try {
      const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId);
      
      if (!strategyProvider) {
        return { eligible: false, reason: 'Strategy provider not found' };
      }

      // Check if strategy is active and not archived
      if (strategyProvider.status !== 1 || strategyProvider.is_active !== 1) {
        return { eligible: false, reason: 'Strategy provider is inactive or archived' };
      }

      // Get actual order statistics from database
      const orderStats = await this.getStrategyOrderStatistics(strategyProviderId);
      
      const requirements = {
        min_closed_trades: 10,
        min_days_since_first_trade: 30,
        max_days_since_last_trade: 7,
        min_return_percentage: 0
      };

      const now = new Date();
      const failures = [];

      // Check minimum closed trades
      if (orderStats.closed_trades < requirements.min_closed_trades) {
        failures.push(`Minimum ${requirements.min_closed_trades} closed trades required (current: ${orderStats.closed_trades})`);
      }

      // Check 30 days since first trade
      if (orderStats.first_trade_date) {
        const daysSinceFirstTrade = Math.floor((now - new Date(orderStats.first_trade_date)) / (1000 * 60 * 60 * 24));
        if (daysSinceFirstTrade < requirements.min_days_since_first_trade) {
          failures.push(`Must complete ${requirements.min_days_since_first_trade} days after first trade (current: ${daysSinceFirstTrade} days)`);
        }
      } else {
        failures.push('No trades found - first trade required');
      }

      // Check last trade within 7 days
      if (orderStats.last_trade_date) {
        const daysSinceLastTrade = Math.floor((now - new Date(orderStats.last_trade_date)) / (1000 * 60 * 60 * 24));
        if (daysSinceLastTrade > requirements.max_days_since_last_trade) {
          failures.push(`Last trade must be within ${requirements.max_days_since_last_trade} days (current: ${daysSinceLastTrade} days ago)`);
        }
      } else {
        failures.push('No recent trades - must have traded within 7 days');
      }

      // Check return percentage >= 0%
      const totalReturn = parseFloat(strategyProvider.total_return_percentage || 0);
      if (totalReturn < requirements.min_return_percentage) {
        failures.push(`Return must be >= ${requirements.min_return_percentage}% (current: ${totalReturn.toFixed(2)}%)`);
      }

      const isEligible = failures.length === 0;

      return {
        eligible: isEligible,
        reason: isEligible ? 'All catalog requirements met' : failures.join(', '),
        requirements,
        current: {
          closed_trades: orderStats.closed_trades,
          total_trades: orderStats.total_trades,
          first_trade_date: orderStats.first_trade_date,
          last_trade_date: orderStats.last_trade_date,
          days_since_first_trade: orderStats.first_trade_date ? 
            Math.floor((now - new Date(orderStats.first_trade_date)) / (1000 * 60 * 60 * 24)) : 0,
          days_since_last_trade: orderStats.last_trade_date ? 
            Math.floor((now - new Date(orderStats.last_trade_date)) / (1000 * 60 * 60 * 24)) : 999,
          total_return_percentage: totalReturn,
          status: strategyProvider.status,
          is_active: strategyProvider.is_active
        }
      };

    } catch (error) {
      logger.error('Failed to check catalog eligibility', {
        strategyProviderId,
        error: error.message
      });
      return { eligible: false, reason: 'Error checking catalog eligibility' };
    }
  }

  /**
   * Get detailed order statistics for strategy provider
   * @param {number} strategyProviderId - Strategy provider ID
   * @returns {Object} Order statistics
   */
  async getStrategyOrderStatistics(strategyProviderId) {
    try {
      // Get all orders for this strategy provider
      const orders = await StrategyProviderOrder.findAll({
        where: { order_user_id: strategyProviderId },
        attributes: ['order_status', 'created_at', 'updated_at'],
        order: [['created_at', 'ASC']]
      });

      const stats = {
        total_trades: orders.length,
        closed_trades: 0,
        open_trades: 0,
        pending_trades: 0,
        first_trade_date: null,
        last_trade_date: null,
        last_closed_trade_date: null
      };

      if (orders.length === 0) {
        return stats;
      }

      // Set first trade date
      stats.first_trade_date = orders[0].created_at;

      // Process each order
      orders.forEach(order => {
        const status = order.order_status?.toUpperCase();
        
        switch (status) {
          case 'CLOSED':
            stats.closed_trades++;
            // Use updated_at for closed orders (when they were closed)
            if (order.updated_at) {
              if (!stats.last_closed_trade_date || new Date(order.updated_at) > new Date(stats.last_closed_trade_date)) {
                stats.last_closed_trade_date = order.updated_at;
              }
            }
            break;
          case 'OPEN':
            stats.open_trades++;
            break;
          case 'PENDING':
            stats.pending_trades++;
            break;
        }

        // Update last trade date (any order activity)
        const tradeDate = order.updated_at || order.created_at;
        if (!stats.last_trade_date || new Date(tradeDate) > new Date(stats.last_trade_date)) {
          stats.last_trade_date = tradeDate;
        }
      });

      return stats;

    } catch (error) {
      logger.error('Failed to get strategy order statistics', {
        strategyProviderId,
        error: error.message
      });
      return {
        total_trades: 0,
        closed_trades: 0,
        open_trades: 0,
        pending_trades: 0,
        first_trade_date: null,
        last_trade_date: null,
        last_closed_trade_date: null
      };
    }
  }

  /**
   * Get catalog eligible strategy providers for authenticated live users
   * Returns minimal fields for catalog display
   * @param {Object} filters - Filter options
   * @param {number} page - Page number (default: 1)
   * @param {number} limit - Items per page (default: 20, max: 100)
   * @returns {Object} Paginated list of catalog eligible strategies
   */
  async getCatalogStrategies(filters = {}, page = 1, limit = 20) {
    try {
      // Validate and sanitize pagination
      const pageNum = Math.max(1, parseInt(page) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
      const offset = (pageNum - 1) * limitNum;

      // Build where conditions
      const whereConditions = {
        status: 1,
        is_active: 1,
        visibility: 'public',
        is_catalog_eligible: true // Only pre-approved catalog eligible strategies
      };

      // Apply filters
      if (filters.min_return !== undefined) {
        whereConditions.total_return_percentage = {
          [Op.gte]: parseFloat(filters.min_return) || 0
        };
      }

      if (filters.max_return !== undefined) {
        whereConditions.total_return_percentage = {
          ...whereConditions.total_return_percentage,
          [Op.lte]: parseFloat(filters.max_return)
        };
      }

      if (filters.min_followers !== undefined) {
        whereConditions.total_followers = {
          [Op.gte]: parseInt(filters.min_followers) || 0
        };
      }

      if (filters.performance_fee !== undefined) {
        whereConditions.performance_fee = {
          [Op.lte]: parseFloat(filters.performance_fee) || 50
        };
      }

      // Max drawdown filter (for moderate drawdown strategies)
      if (filters.max_drawdown !== undefined) {
        whereConditions.max_drawdown = {
          [Op.lte]: parseFloat(filters.max_drawdown)
        };
      }

      // Three month return filter
      if (filters.min_three_month_return !== undefined) {
        whereConditions.three_month_return = {
          [Op.gte]: parseFloat(filters.min_three_month_return) || 0
        };
      }

      // Search by strategy name
      if (filters.search) {
        whereConditions.strategy_name = {
          [Op.iLike]: `%${filters.search}%`
        };
      }

      // Sorting options
      let orderBy = [['total_return_percentage', 'DESC']]; // Default: best performing first
      
      if (filters.sort_by === 'followers') {
        orderBy = [['total_followers', 'DESC']];
      } else if (filters.sort_by === 'newest') {
        orderBy = [['created_at', 'DESC']];
      } else if (filters.sort_by === 'performance_fee') {
        orderBy = [['performance_fee', 'ASC']]; // Lowest fee first
      } else if (filters.sort_by === 'three_month_return') {
        orderBy = [['three_month_return', 'DESC']]; // Best 3-month performance first
      } else if (filters.sort_by === 'drawdown') {
        orderBy = [['max_drawdown', 'ASC']]; // Lowest drawdown first
      }

      // Execute query
      const { count, rows } = await StrategyProviderAccount.findAndCountAll({
        where: whereConditions,
        attributes: [
          'id',
          'strategy_name',
          'total_return_percentage',
          'total_followers',
          'performance_fee',
          'min_investment',
          'max_total_investment',
          'win_rate',
          'closed_trades',
          'max_drawdown',
          'created_at',
          'profile_image_url'
        ],
        order: orderBy,
        limit: limitNum,
        offset: offset,
        distinct: true
      });

      // Format response data
      const strategies = rows.map(strategy => ({
        id: strategy.id,
        strategy_name: strategy.strategy_name,
        total_return_percentage: parseFloat(strategy.total_return_percentage || 0),
        total_followers: strategy.total_followers || 0,
        performance_fee: parseFloat(strategy.performance_fee || 0),
        min_investment: parseFloat(strategy.min_investment || 0),
        max_total_investment: parseFloat(strategy.max_total_investment || 0),
        win_rate: parseFloat(strategy.win_rate || 0),
        closed_trades: strategy.closed_trades || 0,
        max_drawdown: parseFloat(strategy.max_drawdown || 0),
        created_at: strategy.created_at,
        profile_image_url: strategy.profile_image_url
      }));

      return {
        strategies,
        pagination: {
          current_page: pageNum,
          per_page: limitNum,
          total_items: count,
          total_pages: Math.ceil(count / limitNum),
          has_next_page: pageNum < Math.ceil(count / limitNum),
          has_prev_page: pageNum > 1
        },
        filters_applied: filters
      };

    } catch (error) {
      logger.error('Failed to get catalog strategies', {
        filters,
        page,
        limit,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new StrategyProviderService();
