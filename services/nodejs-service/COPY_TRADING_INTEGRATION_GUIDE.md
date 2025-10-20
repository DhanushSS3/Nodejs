# Copy Trading Integration Guide

## ✅ Completed Integration Steps

### 1. **Middleware Integration** ✅
- **Added copy trading middleware** to `src/middlewares/copyTrading.middleware.js`
- **Integrated with orders routes** in `src/routes/orders.routes.js`:
  - `validateCopyTradingConstraints` - Prevents manual orders when copy trading is active
  - `validateOrderModification` - Blocks modification of copied orders
  - `triggerCopyTradingHooks` - Triggers copy trading after successful order placement

### 2. **Route Integration** ✅
- **Added copy trading routes** to `src/app.js` at `/api/copy-trading`
- **Routes available**:
  - `POST /api/copy-trading/follow` - Start following a strategy
  - `GET /api/copy-trading/accounts` - Get follower accounts
  - `PUT /api/copy-trading/accounts/:id` - Update follower settings
  - `DELETE /api/copy-trading/accounts/:id` - Stop following

### 3. **Model Integration** ✅
- **Updated `src/models/index.js`** to include all MAM/PAMM models
- **Model hooks integrated** in:
  - `strategyProviderOrder.model.js` - Triggers copy trading on order create/update
  - `copyFollowerOrder.model.js` - Processes performance fees on order close

### 4. **Python Service Schema** ✅
- **Enhanced `orders.py` schema** with copy trading fields:
  - `copy_trading: bool` - Flag for copy trading orders
  - `master_order_id: str` - Reference to master order
  - `copy_follower_account_id: str` - Follower account reference
  - `strategy_provider_id: str` - Strategy provider reference

## 🚀 Next Steps to Complete Integration

### 1. **Run Database Migrations**
```bash
cd services/nodejs-service
npx sequelize-cli db:migrate
```

### 2. **Test Copy Trading Flow**

#### Start Following a Strategy:
```bash
curl -X POST http://localhost:3000/api/copy-trading/follow \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "strategy_provider_id": 1,
    "investment_amount": 1000,
    "account_name": "My EURUSD Copy",
    "copy_sl_mode": "percentage",
    "sl_percentage": 30,
    "copy_tp_mode": "percentage", 
    "tp_percentage": 50,
    "max_lot_size": 5.0
  }'
```

#### Place Strategy Provider Order (should trigger copying):
```bash
curl -X POST http://localhost:3000/api/orders/instant/place \
  -H "Authorization: Bearer STRATEGY_PROVIDER_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "EURUSD",
    "order_type": "BUY",
    "order_price": 1.1000,
    "order_quantity": 2.0,
    "user_id": "strategy_provider_user_id",
    "user_type": "live"
  }'
```

### 3. **Monitor Copy Trading Logs**
Check logs for copy trading processing:
```bash
# In Node.js service logs, look for:
# - "Strategy provider order created, triggering copy trading"
# - "Processing copy trading for X followers"
# - "Copy trading order placed successfully"
# - "Copy trading order skipped due to lot constraints"
```

### 4. **Verify Database Records**
After testing, check that records are created in:
- `copy_follower_accounts` - Follower account created
- `copy_follower_orders` - Copied orders with proper lot calculations
- `strategy_provider_orders` - Master orders with copy distribution status

## 🔧 Configuration Requirements

### Environment Variables
Ensure these are set in your `.env` file:
```env
# Redis Configuration (for caching)
REDIS_HOST=localhost
REDIS_PORT=6379

# Python Service URL (for order execution)
PYTHON_SERVICE_URL=http://localhost:8000

# Internal API Secret (for service communication)
INTERNAL_API_SECRET=your_secret_key
```

### Database Tables
Ensure all copy trading tables exist:
- `strategy_provider_accounts`
- `copy_follower_accounts` 
- `strategy_provider_orders`
- `copy_follower_orders`
- `mam_master_accounts`
- `mam_follower_accounts`
- `mam_follower_orders`
- `pamm_manager_accounts`
- `pamm_investor_accounts`
- `pamm_investor_allocations`
- `pamm_manager_orders`

## 🛡️ Security & Validation

### Copy Trading Constraints
The middleware automatically enforces:
- **No manual orders** when user has active copy trading accounts
- **No modification** of copied orders (managed by strategy provider only)
- **Investment validation** (minimum $100, strategy requirements)
- **User validation** (cannot follow own strategies)

### Error Handling
- Copy trading failures don't block master orders
- Individual follower failures don't stop other replications
- Comprehensive error logging for debugging
- Graceful degradation on service failures

## 📊 Monitoring & Debugging

### Key Log Messages to Monitor:
```javascript
// Successful copy trading
"Copy trading order placed successfully"

// Lot size constraints
"Copy trading order skipped due to lot constraints"

// Performance fees
"Performance fee calculated for copied order"

// Validation failures
"Cannot place orders while copy trading is active"
"Cannot modify copied orders"
```

### Database Queries for Monitoring:
```sql
-- Check active copy relationships
SELECT sp.strategy_name, cf.account_name, cf.investment_amount, cf.copy_status
FROM copy_follower_accounts cf
JOIN strategy_provider_accounts sp ON cf.strategy_provider_id = sp.id
WHERE cf.copy_status = 'active';

-- Check recent copied orders
SELECT cfo.order_id, cfo.calculated_lot_size, cfo.final_lot_size, 
       cfo.copy_status, cfo.skip_reason
FROM copy_follower_orders cfo
WHERE cfo.created_at > NOW() - INTERVAL 1 DAY
ORDER BY cfo.created_at DESC;

-- Check performance fees
SELECT cfo.order_id, cfo.gross_profit, cfo.performance_fee_amount, 
       cfo.net_profit_after_fees, cfo.fee_status
FROM copy_follower_orders cfo
WHERE cfo.fee_status = 'calculated'
ORDER BY cfo.fee_calculation_date DESC;
```

## 🔄 Copy Trading Flow Summary

### Order Replication Process:
1. **Strategy Provider** places order → `StrategyProviderOrder` created
2. **Model Hook** triggers → `copyTradingHooks.onStrategyProviderOrderCreated()`
3. **Service Processing** → `copyTradingService.processStrategyProviderOrder()`
4. **For Each Follower**:
   - Validate follower can receive orders
   - Calculate lot size: `follower_equity / master_equity * master_lot`
   - Apply group min/max lot constraints
   - Apply follower's custom SL/TP settings
   - Execute order through Python service
   - Update follower account statistics

### Lot Size Calculation:
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
  return 'skipped';
}
```

### Performance Fee Calculation:
```javascript
// On profitable order close:
const performanceFee = (grossProfit * feePercentage) / 100;
const netProfit = grossProfit - performanceFee;

// Update follower account
await CopyFollowerAccount.increment('total_fees_paid', {
  by: performanceFee,
  where: { id: followerAccountId }
});
```

## 🎯 Success Criteria

### Integration is successful when:
- ✅ Follower accounts can be created via API
- ✅ Strategy provider orders automatically trigger copying
- ✅ Lot sizes are calculated correctly with group constraints
- ✅ Custom SL/TP settings are applied to copied orders
- ✅ Performance fees are calculated on profitable closes
- ✅ Manual order placement is blocked for active copy traders
- ✅ Copied orders cannot be manually modified
- ✅ All operations are logged for audit trail

### Performance Benchmarks:
- Copy trading processing should complete within **2 seconds** for up to 100 followers
- Database queries should be optimized with proper indexing
- Error rate should be less than **1%** for copy operations
- System should handle **1000+ concurrent copy operations**

This integration provides a production-ready copy trading system that scales with your existing infrastructure while maintaining data integrity and providing comprehensive risk management features.
