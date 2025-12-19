(() => {
  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.features = XKeen.features || {};

  // Outbounds editor for 04_outbounds.json (VLESS URL helper)
  // API:
  //  - GET  /api/outbounds  -> { url: "vless://..." } or {}
  //  - POST /api/outbounds  -> { ok:true, restarted?:bool }
  //
  // This module owns:
  //  - wiring of UI buttons + collapse state
  //  - load/save calls
  //  - backup button call (/api/backup-outbounds)

  XKeen.features.outbounds = (() => {
    let inited = false;

    function $(id) {
      return document.getElementById(id);
    }

    function wireButton(btnId, handler) {
      const btn = $(btnId);
      if (!btn) return;
      if (btn.dataset && btn.dataset.xkeenWired === '1') return;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handler();
      });

      if (btn.dataset) btn.dataset.xkeenWired = '1';
    }

    function wireHeader(headerId, handler) {
      const header = $(headerId);
      if (!header) return;
      if (header.dataset && header.dataset.xkeenWiredHeader === '1') return;

      header.addEventListener('click', (e) => {
        const target = e.target;
        if (target && (target.closest && target.closest('button, a, input, label, select, textarea'))) return;
        e.preventDefault();
        handler();
      });

      if (header.dataset) header.dataset.xkeenWiredHeader = '1';
    }

    function shouldRestartAfterSave() {
      // Global toggle on panel.html; absent on dedicated pages => default true
      const cb = $('global-autorestart-xkeen');
      if (!cb) return true;
      return !!cb.checked;
    }

    function setCollapsedFromStorage() {
      const body = $('outbounds-body');
      const arrow = $('outbounds-arrow');
      if (!body || !arrow) return;

      let open = false;
      try {
        if (window.localStorage) {
          const stored = localStorage.getItem('xkeen_outbounds_open');
          if (stored === '1') open = true;
          else if (stored === '0') open = false;
        }
      } catch (e) {
        // ignore
      }

      body.style.display = open ? 'block' : 'none';
      arrow.textContent = open ? '▲' : '▼';
    }

    function toggleCard() {
      const body = $('outbounds-body');
      const arrow = $('outbounds-arrow');
      if (!body || !arrow) return;

      const willOpen = body.style.display === 'none';
      body.style.display = willOpen ? 'block' : 'none';
      arrow.textContent = willOpen ? '▲' : '▼';

      try {
        if (window.localStorage) {
          localStorage.setItem('xkeen_outbounds_open', willOpen ? '1' : '0');
        }
      } catch (e) {
        // ignore
      }
    }

    async function load() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;

      try {
        const res = await fetch('/api/outbounds');
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Не удалось загрузить outbounds.';
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data && data.url) {
          input.value = data.url;
          if (statusEl) statusEl.textContent = 'Текущая ссылка загружена.';
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.outbounds ? window.XKEEN_FILES.outbounds : '';
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        } else {
          if (statusEl) statusEl.textContent = 'Файл outbounds отсутствует или не содержит VLESS-конфиг.';
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.outbounds ? window.XKEEN_FILES.outbounds : '';
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = 'Ошибка загрузки outbounds.';
      }
    }

    async function save() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;

      const url = String(input.value || '').trim();
      if (!url) {
        if (statusEl) statusEl.textContent = 'Введи VLESS ссылку.';
        return;
      }

      try {
        const res = await fetch('/api/outbounds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, restart: shouldRestartAfterSave() }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          let msg = 'Outbounds сохранены.';
          if (statusEl) statusEl.textContent = msg;
          try { if (!data || !data.restarted) { if (typeof showToast === 'function') showToast(msg, false); } } catch (e) {}
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.outbounds ? window.XKEEN_FILES.outbounds : '';
              updateLastActivity('saved', 'outbounds', fp);
            }
          } catch (e) {}
        } else {
          const msg = 'Save error: ' + ((data && data.error) || res.status);
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Failed to save outbounds.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      } finally {
        try { if (typeof loadRestartLog === 'function') loadRestartLog(); } catch (e) {}
      }
    }

    async function backup() {
      const statusEl = $('outbounds-status');
      const backupsStatusEl = $('backups-status');

      try {
        const res = await fetch('/api/backup-outbounds', { method: 'POST' });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          const msg = 'Бэкап 04_outbounds.json создан: ' + (data.filename || '');
          if (statusEl) statusEl.textContent = msg;
          if (backupsStatusEl) backupsStatusEl.textContent = '';
          try { if (typeof showToast === 'function') showToast(msg, false); } catch (e) {}
          try {
            if (window.XKeen && XKeen.backups) {
              if (typeof XKeen.backups.refresh === 'function') await XKeen.backups.refresh();
              else if (typeof XKeen.backups.load === 'function') await XKeen.backups.load();
            }
          } catch (e) {}
        } else {
          const msg = 'Ошибка создания бэкапа 04_outbounds.json: ' + ((data && data.error) || 'неизвестная ошибка');
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Ошибка создания бэкапа 04_outbounds.json.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      }
    }

    function init() {
      const hasAny =
        $('outbounds-body') ||
        $('outbounds-save-btn') ||
        $('outbounds-url');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      setCollapsedFromStorage();
      wireHeader('outbounds-header', toggleCard);

      // Buttons
      wireButton('outbounds-save-btn', save);
      wireButton('outbounds-backup-btn', backup);
      wireButton('outbounds-restore-auto-btn', () => {
        try {
          if (window.XKeen && XKeen.backups && typeof XKeen.backups.restoreAuto === 'function') {
            XKeen.backups.restoreAuto('outbounds');
          } else {
            if (typeof showToast === 'function') showToast('Модуль бэкапов не загружен.', true);
          }
        } catch (e) {}
      });
      wireButton('outbounds-open-editor-btn', () => {
        try {
          if (window.XKeen && XKeen.jsonEditor && typeof XKeen.jsonEditor.open === 'function') {
            XKeen.jsonEditor.open('outbounds');
          } else {
            if (typeof showToast === 'function') showToast('Модуль JSON-редактора не загружен.', true);
          }
        } catch (e) {}
      });

      // Initial load
      load();
    }

    return {
      init,
      load,
      save,
      backup,
      toggleCard,
    };
  })();
})();
