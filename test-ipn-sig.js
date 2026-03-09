const crypto = require('crypto');

const secretKey = "4dd105cc4af331cae1167044d739dc205578db11567a288bec";
const rawJson = '{"merchantId":"PP0000303","orderId":"lfxpay_836af51a8ad749eb9831499c2322","txnId":"202603090407526","amount":100000,"code":"SUCCESS","status":"SUCCESS","message":"Giao dịch đã thành công theo cách thủ công","txnDate":"20260309153446","secretSenderBankRefNumber":"","senderBankRefName":null,"senderBankId":null,"senderBankName":null,"senderBinCode":null,"receiverBankId":"MB","receiverBankRefName":"LIVEHUBFX","receiverBankRefNumber":"MBB55783640408019"}';
const receivedSignature = "z3vy41F3qtCBXaHQW/1sKVKyzNZMNJd6tMi1mTF6Vmo=";

console.log("=== Strategy 13: Raw JSON string + Secret Key ===");

// Strategy 13: Just hash exactly what was posted on identical bytes
const stringToSign = rawJson + secretKey;
const computed = crypto.createHash('sha256').update(stringToSign, 'utf8').digest('base64');
console.log("Computed:", computed, computed === receivedSignature ? 'MATCH!' : 'NO MATCH');

// Let's also look at the API key in headers they sent:
// 'p-api-key': '4b40c32a8511558aa5edc897711bdc7127036cd13406ddecf4'
// Our env PAY2PAY_API_KEY is: 4b40c32a... (matches)
// But our IPN SECRET KEY is: 4dd105cc... 
// Wait, what if they are hashing using the API KEY instead of the SECRET KEY?
// "Signature generate from whole request body & secret key"
// Some gateways say "secret key" but mean the merchant API key

const stringToSign14 = rawJson + "4b40c32a8511558aa5edc897711bdc7127036cd13406ddecf4";
const computed14 = crypto.createHash('sha256').update(stringToSign14, 'utf8').digest('base64');
console.log("Strategy 14 (Raw JSON + API Key):", computed14 === receivedSignature ? 'MATCH!' : 'NO MATCH');

// What if they are hashing with the Merchant Key?
const merchantKey = "b8b08c1da7279f78126e34640c557a4dc311504a513cdd1dec";
const stringToSign15 = rawJson + merchantKey;
const computed15 = crypto.createHash('sha256').update(stringToSign15, 'utf8').digest('base64');
console.log("Strategy 15 (Raw JSON + Merchant Key):", computed15 === receivedSignature ? 'MATCH!' : 'NO MATCH');

// Let's try Strategy 2 (Object.values string concatenation) with the other keys
const obj = JSON.parse(rawJson);
const joinedValues = Object.values(obj).join('');
const c16 = crypto.createHash('sha256').update(joinedValues + merchantKey, 'utf8').digest('base64');
console.log("Strategy 16 (Object values + Merchant Key):", c16 === receivedSignature ? 'MATCH!' : 'NO MATCH');

// Let's try the EXACT formatting of Step 2 in the PDF, which converts amount int -> string and strips spaces in message
const objConverted = {};
for (const [k, v] of Object.entries(obj)) {
    if (v === null) continue; // drop nulls? The PDF example doesn't show any null fields

    // Convert int to string
    if (typeof v === 'number') {
        objConverted[k] = String(v);
    }
    // Strip space from string
    else if (typeof v === 'string') {
        objConverted[k] = v.replace(/ /g, '');
    } else {
        objConverted[k] = v;
    }
}
const stringToSign17 = JSON.stringify(objConverted) + secretKey;
const computed17 = crypto.createHash('sha256').update(stringToSign17, 'utf8').digest('base64');
console.log("Strategy 17 (PDF exact parsing + Secret Key):", computed17 === receivedSignature ? 'MATCH!' : 'NO MATCH');

// Is there any chance that utf8 is not the encoding they are hashing, but latin1 or ascii?
// Vietnamese characters: 'Giao dịch đã thành công theo cách thủ công'
// Let's check the length of this string
console.log("UTF8 Length of rawJson:", Buffer.from(rawJson, 'utf8').length);

const c18 = crypto.createHash('sha256').update(Buffer.from(stringToSign, 'utf8')).digest('base64');
console.log("Strategy 18:", c18 === receivedSignature ? 'MATCH!' : 'NO MATCH');
