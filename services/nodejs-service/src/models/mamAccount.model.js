const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const MAMAccount = sequelize.define('MAMAccount', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  created_by_admin_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'admins',
      key: 'id'
    }
  },
  mam_name: {
    type: DataTypes.STRING(150),
    allowNull: false,
    unique: true
  },
  account_number: {
    type: DataTypes.STRING(32),
    allowNull: false,
    unique: true
  },
  login_email: {
    type: DataTypes.STRING(150),
    allowNull: true,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  login_password_hash: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  last_login_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  leverage: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  group: {
    type: DataTypes.STRING,
    allowNull: false
  },
  allocation_method: {
    type: DataTypes.ENUM('balance', 'free_margin'),
    allowNull: false,
    defaultValue: 'free_margin'
  },
  allocation_precision: {
    type: DataTypes.DECIMAL(10, 6),
    allowNull: false,
    defaultValue: 0.01
  },
  rounding_strategy: {
    type: DataTypes.ENUM('symbol_step', 'floor', 'ceil'),
    allowNull: false,
    defaultValue: 'floor'
  },
  min_client_balance: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    defaultValue: 100
  },
  max_client_balance: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    defaultValue: 1000
  },
  max_investors: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 200
  },
  total_investors: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  total_allocated_balance: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    defaultValue: 0
  },
  status: {
    type: DataTypes.ENUM('draft', 'pending_approval', 'active', 'paused', 'closed', 'archived'),
    allowNull: false,
    defaultValue: 'draft'
  },
  fee_model: {
    type: DataTypes.ENUM('performance', 'management', 'hybrid', 'none'),
    allowNull: false,
    defaultValue: 'performance'
  },
  performance_fee_percent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  management_fee_percent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  rebate_fee_percent: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  fee_settlement_cycle: {
    type: DataTypes.ENUM('daily', 'weekly', 'monthly', 'quarterly', 'on_close'),
    allowNull: false,
    defaultValue: 'on_close'
  },
  last_fee_settlement_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  next_fee_settlement_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  allow_partial_closures: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  terms_and_conditions: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'mam_accounts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  defaultScope: {
    attributes: {
      exclude: ['login_password_hash']
    }
  },
  indexes: [
    { fields: ['account_number'] },
    { fields: ['login_email'], unique: true },
    { fields: ['status'] },
    { fields: ['allocation_method'] }
  ],
  hooks: {
    beforeValidate: (mamAccount) => {
      if (!mamAccount.account_number) {
        const timestamp = Date.now().toString();
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        mamAccount.account_number = `MA${timestamp}${random}`;
      }
    }
  },
  scopes: {
    withSecrets: {
      attributes: { include: ['login_password_hash'] }
    },
    active: {
      where: {
        status: 'active'
      }
    },
    pendingApproval: {
      where: {
        status: 'pending_approval'
      }
    }
  }
});

module.exports = MAMAccount;
