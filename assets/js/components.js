/* ============================================================
   GFF SHARED COMPONENTS LOADER + HEADER PERSONALIZATION
   + IMPERSONATION RETURN PILL
   File: assets/js/components.js (load AFTER supabase.js & auth.js)
   ============================================================ */
(async function () {
  async function inject(id, url) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      const res = await fetch(url);
      el.innerHTML = await res.text();
    } catch (e) {
      console.error('[GFF] Component load failed:', url, e);
    }
  }

  async function init() {
    await inject('app-header', '/assets/components/header.html');
    await inject('app-footer', '/assets/components/footer.html');

    const page = (window.location.pathname.split('/').pop() || 'dashboard').replace('.html', '') || 'dashboard';
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.page === page);
    });

    if (!window.AradelAuth || !window.sb) return;
    const session = await window.AradelAuth.getSession();
    if (!session) return;

    const { data: profile } = await window.sb
      .from('users').select('full_name, vip_level')
      .eq('id', session.user.id).single();

    if (profile) {
      const n = document.getElementById('headerUserName');
      const v = document.getElementById('headerUserVip');
      if (n) n.textContent = profile.full_name.split(' ')[0];
      if (v) v.textContent = profile.vip_level > 0 ? 'VIP ' + profile.vip_level : 'Member';
    }

    const { count } = await window.sb
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .or('recipient_id.eq.' + session.user.id + ',is_broadcast.eq.true')
      .eq('is_read', false);
    if (count > 0) {
      const b = document.getElementById('headerMsgBadge');
      if (b) b.style.display = 'block';
    }

    // ---------- IMPERSONATION RETURN PILL ----------
    try {
      const raw = localStorage.getItem('gff_admin_backup');
      if (raw) {
        const bk = JSON.parse(raw);
        const fresh = bk && bk.access_token && bk.saved_at && (Date.now() - bk.saved_at) < 12 * 3600 * 1000;
        if (!fresh || !session) {
          localStorage.removeItem('gff_admin_backup');
        } else if (session.user.id === bk.user_id) {
          localStorage.removeItem('gff_admin_backup'); // admin is back home — clear backup
        } else {
          const pill = document.createElement('button');
          pill.textContent = '👑 Return to Admin';
          pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top) + 74px);right:12px;z-index:1100;background:linear-gradient(135deg,#FFD700,#D4AF37);color:#002171;border:none;border-radius:20px;padding:9px 14px;font-weight:800;font-size:11px;font-family:Inter,sans-serif;box-shadow:0 6px 18px rgba(212,175,55,.45);cursor:pointer;';
          pill.onclick = async () => {
            localStorage.removeItem('gff_admin_backup');
            await window.sb.auth.setSession({ access_token: bk.access_token, refresh_token: bk.refresh_token });
            location.href = '/admin/dashboard';
          };
          document.body.appendChild(pill);
        }
      }
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
