/* ============================================================
   GREEN FARM FORTUNE — FRONTEND AUTH & UTILITY HELPERS
   File: assets/js/auth.js
   ============================================================ */
(function () {
  const AradelAuth = {
    _ensured: false,

    /* ---------- SESSION (with auto-repair) ---------- */
    async getSession() {
      try {
        const { data, error } = await window.sb.auth.getSession();
        if (error) { console.error('[GFF] Session error:', error); return null; }
        const session = data.session || null;
        if (session) await this.ensureProfile(session);
        return session;
      } catch (e) {
        console.error('[GFF] Session exception:', e);
        return null;
      }
    },

    // Creates profile + wallet if they're missing (fixes old broken accounts)
    async ensureProfile(session) {
      if (this._ensured) return;
      this._ensured = true;
      try {
        const { data } = await window.sb
          .from('users').select('id').eq('id', session.user.id).single();
        if (data) return; // profile exists — nothing to do

        console.warn('[GFF] Profile missing — auto-creating...');
        const code = 'GFF' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const meta = session.user.user_metadata || {};

        const { error } = await window.sb.from('users').insert({
          id: session.user.id,
          email: session.user.email,
          full_name: meta.full_name || 'Farmer',
          phone: meta.phone || null,
          referral_code: code
        });
        if (error) throw error;

        await window.sb.from('wallets').insert({ user_id: session.user.id });
        console.warn('[GFF] Profile + wallet auto-created:', code);
      } catch (e) {
        console.warn('[GFF] ensureProfile:', e.message);
      }
    },

    async requireAuth() {
      const session = await this.getSession();
      if (!session) {
        window.location.href = '/';
        return null;
      }
      return session;
    },

    onAuthChange(cb) {
      return window.sb.auth.onAuthStateChange((event, session) => cb(event, session)).data.subscription;
    },

    /* ---------- LOGIN (browser-side so session persists) ---------- */
    async login(email, password) {
      const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      return data;
    },

    /* ---------- REGISTER (server + DB trigger) ---------- */
    async register(full_name, email, phone, password, referral_code) {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ action: 'register', full_name, email, phone, password, referral_code })
      });

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        console.error('[GFF] Register returned non-JSON:', await res.text());
        throw new Error('Server error — please try again');
      }

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Registration failed');
      return data;
    },

    /* ---------- LOGOUT ---------- */
    async logout(redirect = '/') {
      this._ensured = false;
      await window.sb.auth.signOut();
      window.location.href = redirect;
    },

    /* ---------- QUICK DATA FETCHERS ---------- */
    async getProfile(uid) {
      const { data } = await window.sb.from('users').select('*').eq('id', uid).single();
      return data;
    },

    async getWallet(uid) {
      const { data } = await window.sb.from('wallets').select('*').eq('user_id', uid).single();
      return data;
    },

    /* ---------- FORMATTING ---------- */
    money(n) {
      return Number(n || 0).toLocaleString() + ' CFA';
    },

    timeAgo(dateStr) {
      const d = new Date(dateStr);
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return 'Just now';
      const m = Math.floor(s / 60);  if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);  if (h < 24) return h + 'h ago';
      const dy = Math.floor(h / 24); if (dy < 30) return dy + 'd ago';
      return d.toLocaleDateString();
    },

    async copy(text, msg = 'Copied') {
      try {
        await navigator.clipboard.writeText(text);
        this.toast(msg);
      } catch (e) {
        this.toast(text);
      }
    },

    /* ---------- TOAST ---------- */
    toast(message, type = 'success') {
      let toast = document.getElementById('toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:25px;font-size:13px;font-weight:700;z-index:1000;opacity:0;pointer-events:none;transition:opacity .3s;color:#fff;font-family:Inter,sans-serif;';
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.style.background = type === 'error' ? '#DC143C' : '#002171';
      toast.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
    }
  };

  window.AradelAuth = AradelAuth;
})();
