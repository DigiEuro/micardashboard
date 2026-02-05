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
  let closeTimer = null;

  function openMenu() {
    if (isMenuOpen()) return;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    btn.setAttribute('aria-expanded', 'true');
    overlay.classList.remove('hidden');
    menu.classList.remove('hidden');

    requestAnimationFrame(() => {
      overlay.classList.add('menu-open');
      menu.classList.add('menu-open');
      hamburger?.classList.add('hidden');
      closeIcon?.classList.remove('hidden');
    });
  }

  function closeMenu(options = {}) {
    if (!isMenuOpen()) return;
    const focusButton = options.focusButton !== false;
    const immediate = options.immediate === true;

    btn.setAttribute('aria-expanded', 'false');

    overlay.classList.remove('menu-open');
    menu.classList.remove('menu-open');

    hamburger?.classList.remove('hidden');
    closeIcon?.classList.add('hidden');

    if (closeTimer) clearTimeout(closeTimer);

    const finalizeClose = () => {
      menu.classList.add('hidden');
      overlay.classList.add('hidden');
      closeTimer = null;
    };

    if (immediate) {
      finalizeClose();
    } else {
      closeTimer = setTimeout(finalizeClose, transitionMs);
    }

    if (focusButton) {
      try {
        btn.focus({ preventScroll: true });
      } catch (_err) {
        btn.focus();
      }
    }
  }

  btn.addEventListener('click', function () {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) closeMenu();
    else openMenu();
  });

  const handleOutsideInteraction = (event) => {
    if (!isMenuOpen()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (menuPanel.contains(target) || btn.contains(target)) return;
    closeMenu({ focusButton: false });
  };

  document.addEventListener('click', handleOutsideInteraction);
  document.addEventListener('touchend', handleOutsideInteraction, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (isMenuOpen()) closeMenu();
    }
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth >= 768 && isMenuOpen()) {
      closeMenu({ focusButton: false, immediate: true });
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
