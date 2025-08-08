'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('demo_users', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      name: Sequelize.STRING,
      email: { type: Sequelize.STRING, unique: true },
      phone_number: { type: Sequelize.STRING, unique: true },
      password: Sequelize.STRING,
      user_type: Sequelize.STRING,
      wallet_balance: { type: Sequelize.DECIMAL, defaultValue: 0 },
      leverage: Sequelize.INTEGER,
      margin: { type: Sequelize.DECIMAL, defaultValue: 0 },
      net_profit: { type: Sequelize.DECIMAL, defaultValue: 0 },
      account_number: { type: Sequelize.STRING, unique: true },
      group: Sequelize.STRING,
      security_question: Sequelize.STRING,
      security_answer: Sequelize.STRING,
      city: Sequelize.STRING,
      state: Sequelize.STRING,
      pincode: Sequelize.STRING,
      country: Sequelize.STRING,
      status: { type: Sequelize.INTEGER, defaultValue: 1 },
      is_active: { type: Sequelize.INTEGER, defaultValue: 1 },
      created_at: { allowNull: false, type: Sequelize.DATE },
      updated_at: { allowNull: false, type: Sequelize.DATE },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('demo_users');
  },
};
