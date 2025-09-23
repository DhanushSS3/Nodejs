# Order Lifecycle IDs Model Design

## 🚨 **PROBLEM IDENTIFIED**

The current system stores lifecycle IDs directly in the orders table, causing **ID loss** when operations are repeated:

### **Current Issues**
```javascript
// User places stoploss → stoploss_id = "SL123456789"
// User cancels stoploss → stoploss_cancel_id = "SLC987654321" 
// User places stoploss again → stoploss_id = "SL111222333" (OLD SL123456789 LOST!)
```

**Impact**: 
- ❌ Lost historical IDs break provider communication
- ❌ Cannot track complete order lifecycle
- ❌ Provider confirmations for old IDs fail
- ❌ Audit trail incomplete

## ✅ **PROPOSED SOLUTION**

### **New Table: `order_lifecycle_ids`**

```sql
CREATE TABLE order_lifecycle_ids (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id VARCHAR(64) NOT NULL,
    id_type ENUM(
        'order_id',
        'close_id', 
        'cancel_id',
        'modify_id',
        'stoploss_id',
        'takeprofit_id',
        'stoploss_cancel_id',
        'takeprofit_cancel_id'
    ) NOT NULL,
    lifecycle_id VARCHAR(64) NOT NULL UNIQUE,
    status ENUM('active', 'replaced', 'cancelled', 'executed') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    replaced_by VARCHAR(64) NULL, -- Points to the new lifecycle_id that replaced this one
    notes TEXT NULL,
    
    INDEX idx_order_id (order_id),
    INDEX idx_lifecycle_id (lifecycle_id),
    INDEX idx_id_type (id_type),
    INDEX idx_status (status),
    INDEX idx_order_type (order_id, id_type),
    INDEX idx_active_ids (order_id, id_type, status),
    
    FOREIGN KEY (order_id) REFERENCES live_user_orders(order_id) ON DELETE CASCADE
);
```

### **Sequelize Model: `OrderLifecycleId`**

```javascript
const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const OrderLifecycleId = sequelize.define('OrderLifecycleId', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  order_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
    references: {
      model: 'live_user_orders',
      key: 'order_id'
    }
  },
  id_type: {
    type: DataTypes.ENUM(
      'order_id',
      'close_id',
      'cancel_id', 
      'modify_id',
      'stoploss_id',
      'takeprofit_id',
      'stoploss_cancel_id',
      'takeprofit_cancel_id'
    ),
    allowNull: false
  },
  lifecycle_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true
  },
  status: {
    type: DataTypes.ENUM('active', 'replaced', 'cancelled', 'executed'),
    defaultValue: 'active'
  },
  replaced_by: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'order_lifecycle_ids',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['order_id'] },
    { fields: ['lifecycle_id'] },
    { fields: ['id_type'] },
    { fields: ['status'] },
    { fields: ['order_id', 'id_type'] },
    { fields: ['order_id', 'id_type', 'status'] }
  ]
});

module.exports = OrderLifecycleId;
```

## 🔧 **SERVICE LAYER: `OrderLifecycleService`**

```javascript
const OrderLifecycleId = require('../models/orderLifecycleId.model');
const { redisCluster } = require('../../config/redis');

class OrderLifecycleService {
  /**
   * Add a new lifecycle ID for an order
   */
  async addLifecycleId(order_id, id_type, lifecycle_id, notes = null) {
    try {
      // Mark any existing active ID of this type as replaced
      const existingActive = await OrderLifecycleId.findOne({
        where: { order_id, id_type, status: 'active' }
      });
      
      if (existingActive) {
        await existingActive.update({ 
          status: 'replaced', 
          replaced_by: lifecycle_id 
        });
      }
      
      // Create new active ID
      const newId = await OrderLifecycleId.create({
        order_id,
        id_type,
        lifecycle_id,
        status: 'active',
        notes
      });
      
      // Update Redis global lookup
      await redisCluster.set(`global_order_lookup:${lifecycle_id}`, order_id);
      
      return newId;
    } catch (error) {
      console.error('Failed to add lifecycle ID:', error);
      throw error;
    }
  }
  
  /**
   * Get active lifecycle ID for order and type
   */
  async getActiveLifecycleId(order_id, id_type) {
    const record = await OrderLifecycleId.findOne({
      where: { order_id, id_type, status: 'active' }
    });
    return record?.lifecycle_id || null;
  }
  
  /**
   * Get all lifecycle IDs for an order (with history)
   */
  async getAllLifecycleIds(order_id) {
    return await OrderLifecycleId.findAll({
      where: { order_id },
      order: [['created_at', 'ASC']]
    });
  }
  
  /**
   * Find order_id by any lifecycle_id
   */
  async findOrderByLifecycleId(lifecycle_id) {
    const record = await OrderLifecycleId.findOne({
      where: { lifecycle_id }
    });
    return record?.order_id || null;
  }
  
  /**
   * Mark lifecycle ID as executed/cancelled
   */
  async updateLifecycleStatus(lifecycle_id, status, notes = null) {
    const record = await OrderLifecycleId.findOne({
      where: { lifecycle_id }
    });
    
    if (record) {
      await record.update({ status, notes });
    }
    
    return record;
  }
  
  /**
   * Get complete lifecycle history for an order
   */
  async getLifecycleHistory(order_id) {
    const records = await OrderLifecycleId.findAll({
      where: { order_id },
      order: [['created_at', 'ASC']]
    });
    
    // Group by id_type for easier analysis
    const grouped = {};
    records.forEach(record => {
      if (!grouped[record.id_type]) {
        grouped[record.id_type] = [];
      }
      grouped[record.id_type].push(record);
    });
    
    return { records, grouped };
  }
}

module.exports = new OrderLifecycleService();
```

## 📊 **USAGE EXAMPLES**

### **1. Adding Stoploss (First Time)**
```javascript
// User adds stoploss
const stoploss_id = await idGenerator.generateStopLossId();
await orderLifecycleService.addLifecycleId(
  order_id, 
  'stoploss_id', 
  stoploss_id, 
  'Initial stoploss placement'
);

// Result in database:
// order_id: "123456789", id_type: "stoploss_id", lifecycle_id: "SL111", status: "active"
```

### **2. Cancelling Stoploss**
```javascript
// User cancels stoploss
const stoploss_cancel_id = await idGenerator.generateStopLossCancelId();
await orderLifecycleService.addLifecycleId(
  order_id, 
  'stoploss_cancel_id', 
  stoploss_cancel_id, 
  'Stoploss cancellation'
);

// Mark original stoploss as cancelled
await orderLifecycleService.updateLifecycleStatus(
  original_stoploss_id, 
  'cancelled', 
  'Cancelled by user'
);
```

### **3. Adding Stoploss Again (Replacement)**
```javascript
// User adds stoploss again
const new_stoploss_id = await idGenerator.generateStopLossId();
await orderLifecycleService.addLifecycleId(
  order_id, 
  'stoploss_id', 
  new_stoploss_id, 
  'Stoploss re-added after cancellation'
);

// Result: Previous stoploss_id marked as "replaced", new one is "active"
```

### **4. Provider Confirmation Handling**
```javascript
// Provider sends confirmation for any lifecycle_id
const provider_order_id = "SL111"; // Could be old or new ID
const order_id = await orderLifecycleService.findOrderByLifecycleId(provider_order_id);

if (order_id) {
  // Mark as executed
  await orderLifecycleService.updateLifecycleStatus(
    provider_order_id, 
    'executed', 
    'Executed by provider'
  );
  
  // Process the order...
}
```

## 🔄 **MIGRATION STRATEGY**

### **Step 1: Create New Table**
```sql
-- Run migration to create order_lifecycle_ids table
-- Migrate existing IDs from orders table to new table
```

### **Step 2: Populate Existing Data**
```javascript
// Migration script to populate existing lifecycle IDs
async function migrateExistingIds() {
  const orders = await LiveUserOrder.findAll();
  
  for (const order of orders) {
    const order_id = order.order_id;
    
    // Migrate existing IDs
    const idMappings = [
      { type: 'order_id', value: order.order_id },
      { type: 'close_id', value: order.close_id },
      { type: 'cancel_id', value: order.cancel_id },
      { type: 'modify_id', value: order.modify_id },
      { type: 'stoploss_id', value: order.stoploss_id },
      { type: 'takeprofit_id', value: order.takeprofit_id },
      { type: 'stoploss_cancel_id', value: order.stoploss_cancel_id },
      { type: 'takeprofit_cancel_id', value: order.takeprofit_cancel_id }
    ];
    
    for (const mapping of idMappings) {
      if (mapping.value) {
        await orderLifecycleService.addLifecycleId(
          order_id,
          mapping.type,
          mapping.value,
          'Migrated from existing orders table'
        );
      }
    }
  }
}
```

### **Step 3: Update Controllers**
```javascript
// In orders.controller.js - addStopLoss function
const stoploss_id = await idGenerator.generateStopLossId();

// OLD: Direct update to orders table
// await toUpdate.update({ stoploss_id, status });

// NEW: Use lifecycle service
await orderLifecycleService.addLifecycleId(
  order_id, 
  'stoploss_id', 
  stoploss_id, 
  'Stoploss added by user'
);

// Still update orders table for backward compatibility (optional)
await toUpdate.update({ stoploss_id, status });
```

## 📈 **BENEFITS**

### **Complete ID History**
```sql
-- View complete lifecycle for an order
SELECT * FROM order_lifecycle_ids 
WHERE order_id = '123456789' 
ORDER BY created_at;

-- Result shows full history:
-- SL111 (replaced) → SLC222 (executed) → SL333 (active)
```

### **Provider Confirmation Handling**
- ✅ **Any lifecycle_id** can be resolved to order_id
- ✅ **Historical IDs** don't break provider communication  
- ✅ **Status tracking** shows which IDs are active/replaced/executed
- ✅ **Audit trail** for compliance and debugging

### **Efficient Queries**
```sql
-- Get active stoploss for order
SELECT lifecycle_id FROM order_lifecycle_ids 
WHERE order_id = '123' AND id_type = 'stoploss_id' AND status = 'active';

-- Find order by any lifecycle ID
SELECT order_id FROM order_lifecycle_ids 
WHERE lifecycle_id = 'SL123456789';

-- Get replacement chain
SELECT lifecycle_id, status, replaced_by FROM order_lifecycle_ids 
WHERE order_id = '123' AND id_type = 'stoploss_id' 
ORDER BY created_at;
```

## 🚀 **DEPLOYMENT PLAN**

### **Phase 1: Create Infrastructure**
1. Create `order_lifecycle_ids` table
2. Create `OrderLifecycleId` model
3. Create `OrderLifecycleService`
4. Run migration to populate existing data

### **Phase 2: Update Controllers**
1. Update `addStopLoss` to use lifecycle service
2. Update `addTakeProfit` to use lifecycle service  
3. Update `closeOrder` to use lifecycle service
4. Update cancel endpoints to use lifecycle service

### **Phase 3: Update Workers**
1. Update dispatcher to use lifecycle service for lookups
2. Update worker_close.py to handle historical IDs
3. Update provider communication to track ID status

### **Phase 4: Cleanup (Optional)**
1. Remove lifecycle ID columns from orders table
2. Update all references to use lifecycle service
3. Add monitoring and alerting

## ✅ **RESULT**

**Complete lifecycle ID management with:**
- ✅ **Zero ID loss** - All IDs preserved with history
- ✅ **Provider compatibility** - Any historical ID resolves correctly
- ✅ **Status tracking** - Know which IDs are active/replaced/executed
- ✅ **Audit trail** - Complete history for compliance
- ✅ **Efficient queries** - Optimized indexes for fast lookups
- ✅ **Backward compatibility** - Existing code continues to work

**The order lifecycle ID management system is now bulletproof!** 🎯
