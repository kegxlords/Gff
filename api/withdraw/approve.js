// api/withdraw/approve.js — admin approve = dispatch payout to OTPay
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { payUrl: process.env.OTPAY_LIVE_PAY_URL, merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { payUrl: process.env.OTPAY_TEST_PAY_URL, merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
const fmtAmt = n => Number(n).toFixed(2);
const signCreate = (id, amt) => md5(`merchantId=${CFG.merchantId}&merchantOrderId=${id}&amount=${fmtAmt(amt)}&appSecret=${CFG.appSecret}`);

const COUNTRY = {
  CM: { currency: 'XAF', re: /^237\d{9}$/ },
  CI: { currency: 'XOF', re: /^225\d{8}$/ },
  SN: { currency: 'XOF', re: /^221\d{9}$/ },
  NG: { currency: 'NGN', re: /^234\d{10}$/ },
  GH: { currency: 'GHS', re: /^233\d{9}$/ }
};

async function post(path, body) {
  const res = await fetch(CFG.payUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function adminCheck(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  return profile?.is_admin ? data.user : null;
}

async function refund(supabase, userId, amount, desc) {
  const { data: w } = await supabase.from('wallets').select('*').eq('user_id', userId).single();
  if (!w) return;
  const nb = Number(w.balance) + Number(amount);
  await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', userId);
  await supabase.from('wallet_transactions').insert({ user_id: userId, type: 'withdrawal_refund', amount: Number(amount), description: desc, balance_after: nb });
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
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ error: 'Request not found or already processed' });
    }

    // ================= REJECT (refund) =================
    if (action === 'reject') {
      await refund(supabase, request.user_id, request.amount, 'Withdrawal rejected by admin — refund');
      await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: admin_note || '' }).eq('id', request_id);
      return res.status(200).json({ ok: true, message: 'Rejected & refunded' });
    }

    // ================= APPROVE (dispatch to OTPay) =================
    if (action === 'approve') {
      if (!CFG.payUrl || !CFG.merchantId || !CFG.appSecret) {
        return res.status(500).json({ error: 'Gateway not configured (missing OTPAY env vars)' });
      }

      // Double-dispatch guard: don't pay twice if a payout already exists for this request
      const { data: existing } = await supabase.from('payment_transactions')
        .select('id, status, merchant_order_id')
        .eq('linked_request_id', request.id)
        .in('status', ['pending', 'processing', 'successful'])
        .maybeSingle();
      if (existing) {
        return res.status(400).json({ error: `Payout already dispatched (${existing.status}) — see Gateway monitor: ${existing.merchant_order_id}` });
      }

      // Recipient data from bank card + settings
      const { data: card } = await supabase.from('bank_cards').select('*').eq('id', request.bank_card_id).single();
      const { data: user } = await supabase.from('users').select('email').eq('id', request.user_id).single();
      const { data: settings } = await supabase.from('platform_settings').select('*').eq('id', 1).single();

      const cc = settings?.otpay_country || 'CM';
      const cinfo = COUNTRY[cc] || COUNTRY.CM;
      const bankName = (card?.bank_name || '').toUpperCase();
      const operator = bankName.includes('ORANGE') ? 'orange' : bankName.includes('MTN') ? 'mtn' : (cc === 'CM' ? 'mtn' : cc.toLowerCase());
      const mobile = (card?.account_number || '').replace(/\s/g, '');
      const name = card?.account_name || 'Recipient';

      if (!cinfo.re.test(mobile)) {
        return res.status(400).json({ error: `Payout account "${mobile}" is not a valid ${cc} mobile-money number. Update the user's bank account or reject & pay manually.` });
      }

      const amt = Number(request.net_amount); // pay out the NET amount
      const id = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const base = process.env.APP_URL || 'https://gff-ashy.vercel.app';
      const extra = cc === 'CM' ? { type: operator } : (cc === 'TH' ? { type: 'BANK' } : {});
      const fundAccount = {
        accountType: 'bank_account',
        contact: { name, email: user?.email || '', mobile },
        bankAccount: { bankCode: operator, accountNumber: mobile, extra }
      };

      // Durable payout row BEFORE gateway call
      await supabase.from('payment_transactions').insert({
        user_id: request.user_id, kind: 'payout', provider: 'otpay', mode: MODE,
        merchant_order_id: id, amount: amt, currency: cinfo.currency, status: 'pending',
        country_code: cc, phone: mobile, fund_account: fundAccount,
        linked_request_id: request.id,
        meta: { gross: Number(request.amount), fee: Number(request.fee_15percent), source: 'admin-approve' }
      });

      const r = await post('/api/payout/submit', {
        merchantId: CFG.merchantId, merchantOrderId: id, currency: cinfo.currency,
        amount: fmtAmt(amt), sign: signCreate(id, amt),
        notifyUrl: base + '/api/payments/otpay-callback', fundAccount
      });

      // Gateway rejected at creation → refund + reject request
      if (r.status !== 200 || r.data?.status === 2) {
        await supabase.from('payment_transactions').update({ status: 'failed', last_error: r.data?.msg || 'otpay rejected', updated_at: new Date().toISOString() }).eq('merchant_order_id', id);
        await refund(supabase, request.user_id, request.amount, 'OTPay rejected payout at creation — refund');
        await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: 'OTPay rejected: ' + (r.data?.msg || 'gateway error') }).eq('id', request_id);
        return res.status(502).json({ error: 'OTPay rejected the payout: ' + (r.data?.msg || 'gateway error') + '. User refunded.' });
      }

      // Dispatched successfully
      await supabase.from('payment_transactions').update({ provider_order_id: r.data?.payoutId ? String(r.data.payoutId) : null, meta: { gross: Number(request.amount), fee: Number(request.fee_15percent), source: 'admin-approve', otpayResponse: r.data } }).eq('merchant_order_id', id);
      await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: (admin_note ? admin_note + ' • ' : '') + 'Sent to OTPay: ' + id }).eq('id', request_id);

      return res.status(200).json({ ok: true, message: 'Approved & sent to OTPay', merchantOrderId: id });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('[withdraw/approve] Error:', e);
    return res.status(500).json({ error: e.message });
  }
};
