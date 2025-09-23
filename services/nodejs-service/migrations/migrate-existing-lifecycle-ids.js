/**
 * Migration Script: Populate order_lifecycle_ids with existing data
 * Purpose: Migrate all existing lifecycle IDs from live_user_orders and demo_user_orders
 * Run this AFTER creating the order_lifecycle_ids table
 */

const { Sequelize, DataTypes } = require('sequelize');
const sequelize = require('../src/config/db');
const LiveUserOrder = require('../src/models/liveUserOrder.model');
const DemoUserOrder = require('../src/models/demoUserOrder.model');
const orderLifecycleService = require('../src/services/orderLifecycle.service');

class LifecycleIdMigration {
  constructor() {
    this.stats = {
      totalOrders: 0,
      migratedIds: 0,
      skippedIds: 0,
      errors: 0,
      startTime: Date.now()
    };
  }

  /**
   * Migrate lifecycle IDs from a single order
   */
  async migrateOrderIds(order, orderType = 'live') {
    const order_id = order.order_id;
    const migratedIds = [];
    
    try {
      // Define ID mappings from order table columns to lifecycle types
      const idMappings = [
        { type: 'order_id', value: order.order_id, notes: `${orderType} order migrated from existing data` },
        { type: 'close_id', value: order.close_id, notes: 'Close ID migrated from existing data' },
        { type: 'cancel_id', value: order.cancel_id, notes: 'Cancel ID migrated from existing data' },
        { type: 'modify_id', value: order.modify_id, notes: 'Modify ID migrated from existing data' },
        { type: 'stoploss_id', value: order.stoploss_id, notes: 'Stoploss ID migrated from existing data' },
        { type: 'takeprofit_id', value: order.takeprofit_id, notes: 'Takeprofit ID migrated from existing data' },
        { type: 'stoploss_cancel_id', value: order.stoploss_cancel_id, notes: 'Stoploss cancel ID migrated from existing data' },
        { type: 'takeprofit_cancel_id', value: order.takeprofit_cancel_id, notes: 'Takeprofit cancel ID migrated from existing data' }
      ];
      
      // Migrate each non-null ID
      for (const mapping of idMappings) {
        if (mapping.value && mapping.value.trim()) {
          try {
            await orderLifecycleService.addLifecycleId(
              order_id,
              mapping.type,
              mapping.value.trim(),
              mapping.notes
            );
            migratedIds.push(mapping.type);
            this.stats.migratedIds++;
          } catch (error) {
            // Skip if ID already exists (duplicate)
            if (error.message && error.message.includes('Duplicate entry')) {
              console.log(`Skipping duplicate ID: ${mapping.value} for order ${order_id}`);
              this.stats.skippedIds++;
            } else {
              console.error(`Failed to migrate ${mapping.type} for order ${order_id}:`, error.message);
              this.stats.errors++;
            }
          }
        }
      }
      
      console.log(`Migrated order ${order_id} (${orderType}): ${migratedIds.join(', ')}`);
      return migratedIds;
      
    } catch (error) {
      console.error(`Failed to migrate order ${order_id}:`, error.message);
      this.stats.errors++;
      return [];
    }
  }

  /**
   * Migrate all orders from a specific table
   */
  async migrateOrderTable(OrderModel, orderType) {
    console.log(`\n🔄 Migrating ${orderType} orders...`);
    
    const orders = await OrderModel.findAll({
      order: [['created_at', 'ASC']]
    });
    
    console.log(`Found ${orders.length} ${orderType} orders to migrate`);
    
    let processed = 0;
    for (const order of orders) {
      await this.migrateOrderIds(order, orderType);
      processed++;
      
      // Progress indicator
      if (processed % 100 === 0) {
        console.log(`Progress: ${processed}/${orders.length} ${orderType} orders processed`);
      }
    }
    
    console.log(`✅ Completed ${orderType} orders: ${processed} processed`);
    this.stats.totalOrders += processed;
  }

  /**
   * Run the complete migration
   */
  async runMigration() {
    console.log('🚀 Starting Order Lifecycle IDs Migration...\n');
    
    try {
      // Test database connection
      await sequelize.authenticate();
      console.log('✅ Database connection established');
      
      // Check if order_lifecycle_ids table exists
      const [results] = await sequelize.query(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'order_lifecycle_ids'"
      );
      
      if (results[0].count === 0) {
        throw new Error('order_lifecycle_ids table does not exist. Please run the table creation migration first.');
      }
      
      console.log('✅ order_lifecycle_ids table found');
      
      // Migrate live orders
      await this.migrateOrderTable(LiveUserOrder, 'live');
      
      // Migrate demo orders  
      await this.migrateOrderTable(DemoUserOrder, 'demo');
      
      // Print final statistics
      this.printStats();
      
    } catch (error) {
      console.error('❌ Migration failed:', error.message);
      throw error;
    }
  }

  /**
   * Print migration statistics
   */
  printStats() {
    const duration = (Date.now() - this.stats.startTime) / 1000;
    
    console.log('\n📊 Migration Statistics:');
    console.log('========================');
    console.log(`Total Orders Processed: ${this.stats.totalOrders}`);
    console.log(`Lifecycle IDs Migrated: ${this.stats.migratedIds}`);
    console.log(`IDs Skipped (duplicates): ${this.stats.skippedIds}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log(`Duration: ${duration.toFixed(2)} seconds`);
    console.log(`Rate: ${(this.stats.migratedIds / duration).toFixed(2)} IDs/second`);
    
    if (this.stats.errors === 0) {
      console.log('\n✅ Migration completed successfully!');
    } else {
      console.log(`\n⚠️  Migration completed with ${this.stats.errors} errors`);
    }
  }

  /**
   * Verify migration results
   */
  async verifyMigration() {
    console.log('\n🔍 Verifying migration results...');
    
    try {
      // Count total lifecycle IDs
      const [totalCount] = await sequelize.query(
        'SELECT COUNT(*) as count FROM order_lifecycle_ids'
      );
      
      // Count by type
      const [typeCount] = await sequelize.query(`
        SELECT 
          id_type,
          COUNT(*) as count,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_count
        FROM order_lifecycle_ids 
        GROUP BY id_type 
        ORDER BY count DESC
      `);
      
      console.log(`Total lifecycle IDs: ${totalCount[0].count}`);
      console.log('\nBreakdown by type:');
      typeCount.forEach(row => {
        console.log(`  ${row.id_type}: ${row.count} total (${row.active_count} active)`);
      });
      
      // Sample some records
      const [samples] = await sequelize.query(`
        SELECT order_id, id_type, lifecycle_id, status, notes
        FROM order_lifecycle_ids 
        ORDER BY created_at DESC 
        LIMIT 5
      `);
      
      console.log('\nSample records:');
      samples.forEach(record => {
        console.log(`  ${record.order_id} | ${record.id_type} | ${record.lifecycle_id} | ${record.status}`);
      });
      
    } catch (error) {
      console.error('Verification failed:', error.message);
    }
  }
}

// Run migration if called directly
if (require.main === module) {
  const migration = new LifecycleIdMigration();
  
  migration.runMigration()
    .then(() => migration.verifyMigration())
    .then(() => {
      console.log('\n🎉 Migration and verification complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error);
      process.exit(1);
    });
}

module.exports = LifecycleIdMigration;
