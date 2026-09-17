const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // Protect: only Vercel Cron or admin with secret can trigger
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Fetch all active plans
    const { data: plans, error } = await supabase
      .from('user_products')
      .select('*, products(name, duration_days)')
      .eq('status', 'active');

    if (error) throw error;

    let credited = 0, completed = 0;

    for (const p of plans || []) {
      const duration = p.products?.duration_days || 30;
      const days = p.days_collected || 0;
      const income = Number(p.daily_income);

      // Plan matured → mark completed
      if (days >= duration) {
        await supabase.from('user_products').update({ status: 'completed' }).eq('id', p.id);
        completed++;
        continue;
      }

      // Credit wallet
      const { data: wallet } = await supabase
        .from('wallets').select('*').eq('user_id', p.user_id).single();
      if (!wallet) continue;

      const newBalance = Number(wallet.balance) + income;

      await supabase.from('wallets').update({
        balance: newBalance,
        total_profit: Number(wallet.total_profit || 0) + income,
        updated_at: new Date().toISOString()
      }).eq('user_id', p.user_id);

      // Advance day / complete plan
      const newDays = days + 1;
      await supabase.from('user_products').update({
        days_collected: newDays,
        status: newDays >= duration ? 'completed' : 'active'
      }).eq('id', p.id);

      // Log transaction
      await supabase.from('wallet_transactions').insert({
        user_id: p.user_id,
        type: 'daily_income',
        amount: income,
        description: `Daily income — ${p.products?.name || 'Plan'} (Day ${newDays}/${duration})`,
        balance_after: newBalance
      });

      credited++;
    }

    return res.status(200).json({ ok: true, credited, completed });
  } catch (e) {
    console.error('Daily income error:', e);
    return res.status(500).json({ error: e.message });
  }
};
