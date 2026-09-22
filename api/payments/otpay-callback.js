// api/payments/otpay-callback.js — OTPay webhook + external payout webhook receiver (dual-mode)
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MODE = process.env.OTPAY_MODE === 'live' ? 'live' : 'test';
const CFG = MODE === 'live'
  ? { merchantId: process.env.OTPAY_LIVE_MERCHANT_ID, appSecret: process.env.OTPAY_LIVE_APP_SECRET }
  : { merchantId: process.env.OTPAY_TEST_MERCHANT_ID, appSecret: process.env.OTPAY_TEST_APP_SECRET };

// ---------- SIGNING / VERIFY ----------
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
const fmtAmt = n => Number(n).toFixed(2);
const signCreate = (id, amt) => md5(`merchantId=${CFG.merchantId}&merchantOrderId=${id}&amount=${fmtAmt(amt)}&appSecret=${CFG.appSecret}`);
const verifyCb = b => !!(b && b.sign) && signCreate(b.merchantOrderId, b.amount) === String(b.sign).toLowerCase();

// ---------- REDACTED LOGGER ----------
const REDACT = ['appSecret', 'sign', 'mobile', 'email', 'accountNumber'];
function redact(o, d = 0) {
  if (d > 8) return '[redacted]';
  if (o === null || o === undefined || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(x => redact(x, d + 1));
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = REDACT.includes(k) ? '[REDACTED]' : redact(v, d + 1);
  return out;
}
const log = (t, m, d) => console.log(`[${new Date().toISOString()}] [${t}] ${m}${d ? ' ' + JSON.stringify(redact(d)) : ''}`);
const safe200 = (res, msg) => res.status(200).json({ ok: true, msg });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- CREDIT DEPOSIT (wallet auto-create + referral bonus) ----------
async function creditDeposit({ supabase, user_id, amount, provider_ref, description }) {
  let { data: wallet, error } = await supabase.from('wallets').select('*').eq('user_id', user_id).maybeSingle();

  if (error || !wallet) {
    const { data: newWallet, error: insertErr } = await supabase.from('wallets').insert({
      user_id, balance: 0, total_deposit: 0, total_profit: 0, total_referral_earnings: 0,
      updated_at: new Date().toISOString()
    }).select().single();
    if (insertErr) throw new Error('Failed to create wallet: ' + insertErr.message);
    wallet = newWallet;
    log('otpay.callback', 'wallet auto-created', { user_id });
  }

  const amt = Number(amount);
  const nb = Number(wallet.balance) + amt;
  await supabase.from('wallets').update({ balance: nb, total_deposit: Number(wallet.total_deposit || 0) + amt, updated_at: new Date().toISOString() }).eq('user_id', user_id);
  await supabase.from('wallet_transactions').insert({ user_id, type: 'deposit', amount: amt, description, balance_after: nb });

  const { data: st } = await supabase.from('platform_settings').select('referral_bonus_percent').eq('id', 1).single();
  const pct = Number(st?.referral_bonus_percent ?? 22);
  const { data: user } = await supabase.from('users').select('referred_by').eq('id', user_id).single();
  if (user?.referred_by) {
    const comm = Math.round(amt * pct / 100);
    const { data: rw } = await supabase.from('wallets').select('*').eq('user_id', user.referred_by).single();
    if (rw) {
      const rb = Number(rw.balance) + comm;
      await supabase.from('wallets').update({ balance: rb, total_referral_earnings: Number(rw.total_referral_earnings || 0) + comm, updated_at: new Date().toISOString() }).eq('user_id', user.referred_by);
      await supabase.from('wallet_transactions').insert({ user_id: user.referred_by, type: 'referral_bonus', amount: comm, description: pct + '% commission on downline deposit [' + user_id + ']', balance_after: rb });
    }
  }
  return { newBalance: nb };
}

// ---------- OTPay DEPOSIT CALLBACK ----------
async function handleDeposit(supabase, body, eventKey) {
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', body.merchantOrderId).single();
  if (!tx) {
    await supabase.from('webhook_events').update({ status: 'failed', error_message: 'tx not found' }).eq('event_key', eventKey);
    return 'no tx';
  }
  if (tx.status !== 'pending') {
    await supabase.from('webhook_events').update({ status: 'duplicate', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
    return 'already processed';
  }

  const payAmount = Number(body.payAmount || body.amount);
  let st = 'pending';
  if (Number(body.status) === 1) {
    const { newBalance } = await creditDeposit({ supabase, user_id: tx.user_id, amount: payAmount, provider_ref: body.orderId, description: `OTPay deposit (${MODE}) — ref ${body.orderId}` });
    st = 'paid';
    log('otpay.deposit-callback', 'credited', { userId: tx.user_id, amount: payAmount, newBalance });
  } else if (Number(body.status) === 2) st = 'failed';
  else if (Number(body.status) === 3) st = 'refunded';

  await supabase.from('payment_transactions').update({
    status: st, provider_order_id: String(body.orderId || tx.provider_order_id), pay_amount: payAmount,
    updated_at: new Date().toISOString(), meta: { ...tx.meta, payTime: body.payTime, sessionId: body.sessionId }
  }).eq('id', tx.id);
  await supabase.from('webhook_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
  return 'processed';
}

// ---------- OTPay PAYOUT CALLBACK (single-winner refund) ----------
async function handleWithdraw(supabase, body, eventKey) {
  const merchantOrderId = String(body.merchantOrderId || '');
  const { data: tx } = await supabase.from('payment_transactions').select('*').eq('merchant_order_id', merchantOrderId).maybeSingle();
  if (!tx) {
    await supabase.from('webhook_events').update({ status: 'failed', error_message: 'payout transaction not found' }).eq('event_key', eventKey);
    return 'no tx';
  }
  if (tx.status !== 'pending' && tx.status !== 'processing') {
    await supabase.from('webhook_events').update({ status: 'duplicate', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
    return 'already processed';
  }

  const cb = Number(body.status);
  let st = tx.status;
  if (cb === 1) {
    st = 'successful';
    if (tx.linked_request_id) await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: `OTPay payout successful (${MODE})` }).eq('id', tx.linked_request_id);
  } else if (cb === 2) {
    st = 'failed';
    if (tx.linked_request_id) {
      const { data: flipped } = await supabase.from('withdrawal_requests')
        .update({ status: 'rejected', admin_note: `OTPay payout failed — refunded (${body.msg || ''})` })
        .eq('id', tx.linked_request_id).in('status', ['pending', 'approved']).select();
      if (flipped && flipped.length) {
        const refund = Number(tx.meta?.gross || tx.amount);
        const { data: w } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).single();
        if (w) {
          const nb = Number(w.balance) + refund;
          await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', tx.user_id);
          await supabase.from('wallet_transactions').insert({ user_id: tx.user_id, type: 'withdrawal_refund', amount: refund, description: `OTPay payout failed — refund (${MODE})`, balance_after: nb });
        }
      } else {
        log('otpay.withdraw-callback', 'refund skipped — request already settled', { requestId: tx.linked_request_id });
      }
    }
  } else if (cb === 4) st = 'processing';

  await supabase.from('payment_transactions').update({
    status: st, provider_order_id: String(body.orderId || tx.provider_order_id),
    meta: { ...(tx.meta || {}), payTime: body.payTime, sessionId: body.sessionId, msg: body.msg },
    updated_at: new Date().toISOString()
  }).eq('id', tx.id);
  await supabase.from('webhook_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
  log('otpay.withdraw-callback', 'processed', { status: st, id: tx.merchant_order_id });
  return 'processed';
}

// ---------- EXTERNAL PAYOUT WEBHOOK (pcmedia.online etc.) ----------
async function handleExternalWebhook(req, res, supabase, externalId) {
  const body = req.body || {};
  const requestId = externalId || body.request_id || body.id;
  const status = String(body.status || '').toLowerCase();
  // Signature check removed by design — external callbacks accepted without HMAC

  const { data: request } = await supabase.from('withdrawal_requests').select('*').eq('id', requestId).single();
  if (!request) return safe200(res, 'external: withdrawal not found');

  const isPaid = ['paid', 'success', 'successful', '1', 'approved', 'completed'].includes(status);
  const isFailed = ['failed', 'rejected', 'error', '2', 'declined'].includes(status);
  if (!isPaid && !isFailed) return safe200(res, 'external: status ignored');
  if (request.status !== 'pending') return safe200(res, `external: already ${request.status}`);

  if (isPaid) {
    await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: 'Auto-approved via external webhook' }).eq('id', requestId);
    log('otpay.callback', 'external approved', { requestId });
    return safe200(res, 'external: approved');
  }

  const { data: flipped } = await supabase.from('withdrawal_requests')
    .update({ status: 'rejected', admin_note: 'Auto-rejected via external webhook (failed)' })
    .eq('id', requestId).in('status', ['pending', 'approved']).select();
  if (flipped && flipped.length) {
    const { data: w } = await supabase.from('wallets').select('*').eq('user_id', request.user_id).single();
    if (w) {
      const nb = Number(w.balance) + Number(request.amount);
      await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', request.user_id);
      await supabase.from('wallet_transactions').insert({ user_id: request.user_id, type: 'withdrawal_refund', amount: Number(request.amount), description: 'External payout failed — refund via webhook', balance_after: nb });
    }
    log('otpay.callback', 'external failed+refunded', { requestId });
    return safe200(res, 'external: failed & refunded');
  }
  return safe200(res, 'external: failed (already settled)');
}

// ---------- HANDLER (dual-mode router) ----------
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const body = req.body || {};
  log('otpay.callback', 'received', { id: body.merchantOrderId || body.request_id || body.id, status: body.status });

  // ===== MODE 1: EXTERNAL WEBHOOK (UUID payload or X-GFF-Signature header, no OTPay sign) =====
  const sigHeader = req.headers['x-gff-signature'];
  const externalId = body.request_id || body.withdrawal_id ||
    (UUID_RE.test(String(body.merchantOrderId || '')) ? body.merchantOrderId : null) ||
    (UUID_RE.test(String(body.id || '')) ? body.id : null);
  if (sigHeader !== undefined || (externalId && !body.sign)) {
    return handleExternalWebhook(req, res, supabase, externalId);
  }

  // ===== MODE 2: OTPAY WEBHOOK (signature-verified) =====
  if (String(body.merchantId) !== String(CFG.merchantId)) return safe200(res, 'ignored: wrong merchant');
  if (!verifyCb(body)) { log('otpay.callback', 'bad signature'); return safe200(res, 'ignored: bad signature'); }

  const oid = String(body.merchantOrderId || '');
  if (!oid) return safe200(res, 'ignored: missing merchantOrderId');

  const { data: existingTx } = await supabase.from('payment_transactions').select('id, linked_request_id').eq('merchant_order_id', oid).maybeSingle();
  const kind = existingTx?.linked_request_id ? 'payout' : 'deposit';
  const eventKey = `${kind}:${oid}:${body.status}:${body.timestamp || ''}`;

  const { error: evErr } = await supabase.from('webhook_events').insert({
    provider: 'otpay', event_key: eventKey, merchant_order_id: oid, raw: body, status: 'received', attempts: 1
  });
  if (evErr) {
    if (evErr.code === '23505') return safe200(res, 'duplicate');
    return safe200(res, 'persist failed');
  }

  try {
    const msg = kind === 'payout' ? await handleWithdraw(supabase, body, eventKey) : await handleDeposit(supabase, body, eventKey);
    return safe200(res, msg);
  } catch (e) {
    log('otpay.callback', 'exception', { error: e.message });
    await supabase.from('webhook_events').update({ status: 'failed', error_message: e.message }).eq('event_key', eventKey);
    return safe200(res, 'error');
  }
};
