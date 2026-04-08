let donateModuleApi = null;

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const Donate = donateModuleApi || {};
  donateModuleApi = Donate;

  // Persisted UI preference:
  // - true  => hide 💰 Донат button
  // - false => show 💰 Донат button
  const LS_KEY_HIDE = 'xkeen_ui_hide_donate';
  const TOP_LEVEL_ROUTE_CHANGE_EVENT = 'xkeen:top-level-route-change';
  const DONATE_PREF_CHANGE_EVENT = 'xkeen:donate-pref-change';
  let _donateLifecycleBound = false;

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
    try {
      window.dispatchEvent(new CustomEvent(DONATE_PREF_CHANGE_EVENT, {
        detail: { hide: !!hide },
      }));
    } catch (e) {}
  }

  function getModalApi() {
    try {
      if (XK.ui && XK.ui.modal) return XK.ui.modal;
    } catch (e) {}
    return null;
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

  function syncDevtoolsToggleState() {
    const toggle = document.getElementById('dt-hide-donate-toggle');
    if (!toggle) return;
    toggle.checked = getHidePref();
  }

  function syncDonateUiState() {
    syncDonateButtonVisibility();
    syncDevtoolsToggleState();
  }

  function showDonateModal() {
    const modal = document.getElementById('donate-modal');
    if (!modal) return;
    const api = getModalApi();
    try {
      if (api && typeof api.open === 'function') api.open(modal, { source: 'donate_modal' });
      else modal.classList.remove('hidden');
    } catch (e) {}
    try {
      if (!api || typeof api.open !== 'function') {
        if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
        else document.body.classList.add('modal-open');
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
    const api = getModalApi();
    try {
      if (api && typeof api.close === 'function') api.close(modal, { source: 'donate_modal' });
      else modal.classList.add('hidden');
    } catch (e) {}
    try {
      if (!api || typeof api.close !== 'function') {
        if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
        else document.body.classList.remove('modal-open');
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
    syncDevtoolsToggleState();

    if (!toggle.dataset || toggle.dataset.xkeenDonateWired !== '1') {
      toggle.addEventListener('change', () => {
        const hide = !!toggle.checked;
        setHidePref(hide);
        syncDonateUiState();
        if (typeof window.toast === 'function') {
          window.toast(hide ? 'Кнопка 💰 Донат отключена' : 'Кнопка 💰 Донат включена', 'info');
        }
      });
      if (toggle.dataset) toggle.dataset.xkeenDonateWired = '1';
    }
  }

  function bindDonateLifecycle() {
    if (_donateLifecycleBound) return;
    _donateLifecycleBound = true;

    window.addEventListener('pageshow', () => {
      try { syncDonateUiState(); } catch (e) {}
    });

    window.addEventListener(TOP_LEVEL_ROUTE_CHANGE_EVENT, () => {
      try { syncDonateUiState(); } catch (e) {}
    });

    window.addEventListener(DONATE_PREF_CHANGE_EVENT, () => {
      try { syncDonateUiState(); } catch (e) {}
    });

    window.addEventListener('storage', (event) => {
      if (!event || event.key !== LS_KEY_HIDE) return;
      try { syncDonateUiState(); } catch (e) {}
    });

    document.addEventListener('xkeen-ui-prefs-applied', () => {
      try { syncDonateUiState(); } catch (e) {}
    });
  }

  Donate.init = function init() {
    bindDonateLifecycle();
    // Panel: button + modal
    syncDonateUiState();
    wireModal();

    // DevTools: settings toggle
    wireDevtoolsToggle();
  };
  Donate.open = showDonateModal;
  Donate.close = hideDonateModal;
  Donate.syncVisibility = syncDonateUiState;

  // Back-compat / convenience
  window.XKeen = window.XKeen || {};
})();


export function getDonateApi() {
  try {
    return donateModuleApi;
  } catch (error) {
    return null;
  }
}

export function initDonate(...args) {
  const api = getDonateApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export function openDonate(...args) {
  const api = getDonateApi();
  if (!api || typeof api.open !== 'function') return null;
  return api.open(...args);
}

export function closeDonate(...args) {
  const api = getDonateApi();
  if (!api || typeof api.close !== 'function') return null;
  return api.close(...args);
}

export function syncDonateVisibility(...args) {
  const api = getDonateApi();
  if (!api || typeof api.syncVisibility !== 'function') return null;
  return api.syncVisibility(...args);
}
export const donateApi = Object.freeze({
  get: getDonateApi,
  init: initDonate,
  open: openDonate,
  close: closeDonate,
  syncVisibility: syncDonateVisibility,
});
