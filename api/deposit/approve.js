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
    const { data: request } = await supabase.from('deposit_requests').select('*').eq('id', request_id).single();
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ error: 'Request not found or already processed' });
    }

    // ---- REJECT ----
    if (action === 'reject') {
      await supabase.from('deposit_requests').update({ status: 'rejected', admin_note: admin_note || '' }).eq('id', request_id);
      return res.status(200).json({ ok: true });
    }

    // ---- APPROVE ----
    if (action === 'approve') {
      const amt = Number(request.amount);

      // Credit wallet
      const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', request.user_id).single();
      const newBalance = Number(wallet.balance) + amt;
      await supabase.from('wallets').update({
        balance: newBalance,
        total_deposit: Number(wallet.total_deposit || 0) + amt,
        updated_at: new Date().toISOString()
      }).eq('user_id', request.user_id);

      await supabase.from('wallet_transactions').insert({
        user_id: request.user_id, type: 'deposit', amount: amt,
        description: 'Deposit approved (' + request.method + ')', balance_after: newBalance
      });

      // Dynamic referral bonus from platform settings
      const { data: settings } = await supabase.from('platform_settings').select('referral_bonus_percent').eq('id', 1).single();
      const bonusPct = Number(settings?.referral_bonus_percent ?? 22);

      const { data: user } = await supabase.from('users').select('referred_by').eq('id', request.user_id).single();
      if (user?.referred_by) {
        const commission = Math.round(amt * bonusPct / 100);
        const { data: rw } = await supabase.from('wallets').select('*').eq('user_id', user.referred_by).single();
        if (rw) {
          const rb = Number(rw.balance) + commission;
          await supabase.from('wallets').update({
            balance: rb,
            total_referral_earnings: Number(rw.total_referral_earnings || 0) + commission,
            updated_at: new Date().toISOString()
          }).eq('user_id', user.referred_by);

          await supabase.from('wallet_transactions').insert({
            user_id: user.referred_by, type: 'referral_bonus', amount: commission,
            description: bonusPct + '% commission on downline deposit', balance_after: rb
          });

          const { data: existing } = await supabase.from('referrals')
            .select('id, commission_earned')
            .eq('user_id', user.referred_by).eq('referred_user_id', request.user_id).single();

          if (existing) {
            await supabase.from('referrals').update({ commission_earned: Number(existing.commission_earned) + commission }).eq('id', existing.id);
          } else {
            await supabase.from('referrals').insert({ user_id: user.referred_by, referred_user_id: request.user_id, commission_earned: commission });
          }
        }
      }

      await supabase.from('deposit_requests').update({ status: 'approved', admin_note: admin_note || '' }).eq('id', request_id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('[deposit/approve] Error:', e);
    return res.status(500).json({ error: e.message });
  }
};
