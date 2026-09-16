// Load shared header and footer
async function loadComponents() {
  const headerRes = await fetch('/assets/components/header.html');
  const headerHtml = await headerRes.text();
  
  const footerRes = await fetch('/assets/components/footer.html');
  const footerHtml = await footerRes.text();

  const headerContainer = document.getElementById('app-header');
  const footerContainer = document.getElementById('app-footer');

  if (headerContainer) headerContainer.innerHTML = headerHtml;
  if (footerContainer) footerContainer.innerHTML = footerHtml;

  // Set active nav state
  const currentPage = window.location.pathname.split('/').pop().replace('.html', '') || 'dashboard';
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.page === currentPage) {
      item.classList.add('active');
    }
  });

  // Time-based greeting
  const hour = new Date().getHours();
  const greetingEl = document.getElementById('greetingTime');
  if (greetingEl) {
    greetingEl.textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  }
}

// Initialize components when DOM is ready
document.addEventListener('DOMContentLoaded', loadComponents);
