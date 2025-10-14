const crypto = require('crypto');

const secret = '9bba6915dd260ed50b83f75c28e779b02f912904f8cd465bd85de8bedf44cebd';

// This is exactly what your middleware does: JSON.stringify(req.body)
const payloadObject = {
  "data": {
    "merchantOrderId": "livefx_a334fc1db6d941ff83a3bda37d88a71d",
    "orderId": "fac12dc5-9d20-11f0-9b9d-42010a2801c2",
    "status": "UnderPaymenT",
    "baseAmount": 100,
    "baseCurrency": "USDT",
    "settledCurrency": "USDT",
    "networkSymbol": "BSC",
    "baseAmountReceived": 100,
    "settledAmountReceived": 90,
    "settledAmountCredited": 89.5,
    "commission": 0.5,
    "depositAddress": "0xfc951fC62249384cDa8810309664BbF0EaB938e9",
    "transactions": [
      {
        "transactionHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "blockNumber": 12345678,
        "confirmations": 12
      }
    ],
    "confirmedAt": "2025-09-29T10:45:00Z",
    "expiresAt": "2025-09-29T11:42:21Z"
  }
};

// This simulates what the rawBodyMiddleware does: JSON.stringify(req.body)
const rawBody = JSON.stringify(payloadObject);
const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

console.log('=== WEBHOOK TEST ===');
console.log('Signature:', signature);
console.log('Raw body length:', rawBody.length);
console.log('Raw body:', rawBody);
console.log('\n=== CURL COMMAND ===');
console.log(`curl -X POST http://localhost:3000/api/crypto-payments/webhook \\
  -H "Content-Type: application/json" \\
  -H "X-TLP-SIGNATURE: ${signature}" \\
  -d '${rawBody}'`);
