import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

function generateReferralCode() {
  return 'GFF' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, email, password, full_name, phone, referral_code } = req.body;

  try {
    // --- LOGIN ---
    if (action === 'login') {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      // Fetch user profile
      const { data: profile } = await supabase
        .from('users')
        .select('*')
        .eq('id', data.user.id)
        .single();

      return res.status(200).json({ ok: true, user: data.user, profile, session: data.session });
    }

    // --- REGISTER ---
    if (action === 'register') {
      // 1. Create Auth User
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name, phone } }
      });
      if (authError) throw authError;

      const userId = authData.user.id;
      const newReferralCode = generateReferralCode();

      // 2. Find referrer if code provided
      let referrerId = null;
      if (referral_code) {
        const { data: referrer } = await supabase
          .from('users')
          .select('id')
          .eq('referral_code', referral_code)
          .single();
        if (referrer) referrerId = referrer.id;
      }

      // 3. Create User Profile
      await supabase.from('users').insert({
        id: userId,
        email,
        full_name,
        phone,
        referral_code: newReferralCode,
        referred_by: referrerId
      });

      // 4. Create Wallet
      await supabase.from('wallets').insert({ user_id: userId });

      // 5. Handle Referral Commission (22% of first deposit logic can go here later)
      if (referrerId) {
        await supabase.from('referrals').insert({
          user_id: referrerId,
          referred_user_id: userId
        });
      }

      return res.status(200).json({ ok: true, message: 'Registration successful! Please login.' });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}
