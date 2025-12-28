(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};
  XK.features.donate = XK.features.donate || {};

  const Donate = XK.features.donate;

  // Persisted UI preference:
  // - true  => hide 💰 Донат button
  // - false => show 💰 Донат button
  const LS_KEY_HIDE = 'xkeen_ui_hide_donate';

  function getHidePref() {
    try {
      const v = localStorage.getItem(LS_KEY_HIDE);
      return v === '1' || v === 'true' || v === 'yes';
    } catch (e) {
      return false;
    }
  }

  function setHidePref(hide) {
    try {
      localStorage.setItem(LS_KEY_HIDE, hide ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }

  function syncDonateButtonVisibility() {
    const btn = document.getElementById('top-tab-donate');
    if (!btn) return;

    const hide = getHidePref();
    btn.classList.toggle('hidden', hide);

    // If we hid the button while modal is open — close it.
    if (hide) {
      const modal = document.getElementById('donate-modal');
      if (modal && !modal.classList.contains('hidden')) {
        hideDonateModal();
      }
    }
  }

  function showDonateModal() {
    const modal = document.getElementById('donate-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}

    // Focus first actionable element for accessibility.
    try {
      const focusEl = modal.querySelector('#donate-modal-close-btn, button, [href], input, [tabindex]:not([tabindex="-1"])');
      if (focusEl && focusEl.focus) focusEl.focus();
    } catch (e) {}
  }

  function hideDonateModal() {
    const modal = document.getElementById('donate-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = String(text || '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      if (typeof window.toast === 'function') window.toast('Скопировано', 'success');
    } catch (e) {
      if (typeof window.toast === 'function') window.toast('Не удалось скопировать', 'error');
    }
    try { ta.remove(); } catch (e) {}
  }

  function copyToClipboard(text, elForTooltip) {
    const s = String(text || '');
    if (!s) return;

    const bumpTooltip = () => {
      if (!elForTooltip || !elForTooltip.dataset) return;
      const old = elForTooltip.dataset.tooltip;
      elForTooltip.dataset.tooltip = 'Скопировано';
      setTimeout(() => {
        try {
          if (!elForTooltip || !elForTooltip.dataset) return;
          elForTooltip.dataset.tooltip = old || 'Копировать';
        } catch (e) {}
      }, 900);
    };

    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(s).then(
        () => {
          bumpTooltip();
          if (typeof window.toast === 'function') window.toast('Скопировано', 'success');
        },
        () => fallbackCopyText(s)
      );
    } else {
      fallbackCopyText(s);
    }
  }

  function wireModal() {
    const modal = document.getElementById('donate-modal');
    const btn = document.getElementById('top-tab-donate');
    if (!modal || !btn) return;

    if (!btn.dataset || btn.dataset.xkeenDonateWired !== '1') {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (getHidePref()) return;
        showDonateModal();
      });
      if (btn.dataset) btn.dataset.xkeenDonateWired = '1';
    }

    const closeBtn = document.getElementById('donate-modal-close-btn');
    const okBtn = document.getElementById('donate-modal-ok-btn');

    const wireClose = (el) => {
      if (!el) return;
      if (el.dataset && el.dataset.xkeenDonateWired === '1') return;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        hideDonateModal();
      });
      if (el.dataset) el.dataset.xkeenDonateWired = '1';
    };

    wireClose(closeBtn);
    wireClose(okBtn);

    if (!modal.dataset || modal.dataset.xkeenDonateWired !== '1') {
      modal.addEventListener('click', (e) => {
        // Close on backdrop click
        if (e.target === modal) hideDonateModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const m = document.getElementById('donate-modal');
          if (m && !m.classList.contains('hidden')) hideDonateModal();
        }
      });
      if (modal.dataset) modal.dataset.xkeenDonateWired = '1';
    }

    // Copyable wallet addresses
    const addrEls = modal.querySelectorAll('.donate-address[data-copy]');
    addrEls.forEach((el) => {
      if (el.dataset && el.dataset.xkeenDonateCopyWired === '1') return;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        copyToClipboard(el.dataset.copy || el.textContent || '', el);
      });
      if (el.dataset) el.dataset.xkeenDonateCopyWired = '1';
    });
  }

  function wireDevtoolsToggle() {
    const toggle = document.getElementById('dt-hide-donate-toggle');
    if (!toggle) return;

    // initial state
    toggle.checked = getHidePref();

    if (!toggle.dataset || toggle.dataset.xkeenDonateWired !== '1') {
      toggle.addEventListener('change', () => {
        const hide = !!toggle.checked;
        setHidePref(hide);
        syncDonateButtonVisibility();
        if (typeof window.toast === 'function') {
          window.toast(hide ? 'Кнопка 💰 Донат отключена' : 'Кнопка 💰 Донат включена', 'info');
        }
      });
      if (toggle.dataset) toggle.dataset.xkeenDonateWired = '1';
    }
  }

  Donate.init = function init() {
    // Panel: button + modal
    syncDonateButtonVisibility();
    wireModal();

    // DevTools: settings toggle
    wireDevtoolsToggle();
  };

  // Back-compat / convenience
  window.XKeen = window.XKeen || {};
  XK.features = XK.features || {};
  XK.features.donate = Donate;
})();
