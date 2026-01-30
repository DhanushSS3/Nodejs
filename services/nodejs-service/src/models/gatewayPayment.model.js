const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const GatewayPayment = sequelize.define('GatewayPayment', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true,
  },
  merchant_reference_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  gateway: {
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  purpose: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'deposit',
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'PENDING',
  },
  user_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  user_type: {
    type: DataTypes.ENUM('live', 'strategy_provider', 'copy_follower'),
    allowNull: false,
    defaultValue: 'live',
  },
  initiator_user_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  initiator_user_type: {
    type: DataTypes.ENUM('live', 'strategy_provider', 'copy_follower'),
    allowNull: true,
  },
  requested_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
  },
  requested_currency: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'USD',
  },
  paid_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
  },
  paid_currency: {
    type: DataTypes.STRING(10),
    allowNull: true,
  },
  settled_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
  },
  settled_currency: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'USD',
  },
  credited_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
  },
  credited_currency: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'USD',
  },
  exchange_rate: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true,
  },
  fee_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true,
  },
  fee_currency: {
    type: DataTypes.STRING(10),
    allowNull: true,
  },
  provider_reference_id: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  idempotency_key: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  transaction_id: {
    type: DataTypes.STRING(30),
    allowNull: true,
  },
  provider_payload: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  tableName: 'gateway_payments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeCreate: (payment) => {
      if (!payment.merchant_reference_id) {
        const shortUuid = uuidv4().replace(/-/g, '').slice(0, -4);
        payment.merchant_reference_id = `lfxpay_${shortUuid}`;
      }
    },
  },
  indexes: [
    {
      fields: ['merchant_reference_id'],
      unique: true,
      name: 'idx_gateway_payments_merchant_reference_id',
    },
    {
      fields: ['gateway'],
      name: 'idx_gateway_payments_gateway',
    },
    {
      fields: ['gateway', 'provider_reference_id'],
      unique: true,
      name: 'idx_gateway_payments_gateway_provider_reference_id',
    },
    {
      fields: ['user_id'],
      name: 'idx_gateway_payments_user_id',
    },
    {
      fields: ['user_type'],
      name: 'idx_gateway_payments_user_type',
    },
    {
      fields: ['status'],
      name: 'idx_gateway_payments_status',
    },
    {
      fields: ['idempotency_key'],
      name: 'idx_gateway_payments_idempotency_key',
    },
    {
      fields: ['transaction_id'],
      unique: true,
      name: 'idx_gateway_payments_transaction_id',
    },
    {
      fields: ['created_at'],
      name: 'idx_gateway_payments_created_at',
    },
  ],
});

GatewayPayment.generateMerchantReferenceId = function() {
  const shortUuid = uuidv4().replace(/-/g, '').slice(0, -4);
  return `lfxpay_${shortUuid}`;
};

GatewayPayment.findByReferences = async function(merchantReferenceId, providerReferenceId) {
  let payment = null;
  if (merchantReferenceId) {
    payment = await this.findOne({ where: { merchant_reference_id: merchantReferenceId } });
  }
  if (!payment && providerReferenceId) {
    payment = await this.findOne({ where: { provider_reference_id: providerReferenceId } });
  }
  return payment;
};

GatewayPayment.prototype.isFinalState = function() {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(this.status);
};

GatewayPayment.prototype.canBeUpdated = function() {
  return !this.isFinalState();
};

module.exports = GatewayPayment;
