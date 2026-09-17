const { createClient } = require('@supabase/supabase-js');

const FIXED_AMOUNTS = [1000, 3000, 5000, 10000, 20000, 50000, 100000, 200000, 500000];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { user_id, bank_card_id, amount } = req.body;
    const amt = Number(amount);

    if (!FIXED_AMOUNTS.includes(amt)) {
      return res.status(400).json({ error: 'Invalid amount. Choose a fixed withdrawal amount.' });
    }

    // Verify bank card belongs to user
    const { data: card } = await supabase.from('bank_cards').select('*').eq('id', bank_card_id).eq('user_id', user_id).single();
    if (!card) return res.status(400).json({ error: 'Add a bank account first' });

    // Block if a withdrawal is already pending
    const { count } = await supabase.from('withdrawal_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id).eq('status', 'pending');
    if (count > 0) return res.status(400).json({ error: 'You already have a pending withdrawal' });

    // Check balance
    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user_id).single();
    if (!wallet || Number(wallet.balance) < amt) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const fee = Math.round(amt * 0.15);
    const net = amt - fee;
    const newBalance = Number(wallet.balance) - amt;

    // Deduct immediately (refunded if rejected)
    await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', user_id);

    await supabase.from('withdrawal_requests').insert({
      user_id, bank_card_id, amount: amt, fee_15percent: fee, net_amount: net, status: 'pending'
    });

    await supabase.from('wallet_transactions').insert({
      user_id, type: 'withdrawal', amount: -amt,
      description: 'Withdrawal request (' + net.toLocaleString() + ' CFA net after 15% fee)',
      balance_after: newBalance
    });

    return res.status(200).json({ ok: true, message: 'Withdrawal submitted for approval' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
