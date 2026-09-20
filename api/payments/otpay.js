// api/payments/otpay.js — self-contained OTPay gateway (no external libs)
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };

// ---------- OPTIONAL STATIC-IP PROXY (payouts only; off unless env set) ----------
const PROXY = process.env.PAYOUT_PROXY_URL || '';
const PROXY_KEY = process.env.PAYOUT_PROXY_KEY || '';
function payoutUrl(path) { return (PROXY && path.startsWith('/api/payout/')) ? PROXY + path : CFG.payUrl + path; }
function payoutHeaders() { return (PROXY && PROXY_KEY) ? { 'X-Proxy-Key': PROXY_KEY } : {}; }

// ---------- SIGNING (MD5 lowercase, 2-decimal amounts) ----------
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
function fmtAmt(n) { const x = Number(n); if (!Number.isFinite(x) || x < 0) throw new Error('Invalid amount'); return x.toFixed(2); }
const signCreate = (id, amt) => md5(`merchantId=${CFG.merchantId}&merchantOrderId=${id}&amount=${fmtAmt(amt)}&appSecret=${CFG.appSecret}`);

// ---------- REDACTED LOGGER ----------
const REDACT = ['appSecret', 'sign', 'mobile', 'email', 'accountNumber', 'idNumber', 'address'];
function redact(o, d = 0) {
  if (d > 8) return '[redacted]';
  if (o === null || o === undefined || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(x => redact(x, d + 1));
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = REDACT.includes(k) ? '[REDACTED]' : redact(v, d + 1);
  return out;
}
const log = (t, m, d) => console.log(`[${new Date().toISOString()}] [${t}] ${m}${d ? ' ' + JSON.stringify(redact(d)) : ''}`);

// ---------- COUNTRY FORMATS ----------
const COUNTRY = {
  CM: { currency: 'XAF', re: /^237\d{9}$/, extras: { type: 'orange' } },
  NG: { currency: 'NGN', re: /^234\d{10}$/, extras: null },
  GH: { currency: 'GHS', re: /^233\d{9}$/, extras: null },
  CI: { currency: 'XOF', re: /^225\d{8}$/, extras: null },
  SN: { currency: 'XOF', re: /^221\d{9}$/, extras: null },
  TH: { currency: 'THB', re: /^0\d{9}$/, extras: { type: 'BANK' } },
  PE: { currency: 'PEN', re: /^9\d{8}$/, extras: { identityType: 'DNI', interBankAccount: '' } },
  CO: { currency: 'COP', re: /^57\d{10}$/, extras: { legalDocType: 'CC', type: 'AHORRO' } },
  MX: { currency: 'MXN', re: /^52\d{10}$/, extras: { type: '40' } }
};
// OTPay cashier/wallets use NATIONAL numbers (the +237 prefix is shown separately)
const PREFIX = { CM: '237', CI: '225', SN: '221', NG: '234', GH: '233', CO: '57', MX: '52' };
function national(cc, mobile) {
  const m = String(mobile || '').replace(/\s/g, '');
  const p = PREFIX[cc];
  return p && m.startsWith(p) ? m.slice(p.length) : m;
}
function validateMobile(cc, mobile) {
  const c = COUNTRY[cc];
  if (!c) return { ok: false, error: `Unsupported country: ${cc}` };
  if (!c.re.test(String(mobile))) return { ok: false, error: `Mobile must match ${cc} format` };
  return { ok: true, country: c };
}
function buildFundAccount(cc, r) {
  const c = COUNTRY[cc];
  if (!c) throw new Error(`Unsupported country: ${cc}`);
  const extra = c.extras ? { ...c.extras } : {};
  if (cc === 'PE' && r.idNumber) extra.interBankAccount = r.idNumber;
  const fa = { accountType: 'bank_account', contact: { name: r.name, email: r.email, mobile: r.mobile }, bankAccount: { bankCode: r.bankCode, accountNumber: r.accountNumber, extra } };
  if (r.idNumber) fa.bankAccount.idNumber = r.idNumber;
  return fa;
}

// ---------- HTTP (15s hard timeout) ----------
async function post(path, body, timeoutMs = 15000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(payoutUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('OTPAY_TIMEOUT_15S'); err.timeout = true; throw err; }
    throw e;
  } finally { clearTimeout(timer); }
}
async function get(path, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(CFG.payUrl + path, { method: 'GET', signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('OTPAY_TIMEOUT_15S'); err.timeout = true; throw err; }
    throw e;
  } finally { clearTimeout(timer); }
}

// ---------- CREDIT DEPOSIT (wallet auto-create + tx log + referral bonus) ----------
// wallets schema: user_id, balance, total_deposit, total_profit, total_referral_earnings, updated_at
async function creditDeposit({ supabase, user_id, amount, provider_ref, description }) {
  let { data: wallet, error } = await supabase.from('wallets').select('*').eq('user_id', user_id).maybeSingle();

  if (error || !wallet) {
    const { data: newWallet, error: insertErr } = await supabase.from('wallets').insert({
      user_id, balance: 0, total_deposit: 0, total_profit: 0, total_referral_earnings: 0,
      updated_at: new Date().toISOString()
    }).select().single();
    if (insertErr) throw new Error('Failed to create wallet: ' + insertErr.message);
    wallet = newWallet;
    log('otpay.creditDeposit', 'wallet auto-created', { user_id });
  }

  const amt = Number(amount);
  const nb = Number(wallet.balance) + amt;
  await supabase.from('wallets').update({ balance: nb, total_deposit: Number(wallet.total_deposit || 0) + amt, updated_at: new Date().toISOString() }).eq('user_id', user_id);
  await supabase.from('wallet_transactions').insert({ user_id, type: 'deposit', amount: amt, description: description || 'Deposit credited', balance_after: nb });

  const { data: st } = await supabase.from('platform_settings').select('referral_bonus_percent').eq('id', 1).single();
  const pct = Number(st?.referral_bonus_percent ?? 22);
  const { data: user } = await supabase.from('users').select('referred_by').eq('id', user_id).single();
  if (user?.referred_by) {
    const comm = Math.round(amt * pct / 100);
    const { data: rw } = await supabase.from('wallets').select('*').eq('user_id', user.referred_by).single();
    if (rw) {
      const rb = Number(rw.balance) + comm;
      await supabase.from('wallets').update({ balance: rb, total_referral_earnings: Number(rw.total_referral_earnings || 0) + comm, updated_at: new Date().toISOString() }).eq('user_id', user.referred_by);
      await supabase.from('wallet_transactions').insert({ user_id: user.referred_by, type: 'referral_bonus', amount: comm, description: pct + '% commission on downline deposit', balance_after: rb });
    }
  }
  return { newBalance: nb };
}

// ---------- DEPOSIT CREATE ----------
async function depositCreate(supabase, uid, b) {
  const amt = Number(b.amount);
  if (!Number.isFinite(amt) || amt < 500) return { status: 400, body: { error: 'Minimum deposit is 500' } };
  if (b.country_code) { const v = validateMobile(b.country_code, b.mobile); if (!v.ok) return { status: 400, body: { error: v.error } }; }

  const { data: prof } = await supabase.from('users').select('email, full_name').eq('id', uid).single();
  const email = b.email || prof?.email || '';
  if (!email) return { status: 400, body: { error: 'Email required — contact support' } };
  const nameParts = (prof?.full_name || 'Customer GFF').trim().split(' ');
  const firstName = b.firstName || nameParts[0] || 'Customer';
  const lastName = b.lastName || nameParts.slice(1).join(' ') || 'GFF';

  const cur = COUNTRY[b.country_code] ? COUNTRY[b.country_code].currency : (b.currency || 'XAF');
  const method = b.operator || b.remark || (b.country_code === 'CM' ? 'mtn' : 'mobile');
  const natMobile = national(b.country_code, b.mobile); // 9 digits for CM — cashier shows +237 itself

  const id = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const base = process.env.APP_URL || 'https://gff-ashy.vercel.app';
  log('otpay.deposit-create', 'creating', { uid, amount: amt, cur, method, id });

  let r;
  try {
    r = await post('/api/order/submit', {
      merchantId: CFG.merchantId, merchantOrderId: id, amount: fmtAmt(amt), currency: cur,
      remark: method, sign: signCreate(id, amt), payType: 1,
      notifyUrl: base + '/api/payments/otpay-callback', callbackUrl: base + '/payments/return',
      firstName, lastName, mobile: natMobile, email
    });
  } catch (e) {
    log('otpay.deposit-create', e.timeout ? 'GATEWAY TIMEOUT 15s' : 'network error', { id, error: e.message });
    return { status: 502, body: { ok: false, error: e.timeout ? 'Gateway did not respond in 15s — try again shortly' : 'Network error reaching gateway' } };
  }
  log('otpay.deposit-create', 'gateway response', { id, status: r.status, body: r.data });

  if (r.status !== 200 || !r.data || r.data.code !== 0) {
    const errMsg = r.data?.error || r.data?.msg || 'Gateway error';
    return { status: 502, body: { error: errMsg + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : ''), raw: r.data } };
  }

  await supabase.from('payment_transactions').insert({
    user_id: uid, kind: 'deposit', provider: 'otpay', mode: MODE, merchant_order_id: id,
    provider_order_id: String(r.data.data.orderId || ''), amount: amt, currency: cur,
    status: 'pending', country_code: b.country_code, operator: b.operator || null, phone: b.mobile, email,
    meta: { h5Url: r.data.data.h5Url, payType: r.data.data.payType }
  });

  return { status: 200, body: { ok: true, merchantOrderId: id, h5Url: r.data.data.h5Url, orderId: r.data.data.orderId } };
}

// ---------- DEPOSIT QUERY ----------
async function depositQuery(supabase, uid, b) {
  if (!b.merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', b.merchantOrderId).eq('user_id', uid).single();
  if (!tx) return { status: 404, body: { error: 'Order not found' } };

  let r;
  try {
    r = await get(`/api/order/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(b.merchantOrderId)}`);
  } catch (e) {
    return { status: 502, body: { error: e.timeout ? 'Gateway query timed out' : 'Gateway query network error' } };
  }
  if (r.status !== 200 || !r.data || r.data.code !== 0) {
    return { status: 502, body: { error: (r.data?.error || 'Gateway query failed') + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : '') } };
  }

  const q = r.data.data.status;
  let st = tx.status;
  if (tx.status === 'pending') {
    if (q === 1) {
      const pa = Number(r.data.data.payAmount || tx.amount);
      await creditDeposit({ supabase, user_id: tx.user_id, amount: pa, provider_ref: r.data.data.orderId, description: `OTPay deposit (query) — ref ${r.data.data.orderId}` });
      st = 'paid';
      await supabase.from('payment_transactions').update({ status: 'paid', pay_amount: pa, provider_order_id: String(r.data.data.orderId || ''), updated_at: new Date().toISOString() }).eq('id', tx.id);
    } else if (q === 2) { st = 'failed'; await supabase.from('payment_transactions').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', tx.id); }
    else if (q === 3) { st = 'refunded'; await supabase.from('payment_transactions').update({ status: 'refunded', updated_at: new Date().toISOString() }).eq('id', tx.id); }
  }
  return { status: 200, body: { ok: true, status: st, gatewayStatus: q } };
}

// ---------- WITHDRAW CREATE (request + debit + fee + payout in one) ----------
async function withdrawCreate(supabase, uid, b) {
  const amt = Number(b.amount);
  if (!Number.isFinite(amt) || amt < 1000) return { status: 400, body: { error: 'Minimum withdrawal is 1,000' } };
  const v = validateMobile(b.country_code, b.recipient?.mobile);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const name = (b.recipient?.name || '').trim();
  if (name.length < 3) return { status: 400, body: { error: 'Recipient name required' } };

  const { data: st } = await supabase.from('platform_settings').select('withdrawal_fee_percent').eq('id', 1).single();
  const feePct = Number(st?.withdrawal_fee_percent ?? 15);
  const fee = Math.round(amt * feePct / 100);
  const net = amt - fee;
  const cur = COUNTRY[b.country_code] ? COUNTRY[b.country_code].currency : (b.currency || 'XAF');
  const natMobile = national(b.country_code, b.recipient.mobile);

  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { count: pend } = await supabase.from('payment_transactions').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('kind', 'payout').in('status', ['pending', 'processing']).gte('created_at', since);
  if (pend > 0) return { status: 400, body: { error: 'You already have a pending payout (wait ~30 min or contact support)' } };

  const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', uid).single();
  if (!wallet || Number(wallet.balance) < amt) return { status: 400, body: { error: 'Insufficient balance' } };

  const fa = buildFundAccount(b.country_code, { name, email: b.recipient.email || '', mobile: natMobile, bankCode: b.recipient.operator || b.country_code, accountNumber: natMobile, idNumber: b.recipient.idNumber });
  if (b.country_code === 'CM' && b.recipient.operator) fa.bankAccount.extra.type = b.recipient.operator;

  const id = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const base = process.env.APP_URL || 'https://gff-ashy.vercel.app';

  const { data: reqRow, error: e1 } = await supabase.from('withdrawal_requests').insert({ user_id: uid, bank_card_id: null, amount: amt, fee_15percent: fee, net_amount: net, status: 'pending' }).select().single();
  if (e1) throw e1;
  const nb = Number(wallet.balance) - amt;
  await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', uid);
  await supabase.from('wallet_transactions').insert({ user_id: uid, type: 'withdrawal', amount: -amt, description: `OTPay payout (${net.toLocaleString()} net after ${feePct}% fee)`, balance_after: nb });
  await supabase.from('payment_transactions').insert({
    user_id: uid, kind: 'payout', provider: 'otpay', mode: MODE, merchant_order_id: id, amount: net,
    currency: cur, status: 'pending', country_code: b.country_code, phone: b.recipient.mobile,
    fund_account: fa, linked_request_id: reqRow.id, meta: { gross: amt, fee }
  });

  log('otpay.withdraw-create', 'submitting', { uid, gross: amt, net, cur, id });
  let r;
  try {
    r = await post('/api/payout/submit', { merchantId: CFG.merchantId, merchantOrderId: id, currency: cur, amount: fmtAmt(net), sign: signCreate(id, net), notifyUrl: base + '/api/payments/otpay-callback', fundAccount: fa }, 15000, payoutHeaders());
  } catch (e) {
    log('otpay.withdraw-create', e.timeout ? 'GATEWAY TIMEOUT 15s' : 'network error', { id, error: e.message });
    return { status: 502, body: { ok: false, ambiguous: true, merchantOrderId: id, error: e.timeout ? 'Gateway did not respond in 15s — check probe/whitelist' : 'Network error reaching gateway: ' + e.message } };
  }
  log('otpay.withdraw-create', 'gateway response', { id, status: r.status, body: r.data });

  const codeBad = r.data && r.data.code !== undefined && Number(r.data.code) !== 0;
  if (r.status !== 200 || !r.data || codeBad || r.data.status === 2) {
    const errMsg = (r.data?.error || r.data?.msg || 'Payout rejected') + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : '');
    await supabase.from('payment_transactions').update({ status: 'failed', last_error: errMsg, updated_at: new Date().toISOString() }).eq('merchant_order_id', id);
    await supabase.from('wallets').update({ balance: Number(wallet.balance), updated_at: new Date().toISOString() }).eq('user_id', uid);
    await supabase.from('wallet_transactions').insert({ user_id: uid, type: 'withdrawal_refund', amount: amt, description: 'OTPay payout rejected at creation — refund', balance_after: Number(wallet.balance) });
    await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: 'OTPay rejected at creation: ' + errMsg }).eq('id', reqRow.id);
    return { status: 502, body: { ok: false, error: errMsg, refunded: true } };
  }

  await supabase.from('payment_transactions').update({ provider_order_id: r.data?.payoutId ? String(r.data.payoutId) : null, meta: { gross: amt, fee, otpayResponse: r.data } }).eq('merchant_order_id', id);
  return { status: 200, body: { ok: true, merchantOrderId: id, payoutId: r.data?.payoutId, status: r.data?.status, net, fee } };
}

// ---------- WITHDRAW QUERY ----------
async function withdrawQuery(supabase, uid, b) {
  if (!b.merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', b.merchantOrderId).eq('user_id', uid).single();
  if (!tx) return { status: 404, body: { error: 'Order not found' } };

  let r;
  try {
    r = await get(`/api/payout/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(b.merchantOrderId)}`);
  } catch (e) {
    return { status: 502, body: { error: e.timeout ? 'Gateway query timed out' : 'Gateway query network error' } };
  }
  if (r.status !== 200) {
    return { status: 502, body: { error: (r.data?.error || 'Gateway query failed') + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : '') } };
  }

  const q = r.data?.data?.status ?? r.data?.status;
  let st = tx.status;
  if (tx.status === 'pending' || tx.status === 'processing') {
    if (q === 1) {
      st = 'successful';
      if (tx.linked_request_id) await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: 'OTPay payout confirmed (query)' }).eq('id', tx.linked_request_id);
    } else if (q === 2) {
      st = 'failed';
      if (tx.linked_request_id) {
        const { data: flipped } = await supabase.from('withdrawal_requests')
          .update({ status: 'rejected', admin_note: 'OTPay payout failed (query) — refunded' })
          .eq('id', tx.linked_request_id)
          .in('status', ['pending', 'approved'])
          .select();
        if (flipped && flipped.length) {
          const refund = Number(tx.meta?.gross || tx.amount);
          const { data: w } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).single();
          if (w) {
            const nb2 = Number(w.balance) + refund;
            await supabase.from('wallets').update({ balance: nb2, updated_at: new Date().toISOString() }).eq('user_id', tx.user_id);
            await supabase.from('wallet_transactions').insert({ user_id: tx.user_id, type: 'withdrawal_refund', amount: refund, description: 'OTPay payout failed (query) — refund', balance_after: nb2 });
          }
        }
      }
    } else if (q === 4) st = 'processing';
    await supabase.from('payment_transactions').update({ status: st, updated_at: new Date().toISOString() }).eq('id', tx.id);
  }
  return { status: 200, body: { ok: true, status: st, gatewayStatus: q } };
}

// ---------- COUNTRY VALIDATE ----------
function countryValidate(b) {
  const c = COUNTRY[b.country_code];
  if (!c) return { status: 400, body: { ok: false, error: `Unsupported country: ${b.country_code}` } };
  const m = validateMobile(b.country_code, b.mobile);
  if (!m.ok) return { status: 200, body: { ok: false, error: m.error } };
  return { status: 200, body: { ok: true, currency: c.currency, requiresExtras: c.extras ? Object.keys(c.extras) : [] } };
}

// ---------- ADMIN CHECK ----------
async function adminCheck(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  return profile?.is_admin ? data.user : null;
}

// ---------- ADMIN: VERIFY & CREDIT ----------
async function adminDepositVerify(supabase, merchantOrderId) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).eq('kind', 'deposit').single();
  if (!tx) return { status: 404, body: { error: 'Transaction not found' } };
  if (tx.status !== 'pending') return { status: 400, body: { error: `Already ${tx.status}` } };

  let r;
  try {
    r = await get(`/api/order/status?merchantId=${CFG.merchantId}&merchantOrderId=${encodeURIComponent(merchantOrderId)}`);
  } catch (e) {
    return { status: 502, body: { error: e.timeout ? 'Gateway timeout' : 'Network error' } };
  }
  if (r.status !== 200 || !r.data || r.data.code !== 0) {
    return { status: 502, body: { error: (r.data?.error || 'Gateway query failed') + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : '') } };
  }

  const q = r.data.data.status;
  if (q === 1) {
    const pa = Number(r.data.data.payAmount || tx.amount);
    await creditDeposit({ supabase, user_id: tx.user_id, amount: pa, provider_ref: r.data.data.orderId, description: `OTPay deposit (admin verify) — ref ${r.data.data.orderId}` });
    await supabase.from('payment_transactions').update({ status: 'paid', pay_amount: pa, provider_order_id: String(r.data.data.orderId || ''), updated_at: new Date().toISOString() }).eq('id', tx.id);
    log('otpay.admin-verify', 'credited', { merchantOrderId, pa });
    return { status: 200, body: { ok: true, message: 'Verified & credited', gatewayStatus: q } };
  } else if (q === 2) {
    await supabase.from('payment_transactions').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', tx.id);
    return { status: 200, body: { ok: true, message: 'Gateway says FAILED — marked failed', gatewayStatus: q } };
  } else if (q === 3) {
    await supabase.from('payment_transactions').update({ status: 'refunded', updated_at: new Date().toISOString() }).eq('id', tx.id);
    return { status: 200, body: { ok: true, message: 'Gateway says REFUNDED', gatewayStatus: q } };
  }
  return { status: 200, body: { ok: false, message: 'Gateway still PENDING — nothing credited', gatewayStatus: q } };
}

// ---------- ADMIN: FORCE CREDIT ----------
async function adminDepositCredit(supabase, merchantOrderId) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).eq('kind', 'deposit').single();
  if (!tx) return { status: 404, body: { error: 'Transaction not found' } };
  if (tx.status !== 'pending') return { status: 400, body: { error: `Already ${tx.status}` } };

  const pa = Number(tx.pay_amount || tx.amount);
  await creditDeposit({ supabase, user_id: tx.user_id, amount: pa, provider_ref: tx.provider_order_id, description: `OTPay deposit (admin force-credit) — ref ${tx.provider_order_id || tx.merchant_order_id}` });
  await supabase.from('payment_transactions').update({ status: 'paid', pay_amount: pa, updated_at: new Date().toISOString() }).eq('id', tx.id);
  log('otpay.admin-credit', 'force-credited', { merchantOrderId, pa });
  return { status: 200, body: { ok: true, message: 'Force-credited without gateway confirmation' } };
}

// ---------- ADMIN: MARK FAILED ----------
async function adminDepositFail(supabase, merchantOrderId) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).eq('kind', 'deposit').single();
  if (!tx) return { status: 404, body: { error: 'Transaction not found' } };
  if (tx.status !== 'pending') return { status: 400, body: { error: `Already ${tx.status}` } };

  await supabase.from('payment_transactions').update({ status: 'failed', last_error: 'Marked failed by admin', updated_at: new Date().toISOString() }).eq('id', tx.id);
  log('otpay.admin-fail', 'marked failed', { merchantOrderId });
  return { status: 200, body: { ok: true, message: 'Marked as failed' } };
}

// ---------- HANDLER ----------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!CFG.payUrl || !CFG.merchantId || !CFG.appSecret) {
    return res.status(500).json({ error: 'Gateway not configured (missing OTPAY env vars)' });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const action = (req.body?.action || '').toString();

  try {
    // ===== ADMIN ACTIONS =====
    if (action.startsWith('admin-')) {
      const admin = await adminCheck(supabase, req);
      if (!admin) return res.status(403).json({ error: 'Admin access required' });

      let result;
      switch (action) {
        case 'admin-deposit-verify': result = await adminDepositVerify(supabase, req.body.merchantOrderId); break;
        case 'admin-deposit-credit': result = await adminDepositCredit(supabase, req.body.merchantOrderId); break;
        case 'admin-deposit-fail': result = await adminDepositFail(supabase, req.body.merchantOrderId); break;
        default: result = { status: 400, body: { error: 'Unknown admin action' } };
      }
      return res.status(result.status).json(result.body);
    }

    // ===== USER ACTIONS =====
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data } = await supabase.auth.getUser(token);
    if (!data?.user) return res.status(401).json({ error: 'Unauthorized' });

    // BAN enforcement (server-side — blocks API abuse too)
    const { data: prof } = await supabase.from('users').select('is_banned').eq('id', data.user.id).single();
    if (prof?.is_banned) return res.status(403).json({ error: 'Account suspended — contact support' }); 
    let result;
    switch (action) {
      case 'deposit-create': result = await depositCreate(supabase, data.user.id, req.body); break;
      case 'deposit-query': result = await depositQuery(supabase, data.user.id, req.body); break;
      case 'withdraw-create': result = await withdrawCreate(supabase, data.user.id, req.body); break;
      case 'withdraw-query': result = await withdrawQuery(supabase, data.user.id, req.body); break;
      case 'country-validate': result = countryValidate(req.body); break;
      default: result = { status: 400, body: { error: 'Unknown action' } };
    }
    return res.status(result.status).json(result.body);
  } catch (e) {
    log('otpay.handler', 'exception', { action, error: e.message });
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
