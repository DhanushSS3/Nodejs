'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Increase transaction_id column length from 20 to 30 characters
    // to accommodate new Redis-independent ID generation format
    await queryInterface.changeColumn('user_transactions', 'transaction_id', {
      type: Sequelize.STRING(30),
      allowNull: false,
      unique: true,
      comment: 'Unique transaction ID with prefix (e.g., TXN1234567890123456)',
    });
    
    console.log('✅ Increased transaction_id column length to 30 characters');
  },

  async down(queryInterface, Sequelize) {
    // Revert back to original length (only if no data would be truncated)
    await queryInterface.changeColumn('user_transactions', 'transaction_id', {
      type: Sequelize.STRING(20),
      allowNull: false,
      unique: true,
      comment: 'Unique transaction ID with prefix (e.g., TXN1234567890)',
    });
    
    console.log('⚠️  Reverted transaction_id column length to 20 characters');
  }
};
