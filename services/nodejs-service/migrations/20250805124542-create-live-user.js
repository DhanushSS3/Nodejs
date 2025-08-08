'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('live_users', {
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
      fund_manager: Sequelize.STRING,
      is_self_trading: { type: Sequelize.INTEGER, defaultValue: 1 },
      id_proof: Sequelize.STRING,
      id_proof_image: Sequelize.STRING,
      address_proof: Sequelize.STRING,
      address_proof_image: Sequelize.STRING,
      bank_ifsc_code: Sequelize.STRING,
      bank_holder_name: Sequelize.STRING,
      bank_account_number: Sequelize.STRING,
      reffered_by_id: Sequelize.INTEGER,
      reffered_code: Sequelize.STRING,
      refferal_code: { type: Sequelize.STRING, unique: true },
      mam_id: Sequelize.INTEGER,
      mam_status: { type: Sequelize.INTEGER, defaultValue: 0 },
      mam_alloted_time: Sequelize.DATE,
      pam_id: Sequelize.INTEGER,
      pam_status: { type: Sequelize.INTEGER, defaultValue: 0 },
      pam_alloted_time: Sequelize.DATE,
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('live_users');
  }
};
