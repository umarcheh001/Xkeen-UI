(() => {
  'use strict';

  // UI Settings Panel
  // - Minimal toggles backed by /api/ui-settings
  // - Safe when endpoint is unavailable (toast + no-op)

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, kind) {
    try {
      if (typeof window.toast === 'function') return window.toast(String(msg || ''), kind);
      if (XK.ui && typeof XK.ui.toast === 'function') return XK.ui.toast(String(msg || ''), kind);
      if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind === 'error' || kind === true);
    } catch (e) {}
  }

  function syncScrollLock() {
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        const anyModal = !!document.querySelector('.modal:not(.hidden)');
        document.body.classList.toggle('modal-open', anyModal);
      }
    } catch (e) {}
  }

  function showModal(modal) {
    if (!modal) return;
    modal.classList.remove('hidden');
    syncScrollLock();
    try {
      const focusEl = modal.querySelector('input, button, [href], [tabindex]:not([tabindex="-1"])');
      if (focusEl && focusEl.focus) focusEl.focus();
    } catch (e) {}
  }

  function hideModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    syncScrollLock();
  }

  function getSettingsApi() {
    try {
      if (XK.ui && XK.ui.settings) return XK.ui.settings;
    } catch (e) {}
    return null;
  }

  function setStatus(text, isError) {
    const el = $('ui-settings-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.classList.toggle('error', !!isError);
  }

  function setDisabled(disabled) {
    const ids = [
      'ui-setting-prefer-prettier',
      'ui-setting-logs-ansi',
      'ui-setting-logs-ws2',
    ];
    for (const id of ids) {
      const el = $(id);
      if (!el) continue;
      el.disabled = !!disabled;
    }
  }

  async function loadAndRender() {
    const api = getSettingsApi();
    setDisabled(true);
    setStatus('Загрузка…', false);

    if (!api || typeof api.fetchOnce !== 'function' || typeof api.get !== 'function') {
      setStatus('UI‑настройки недоступны (нет модуля settings).', true);
      toast('UI‑настройки недоступны.', 'error');
      return;
    }

    try {
      await api.fetchOnce();
    } catch (e) {
      setStatus('UI‑настройки недоступны (/api/ui-settings).', true);
      toast('UI‑настройки недоступны: /api/ui-settings', 'error');
      return;
    }

    const st = api.get();

    try {
      const cb1 = $('ui-setting-prefer-prettier');
      if (cb1) cb1.checked = !!(st && st.format && st.format.preferPrettier);
    } catch (e) {}

    try {
      const cb2 = $('ui-setting-logs-ansi');
      if (cb2) cb2.checked = !!(st && st.logs && st.logs.ansi);
    } catch (e) {}

    try {
      const cb3 = $('ui-setting-logs-ws2');
      if (cb3) cb3.checked = !!(st && st.logs && st.logs.ws2);
    } catch (e) {}

    setDisabled(false);
    setStatus('Готово. Настройки сохраняются на роутере.', false);
  }

  async function patchSetting(patchObj, cbEl, label) {
    const api = getSettingsApi();
    if (!api || typeof api.patch !== 'function') {
      toast('UI‑настройки недоступны.', 'error');
      return;
    }

    const prev = !!cbEl.checked;

    // Lock all while saving
    setDisabled(true);
    setStatus('Сохраняем…', false);

    try {
      await api.patch(patchObj);
      setStatus('Сохранено.', false);
      toast(label + ': сохранено', 'success');
    } catch (e) {
      // Revert
      try { cbEl.checked = !prev; } catch (e2) {}
      const msg = (e && e.message) ? e.message : 'Ошибка сохранения UI‑настроек';
      setStatus(msg, true);
      toast(msg, 'error');
    } finally {
      setDisabled(false);
    }
  }

  function wire() {
    const openBtn = $('ui-settings-open-btn');
    const modal = $('ui-settings-modal');
    const closeBtn = $('ui-settings-close-btn');
    const okBtn = $('ui-settings-ok-btn');

    if (!modal || !openBtn) return;

    if (!openBtn.dataset || openBtn.dataset.xkWired !== '1') {
      openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        showModal(modal);
        loadAndRender();
      });
      if (openBtn.dataset) openBtn.dataset.xkWired = '1';
    }

    const close = () => hideModal(modal);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (okBtn) okBtn.addEventListener('click', close);

    // Backdrop click
    modal.addEventListener('click', (e) => {
      if (e && e.target === modal) close();
    });

    // ESC close
    document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape') return;
      if (modal.classList.contains('hidden')) return;
      close();
    });

    const cbPrettier = $('ui-setting-prefer-prettier');
    if (cbPrettier) {
      cbPrettier.addEventListener('change', () => {
        patchSetting({ format: { preferPrettier: !!cbPrettier.checked } }, cbPrettier, 'Prettier');
      });
    }

    const cbAnsi = $('ui-setting-logs-ansi');
    if (cbAnsi) {
      cbAnsi.addEventListener('change', () => {
        patchSetting({ logs: { ansi: !!cbAnsi.checked } }, cbAnsi, 'ANSI');
      });
    }

    const cbWs2 = $('ui-setting-logs-ws2');
    if (cbWs2) {
      cbWs2.addEventListener('change', () => {
        patchSetting({ logs: { ws2: !!cbWs2.checked } }, cbWs2, 'WS2');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
