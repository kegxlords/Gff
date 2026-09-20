/* ============================================================
   GREEN FARM FORTUNE — FRONTEND AUTH & UTILITY HELPERS
   File: assets/js/auth.js (with BAN enforcement)
   ============================================================ */
(function () {
  const AradelAuth = {
    _ensured: false,
    _banChecked: false,
    _banned: false,

    /* ---------- SESSION (with auto-repair + ban check) ---------- */
    async getSession() {
      try {
        const { data, error } = await window.sb.auth.getSession();
        if (error) { console.error('[GFF] Session error:', error); return null; }
        const session = data.session || null;
        if (session) {
          await this.ensureProfile(session);
          const allowed = await this.checkBan(session);
          if (!allowed) return null;
        }
        return session;
      } catch (e) {
        console.error('[GFF] Session exception:', e);
        return null;
      }
    },

    /* ---------- BAN ENFORCEMENT (kicks banned users off every page) ---------- */
    async checkBan(session) {
      if (this._banChecked) return !this._banned;
      this._banChecked = true;
      try {
        const { data } = await window.sb
          .from('users').select('is_banned, ban_reason')
          .eq('id', session.user.id).single();
        if (data && data.is_banned) {
          this._banned = true;
          this._showBanned(data.ban_reason);
          window.sb.auth.signOut().catch(() => {});
          return false;
        }
      } catch (e) {
        console.warn('[GFF] checkBan:', e.message);
      }
      return true;
    },

    _showBanned(reason) {
      if (document.getElementById('gffBanned')) return;
      const d = document.createElement('div');
      d.id = 'gffBanned';
      d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:linear-gradient(180deg,#0E1B33,#1a2b4d);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,sans-serif;';
      d.innerHTML = `
        <div style="max-width:380px;width:100%;background:#fff;border-radius:24px;padding:32px 26px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4);">
          <div style="font-size:52px;">🚫</div>
          <h2 style="margin:12px 0 6px;font-size:22px;color:#0E1B33;font-weight:800;">Account Suspended</h2>
          <p style="color:#7A8699;font-size:13px;line-height:1.6;margin:0 0 6px;">${reason ? 'Reason: ' + reason : 'Your account has been suspended by the administrator.'}</p>
          <p style="color:#7A8699;font-size:12px;line-height:1.6;margin:0 0 20px;">If you believe this is a mistake, contact customer support on Telegram.</p>
          <button onclick="location.href='/'" style="width:100%;padding:14px;border:none;border-radius:14px;background:linear-gradient(135deg,#0033A0,#002171);color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;">Back to Home</button>
        </div>`;
      document.body.appendChild(d);
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
        if (!this._banned) window.location.href = '/';  // banned users keep the suspension screen
        return null;
      }
      return session;
    },

    onAuthChange(cb) {
      return window.sb.auth.onAuthStateChange((event, session) => cb(event, session)).data.subscription;
    },

    /* ---------- LOGIN (blocked at the door if banned) ---------- */
    async login(email, password) {
      const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      try {
        const { data: prof } = await window.sb
          .from('users').select('is_banned, ban_reason')
          .eq('id', data.user.id).single();
        if (prof && prof.is_banned) {
          await window.sb.auth.signOut();
          throw new Error('Account suspended' + (prof.ban_reason ? ': ' + prof.ban_reason : ' — contact support'));
        }
      } catch (e) {
        if (/Account suspended/.test(e.message)) throw e;
        // profile fetch failed (missing row) — allow, ensureProfile repairs it
      }
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
      this._banChecked = false;
      this._banned = false;
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
