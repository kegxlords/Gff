// api/payments/otpay.js
// Handles: action = deposit-create | deposit-query | withdraw-create | withdraw-query | country-validate
const { createClient } = require('@supabase/supabase-js');
const otpay = require('../../lib/otpay');
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
  if (amt < 500) return { status: 400, body: { error: 'Minimum deposit is 500 XAF' } };

  if (country_code) {
    const v = otpay.validateMobile(country_code, mobile);
    if (!v.ok) return { status: 400, body: { error: v.error } };
  }

  const merchantOrderId = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notifyUrl = `${process.env.APP_URL}/api/payments/otpay-callback`;
  const callbackUrl = `${process.env.APP_URL}/payments/return`;

  logger.log('otpay.deposit-create', 'creating', { uid, amount: amt, currency, country_code, merchantOrderId });

  const result = await otpay.createDeposit({
    merchantOrderId, amount: amt, currency: currency || 'XAF', payType: 1,
    firstName: firstName || 'Customer', lastName: lastName || 'GFF',
    mobile: mobile || '', email: email || '', remark: remark || 'GFF Deposit',
    notifyUrl, callbackUrl
  });

  logger.log('otpay.deposit-create', 'response', { status: result.status, code: result.data?.code });

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

  return {
    status: 200,
    body: {
      ok: true,
      merchantOrderId,
      h5Url: result.data.data.h5Url,
      orderId: result.data.data.orderId,
      payType: result.data.data.payType
    }
  };
}

// ============ DEPOSIT QUERY (resolves ambiguous timeouts) ============
async function depositQuery(supabase, uid, body) {
  const { merchantOrderId } = body;
  if (!merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };

  const { data: tx } = await supabase
    .from('payment_transactions')
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
      newStatus = 'paid';
      await supabase.from('payment_transactions').update({
        status: 'paid', provider_order_id: String(result.data.data.orderId || tx.provider_order_id),
        pay_amount: Number(result.data.data.payAmount || tx.amount),
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

// ============ WITHDRAW CREATE ============
async function withdrawCreate(supabase, uid, body) {
  const { amount, currency, country_code, withdrawal_request_id, recipient } = body;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { status: 400, body: { error: 'Invalid amount' } };

  const v = otpay.validateMobile(country_code, recipient?.mobile);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  const { data: req_ } = await supabase
    .from('withdrawal_requests').select('*')
    .eq('id', withdrawal_request_id).eq('user_id', uid).eq('status', 'pending').single();
  if (!req_) return { status: 404, body: { error: 'Withdrawal request not found or not pending' } };

  const { data: card } = await supabase.from('bank_cards').select('*').eq('id', req_.bank_card_id).single();
  if (!card) return { status: 400, body: { error: 'Bank account missing' } };

  const recipientName = (recipient.name || card.account_name || '').trim();
  if (!recipientName) return { status: 400, body: { error: 'Recipient name required' } };

  const fundAccount = otpay.buildPayoutFundAccount(country_code, {
    name: recipientName,
    email: recipient.email || '',
    mobile: recipient.mobile,
    bankCode: recipient.bankCode || card.bank_name,
    accountNumber: recipient.accountNumber || card.account_number,
    idNumber: recipient.idNumber
  });

  const merchantOrderId = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notifyUrl = `${process.env.APP_URL}/api/payments/otpay-callback`;

  logger.log('otpay.withdraw-create', 'submitting', { uid, amount: amt, country_code, merchantOrderId });

  const result = await otpay.createWithdrawal({
    merchantOrderId, amount: amt, currency: currency || 'XAF',
    fundAccount, notifyUrl
  });

  logger.log('otpay.withdraw-create', 'response', { status: result.status, body: result.data });

  const { error: insErr } = await supabase.from('payment_transactions').insert({
    user_id: uid, kind: 'payout', provider: 'otpay', mode: otpay.MODE,
    merchant_order_id: merchantOrderId,
    provider_order_id: result.data?.payoutId ? String(result.data.payoutId) : null,
    amount: amt, currency: currency || 'XAF', status: 'pending',
    country_code, phone: recipient.mobile, email: recipient.email,
    fund_account: fundAccount,
    linked_request_id: withdrawal_request_id,
    meta: { otpayResponse: result.data }
  });
  if (insErr) throw insErr;

  if (result.data?.status === 2) {
    await supabase.from('payment_transactions').update({
      status: 'failed', last_error: result.data?.msg || 'otpay rejected',
      updated_at: new Date().toISOString()
    }).eq('merchant_order_id', merchantOrderId);
  }

  return {
    status: 200,
    body: {
      ok: true,
      merchantOrderId,
      payoutId: result.data?.payoutId,
      status: result.data?.status,
      msg: result.data?.msg
    }
  };
}

// ============ WITHDRAW QUERY (spec 3.1: never retry before querying) ============
async function withdrawQuery(supabase, uid, body) {
  const { merchantOrderId } = body;
  if (!merchantOrderId) return { status: 400, body: { error: 'merchantOrderId required' } };

  const { data: tx } = await supabase
    .from('payment_transactions').select('*')
    .eq('merchant_order_id', merchantOrderId).eq('user_id', uid).single();
  if (!tx) return { status: 404, body: { error: 'Order not found' } };

  const result = await otpay.queryWithdrawal(merchantOrderId);
  logger.log('otpay.withdraw-query', 'response', { status: result.status, body: result.data });

  if (result.status !== 200) {
    return { status: 502, body: { error: 'Gateway query failed', raw: result.data } };
  }

  const q = result.data?.data?.status ?? result.data?.status;
  let newStatus = tx.status;

  if (tx.status === 'pending' || tx.status === 'processing') {
    if (q === 1) {
      newStatus = 'successful';
      if (tx.linked_request_id) {
        await supabase.from('withdrawal_requests').update({
          status: 'approved', admin_note: 'OTPay payout confirmed (query)'
        }).eq('id', tx.linked_request_id);
      }
    } else if (q === 2) {
      newStatus = 'failed';
      const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).single();
      if (wallet) {
        const refund = Number(tx.amount);
        const newBalance = Number(wallet.balance) + refund;
        await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', tx.user_id);
        await supabase.from('wallet_transactions').insert({
          user_id: tx.user_id, type: 'withdrawal_refund', amount: refund,
          description: 'OTPay payout failed (query) — refund', balance_after: newBalance
        });
      }
      if (tx.linked_request_id) {
        await supabase.from('withdrawal_requests').update({
          status: 'rejected', admin_note: 'OTPay payout failed (query) — refunded'
        }).eq('id', tx.linked_request_id);
      }
    } else if (q === 4) {
      newStatus = 'processing';
    }
    await supabase.from('payment_transactions').update({
      status: newStatus, updated_at: new Date().toISOString()
    }).eq('id', tx.id);
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
  if (accountHolder && accountHolder.trim().length < 3) issues.push('recipient name too short');

  return {
    status: 200,
    body: {
      ok: issues.length === 0,
      errors: issues,
      currency: country.currency,
      payoutOperators: country.payoutOperators,
      requiresExtras: country.payoutExtras ? Object.keys(country.payoutExtras) : []
    }
  };
}

// ============ MAIN HANDLER ============
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const action = (req.body?.action || '').toString();

  try {
    // Country validate is public-ish (still require auth for safety)
    const user = await authUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    let result;
    switch (action) {
      case 'deposit-create':   result = await depositCreate(supabase, user.id, req.body); break;
      case 'deposit-query':    result = await depositQuery(supabase, user.id, req.body); break;
      case 'withdraw-create':  result = await withdrawCreate(supabase, user.id, req.body); break;
      case 'withdraw-query':   result = await withdrawQuery(supabase, user.id, req.body); break;
      case 'country-validate': result = countryValidate(req.body); break;
      default:
        result = { status: 400, body: { error: `Unknown action: ${action}` } };
    }

    return res.status(result.status).json(result.body);
  } catch (e) {
    logger.error('otpay.handler', 'exception', { action, error: e.message });
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
