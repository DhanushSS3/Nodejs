'use strict';

/**
 * Pay2Pay FX Rate Service
 *
 * Uses the static VND/USD exchange rate from PAY2PAY_VND_TO_USD_FALLBACK_RATE
 * as requested without relying on external APIs.
 *
 * Rate returned: how many USD per 1 VND (e.g. ~0.0000395)
 */

const logger = require('./logger.service');

const FALLBACK_RATE_DEFAULT = 0.0000395; // ~25,330 VND per USD

/**
 * Get the current VND→USD rate from environment variables.
 * @param {string} type - 'deposit' or 'withdraw'
 * @returns {Promise<number>} VND to USD rate
 */
async function getVndToUsdRate(type = 'deposit') {
    let rate;
    if (type === 'withdraw') {
        rate = parseFloat(process.env.PAY2PAY_VND_TO_USD_WITHDRAW_FALLBACK_RATE);
    } else {
        rate = parseFloat(process.env.PAY2PAY_VND_TO_USD_FALLBACK_RATE);
    }
    
    if (!isNaN(rate) && rate > 0) {
        return rate;
    }

    logger.warn(`PAY2PAY fallback rate for ${type} is missing or invalid, using default`, { FALLBACK_RATE_DEFAULT });
    return FALLBACK_RATE_DEFAULT;
}

/**
 * Convert a VND amount to USD using the configured deposit rate.
 * @param {number} vndAmount
 * @returns {Promise<{ usdAmount: number, rate: number }>}
 */
async function vndToUsd(vndAmount) {
    const rate = await getVndToUsdRate('deposit');
    const usdAmount = vndAmount * rate;
    return { usdAmount: Math.round(usdAmount * 100000) / 100000, rate };
}

/**
 * Convert USD to VND using the configured withdraw rate.
 * @param {number} usdAmount
 * @returns {Promise<{ vndAmount: number, rate: number }>}
 */
async function usdToVnd(usdAmount) {
    const rate = await getVndToUsdRate('withdraw');
    const vndAmount = Math.round(usdAmount / rate);
    return { vndAmount, rate };
}

/**
 * Get the currently configured rate.
 * @returns {number}
 */
function getCachedRate(type = 'deposit') {
    if (type === 'withdraw') {
        return parseFloat(process.env.PAY2PAY_VND_TO_USD_WITHDRAW_FALLBACK_RATE) || FALLBACK_RATE_DEFAULT;
    }
    return parseFloat(process.env.PAY2PAY_VND_TO_USD_FALLBACK_RATE) || FALLBACK_RATE_DEFAULT;
}

module.exports = {
    getVndToUsdRate,
    vndToUsd,
    usdToVnd,
    getCachedRate,
};
