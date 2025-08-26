# Logging System Documentation

## 🏗️ Architecture Overview

Our logging system follows SOLID principles with a clean, scalable architecture:

```
src/services/logging/
├── LoggerFactory.js      # Factory Pattern - Creates logger instances
├── BaseLogger.js         # Interface - Common logging contract
├── CryptoPaymentLogger.js # Domain-specific logger
├── UserAuthLogger.js     # Domain-specific logger
├── ApplicationLogger.js  # General application logger
├── index.js             # Centralized exports
└── README.md           # This documentation
```

## 🚀 Quick Start

### Option 1: Use Pre-configured Loggers (Recommended)
```javascript
const { cryptoPaymentLogger, userAuthLogger, applicationLogger } = require('../services/logging');

// In crypto payment controller
cryptoPaymentLogger.logDepositRequest(userId, requestData, ip, userAgent);

// In authentication service
userAuthLogger.logLiveUserLogin({ email, account_number, ip, userAgent, timestamp });

// For general application logs
applicationLogger.info('Server started', { port: 3000 });
```

### Option 2: Create Custom Loggers
```javascript
const { LoggerFactory } = require('../services/logging');

// Create a custom logger for a new domain
const orderLogger = LoggerFactory.getLogger('orders', {
  filename: 'orders.log',
  maxsize: 10485760, // 10MB
  maxFiles: 5
});

orderLogger.info('Order created', { orderId: 123, userId: 456 });
```

### Option 3: Quick Logger Creation
```javascript
const { createLogger } = require('../services/logging');

const customLogger = createLogger('myFeature');
customLogger.info('Feature initialized');
```

## 🎯 Environment Configuration

### Log Levels
- **Development**: `debug` level (shows all logs)
- **Production**: `info` level (shows info, warn, error)
- **Custom**: Set `LOG_LEVEL` environment variable

### Log Formats
- **Development**: Human-readable with colors
- **Production**: Structured JSON for log aggregation

### Environment Variables
```bash
NODE_ENV=development|production
LOG_LEVEL=debug|info|warn|error
```

## 📁 Log Files Location

All logs are stored in: `services/nodejs-service/logs/`

- `cryptoPayments.log` - All crypto payment activities
- `userAuth.log` - Authentication events
- `application.log` - General application logs
- `[custom].log` - Custom domain logs

## 🔧 Usage Examples

### Crypto Payment Controller
```javascript
const { cryptoPaymentLogger } = require('../services/logging');

class CryptoPaymentController {
  async createDeposit(req, res) {
    // Log incoming request
    cryptoPaymentLogger.logDepositRequest(
      userId, 
      requestData, 
      req.ip, 
      req.get('User-Agent')
    );

    // Log API response
    cryptoPaymentLogger.logTyltResponse(userId, merchantOrderId, response);
  }

  async handleWebhook(req, res) {
    // Log webhook callback
    cryptoPaymentLogger.logWebhookCallback(
      webhookData, 
      signature, 
      isValid, 
      req.ip, 
      req.get('User-Agent')
    );
  }
}
```

### Error Handling
```javascript
const { applicationLogger } = require('../services/logging');

try {
  // Some operation
} catch (error) {
  applicationLogger.error('Operation failed', {
    error: error.message,
    stack: error.stack,
    userId: req.user?.id,
    operation: 'createPayment'
  });
}
```

### Financial Operations
```javascript
const { applicationLogger } = require('../services/logging');

// Log financial transactions for audit trail
applicationLogger.logFinancialOperation('wallet_credit', {
  userId: 123,
  amount: 100.50,
  currency: 'USD',
  transactionId: 'tx_123'
});
```

## 🔄 Migration from Old System

### Legacy Compatibility
Old imports still work via compatibility layer:
```javascript
// This still works (uses ApplicationLogger internally)
const logger = require('../utils/logger');
logger.info('Message', { context: 'data' });
```

### Recommended Migration
```javascript
// Old way
const logger = require('../utils/logger');
logger.info('Payment created');

// New way (recommended)
const { cryptoPaymentLogger } = require('../services/logging');
cryptoPaymentLogger.logDepositRequest(userId, data, ip, userAgent);
```

## 🧪 Testing

```javascript
const { LoggerFactory } = require('../services/logging');

// Clear loggers between tests
afterEach(() => {
  LoggerFactory.clearLoggers();
});
```

## 📊 Log Structure

### Development Format
```
[2025-01-26 10:30:45] INFO: Deposit request received
{
  "type": "deposit_request",
  "userId": 123,
  "requestData": {
    "baseAmount": "100",
    "baseCurrency": "USD"
  }
}
```

### Production Format
```json
{
  "timestamp": "2025-01-26T10:30:45.123Z",
  "level": "info",
  "message": "Deposit request received",
  "type": "deposit_request",
  "userId": 123,
  "requestData": {
    "baseAmount": "100",
    "baseCurrency": "USD"
  }
}
```

## 🎯 Best Practices

1. **Use Domain-Specific Loggers**: Choose the right logger for your domain
2. **Structured Logging**: Always include relevant context
3. **Error Logging**: Include stack traces and operation context
4. **Security**: Never log sensitive data (passwords, API keys)
5. **Performance**: Use appropriate log levels to avoid noise

## 🔧 Extending the System

### Adding a New Domain Logger
```javascript
// 1. Create new logger class
class OrderLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('orders');
    super(logger);
  }

  logOrderCreated(orderId, userId, amount) {
    this.info('Order created', {
      type: 'order_created',
      orderId,
      userId,
      amount
    });
  }
}

// 2. Export from index.js
module.exports = {
  // ... existing exports
  orderLogger: new OrderLogger(),
  OrderLogger
};
```

## 🚨 Troubleshooting

### Common Issues
1. **Module not found**: Ensure you're importing from `../services/logging`
2. **Log files not created**: Check directory permissions for `logs/` folder
3. **No console output**: Set `NODE_ENV=development` for console logs
4. **Wrong log level**: Check `LOG_LEVEL` environment variable
