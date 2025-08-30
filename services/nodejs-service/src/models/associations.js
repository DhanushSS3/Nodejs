const LiveUser = require('./liveUser.model');
const DemoUser = require('./demoUser.model');
const LiveUserOrder = require('./liveUserOrder.model');
const DemoUserOrder = require('./demoUserOrder.model');

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
}

module.exports = { defineAssociations };
