// Authentication Helpers
const AradelAuth = {
  async requireAuth() {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session) {
      window.location.href = 'index.html';
      return null;
    }
    return session;
  },

  async login(email, password) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data;
  },

  async register(full_name, email, phone, password, referral_code) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', full_name, email, phone, password, referral_code })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data;
  },

  toast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = type === 'error' ? 'var(--accent-red)' : 'var(--text-dark)';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
};
window.AradelAuth = AradelAuth;
