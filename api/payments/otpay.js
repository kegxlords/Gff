// api/payments/otpay.js
// Actions: deposit-create | deposit-query | withdraw-create | withdraw-query | country-validate
const { createClient } = require('@supabase/supabase-js');
const otpay = require('../../lib/otpay');
const { creditDeposit } = require('../../lib/credit-deposit');
const logger = require('../../lib/logger');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function authUser(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data } = await supabase.auth.getUser(token);
  return data?.user || null;
}

// ============ DEPOSIT CREATE ============
async function depositCreate(supabase, uid, body) {
  const { amount, currency, country_code, mobile, email, firstName, lastName, remark } = body;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { status: 400, body: { error: 'Invalid amount' } };
  if (amt < 500) return { status: 400, body: { error: 'Minimum deposit is 500' } };

  if (country_code) {
    const v = otpay.validateMobile(country_code, mobile);
    if (!v.ok) return { status: 400, body: { error: v.error } };
  }

  const merchantOrderId = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notifyUrl = `${process.env.APP_URL}/api/payments/otpay-callback`;
  const callbackUrl = `${process.env.APP_URL}/payments/return`;

  logger.log('otpay.deposit-create', 'creating', { uid, amount: amt, country_code, merchantOrderId });

  const result = await otpay.createDeposit({
    merchantOrderId, amount: amt, currency: currency || 'XAF', payType: 1,
    firstName: firstName || 'Customer', lastName: lastName || 'GFF',
    mobile: mobile || '', email: email || '', remark: remark || 'GFF Deposit',
    notifyUrl, callbackUrl
  });

  if (result.status !== 200 || result.data?.code !== 0) {
    logger.error('otpay.deposit-create', 'rejected', result.data);
    return { status: 502, body: { error: result.data?.error || 'Gateway error', raw: result.data } };
  }

  const { error: insErr } = await supabase.from('payment_transactions').insert({
    user_id: uid, kind: 'deposit', provider: 'otpay', mode: otpay.MODE,
    merchant_order_id: merchantOrderId,
    provider_order_id: String(result.data.data.orderId || ''),
    amount: amt, currency: currency || 'XAF', status: 'pending',
    country_code, phone: mobile, email,
    meta: { h5Url: result.data.data.h5Url, payType: result.data.data.payType }
  });
  if (insErr) throw insErr;

  return { status: 200, body: { ok: true, merchantOrderId, h5Url: result.data.data.h5Url, orderId: result.data.data.orderId, payType: result.data.data.payType } };
}

// ============ DEPOSIT QUERY ============
async function depositQuery(supabase, uid, body) {
  const { merchantOrderId } = body;
  if (!merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };

  const { data: tx } = await supabase.from('payment_transactions')
    .select('*').eq('merchant_order_id', merchantOrderId).eq('user_id', uid).single();
  if (!tx) return { status: 404, body: { error: 'Order not found' } };

  const result = await otpay.queryDeposit(merchantOrderId);
  logger.log('otpay.deposit-query', 'response', { status: result.status, body: result.data });
  if (result.status !== 200 || result.data?.code !== 0) {
    return { status: 502, body: { error: 'Gateway query failed', raw: result.data } };
  }

  const qStatus = result.data.data.status;
  let newStatus = tx.status;

  if (tx.status === 'pending') {
    if (qStatus === 1) {
      const payAmount = Number(result.data.data.payAmount || tx.amount);
      await creditDeposit({
        supabase, user_id: tx.user_id, amount: payAmount,
        provider_ref: result.data.data.orderId,
        description: `OTPay deposit (resolved via query) — ref ${result.data.data.orderId}`
      });
      newStatus = 'paid';
      await supabase.from('payment_transactions').update({
        status: 'paid', pay_amount: payAmount,
        provider_order_id: String(result.data.data.orderId || tx.provider_order_id),
        updated_at: new Date().toISOString()
      }).eq('id', tx.id);
    } else if (qStatus === 2) {
      newStatus = 'failed';
      await supabase.from('payment_transactions').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', tx.id);
    } else if (qStatus === 3) {
      newStatus = 'refunded';
      await supabase.from('payment_transactions').update({ status: 'refunded', updated_at: new Date().toISOString() }).eq('id', tx.id);
    }
  }
  return { status: 200, body: { ok: true, status: newStatus, gatewayStatus: qStatus } };
}

// ============ WITHDRAW CREATE (self-contained: request + debit + payout) ============
async function withdrawCreate(supabase, uid, body) {
  const { amount, currency, country_code, recipient } = body;
  const amt = Number(amount); // GROSS amount deducted from wallet
  if (!Number.isFinite(amt) || amt <= 0) return { status: 400, body: { error: 'Invalid amount' } };
  if (amt < 1000) return { status: 400, body: { error: 'Minimum withdrawal is 1,000' } };

  const v = otpay.validateMobile(country_code, recipient?.mobile);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const recipientName = (recipient?.name || '').trim();
  if (recipientName.length < 3) return { status: 400, body: { error: 'Recipient name required (must match account)' } };

  // Fee from platform settings
  const { data: settings } = await supabase.from('platform_settings').select('withdrawal_fee_percent').eq('id', 1).single();
  const feePct = Number(settings?.withdrawal_fee_percent ?? 15);
  const fee = Math.round(amt * feePct / 100);
  const net = amt - fee; // amount actually paid out

  // Block duplicate pending payouts
  const { count: pend } = await supabase.from('payment_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', uid).eq('kind', 'payout').in('status', ['pending', 'processing']);
  if (pend > 0) return { status: 400, body: { error: 'You already have a pending payout' } };

  // Balance check
  const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', uid).single();
  if (!wallet || Number(wallet.balance) < amt) return { status: 400, body: { error: 'Insufficient balance' } };

  // Build fund account (country-specific extras + CM operator)
  const fundAccount = otpay.buildPayoutFundAccount(country_code, {
    name: recipientName,
    email: recipient.email || '',
    mobile: recipient.mobile,
    bankCode: recipient.bankCode || recipient.operator || country_code,
    accountNumber: recipient.mobile,
    idNumber: recipient.idNumber
  });
  if (country_code === 'CM' && recipient.operator) fundAccount.bankAccount.extra.type = recipient.operator;

  const merchantOrderId = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notifyUrl = `${process.env.APP_URL}/api/payments/otpay-callback`;

  // 1) Create withdrawal request (pending)
  const { data: newReq, error: reqErr } = await supabase.from('withdrawal_requests').insert({
    user_id: uid, bank_card_id: recipient.bank_card_id || null,
    amount: amt, fee_15percent: fee, net_amount: net, status: 'pending'
  }).select().single();
  if (reqErr) throw reqErr;

  // 2) Deduct wallet + log
  const newBalance = Number(wallet.balance) - amt;
  await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', uid);
  await supabase.from('wallet_transactions').insert({
    user_id: uid, type: 'withdrawal', amount: -amt,
    description: `OTPay payout request (${net.toLocaleString()} net after ${feePct}% fee)`,
    balance_after: newBalance
  });

  // 3) Durable payout record BEFORE gateway call
  const { error: txErr } = await supabase.from('payment_transactions').insert({
    user_id: uid, kind: 'payout', provider: 'otpay', mode: otpay.MODE,
    merchant_order_id: merchantOrderId,
    amount: net, currency: currency || 'XAF', status: 'pending',
    country_code, phone: recipient.mobile, email: recipient.email,
    fund_account: fundAccount, linked_request_id: newReq.id,
    meta: { gross: amt, fee }
  });
  if (txErr) throw txErr;

  // 4) Submit payout (NET amount)
  logger.log('otpay.withdraw-create', 'submitting', { uid, gross: amt, net, country_code, merchantOrderId });
  let result;
  try {
    result = await otpay.createWithdrawal({ merchantOrderId, amount: net, currency: currency || 'XAF', fundAccount, notifyUrl });
  } catch (e) {
    // Ambiguous timeout: DO NOT refund or retry — resolve via query/callback
    logger.error('otpay.withdraw-create', 'ambiguous timeout', { merchantOrderId, error: e.message });
    return { status: 502, body: { ok: false, ambiguous: true, merchantOrderId, error: 'Gateway timeout — status will resolve via query/callback' } };
  }

  logger.log('otpay.withdraw-create', 'response', { status: result.status, body: result.data });

  // Immediate rejection → refund gross + reject request
  if (result.status !== 200 || result.data?.status === 2) {
    await supabase.from('payment_transactions').update({
      status: 'failed', last_error: result.data?.msg || 'otpay rejected', updated_at: new Date().toISOString()
    }).eq('merchant_order_id', merchantOrderId);
    await supabase.from('wallets').update({ balance: Number(wallet.balance), updated_at: new Date().toISOString() }).eq('user_id', uid);
    await supabase.from('wallet_transactions').insert({
      user_id: uid, type: 'withdrawal_refund', amount: amt,
      description: 'OTPay payout rejected at creation — refund', balance_after: Number(wallet.balance)
    });
    await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: 'OTPay rejected at creation' }).eq('id', newReq.id);
    return { status: 502, body: { ok: false, error: result.data?.msg || 'Payout rejected', refunded: true } };
  }

  await supabase.from('payment_transactions').update({
    provider_order_id: result.data?.payoutId ? String(result.data.payoutId) : null,
    meta: { gross: amt, fee, otpayResponse: result.data }
  }).eq('merchant_order_id', merchantOrderId);

  return { status: 200, body: { ok: true, merchantOrderId, payoutId: result.data?.payoutId, status: result.data?.status, net, fee } };
}

// ============ WITHDRAW QUERY ============
async function withdrawQuery(supabase, uid, body) {
  const { merchantOrderId } = body;
  if (!merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };

  const { data: tx } = await supabase.from('payment_transactions').select('*')
    .eq('merchant_order_id', merchantOrderId).eq('user_id', uid).single();
  if (!tx) return { status: 404, body: { error: 'Order not found' } };

  const result = await otpay.queryWithdrawal(merchantOrderId);
  logger.log('otpay.withdraw-query', 'response', { status: result.status, body: result.data });
  if (result.status !== 200) return { status: 502, body: { error: 'Gateway query failed', raw: result.data } };

  const q = result.data?.data?.status ?? result.data?.status;
  let newStatus = tx.status;

  if (tx.status === 'pending' || tx.status === 'processing') {
    if (q === 1) {
      newStatus = 'successful';
      if (tx.linked_request_id) {
        await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: 'OTPay payout confirmed (query)' }).eq('id', tx.linked_request_id);
      }
    } else if (q === 2) {
      newStatus = 'failed';
      const refund = Number(tx.meta?.gross || tx.amount);
      const { data: w } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).single();
      if (w) {
        const nb = Number(w.balance) + refund;
        await supabase.from('wallets').update({ balance: nb, updated_at: new Date().toISOString() }).eq('user_id', tx.user_id);
        await supabase.from('wallet_transactions').insert({
          user_id: tx.user_id, type: 'withdrawal_refund', amount: refund,
          description: 'OTPay payout failed (query) — refund', balance_after: nb
        });
      }
      if (tx.linked_request_id) {
        await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: 'OTPay payout failed (query) — refunded' }).eq('id', tx.linked_request_id);
      }
    } else if (q === 4) {
      newStatus = 'processing';
    }
    await supabase.from('payment_transactions').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', tx.id);
  }
  return { status: 200, body: { ok: true, status: newStatus, gatewayStatus: q } };
}

// ============ COUNTRY VALIDATE ============
function countryValidate(body) {
  const { country_code, mobile, accountHolder, bankCode, accountNumber } = body;
  const country = otpay.COUNTRY[country_code];
  if (!country) return { status: 400, body: { ok: false, error: `Unsupported country: ${country_code}` } };
  const m = otpay.validateMobile(country_code, mobile);
  if (!m.ok) return { status: 200, body: { ok: false, error: m.error } };
  const issues = [];
  if (country_code === 'NG' && !bankCode) issues.push('bankCode required for Nigeria');
  if (country_code === 'PE' && !accountNumber) issues.push('interBankAccount required for Peru');
  if (country_code === 'CO' && !accountHolder) issues.push('account holder name required for Colombia');
  return { status: 200, body: { ok: issues.length === 0, errors: issues, currency: country.currency, payoutOperators: country.payoutOperators, requiresExtras: country.payoutExtras ? Object.keys(country.payoutExtras) : [] } };
}

// ============ MAIN HANDLER ============
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const action = (req.body?.action || '').toString();

  try {
    const user = await authUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    let result;
    switch (action) {
      case 'deposit-create':   result = await depositCreate(supabase, user.id, req.body); break;
      case 'deposit-query':    result = await depositQuery(supabase, user.id, req.body); break;
      case 'withdraw-create':  result = await withdrawCreate(supabase, user.id, req.body); break;
      case 'withdraw-query':   result = await withdrawQuery(supabase, user.id, req.body); break;
      case 'country-validate': result = countryValidate(req.body); break;
      default: result = { status: 400, body: { error: `Unknown action: ${action}` } };
    }
    return res.status(result.status).json(result.body);
  } catch (e) {
    logger.error('otpay.handler', 'exception', { action, error: e.message });
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
