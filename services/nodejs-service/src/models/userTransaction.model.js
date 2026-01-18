// @ts-nocheck
const { DataTypes, Op } = require('sequelize'); // Destructured Op for cleaner scopes
const sequelize = require('../config/db');

const UserTransaction = sequelize.define('UserTransaction', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true,
  },
  transaction_id: {
    type: DataTypes.STRING(30),
    allowNull: false,
    unique: true,
    comment: 'Unique transaction ID with prefix (e.g., TXN1234567890123456)',
  },
  user_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: 'Reference to user (live_users or demo_users)',
  },
  user_type: {
    type: DataTypes.ENUM('live', 'demo', 'strategy_provider', 'copy_follower', 'mam_account'),
    allowNull: false,
    comment: 'Type of user account',
  },
  order_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Reference to order if transaction is order-related',
  },
  type: {
    type: DataTypes.ENUM(
      'deposit',
      'withdraw', 
      'transfer',
      'profit',
      'loss',
      'commission',
      'swap',
      'adjustment',
      'performance_fee',
      'performance_fee_earned'
    ),
    allowNull: false,
    comment: 'Type of transaction',
  },
  amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    comment: 'Transaction amount (positive for credits, negative for debits)',
  },
  balance_before: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    comment: 'User balance before this transaction',
  },
  balance_after: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    comment: 'User balance after this transaction',
  },
  status: {
    type: DataTypes.ENUM('pending', 'completed', 'failed', 'cancelled'),
    allowNull: false,
    defaultValue: 'completed',
    comment: 'Transaction status',
  },
  reference_id: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'External reference ID (payment gateway, bank reference, etc.)',
  },
  admin_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Admin who approved/processed the transaction',
  },
  user_email: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'User email snapshot for audit purposes',
  },
  method_type: {
    type: DataTypes.ENUM('BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'),
    allowNull: true,
    comment: 'Payment method type',
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Additional flexible data',
  },
}, {
  tableName: 'user_transactions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { name: 'idx_user_transactions_user_id', fields: ['user_id'] },
    { name: 'idx_user_transactions_user_type', fields: ['user_type'] },
    { name: 'idx_user_transactions_type', fields: ['type'] },
    { name: 'idx_user_transactions_status', fields: ['status'] },
    { name: 'idx_user_transactions_created_at', fields: ['created_at'] },
    { name: 'idx_user_transactions_transaction_id', fields: ['transaction_id'] },
    { name: 'idx_user_transactions_order_id', fields: ['order_id'] },
    { name: 'idx_user_transactions_user_type_user_id', fields: ['user_type', 'user_id'] },
    { name: 'idx_user_transactions_user_created', fields: ['user_id', 'created_at'] },
    { name: 'idx_user_transactions_user_email', fields: ['user_email'] },
    { name: 'idx_user_transactions_method_type', fields: ['method_type'] }
  ]
});

// Adding scopes using the addScope method is often cleaner for functional scopes
UserTransaction.addScope('liveUsers', { where: { user_type: 'live' } });
UserTransaction.addScope('demoUsers', { where: { user_type: 'demo' } });
UserTransaction.addScope('completed', { where: { status: 'completed' } });
UserTransaction.addScope('pending', { where: { status: 'pending' } });

UserTransaction.addScope('forUser', (userId, userType) => ({
  where: { 
    user_id: userId,
    user_type: userType
  }
}));

UserTransaction.addScope('ofType', (transactionType) => ({
  where: { type: transactionType }
}));

UserTransaction.addScope('dateRange', (startDate, endDate) => ({
  where: {
    created_at: {
      [Op.between]: [startDate, endDate]
    }
  }
}));

module.exports = UserTransaction;