const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Directory: ../../logs relative to this file
const LOG_DIR = path.resolve(__dirname, '../../logs');
// Size-based rotation config (env overrides)
const MAX_BYTES = (() => {
  const env = process.env.ORDER_REQ_LOG_MAX_BYTES;
  const n = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024; // 10 MB default
})();
const MAX_FILES = (() => {
  const env = process.env.ORDER_REQ_LOG_MAX_FILES;
  const n = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5; // keep latest 5 rotated files
})();

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

async function fileExists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch (_) {
    return false;
  }
}

async function rotateIfNeeded(file) {
  try {
    const st = await fsp.stat(file);
    if (!st || st.size < MAX_BYTES) return;
  } catch (_) {
    // file does not exist; no rotation
    return;
  }
  // Shift rotated files: .N -> .N+1 (drop oldest)
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    const dst = `${file}.${i + 1}`;
    try {
      if (await fileExists(dst)) {
        await fsp.unlink(dst).catch(() => {});
      }
      if (await fileExists(src)) {
        await fsp.rename(src, dst).catch(() => {});
      }
    } catch (_) {}
  }
  // Base -> .1
  try {
    const first = `${file}.1`;
    if (await fileExists(first)) {
      await fsp.unlink(first).catch(() => {});
    }
    await fsp.rename(file, first);
  } catch (_) {}
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

function sanitizeUser(user = {}) {
  try {
    const clone = JSON.parse(JSON.stringify(user));
    const redact = ['password', 'secret', 'access_token', 'refresh_token', 'token'];
    for (const k of Object.keys(clone)) {
      if (redact.includes(String(k).toLowerCase())) clone[k] = '***';
    }
    return clone;
  } catch (_) {
    return {};
  }
}

async function appendLine(line) {
  await ensureLogDir();
  const file = getLogFilePath();
  await rotateIfNeeded(file);
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
      user: sanitizeUser(user || {}),
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
