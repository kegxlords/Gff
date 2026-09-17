const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: auth, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !auth?.user) return res.status(401).json({ error: 'Unauthorized' });
  const uid = auth.user.id;

  try {
    const { data: refs, error } = await supabase
      .from('referrals')
      .select('*, referred:users!referrals_referred_user_id_fkey(id, full_name, created_at)')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const ids = (refs || []).map(r => r.referred?.id).filter(Boolean);
    let depMap = {};
    if (ids.length) {
      const { data: w } = await supabase.from('wallets').select('user_id, total_deposit').in('user_id', ids);
      (w || []).forEach(x => depMap[x.user_id] = Number(x.total_deposit || 0));
    }

    const list = (refs || []).map(r => ({
      name: r.referred?.full_name || 'Member',
      joined: r.created_at,
      deposited: depMap[r.referred?.id] || 0,
      commission: Number(r.commission_earned || 0)
    }));

    return res.status(200).json({
      ok: true,
      stats: {
        total_commission: list.reduce((s, x) => s + x.commission, 0),
        total_referrals: list.length,
        active_referrals: list.filter(x => x.deposited > 0).length
      },
      referrals: list
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
