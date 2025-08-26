// Get the request body
const requestBody = JSON.stringify(pm.request.body.toJSON().raw ? JSON.parse(pm.request.body.toJSON().raw) : {});

// Your TLP API Secret (replace with actual secret from .env)
const apiSecret = "your_tlp_api_secret_here";

// Create HMAC SHA256 signature
const signature = CryptoJS.HmacSHA256(requestBody, apiSecret).toString(CryptoJS.enc.Hex);

// Set the signature in headers
pm.request.headers.add({
    key: 'X-TLP-SIGNATURE',
    value: signature
});

console.log('Request Body:', requestBody);
console.log('Generated Signature:', signature);