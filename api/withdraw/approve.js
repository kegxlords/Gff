// api/withdraw/approve.js
// actions: approve = mark paid manually | dispatch = send via OTPay | reject = refund
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
const fmtAmt = n => Number(n).toFixed(2);
const signCreate = (id, amt) => md5(`merchantId=${CFG.merchantId}&merchantOrderId=${id}&amount=${fmtAmt(amt)}&appSecret=${CFG.appSecret}`);

const PROXY = process.env.PAYOUT_PROXY_URL || '';
const PROXY_KEY = process.env.PAYOUT_PROXY_KEY || '';
function payoutUrl(path) { return (PROXY && path.startsWith('/api/payout/')) ? PROXY + path : CFG.payUrl + path; }
function payoutHeaders() { return (PROXY && PROXY_KEY) ? { 'X-Proxy-Key': PROXY_KEY } : {}; }

const COUNTRY = {
  CM: { currency: 'XAF', re: /^237\d{9}$/ },
  CI: { currency: 'XOF', re: /^225\d{8}$/ },
  SN: { currency: 'XOF', re: /^221\d{9}$/ },
  NG: { currency: 'NGN', re: /^234\d{10}$/ },
  GH: { currency: 'GHS', re: /^233\d{9}$/ }
};

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

async function adminCheck(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  return profile?.is_admin ? data.user : null;
}

// Single-winner refund: atomic flip pending|approved -> rejected
async function settleReject(supabase, requestId, adminNote, refundDescription) {
  const { data: flipped } = await supabase.from('withdrawal_requests')
    .update({ status: 'rejected', admin_note: adminNote })
    .eq('id', requestId)
    .in('status', ['pending', 'approved'])
    .select();
  if (!flipped || flipped.length === 0) return { refunded: false };
  const request = flipped[0];
  const { data: w } = await supabase.from('wallets').select('*').eq('user_id', request.user_id).single();
  if (!w) return { refunded: false };
  const nb = Number(w.balance) + Number(request.amount);
  await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', request.user_id);
  await supabase.from('wallet_transactions').insert({
    user_id: request.user_id, type: 'withdrawal_refund', amount: Number(request.amount),
    description: refundDescription || 'Withdrawal rejected — refund', balance_after: nb
  });
  return { refunded: true, amount: Number(request.amount) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const admin = await adminCheck(supabase, req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    const { action, request_id, admin_note } = req.body;
    const { data: request } = await supabase.from('withdrawal_requests').select('*').eq('id', request_id).single();
    if (!request) return res.status(400).json({ error: 'Request not found' });

    // ================= REJECT (single refund) =================
    if (action === 'reject') {
      if (request.status !== 'pending') return res.status(400).json({ error: `Request already ${request.status}` });
      const { data: linked } = await supabase.from('payment_transactions')
        .select('id, status, merchant_order_id').eq('linked_request_id', request.id);
      const inflight = (linked || []).find(x => ['pending', 'processing', 'successful'].includes(x.status));
      if (inflight) {
        return res.status(400).json({ error: `Cannot reject: payout ${inflight.merchant_order_id} is ${inflight.status.toUpperCase()} at gateway. Resolve in Gateway monitor first.` });
      }
      const settle = await settleReject(supabase, request.id, admin_note || 'Rejected by admin', 'Withdrawal rejected by admin — refund');
      return res.status(200).json({ ok: true, message: settle.refunded ? 'Rejected & refunded' : 'Already settled — no refund issued' });
    }

    // ================= APPROVE = MANUAL PAID (no gateway) =================
    if (action === 'approve') {
      if (request.status !== 'pending') return res.status(400).json({ error: `Request already ${request.status}` });
      const { data: linked } = await supabase.from('payment_transactions')
        .select('id, status, merchant_order_id').eq('linked_request_id', request.id);
      const inflight = (linked || []).find(x => ['pending', 'processing', 'successful'].includes(x.status));
      if (inflight) {
        return res.status(400).json({ error: `This request was sent to OTPay (${inflight.status}). Use Gateway monitor, not manual pay.` });
      }
      await supabase.from('withdrawal_requests').update({
        status: 'approved',
        admin_note: (admin_note ? admin_note + ' • ' : '') + 'Paid manually by admin'
      }).eq('id', request_id);
      return res.status(200).json({ ok: true, message: 'Marked as paid (manual)' });
    }

    // ================= DISPATCH = SEND VIA OTPAY =================
    if (action === 'dispatch') {
      if (request.status !== 'pending') return res.status(400).json({ error: `Request already ${request.status}` });
      if (!CFG.payUrl || !CFG.merchantId || !CFG.appSecret) return res.status(500).json({ error: 'Gateway not configured' });

      const { data: linked } = await supabase.from('payment_transactions')
        .select('id, status, merchant_order_id, created_at')
        .eq('linked_request_id', request.id).order('created_at', { ascending: false });
      const rows = linked || [];
      const completed = rows.find(x => x.status === 'successful');
      if (completed) return res.status(400).json({ error: `Payout already COMPLETED (${completed.merchant_order_id})` });
      const fresh = rows.find(x => (x.status === 'pending' || x.status === 'processing') && (Date.now() - new Date(x.created_at).getTime()) < 30 * 60 * 1000);
      if (fresh) return res.status(400).json({ error: `Payout dispatched <30 min ago (${fresh.merchant_order_id}) — wait or retry later` });

      const { data: card } = request.bank_card_id
        ? await supabase.from('bank_cards').select('*').eq('id', request.bank_card_id).single()
        : { data: null };
      const { data: user } = await supabase.from('users').select('email').eq('id', request.user_id).single();
      const { data: settings } = await supabase.from('platform_settings').select('*').eq('id', 1).single();

      const cc = request.country_code || settings?.otpay_country || 'CM';
      const cinfo = COUNTRY[cc] || COUNTRY.CM;
      const bankName = (card?.bank_name || '').toUpperCase();
      const operator = request.operator || (bankName.includes('ORANGE') ? 'orange' : bankName.includes('MTN') ? 'mtn' : (cc === 'CM' ? 'mtn' : cc.toLowerCase()));
      const mobile = (request.recipient_mobile || card?.account_number || '').replace(/\s/g, '');
      const name = request.recipient_name || card?.account_name || 'Recipient';

      if (!cinfo.re.test(mobile)) return res.status(400).json({ error: `Payout account "${mobile}" is not a valid ${cc} mobile-money number.` });

      const amt = Number(request.net_amount);
      const id = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const base = process.env.APP_URL || 'https://gff-ashy.vercel.app';
      const extra = cc === 'CM' ? { type: operator } : (cc === 'TH' ? { type: 'BANK' } : {});
      const fundAccount = {
        accountType: 'bank_account',
        contact: { name, email: user?.email || '', mobile },
        bankAccount: { bankCode: operator, accountNumber: mobile, extra }
      };

      await supabase.from('payment_transactions').insert({
        user_id: request.user_id, kind: 'payout', provider: 'otpay', mode: MODE,
        merchant_order_id: id, amount: amt, currency: cinfo.currency, status: 'pending',
        country_code: cc, phone: mobile, fund_account: fundAccount,
        linked_request_id: request.id,
        meta: { gross: Number(request.amount), fee: Number(request.fee_15percent), source: 'admin-dispatch' }
      });

      console.log('[withdraw/dispatch] sending', JSON.stringify({ id, cc, mobile, amt }));
      let r;
      try {
        r = await post('/api/payout/submit', {
          merchantId: CFG.merchantId, merchantOrderId: id, currency: cinfo.currency,
          amount: fmtAmt(amt), sign: signCreate(id, amt),
          notifyUrl: base + '/api/payments/otpay-callback', fundAccount
        }, 15000, payoutHeaders());
      } catch (e) {
        console.log('[withdraw/dispatch] timeout/network error', { id, error: e.message });
        await supabase.from('payment_transactions').update({ status: 'failed', last_error: e.timeout ? 'Gateway timeout (status unknown)' : 'Network error', updated_at: new Date().toISOString() }).eq('merchant_order_id', id);
        return res.status(502).json({ error: e.timeout ? 'OTPay did not respond in 15s — check Gateway monitor, retry later.' : 'Network error: ' + e.message });
      }
      console.log('[withdraw/dispatch] gateway response', JSON.stringify({ status: r.status, body: r.data }));

      const codeBad = r.data && r.data.code !== undefined && Number(r.data.code) !== 0;
      if (r.status !== 200 || !r.data || codeBad || r.data.status === 2) {
        const errMsg = (r.data?.error || r.data?.msg || 'OTPay rejected') + (r.data?.code !== undefined ? ' [code ' + r.data.code + ']' : '');
        await supabase.from('payment_transactions').update({ status: 'failed', last_error: errMsg, updated_at: new Date().toISOString() }).eq('merchant_order_id', id);
        const settle = await settleReject(supabase, request.id, 'OTPay rejected: ' + errMsg, 'OTPay rejected payout at creation — refund');
        return res.status(502).json({ error: 'OTPay rejected: ' + errMsg + (settle.refunded ? '. User refunded.' : '. Already settled.') });
      }

      await supabase.from('payment_transactions').update({ provider_order_id: r.data?.payoutId ? String(r.data.payoutId) : null, meta: { gross: Number(request.amount), fee: Number(request.fee_15percent), source: 'admin-dispatch', otpayResponse: r.data } }).eq('merchant_order_id', id);
      await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: (admin_note ? admin_note + ' • ' : '') + 'Sent to OTPay: ' + id }).eq('id', request_id);
      return res.status(200).json({ ok: true, message: 'Sent to OTPay', merchantOrderId: id });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('[withdraw/approve] Error:', e);
    return res.status(500).json({ error: e.message });
  }
};
