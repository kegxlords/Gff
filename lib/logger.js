// lib/logger.js
// Redacts secrets (appSecret, sign) and PII (mobile, email, accountNumber) before logging.
const REDACT_KEYS = ['appSecret', 'sign', 'mobile', 'email', 'accountNumber', 'idNumber', 'address'];

function redact(obj, depth = 0) {
  if (depth > 8) return '[redacted:depth]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(x => redact(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.includes(k)) out[k] = '[REDACTED]';
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

function log(tag, message, data) {
  const ts = new Date().toISOString();
  const payload = data ? JSON.stringify(redact(data)) : '';
  console.log(`[${ts}] [${tag}] ${message}${payload ? ' ' + payload : ''}`);
}

function error(tag, message, data) {
  const ts = new Date().toISOString();
  const payload = data ? JSON.stringify(redact(data)) : '';
  console.error(`[${ts}] [${tag}] ERROR: ${message}${payload ? ' ' + payload : ''}`);
}

module.exports = { log, error, redact };
