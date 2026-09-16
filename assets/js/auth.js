const AradelAuth = {
  async requireAuth() {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session) {
      window.location.href = '/';
      return null;
    }
    return session;
  },

  async login(email, password) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ 
        action: 'login', 
        email, 
        password 
      })
    });
    
    // Check if response is JSON
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      console.error('API returned non-JSON:', text);
      throw new Error('Server error - please try again later');
    }
    
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Login failed');
    }
    return data;
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
    
    // Check if response is JSON
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
