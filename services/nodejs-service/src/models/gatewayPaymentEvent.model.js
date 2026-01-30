
const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const GatewayPaymentEvent = sequelize.define('GatewayPaymentEvent', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true,
  },
  gateway_payment_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  gateway: {
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  provider_event_id: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  event_type: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  payload_hash: {
    type: DataTypes.STRING(64),
    allowNull: true,
  },
  merchant_reference_id: {
    type: DataTypes.STRING(64),
    allowNull: true,
  },
  provider_reference_id: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  processing_status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'RECEIVED',
  },
  processed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  processing_error: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  payload: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  tableName: 'gateway_payment_events',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['gateway_payment_id'],
      name: 'idx_gateway_payment_events_gateway_payment_id',
    },
    {
      fields: ['gateway'],
      name: 'idx_gateway_payment_events_gateway',
    },
    {
      fields: ['gateway', 'provider_event_id'],
      unique: true,
      name: 'idx_gateway_payment_events_gateway_provider_event_id',
    },
    {
      fields: ['gateway', 'payload_hash'],
      unique: true,
      name: 'idx_gateway_payment_events_gateway_payload_hash',
    },
    {
      fields: ['merchant_reference_id'],
      name: 'idx_gateway_payment_events_merchant_reference_id',
    },
    {
      fields: ['provider_reference_id'],
      name: 'idx_gateway_payment_events_provider_reference_id',
    },
    {
      fields: ['processing_status'],
      name: 'idx_gateway_payment_events_processing_status',
    },
    {
      fields: ['created_at'],
      name: 'idx_gateway_payment_events_created_at',
    },
  ],
});

module.exports = GatewayPaymentEvent;
