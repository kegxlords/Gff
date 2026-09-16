import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

function generateReferralCode() {
  return 'GFF' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, email, password, full_name, phone, referral_code } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    // LOGIN
    if (action === 'login') {
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const { data, error } = await supabase.auth.signInWithPassword({ 
        email, 
        password 
      });

      if (error) {
        return res.status(401).json({ error: error.message });
      }

      // Fetch user profile
      const { data: profile, error: profileError } = await supabase
        .from('users')
        .select('*')
        .eq('id', data.user.id)
        .single();

      if (profileError) {
        console.error('Profile fetch error:', profileError);
      }

      return res.status(200).json({ 
        ok: true, 
        user: data.user, 
        profile, 
        session: data.session 
      });
    }

    // REGISTER
    if (action === 'register') {
      if (!email || !password || !full_name) {
        return res.status(400).json({ error: 'All required fields must be filled' });
      }

      // Create Auth User
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { 
          data: { 
            full_name, 
            phone 
          } 
        }
      });

      if (authError) {
        return res.status(400).json({ error: authError.message });
      }

      const userId = authData.user.id;
      const newReferralCode = generateReferralCode();

      // Find referrer if code provided
      let referrerId = null;
      if (referral_code && referral_code.trim() !== '') {
        const { data: referrer } = await supabase
          .from('users')
          .select('id')
          .eq('referral_code', referral_code.trim())
          .single();
        
        if (referrer) {
          referrerId = referrer.id;
        }
      }

      // Create User Profile
      const { error: profileError } = await supabase
        .from('users')
        .insert({
          id: userId,
          email,
          full_name,
          phone: phone || null,
          referral_code: newReferralCode,
          referred_by: referrerId,
          vip_level: 0,
          is_admin: false
        });

      if (profileError) {
        console.error('Profile creation error:', profileError);
        return res.status(500).json({ error: 'Failed to create user profile' });
      }

      // Create Wallet
      const { error: walletError } = await supabase
        .from('wallets')
        .insert({ 
          user_id: userId,
          balance: 0,
          total_deposit: 0,
          total_profit: 0,
          total_referral_earnings: 0
        });

      if (walletError) {
        console.error('Wallet creation error:', walletError);
      }

      // Handle Referral
      if (referrerId) {
        await supabase
          .from('referrals')
          .insert({
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

    return res.status(400).json({ error: 'Invalid action specified' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: error.message || 'Internal server error' 
    });
  }
}
