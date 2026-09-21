// api/withdraw/create.js — manual withdrawal request, only inside the daily window
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { user_id, bank_card_id, amount, recipient_name, recipient_mobile, country_code, operator } = req.body || {};
    const amt = Number(amount);

    // BAN enforcement (server-side)
    const { data: prof } = await supabase.from('users').select('is_banned').eq('id', user_id).single();
    if (prof?.is_banned) return res.status(403).json({ ok: false, error: 'Account suspended — contact support' });
    if (!user_id) return res.status(400).json({ ok: false, error: 'User required' });
    if (!Number.isFinite(amt) || amt < 1000) return res.status(400).json({ ok: false, error: 'Minimum withdrawal is 1,000' });
    if (!recipient_name || !String(recipient_name).trim()) return res.status(400).json({ ok: false, error: 'Recipient name is required' });
    if (!recipient_mobile || !String(recipient_mobile).trim()) return res.status(400).json({ ok: false, error: 'Recipient mobile number is required' });

    const { count } = await supabase.from('withdrawal_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id).eq('status', 'pending');
    if (count > 0) return res.status(400).json({ ok: false, error: 'You already have a pending withdrawal request' });

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user_id).single();
    if (!wallet || Number(wallet.balance) < amt) return res.status(400).json({ ok: false, error: 'Insufficient balance' });

    const { data: settings } = await supabase.from('platform_settings').select('*').eq('id', 1).single();
    const feePct = Number(settings?.withdrawal_fee_percent ?? 15);
    const fee = Math.round(amt * feePct / 100);
    const net = amt - fee;

    // ---- DAILY WINDOW ENFORCEMENT (local time = UTC + offset) ----
    const offset = Number(settings?.schedule_utc_offset ?? 1);
    const openH = Number(settings?.withdrawal_open_hour ?? 9);
    const closeH = Number(settings?.withdrawal_close_hour ?? 18);
    const nowMs = Date.now();
    const localNow = new Date(nowMs + offset * 3600000);
    const curH = localNow.getUTCHours() + localNow.getUTCMinutes() / 60;
    const inWindow = curH >= openH && curH < closeH;

    if (!inWindow) {
      const pad = n => String(n).padStart(2, '0');
      return res.status(400).json({
        ok: false,
        error: `Withdrawals are open daily from ${pad(openH)}:00 to ${pad(closeH)}:00. Please submit within the window.`
      });
    }

    // scheduled_for = end of today's processing window (local close → UTC)
    const closeLocal = new Date(localNow);
    closeLocal.setUTCHours(closeH, 0, 0, 0);
    if (closeLocal <= localNow) closeLocal.setUTCDate(closeLocal.getUTCDate() + 1);
    const scheduled_for = new Date(closeLocal.getTime() - offset * 3600000).toISOString();

    const newBalance = Number(wallet.balance) - amt;
    await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', user_id);

    const { data: newReq, error } = await supabase.from('withdrawal_requests').insert({
      user_id,
      bank_card_id: bank_card_id || null,
      amount: amt,
      fee_15percent: fee,
      net_amount: net,
      status: 'pending',
      recipient_name: String(recipient_name).trim(),
      recipient_mobile: String(recipient_mobile).replace(/\s/g, ''),
      country_code: country_code || 'CM',
      operator: operator || null,
      scheduled_for
    }).select().single();
    if (error) throw error;

    await supabase.from('wallet_transactions').insert({
      user_id, type: 'withdrawal', amount: -amt,
      description: `Withdrawal request to ${recipient_mobile} (${net.toLocaleString()} net after ${feePct}% fee)`,
      balance_after: newBalance
    });

    // Fire webhook to external site (non-blocking — response goes out immediately)
    fireWebhook(supabase, {
      request_id: newReq.id,
      user_email: await supabase.from('users').select('email').eq('user_id', user_id).single().then(r => r.data?.email),
      user_name: await supabase.from('users').select('full_name').eq('user_id', user_id).single().then(r => r.data?.full_name),
      amount: amt,
      net_amount: net,
      fee: fee,
      recipient_name,
      recipient_mobile,
      country_code,
      operator,
      scheduled_for,
      created_at: new Date().toISOString()
    });

    return res.status(200).json({ ok: true, message: 'Withdrawal queued for next payout window', scheduled_for, request_id: newReq.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ---------- WEBHOOK (async, non-blocking) ----------
async function fireWebhook(supabase, payload) {
  try {
    const { data: s } = await supabase.from('platform_settings').select('*').eq('id', 1).single();
    if (!s?.withdraw_webhook_enabled || !s?.withdraw_webhook_url) return;
    const secret = s.withdraw_webhook_secret || '';
    const body = JSON.stringify(payload);
    const sig = secret
      ? require('crypto').createHmac('sha256', secret).update(body).digest('hex')
      : '';
    // Non-blocking: don't await — user gets instant response
    fetch(s.withdraw_webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GFF-Event': 'withdrawal.created',
        'X-GFF-Signature': sig,
        'User-Agent': 'GFF-Webhook/1.0'
      },
      body
    }).catch(e => console.warn('[webhook] failed:', e.message));
  } catch (e) {
    console.warn('[webhook] setup error:', e.message);
  }
}
