const crypto = require('crypto');

const secret = '9bba6915dd260ed50b83f75c28e779b02f912904f8cd465bd85de8bedf44cebd';

// Updated payload with settledAmountReceived: 90 and settledAmountCredited: 89.5
const payloadObject = {
  "data": {
    "merchantOrderId": "livefx_37345607e1004a79ae7b22f518c94b5b",
    "orderId": "fe8d396b-9d27-11f0-9b9d-42010a2801c2",
    "status": "completed",
    "baseAmount": 100,
    "baseCurrency": "USDT",
    "settledCurrency": "USDT",
    "networkSymbol": "BSC",
    "baseAmountReceived": 100,
    "settledAmountReceived": 90,
    "settledAmountCredited": 89.5,
    "commission": 0.5,
    "depositAddress": "0xfFaea3Ade6E8031534E537a58Eaa9Df5c59CEA4b",
    "transactions": [
      {
        "transactionHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "blockNumber": 12345678,
        "confirmations": 12
      }
    ],
    "confirmedAt": "2025-09-29T11:35:00Z",
    "expiresAt": "2025-09-29T12:32:34Z"
  }
};

// This simulates what the rawBodyMiddleware does: JSON.stringify(req.body)
const rawBody = JSON.stringify(payloadObject);
const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

console.log('=== WEBHOOK TEST ===');
console.log('Signature:', signature);
console.log('Raw body length:', rawBody.length);
console.log('Raw body:', rawBody);

console.log('\n=== EXPECTED BEHAVIOR ===');
console.log('- Status "completed" will be mapped to "COMPLETED"');
console.log('- User wallet will be credited with settledAmountReceived: 90 USDT');
console.log('- baseAmountReceived (100) is for record keeping only');
console.log('- settledAmountReceived (90) is what gets credited to wallet');
console.log('- settledAmountCredited (89.5) is after commission deduction');
console.log('- This matches the actual merchant order: livefx_37345607e1004a79ae7b22f518c94b5b');

console.log('\n=== CURL COMMAND ===');
console.log(`curl -X POST http://localhost:3000/api/crypto-payments/webhook \\
  -H "Content-Type: application/json" \\
  -H "X-TLP-SIGNATURE: ${signature}" \\
  -d '${rawBody}'`);
