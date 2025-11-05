# Copy Follower WebSocket Architecture Plan

## 🎯 Objective
Enable copy followers to receive real-time updates for their copy follower account orders using their main account JWT, without requiring separate authentication.

## 📋 Current Architecture Analysis

### Current WebSocket Flow:
1. Client connects with JWT token: `/ws/portfolio?token=<jwt>`
2. Server extracts `userId` and `userType` from JWT
3. Fetches orders for single account: `fetchOrdersFromDB(userType, userId)`
4. Sends updates for single account only

### Current Limitations:
- Copy followers have multiple `CopyFollowerAccount` records
- WebSocket only handles single account per connection
- No mechanism to specify which copy follower account to monitor

## 🚀 Solution Architecture

### Phase 1: Connection Parameter Extension

#### 1.1 WebSocket Connection Enhancement
**New Connection Format:**
```
/ws/portfolio?token=<jwt>&copy_follower_account_id=<account_id>
```

**Benefits:**
- ✅ Backward compatible (existing connections work)
- ✅ Explicit account selection
- ✅ Uses existing JWT authentication
- ✅ Simple client implementation

#### 1.2 WebSocket Handler Modifications

**File: `services/nodejs-service/src/services/ws/portfolio.ws.js`**

```javascript
// Enhanced connection handling
wss.on('connection', async (ws, req) => {
  const params = url.parse(req.url, true);
  const token = params.query.token;
  const copyFollowerAccountId = params.query.copy_follower_account_id;

  // JWT verification (existing)
  let user = jwt.verify(token, JWT_SECRET);
  
  // Determine connection type
  let userId, userType, accountId;
  
  if (copyFollowerAccountId) {
    // Copy follower account connection
    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: parseInt(copyFollowerAccountId),
        user_id: user.sub || user.user_id,
        status: 1,
        is_active: 1
      }
    });
    
    if (!followerAccount) {
      ws.close(4403, 'Copy follower account not found or access denied');
      return;
    }
    
    userId = user.sub || user.user_id; // Main user ID for auth
    userType = 'copy_follower';
    accountId = followerAccount.id; // Specific copy follower account
    
  } else {
    // Existing logic for other account types
    // ... (strategy_provider, live, demo)
  }
  
  // Create composite user key for copy followers
  const userKey = copyFollowerAccountId 
    ? `copy_follower_account:${copyFollowerAccountId}:user:${userId}`
    : getUserKey(userType, userId);
});
```

### Phase 2: Order Fetching Enhancement

#### 2.1 Enhanced Order Fetching Function

**File: `services/nodejs-service/src/services/ws/portfolio.ws.js`**

```javascript
async function fetchOrdersFromDB(userType, userId, accountId = null) {
  let OrderModel, rows;
  
  if (userType === 'copy_follower' && accountId) {
    // Fetch orders for specific copy follower account
    OrderModel = CopyFollowerOrder;
    rows = await OrderModel.findAll({ 
      where: { copy_follower_account_id: parseInt(accountId, 10) } 
    });
  } else if (userType === 'copy_follower') {
    // Fetch orders for all copy follower accounts of this user
    const followerAccounts = await CopyFollowerAccount.findAll({
      where: { user_id: parseInt(userId, 10), status: 1, is_active: 1 }
    });
    
    if (followerAccounts.length === 0) return { open: [], pending: [], rejected: [] };
    
    const accountIds = followerAccounts.map(acc => acc.id);
    OrderModel = CopyFollowerOrder;
    rows = await OrderModel.findAll({ 
      where: { copy_follower_account_id: { [Op.in]: accountIds } } 
    });
  } else {
    // Existing logic for other user types
    // ... (strategy_provider, live, demo)
  }
  
  // Process orders (existing logic)
  // ...
}
```

#### 2.2 Redis Order Fetching Enhancement

**File: `services/nodejs-service/src/services/ws/portfolio.ws.js`**

```javascript
async function fetchOpenOrdersFromRedis(userType, userId, accountId = null) {
  if (userType === 'copy_follower' && accountId) {
    // Fetch Redis orders for specific copy follower account
    const tag = `copy_follower:${accountId}`;
    const orderIds = await redisCluster.smembers(`user_orders_index:{${tag}}`);
    
    const orders = [];
    for (const orderId of orderIds) {
      const orderData = await redisCluster.hgetall(`user_holdings:{${tag}}:${orderId}`);
      if (orderData && Object.keys(orderData).length > 0) {
        orders.push(parseRedisOrder(orderData));
      }
    }
    return orders;
  } else if (userType === 'copy_follower') {
    // Fetch orders for all copy follower accounts
    const followerAccounts = await CopyFollowerAccount.findAll({
      where: { user_id: parseInt(userId, 10), status: 1, is_active: 1 }
    });
    
    const allOrders = [];
    for (const account of followerAccounts) {
      const tag = `copy_follower:${account.id}`;
      const orderIds = await redisCluster.smembers(`user_orders_index:{${tag}}`);
      
      for (const orderId of orderIds) {
        const orderData = await redisCluster.hgetall(`user_holdings:{${tag}}:${orderId}`);
        if (orderData && Object.keys(orderData).length > 0) {
          const order = parseRedisOrder(orderData);
          order.copy_follower_account_id = account.id;
          order.copy_follower_account_name = account.account_name;
          allOrders.push(order);
        }
      }
    }
    return allOrders;
  }
  
  // Existing logic for other user types
  // ...
}
```

### Phase 3: Event System Enhancement

#### 3.1 Portfolio Events Enhancement

**File: `services/nodejs-service/src/services/events/portfolio.events.js`**

```javascript
class PortfolioEventBus extends EventEmitter {
  // Enhanced user key generation for copy followers
  makeUserKey(userType, userId, accountId = null) {
    const normalizedUserType = String(userType).toLowerCase();
    
    if (normalizedUserType === 'copy_follower' && accountId) {
      return `copy_follower_account:${accountId}:user:${userId}`;
    }
    
    return `${normalizedUserType}:${String(userId)}`;
  }

  // Enhanced emit for copy follower accounts
  emitCopyFollowerUpdate(copyFollowerAccountId, userId, payload = {}) {
    const key = this.makeUserKey('copy_follower', userId, copyFollowerAccountId);
    const evt = { 
      userType: 'copy_follower', 
      userId, 
      copyFollowerAccountId,
      ...payload 
    };
    
    // Emit locally
    this.emit(`user:${key}`, evt);
    
    // Publish cross-process via Redis
    try {
      const msg = JSON.stringify({ 
        _src: INSTANCE_ID, 
        type: 'copy_follower_update', 
        ...evt 
      });
      redisCluster.publish('portfolio_events', msg).catch(() => {});
    } catch (e) {
      logger?.warn?.('PortfolioEventBus copy follower publish failed', { error: e.message });
    }
  }
}
```

#### 3.2 Controller Event Emission Updates

**File: `services/nodejs-service/src/controllers/copyTrading.orders.controller.js`**

```javascript
// In copy follower order operations, emit to specific account
try {
  portfolioEvents.emitCopyFollowerUpdate(
    copyFollowerAccountId, 
    mainUserId, 
    {
      type: 'order_update',
      order_id,
      update: { order_status: 'OPEN' }
    }
  );
} catch (e) {
  logger.warn('Failed to emit copy follower portfolio event', { 
    error: e.message, 
    order_id,
    copyFollowerAccountId 
  });
}
```

### Phase 4: Client-Side Implementation

#### 4.1 Frontend WebSocket Connection

```javascript
class CopyFollowerWebSocket {
  constructor(jwt, copyFollowerAccountId = null) {
    this.jwt = jwt;
    this.copyFollowerAccountId = copyFollowerAccountId;
    this.ws = null;
  }
  
  connect() {
    const baseUrl = 'ws://localhost:3000/ws/portfolio';
    const params = new URLSearchParams({ token: this.jwt });
    
    if (this.copyFollowerAccountId) {
      params.append('copy_follower_account_id', this.copyFollowerAccountId);
    }
    
    const wsUrl = `${baseUrl}?${params.toString()}`;
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handlePortfolioUpdate(data);
    };
  }
  
  handlePortfolioUpdate(data) {
    // Handle real-time portfolio updates
    console.log('Portfolio update:', data);
  }
}

// Usage examples:
// 1. Connect to specific copy follower account
const copyFollowerWS = new CopyFollowerWebSocket(jwt, 123);
copyFollowerWS.connect();

// 2. Connect to all copy follower accounts (if no accountId provided)
const allAccountsWS = new CopyFollowerWebSocket(jwt);
allAccountsWS.connect();
```

## 🔄 Migration Strategy

### Step 1: Backward Compatibility
- Existing connections continue to work unchanged
- New parameter is optional

### Step 2: Gradual Rollout
1. Deploy server changes
2. Update frontend to use new parameter
3. Test with specific copy follower accounts
4. Extend to support multiple accounts per connection (future)

### Step 3: Performance Optimization
- Implement Redis caching for copy follower account lookups
- Add connection pooling for multiple accounts
- Optimize event emission for high-frequency updates

## 🎯 Benefits

### Immediate Benefits:
- ✅ Real-time updates for copy follower orders
- ✅ Uses existing JWT authentication
- ✅ Backward compatible
- ✅ Minimal client changes required

### Long-term Benefits:
- ✅ Scalable architecture for multiple accounts
- ✅ Consistent with existing WebSocket patterns
- ✅ Easy to extend for additional features
- ✅ Efficient resource usage

## 🔧 Implementation Priority

### High Priority (Phase 1):
1. WebSocket connection parameter handling
2. Copy follower account validation
3. Basic order fetching for specific account

### Medium Priority (Phase 2):
1. Enhanced order fetching for multiple accounts
2. Redis integration for copy follower orders
3. Event system enhancements

### Low Priority (Phase 3):
1. Performance optimizations
2. Advanced filtering options
3. Bulk account monitoring

## 🧪 Testing Strategy

### Unit Tests:
- WebSocket connection validation
- Copy follower account authorization
- Order fetching logic

### Integration Tests:
- End-to-end WebSocket communication
- Real-time event emission
- Multiple account scenarios

### Performance Tests:
- Connection load testing
- Event emission performance
- Memory usage optimization
