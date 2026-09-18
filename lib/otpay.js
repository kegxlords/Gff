// lib/otpay.js
// Adapter for OTPay gateway. All signing/amount formatting happens here.
const crypto = require('crypto');

const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };

if (!CFG.payUrl || !CFG.merchantId || !CFG.appSecret) {
  console.warn('[otpay] Missing OTPAY_* env vars for mode:', MODE);
}

// ---------- SIGNATURE (spec item 2: MD5 lowercase, 2-decimal amounts) ----------
function md5(str) { return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase(); }

function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid amount');
  return n.toFixed(2); // exactly 2 decimals
}

function signCreate(merchantOrderId, amount) {
  const raw = `merchantId=${CFG.merchantId}&merchantOrderId=${merchantOrderId}&amount=${formatAmount(amount)}&appSecret=${CFG.appSecret}`;
  return md5(raw);
}

function signQuery(merchantOrderId) {
  const raw = `merchantId=${CFG.merchantId}&merchantOrderId=${merchantOrderId}&appSecret=${CFG.appSecret}`;
  return md5(raw);
}

function verifyDepositCallback(body) {
  if (!body || !body.sign) return false;
  const expected = signCreate(body.merchantOrderId, body.amount);
  return expected === String(body.sign).toLowerCase();
}

function verifyWithdrawCallback(body) {
  return verifyDepositCallback(body); // same signing rules per spec
}

// ---------- COUNTRY FORMATS (spec 2.2 + 3.2) ----------
const COUNTRY = {
  CM: { code: 'CM', currency: 'XAF', mobileRegex: /^237\d{9}$/,   payoutExtras: { type: 'orange' }, payoutOperators: ['orange', 'mtn'] },
  NG: { code: 'NG', currency: 'NGN', mobileRegex: /^234\d{10}$/, payoutExtras: null,                  payoutOperators: ['bank'] },
  GH: { code: 'GH', currency: 'GHS', mobileRegex: /^233\d{9}$/,  payoutExtras: null,                  payoutOperators: ['mtn', 'vodafone', 'airteltigo'] },
  TH: { code: 'TH', currency: 'THB', mobileRegex: /^0\d{9}$/,    payoutExtras: { type: 'BANK' },      payoutOperators: ['bank'] },
  CI: { code: 'CI', currency: 'XOF', mobileRegex: /^225\d{8}$/,  payoutExtras: null,                  payoutOperators: ['orange', 'mtn', 'wave'] },
  SN: { code: 'SN', currency: 'XOF', mobileRegex: /^221\d{9}$/,  payoutExtras: null,                  payoutOperators: ['orange', 'wave'] },
  PE: { code: 'PE', currency: 'PEN', mobileRegex: /^9\d{8}$/,    payoutExtras: { identityType: 'DNI', interBankAccount: '' }, payoutOperators: ['bank'] },
  CO: { code: 'CO', currency: 'COP', mobileRegex: /^57\d{10}$/,  payoutExtras: { legalDocType: 'CC', type: 'AHORRO' }, payoutOperators: ['bank'] },
  MX: { code: 'MX', currency: 'MXN', mobileRegex: /^52\d{10}$/,  payoutExtras: { type: '40' },        payoutOperators: ['bank'] },
};

function validateMobile(countryCode, mobile) {
  const c = COUNTRY[countryCode];
  if (!c) return { ok: false, error: `Unsupported country: ${countryCode}` };
  if (!c.mobileRegex.test(String(mobile))) {
    return { ok: false, error: `Mobile must match ${countryCode} format (${c.mobileRegex})` };
  }
  return { ok: true, country: c };
}

function buildPayoutFundAccount(countryCode, { name, email, mobile, bankCode, accountNumber, idNumber }) {
  const c = COUNTRY[countryCode];
  if (!c) throw new Error(`Unsupported country: ${countryCode}`);
  const extra = c.payoutExtras ? { ...c.payoutExtras } : {};
  if (countryCode === 'PE' && idNumber) extra.interBankAccount = idNumber;
  if (countryCode === 'CO' && idNumber) extra.legalDocNumber = idNumber;

  const fa = {
    accountType: 'bank_account',
    contact: { name, email, mobile },
    bankAccount: { bankCode, accountNumber, extra }
  };
  if (idNumber) fa.bankAccount.idNumber = idNumber;
  return fa;
}

// ---------- HTTP CALLS ----------
async function post(path, body) {
  const res = await fetch(CFG.payUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function get(path) {
  const res = await fetch(CFG.payUrl + path, { method: 'GET' });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---------- DEPOSIT (代收) ----------
async function createDeposit({ merchantOrderId, amount, currency, payType = 1, firstName, lastName, mobile, email, remark, subject, notifyUrl, callbackUrl }) {
  const body = {
    merchantId: CFG.merchantId,
    merchantOrderId,
    amount: formatAmount(amount),
    currency: currency || 'XAF',
    payType,
    firstName, lastName, mobile, email,
    remark: remark || 'GFF Deposit',
    sign: signCreate(merchantOrderId, amount),
    notifyUrl
  };
  if (callbackUrl) body.callbackUrl = callbackUrl;
  if (subject) body.subject = subject;
  return post('/api/order/submit', body);
}

async function queryDeposit(merchantOrderId) {
  return get(`/api/order/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(merchantOrderId)}`);
}

// ---------- WITHDRAWAL (代付) ----------
async function createWithdrawal({ merchantOrderId, amount, currency, fundAccount, notifyUrl }) {
  const body = {
    merchantId: CFG.merchantId,
    merchantOrderId,
    amount: formatAmount(amount),
    currency: currency || 'XAF',
    sign: signCreate(merchantOrderId, amount),
    fundAccount,
    notifyUrl
  };
  return post('/api/payout/submit', body);
}

async function queryWithdrawal(merchantOrderId) {
  return get(`/api/payout/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(merchantOrderId)}`);
}

module.exports = {
  MODE, CFG,
  formatAmount, md5, signCreate, signQuery,
  verifyDepositCallback, verifyWithdrawCallback,
  COUNTRY, validateMobile, buildPayoutFundAccount,
  createDeposit, queryDeposit, createWithdrawal, queryWithdrawal
};
