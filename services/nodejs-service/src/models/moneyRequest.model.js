const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const MoneyRequest = sequelize.define('MoneyRequest', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true,
    allowNull: false,
    comment: 'Primary key',
  },
  request_id: {
    type: DataTypes.STRING(20),
    allowNull: false,
    unique: true,
    comment: 'External reference ID (e.g. REQ20250001)',
  },
  user_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: 'Reference to live_users.id',
  },
  initiator_user_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'ID of the user/account that initiated the request',
  },
  initiator_user_type: {
    type: DataTypes.ENUM('live', 'strategy_provider', 'copy_follower'),
    allowNull: true,
    comment: 'Account type of the initiator',
  },
  target_account_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'ID of the wallet/account the request operates on',
  },
  target_account_type: {
    type: DataTypes.ENUM('live', 'strategy_provider', 'copy_follower'),
    allowNull: true,
    comment: 'Account type of the wallet/account the request operates on',
  },
  account_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Platform account number snapshot at time of request',
  },
  method_type: {
    type: DataTypes.ENUM('BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'),
    allowNull: true,
    comment: 'Withdrawal method type',
  },
  method_details: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Arbitrary details provided by user (e.g., upi_id, iban, swift, bank_account_number, ifsc, paypal_email, crypto_address, etc.)',
  },
  type: {
    type: DataTypes.ENUM('deposit', 'withdraw'),
    allowNull: false,
    comment: 'Request type',
  },
  amount: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    comment: 'Requested amount',
  },
  currency: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'USD',
    comment: 'Currency code (expandable for future)',
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'rejected', 'on_hold'),
    allowNull: false,
    defaultValue: 'pending',
    comment: 'Review state',
  },
  admin_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Admin who handled the request',
  },
  approved_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'When the request was approved/rejected',
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Admin remarks or additional information',
  },
  transaction_id: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Link to user_transactions.transaction_id if approved',
  },
}, {
  tableName: 'money_requests',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      unique: true,
      fields: ['request_id']
    },
    {
      fields: ['user_id']
    },
    {
      fields: ['status']
    },
    {
      fields: ['type']
    },
    {
      fields: ['admin_id']
    },
    {
      fields: ['transaction_id']
    },
    {
      fields: ['created_at']
    },
    {
      fields: ['method_type']
    },
    {
      fields: ['account_number']
    },
    {
      fields: ['user_id', 'status']
    },
    {
      fields: ['status', 'created_at']
    },
    {
      fields: ['target_account_type']
    },
    {
      fields: ['target_account_id']
    },
    {
      fields: ['initiator_user_id']
    },
    {
      fields: ['initiator_user_type']
    }
  ],
  scopes: {
    pending: {
      where: {
        status: 'pending'
      }
    },
    approved: {
      where: {
        status: 'approved'
      }
    },
    rejected: {
      where: {
        status: 'rejected'
      }
    },
    deposits: {
      where: {
        type: 'deposit'
      }
    },
    withdrawals: {
      where: {
        type: 'withdraw'
      }
    },
    byUser: (userId) => ({
      where: {
        user_id: userId
      }
    }),
    byAdmin: (adminId) => ({
      where: {
        admin_id: adminId
      }
    }),
    recent: {
      order: [['created_at', 'DESC']]
    },
    withTransaction: {
      where: {
        transaction_id: {
          [sequelize.Sequelize.Op.ne]: null
        }
      }
    }
  }
});

// Define associations
MoneyRequest.associate = (models) => {
  // Belongs to LiveUser
  MoneyRequest.belongsTo(models.LiveUser, {
    foreignKey: 'user_id',
    as: 'user',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  // Belongs to Admin
  MoneyRequest.belongsTo(models.Admin, {
    foreignKey: 'admin_id',
    as: 'admin',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
  });

  // Optional: Reference to UserTransaction if approved
  MoneyRequest.belongsTo(models.UserTransaction, {
    foreignKey: 'transaction_id',
    targetKey: 'transaction_id',
    as: 'transaction',
    constraints: false // Soft reference since transaction_id is string
  });
};

module.exports = MoneyRequest;
