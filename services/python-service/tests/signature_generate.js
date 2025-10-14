const crypto = require('crypto');

// Your TLP_API_SECRET from environment
const secret = '9bba6915dd260ed50b83f75c28e779b02f912904f8cd465bd85de8bedf44cebd';

// Method 1: Compact JSON (no spaces)
const compactPayload = '{"data":{"merchantOrderId":"livefx_a334fc1db6d941ff83a3bda37d88a71d","orderId":"fac12dc5-9d20-11f0-9b9d-42010a2801c2","status":"UnderPaymenT","baseAmount":100,"baseCurrency":"USDT","settledCurrency":"USDT","networkSymbol":"BSC","baseAmountReceived":100,"settledAmountReceived":90,"settledAmountCredited":89.5,"commission":0.5,"depositAddress":"0xfc951fC62249384cDa8810309664BbF0EaB938e9","transactions":[{"transactionHash":"0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef","blockNumber":12345678,"confirmations":12}],"confirmedAt":"2025-09-29T10:45:00Z","expiresAt":"2025-09-29T11:42:21Z"}}';

// Method 2: Pretty formatted JSON (with spaces and newlines)
const prettyPayload = `{
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
}`;

// Method 3: JSON.stringify from object (most reliable)
const payloadObj = {
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
const stringifiedPayload = JSON.stringify(payloadObj);

// Generate signatures for all three methods
const compactSignature = crypto.createHmac('sha256', secret).update(compactPayload).digest('hex');
const prettySignature = crypto.createHmac('sha256', secret).update(prettyPayload).digest('hex');
const stringifiedSignature = crypto.createHmac('sha256', secret).update(stringifiedPayload).digest('hex');

console.log('=== SIGNATURE OPTIONS ===\n');

console.log('1. COMPACT JSON SIGNATURE:');
console.log('X-TLP-SIGNATURE:', compactSignature);
console.log('Payload length:', compactPayload.length);
console.log();

console.log('2. PRETTY JSON SIGNATURE:');
console.log('X-TLP-SIGNATURE:', prettySignature);
console.log('Payload length:', prettyPayload.length);
console.log();

console.log('3. JSON.stringify() SIGNATURE (RECOMMENDED):');
console.log('X-TLP-SIGNATURE:', stringifiedSignature);
console.log('Payload length:', stringifiedPayload.length);
console.log();

console.log('=== PAYLOAD COMPARISON ===');
console.log('Compact matches stringify:', compactPayload === stringifiedPayload);
console.log('Pretty matches stringify:', prettyPayload === stringifiedPayload);
console.log();

console.log('=== USE THIS PAYLOAD IN YOUR REQUEST ===');
console.log(stringifiedPayload);