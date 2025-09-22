const LiveUser = require('./liveUser.model');
const DemoUser = require('./demoUser.model');
const LiveUserOrder = require('./liveUserOrder.model');
const DemoUserOrder = require('./demoUserOrder.model');
const MoneyRequest = require('./moneyRequest.model');
const Admin = require('./admin.model');
const UserTransaction = require('./userTransaction.model');

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
}

module.exports = { defineAssociations };
