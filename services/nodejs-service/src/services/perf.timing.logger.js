const fsp = require('fs/promises');
const path = require('path');

// Write timing logs into the python-service logs directory so both services share one file
const LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'python-service', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'orders_timing.log');

async function ensureDir() {
  try { await fsp.mkdir(LOG_DIR, { recursive: true }); } catch (_) {}
}

function safeClone(obj) {
  try { return JSON.parse(JSON.stringify(obj || {})); } catch { return {}; }
}

async function logTiming(entry) {
  try {
    await ensureDir();
    const payload = {
      ts: new Date().toISOString(),
      component: 'node_api',
      ...safeClone(entry),
    };
    await fsp.appendFile(LOG_FILE, JSON.stringify(payload) + '\n', { encoding: 'utf8' });
  } catch (_) {
    // best-effort
  }
}

module.exports = { logTiming };
