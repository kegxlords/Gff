/* ============================================================
   GFF SHARED COMPONENTS LOADER + HEADER PERSONALIZATION
   File: assets/js/components.js
   Must load AFTER supabase.js and auth.js
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
    // 1) Inject shared header & footer
    await inject('app-header', '/assets/components/header.html');
    await inject('app-footer', '/assets/components/footer.html');

    // 2) Highlight active bottom-nav item
    const page = (window.location.pathname.split('/').pop() || 'dashboard').replace('.html', '') || 'dashboard';
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.page === page);
    });

    // 3) Personalize header (name, VIP badge, message badge)
    if (!window.AradelAuth || !window.sb) return;
    const session = await window.AradelAuth.getSession();
    if (!session) return;

    const { data: profile } = await window.sb
      .from('users')
      .select('full_name, vip_level')
      .eq('id', session.user.id)
      .single();

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
