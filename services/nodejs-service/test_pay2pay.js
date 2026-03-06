const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const domain = 'https://uat-api.pay2pay.vn';
const username = 'm313user1';
const passwordRaw = 'Lkj@asd@123';
const tenant = 'LIVEHUBFX';

const hexHash = crypto.createHash('sha256').update(username + passwordRaw, 'utf8').digest('hex');
const passwordHashed = Buffer.from(hexHash).toString('base64');

async function testLogin(sigType) {
    const requestId = crypto.randomUUID();

    // YYYYMMDDHHMMSS UTC+7
    const now = new Date();
    const utc7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const requestTime = '' + utc7.getUTCFullYear() + pad(utc7.getUTCMonth() + 1) + pad(utc7.getUTCDate()) + pad(utc7.getUTCHours()) + pad(utc7.getUTCMinutes()) + pad(utc7.getUTCSeconds());

    const body = { username, password: passwordHashed };
    const bodyStr = JSON.stringify(body);

    const stringToSign = requestId + requestTime + tenant + bodyStr;

    let sigStr = '';
    if (sigType === 'none') {
        sigStr = '';
    } else if (sigType === 'hmac_secret') {
        sigStr = crypto.createHmac('sha256', '4dd105cc4af331cae1167044d739dc205578db11567a288bec').update(stringToSign, 'utf8').digest('base64');
    } else if (sigType === 'hmac_apikey') {
        sigStr = crypto.createHmac('sha256', '4b40c32a8511558aa5edc897711bdc7127036cd13406ddecf4').update(stringToSign, 'utf8').digest('base64');
    } else if (sigType === 'hmac_merchantkey') {
        sigStr = crypto.createHmac('sha256', 'b8b08c1da7279f78126e34640c557a4dc311504a513cdd1dec').update(stringToSign, 'utf8').digest('base64');
    } else if (sigType === 'rsa') {
        try {
            const pkey = fs.readFileSync('pay2pay_private.pem');
            const sign = crypto.createSign('SHA256');
            sign.update(stringToSign, 'utf8');
            sign.end();
            sigStr = sign.sign(pkey, 'base64');
        } catch (e) { console.log('RSA skipped'); return; }
    }

    const headers = {
        'Content-Type': 'application/json',
        'p-request-id': requestId,
        'p-request-time': requestTime,
        'p-tenant': tenant
    };
    if (sigStr) headers['p-signature'] = sigStr;

    try {
        const res = await axios.post(domain + '/auth-service/api/v1.0/user/login', body, { headers });
        console.log(`[SUCCESS] ${sigType} ->`, res.data);
    } catch (e) {
        console.log(`[FAIL] ${sigType} ->`, e.response ? e.response.status + ' ' + JSON.stringify(e.response.data) : e.message);
    }
}

async function run() {
    await testLogin('none');
    console.log('---');
    await testLogin('hmac_secret');
    console.log('---');
    await testLogin('hmac_apikey');
    console.log('---');
    await testLogin('hmac_merchantkey');
    console.log('---');
    await testLogin('rsa');
}

run();
