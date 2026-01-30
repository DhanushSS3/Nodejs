const LiveUser = require('./liveUser.model');
const DemoUser = require('./demoUser.model');
const LiveUserOrder = require('./liveUserOrder.model');
const DemoUserOrder = require('./demoUserOrder.model');
const MoneyRequest = require('./moneyRequest.model');
const Admin = require('./admin.model');
const UserTransaction = require('./userTransaction.model');
const GatewayPayment = require('./gatewayPayment.model');
const GatewayPaymentEvent = require('./gatewayPaymentEvent.model');
const MAMAccount = require('./mamAccount.model');
const MAMOrder = require('./mamOrder.model');
const MAMAssignment = require('./mamAssignment.model');

/**
 * Define associations between models
 */
function defineAssociations() {
  // LiveUser has many LiveUserOrders
  LiveUser.hasMany(LiveUserOrder, {
    foreignKey: 'order_user_id',
    as: 'orders'
  });

  // LiveUserOrder belongs to LiveUser
  LiveUserOrder.belongsTo(LiveUser, {
    foreignKey: 'order_user_id',
    as: 'user'
  });

  // DemoUser has many DemoUserOrders
  DemoUser.hasMany(DemoUserOrder, {
    foreignKey: 'order_user_id',
    as: 'orders'
  });

  // DemoUserOrder belongs to DemoUser
  DemoUserOrder.belongsTo(DemoUser, {
    foreignKey: 'order_user_id',
    as: 'user'
  });

  // MoneyRequest associations (for admin panel and references)
  MoneyRequest.belongsTo(LiveUser, {
    foreignKey: 'user_id',
    as: 'user',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  MoneyRequest.belongsTo(Admin, {
    foreignKey: 'admin_id',
    as: 'admin',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
  });

  // Soft reference by transaction_id string to UserTransaction.transaction_id
  MoneyRequest.belongsTo(UserTransaction, {
    foreignKey: 'transaction_id',
    targetKey: 'transaction_id',
    as: 'transaction',
    constraints: false
  });

  GatewayPayment.hasMany(GatewayPaymentEvent, {
    foreignKey: 'gateway_payment_id',
    as: 'events',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    constraints: false
  });

  GatewayPaymentEvent.belongsTo(GatewayPayment, {
    foreignKey: 'gateway_payment_id',
    as: 'payment',
    constraints: false
  });

  // Soft reference by transaction_id string to UserTransaction.transaction_id
  GatewayPayment.belongsTo(UserTransaction, {
    foreignKey: 'transaction_id',
    targetKey: 'transaction_id',
    as: 'transaction',
    constraints: false
  });

  // MAM associations
  MAMAccount.belongsTo(Admin, {
    foreignKey: 'created_by_admin_id',
    as: 'creator',
    constraints: false
  });

  MAMAccount.hasMany(MAMOrder, {
    foreignKey: 'mam_account_id',
    as: 'orders',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  MAMOrder.belongsTo(MAMAccount, {
    foreignKey: 'mam_account_id',
    as: 'mamAccount'
  });

  MAMAccount.hasMany(MAMAssignment, {
    foreignKey: 'mam_account_id',
    as: 'assignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  MAMAssignment.belongsTo(MAMAccount, {
    foreignKey: 'mam_account_id',
    as: 'mamAccount'
  });

  MAMAssignment.belongsTo(LiveUser, {
    foreignKey: 'client_live_user_id',
    as: 'client'
  });

  LiveUser.hasMany(MAMAssignment, {
    foreignKey: 'client_live_user_id',
    as: 'mamAssignments'
  });

  LiveUserOrder.belongsTo(MAMOrder, {
    foreignKey: 'parent_mam_order_id',
    as: 'parentMAMOrder',
    constraints: false
  });
}

module.exports = { defineAssociations };
