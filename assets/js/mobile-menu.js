// assets/js/mobile-menu.js
document.addEventListener('DOMContentLoaded', function () {
  const btn = document.getElementById('mobile-menu-button');
  const menu = document.getElementById('mobile-menu');
  const menuPanel = menu ? menu.querySelector('.mobile-menu-panel') : null;
  const overlay = document.getElementById('mobile-menu-overlay');
  const hamburger = document.getElementById('hamburger-icon');
  const closeIcon = document.getElementById('close-icon');

  if (!btn || !menu || !menuPanel || !overlay) return;
  const transitionMs = 220;
  const isMenuOpen = () => btn.getAttribute('aria-expanded') === 'true';

  function safeFocus(element) {
    if (!element || typeof element.focus !== 'function') return;
    try {
      element.focus({ preventScroll: true });
    } catch (_err) {
      element.focus();
    }
  }

  function openMenu() {
    btn.setAttribute('aria-expanded', 'true');
    overlay.classList.remove('hidden');
    menu.classList.remove('hidden');

    requestAnimationFrame(() => {
      overlay.classList.add('menu-open');
      menu.classList.add('menu-open');
      hamburger?.classList.add('hidden');
      closeIcon?.classList.remove('hidden');
    });

    const first = menuPanel.querySelector('[role="menuitem"]');
    safeFocus(first);
  }

  function closeMenu(options = {}) {
    const focusButton = options.focusButton !== false;
    btn.setAttribute('aria-expanded', 'false');

    overlay.classList.remove('menu-open');
    menu.classList.remove('menu-open');

    hamburger?.classList.remove('hidden');
    closeIcon?.classList.add('hidden');

    setTimeout(() => {
      menu.classList.add('hidden');
      overlay.classList.add('hidden');
    }, transitionMs);

    if (focusButton) safeFocus(btn);
  }

  btn.addEventListener('click', function () {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) closeMenu();
    else openMenu();
  });

  document.addEventListener(
    'click',
    function (event) {
      if (!isMenuOpen()) return;
      const target = event.target;
      if (menuPanel.contains(target) || btn.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ focusButton: false });
    },
    true
  );

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
