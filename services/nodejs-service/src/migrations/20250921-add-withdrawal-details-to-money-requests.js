'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // account_number
    await queryInterface.addColumn('money_requests', 'account_number', {
      type: Sequelize.STRING(50),
      allowNull: true, // keep nullable to avoid migration failures on existing data
      comment: 'Platform account number snapshot at time of request'
    });

    // method_type
    await queryInterface.addColumn('money_requests', 'method_type', {
      type: Sequelize.ENUM('BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'),
      allowNull: true,
      comment: 'Withdrawal method type'
    });

    // method_details JSON
    await queryInterface.addColumn('money_requests', 'method_details', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Arbitrary payout details provided by user'
    });

    // extend status enum to include on_hold
    await queryInterface.changeColumn('money_requests', 'status', {
      type: Sequelize.ENUM('pending', 'approved', 'rejected', 'on_hold'),
      allowNull: false,
      defaultValue: 'pending',
      comment: 'Review state'
    });

    // indexes
    await queryInterface.addIndex('money_requests', ['method_type'], {
      name: 'idx_money_requests_method_type'
    });
    await queryInterface.addIndex('money_requests', ['account_number'], {
      name: 'idx_money_requests_account_number'
    });
  },

  async down(queryInterface, Sequelize) {
    // remove indexes first
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_account_number').catch(() => {});
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_method_type').catch(() => {});

    // revert status enum (drop and recreate may be required on some dialects)
    await queryInterface.changeColumn('money_requests', 'status', {
      type: Sequelize.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
      comment: 'Review state'
    });

    // Drop new columns
    await queryInterface.removeColumn('money_requests', 'method_details').catch(() => {});
    await queryInterface.removeColumn('money_requests', 'method_type').catch(() => {});
    await queryInterface.removeColumn('money_requests', 'account_number').catch(() => {});
  }
};
