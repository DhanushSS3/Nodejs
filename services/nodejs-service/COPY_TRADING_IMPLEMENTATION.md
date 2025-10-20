# Copy Trading Implementation Summary

## Overview
Complete copy trading system that replicates strategy provider orders to follower accounts with proper lot calculation, group configuration inheritance, and SL/TP management.

## Key Features Implemented

### 1. Order Replication Logic
- **Automatic Replication**: Strategy provider orders are automatically copied to all active followers
- **Lot Calculation**: Based on follower equity/balance ratio to master equity
- **Group Constraints**: Respects min/max lot sizes from group configuration
- **Skip Logic**: Orders below minimum lot size are skipped and logged

### 2. Follower Account Management
- **Investment-Based**: Followers invest specific amounts to follow strategies
- **Settings Inheritance**: Leverage, group, sending_orders inherited from strategy provider
- **Custom SL/TP**: Followers can set percentage or amount-based stop loss/take profit
- **Risk Management**: Daily loss limits, drawdown stops, max lot size controls

### 3. Performance Fee System
- **Automatic Calculation**: Fees calculated on profitable closed orders
- **High Water Mark**: Prevents double charging on recovered losses
- **Transparent Tracking**: Complete audit trail of fee calculations
- **Real-time Updates**: Follower account statistics updated automatically

## Files Created/Modified

### Core Services
1. **`copyTrading.service.js`** - Main copy trading logic
   - Order replication processing
   - Lot size calculations with group constraints
   - Follower validation and risk management
   - Python service integration for order execution

2. **`copyTrading.hooks.js`** - Integration hooks
   - Strategy provider order creation/update hooks
   - Performance fee processing
   - Order modification validation
   - User trading permission validation

### Controllers & Routes
3. **`copyTrading.controller.js`** - Follower account management
   - Create/update/delete follower accounts
   - Investment validation and strategy requirements
   - Account settings and risk management

4. **`copyTrading.routes.js`** - API endpoints
   - `/follow` - Start following a strategy
   - `/accounts` - Get follower accounts
   - `/accounts/:id` - Update/delete follower account

### Middleware
5. **`copyTrading.middleware.js`** - Request validation
   - Prevents manual orders when copy trading is active
   - Blocks modification of copied orders
   - Triggers copy trading hooks after successful operations

### Model Updates
6. **Updated `strategyProviderOrder.model.js`** - Added copy trading hooks
7. **Updated `copyFollowerOrder.model.js`** - Enhanced performance fee processing

## Copy Trading Flow

### 1. Strategy Provider Places Order
```javascript
// Order created in StrategyProviderOrder
// Hook triggers: copyTradingHooks.onStrategyProviderOrderCreated()
// Service processes: copyTradingService.processStrategyProviderOrder()
```

### 2. Order Replication Process
```javascript
// For each active follower:
// 1. Validate follower can receive orders
// 2. Calculate lot size: follower_equity / master_equity * master_lot
// 3. Apply group min/max lot constraints
// 4. Apply follower's custom SL/TP settings
// 5. Execute order through Python service
// 6. Update follower account statistics
```

### 3. Lot Size Calculation
```javascript
const ratio = followerInvestment / masterEquity;
let calculatedLot = masterLotSize * ratio;

// Apply follower's max lot limit
if (follower.max_lot_size && calculatedLot > follower.max_lot_size) {
  calculatedLot = follower.max_lot_size;
}

// Apply group constraints
const finalLot = Math.max(calculatedLot, groupMinLot);
const constrainedLot = Math.min(finalLot, groupMaxLot);

// Skip if below minimum
if (constrainedLot < groupMinLot) {
  // Create skipped order record for audit
  return 'skipped';
}
```

### 4. SL/TP Application
```javascript
// Follower can set custom SL/TP in two modes:
// 1. Percentage mode: 30% loss = SL at 30% below entry price
// 2. Amount mode: $50 loss = SL at $50 below entry price

if (follower.copy_sl_mode === 'percentage') {
  const slPercentage = follower.sl_percentage / 100;
  stopLoss = isBuy ? orderPrice * (1 - slPercentage) : orderPrice * (1 + slPercentage);
}
```

### 5. Performance Fee Processing
```javascript
// On order close with profit:
// 1. Calculate gross profit
// 2. Apply performance fee percentage
// 3. Update follower account total fees paid
// 4. Record fee calculation details

const performanceFee = (grossProfit * feePercentage) / 100;
const netProfit = grossProfit - performanceFee;
```

## Integration Points

### With Existing Order Controller
```javascript
// Add to existing order routes:
const { validateCopyTradingConstraints, triggerCopyTradingHooks } = require('../middleware/copyTrading.middleware');

// Before order placement:
router.post('/instant', validateCopyTradingConstraints, triggerCopyTradingHooks, placeInstantOrder);

// Before order modification:
router.put('/modify/:order_id', validateOrderModification, modifyOrder);
```

### With Group Configuration
- Respects `min_lot` and `max_lot` from groups table
- Uses `groupsCache.getGroupFields()` for efficient lookups
- Applies constraints per symbol and group combination

### With Python Service
- Uses existing `/api/orders/instant/execute` endpoint
- Passes `copy_trading: true` flag for identification
- Includes `master_order_id` for audit trail
- Handles order closure/cancellation through Python service

## Risk Management Features

### Follower-Level Controls
- **Daily Loss Limit**: Stop copying if daily losses exceed threshold
- **Drawdown Protection**: Pause copying if account drawdown exceeds limit
- **Lot Size Limits**: Maximum lot size per order
- **Manual Override**: Followers can pause/stop copying anytime

### System-Level Protections
- **Minimum Investment**: $100 minimum to start following
- **Strategy Validation**: Only active, eligible strategies can be followed
- **User Validation**: Cannot follow own strategies
- **Order Validation**: Copied orders cannot be manually modified

## Performance Considerations

### Asynchronous Processing
- Copy trading processing runs asynchronously to avoid blocking main order flow
- Uses `setImmediate()` for non-blocking execution
- Error handling prevents copy trading failures from affecting master orders

### Database Optimization
- Efficient queries with proper indexing
- Batch processing for multiple followers
- Cached group configuration lookups
- Minimal database calls per replication

### Audit Trail
- Complete tracking of all copy operations
- Skipped orders logged with reasons
- Performance fee calculations recorded
- Lot calculation details preserved

## Usage Examples

### Start Following a Strategy
```javascript
POST /api/copy-trading/follow
{
  "strategy_provider_id": 123,
  "investment_amount": 1000,
  "account_name": "Following EURUSD Strategy",
  "copy_sl_mode": "percentage",
  "sl_percentage": 30,
  "copy_tp_mode": "percentage", 
  "tp_percentage": 50,
  "max_lot_size": 5.0,
  "max_daily_loss": 100
}
```

### Update Copy Settings
```javascript
PUT /api/copy-trading/accounts/456
{
  "copy_status": "paused",
  "pause_reason": "Market volatility",
  "sl_percentage": 25,
  "max_lot_size": 3.0
}
```

### Stop Following
```javascript
DELETE /api/copy-trading/accounts/456
{
  "reason": "Strategy not performing as expected"
}
```

## Error Handling

### Graceful Degradation
- Copy trading failures don't affect master orders
- Individual follower failures don't stop other replications
- Comprehensive error logging for debugging
- Fallback mechanisms for critical operations

### Validation Layers
- Input validation at API level
- Business logic validation in services
- Database constraint validation
- Runtime error handling with recovery

This implementation provides a robust, scalable copy trading system that integrates seamlessly with your existing order flow while maintaining data integrity and providing comprehensive risk management features.
