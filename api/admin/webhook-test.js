// api/admin/webhook-test.js — send a dummy withdrawal payload to any URL (admin only)
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
    const url = req.body?.url;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Valid URL required' });

    const { data: s } = await supabase.from('platform_settings').select('withdraw_webhook_secret').eq('id', 1).single();
    const secret = s?.withdraw_webhook_secret || '';
    const dummy = {
      test: true, request_id: 'test-' + Date.now(), user_email: 'test@gff.com',
      user_name: 'Test User', amount: 5000, net_amount: 4250, fee: 750,
      recipient_name: 'John Doe', recipient_mobile: '237670000000',
      country_code: 'CM', operator: 'mtn',
      scheduled_for: new Date().toISOString(), created_at: new Date().toISOString()
    };
    const body = JSON.stringify(dummy);
    const sig = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : '';

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GFF-Event': 'withdrawal.test', 'X-GFF-Signature': sig, 'User-Agent': 'GFF-Webhook/1.0' },
      body
    });
    return res.status(200).json({ ok: true, status: r.status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
