const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
const liveUserLoginLogFile = path.join(logDir, 'liveUserLogin.log');
const demoUserLoginLogFile = path.join(logDir, 'demoUserLogin.log');

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function logLiveUserLogin({ email, account_number, ip, userAgent, timestamp }) {
  const logEntry = JSON.stringify({
    level: 'info',
    type: 'live_user_login',
    timestamp,
    email,
    account_number,
    ip,
    userAgent
  }) + '\n';
  fs.appendFileSync(liveUserLoginLogFile, logEntry, { encoding: 'utf8' });
}

function logDemoUserLogin({ email, account_number, ip, userAgent, timestamp }) {
  const logEntry = JSON.stringify({
    level: 'info',
    type: 'demo_user_login',
    timestamp,
    email,
    account_number,
    ip,
    userAgent
  }) + '\n';
  fs.appendFileSync(demoUserLoginLogFile, logEntry, { encoding: 'utf8' });
}

module.exports = { logLiveUserLogin, logDemoUserLogin };
