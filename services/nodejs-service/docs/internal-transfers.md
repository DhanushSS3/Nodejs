# Internal Transfer System

## Overview

The Internal Transfer System allows live users to transfer funds between their different wallet accounts within the platform. This includes transfers between:

- **Main Trading Account** - The primary live user account
- **Strategy Provider Accounts** - Accounts used for providing trading strategies
- **Copy Follower Accounts** - Accounts used for following other traders' strategies

## Features

### ✅ **Comprehensive Validation**
- **Balance Verification**: Ensures sufficient funds are available
- **Margin Protection**: Prevents transfers that would violate margin requirements for open orders
- **Account Ownership**: Validates user owns both source and destination accounts
- **Business Rules**: Enforces platform-specific transfer rules

### ✅ **Margin Safety**
- **Open Orders Check**: Analyzes all open/pending orders before allowing transfers
- **Margin Calculation**: Ensures remaining balance can cover required margins
- **Risk Prevention**: Blocks transfers that could cause margin calls or order closures

### ✅ **Transaction Integrity**
- **Atomic Operations**: All transfers use database transactions for consistency
- **Audit Trail**: Complete transaction history with metadata
- **Unique Transaction IDs**: Each transfer gets a unique identifier
- **Status Tracking**: Real-time status updates for all transfers

### ✅ **Multi-Account Support**
- **Account Discovery**: Automatically finds all user accounts
- **Balance Aggregation**: Shows available vs. used balances
- **Account Relationships**: Tracks which strategies are being followed

## API Endpoints

### 1. Get User Accounts
```http
GET /api/internal-transfers/accounts
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "mainAccount": {
      "type": "main",
      "id": 123,
      "name": "Main Trading Account",
      "account_number": "LU123456",
      "wallet_balance": 10000.00,
      "margin": 2500.00,
      "net_profit": 1500.00,
      "available_balance": 7500.00
    },
    "strategyProviderAccounts": [
      {
        "type": "strategy_provider",
        "id": 456,
        "name": "EURUSD Scalping Strategy",
        "account_number": "SP456789",
        "wallet_balance": 5000.00,
        "margin": 1000.00,
        "net_profit": 500.00,
        "available_balance": 4000.00
      }
    ],
    "copyFollowerAccounts": [
      {
        "type": "copy_follower",
        "id": 789,
        "name": "Following John's Strategy",
        "account_number": "CF789012",
        "wallet_balance": 3000.00,
        "margin": 500.00,
        "net_profit": 200.00,
        "available_balance": 2500.00,
        "following_strategy": "John's GBPUSD Strategy"
      }
    ]
  }
}
```

### 2. Validate Transfer
```http
POST /api/internal-transfers/validate
Authorization: Bearer <token>
Content-Type: application/json

{
  "fromAccountType": "main",
  "toAccountType": "strategy_provider",
  "toAccountId": 456,
  "amount": 1000.00
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Transfer validation successful",
  "data": {
    "sourceAccount": {
      "type": "main",
      "name": "Main Trading Account",
      "currentBalance": 10000.00,
      "balanceAfterTransfer": 9000.00
    },
    "destinationAccount": {
      "type": "strategy_provider",
      "name": "EURUSD Scalping Strategy",
      "currentBalance": 5000.00,
      "balanceAfterTransfer": 6000.00
    },
    "transferAmount": 1000.00,
    "availableBalance": 7500.00
  }
}
```

**Response (Validation Error):**
```json
{
  "success": false,
  "message": "Transfer would violate margin requirements. You have 3 open order(s) requiring $2500.00 margin. Balance after transfer would be $6500.00.",
  "details": {
    "availableBalance": 7500.00,
    "openOrdersCount": 3,
    "totalMarginRequired": 2500.00
  }
}
```

### 3. Execute Transfer
```http
POST /api/internal-transfers/execute
Authorization: Bearer <token>
Content-Type: application/json

{
  "fromAccountType": "main",
  "toAccountType": "strategy_provider",
  "toAccountId": 456,
  "amount": 1000.00,
  "notes": "Funding strategy account for new trades"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transfer completed successfully",
  "data": {
    "transactionId": "TXN1699123456ABC123",
    "amount": 1000.00,
    "sourceAccount": {
      "type": "main",
      "id": 123,
      "name": "Main Trading Account",
      "balanceAfter": 9000.00
    },
    "destinationAccount": {
      "type": "strategy_provider",
      "id": 456,
      "name": "EURUSD Scalping Strategy",
      "balanceAfter": 6000.00
    }
  }
}
```

### 4. Get Transfer History
```http
GET /api/internal-transfers/history?page=1&limit=20
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transfers": [
      {
        "id": 12345,
        "transaction_id": "TXN1699123456ABC123_OUT",
        "amount": -1000.00,
        "balance_before": 10000.00,
        "balance_after": 9000.00,
        "status": "completed",
        "notes": "Transfer to EURUSD Scalping Strategy",
        "metadata": {
          "transfer_type": "internal_transfer_out",
          "from_account": {
            "type": "main",
            "id": 123,
            "name": "Main Trading Account"
          },
          "to_account": {
            "type": "strategy_provider",
            "id": 456,
            "name": "EURUSD Scalping Strategy"
          }
        },
        "created_at": "2024-11-07T10:30:00Z",
        "transfer_direction": "outgoing"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

### 5. Get Account Balance
```http
GET /api/internal-transfers/account/strategy_provider/456/balance
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 456,
    "type": "strategy_provider",
    "wallet_balance": 5000.00,
    "margin": 1000.00,
    "net_profit": 500.00,
    "account_number": "SP456789",
    "name": "EURUSD Scalping Strategy",
    "availableBalance": 4000.00,
    "marginInfo": {
      "openOrdersCount": 2,
      "totalMarginRequired": 1000.00
    }
  }
}
```

## Account Types

### Main Account (`main`)
- **Description**: Primary live user trading account
- **Account ID**: Use user ID or `"me"` in API calls
- **Features**: Standard trading, deposits, withdrawals

### Strategy Provider Account (`strategy_provider`)
- **Description**: Account for users providing trading strategies
- **Account ID**: Strategy provider account ID
- **Features**: Strategy management, follower distribution, performance fees

### Copy Follower Account (`copy_follower`)
- **Description**: Account for following other traders' strategies
- **Account ID**: Copy follower account ID
- **Features**: Automatic trade copying, performance tracking

## Validation Rules

### 1. **Balance Validation**
```javascript
// Must have sufficient available balance
availableBalance = walletBalance - marginUsed
transferAmount <= availableBalance
```

### 2. **Margin Protection**
```javascript
// Remaining balance must cover margin requirements
balanceAfterTransfer = currentBalance - transferAmount
balanceAfterTransfer >= totalMarginRequired
```

### 3. **Account Ownership**
```javascript
// User must own both accounts
sourceAccount.user_id === authenticatedUserId
destinationAccount.user_id === authenticatedUserId
```

### 4. **Business Rules**
- Transfer amount must be > 0.01
- Cannot transfer to the same account
- Accounts must be active and accessible
- Maximum transfer amount may be limited by platform settings

## Error Handling

### Common Error Scenarios

1. **Insufficient Balance**
   ```json
   {
     "success": false,
     "message": "Insufficient available balance. Available: $1500.00, Required: $2000.00",
     "availableBalance": 1500.00
   }
   ```

2. **Margin Violation**
   ```json
   {
     "success": false,
     "message": "Transfer would violate margin requirements. You have 3 open order(s) requiring $2500.00 margin.",
     "details": {
       "openOrdersCount": 3,
       "totalMarginRequired": 2500.00,
       "balanceAfterTransfer": 2000.00
     }
   }
   ```

3. **Account Not Found**
   ```json
   {
     "success": false,
     "message": "Destination account not found or not accessible"
   }
   ```

4. **Invalid Transfer**
   ```json
   {
     "success": false,
     "message": "Cannot transfer to the same account"
   }
   ```

## Security Features

### 1. **Authentication**
- All endpoints require valid JWT token
- User identity verified for all operations

### 2. **Authorization**
- Users can only access their own accounts
- Account ownership validated on every request

### 3. **Transaction Integrity**
- Database transactions ensure atomicity
- Rollback on any failure during transfer

### 4. **Audit Trail**
- Complete transaction history maintained
- Metadata includes full transfer details
- Immutable transaction records

## Integration Guide

### 1. **Add Routes to Main App**
```javascript
// In your main app.js or routes/index.js
const internalTransferRoutes = require('./routes/internalTransfer.routes');
app.use('/api/internal-transfers', internalTransferRoutes);
```

### 2. **Database Requirements**
- Ensure all models are properly imported
- Verify database connections are established
- Check that user_transactions table exists with 'transfer' type support

### 3. **Frontend Integration**
```javascript
// Example frontend usage
const accounts = await fetch('/api/internal-transfers/accounts', {
  headers: { 'Authorization': `Bearer ${token}` }
});

const validation = await fetch('/api/internal-transfers/validate', {
  method: 'POST',
  headers: { 
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    fromAccountType: 'main',
    toAccountType: 'strategy_provider',
    toAccountId: 456,
    amount: 1000.00
  })
});

if (validation.success) {
  const transfer = await fetch('/api/internal-transfers/execute', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fromAccountType: 'main',
      toAccountType: 'strategy_provider',
      toAccountId: 456,
      amount: 1000.00,
      notes: 'Funding strategy account'
    })
  });
}
```

## Testing

### 1. **Unit Tests**
- Service layer validation logic
- Account balance calculations
- Margin requirement checks

### 2. **Integration Tests**
- End-to-end transfer flows
- Database transaction integrity
- Error handling scenarios

### 3. **Manual Testing Scenarios**
- Transfer between all account type combinations
- Insufficient balance scenarios
- Margin violation scenarios
- Large transfer amounts
- Concurrent transfer attempts

## Monitoring & Logging

### 1. **Key Metrics**
- Transfer success/failure rates
- Average transfer amounts
- Most common transfer routes
- Error frequency by type

### 2. **Logging Events**
- Transfer initiation and completion
- Validation failures with reasons
- Account balance changes
- Error conditions with full context

### 3. **Alerts**
- Failed transfers above threshold
- Unusual transfer patterns
- System errors during transfers
- Database transaction failures

## Future Enhancements

### 1. **Advanced Features**
- Scheduled transfers
- Recurring transfers
- Transfer limits and controls
- Multi-currency support

### 2. **Risk Management**
- Daily/monthly transfer limits
- Velocity checks for large amounts
- Fraud detection patterns
- Administrative approval workflows

### 3. **User Experience**
- Transfer templates/favorites
- Bulk transfer operations
- Mobile app integration
- Real-time notifications
