async function loadComponents() {
  try {
    // Load Header
    const headerRes = await fetch('/assets/components/header.html');
    const headerHtml = await headerRes.text();
    const headerContainer = document.getElementById('app-header');
    if (headerContainer) headerContainer.innerHTML = headerHtml;

    // Load Footer
    const footerRes = await fetch('/assets/components/footer.html');
    const footerHtml = await footerRes.text();
    const footerContainer = document.getElementById('app-footer');
    if (footerContainer) footerContainer.innerHTML = footerHtml;

    // Set Active Nav State
    const currentPage = window.location.pathname.split('/').pop().replace('.html', '') || 'dashboard';
    document.querySelectorAll('.nav-link').forEach(item => {
      item.classList.remove('active');
      if (item.dataset.page === currentPage) {
        item.classList.add('active');
      }
    });
  } catch (error) {
    console.error('Error loading components:', error);
  }
}

document.addEventListener('DOMContentLoaded', loadComponents);
