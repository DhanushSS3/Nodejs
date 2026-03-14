const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// --- UAT CREDENTIALS ---
const BASE_URL = 'https://uat-api.pay2pay.vn';
const TENANT = 'LIVEHUBFX';
const USERNAME = 'm303user1';
const LOGIN_PASSWORD = 'Lkj@asd@123';

// Replace this with your actual full raw passcode (from PAY2PAY_PAYOUT_PASSCODE_RAW)
const TRANSFER_PASSCODE = '359135';

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCsvRW+aNq5SiHz
x5GlqtYqh71vS3ccXpAuUVRDC20yA1faehZ9R2eSfIENFAI9rVUMxBS5/+2lyNfC
NLC6Ssyzq9jj8Nu+CgDdFFGGcpnNjIsPxppdsKaOc8vmuQy6o1oOz0CHIkGQrBli
GbsBNVeil1JwbAmfCfAbpgm203PJuPaXJoM3Y4KwtB4wUZQOe5vrW7zGzghSVsgL
2QkWtLokyLdlXns4mIUJI5mesb8SpGRWMoz/SJT4HpdBJ0JzABWNgkpQPayyR9Dw
iiVYP/pc3BGKVWZFFSbgu8CjjzPz124p/BvLeuX9YIgyGyOrMuO9oDiICKvM6TVP
jiuxggpDAgMBAAECggEAAXlkj5MPgs5ixhnB/l/g8gfSEnCzINc81mI0Erzd/wKU
cqtq/ZAaXVXBS+MzIp6KJzMzCwHKOJNKw3sm3gn9OqCL+lB86XNI3dU5QEbfy3Yi
Sf63X55lomr6ukW9QRI0R9yJZ0ok3FVLqxWpSPuV8aX6CUoywA2QMqOX46FRReLl
mMTIVUhaDh196KOoBRB8X1kMXZoluD1yZNr+YUc2k1yS6Zem/AJIEEMkDM0w43ai
VENm5uFBfyDC5xmAplo7kysLf9PFMsOHLunI8FgVdNG/LP967J2iHBP9FqGroTmq
ux4O4ujiwR2Zrx/zKwmVugsJFzdLKGjlBQIXFPb9SQKBgQDxhm6orhILTrWwKdnt
//2UHF/9b3tKBDnqbmsX1YxdbVlchKU4RbpndUj6Jgfg2uYqHuBdyOHl//7CN8xD
pdjfIZ9371iC97bwCLliz2f//W1NwKd4PZ+4MERrs0YMWypOawt8eiGShuCqfmXB
98FcNuk3f88e4AFOSPsLKLNQ5wKBgQC3F034gQwynk1JGiL83g+F0zEdFb3gPqaF
mLXM75cNw0RYg1/QkitdX2fXcZ4A/FqTuj5AVekrXFmhWAlkMolfHWeRlU15RDcN
EOsOzqbHFVTskf8V4FVgqu27UoWX7HEmJZkyv/jnO1Pyfr8kIJjJ/m0uZ/3gk0/R
K6tYLHVkRQKBgQCV7SdAGl4lGsT6B+C6NtBIYpzLi6pytdDlz4k3EF7DmB+CqOyO
0+n0Uv/sGDOHxxpdRzFrxklEJvcTxONNkuPfDtYY80B0fCTZN/EsfydF5yE0xMSw
hUBia8PtPynafbTzXMuSh5XTiVppO3EbSRqEjamTxAjkV5U37WG4+ZjmPQKBgQCp
/FsJs1ZN0KdUjY2aU9j5mIBqznrBLamRM5zmrjMCNh7IRwC4Nl1IjYFthzD5HVJD
AZE2TgzzkwQsRf5CJqFfy38SrRmG0wyBdwmlb7tr7qQwF8RK3UKnQ0sAtbcOvBi5
IANCGPXQSUbBR2fS9Oil8TAQ+7+7t0lNnEuyy2QaOQKBgC/SNOXdrYl9Spx0y90B
EAvmPanDf7nbPixxxUTbCzZq1KT/eFm5eOYQUQW9ZNHbZHbe2NpuOVWiwa7Qs3Jc
RnFHnpCMDgHw7NCAWG5HleJ8RWzRDp3A4O0L9prfBPnZWUyGn98+zbk6PpO6Iyv9
G7ElEqMT7S7S0k1IDop8ePFW
-----END PRIVATE KEY-----`;

// --- UTILITIES ---

function getUTC7Time() {
    const now = new Date();
    const utc7 = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return utc7.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function generateAuthHash(username, rawValue) {
    // Pay2Pay specifies the passcode is SHA256(username + raw Passcode) [cite: 916]
    // The link provided in docs points to hex -> base64 encoding [cite: 916]
    const hashHex = crypto.createHash('sha256').update(username + rawValue).digest('hex');
    return Buffer.from(hashHex).toString('base64');
}

function generateSignature(headers, bodyStr) {
    // 1. Filter and sort headers alphabetically (force lowercase for safe sorting) [cite: 351]
    const keysToSign = Object.keys(headers)
        .filter(k => {
            const lowerK = k.toLowerCase();
            return lowerK.startsWith('p-') || lowerK === 'authorization' || lowerK === 'verification';
        })
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    // 2. Concatenate header values [cite: 351]
    let headerString = '';
    for (const key of keysToSign) {
        headerString += headers[key];
    }

    // 3. Combine with request body and sign [cite: 352]
    const stringToSign = headerString + bodyStr;

    console.log("\n--- SIGNATURE DEBUG ---");
    console.log("Sorted Header String:", headerString);
    console.log("String to Sign:", stringToSign);
    console.log("-----------------------\n");

    const sign = crypto.createSign('SHA256');
    sign.update(stringToSign);
    sign.end();
    return sign.sign(PRIVATE_KEY, 'base64');
}

// --- MAIN FLOW ---

async function runTest() {
    try {
        console.log("=== STEP 1: LOGIN ===");
        const loginUrl = `${BASE_URL}/auth-service/api/v1.0/user/login`;

        const loginBody = {
            username: USERNAME,
            password: generateAuthHash(USERNAME, LOGIN_PASSWORD)
        };
        const loginBodyStr = JSON.stringify(loginBody);

        const loginHeaders = {
            'p-request-id': uuidv4(),
            'p-request-time': getUTC7Time(),
            'p-tenant': TENANT,
            'Content-Type': 'application/json'
        };
        loginHeaders['p-signature'] = generateSignature(loginHeaders, loginBodyStr);

        const loginRes = await axios.post(loginUrl, loginBodyStr, { headers: loginHeaders });
        const accessToken = loginRes.data.data.accessToken;
        console.log("✅ Login Successful! Access Token Retrieved.\n");

        console.log("=== STEP 2: IMPLORE-AUTH ===");
        const imploreUrl = `${BASE_URL}/auth-service/api/v1.0/implore-auth`; // [cite: 904]

        // The exact payload required for implore-auth [cite: 969, 970, 971]
        const imploreBody = {
            phone: USERNAME,
            api: "/merchant-transaction-service/api/v2.0/transfer_247",
            authMode: "PASSCODE",
            authValue: generateAuthHash(USERNAME, TRANSFER_PASSCODE)
        };
        const imploreBodyStr = JSON.stringify(imploreBody);

        const imploreHeaders = {
            'authorization': `Bearer ${accessToken}`, // Lowercase 'a' to force proper alphabetical sorting in our script [cite: 351]
            'p-request-id': uuidv4(),
            'p-request-time': getUTC7Time(),
            'p-tenant': TENANT,
            'Content-Type': 'application/json'
        };

        imploreHeaders['p-signature'] = generateSignature(imploreHeaders, imploreBodyStr);

        const imploreRes = await axios.post(imploreUrl, imploreBodyStr, { headers: imploreHeaders });

        console.log("✅ Implore-Auth Successful!");
        console.log("🔑 Verified Key:", imploreRes.data.data.verifiedKey); // [cite: 978]

    } catch (error) {
        console.error("\n❌ !!! ERROR !!!");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", error.response.data);

            if (error.response.status === 401 && error.config.url.includes('implore-auth')) {
                console.log("\n[DIAGNOSIS]: The 401 occurred on implore-auth. The passcode or the signature string is mismatched.");
            }
        } else {
            console.error(error.message);
        }
    }
}

runTest();