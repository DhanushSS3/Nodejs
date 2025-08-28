# Groups Redis Caching System

## Overview

This document explains the comprehensive Redis Cluster caching solution implemented for the groups table, designed to handle ~3000 group records with high-performance access for trading operations.

## Architecture Decisions

### 1. Redis Data Structure: **Hash (HSET)**

**Why Hash over JSON/SET:**
- **Partial Updates**: Hash allows updating individual fields without fetching/parsing entire objects
- **Memory Efficient**: Redis Hashes are optimized for small objects with many fields
- **Atomic Operations**: Field-level atomic updates prevent race conditions
- **Query Flexibility**: Can fetch specific fields only (e.g., just spread + margin for calculations)

### 2. Redis Key Design: **Hash Tags for Cluster Optimization**

**Pattern**: `groups:{group_name}:{symbol}`

**Benefits:**
- **Co-location**: Hash tags `{group_name}` ensure all symbols for same group are in same Redis slot
- **Cluster Friendly**: Reduces cross-slot operations, improves performance
- **Logical Grouping**: Easy to scan all symbols for a specific group
- **Collision Avoidance**: Sanitizes special characters that could break Redis keys

### 3. Caching Strategy: **Write-Through with Pub/Sub**

**Flow:**
1. **Read**: Cache → Database fallback → Cache population
2. **Write**: Database → Cache → Pub/Sub notification
3. **Sync**: Manual admin sync from database to cache

## Implementation Components

### 1. Sequelize Model (`group.model.js`)
- Complete schema mapping with validations
- Composite unique index on (symbol, name)
- Performance indexes on frequently queried fields
- Custom validation for business rules (min_lot ≤ max_lot)

### 2. Cache Service (`groups.cache.service.js`)
- **Hash-based storage** with efficient field operations
- **Batch processing** for startup sync (100 records/batch)
- **Distributed locking** to prevent concurrent syncs
- **Fallback mechanisms** for cache misses
- **Pub/Sub notifications** for cross-service updates

### 3. Startup Service (`groups.startup.service.js`)
- **Automatic initialization** during app startup
- **Redis readiness checks** with retry logic
- **Pub/Sub subscriber** for cross-service notifications
- **Health monitoring** and graceful shutdown

### 4. Controllers & Routes
- **Public routes** for trading data access (authenticated)
- **Admin routes** for group management (superadmin only)
- **Cache management** endpoints for monitoring/maintenance

## Key Features

### Performance Optimizations
- **Pipeline Operations**: Batch Redis commands for better throughput
- **Field-Specific Queries**: Fetch only required fields for calculations
- **Connection Pooling**: Reuse Redis connections efficiently
- **Memory Management**: Process large datasets in batches

### High Availability
- **Redis Cluster Support**: Full cluster topology with NAT mapping
- **Fallback to Database**: Automatic fallback on cache failures
- **Distributed Locking**: Prevent sync conflicts across instances
- **Health Monitoring**: Continuous health checks and alerting

### Cross-Service Communication
- **Pub/Sub Notifications**: Real-time updates to all microservices
- **Event Types**: update, delete, sync actions
- **Source Tracking**: Prevent notification loops
- **Automatic Refresh**: Services auto-refresh on remote changes

## API Endpoints

### Public Access (Authenticated Users)
```
GET /api/groups/:groupName/:symbol              # Get complete group data
GET /api/groups/:groupName/:symbol/fields       # Get specific fields only
GET /api/groups/:groupName                      # Get all symbols for group
```

### Admin Access (Superadmin Only)
```
PUT /api/superadmin/groups/:groupName/:symbol   # Update group fields
POST /api/superadmin/groups/sync/:groupId       # Sync single group from DB
GET /api/superadmin/groups/cache/stats          # Get cache statistics
POST /api/superadmin/groups/cache/resync        # Force full resync
DELETE /api/superadmin/groups/cache             # Clear cache (dangerous)
```

## Usage Examples

### Trading Engine Integration
```javascript
// Get specific fields for spread calculation
const { spread, margin, swap_buy } = await groupsCacheService.getGroupFields(
  'VIP', 'EURUSD', ['spread', 'margin', 'swap_buy']
);

// Get complete group configuration
const group = await groupsCacheService.getGroup('VIP', 'EURUSD');
```

### Admin Operations
```javascript
// Update spread and margin
await groupsCacheService.updateGroup('VIP', 'EURUSD', {
  spread: 1.5,
  margin: 100.0
});

// Sync from database after manual DB changes
await groupsCacheService.syncGroupFromDB(groupId);
```

### Application Startup
```javascript
// Initialize in your main app.js
const startupManager = require('./src/utils/startup');

app.listen(port, async () => {
  try {
    await startupManager.initializeAll();
    console.log('Server ready with all services initialized');
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
});
```

## Best Practices

### 1. Data Consistency
- Always update database first, then cache
- Use transactions for critical updates
- Implement proper error handling and rollback
- Monitor sync lag between DB and cache

### 2. Performance
- Use field-specific queries for trading calculations
- Batch operations when possible
- Monitor Redis memory usage
- Implement proper connection pooling

### 3. Monitoring
- Track cache hit/miss ratios
- Monitor pub/sub message delivery
- Set up alerts for sync failures
- Regular health checks

### 4. Maintenance
- Schedule periodic full resyncs
- Monitor Redis cluster health
- Clean up orphaned keys
- Backup critical cache data

## Troubleshooting

### Cache Miss Issues
1. Check Redis connectivity
2. Verify key naming patterns
3. Check database connectivity for fallback
4. Review sync logs for errors

### Performance Issues
1. Monitor Redis memory usage
2. Check for cross-slot operations
3. Verify pipeline usage
4. Review query patterns

### Sync Problems
1. Check distributed lock status
2. Verify database connectivity
3. Review batch processing logs
4. Check Redis cluster health

## Monitoring Queries

```bash
# Check cache statistics
curl -X GET /api/superadmin/groups/cache/stats

# Monitor Redis keys
redis-cli --cluster call 127.0.0.1:7001 keys "groups:*" | wc -l

# Check pub/sub activity
redis-cli --cluster call 127.0.0.1:7001 pubsub channels
```

This implementation provides a robust, scalable, and high-performance caching solution that can handle the demanding requirements of a trading platform while maintaining data consistency and cross-service communication.
