const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const StrategyProviderAccount = sequelize.define('StrategyProviderAccount', {
  id: { 
    type: DataTypes.INTEGER, 
    autoIncrement: true, 
    primaryKey: true 
  },
  user_id: { 
    type: DataTypes.INTEGER, 
    allowNull: false,
    references: {
      model: 'live_users',
      key: 'id'
    }
  },
  
  // Strategy Identity
  strategy_name: { 
    type: DataTypes.STRING(100), 
    allowNull: false,
    unique: true,
    validate: {
      len: [10, 100] // Minimum 10 characters as per Exness requirement
    }
  },
  description: { 
    type: DataTypes.TEXT,
    allowNull: true 
  },
  account_number: { 
    type: DataTypes.STRING, 
    unique: true,
    allowNull: false
  },
  
  // Financial Data (Same pattern as LiveUser)
  wallet_balance: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0,
    validate: {
      min: 0
    }
  },
  leverage: { 
    type: DataTypes.INTEGER, 
    defaultValue: 100,
    validate: {
      isIn: [[50, 100, 200]] // Max leverage options as per Exness
    }
  },
  margin: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  net_profit: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  group: { 
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Standard'
  },
  
  // Strategy Configuration
  visibility: { 
    type: DataTypes.ENUM('public', 'private'), 
    defaultValue: 'public' 
  },
  access_link: { 
    type: DataTypes.STRING, 
    unique: true,
    allowNull: true // Only for private strategies
  },
  performance_fee: { 
    type: DataTypes.DECIMAL(5, 2), 
    defaultValue: 20.00,
    validate: {
      min: 5.00,
      max: 50.00 // 5-50% as per Exness requirement
    }
  },
  max_leverage: { 
    type: DataTypes.INTEGER, 
    defaultValue: 100,
    validate: {
      isIn: [[50, 100, 200]]
    }
  },
  strategy_password: { 
    type: DataTypes.STRING,
    allowNull: true // Hashed password for strategy access
  },
  
  // Investment Requirements
  min_investment: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 100.00,
    validate: {
      min: 100.00 // Minimum $100 as per Exness
    }
  },
  max_total_investment: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 500000.00,
    validate: {
      max: 500000.00 // Maximum $500k as per Exness
    }
  },
  max_followers: { 
    type: DataTypes.INTEGER, 
    defaultValue: 1000,
    validate: {
      min: 1
    }
  },
  
  // Status & Trading Settings (Same pattern as LiveUser)
  status: { 
    type: DataTypes.INTEGER, 
    defaultValue: 1 // 1 = active, 0 = inactive
  },
  is_active: { 
    type: DataTypes.INTEGER, 
    defaultValue: 1 
  },
  sending_orders: { 
    type: DataTypes.STRING, 
    allowNull: true, 
    defaultValue: 'barclays' 
  },
  auto_cutoff_level: { 
    type: DataTypes.DECIMAL(5, 2), 
    defaultValue: 50.00,
    validate: {
      min: 10.00,
      max: 90.00
    }
  },

  // Archival Tracking
  is_archived: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  archived_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  
  // Catalog Eligibility (Exness requirements)
  is_catalog_eligible: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: false 
  },
  is_trustworthy: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: false 
  },
  catalog_display_date: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  first_trade_date: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  last_trade_date: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  catalog_eligibility_updated_at: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  
  // Superadmin Free Pass for Catalog Display
  catalog_free_pass: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: false 
  },
  catalog_free_pass_granted_by: { 
    type: DataTypes.INTEGER, 
    allowNull: true,
    references: {
      model: 'admins',
      key: 'id'
    }
  },
  catalog_free_pass_granted_at: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  catalog_free_pass_reason: { 
    type: DataTypes.TEXT,
    allowNull: true
  },
  
  // Cached Statistics (Performance optimization)
  total_followers: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  total_investment: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  // Strategy provider's own investment tracking (similar to copy follower)
  provider_investment_amount: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  provider_initial_investment: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  total_trades: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  closed_trades: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  win_rate: { 
    type: DataTypes.DECIMAL(5, 2), 
    defaultValue: 0 
  },
  total_return_percentage: { 
    type: DataTypes.DECIMAL(8, 4), 
    defaultValue: 0 
  },
  three_month_return: { 
    type: DataTypes.DECIMAL(8, 4), 
    defaultValue: 0 
  },
  max_drawdown: { 
    type: DataTypes.DECIMAL(8, 4), 
    defaultValue: 0 
  },
  
  // Media & Presentation
  profile_image_url: { 
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isUrlOrPath(value) {
        if (value === null || value === undefined) return; // Allow null values
        
        // Allow full URLs (http/https)
        const urlPattern = /^https?:\/\/.+/;
        // Allow relative paths starting with /
        const pathPattern = /^\/[^\/].*/;
        
        if (!urlPattern.test(value) && !pathPattern.test(value)) {
          throw new Error('Profile image URL must be a valid URL or relative path starting with /');
        }
      }
    }
  },
  
  // KYC & Verification Status
  is_kyc_verified: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: false 
  },
  
  // Additional LiveUser pattern fields
  view_password: { 
    type: DataTypes.STRING, 
    allowNull: true 
  },
  book: { 
    type: DataTypes.STRING(5), 
    allowNull: true 
  }
  
}, {
  tableName: 'strategy_provider_accounts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['user_id'] },
    { fields: ['strategy_name'] },
    { fields: ['account_number'] },
    { fields: ['status'] },
    { fields: ['is_active'] },
    { fields: ['visibility'] },
    { fields: ['is_catalog_eligible'] },
    { fields: ['is_trustworthy'] },
    { fields: ['total_followers'] },
    { fields: ['performance_fee'] },
    { fields: ['min_investment'] },
    { fields: ['created_at'] },
    // Composite indexes for catalog queries
    { fields: ['is_catalog_eligible', 'status', 'is_active'] },
    { fields: ['visibility', 'is_catalog_eligible', 'total_followers'] },
    { fields: ['performance_fee', 'total_return_percentage'] }
  ],
  scopes: {
    active: {
      where: { 
        status: 1, 
        is_active: 1 
      }
    },
    catalogEligible: {
      where: { 
        is_catalog_eligible: true,
        status: 1,
        is_active: 1,
        visibility: 'public'
      }
    },
    trustworthy: {
      where: { 
        is_trustworthy: true,
        is_catalog_eligible: true,
        status: 1,
        is_active: 1
      }
    }
  },
  hooks: {
    beforeCreate: async (strategyProvider) => {
      // Generate unique account number
      if (!strategyProvider.account_number) {
        const timestamp = Date.now().toString();
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        strategyProvider.account_number = `SP${timestamp}${random}`;
      }
      
      // Generate access link for private strategies
      if (strategyProvider.visibility === 'private' && !strategyProvider.access_link) {
        const crypto = require('crypto');
        strategyProvider.access_link = crypto.randomBytes(16).toString('hex');
      }

      // Set initial provider investment tracking
      if (!strategyProvider.provider_investment_amount) {
        strategyProvider.provider_investment_amount = strategyProvider.wallet_balance || 0;
      }
      if (!strategyProvider.provider_initial_investment) {
        strategyProvider.provider_initial_investment = strategyProvider.wallet_balance || 0;
      }
      
      // Note: total_investment tracks follower investments, not provider's own deposits
      // It starts at 0 and gets updated when followers invest
    },
    beforeUpdate: (strategyProvider) => {
      // Update equity calculation
      if (strategyProvider.changed('wallet_balance') || strategyProvider.changed('net_profit')) {
        strategyProvider.equity = parseFloat(strategyProvider.wallet_balance) + parseFloat(strategyProvider.net_profit || 0);
      }
    }
  }
});

module.exports = StrategyProviderAccount;
