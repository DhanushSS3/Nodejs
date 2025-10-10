'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Create strategy_provider_accounts table
    await queryInterface.createTable('strategy_provider_accounts', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'live_users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      strategy_name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      account_number: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: false
      },
      wallet_balance: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      leverage: {
        type: Sequelize.INTEGER,
        defaultValue: 100
      },
      margin: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      net_profit: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      equity: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      group: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'Standard'
      },
      visibility: {
        type: Sequelize.ENUM('public', 'private'),
        defaultValue: 'public'
      },
      access_link: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: true
      },
      performance_fee: {
        type: Sequelize.DECIMAL(5, 2),
        defaultValue: 20.00
      },
      max_leverage: {
        type: Sequelize.INTEGER,
        defaultValue: 100
      },
      strategy_password: {
        type: Sequelize.STRING,
        allowNull: true
      },
      min_investment: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 100.00
      },
      max_total_investment: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 500000.00
      },
      max_followers: {
        type: Sequelize.INTEGER,
        defaultValue: 1000
      },
      status: {
        type: Sequelize.INTEGER,
        defaultValue: 1
      },
      is_active: {
        type: Sequelize.INTEGER,
        defaultValue: 1
      },
      sending_orders: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'barclays'
      },
      auto_cutoff_level: {
        type: Sequelize.DECIMAL(5, 2),
        defaultValue: 50.00
      },
      is_catalog_eligible: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      is_trustworthy: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      catalog_display_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      first_trade_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      last_trade_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      total_followers: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      total_investment: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      total_trades: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      closed_trades: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      win_rate: {
        type: Sequelize.DECIMAL(5, 2),
        defaultValue: 0
      },
      total_return_percentage: {
        type: Sequelize.DECIMAL(8, 4),
        defaultValue: 0
      },
      three_month_return: {
        type: Sequelize.DECIMAL(8, 4),
        defaultValue: 0
      },
      max_drawdown: {
        type: Sequelize.DECIMAL(8, 4),
        defaultValue: 0
      },
      profile_image_url: {
        type: Sequelize.STRING,
        allowNull: true
      },
      is_kyc_verified: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      view_password: {
        type: Sequelize.STRING,
        allowNull: true
      },
      book: {
        type: Sequelize.STRING(5),
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Create copy_follower_accounts table
    await queryInterface.createTable('copy_follower_accounts', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'live_users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      strategy_provider_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'strategy_provider_accounts',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      account_name: {
        type: Sequelize.STRING(150),
        allowNull: false
      },
      account_number: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: false
      },
      wallet_balance: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      leverage: {
        type: Sequelize.INTEGER,
        defaultValue: 100
      },
      margin: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      net_profit: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      equity: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      group: {
        type: Sequelize.STRING,
        allowNull: false
      },
      investment_amount: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false
      },
      initial_investment: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false
      },
      current_equity_ratio: {
        type: Sequelize.DECIMAL(18, 8),
        defaultValue: 1.0000
      },
      copy_sl_mode: {
        type: Sequelize.ENUM('percentage', 'amount', 'none'),
        defaultValue: 'none'
      },
      copy_tp_mode: {
        type: Sequelize.ENUM('percentage', 'amount', 'none'),
        defaultValue: 'none'
      },
      sl_percentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true
      },
      tp_percentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true
      },
      sl_amount: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: true
      },
      tp_amount: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: true
      },
      max_lot_size: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      max_daily_loss: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: true
      },
      stop_copying_on_drawdown: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true
      },
      status: {
        type: Sequelize.INTEGER,
        defaultValue: 1
      },
      is_active: {
        type: Sequelize.INTEGER,
        defaultValue: 1
      },
      sending_orders: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'barclays'
      },
      copy_status: {
        type: Sequelize.ENUM('active', 'paused', 'stopped'),
        defaultValue: 'active'
      },
      auto_cutoff_inherited: {
        type: Sequelize.BOOLEAN,
        defaultValue: true
      },
      auto_cutoff_level: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true
      },
      total_profit_loss: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      total_fees_paid: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      total_copied_orders: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      successful_copies: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      failed_copies: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      subscription_date: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW
      },
      last_copy_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      pause_reason: {
        type: Sequelize.STRING,
        allowNull: true
      },
      stop_reason: {
        type: Sequelize.STRING,
        allowNull: true
      },
      view_password: {
        type: Sequelize.STRING,
        allowNull: true
      },
      book: {
        type: Sequelize.STRING(5),
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Create strategy_provider_orders table
    await queryInterface.createTable('strategy_provider_orders', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      order_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true
      },
      order_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'strategy_provider_accounts',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      order_company_name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      order_type: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      order_status: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      order_price: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      order_quantity: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      contract_value: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      margin: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      stop_loss: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      take_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      close_price: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      net_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      swap: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      commission: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      cancel_message: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      close_message: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      close_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      modify_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      stoploss_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      takeprofit_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      stoploss_cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      takeprofit_cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      status: {
        type: Sequelize.STRING(30),
        allowNull: true
      },
      placed_by: {
        type: Sequelize.STRING(30),
        allowNull: true,
        defaultValue: 'strategy_provider'
      },
      is_master_order: {
        type: Sequelize.BOOLEAN,
        defaultValue: true
      },
      total_followers_copied: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      copy_distribution_status: {
        type: Sequelize.ENUM('pending', 'distributing', 'completed', 'failed'),
        defaultValue: 'pending'
      },
      copy_distribution_started_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      copy_distribution_completed_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      failed_copies_count: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      successful_copies_count: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Create copy_follower_orders table
    await queryInterface.createTable('copy_follower_orders', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      order_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true
      },
      order_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'copy_follower_accounts',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      order_company_name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      order_type: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      order_status: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      order_price: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      order_quantity: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      contract_value: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      margin: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      stop_loss: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      take_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      close_price: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      net_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      swap: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      commission: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      cancel_message: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      close_message: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      close_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      modify_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      stoploss_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      takeprofit_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      stoploss_cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      takeprofit_cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      status: {
        type: Sequelize.STRING(30),
        allowNull: true
      },
      placed_by: {
        type: Sequelize.STRING(30),
        allowNull: true,
        defaultValue: 'copy_trading'
      },
      master_order_id: {
        type: Sequelize.STRING(64),
        allowNull: false
      },
      strategy_provider_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'strategy_provider_accounts',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      copy_follower_account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'copy_follower_accounts',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      master_lot_size: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      follower_investment_at_copy: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false
      },
      master_equity_at_copy: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false
      },
      lot_ratio: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      calculated_lot_size: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      final_lot_size: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      copy_status: {
        type: Sequelize.ENUM('pending', 'copied', 'failed', 'cancelled', 'rejected'),
        defaultValue: 'pending'
      },
      copy_timestamp: {
        type: Sequelize.DATE,
        allowNull: true
      },
      copy_delay_ms: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      failure_reason: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      original_stop_loss: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      original_take_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      modified_by_follower: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      sl_modification_type: {
        type: Sequelize.ENUM('percentage', 'amount', 'none'),
        allowNull: true
      },
      tp_modification_type: {
        type: Sequelize.ENUM('percentage', 'amount', 'none'),
        allowNull: true
      },
      performance_fee_percentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true
      },
      gross_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      performance_fee_amount: {
        type: Sequelize.DECIMAL(18, 6),
        defaultValue: 0
      },
      net_profit_after_fees: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      fee_status: {
        type: Sequelize.ENUM('pending', 'calculated', 'paid'),
        defaultValue: 'pending'
      },
      fee_calculation_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      fee_payment_date: {
        type: Sequelize.DATE,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Add indexes for performance optimization
    await queryInterface.addIndex('strategy_provider_accounts', ['user_id']);
    await queryInterface.addIndex('strategy_provider_accounts', ['strategy_name']);
    await queryInterface.addIndex('strategy_provider_accounts', ['account_number']);
    await queryInterface.addIndex('strategy_provider_accounts', ['status']);
    await queryInterface.addIndex('strategy_provider_accounts', ['is_active']);
    await queryInterface.addIndex('strategy_provider_accounts', ['visibility']);
    await queryInterface.addIndex('strategy_provider_accounts', ['is_catalog_eligible']);
    await queryInterface.addIndex('strategy_provider_accounts', ['is_trustworthy']);
    await queryInterface.addIndex('strategy_provider_accounts', ['total_followers']);
    await queryInterface.addIndex('strategy_provider_accounts', ['performance_fee']);
    await queryInterface.addIndex('strategy_provider_accounts', ['min_investment']);
    await queryInterface.addIndex('strategy_provider_accounts', ['created_at']);
    await queryInterface.addIndex('strategy_provider_accounts', ['is_catalog_eligible', 'status', 'is_active']);
    await queryInterface.addIndex('strategy_provider_accounts', ['visibility', 'is_catalog_eligible', 'total_followers']);
    await queryInterface.addIndex('strategy_provider_accounts', ['performance_fee', 'total_return_percentage']);

    await queryInterface.addIndex('copy_follower_accounts', ['user_id']);
    await queryInterface.addIndex('copy_follower_accounts', ['strategy_provider_id']);
    await queryInterface.addIndex('copy_follower_accounts', ['account_number']);
    await queryInterface.addIndex('copy_follower_accounts', ['status']);
    await queryInterface.addIndex('copy_follower_accounts', ['is_active']);
    await queryInterface.addIndex('copy_follower_accounts', ['copy_status']);
    await queryInterface.addIndex('copy_follower_accounts', ['subscription_date']);
    await queryInterface.addIndex('copy_follower_accounts', ['investment_amount']);
    await queryInterface.addIndex('copy_follower_accounts', ['strategy_provider_id', 'copy_status', 'is_active']);
    await queryInterface.addIndex('copy_follower_accounts', ['user_id', 'copy_status']);
    await queryInterface.addIndex('copy_follower_accounts', ['copy_status', 'subscription_date']);

    await queryInterface.addIndex('strategy_provider_orders', ['order_id']);
    await queryInterface.addIndex('strategy_provider_orders', ['order_user_id']);
    await queryInterface.addIndex('strategy_provider_orders', ['order_status']);
    await queryInterface.addIndex('strategy_provider_orders', ['order_type']);
    await queryInterface.addIndex('strategy_provider_orders', ['order_company_name']);
    await queryInterface.addIndex('strategy_provider_orders', ['created_at']);
    await queryInterface.addIndex('strategy_provider_orders', ['is_master_order']);
    await queryInterface.addIndex('strategy_provider_orders', ['copy_distribution_status']);
    await queryInterface.addIndex('strategy_provider_orders', ['order_user_id', 'order_status', 'is_master_order']);
    await queryInterface.addIndex('strategy_provider_orders', ['copy_distribution_status', 'created_at']);
    await queryInterface.addIndex('strategy_provider_orders', ['order_status', 'order_company_name', 'created_at']);

    await queryInterface.addIndex('copy_follower_orders', ['order_id']);
    await queryInterface.addIndex('copy_follower_orders', ['order_user_id']);
    await queryInterface.addIndex('copy_follower_orders', ['master_order_id']);
    await queryInterface.addIndex('copy_follower_orders', ['strategy_provider_id']);
    await queryInterface.addIndex('copy_follower_orders', ['copy_follower_account_id']);
    await queryInterface.addIndex('copy_follower_orders', ['order_status']);
    await queryInterface.addIndex('copy_follower_orders', ['order_type']);
    await queryInterface.addIndex('copy_follower_orders', ['order_company_name']);
    await queryInterface.addIndex('copy_follower_orders', ['copy_status']);
    await queryInterface.addIndex('copy_follower_orders', ['created_at']);
    await queryInterface.addIndex('copy_follower_orders', ['copy_timestamp']);
    await queryInterface.addIndex('copy_follower_orders', ['fee_status']);
    await queryInterface.addIndex('copy_follower_orders', ['master_order_id', 'copy_status']);
    await queryInterface.addIndex('copy_follower_orders', ['strategy_provider_id', 'order_status', 'created_at']);
    await queryInterface.addIndex('copy_follower_orders', ['copy_follower_account_id', 'order_status']);
    await queryInterface.addIndex('copy_follower_orders', ['copy_status', 'copy_timestamp']);
    await queryInterface.addIndex('copy_follower_orders', ['fee_status', 'order_status']);
    await queryInterface.addIndex('copy_follower_orders', ['placed_by', 'copy_status']);
  },

  down: async (queryInterface, Sequelize) => {
    // Drop tables in reverse order due to foreign key constraints
    await queryInterface.dropTable('copy_follower_orders');
    await queryInterface.dropTable('strategy_provider_orders');
    await queryInterface.dropTable('copy_follower_accounts');
    await queryInterface.dropTable('strategy_provider_accounts');
  }
};
