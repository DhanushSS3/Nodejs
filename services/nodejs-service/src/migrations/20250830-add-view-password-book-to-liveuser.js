'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('live_users', 'view_password', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: 'Hashed view password for read-only access'
    });

    await queryInterface.addColumn('live_users', 'book', {
      type: Sequelize.STRING(5),
      allowNull: true,
      comment: 'Book identifier, max 5 alphanumeric characters'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('live_users', 'view_password');
    await queryInterface.removeColumn('live_users', 'book');
  }
};
