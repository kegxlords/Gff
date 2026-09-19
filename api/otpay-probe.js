// api/otpay-probe.js v2 — TEMPORARY. DELETE after diagnosis.
const crypto = require('crypto');
const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
const fmtAmt = n => Number(n).toFixed(2);

module.exports = async function handler(req, res) {
  if (!CFG.payUrl) return res.status(500).json({ error: 'no payUrl env' });

  const secret = CFG.appSecret || '';
  const fingerprint = {
    mode: MODE,
    payUrl: CFG.payUrl,
    merchantId: CFG.merchantId,
    secretLen: secret.length,
    secretFirst4: secret.slice(0, 4),
    secretLast4: secret.slice(-4),
    secretHasWhitespace: /\s/.test(secret)
  };

  // SAFE signed test: deposit order creates an UNPAID order only — no funds move
  const id = 'probe-' + Date.now();
  const amount = fmtAmt(100);
  const sign = md5(`merchantId=${CFG.merchantId}&merchantOrderId=${id}&amount=${amount}&appSecret=${secret}`);
  let depositSignTest;
  try {
    const r = await fetch(CFG.payUrl + '/api/order/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId: CFG.merchantId, merchantOrderId: id, amount, currency: 'XAF', remark: 'mtn',
        sign, payType: 1, notifyUrl: (process.env.APP_URL || 'https://gff-ashy.vercel.app') + '/api/payments/otpay-callback',
        firstName: 'Probe', lastName: 'Test', mobile: '237600000000', email: 'probe@test.com'
      })
    });
    depositSignTest = { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    depositSignTest = { error: e.message };
  }

  res.status(200).json({ fingerprint, depositSignTest, hint: 'code 0 = signature OK • code 1005 = secret/merchant mismatch' });
};
