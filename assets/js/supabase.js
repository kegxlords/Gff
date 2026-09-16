// Supabase Configuration
const SUPABASE_URL = 'YOUR_SUPABASE_URL'; // Replace with your actual URL
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // Replace with your actual Key

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
