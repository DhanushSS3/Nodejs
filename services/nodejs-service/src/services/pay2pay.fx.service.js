'use strict';

/**
 * Pay2Pay FX Rate Service
 *
 * Fetches live VND/USD exchange rate from ExchangeRate-API (free, no key required).
 * Caches the rate for 1 hour. Falls back to PAY2PAY_VND_TO_USD_FALLBACK_RATE if
 * the external API is unavailable.
 *
 * Rate returned: how many USD per 1 VND (e.g. ~0.0000395)
 */

const axios = require('axios');
const logger = require('./logger.service');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FX_API_URL = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_RATE_DEFAULT = 0.0000395; // ~25,330 VND per USD

let _cachedRate = null;
let _cacheExpiresAt = 0;
let _isFetching = false;
let _fetchPromise = null;

/**
 * Fetch live USD/VND rate from ExchangeRate-API and invert to VND→USD.
 * @returns {Promise<number>} VND to USD rate
 */
async function fetchLiveRate() {
    const fallbackRate =
        parseFloat(process.env.PAY2PAY_VND_TO_USD_FALLBACK_RATE) > 0
            ? parseFloat(process.env.PAY2PAY_VND_TO_USD_FALLBACK_RATE)
            : FALLBACK_RATE_DEFAULT;

    try {
        const response = await axios.get(FX_API_URL, { timeout: 8000 });
        const data = response && response.data;

        if (!data || data.result !== 'success') {
            throw new Error(`ExchangeRate-API returned non-success: ${JSON.stringify(data)}`);
        }

        const usdPerVnd = data.rates && data.rates.VND;
        if (!usdPerVnd || usdPerVnd <= 0) {
            throw new Error('VND rate missing or invalid in ExchangeRate-API response');
        }

        // API gives: 1 USD = usdPerVnd VND → invert for VND→USD
        const vndToUsd = 1 / usdPerVnd;

        logger.info('Pay2Pay FX rate refreshed', {
            usdToVnd: usdPerVnd,
            vndToUsd,
            source: FX_API_URL,
        });

        return vndToUsd;
    } catch (err) {
        logger.warn('Pay2Pay FX rate fetch failed, using fallback', {
            error: err.message,
            fallbackRate,
        });
        return fallbackRate;
    }
}

/**
 * Get the current VND→USD rate, refreshing the cache if needed.
 * Thread-safe: concurrent callers during a refresh share the same promise.
 *
 * @returns {Promise<number>} VND to USD rate
 */
async function getVndToUsdRate() {
    const now = Date.now();

    // Serve from cache if still fresh
    if (_cachedRate !== null && now < _cacheExpiresAt) {
        return _cachedRate;
    }

    // Coalesce concurrent refresh requests
    if (_isFetching && _fetchPromise) {
        return _fetchPromise;
    }

    _isFetching = true;
    _fetchPromise = fetchLiveRate()
        .then((rate) => {
            _cachedRate = rate;
            _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
            return rate;
        })
        .finally(() => {
            _isFetching = false;
            _fetchPromise = null;
        });

    return _fetchPromise;
}

/**
 * Convert a VND amount to USD using the current live rate.
 * @param {number} vndAmount
 * @returns {Promise<{ usdAmount: number, rate: number }>}
 */
async function vndToUsd(vndAmount) {
    const rate = await getVndToUsdRate();
    const usdAmount = vndAmount * rate;
    return { usdAmount: Math.round(usdAmount * 100000) / 100000, rate };
}

/**
 * Convert USD to VND using the current live rate.
 * @param {number} usdAmount
 * @returns {Promise<{ vndAmount: number, rate: number }>}
 */
async function usdToVnd(usdAmount) {
    const rate = await getVndToUsdRate();
    const vndAmount = Math.round(usdAmount / rate);
    return { vndAmount, rate };
}

/**
 * Force-refresh the cached rate regardless of TTL. Useful after startup.
 * @returns {Promise<number>}
 */
async function refreshRate() {
    _cachedRate = null;
    _cacheExpiresAt = 0;
    return getVndToUsdRate();
}

/**
 * Get the currently cached rate without triggering a refresh.
 * Returns null if cache is empty.
 * @returns {number|null}
 */
function getCachedRate() {
    return _cachedRate;
}

module.exports = {
    getVndToUsdRate,
    vndToUsd,
    usdToVnd,
    refreshRate,
    getCachedRate,
};
