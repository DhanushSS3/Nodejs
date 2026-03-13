'use strict';

/**
 * Pay2Pay Payout Logger
 *
 * Dedicated rotating log file for all Pay2Pay Transfer 24/7 (Payout) activity:
 * - All outgoing API requests (login, implore-auth, transfer_247, list_bank)
 * - All incoming responses from Pay2Pay
 * - All incoming IPN / webhook payloads (raw)
 * - Fee breakdown calculations
 * - Errors with full stack traces
 *
 * Rotation: 10 MB per file, max 10 files (100 MB total)
 * Location: logs/pay2pay-payout.log  →  pay2pay-payout1.log  …  pay2pay-payout10.log
 */

const winston = require('winston');
const path = require('path');
const BaseLogger = require('./BaseLogger');

const LOG_FILE_PATH = path.join(__dirname, '../../../logs/pay2pay-payout.log');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 10;                           // keep up to 10 rotated files

function buildFormat() {
    return winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.printf((info) => {
            let messageStr = typeof info.message === 'string'
                ? info.message
                : (() => { try { return JSON.stringify(info.message); } catch { return String(info.message); } })();

            const meta = { ...info };
            delete meta.level;
            delete meta.message;
            delete meta.timestamp;

            let metaStr = '';
            if (Object.keys(meta).length > 0) {
                try { metaStr = ` | ${JSON.stringify(meta)}`; } catch { /* skip */ }
            }

            return `[${info.timestamp}] ${info.level.toUpperCase().padEnd(5)} | ${messageStr}${metaStr}`;
        })
    );
}

const _winstonLogger = winston.createLogger({
    level: 'debug',
    format: buildFormat(),
    transports: [
        new winston.transports.File({
            filename: LOG_FILE_PATH,
            maxsize: MAX_FILE_SIZE_BYTES,
            maxFiles: MAX_FILES,
            tailable: true,     // always write to pay2pay-payout.log, rotate older ones
        }),
        ...(process.env.NODE_ENV === 'development' ? [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.simple()
                )
            })
        ] : [])
    ]
});

class Pay2PayPayoutLogger extends BaseLogger {
    constructor() {
        super(_winstonLogger);
    }

    // ─── Outgoing Requests ─────────────────────────────────────────────────────

    /**
     * Log an outgoing API request to Pay2Pay (sensitive fields redacted).
     * @param {string} endpoint
     * @param {Object} payload
     */
    logRequest(endpoint, payload) {
        // Redact sensitive values before logging
        const safe = this._redact(payload);
        this.logger.info(`[OUTGOING] ${endpoint}`, { payload: safe });
    }

    // ─── Incoming Responses ────────────────────────────────────────────────────

    /**
     * Log an incoming response from Pay2Pay.
     * @param {string} endpoint
     * @param {Object} response
     */
    logResponse(endpoint, response) {
        this.logger.info(`[INCOMING] ${endpoint}`, { response });
    }

    // ─── Payout Dispatch ───────────────────────────────────────────────────────

    /**
     * Log the start of a payout dispatch with full fee breakdown.
     * @param {string} operationId
     * @param {Object} details
     */
    logPayoutDispatch(operationId, details) {
        this.logger.info(`[PAYOUT_DISPATCH] ${operationId}`, { details });
    }

    /**
     * Log the outcome of a payout dispatch.
     * @param {string} operationId
     * @param {'success'|'failed'} outcome
     * @param {Object} data
     */
    logPayoutOutcome(operationId, outcome, data) {
        const level = outcome === 'success' ? 'info' : 'error';
        this.logger[level](`[PAYOUT_OUTCOME:${outcome.toUpperCase()}] ${operationId}`, { data });
    }

    // ─── IPN / Webhook ─────────────────────────────────────────────────────────

    /**
     * Log a raw incoming payout IPN exactly as received (before any processing).
     * @param {Object} headers - Request headers (sensitive keys redacted)
     * @param {string|Object} rawBody - Raw body string or parsed object
     */
    logPayoutIPN(headers, rawBody) {
        const safeHeaders = {
            'p-api-key': headers['p-api-key'] || headers['P-API-KEY'] || '',
            'p-signature': headers['p-signature'] || headers['P-SIGNATURE'] || '',
            'content-type': headers['content-type'] || '',
            'x-forwarded-for': headers['x-forwarded-for'] || '',
        };
        this.logger.info('[IPN_RECEIVED] Pay2Pay Payout IPN', {
            headers: safeHeaders,
            body: rawBody,
        });
    }

    /**
     * Log the result of IPN processing.
     * @param {string} audit
     * @param {string} action
     * @param {Object} data
     */
    logIPNResult(audit, action, data) {
        this.logger.info(`[IPN_PROCESSED] audit=${audit} action=${action}`, { data });
    }

    // ─── Fee Calculation ───────────────────────────────────────────────────────

    /**
     * Log the fee breakdown for a payout.
     * @param {Object} fees
     */
    logFeeBreakdown(fees) {
        this.logger.info('[FEE_BREAKDOWN]', { fees });
    }

    // ─── Errors ────────────────────────────────────────────────────────────────

    /**
     * Log a Pay2Pay payout error with context.
     * @param {string} context - Description of where the error occurred
     * @param {Error|Object|string} error
     */
    logError(context, error) {
        this.logger.error(`[ERROR] ${context}`, {
            error: error && error.message ? error.message : error,
            stack: error && error.stack ? error.stack : undefined,
        });
    }

    /**
     * Log a token revocation / retry event.
     * @param {Object} data
     */
    logTokenRetry(data) {
        this.logger.warn('[TOKEN_RETRY] Token revoked, retrying with fresh login', { data });
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Redact sensitive fields before logging.
     */
    _redact(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const SENSITIVE = ['authValue', 'password', 'passcode', 'verifiedKey', 'accessToken', 'token', 'Authorization'];
        const result = { ...obj };
        for (const key of SENSITIVE) {
            if (result[key] !== undefined) result[key] = '[REDACTED]';
        }
        return result;
    }
}

module.exports = new Pay2PayPayoutLogger();
