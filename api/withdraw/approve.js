const { createClient } = require('@supabase/supabase-js');

async function adminCheck(supabase, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await supabase.from('users').select('is_admin').eq('id', data.user.id).single();
  return profile?.is_admin ? data.user : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const admin = await adminCheck(supabase, req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  try {
    const { action, request_id, admin_note } = req.body;
    const { data: request } = await supabase.from('withdrawal_requests').select('*').eq('id', request_id).single();
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ error: 'Request not found or already processed' });
    }

    if (action === 'approve') {
      await supabase.from('withdrawal_requests').update({ status: 'approved', admin_note: admin_note || '' }).eq('id', request_id);
      return res.status(200).json({ ok: true });
    }

    if (action === 'reject') {
      // Refund the deducted amount
      const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', request.user_id).single();
      const newBalance = Number(wallet.balance) + Number(request.amount);
      await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', request.user_id);

      await supabase.from('wallet_transactions').insert({
        user_id: request.user_id, type: 'withdrawal_refund', amount: Number(request.amount),
        description: 'Withdrawal rejected — amount refunded', balance_after: newBalance
      });

      await supabase.from('withdrawal_requests').update({ status: 'rejected', admin_note: admin_note || '' }).eq('id', request_id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
