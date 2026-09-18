// lib/credit-deposit.js
// Used by BOTH admin manual approval AND OTPay auto-callback.
// Prevents business logic divergence.
async function creditDeposit({ supabase, user_id, amount, provider_ref, description, balance_after_override }) {
  const { data: wallet, error: wErr } = await supabase.from('wallets').select('*').eq('user_id', user_id).single();
  if (wErr) throw new Error('Wallet not found: ' + wErr.message);

  const amt = Number(amount);
  const newBalance = balance_after_override ?? (Number(wallet.balance) + amt);

  await supabase.from('wallets').update({
    balance: newBalance,
    total_deposit: Number(wallet.total_deposit || 0) + amt,
    updated_at: new Date().toISOString()
  }).eq('user_id', user_id);

  await supabase.from('wallet_transactions').insert({
    user_id, type: 'deposit', amount: amt,
    description: description || 'Deposit credited',
    balance_after: newBalance
  });

  // Referral commission (dynamic % from platform_settings)
  const { data: settings } = await supabase.from('platform_settings').select('referral_bonus_percent').eq('id', 1).single();
  const pct = Number(settings?.referral_bonus_percent ?? 22);

  const { data: user } = await supabase.from('users').select('referred_by').eq('id', user_id).single();
  let commissionPaid = 0;
  if (user?.referred_by) {
    const commission = Math.round(amt * pct / 100);
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
        description: pct + '% commission on downline deposit', balance_after: rb
      });
      commissionPaid = commission;
    }
  }

  return { newBalance, commissionPaid };
}

module.exports = { creditDeposit };
