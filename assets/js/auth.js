const AradelAuth = {
  async getSession() {
    try {
      const { data: { session }, error } = await window.sb.auth.getSession();
      if (error) {
        console.error('Get session error:', error);
        return null;
      }
      return session;
    } catch (error) {
      console.error('Session check error:', error);
      return null;
    }
  },

  async requireAuth() {
    const session = await this.getSession();
    if (!session) {
      console.log('No session found, redirecting to login');
      window.location.href = '/';
      return null;
    }
    return session;
  },

  async login(email, password) {
    try {
      const { data, error } = await window.sb.auth.signInWithPassword({
        email,
        password
      });
      
      if (error) throw error;
      
      // Fetch user profile
      const { data: profile } = await window.sb
        .from('users')
        .select('*')
        .eq('id', data.user.id)
        .single();
      
      return { ok: true, user: data.user, profile, session: data.session };
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  },

  async register(full_name, email, phone, password, referral_code) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ 
        action: 'register', 
        full_name, 
        email, 
        phone, 
        password, 
        referral_code 
      })
    });
    
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      console.error('API returned non-JSON:', text);
      throw new Error('Server error - please try again later');
    }
    
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Registration failed');
    }
    return data;
  },

  async logout() {
    await window.sb.auth.signOut();
    window.location.href = '/';
  },

  toast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) {
      alert(message);
      return;
    }
    toast.textContent = message;
    toast.style.background = type === 'error' ? '#DC143C' : '#1A2E1A';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }
};

window.AradelAuth = AradelAuth;
