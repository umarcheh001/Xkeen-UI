(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  // Promise-based confirm modal.
  // Usage:
  //   const ok = await XKeen.ui.confirm({ title, message, okText, cancelText, danger });

  let _bound = false;
  let _resolver = null;
  let _activeOptions = null;

  function el(id) {
    return document.getElementById(id);
  }

  function getModalApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal) return XKeen.ui.modal;
    } catch (e) {}
    return null;
  }

  function normalizeText(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
    return fallback ? String(fallback) : '';
  }

  function normalizeToastKind(value, fallback) {
    const kind = String(value || fallback || 'info').trim().toLowerCase();
    if (kind === 'error' || kind === 'warning' || kind === 'success' || kind === 'info') return kind;
    return 'info';
  }

  function ensureBodyPortal(modal) {
    if (!modal) return;
    try {
      if (document.body && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
      }
    } catch (e) {}
  }

  function buildConfirmMessageText(opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const primary = normalizeText(options.message || options.text || options.body, 'Вы уверены?');
    const details = Array.isArray(options.details)
      ? options.details.map((item) => normalizeText(item)).filter(Boolean).join('\n')
      : normalizeText(options.details);
    return details ? (primary + '\n\n' + details) : primary;
  }

  function emitConfirmFeedback(message, kind) {
    const text = normalizeText(message);
    if (!text) return;

    const tone = normalizeToastKind(kind, 'info');

    try {
      if (typeof window.toast === 'function') return window.toast(text, tone);
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(text, tone);
    } catch (e2) {}
    try {
      if (window.XKeen && XKeen.ui && typeof XKeen.ui.toast === 'function') return XKeen.ui.toast(text, tone);
    } catch (e3) {}
    try { console.log('[xkeen]', text); } catch (e4) {}
  }

  function showModal(modal) {
    if (!modal) return;
    ensureBodyPortal(modal);
    const api = getModalApi();
    try {
      if (api && typeof api.open === 'function') {
        const opened = api.open(modal, { source: 'confirm_modal' });
        try { if (typeof api.bringToFront === 'function') api.bringToFront(modal); } catch (e1) {}
        return opened;
      }
    } catch (e) {}
    try { modal.classList.remove('hidden'); } catch (e2) {}
    try { if (api && typeof api.bringToFront === 'function') api.bringToFront(modal); } catch (e2a) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
      else document.body.classList.add('modal-open');
    } catch (e3) {}
  }

  function hideModal(modal) {
    if (!modal) return;
    const api = getModalApi();
    try {
      if (api && typeof api.close === 'function') return api.close(modal, { source: 'confirm_modal' });
    } catch (e) {}
    try { modal.classList.add('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
      else document.body.classList.remove('modal-open');
    } catch (e3) {}
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

      function closeWith(value, meta) {
        const details = (meta && typeof meta === 'object') ? meta : {};
        hideModal(modal);

        const active = _activeOptions || null;
        _activeOptions = null;
        const r = _resolver;
        _resolver = null;
        if (!value && active && !details.silent) {
          emitConfirmFeedback(active.cancelMessage, active.cancelKind);
        }
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

      modal.addEventListener('xkeen:modal-request-close', (e) => {
        if (typeof _resolver !== 'function') return;
        try { if (e && typeof e.preventDefault === 'function') e.preventDefault(); } catch (err) {}
        closeWith(false);
      });

      // Expose for internal use (optional)
      ensureModal._closeWith = closeWith;
    }

    return { modal, title, message, okBtn, cancelBtn };
  }

  XKeen.ui.confirm = function confirmModal(opts = {}) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const messageText = buildConfirmMessageText(options);
    const ui = ensureModal();
    if (!ui) {
      // Fallback to native confirm if modal isn't present.
      const ok = window.confirm(messageText);
      if (!ok) emitConfirmFeedback(options.cancelMessage, options.cancelKind);
      return Promise.resolve(ok);
    }

    // If a confirm is already open, resolve it as cancelled.
    if (typeof _resolver === 'function' && ensureModal._closeWith) {
      try { ensureModal._closeWith(false, { silent: true }); } catch (e) {}
    }

    const titleText = normalizeText(options.title, 'Подтверждение');
    const okText = normalizeText(options.okText, 'OK');
    const cancelText = normalizeText(options.cancelText, 'Отменить');
    const danger = options.danger !== false; // default true for destructive actions
    const focusTarget = normalizeText(options.focus, 'cancel').toLowerCase() === 'ok' ? 'ok' : 'cancel';

    ui.title.textContent = titleText;
    ui.message.textContent = messageText;
    try { ui.message.style.whiteSpace = 'pre-line'; } catch (e) {}
    ui.okBtn.textContent = okText;
    ui.cancelBtn.textContent = cancelText;
    _activeOptions = {
      cancelMessage: normalizeText(options.cancelMessage),
      cancelKind: normalizeToastKind(options.cancelKind, 'info'),
    };

    try {
      ui.okBtn.classList.toggle('btn-danger', !!danger);
    } catch (e) {}

    showModal(ui.modal);

    // Focus the cancel button by default (safer for destructive operations).
    setTimeout(() => {
      const target = focusTarget === 'ok' ? ui.okBtn : ui.cancelBtn;
      try { target.focus(); } catch (e) {}
    }, 0);

    return new Promise((resolve) => {
      _resolver = resolve;
    });
  };
})();
