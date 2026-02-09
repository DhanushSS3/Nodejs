'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('currency_config', {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      currency: {
        type: Sequelize.CHAR(3),
        allowNull: false,
        unique: true,
      },
      minor_unit: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 2,
      },
      enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      min_amount: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false,
        defaultValue: 0,
      },
      max_amount: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false,
        defaultValue: 0,
      },
      settlement_currency: {
        type: Sequelize.CHAR(3),
        allowNull: false,
        defaultValue: 'USD',
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('currency_config', ['currency'], {
      name: 'idx_currency_config_currency',
      unique: true,
    });

    await queryInterface.addIndex('currency_config', ['enabled'], {
      name: 'idx_currency_config_enabled',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('currency_config');
  },
};
