# Database Pool Optimization - Phase 1

## Changes Made

### 1. Database Connection Pool Configuration
**File:** `services/nodejs-service/src/config/db.js`

**Before:**
```javascript
pool: {
  max: 50,
  min: 0,        // ❌ Cold connections cause handshake latency
  acquire: 30000,
  idle: 10000
}
```

**After:**
```javascript
pool: {
  max: 100,        // Increased from 50 to handle 1000 users with concurrent orders
  min: 15,         // Increased from 0 to keep warm connections (eliminates handshake latency)
  acquire: 60000,  // Increased from 30s to 60s for high-load scenarios
  idle: 30000,     // Increased from 10s to 30s to keep connections alive longer
  evict: 60000     // Added: Check for idle connections every 60s
}
```

### 2. Enhanced DB Insert Timing
**File:** `services/nodejs-service/src/controllers/orders.controller.js`

**Added granular timing around DB operations:**
- `mark('before_db_preinsert')` - Before DB create operation
- `mark('after_db_preinsert')` - After DB create operation
- Updated `db_preinsert_ms` calculation to measure pure DB operation time

## Expected Performance Impact

### Database Connection Pool Benefits:
1. **Eliminates Cold Connection Handshake:** 
   - Before: ~50-100ms handshake time when pool is empty
   - After: ~5-15ms using warm connections

2. **Higher Concurrent Capacity:**
   - Before: Max 50 connections for all operations
   - After: Max 100 connections with 15 always warm

3. **Better Connection Reuse:**
   - Before: Connections closed after 10s idle
   - After: Connections kept alive for 30s, checked every 60s

### Expected Timing Improvements:
- **db_preinsert_ms:** 70-120ms → 10-25ms (60-80% reduction)
- **Total latency reduction:** ~50-95ms per order

## Configuration Rationale for 1000 Users

### Connection Pool Sizing:
- **max: 100** - Handles peak concurrent orders (10% of users placing orders simultaneously)
- **min: 15** - Keeps warm connections for instant availability
- **acquire: 60000** - Allows time for connection acquisition during high load
- **idle: 30000** - Balances connection reuse vs resource consumption
- **evict: 60000** - Regular cleanup without being too aggressive

### Load Assumptions:
- 1000 active users
- Peak: 10% concurrent order placement (100 simultaneous orders)
- Average: 2-5% concurrent activity (20-50 operations)
- Each order requires 1-2 DB operations (pre-insert + post-update)

## Monitoring

### Before/After Comparison:
Monitor these metrics in the timing logs:
```json
{
  "db_preinsert_ms": "Should reduce from ~77ms to ~15ms",
  "total_ms": "Should reduce by 50-95ms overall"
}
```

### Database Connection Health:
- Monitor connection pool utilization
- Watch for connection acquisition timeouts
- Track connection creation/destruction rates

## Next Steps

After confirming DB insert latency reduction:
1. **Phase 2:** HTTP Keep-Alive for Python service calls
2. **Phase 3:** Python execution optimization (skip heavy margin recompute for provider flow)
3. **Phase 4:** Caching and additional optimizations

## Rollback Plan

If issues occur, revert `db.js` to previous settings:
```javascript
pool: {
  max: 50,
  min: 0,
  acquire: 30000,
  idle: 10000
}
```

## Testing Recommendations

1. **Load Test:** Simulate 100 concurrent order placements
2. **Monitor:** DB connection pool metrics and timing logs
3. **Verify:** `db_preinsert_ms` reduction in production logs
4. **Alert:** Set up alerts for connection pool exhaustion or timeouts
