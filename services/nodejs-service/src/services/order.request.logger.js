const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Directory: ../../logs relative to this file
const LOG_DIR = path.resolve(__dirname, '../../logs');

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

async function ensureLogDir() {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
  } catch (_) {
    // ignore
  }
}

function getLogFilePath(date = new Date()) {
  return path.join(LOG_DIR, `orders_requests-${ymd(date)}.log`);
}

function sanitizeHeaders(headers = {}) {
  const h = { ...headers };
  // Redact common sensitive headers
  if (h.authorization) h.authorization = '***';
  if (h.cookie) h.cookie = '***';
  if (h['x-api-key']) h['x-api-key'] = '***';
  return h;
}

function sanitizeBody(body = {}) {
  try {
    const clone = JSON.parse(JSON.stringify(body));
    const redactKeys = ['password', 'secret', 'access_token', 'refresh_token', 'token'];
    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (redactKeys.includes(String(k).toLowerCase())) {
          obj[k] = '***';
          continue;
        }
        if (v && typeof v === 'object') walk(v);
      }
    }
    walk(clone);
    return clone;
  } catch (_) {
    return {}; // fallback if body is not JSON-serializable
  }
}

async function appendLine(line) {
  await ensureLogDir();
  const file = getLogFilePath();
  const data = line + '\n';
  // Use appendFile with flag 'a' to create if not exists
  await fsp.appendFile(file, data, { encoding: 'utf8', flag: 'a' });
}

async function logOrderRequest({ endpoint, operationId, method, path: reqPath, ip, user, headers, body }) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      level: 'info',
      type: 'order_request',
      endpoint,
      operationId,
      method,
      path: reqPath,
      ip,
      user: user || {},
      headers: sanitizeHeaders(headers || {}),
      body: sanitizeBody(body || {}),
    };
    await appendLine(JSON.stringify(entry));
  } catch (e) {
    // Best-effort logging: do not throw
  }
}

module.exports = {
  logOrderRequest,
};
