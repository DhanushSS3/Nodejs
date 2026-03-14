'use strict';

/**
 * Pay2Pay Token Service
 *
 * Manages JWT authentication with Pay2Pay:
 * - Logs in with RSA-2048 signed headers + SHA-256-hashed password
 * - Caches accessToken and refreshToken in memory
 * - Auto-refreshes at 80% of TTL (480 of 600 seconds)
 * - Provides buildRequestHeaders() to generate all required p-* signed headers
 */

const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger.service');
const pay2payLogger = require('./logging/Pay2PayLogger');

// ─── Configuration ───────────────────────────────────────────────────────────

function getDomain() {
    return (process.env.PAY2PAY_DOMAIN || 'https://api.pay2pay.vn').replace(/\/$/, '');
}

function getTenant() {
    return process.env.PAY2PAY_TENANT || 'MERCHANT-WEB';
}

function getPrivateKey() {
    const key = process.env.PAY2PAY_PRIVATE_KEY || '';
    if (!key) return null;
    // Support "\n" literal in env vars
    return key.replace(/\\n/g, '\n');
}

function getUsername() {
    return process.env.PAY2PAY_USERNAME || '';
}

function getRawPassword() {
    return process.env.PAY2PAY_PASSWORD_RAW || '';
}

// ─── Password Hashing ────────────────────────────────────────────────────────

/**
 * Hash password as required by Pay2Pay:
 * SHA256(username + rawPassword) in HEX format → encode as Base64
 * @param {string} username
 * @param {string} rawPassword
 * @returns {string} Base64-encoded hex string of SHA-256 hash
 */
function hashPassword(username, rawPassword) {
    const input = `${username}${rawPassword}`;
    const hexHash = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
    return Buffer.from(hexHash).toString('base64');
}

// ─── RSA Signature ───────────────────────────────────────────────────────────

/**
 * Create a Pay2Pay p-signature by sorting all relevant headers and appending the body.
 *
 * Algorithm (matches the Pay2Pay API spec):
 *   1. Collect all headers whose key (lowercase) starts with 'p-', or equals
 *      'authorization' or 'verification'.
 *   2. Sort the collected keys alphabetically (case-insensitive).
 *   3. Concatenate the VALUES of those headers in sorted order.
 *   4. Append the JSON body string.
 *   5. RSA-SHA256 sign the result → Base64.
 *
 * @param {Object} headers - The full set of request headers (before p-signature is added)
 * @param {string} bodyStr - Serialised request body (empty string '' for no body)
 * @returns {string} Base64-encoded RSA-SHA256 signature
 */
function createSignatureFromHeaders(headers, bodyStr) {
    const privateKey = getPrivateKey();

    // Step 1 & 2: filter and sort
    const keysToSign = Object.keys(headers)
        .filter((k) => {
            const lk = k.toLowerCase();
            return lk.startsWith('p-') || lk === 'authorization' || lk === 'verification';
        })
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    // Step 3: concatenate values
    let headerString = '';
    for (const key of keysToSign) {
        headerString += headers[key];
    }

    // Step 4: append body
    const stringToSign = headerString + (bodyStr || '');

    const isPem = privateKey && (
        privateKey.includes('-----BEGIN RSA PRIVATE KEY-----') ||
        privateKey.includes('-----BEGIN PRIVATE KEY-----')
    );

    if (isPem) {
        const sign = crypto.createSign('SHA256');
        sign.update(stringToSign, 'utf8');
        sign.end();
        return sign.sign(privateKey, 'base64');
    }

    // Fallback: HMAC-SHA256
    const secret = privateKey || process.env.PAY2PAY_IPN_SECRET_KEY || '';
    if (!secret) {
        throw new Error('PAY2PAY_PRIVATE_KEY is not configured. Cannot sign Pay2Pay API request.');
    }
    logger.warn('Pay2Pay: using HMAC-SHA256 fallback for p-signature (set a real RSA key for production)');
    return crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
}

/**
 * Legacy helper kept for backward compatibility.
 * For simple calls without an Authorization header the two approaches are equivalent:
 *   sorted headers = p-request-id + p-request-time + p-tenant (alphabetical)
 *                  = requestId + requestTime + tenant
 * @deprecated Prefer createSignatureFromHeaders() for new calls.
 */
function createSignature(requestId, requestTime, tenant, bodyStr) {
    const syntheticHeaders = {
        'p-request-id': requestId,
        'p-request-time': requestTime,
        'p-tenant': tenant,
    };
    return createSignatureFromHeaders(syntheticHeaders, bodyStr);
}

// ─── Time Formatting ─────────────────────────────────────────────────────────

/**
 * Get current time in Pay2Pay format: YYYYMMDDHHMMSS (UTC+7)
 * @returns {string}
 */
function getRequestTime() {
    const now = new Date();
    // UTC+7 offset = 7 * 60 * 60 * 1000
    const utc7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${utc7.getUTCFullYear()}` +
        `${pad(utc7.getUTCMonth() + 1)}` +
        `${pad(utc7.getUTCDate())}` +
        `${pad(utc7.getUTCHours())}` +
        `${pad(utc7.getUTCMinutes())}` +
        `${pad(utc7.getUTCSeconds())}`
    );
}

// ─── Token Cache ─────────────────────────────────────────────────────────────

let _accessToken = null;
let _refreshToken = null;
let _accessTokenExpiresAt = 0; // epoch ms
let _refreshTokenExpiresAt = 0;

const REFRESH_THRESHOLD_MS = 120 * 1000; // refresh 2 min before expiry

// ─── Login ───────────────────────────────────────────────────────────────────

/**
 * Log in to Pay2Pay and cache tokens.
 * @returns {Promise<string>} accessToken
 */
async function login() {
    const username = getUsername();
    const rawPassword = getRawPassword();

    if (!username || !rawPassword) {
        throw new Error('PAY2PAY_USERNAME and PAY2PAY_PASSWORD_RAW must be configured.');
    }

    const hashedPassword = hashPassword(username, rawPassword);
    const body = { username, password: hashedPassword };
    const bodyStr = JSON.stringify(body);

    const requestId = uuidv4();
    const requestTime = getRequestTime();
    const tenant = getTenant();
    const signature = createSignature(requestId, requestTime, tenant, bodyStr);

    const url = `${getDomain()}/auth-service/api/v1.0/user/login`;

    logger.info('Pay2Pay: logging in', { username, url });
    pay2payLogger.logRequest('POST /auth-service/api/v1.0/user/login', { username });

    let response;
    try {
        response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json',
                'p-request-id': requestId,
                'p-request-time': requestTime,
                'p-tenant': tenant,
                'p-signature': signature,
            },
            timeout: 15000,
        });
        pay2payLogger.logResponse('POST /auth-service/api/v1.0/user/login - SUCCESS', response.data);
    } catch (err) {
        pay2payLogger.logError('POST /auth-service/api/v1.0/user/login - FAIL', err.response ? err.response.data : err.message);
        throw err;
    }

    const data = response.data;
    if (!data || data.code !== 'SUCCESS' || !data.data || !data.data.accessToken) {
        throw new Error(`Pay2Pay login failed: ${JSON.stringify(data)}`);
    }

    const { accessToken, refreshToken, expireIn, refreshExpiresIn } = data.data;
    const now = Date.now();

    _accessToken = accessToken;
    _refreshToken = refreshToken;
    _accessTokenExpiresAt = now + (parseInt(expireIn, 10) || 600) * 1000;
    _refreshTokenExpiresAt = now + (parseInt(refreshExpiresIn, 10) || 1800) * 1000;

    logger.info('Pay2Pay: login successful', {
        accessTokenExpiry: new Date(_accessTokenExpiresAt).toISOString(),
    });

    return accessToken;
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

/**
 * Refresh the access token using the stored refresh token.
 * @returns {Promise<string>} new accessToken
 */
async function refresh() {
    if (!_refreshToken) {
        logger.info('Pay2Pay: no refresh token available, logging in fresh');
        return login();
    }

    const now = Date.now();
    if (now >= _refreshTokenExpiresAt) {
        logger.info('Pay2Pay: refresh token expired, logging in fresh');
        return login();
    }

    const body = { refreshToken: _refreshToken };
    const bodyStr = JSON.stringify(body);
    const requestId = uuidv4();
    const requestTime = getRequestTime();
    const tenant = getTenant();
    const signature = createSignature(requestId, requestTime, tenant, bodyStr);

    const url = `${getDomain()}/auth-service/api/v1.0/user/refresh`;
    pay2payLogger.logRequest('POST /auth-service/api/v1.0/user/refresh', { refreshToken: _refreshToken });

    try {
        const response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json',
                'p-request-id': requestId,
                'p-request-time': requestTime,
                'p-tenant': tenant,
                'Authorization': `Bearer ${_accessToken}`,
                'p-signature': signature,
            },
            timeout: 15000,
        });
        pay2payLogger.logResponse('POST /auth-service/api/v1.0/user/refresh - SUCCESS', response.data);

        const data = response.data;
        if (!data || data.code !== 'SUCCESS' || !data.data || !data.data.accessToken) {
            throw new Error(`Pay2Pay token refresh failed: ${JSON.stringify(data)}`);
        }

        const { accessToken, refreshToken, expireIn, refreshExpiresIn } = data.data;

        _accessToken = accessToken;
        _refreshToken = refreshToken;
        _accessTokenExpiresAt = Date.now() + (parseInt(expireIn, 10) || 600) * 1000;
        _refreshTokenExpiresAt = Date.now() + (parseInt(refreshExpiresIn, 10) || 1800) * 1000;

        logger.info('Pay2Pay: token refreshed', {
            accessTokenExpiry: new Date(_accessTokenExpiresAt).toISOString(),
        });

        return accessToken;
    } catch (err) {
        pay2payLogger.logError('POST /auth-service/api/v1.0/user/refresh - FAIL', err.response ? err.response.data : err.message);
        logger.warn('Pay2Pay: token refresh failed, logging in fresh', { error: err.message });
        return login();
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

let _tokenPromise = null;

/**
 * Get a valid access token, refreshing or logging in as needed.
 * Concurrent calls are coalesced into one request.
 * @returns {Promise<string>} valid accessToken
 */
async function getAccessToken() {
    const now = Date.now();

    // Token is still valid (with threshold buffer)
    if (_accessToken && now < _accessTokenExpiresAt - REFRESH_THRESHOLD_MS) {
        return _accessToken;
    }

    // Coalesce concurrent refresh calls
    if (_tokenPromise) return _tokenPromise;

    if (_accessToken && _refreshToken && now < _refreshTokenExpiresAt) {
        _tokenPromise = refresh().finally(() => { _tokenPromise = null; });
    } else {
        _tokenPromise = login().finally(() => { _tokenPromise = null; });
    }

    return _tokenPromise;
}

/**
 * Build all required Pay2Pay request headers for an authenticated API call.
 * Automatically obtains a valid access token.
 *
 * Signs using the header-sort method (createSignatureFromHeaders) so that
 * the Authorization value is included in the string-to-sign — required for
 * implore-auth and transfer_247 calls.
 *
 * @param {string|object} body        - request body (object or string); pass '' for GET
 * @param {Object}        extraHeaders - optional extra headers to include BEFORE signing
 *                                       (e.g. { 'verification': verifiedKey })
 * @returns {Promise<Object>} headers object ready for axios
 */
async function buildRequestHeaders(body, extraHeaders = {}) {
    const accessToken = await getAccessToken();
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const requestId = uuidv4();
    const requestTime = getRequestTime();
    const tenant = getTenant();

    // Build all signable headers first (before computing p-signature)
    const headers = {
        'Content-Type': 'application/json',
        'p-request-id': requestId,
        'p-request-time': requestTime,
        'p-tenant': tenant,
        'Authorization': `Bearer ${accessToken}`,
        ...extraHeaders,
    };

    // Compute signature over the full header set + body
    headers['p-signature'] = createSignatureFromHeaders(headers, bodyStr);

    return headers;
}

/**
 * Check if Pay2Pay is enabled (credentials configured).
 * Private key is optional — redirect flow uses Merchant Key, not RSA.
 * @returns {boolean}
 */
function isEnabled() {
    return !!(getUsername() && getRawPassword() && process.env.PAY2PAY_MERCHANT_KEY);
}

/**
 * Clear cached tokens (useful for testing or forced re-auth).
 */
function clearTokenCache() {
    _accessToken = null;
    _refreshToken = null;
    _accessTokenExpiresAt = 0;
    _refreshTokenExpiresAt = 0;
}

module.exports = {
    getDomain,
    getTenant,
    getAccessToken,
    buildRequestHeaders,
    createSignature,
    createSignatureFromHeaders,
    hashPassword,
    getRequestTime,
    isEnabled,
    clearTokenCache,
};
