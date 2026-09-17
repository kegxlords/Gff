/**
 * ============================================================
 * GREEN FARM FORTUNE — AUTH API
 * File: api/auth.js
 * Actions: POST { action: 'login' | 'register' }
 *
 * Works with the DB trigger `handle_new_user` which auto-creates
 * the user profile (with referral code), wallet & referral link.
 * ============================================================
 */
const { createClient } = require('@supabase/supabase-js');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  setCors(res);

  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Environment check
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[auth] Missing Supabase environment variables');
    return res.status(500).json({ ok: false, error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const { action, email, password, full_name, phone, referral_code } = req.body || {};

    /* ============================================================
       ACTION: LOGIN
       ============================================================ */
    if (action === 'login') {
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email and password are required' });
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: String(email).trim().toLowerCase(),
        password: String(password)
      });

      if (error) {
        const msg = error.message === 'Invalid login credentials'
          ? 'Incorrect email or password'
          : error.message;
        return res.status(401).json({ ok: false, error: msg });
      }

      // Fetch profile + wallet (service role bypasses RLS)
      const { data: profile } = await supabase
        .from('users').select('*').eq('id', data.user.id).single();
      const { data: wallet } = await supabase
        .from('wallets').select('*').eq('user_id', data.user.id).single();

      return res.status(200).json({
        ok: true,
        user: data.user,
        session: data.session,
        profile: profile || null,
        wallet: wallet || null
      });
    }

    /* ============================================================
       ACTION: REGISTER
       ============================================================ */
    if (action === 'register') {
      // Validation
      if (!full_name || !email || !password) {
        return res.status(400).json({ ok: false, error: 'Full name, email and password are required' });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
      }

      // Validate referral code if provided
      let referrer = null;
      if (referral_code && String(referral_code).trim() !== '') {
        const { data: ref } = await supabase
          .from('users')
          .select('id, referral_code')
          .eq('referral_code', String(referral_code).trim().toUpperCase())
          .single();

        if (!ref) {
          return res.status(400).json({ ok: false, error: 'Invalid referral code' });
        }
        referrer = ref;
      }

      // Create auth user — metadata is read by the DB trigger
      const { data, error } = await supabase.auth.signUp({
        email: String(email).trim().toLowerCase(),
        password: String(password),
        options: {
          data: {
            full_name: String(full_name).trim(),
            phone: phone ? String(phone).trim() : null,
            referral_code: referrer ? referrer.referral_code : null
          }
        }
      });

      if (error) {
        const msg = error.message.includes('already registered')
          ? 'This email is already registered. Please sign in.'
          : error.message;
        return res.status(400).json({ ok: false, error: msg });
      }

      // Supabase returns a user with empty identities when email already exists
      if (!data.user || (data.identities && data.identities.length === 0)) {
        return res.status(400).json({ ok: false, error: 'This email is already registered. Please sign in.' });
      }

      // The DB trigger `handle_new_user` has now created:
      //   • users row (with auto-generated GFFXXXXXX referral code)
      //   • wallets row (balance 0)
      //   • referrals row (if a referral code was used)
      const { data: profile } = await supabase
        .from('users')
        .select('referral_code')
        .eq('id', data.user.id)
        .single();

      return res.status(200).json({
        ok: true,
        message: 'Registration successful! Please sign in.',
        referral_code: profile?.referral_code || null
      });
    }

    // Unknown action
    return res.status(400).json({ ok: false, error: 'Invalid action. Use "login" or "register".' });

  } catch (e) {
    console.error('[auth] Unexpected error:', e);
    return res.status(500).json({ ok: false, error: 'Unexpected server error' });
  }
};
