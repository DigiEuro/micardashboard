// assets/js/mobile-menu.js
document.addEventListener('DOMContentLoaded', function () {
  const btn = document.getElementById('mobile-menu-button');
  const menu = document.getElementById('mobile-menu');
  const menuPanel = menu ? menu.querySelector('.mobile-menu-panel') : null;
  const overlay = document.getElementById('mobile-menu-overlay');
  const hamburger = document.getElementById('hamburger-icon');
  const closeIcon = document.getElementById('close-icon');

  if (!btn || !menu || !menuPanel || !overlay) return;

  function openMenu() {
    btn.setAttribute('aria-expanded', 'true');
    overlay.classList.remove('hidden');
    menu.classList.remove('hidden');

    requestAnimationFrame(() => {
      menuPanel.classList.remove('opacity-0', 'translate-y-6');
      menuPanel.classList.add('opacity-100', 'translate-y-0');
      hamburger?.classList.add('hidden');
      closeIcon?.classList.remove('hidden');
    });

    document.documentElement.classList.add('overflow-hidden');
    document.body.classList.add('overflow-hidden');

    const first = menuPanel.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }

  function closeMenu() {
    btn.setAttribute('aria-expanded', 'false');

    menuPanel.classList.remove('opacity-100', 'translate-y-0');
    menuPanel.classList.add('opacity-0', 'translate-y-6');

    hamburger?.classList.remove('hidden');
    closeIcon?.classList.add('hidden');

    document.documentElement.classList.remove('overflow-hidden');
    document.body.classList.remove('overflow-hidden');

    setTimeout(() => {
      menu.classList.add('hidden');
      overlay.classList.add('hidden');
    }, 220);

    btn.focus();
  }

  btn.addEventListener('click', function () {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) closeMenu();
    else openMenu();
  });

  overlay.addEventListener('click', closeMenu);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) closeMenu();
    }
  });

  menuPanel.querySelectorAll('[role="menuitem"]').forEach((item) => {
    item.addEventListener('click', (event) => {
      const tabTarget = item.getAttribute('data-tab-target');
      if (tabTarget && typeof window.switchTab === 'function') {
        event.preventDefault();
        window.switchTab(tabTarget);
      }
      closeMenu();
    });
  });
});
