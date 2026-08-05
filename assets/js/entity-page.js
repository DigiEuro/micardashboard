(function () {
  'use strict';

  function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }
    return new Promise(function (resolve, reject) {
      const input = document.createElement('textarea');
      input.value = value;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        input.remove();
      }
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      const value = button.getAttribute('data-copy') || '';
      const status = document.querySelector('.entity-copy-status');
      copyText(value).then(function () {
        if (status) status.textContent = 'LEI copied';
        window.setTimeout(function () { if (status) status.textContent = ''; }, 2200);
      }).catch(function () {
        if (status) status.textContent = 'Could not copy automatically';
      });
    });
  });
})();
