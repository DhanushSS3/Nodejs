# High-Concurrency Trading Backend - Transaction Patterns

## Overview

This document outlines the transaction patterns implemented for a high-concurrency trading backend designed to handle **33,000+ concurrent users** and **100,000+ total users** with strict financial data consistency.

## Core Principles

### 1. **Database Transaction Wrapping**
Every critical operation MUST be wrapped in a Sequelize transaction using our `TransactionService`.

### 2. **Row-Level Locking**
Financial data updates MUST use `SELECT ... FOR UPDATE` to prevent race conditions.

### 3. **Deadlock Prevention**
Automatic retry logic with exponential backoff for deadlock situations.

### 4. **Atomic Operations**
All financial operations are atomic - either all succeed or all fail.

### 5. **Graceful Failure Handling**
Comprehensive error handling with descriptive logging and automatic rollback.

### 6. **Idempotency Protection**
Duplicate request prevention using idempotency keys.

## Services

### TransactionService
The core service for database transaction management.

```javascript
const TransactionService = require('../services/transaction.service');

// Basic transaction with retry
const result = await TransactionService.executeWithRetry(async (transaction) => {
  // Your database operations here
  const user = await User.findByPk(userId, { transaction });
  await user.update({ balance: newBalance }, { transaction });
  return user;
});

// Transaction with user locking
const result = await TransactionService.executeWithUserLock(userId, async (transaction, user) => {
  // User is automatically locked with SELECT ... FOR UPDATE
  await user.update({ balance: user.balance + amount }, { transaction });
  return user;
});
```

### FinancialService
Specialized service for financial operations with atomic guarantees.

```javascript
const FinancialService = require('../services/financial.service');

// Update wallet balance
const result = await FinancialService.updateWalletBalance(
  userId, 
  amount, 
  'live', // or 'demo'
  'deposit',
  { paymentMethod: 'bank_transfer' }
);

// Combined financial operation
const result = await FinancialService.performCombinedOperation(
  userId,
  {
    balance: 100.00,    // Credit $100
    margin: -50.00,     // Release $50 margin
    profit: 25.00       // Add $25 profit
  },
  'live',
  'trade_close'
);
```

### IdempotencyService
Prevents duplicate operations using unique keys.

```javascript
const { IdempotencyService } = require('../services/idempotency.service');

// Generate key and check for duplicates
const idempotencyKey = IdempotencyService.generateKey(req, 'operation_name');
const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

if (isExisting && record.status === 'completed') {
  return res.status(200).json(record.response);
}

// Mark as completed after successful operation
await IdempotencyService.markCompleted(idempotencyKey, result);
```

## Controller Patterns

### Standard Financial Operation Pattern

```javascript
async function financialOperation(req, res) {
  const operationId = `operation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // 1. Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // 2. Extract parameters
    const { userId, amount, userType } = req.body;

    // 3. Check idempotency
    const idempotencyKey = IdempotencyService.generateKey(req, 'operation_name');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting && record.status === 'completed') {
      return res.status(200).json(record.response);
    }

    // 4. Log transaction start
    logger.transactionStart('operation_name', { operationId, userId, amount });

    // 5. Execute with transaction
    const result = await TransactionService.executeWithRetry(async (transaction) => {
      // Your business logic here
      // Always use transaction parameter for database operations
      
      return { success: true, /* your result */ };
    });

    // 6. Mark idempotency as completed
    await IdempotencyService.markCompleted(idempotencyKey, result);

    // 7. Log success
    logger.transactionSuccess('operation_name', { operationId });

    return res.status(200).json(result);

  } catch (error) {
    // 8. Handle errors
    logger.transactionFailure('operation_name', error, { operationId });
    
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'operation_name');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { error: idempotencyError.message });
    }

    // Return appropriate error response
    return res.status(500).json({ 
      success: false, 
      message: 'Operation failed',
      operationId 
    });
  }
}
```

## Database Configuration

### Connection Pool Settings
```javascript
// src/config/db.js
pool: {
  max: 50,           // Maximum connections
  min: 0,            // Minimum connections
  acquire: 30000,    // 30s timeout to get connection
  idle: 10000        // 10s before releasing idle connection
}
```

### Model Configuration
```javascript
// Always use snake_case for database fields
{
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['email'] },
    { fields: ['account_number'] }
  ]
}
```

## Error Handling

### Global Error Middleware
- Handles Sequelize-specific errors
- Provides appropriate HTTP status codes
- Logs errors with context
- Never exposes sensitive information

### Custom Error Types
```javascript
// Insufficient balance
if (newBalance < 0) {
  throw new Error('Insufficient balance. Current: ${balance}, Requested: ${amount}');
}

// Deadlock detection
if (TransactionService.isDeadlockError(error)) {
  // Automatically retried by TransactionService
}
```

## Logging

### Financial Operations
```javascript
logger.financial('operation_name', {
  operationId,
  userId,
  amount,
  oldBalance,
  newBalance,
  metadata
});
```

### Transaction Lifecycle
```javascript
logger.transactionStart('operation_name', context);
logger.transactionSuccess('operation_name', context);
logger.transactionFailure('operation_name', error, context);
```

## Performance Considerations

### 1. **Connection Pooling**
- Pool size: 50 connections
- Acquire timeout: 30 seconds
- Idle timeout: 10 seconds

### 2. **Lock Duration**
- Keep transactions short
- Lock only necessary rows
- Use appropriate isolation levels

### 3. **Retry Strategy**
- Maximum 3 retry attempts
- Exponential backoff: 10ms, 20ms, 40ms
- Jitter to prevent thundering herd

### 4. **Indexing**
- Index all foreign keys
- Index frequently queried fields
- Composite indexes for complex queries

## Example Implementations

The following example controllers demonstrate the patterns:

1. **Order Management** (`src/controllers/examples/order.controller.js`)
   - Place order with margin calculation
   - Close order with P&L updates

2. **Wallet Operations** (`src/controllers/examples/wallet.controller.js`)
   - Deposit funds
   - Withdraw funds
   - Internal transfers

3. **Referral System** (`src/controllers/examples/referral.controller.js`)
   - Commission distribution
   - Signup bonuses
   - Referral statistics

## Migration Guide

### Setting up Idempotency
1. Run the idempotency keys migration:
```bash
npx sequelize-cli db:migrate
```

2. Import services in your controllers:
```javascript
const TransactionService = require('../services/transaction.service');
const FinancialService = require('../services/financial.service');
const { IdempotencyService } = require('../services/idempotency.service');
const logger = require('../services/logger.service');
```

3. Update existing controllers to use the transaction patterns shown above.

## Monitoring and Maintenance

### Health Checks
- `/health` endpoint for system status
- Database connection monitoring
- Transaction success/failure rates

### Cleanup Jobs
- Expired idempotency keys cleanup
- Log rotation
- Performance metrics collection

## Security Considerations

### 1. **Input Validation**
- Validate all user inputs
- Sanitize financial amounts
- Check user permissions

### 2. **Rate Limiting**
- Implement per-user rate limits
- Monitor for suspicious patterns
- Block excessive failed attempts

### 3. **Audit Trail**
- Log all financial operations
- Track operation IDs
- Maintain transaction history

## Future Enhancements

1. **Distributed Transactions**
   - Cross-service transaction coordination
   - Saga pattern implementation

2. **Read Replicas**
   - Separate read and write operations
   - Load balancing for queries

3. **Caching Layer**
   - Redis for session data
   - Cache frequently accessed data

4. **Message Queues**
   - Async processing for non-critical operations
   - Event-driven architecture

---

**Remember**: This is a financial system. **NO PARTIAL UPDATES ALLOWED**. All critical database writes MUST be atomic and use the patterns described in this document.