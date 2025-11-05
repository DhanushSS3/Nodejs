const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const CopyFollowerAccount = sequelize.define('CopyFollowerAccount', {
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
  strategy_provider_id: { 
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'strategy_provider_accounts',
      key: 'id'
    }
  },
  
  // Account Identity
  account_name: { 
    type: DataTypes.STRING(150), 
    unique: true,
    allowNull: false // e.g., "Following John's EURUSD Strategy"
  },
  account_number: { 
    type: DataTypes.STRING, 
    unique: true,
    allowNull: false
  },
  
  // Financial Data (Same pattern as LiveUser) - Inherits from strategy provider
  wallet_balance: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0,
    validate: {
      min: 0
    }
  },
  leverage: { 
    type: DataTypes.INTEGER, 
    defaultValue: 100 // Will be set to match strategy provider
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
    allowNull: false // Will be set to match strategy provider's group
  },
  
  // Investment & Copy Trading Settings
  investment_amount: { 
    type: DataTypes.DECIMAL(18, 6), 
    allowNull: false
    // Validation is done dynamically in controller based on strategy provider's min_investment
  },
  initial_investment: { 
    type: DataTypes.DECIMAL(18, 6), 
    allowNull: false // Snapshot of original investment
  },
  current_equity_ratio: { 
    type: DataTypes.DECIMAL(18, 8), 
    defaultValue: 1.0000 // For lot calculation: (wallet_balance + net_profit) / initial_investment
  },
  
  // Copy Settings - SL/TP modifications allowed as per Exness rules
  copy_sl_mode: { 
    type: DataTypes.ENUM('percentage', 'amount', 'none'), 
    defaultValue: 'none' 
  },
  copy_tp_mode: { 
    type: DataTypes.ENUM('percentage', 'amount', 'none'), 
    defaultValue: 'none' 
  },
  sl_percentage: { 
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true,
    validate: {
      min: 0.01,
      max: 100.00
    }
  },
  tp_percentage: { 
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true,
    validate: {
      min: 0.01,
      max: 1000.00
    }
  },
  sl_amount: { 
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
    validate: {
      min: 0.01
    }
  },
  tp_amount: { 
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
    validate: {
      min: 0.01
    }
  },
  
  // Risk Management Settings
  max_lot_size: { 
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true,
    validate: {
      min: 0.00018 // Exness minimum lot size
    }
  },
  max_daily_loss: { 
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
    validate: {
      min: 0
    }
  },
  stop_copying_on_drawdown: { 
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true,
    validate: {
      min: 5.00,
      max: 95.00
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
    defaultValue: 'barclays' // Inherits from strategy provider
  },
  copy_status: { 
    type: DataTypes.ENUM('active', 'paused', 'stopped'), 
    defaultValue: 'active' 
  },
  
  // Auto-cutoff Inheritance (Exness rule: followers inherit master's auto-cutoff)
  auto_cutoff_inherited: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: true 
  },
  auto_cutoff_level: { 
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true // Will be set from strategy provider
  },
  
  // Performance Tracking
  total_profit_loss: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  total_fees_paid: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  total_copied_orders: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  successful_copies: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  failed_copies: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  
  // Subscription Management
  subscription_date: { 
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  last_copy_date: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  pause_reason: { 
    type: DataTypes.STRING,
    allowNull: true
  },
  stop_reason: { 
    type: DataTypes.STRING,
    allowNull: true
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
  tableName: 'copy_follower_accounts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['user_id'] },
    { fields: ['strategy_provider_id'] },
    { fields: ['account_number'] },
    { fields: ['status'] },
    { fields: ['is_active'] },
    { fields: ['copy_status'] },
    { fields: ['subscription_date'] },
    { fields: ['investment_amount'] },
    // Composite indexes for performance
    { fields: ['strategy_provider_id', 'copy_status', 'is_active'] },
    { fields: ['user_id', 'copy_status'] },
    { fields: ['copy_status', 'subscription_date'] }
  ],
  scopes: {
    active: {
      where: { 
        status: 1, 
        is_active: 1,
        copy_status: 'active'
      }
    },
    copying: {
      where: { 
        copy_status: 'active',
        status: 1,
        is_active: 1
      }
    },
    byStrategy(strategyProviderId) {
      return {
        where: { 
          strategy_provider_id: strategyProviderId,
          copy_status: 'active',
          status: 1,
          is_active: 1
        }
      };
    }
  },
  hooks: {
    beforeCreate: async (followerAccount) => {
      // Generate unique account number
      if (!followerAccount.account_number) {
        const timestamp = Date.now().toString();
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        followerAccount.account_number = `CF${timestamp}${random}`;
      }
      
      // Set initial investment snapshot
      if (!followerAccount.initial_investment) {
        followerAccount.initial_investment = followerAccount.investment_amount;
      }
      
      // Inherit settings from strategy provider
      if (followerAccount.strategy_provider_id) {
        const StrategyProviderAccount = require('./strategyProviderAccount.model');
        const strategyProvider = await StrategyProviderAccount.findByPk(followerAccount.strategy_provider_id);
        
        if (strategyProvider) {
          // Inherit group and leverage settings
          followerAccount.group = strategyProvider.group;
          followerAccount.leverage = strategyProvider.leverage;
          followerAccount.sending_orders = strategyProvider.sending_orders;
          
          // Inherit auto-cutoff settings
          if (followerAccount.auto_cutoff_inherited) {
            followerAccount.auto_cutoff_level = strategyProvider.auto_cutoff_level;
          }
        }
      }
    },
    beforeUpdate: (followerAccount) => {
      // Update equity ratio for lot calculations (equity = wallet_balance + net_profit)
      if ((followerAccount.changed('wallet_balance') || followerAccount.changed('net_profit')) && followerAccount.initial_investment > 0) {
        const currentEquity = parseFloat(followerAccount.wallet_balance) + parseFloat(followerAccount.net_profit || 0);
        followerAccount.current_equity_ratio = currentEquity / followerAccount.initial_investment;
      }
    },
    afterUpdate: async (followerAccount) => {
      // Update last copy date when copying
      if (followerAccount.changed('copy_status') && followerAccount.copy_status === 'active') {
        followerAccount.last_copy_date = new Date();
        await followerAccount.save({ hooks: false });
      }
    }
  }
});

module.exports = CopyFollowerAccount;

