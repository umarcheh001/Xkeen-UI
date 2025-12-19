(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};

  // Promise-based confirm modal.
  // Usage:
  //   const ok = await XKeen.ui.confirm({ title, message, okText, cancelText, danger });

  let _bound = false;
  let _resolver = null;
  let _escHandler = null;

  function el(id) {
    return document.getElementById(id);
  }

  function ensureModal() {
    const modal = el('confirm-modal');
    const title = el('confirm-modal-title');
    const message = el('confirm-modal-message');
    const okBtn = el('confirm-modal-ok-btn');
    const cancelBtn = el('confirm-modal-cancel-btn');
    const closeBtn = el('confirm-modal-close-btn');

    if (!modal || !title || !message || !okBtn || !cancelBtn || !closeBtn) {
      return null;
    }

    if (!_bound) {
      _bound = true;

      function closeWith(value) {
        try { modal.classList.add('hidden'); } catch (e) {}
        if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
          try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
        } else {
          try { document.body.classList.remove('modal-open'); } catch (e) {}
        }

        if (_escHandler) {
          try { document.removeEventListener('keydown', _escHandler); } catch (e) {}
          _escHandler = null;
        }

        const r = _resolver;
        _resolver = null;
        if (typeof r === 'function') {
          try { r(!!value); } catch (e) {}
        }
      }

      okBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeWith(true);
      });
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeWith(false);
      });
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeWith(false);
      });
      modal.addEventListener('click', (e) => {
        // Click on backdrop closes.
        if (e.target === modal) {
          closeWith(false);
        }
      });

      // Expose for internal use (optional)
      ensureModal._closeWith = closeWith;
    }

    return { modal, title, message, okBtn, cancelBtn };
  }

  XKeen.ui.confirm = function confirmModal(opts = {}) {
    const ui = ensureModal();
    if (!ui) {
      // Fallback to native confirm if modal isn't present.
      const text = String(opts && (opts.message || opts.text || opts.body) || 'Вы уверены?');
      return Promise.resolve(window.confirm(text));
    }

    // If a confirm is already open, resolve it as cancelled.
    if (typeof _resolver === 'function' && ensureModal._closeWith) {
      try { ensureModal._closeWith(false); } catch (e) {}
    }

    const titleText = String(opts.title || 'Подтверждение');
    const messageText = String(opts.message || opts.text || 'Вы уверены?');
    const okText = String(opts.okText || 'OK');
    const cancelText = String(opts.cancelText || 'Отменить');
    const danger = opts.danger !== false; // default true for destructive actions

    ui.title.textContent = titleText;
    ui.message.textContent = messageText;
    ui.okBtn.textContent = okText;
    ui.cancelBtn.textContent = cancelText;

    try {
      ui.okBtn.classList.toggle('btn-danger', !!danger);
    } catch (e) {}

    try { ui.modal.classList.remove('hidden'); } catch (e) {}
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
    } else {
      try { document.body.classList.add('modal-open'); } catch (e) {}
    }

    // ESC closes.
    _escHandler = (e) => {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) {
        if (ensureModal._closeWith) ensureModal._closeWith(false);
      }
    };
    try { document.addEventListener('keydown', _escHandler); } catch (e) {}

    // Focus the cancel button by default (safer for destructive operations).
    setTimeout(() => {
      try { ui.cancelBtn.focus(); } catch (e) {}
    }, 0);

    return new Promise((resolve) => {
      _resolver = resolve;
    });
  };
})();
