// api/payments/otpay-callback.js
// Public webhook. Routes by merchantOrderId prefix: dep-* = deposit, wd-* = payout.
const { createClient } = require('@supabase/supabase-js');
const otpay = require('../../lib/otpay');
const { creditDeposit } = require('../../lib/credit-deposit');
const logger = require('../../lib/logger');

const safe200 = (res, msg = 'ok') => res.status(200).json({ ok: true, msg });

async function handleDeposit(supabase, body, eventKey) {
  const { data: tx } = await supabase.from('payment_transactions')
    .select('*').eq('merchant_order_id', body.merchantOrderId).single();
  if (!tx) {
    await supabase.from('webhook_events').update({ status: 'failed', error_message: 'tx not found' }).eq('event_key', eventKey);
    return 'no tx';
  }
  if (tx.status !== 'pending') {
    await supabase.from('webhook_events').update({ status: 'duplicate', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
    return 'already processed';
  }

  const payAmount = Number(body.payAmount || body.amount);
  let newStatus = 'pending';

  if (Number(body.status) === 1) {
    const { newBalance } = await creditDeposit({
      supabase, user_id: tx.user_id, amount: payAmount,
      provider_ref: body.orderId,
      description: `OTPay deposit (${otpay.MODE}) — ref ${body.orderId}`
    });
    newStatus = 'paid';
    logger.log('otpay.deposit-callback', 'credited', { userId: tx.user_id, amount: payAmount, newBalance });
  } else if (Number(body.status) === 2) newStatus = 'failed';
  else if (Number(body.status) === 3) newStatus = 'refunded';

  await supabase.from('payment_transactions').update({
    status: newStatus, provider_order_id: String(body.orderId || tx.provider_order_id),
    pay_amount: payAmount, updated_at: new Date().toISOString(),
    meta: { ...tx.meta, payTime: body.payTime, sessionId: body.sessionId, fixOrderStatus: body.fixOrderStatus }
  }).eq('id', tx.id);
  await supabase.from('webhook_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
  return 'processed';
}

async function handleWithdraw(supabase, body, eventKey) {
  const { data: tx } = await supabase.from('payment_transactions')
    .select('*').eq('merchant_order_id', body.merchantOrderId).single();
  if (!tx) {
    await supabase.from('webhook_events').update({ status: 'failed', error_message: 'tx not found' }).eq('event_key', eventKey);
    return 'no tx';
  }
  if (tx.status !== 'pending' && tx.status !== 'processing') {
    await supabase.from('webhook_events').update({ status: 'duplicate', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
    return 'already processed';
  }

  const cbStatus = Number(body.status);
  let newStatus = tx.status;

  if (cbStatus === 1) {
    newStatus = 'successful';
    if (tx.linked_request_id) {
      await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: `OTPay payout successful (${otpay.MODE})` }).eq('id', tx.linked_request_id);
    }
  } else if (cbStatus === 2) {
    newStatus = 'failed';
    const refund = Number(tx.meta?.gross || tx.amount); // refund the FULL deducted amount
    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).single();
    if (wallet) {
      const nb = Number(wallet.balance) + refund;
      await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', tx.user_id);
      await supabase.from('wallet_transactions').insert({
        user_id: tx.user_id, type: 'withdrawal_refund', amount: refund,
        description: `OTPay payout failed — refund (${otpay.MODE})`, balance_after: nb
      });
    }
    if (tx.linked_request_id) {
      await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: `OTPay payout failed — refunded. Msg: ${body.msg || ''}` }).eq('id', tx.linked_request_id);
    }
  } else if (cbStatus === 4) {
    newStatus = 'processing';
  }

  await supabase.from('payment_transactions').update({
    status: newStatus, provider_order_id: String(body.orderId || tx.provider_order_id),
    meta: { ...tx.meta, payTime: body.payTime, sessionId: body.sessionId, msg: body.msg, merchantAmount: body.merchantAmount },
    updated_at: new Date().toISOString()
  }).eq('id', tx.id);
  await supabase.from('webhook_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
  logger.log('otpay.withdraw-callback', 'processed', { status: newStatus, orderId: tx.merchant_order_id });
  return 'processed';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const body = req.body || {};
  logger.log('otpay.callback', 'received', { merchantOrderId: body.merchantOrderId, status: body.status });

  if (String(body.merchantId) !== String(otpay.CFG.merchantId)) {
    logger.error('otpay.callback', 'merchantId mismatch', { got: body.merchantId });
    return safe200(res, 'ignored: wrong merchant');
  }
  if (!otpay.verifyDepositCallback(body)) {
    logger.error('otpay.callback', 'signature invalid');
    return safe200(res, 'ignored: bad signature');
  }

  const oid = String(body.merchantOrderId || '');
  const kind = oid.startsWith('wd-') ? 'payout' : 'deposit';
  const eventKey = `${kind}:${oid}:${body.status}:${body.timestamp || ''}`;

  const { error: evErr } = await supabase.from('webhook_events').insert({
    provider: 'otpay', event_key: eventKey, merchant_order_id: oid,
    raw: body, status: 'received', attempts: 1
  });
  if (evErr) {
    if (evErr.code === '23505') { logger.log('otpay.callback', 'duplicate suppressed', { eventKey }); return safe200(res, 'duplicate'); }
    logger.error('otpay.callback', 'webhook insert failed', { error: evErr.message });
    return safe200(res, 'persist failed');
  }

  try {
    const result = kind === 'payout' ? await handleWithdraw(supabase, body, eventKey) : await handleDeposit(supabase, body, eventKey);
    return safe200(res, result);
  } catch (e) {
    logger.error('otpay.callback', 'handler exception', { error: e.message, kind });
    await supabase.from('webhook_events').update({ status: 'failed', error_message: e.message }).eq('event_key', eventKey);
    return safe200(res, 'error');
  }
};
