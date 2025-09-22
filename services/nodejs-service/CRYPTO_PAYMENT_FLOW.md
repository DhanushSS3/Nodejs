# 🔐 Crypto Payment Gateway Flow Documentation

## 📋 **Overview**

The LiveFXHub crypto payment system integrates with **Tylt Payment Gateway** to enable cryptocurrency deposits for live users. This document provides a comprehensive breakdown of the entire payment flow, logging mechanisms, and technical implementation.

## 🏗️ **System Architecture**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend UI   │───▶│  Node.js API    │───▶│  Tylt Gateway   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │                         │
                              ▼                         │
                    ┌─────────────────┐                 │
                    │   Database      │                 │
                    │   (MySQL)       │                 │
                    └─────────────────┘                 │
                              ▲                         │
                              │                         │
                    ┌─────────────────┐                 │
                    │   Redis Cache   │                 │
                    └─────────────────┘                 │
                              ▲                         │
                              │                         │
                    ┌─────────────────┐◀────────────────┘
                    │   Webhook       │
                    │   Handler       │
                    └─────────────────┘
```

## 🔄 **Complete Payment Flow**

### **Step 1: User Initiates Deposit Request**
```http
POST /api/crypto-payments/deposit
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "baseAmount": "100.00",
  "baseCurrency": "USD",
  "settledCurrency": "USD", 
  "networkSymbol": "TRC20",
  "customerName": "John Doe",
  "comments": "Deposit for trading"
}
```

**What Happens:**
- ✅ JWT authentication validates user
- ✅ Request validation (amount, currency, network)
- ✅ User ID extracted from JWT token
- ✅ Comprehensive logging of user request

### **Step 2: Generate Merchant Order ID**
```javascript
// Unique order ID generation
const merchantOrderId = CryptoPayment.generateMerchantOrderId();
// Format: LFXH_YYYYMMDD_HHMMSS_RANDOM
// Example: LFXH_20241221_143052_A7B9C2
```

### **Step 3: Prepare Tylt API Request**
```javascript
const requestBody = {
  merchantOrderId: "LFXH_20241221_143052_A7B9C2",
  baseAmount: 100.00,
  baseCurrency: "USD",
  settledCurrency: "USD",
  networkSymbol: "TRC20",
  callBackUrl: "https://api.livefxhub.com/api/crypto-payments/webhook",
  settleUnderpayment: 1,
  customerName: "John Doe",
  comments: "Deposit for trading"
};
```

**Security Implementation:**
```javascript
// HMAC-SHA256 signature generation
const signature = crypto.createHmac('sha256', TLP_API_SECRET)
                       .update(JSON.stringify(requestBody))
                       .digest('hex');

const headers = {
  'X-TLP-APIKEY': process.env.TLP_API_KEY,
  'X-TLP-SIGNATURE': signature,
  'Content-Type': 'application/json'
};
```

### **Step 4: Call Tylt API**
```http
POST https://api.tylt.money/transactions/merchant/createPayinRequest
X-TLP-APIKEY: your_api_key
X-TLP-SIGNATURE: hmac_signature
Content-Type: application/json

{...requestBody}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "orderId": "TYL_789123456",
    "paymentURL": "https://pay.tylt.money/payment/LFXH_20241221_143052_A7B9C2",
    "depositAddress": "TQn9Y2khEsLMWD5uP...",
    "expiresAt": "2024-12-21T15:30:52.000Z",
    "settledAmountRequested": 100.00,
    "commission": 2.50
  }
}
```

### **Step 5: Database Record Creation**
```sql
INSERT INTO crypto_payments (
  userId, merchantOrderId, orderId, baseAmount, baseCurrency,
  settledCurrency, networkSymbol, status, transactionDetails,
  settledAmountRequested, commission, created_at, updated_at
) VALUES (
  12345, 'LFXH_20241221_143052_A7B9C2', 'TYL_789123456', 100.00, 'USD',
  'USD', 'TRC20', 'PENDING', '{"tyltResponse": {...}}',
  100.00, 2.50, NOW(), NOW()
);
```

### **Step 6: Return Payment URL to Frontend**
```json
{
  "status": true,
  "message": "PaymentUrl Generated Successfully",
  "data": {
    "paymentUrl": "https://pay.tylt.money/payment/LFXH_20241221_143052_A7B9C2",
    "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
    "expiresAt": "2024-12-21T15:30:52.000Z"
  }
}
```

### **Step 7: User Completes Payment**
- User redirected to Tylt payment page
- User sends cryptocurrency to provided address
- Tylt monitors blockchain for transaction confirmation

### **Step 8: Webhook Notification**
```http
POST https://api.livefxhub.com/api/crypto-payments/webhook
X-TLP-SIGNATURE: webhook_hmac_signature
Content-Type: application/json

{
  "data": {
    "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
    "orderId": "TYL_789123456",
    "status": "completed",
    "baseAmount": "100.00",
    "baseAmountReceived": "100.00",
    "settledAmount": "100.00",
    "settledAmountReceived": "100.00",
    "settledAmountCredited": "97.50",
    "commission": "2.50",
    "network": "TRC20",
    "depositAddress": "TQn9Y2khEsLMWD5uP...",
    "transactions": [
      {
        "transactionHash": "0xabc123...",
        "confirmations": 12,
        "timestamp": "2024-12-21T14:45:30.000Z"
      }
    ]
  }
}
```

### **Step 9: Webhook Processing**
1. **Signature Validation**
   ```javascript
   const calculatedSignature = crypto.createHmac('sha256', TLP_API_SECRET)
                                    .update(rawRequestBody)
                                    .digest('hex');
   const isValid = (calculatedSignature === receivedSignature);
   ```

2. **Payment Status Update**
   ```sql
   UPDATE crypto_payments SET
     status = 'COMPLETED',
     baseAmountReceived = 100.00,
     settledAmountReceived = 100.00,
     settledAmountCredited = 97.50,
     commission = 2.50,
     transactionDetails = JSON_SET(transactionDetails, '$.webhookData', ?)
   WHERE merchantOrderId = 'LFXH_20241221_143052_A7B9C2';
   ```

3. **Wallet Credit**
   ```sql
   -- Update user wallet
   UPDATE live_users SET
     wallet_balance = wallet_balance + 100.00
   WHERE id = 12345;
   
   -- Create transaction record
   INSERT INTO user_transactions (
     transaction_id, user_id, user_type, type, amount,
     balance_before, balance_after, status, reference_id,
     notes, metadata, created_at
   ) VALUES (
     'TXN_20241221_143055_X9Y8Z7', 12345, 'live', 'deposit', 100.00,
     500.00, 600.00, 'completed', 'LFXH_20241221_143052_A7B9C2',
     'Crypto deposit via Tylt - completed',
     '{"paymentGateway": "tylt", "orderId": "TYL_789123456", ...}',
     NOW()
   );
   ```

4. **Redis Cache Update**
   ```javascript
   await redisUserCache.updateUser('live', 12345, {
     wallet_balance: 600.00
   });
   ```

## 📊 **Comprehensive Logging System**

### **Log Types and Locations**

| **Log Type** | **File Location** | **Purpose** |
|--------------|-------------------|-------------|
| **Deposit Requests** | `logs/cryptoPayments.log` | User deposit initiation |
| **API Communications** | `logs/cryptoPayments.log` | Tylt API requests/responses |
| **Webhook Processing** | `logs/cryptoPayments.log` | Payment status updates |
| **WebSocket Flow** | `logs/cryptoPayments.log` | Complete flow tracking |
| **Error Logs** | `logs/cryptoPayments.log` | All error scenarios |

### **Sample Log Entries**

#### **1. Deposit Request Log**
```json
{
  "level": "info",
  "message": "Deposit request received",
  "type": "deposit_request",
  "userId": 12345,
  "requestData": {
    "baseAmount": "100.00",
    "baseCurrency": "USD",
    "settledCurrency": "USD",
    "networkSymbol": "TRC20",
    "customerName": "John Doe",
    "comments": "Deposit for trading"
  },
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "timestamp": "2024-12-21T14:30:52.123Z"
}
```

#### **2. Outgoing API Request Log**
```json
{
  "level": "info",
  "message": "Outgoing API request to Tylt",
  "type": "outgoing_request",
  "direction": "OUTBOUND",
  "method": "POST",
  "url": "https://api.tylt.money/transactions/merchant/createPayinRequest",
  "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
  "userId": 12345,
  "headers": {
    "X-TLP-APIKEY": "***REDACTED***",
    "X-TLP-SIGNATURE": "***REDACTED***",
    "Content-Type": "application/json",
    "User-Agent": "LiveFXHub-CryptoGateway/1.0"
  },
  "requestBody": {
    "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
    "baseAmount": 100.00,
    "baseCurrency": "USD",
    "settledCurrency": "USD",
    "networkSymbol": "TRC20",
    "callBackUrl": "https://api.livefxhub.com/api/crypto-payments/webhook",
    "settleUnderpayment": 1,
    "customerName": "John Doe",
    "comments": "Deposit for trading"
  },
  "timestamp": "2024-12-21T14:30:52.456Z",
  "requestSize": 312
}
```

#### **3. Incoming API Response Log**
```json
{
  "level": "info",
  "message": "Incoming API response from Tylt",
  "type": "incoming_response",
  "direction": "INBOUND",
  "statusCode": 200,
  "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
  "userId": 12345,
  "responseTime": "1247ms",
  "headers": {
    "content-type": "application/json",
    "content-length": "456",
    "server": "nginx/1.18.0"
  },
  "responseBody": {
    "success": true,
    "message": "Payment URL generated successfully",
    "data": {
      "orderId": "TYL_789123456",
      "paymentURL": "https://pay.tylt.money/payment/LFXH_20241221_143052_A7B9C2",
      "depositAddress": "TQn9Y2khEsLMWD5uP...",
      "expiresAt": "2024-12-21T15:30:52.000Z",
      "settledAmountRequested": 100.00,
      "commission": 2.50
    },
    "error": null
  },
  "timestamp": "2024-12-21T14:30:53.703Z",
  "responseSize": 456
}
```

#### **4. Complete WebSocket Flow Log**
```json
{
  "level": "info",
  "message": "WebSocket communication flow",
  "type": "websocket_flow",
  "flowId": "flow_1703174252123_a7b9c2d4e5",
  "userId": 12345,
  "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
  "userRequestedAmount": 100.00,
  "userRequestedCurrency": "USD",
  "flow": {
    "step1_user_request": {
      "timestamp": "2024-12-21T14:30:52.123Z",
      "amount": 100.00,
      "currency": "USD",
      "network": "TRC20",
      "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "ip": "192.168.1.100"
    },
    "step2_api_request": {
      "timestamp": "2024-12-21T14:30:52.456Z",
      "endpoint": "https://api.tylt.money/transactions/merchant/createPayinRequest",
      "method": "POST",
      "requestSize": 312
    },
    "step3_api_response": {
      "timestamp": "2024-12-21T14:30:53.703Z",
      "statusCode": 200,
      "responseTime": "1247ms",
      "responseSize": 456,
      "success": true
    },
    "step4_user_response": {
      "timestamp": "2024-12-21T14:30:53.890Z",
      "paymentUrl": "https://pay.tylt.money/payment/LFXH_20241221_143052_A7B9C2",
      "expiresAt": "2024-12-21T15:30:52.000Z"
    }
  },
  "totalFlowTime": "1767ms",
  "success": true
}
```

#### **5. Webhook Processing Log**
```json
{
  "level": "info",
  "message": "Webhook processing details",
  "type": "webhook_processing",
  "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
  "orderId": "TYL_789123456",
  "webhookReceived": {
    "timestamp": "2024-12-21T14:45:30.123Z",
    "ip": "52.74.223.119",
    "userAgent": "Tylt-Webhook/1.0",
    "signature": "a7b9c2d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "signatureValid": true
  },
  "paymentDetails": {
    "status": "completed",
    "baseAmount": "100.00",
    "baseAmountReceived": "100.00",
    "settledAmount": "100.00",
    "settledAmountReceived": "100.00",
    "settledAmountCredited": "97.50",
    "commission": "2.50",
    "network": "TRC20",
    "depositAddress": "TQn9Y2khEsLMWD5uP...",
    "transactions": [
      {
        "transactionHash": "0xabc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
        "confirmations": 12,
        "timestamp": "2024-12-21T14:45:30.000Z"
      }
    ]
  },
  "processing": {
    "databaseUpdateSuccess": true,
    "walletCreditSuccess": true,
    "walletCreditAmount": 100.00,
    "previousWalletBalance": 500.00,
    "newWalletBalance": 600.00,
    "transactionId": "TXN_20241221_143055_X9Y8Z7",
    "processingTime": "234ms"
  },
  "timestamp": "2024-12-21T14:45:30.357Z"
}
```

## 🔍 **Log Analysis and Monitoring**

### **Key Metrics to Monitor**

1. **Response Times**
   - API request/response times
   - Total flow completion time
   - Webhook processing time

2. **Success Rates**
   - Payment URL generation success rate
   - Webhook signature validation rate
   - Wallet credit success rate

3. **Error Patterns**
   - Failed API calls
   - Invalid signatures
   - Database transaction failures

### **Log Filtering Examples**

```bash
# Filter by user ID
grep '"userId": 12345' logs/cryptoPayments.log

# Filter by merchant order ID
grep '"merchantOrderId": "LFXH_20241221_143052_A7B9C2"' logs/cryptoPayments.log

# Filter by log type
grep '"type": "webhook_processing"' logs/cryptoPayments.log

# Filter by errors
grep '"level": "error"' logs/cryptoPayments.log

# Filter by specific amount
grep '"userRequestedAmount": 100.00' logs/cryptoPayments.log
```

## 🚨 **Error Scenarios and Handling**

### **1. API Communication Errors**
```json
{
  "level": "error",
  "message": "WebSocket error in payment_creation",
  "type": "websocket_error",
  "stage": "payment_creation",
  "error": {
    "message": "Payment gateway error: Insufficient funds in merchant account",
    "stack": "Error: Payment gateway error...",
    "name": "PaymentGatewayError"
  },
  "context": {
    "userId": 12345,
    "merchantOrderId": "LFXH_20241221_143052_A7B9C2",
    "requestedAmount": 100.00,
    "timestamp": "2024-12-21T14:30:52.789Z"
  }
}
```

### **2. Webhook Signature Validation Failures**
```json
{
  "level": "warn",
  "message": "Signature validation failed",
  "type": "signature_validation_failure",
  "receivedSignature": "invalid_signature_here",
  "expectedSignature": "a7b9c2d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "rawBodyLength": 456,
  "rawBodyPreview": "{\"data\":{\"merchantOrderId\":\"LFXH_20241221_143052_A7B9C2\"...",
  "ip": "192.168.1.100",
  "userAgent": "Unknown-Webhook/1.0"
}
```

## 🛠️ **Technical Implementation Details**

### **Database Schema**

```sql
CREATE TABLE crypto_payments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL,
  merchantOrderId VARCHAR(50) UNIQUE NOT NULL,
  orderId VARCHAR(50),
  baseAmount DECIMAL(18,6) NOT NULL,
  baseCurrency VARCHAR(10) NOT NULL,
  settledCurrency VARCHAR(10) NOT NULL,
  networkSymbol VARCHAR(20) NOT NULL,
  status ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'UNDERPAYMENT', 'OVERPAYMENT', 'FAILED', 'CANCELLED') DEFAULT 'PENDING',
  baseAmountReceived DECIMAL(18,6),
  settledAmountReceived DECIMAL(18,6),
  settledAmountCredited DECIMAL(18,6),
  commission DECIMAL(18,6),
  transactionDetails JSON,
  settledAmountRequested DECIMAL(18,6),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_userId (userId),
  INDEX idx_merchantOrderId (merchantOrderId),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
);
```

### **Environment Variables**

```env
# Tylt API Configuration
TLP_API_KEY=your_tylt_api_key_here
TLP_API_SECRET=your_tylt_api_secret_here
TLP_CALLBACK_URL=https://api.livefxhub.com/api/crypto-payments/webhook

# Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_NAME=livefxhub
DB_USER=your_db_user
DB_PASS=your_db_password

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
```

### **Security Considerations**

1. **HMAC Signature Validation**
   - All API requests and webhooks use HMAC-SHA256 signatures
   - Signatures are validated on both outgoing and incoming messages

2. **JWT Authentication**
   - All user requests require valid JWT tokens
   - User ID extracted from token, not request body

3. **Input Validation**
   - All amounts validated as positive numbers
   - Currency codes validated against allowed list
   - Network symbols validated

4. **Rate Limiting**
   - API endpoints protected against abuse
   - Per-user rate limiting implemented

## 📈 **Performance Optimization**

### **Database Optimizations**
- Indexed columns for fast lookups
- JSON fields for flexible transaction details storage
- Connection pooling for concurrent requests

### **Redis Caching**
- User wallet balances cached for fast access
- Payment status cached during processing
- Session management for authenticated users

### **Logging Optimizations**
- Structured JSON logging for easy parsing
- Log rotation to manage disk space
- Separate log files for different components

## 🔄 **Status Flow Diagram**

```
PENDING ──────┐
              │
              ▼
         PROCESSING ──┬──▶ COMPLETED ──▶ [Wallet Credit]
                      │
                      ├──▶ UNDERPAYMENT ──▶ [Partial Credit]
                      │
                      ├──▶ OVERPAYMENT ──▶ [Full Credit]
                      │
                      ├──▶ FAILED ──▶ [No Credit]
                      │
                      └──▶ CANCELLED ──▶ [No Credit]
```

## 🎯 **Monitoring and Alerts**

### **Key Performance Indicators (KPIs)**

1. **Payment Success Rate**: > 95%
2. **Average Response Time**: < 2 seconds
3. **Webhook Processing Time**: < 500ms
4. **Database Transaction Success**: > 99.9%

### **Alert Conditions**

- Payment success rate drops below 90%
- Response time exceeds 5 seconds
- More than 5 signature validation failures per hour
- Database connection failures

## 📞 **Support and Troubleshooting**

### **Common Issues**

1. **"Invalid signature" errors**
   - Check API secret configuration
   - Verify request body encoding
   - Ensure no modifications to raw body

2. **"Payment not found" errors**
   - Verify merchant order ID format
   - Check database connectivity
   - Confirm payment record creation

3. **Wallet credit failures**
   - Check user existence
   - Verify transaction amounts
   - Review Redis cache status

### **Debug Commands**

```bash
# Check recent payments
tail -f logs/cryptoPayments.log | grep "type.*deposit_request"

# Monitor webhook processing
tail -f logs/cryptoPayments.log | grep "webhook_processing"

# Check for errors
tail -f logs/cryptoPayments.log | grep "level.*error"
```

---

**📝 Last Updated**: December 21, 2024  
**🔧 Version**: 1.0  
**👨‍💻 Maintained by**: LiveFXHub Development Team
