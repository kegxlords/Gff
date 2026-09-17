const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { user_id, amount, reference, method } = req.body;
    const amt = Number(amount);

    if (!user_id || !amt || amt < 1000) {
      return res.status(400).json({ error: 'Minimum deposit is 1,000 CFA' });
    }
    if (!reference || !String(reference).trim()) {
      return res.status(400).json({ error: 'Transaction reference is required' });
    }

    // Anti-spam: max 3 pending deposits
    const { count } = await supabase.from('deposit_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id).eq('status', 'pending');
    if (count >= 3) {
      return res.status(400).json({ error: 'Too many pending deposits. Wait for approval.' });
    }

    const { error } = await supabase.from('deposit_requests').insert({
      user_id,
      amount: amt,
      reference: String(reference).trim(),
      method: method || 'Bank Transfer',
      status: 'pending'
    });
    if (error) throw error;

    return res.status(200).json({ ok: true, message: 'Deposit submitted for approval' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
