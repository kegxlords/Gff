// api/admin/impersonate.js — admin-only: mint a one-time login link for any user
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: auth, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !auth?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { data: admin } = await supabase.from('users').select('is_admin').eq('id', auth.user.id).single();
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: target } = await supabase.from('users').select('id, email, full_name').eq('email', String(email).toLowerCase()).single();
    if (!target) return res.status(404).json({ error: 'User not found' });

    const redirectTo = (process.env.APP_URL || 'https://gff-ashy.vercel.app') + '/dashboard';
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: target.email,
      options: { redirectTo }
    });
    if (error) return res.status(500).json({ error: error.message });

    const link = data.properties?.action_link || data.action_link;
    if (!link) return res.status(500).json({ error: 'No login link generated' });

    console.log(`[impersonate] admin ${auth.user.id} minted login link for ${target.email}`);
    return res.status(200).json({ ok: true, action_link: link, name: target.full_name });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
