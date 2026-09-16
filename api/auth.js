const { createClient } = require('@supabase/supabase-js');

function generateReferralCode() {
  return 'GFF' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Initialize Supabase
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing env vars:', { supabaseUrl: !!supabaseUrl, supabaseKey: !!supabaseKey });
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { action, email, password, full_name, phone, referral_code } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    // ===== LOGIN =====
    if (action === 'login') {
      const { data, error } = await supabase.auth.signInWithPassword({ 
        email, 
        password 
      });

      if (error) {
        return res.status(401).json({ error: error.message });
      }

      const { data: profile } = await supabase
        .from('users')
        .select('*')
        .eq('id', data.user.id)
        .single();

      return res.status(200).json({ 
        ok: true, 
        user: data.user, 
        profile, 
        session: data.session 
      });
    }

    // ===== REGISTER =====
    if (action === 'register') {
      // Create user in Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name, phone } }
      });

      if (authError) {
        return res.status(400).json({ error: authError.message });
      }

      const userId = authData.user.id;
      const newReferralCode = generateReferralCode();

      // Find referrer
      let referrerId = null;
      if (referral_code && referral_code.trim() !== '') {
        const { data: referrer } = await supabase
          .from('users')
          .select('id')
          .eq('referral_code', referral_code.trim())
          .single();
        
        if (referrer) referrerId = referrer.id;
      }

      // Create user profile
      await supabase.from('users').insert({
        id: userId,
        email,
        full_name,
        phone: phone || null,
        referral_code: newReferralCode,
        referred_by: referrerId,
        vip_level: 0,
        is_admin: false
      });

      // Create wallet
      await supabase.from('wallets').insert({
        user_id: userId,
        balance: 0,
        total_deposit: 0,
        total_profit: 0,
        total_referral_earnings: 0
      });

      // Create referral record
      if (referrerId) {
        await supabase.from('referrals').insert({
          user_id: referrerId,
          referred_user_id: userId,
          commission_earned: 0
        });
      }

      return res.status(200).json({ 
        ok: true, 
        message: 'Registration successful! Please login.' 
      });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};
