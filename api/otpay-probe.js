// api/otpay-probe.js — TEMPORARY connectivity diagnostic. DELETE after use.
const crypto = require('crypto');
const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();

function withTimeout(ms, fn) {
  return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_' + ms + 'ms')), ms))]);
}
async function timed(label, fn) {
  const start = Date.now();
  try {
    const r = await fn();
    return { label, ms: Date.now() - start, status: r.status, body: r.body };
  } catch (e) {
    return { label, ms: Date.now() - start, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  if (!CFG.payUrl) return res.status(500).json({ error: 'no payUrl env' });

  const orderStatus = await timed('GET /api/order/status', () => withTimeout(10000, async () => {
    const r = await fetch(`${CFG.payUrl}/api/order/status?merchantId=${CFG.merchantId}&merchantOrderId=probe-${Date.now()}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  }));

  const payoutSubmit = await timed('POST /api/payout/submit (bad sign on purpose)', () => withTimeout(10000, async () => {
    const r = await fetch(`${CFG.payUrl}/api/payout/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId: CFG.merchantId, merchantOrderId: 'probe-' + Date.now(), currency: 'XAF', amount: '100.00', sign: md5('bad'),
        fundAccount: { accountType: 'bank_account', contact: { name: 'Probe', email: 'p@p.co', mobile: '237600000000' }, bankAccount: { bankCode: 'mtn', accountNumber: '237600000000', extra: { type: 'mtn' } } }
      })
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }));

  res.status(200).json({ mode: MODE, payUrl: CFG.payUrl, orderStatus, payoutSubmit });
};
