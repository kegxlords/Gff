const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: auth, error } = await supabase.auth.getUser(token);
  if (error || !auth?.user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: admin } = await supabase.from('users').select('is_admin').eq('id', auth.user.id).single();
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    const { recipient_id, title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

    const { error: insErr } = await supabase.from('messages').insert({
      sender_id: auth.user.id,
      recipient_id: recipient_id || null,
      title: String(title).trim(),
      content: String(content).trim(),
      is_broadcast: !recipient_id
    });
    if (insErr) throw insErr;

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
