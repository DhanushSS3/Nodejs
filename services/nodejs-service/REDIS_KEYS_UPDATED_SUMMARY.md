# Redis Keys Updated - Complete Reference

## 🔑 **REDIS KEYS UPDATED AFTER ADMIN OPERATIONS**

### **1. Admin Transactions (Deposits/Withdrawals)**

#### **Primary User Config (Critical for Python Services)**
```redis
Key: user:{userType:userId}:config
Type: Hash
Fields Updated:
├── wallet_balance: "10000.50"
├── margin: "2500.00" 
├── net_profit: "1250.75"
├── last_balance_update: "2024-01-15T10:30:00.000Z"
└── last_admin_update: "2024-01-15T10:30:00.000Z"

Example: user:{live:123}:config
```

#### **Balance Cache (Fast Access)**
```redis
Key: user_balance:{userType}:{userId}
Type: String
TTL: 3600 seconds (1 hour)
Value: "10000.50"

Example: user_balance:live:123
```

#### **Portfolio Cache (If Exists)**
```redis
Key: user:{userType:userId}:portfolio
Type: Hash
Fields Updated:
├── wallet_balance: "10000.50"
└── balance_updated_at: "2024-01-15T10:30:00.000Z"

Example: user:{live:123}:portfolio
```

#### **User Cache Service (Comprehensive)**
```redis
Updated via: redisUserCacheService.updateUser()
Includes all user fields with proper formatting
```

#### **Event Publishing**
```redis
Channels:
├── user_updates: General user update notifications
└── balance_updates: Balance-specific notifications for Python services
```

#### **Derived Caches (Cleared for Fresh Calculations)**
```redis
Keys Cleared:
├── user_margin_calc:{userType}:{userId}
├── user_stats:{userType}:{userId}
├── user_summary:{userType}:{userId}
└── financial_summary:{userType}:{userId}:*
```

---

### **2. Admin User Updates (Profile Changes)**

#### **Primary User Config (Enhanced)**
```redis
Key: user:{userType:userId}:config
Type: Hash
Fields Updated (Based on Admin Changes):

Financial Fields:
├── wallet_balance: "10000.50"
├── margin: "2500.00"
├── net_profit: "1250.75"

Trading Configuration (CRITICAL):
├── group: "VIP"
├── leverage: "100"
├── last_group_update: "2024-01-15T10:30:00.000Z" (if group changed)

User Status:
├── status: "1"
├── is_active: "1"

Account Information:
├── account_number: "ACC123456"
├── country_id: "1"

Live User Specific:
├── mam_id: "MAM001"
├── mam_status: "1"
├── pam_id: "PAM001"
├── pam_status: "1"
├── copy_trading_wallet: "5000.00"
├── copytrader_id: "CT001"
├── copytrading_status: "1"

Timestamps:
└── last_admin_update: "2024-01-15T10:30:00.000Z"
```

#### **Portfolio Cache (Group Updates)**
```redis
Key: user:{userType:userId}:portfolio
Type: Hash
Fields Updated (If Group Changed):
├── group: "VIP"
└── group_updated_at: "2024-01-15T10:30:00.000Z"
```

#### **Group-Dependent Caches (Cleared When Group Changes)**
```redis
Keys Cleared (Forward-Looking Only):
├── user_margin_calc:{userType}:{userId}
├── user_group_config:{userType}:{userId}
├── margin_requirements:{userType}:{userId}
└── spread_config:{userType}:{userId}
```

#### **Future-Calculation Caches (Cleared Based on Field Changes)**
```redis
Cleared When Trading Fields Change (group, leverage, status, is_active):
├── user_margin_calc:{userType}:{userId}

Cleared When Any User Data Changes:
├── user_stats:{userType}:{userId}
└── user_summary:{userType}:{userId}

Cleared When Financial Fields Change (wallet_balance, margin, net_profit):
└── financial_summary:{userType}:{userId}:*
```

#### **Enhanced Event Publishing**
```redis
Channels:
├── user_updates: General user update notifications
├── admin_user_updates: Admin-specific update notifications
└── group_updates: Group change notifications (when group changes)

Event Data Includes:
├── user_id: 123
├── user_type: "live"
├── updated_fields: {...}
├── group_changed: true/false
├── event_type: "admin_user_update"
├── timestamp: "2024-01-15T10:30:00.000Z"
└── source: "admin_operation"
```

---

### **3. Money Request Approvals**

#### **Automatic via Wallet Service**
```
Money Request Approval → Wallet Service → Redis Sync Service
```
Uses the same Redis key updates as **Admin Transactions** above.

---

## 🎯 **CRITICAL REDIS KEYS FOR PYTHON SERVICES**

### **Most Important Keys (Python Dependencies)**
```redis
1. user:{userType:userId}:config
   ├── Primary source for user configuration
   ├── Used by order placement, margin calculations
   └── MUST be updated for all admin operations

2. user_balance:{userType}:{userId}
   ├── Fast balance lookups
   ├── Used by trading operations
   └── TTL: 1 hour

3. user:{userType:userId}:portfolio
   ├── Portfolio calculations
   ├── Position management
   └── Updated when balance/group changes
```

---

## 🔄 **REDIS UPDATE WORKFLOW**

### **Admin Transaction Flow**
```
1. Database Transaction (Atomic)
   ├── Update user table
   └── Create transaction record

2. Redis Sync Service
   ├── Update user config cache
   ├── Update balance caches
   ├── Update user cache service
   ├── Publish events
   └── Clear derived caches
```

### **Admin User Update Flow**
```
1. Database Update
   ├── Update user fields
   └── Store old values for comparison

2. Redis Sync Service
   ├── Update user config with new fields
   ├── Handle group changes specially
   ├── Clear future-calculation caches
   ├── Update portfolio cache
   └── Publish comprehensive events
```

### **Group Change Special Handling**
```
When Group Changes:
1. Update user:{userType:userId}:config with new group
2. Clear group-dependent caches (future calculations only)
3. Update portfolio cache with new group
4. Publish group_updates event
5. Keep historical data intact (orders, transactions)
```

---

## ✅ **WHAT'S PRESERVED (Historical Data)**

### **Never Touched by Admin Updates**
```redis
✅ Existing order data in database
✅ Historical transaction records
✅ Existing portfolio positions
✅ Past profit/loss calculations
✅ Historical margin data
```

### **Only Future Operations Affected**
```redis
🎯 Next order placements use new group
🎯 Future margin calculations use new leverage
🎯 New trading operations use updated status
🎯 Fresh portfolio calculations use new config
```

---

## 🛡️ **ERROR HANDLING & CONSISTENCY**

### **Database-First Principle**
```
1. Database transaction commits first (authoritative)
2. Redis sync happens after database commit
3. Redis failures NEVER affect main operation
4. Python services fall back to database if Redis stale
```

### **Graceful Degradation**
```javascript
try {
  await redisSyncService.syncUserAfterAdminUpdate(/* ... */);
} catch (redisSyncError) {
  logger.error('Redis sync failed - database is consistent');
  // Continue - database is authoritative
}
```

---

## 📊 **MONITORING & VERIFICATION**

### **Health Check Endpoints**
```
GET /api/redis-health/status
GET /api/redis-health/user/:userId/consistency
POST /api/redis-health/user/:userId/force-refresh
GET /api/redis-health/cluster-info
```

### **Manual Verification Commands**
```bash
# Check user config
redis-cli HGETALL "user:{live:123}:config"

# Check balance cache
redis-cli GET "user_balance:live:123"

# Check portfolio cache
redis-cli HGETALL "user:{live:123}:portfolio"

# Monitor events
redis-cli SUBSCRIBE user_updates admin_user_updates group_updates
```

### **Test Script**
```bash
node test_redis_consistency.js <ADMIN_TOKEN>
```

---

## 🎯 **SUMMARY**

### **Redis Keys Updated After Admin Operations:**

#### **Admin Transactions (Deposits/Withdrawals):**
- ✅ `user:{userType:userId}:config` (balance, margin, net_profit)
- ✅ `user_balance:{userType}:{userId}` (TTL cache)
- ✅ `user:{userType:userId}:portfolio` (balance updates)
- ✅ User cache service (comprehensive)
- ✅ Event publishing (user_updates, balance_updates)
- ✅ Derived caches cleared

#### **Admin User Updates (Profile Changes):**
- ✅ `user:{userType:userId}:config` (all updated fields)
- ✅ `user:{userType:userId}:portfolio` (group changes)
- ✅ Group-dependent caches cleared (when group changes)
- ✅ Future-calculation caches cleared
- ✅ Enhanced event publishing (admin_user_updates, group_updates)
- ✅ User cache service updated

#### **Money Request Approvals:**
- ✅ Same as Admin Transactions (via wallet service)

### **Result:**
**Perfect Redis/Database consistency** for all admin operations while preserving historical data and ensuring future operations use updated configuration! 🎉
