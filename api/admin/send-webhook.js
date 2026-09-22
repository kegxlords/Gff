// api/admin/send-webhook.js — admin-triggered webhook for pending withdrawals
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { data: prof } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  if (!prof?.is_admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    const { request_id, url } = req.body || {};
    if (!request_id) return res.status(400).json({ error: 'request_id required' });
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Valid URL required' });

    const { data: request } = await supabase.from('withdrawal_requests').select('*, users(email, full_name)').eq('id', request_id).single();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: `Request already ${request.status}` });

    const { data: s } = await supabase.from('platform_settings').select('withdraw_webhook_secret').eq('id', 1).single();
    const secret = s?.withdraw_webhook_secret || '';

    const payload = {
      request_id: request.id,
      user_email: request.users?.email,
      user_name: request.users?.full_name,
      amount: Number(request.amount),
      net_amount: Number(request.net_amount),
      fee: Number(request.fee_15percent),
      recipient_name: request.recipient_name,
      recipient_mobile: request.recipient_mobile,
      country_code: request.country_code,
      operator: request.operator,
      scheduled_for: request.scheduled_for,
      created_at: request.created_at
    };

    const body = JSON.stringify(payload);
    const sig = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : '';

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GFF-Event': 'withdrawal.admin_send',
        'X-GFF-Signature': sig,
        'User-Agent': 'GFF-Webhook/1.0'
      },
      body
    });

    return res.status(200).json({ ok: true, status: r.status, statusText: r.statusText });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
