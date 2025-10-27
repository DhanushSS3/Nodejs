# Minimum Balance Implementation for Copy Trading

## Overview
This implementation enforces a minimum balance requirement of $100 for both strategy providers and copy followers to participate in copy trading activities.

## Key Requirements Implemented

### 1. Strategy Provider Requirements
- **Minimum Balance**: $100 in account equity (wallet_balance + net_profit)
- **Account Creation**: Users must have at least $100 to create a strategy provider account
- **Trading Eligibility**: Strategy providers must maintain $100 minimum to continue trading
- **Catalog Eligibility**: Strategy providers below $100 are automatically removed from catalog
- **Follower Acceptance**: Strategy providers below $100 cannot accept new followers

### 2. Copy Follower Requirements
- **Minimum Balance**: $100 in user's main account to start copy trading
- **Investment Validation**: Users must have sufficient balance for their investment amount
- **Strategy Provider Validation**: Cannot follow strategy providers with insufficient balance

## Implementation Details

### Files Modified

#### 1. Strategy Provider Controller (`strategyProvider.controller.js`)
- Added minimum balance validation in `createStrategyProviderAccount()`
- Added new endpoints:
  - `POST /api/strategy-providers/update-catalog-eligibility` - Manual catalog cleanup
  - `GET /api/strategy-providers/:id/trading-eligibility` - Check trading eligibility

#### 2. Copy Trading Controller (`copyTrading.controller.js`)
- Added minimum balance validation in `createFollowerAccount()`
- Added strategy provider balance validation before allowing follows

#### 3. Strategy Provider Service (`strategyProvider.service.js`)
- Added `getCatalogRequirements()` method with minimum equity requirement
- Added `updateCatalogEligibilityByBalance()` for automatic catalog cleanup
- Added `checkTradingEligibility()` for trading validation
- Updated `checkCatalogEligibility()` to include equity validation

### Validation Points

#### Strategy Provider Account Creation
```javascript
const userBalance = parseFloat(liveUser.wallet_balance || 0);
const minBalance = 100.00;

if (userBalance < minBalance) {
  return res.status(400).json({
    success: false,
    message: `Minimum balance of $${minBalance} required to create a strategy provider account. Current balance: $${userBalance.toFixed(2)}`
  });
}
```

#### Copy Follower Account Creation
```javascript
const userBalance = parseFloat(liveUser.wallet_balance || 0);
const minBalance = 100.00;

// Check minimum balance requirement
if (userBalance < minBalance) {
  return res.status(400).json({
    success: false,
    message: `Minimum balance of $${minBalance} required to start copy trading. Current balance: $${userBalance.toFixed(2)}`
  });
}

// Check strategy provider balance
const strategyProviderEquity = parseFloat(strategyProvider.wallet_balance || 0) + parseFloat(strategyProvider.net_profit || 0);
if (strategyProviderEquity < minBalance) {
  return res.status(400).json({
    success: false,
    message: `Strategy provider does not meet minimum balance requirement of $${minBalance}. Current equity: $${strategyProviderEquity.toFixed(2)}`
  });
}
```

#### Catalog Eligibility
```javascript
// Check minimum equity requirement
const currentEquity = parseFloat(strategyProvider.wallet_balance || 0) + parseFloat(strategyProvider.net_profit || 0);
if (currentEquity < requirements.min_equity) {
  failures.push(`Minimum equity of $${requirements.min_equity} required (current: $${currentEquity.toFixed(2)})`);
}
```

### Automatic Catalog Cleanup

The `updateCatalogEligibilityByBalance()` method automatically removes strategy providers from catalog when their equity falls below $100:

```javascript
// Find all strategy providers currently in catalog but with insufficient balance
const ineligibleProviders = await StrategyProviderAccount.findAll({
  where: {
    is_catalog_eligible: true,
    status: 1,
    is_active: 1,
    catalog_free_pass: false, // Don't remove free pass accounts
    [Op.or]: [
      // Complex query to check wallet_balance + net_profit < 100
    ]
  }
});

// Remove each provider from catalog
for (const provider of ineligibleProviders) {
  await StrategyProviderAccount.update(
    {
      is_catalog_eligible: false,
      catalog_eligibility_updated_at: new Date()
    },
    { where: { id: provider.id } }
  );
}
```

## API Endpoints

### New Endpoints Added

1. **POST /api/strategy-providers/update-catalog-eligibility**
   - Updates catalog eligibility based on minimum balance
   - Removes providers with insufficient balance from catalog
   - Returns list of removed providers

2. **GET /api/strategy-providers/:id/trading-eligibility**
   - Checks if strategy provider can start trading
   - Validates minimum balance requirement
   - Returns eligibility status and current equity

### Modified Endpoints

1. **POST /api/strategy-providers** (createStrategyProviderAccount)
   - Added minimum balance validation before account creation

2. **POST /api/copy-trading/follow** (createFollowerAccount)
   - Added minimum balance validation for user
   - Added strategy provider balance validation

## Error Messages

The implementation provides clear error messages for different scenarios:

- **Insufficient user balance for strategy creation**: "Minimum balance of $100 required to create a strategy provider account. Current balance: $X.XX"
- **Insufficient user balance for copy trading**: "Minimum balance of $100 required to start copy trading. Current balance: $X.XX"
- **Strategy provider insufficient balance**: "Strategy provider does not meet minimum balance requirement of $100. Current equity: $X.XX"
- **Catalog eligibility failure**: "Minimum equity of $100 required (current: $X.XX)"

## Recommendations

1. **Scheduled Job**: Set up a cron job or scheduled task to run `updateCatalogEligibilityByBalance()` periodically (e.g., every hour)
2. **Real-time Updates**: Consider implementing real-time balance checks when trades are executed
3. **Notifications**: Add email/push notifications to inform users when they're removed from catalog due to insufficient balance
4. **Grace Period**: Consider implementing a grace period before removing from catalog to account for temporary balance fluctuations

## Testing Considerations

1. Test strategy provider creation with various balance scenarios
2. Test copy follower creation with insufficient balance
3. Test following strategy providers with insufficient balance
4. Test catalog cleanup functionality
5. Test edge cases with negative net_profit values
6. Verify free pass accounts are not affected by balance requirements

## Database Impact

The implementation uses existing database fields:
- `wallet_balance` - Current account balance
- `net_profit` - Accumulated profit/loss
- `is_catalog_eligible` - Catalog eligibility flag
- `catalog_eligibility_updated_at` - Last eligibility update timestamp
- `catalog_free_pass` - Superadmin override flag

No new database migrations are required.
