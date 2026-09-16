// Supabase Configuration
const SUPABASE_URL = 'https://gftumbfvgiwtbnjkdiuv.supabase.co'; // Replace with your actual URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmdHVtYmZ2Z2l3dGJuamtkaXV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NjExNDcsImV4cCI6MjEwNTEzNzE0N30.siNM5h2wykPZwv2geR5_oUJiwOTQ1BABIi0fTWIIYrs'; // Replace with your actual Key

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb;
