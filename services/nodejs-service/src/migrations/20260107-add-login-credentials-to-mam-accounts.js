/* eslint-disable no-unused-vars */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('mam_accounts', 'login_email', {
      type: Sequelize.STRING(150),
      allowNull: true
    });

    await queryInterface.addColumn('mam_accounts', 'login_password_hash', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addColumn('mam_accounts', 'last_login_at', {
      type: Sequelize.DATE,
      allowNull: true
    });

    await queryInterface.addIndex('mam_accounts', {
      fields: ['login_email'],
      unique: true,
      name: 'mam_accounts_login_email_unique'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('mam_accounts', 'mam_accounts_login_email_unique');
    await queryInterface.removeColumn('mam_accounts', 'last_login_at');
    await queryInterface.removeColumn('mam_accounts', 'login_password_hash');
    await queryInterface.removeColumn('mam_accounts', 'login_email');
  }
};
