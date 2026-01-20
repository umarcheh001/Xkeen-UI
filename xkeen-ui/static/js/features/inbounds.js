(() => {
  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.features = XKeen.features || {};

  // Inbounds mode selector for 03_inbounds.json
  // API:
  //  - GET  /api/inbounds  -> { mode: "mixed"|"tproxy"|"redirect"|"custom"|null }
  //  - POST /api/inbounds  -> { ok:true, mode:"...", restarted?:bool }
  //
  // This module owns:
  //  - wiring of UI buttons + collapse state
  //  - load/save calls
  //  - backup button call (/api/backup-inbounds)
  //
  // It is designed to coexist with legacy main.js:
  // main.js will prefer this module when present.

  XKeen.features.inbounds = (() => {
    let inited = false;
    // last mode that is known to be applied on backend (from load/save)
    let currentMode = null;
    // guard against double-fire when clicking labels / rapid toggles
    let autoSaveInFlight = false;

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
        // allow clicking on buttons inside header without toggling
        const target = e.target;
        if (target && (target.closest && target.closest('button, a, input, label, select, textarea'))) return;
        e.preventDefault();
        handler();
      });

      if (header.dataset) header.dataset.xkeenWiredHeader = '1';
    }

    function setCollapsedFromStorage() {
      const body = $('inbounds-body');
      const arrow = $('inbounds-arrow');
      if (!body || !arrow) return;

      let open = false;
      try {
        if (window.localStorage) {
          const stored = localStorage.getItem('xkeen_inbounds_open');
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
      const body = $('inbounds-body');
      const arrow = $('inbounds-arrow');
      if (!body || !arrow) return;

      const willOpen = body.style.display === 'none';
      body.style.display = willOpen ? 'block' : 'none';
      arrow.textContent = willOpen ? '▲' : '▼';

      try {
        if (window.localStorage) {
          localStorage.setItem('xkeen_inbounds_open', willOpen ? '1' : '0');
        }
      } catch (e) {
        // ignore
      }
    }

    async function load() {
      const statusEl = $('inbounds-status');
      try {
        const res = await fetch('/api/inbounds');
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Не удалось загрузить inbounds.';
          return;
        }
        const data = await res.json().catch(() => ({}));
        const mode = data && data.mode;

        // remember current applied mode
        currentMode = mode || null;

        if (mode === 'mixed' || mode === 'tproxy' || mode === 'redirect') {
          const radio = document.querySelector('input[name="inbounds_mode"][value="' + mode + '"]');
          if (radio) radio.checked = true;
        }

        if (statusEl) {
          if (mode === 'custom') statusEl.textContent = 'Обнаружен пользовательский конфиг (не совпадает с пресетами).';
          else if (mode) statusEl.textContent = 'Текущий режим: ' + mode;
          else statusEl.textContent = 'Режим не определён (файл отсутствует или повреждён).';
        }

        try {
          if (typeof updateLastActivity === 'function') {
            const fp = window.XKEEN_FILES && window.XKEEN_FILES.inbounds ? window.XKEEN_FILES.inbounds : '';
            updateLastActivity('loaded', 'inbounds', fp);
          }
        } catch (e) {}
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = 'Ошибка загрузки inbounds.';
      }
    }

    function wireModeAutosave() {
      const radios = document.querySelectorAll('input[name="inbounds_mode"]');
      if (!radios || !radios.length) return;

      radios.forEach((r) => {
        if (r.dataset && r.dataset.xkeenWiredMode === '1') return;
        r.addEventListener('change', async () => {
          const statusEl = $('inbounds-status');
          const toggle = $('inbounds-autorestart');
          const restart = toggle ? !!toggle.checked : false;

          // If autorestart is enabled: apply immediately on mode change.
          if (restart) {
            // avoid redundant restarts when user clicks the already active mode
            if (currentMode === r.value && !autoSaveInFlight) {
              if (statusEl) statusEl.textContent = 'Текущий режим: ' + currentMode;
              return;
            }
            if (autoSaveInFlight) return;
            autoSaveInFlight = true;
            try {
              await save();
              // save() will set status/toasts; we only update currentMode optimistically here
              currentMode = r.value;
            } finally {
              autoSaveInFlight = false;
            }
            return;
          }

          // If autorestart is disabled: only mark selection as pending.
          if (statusEl) {
            statusEl.textContent = 'Выбрано: ' + r.value + '. Нажмите "Save inbounds" чтобы применить.';
          }
        });

        if (r.dataset) r.dataset.xkeenWiredMode = '1';
      });
    }

    async function save() {
      const statusEl = $('inbounds-status');
      const selected = document.querySelector('input[name="inbounds_mode"]:checked');
      const toggle = $('inbounds-autorestart');

      if (!selected) {
        if (statusEl) statusEl.textContent = 'Выбери режим перед сохранением.';
        return;
      }

      const mode = selected.value;
      const restart = toggle ? !!toggle.checked : false;

      try {
        const res = await fetch('/api/inbounds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, restart }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          let msg = 'Режим сохранён: ' + (data.mode || mode) + '.';
          if (statusEl) statusEl.textContent = msg;

          // keep currentMode in sync
          currentMode = (data && data.mode) ? data.mode : mode;
          try { if (!data || !data.restarted) { if (typeof showToast === 'function') showToast(msg, false); } } catch (e) {}
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.inbounds ? window.XKEEN_FILES.inbounds : '';
              updateLastActivity('saved', 'inbounds', fp);
            }
          } catch (e) {}
        } else {
          const msg = 'Save error: ' + ((data && data.error) || res.status);
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Ошибка сохранения режима inbounds.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      } finally {
        try { if (typeof loadRestartLog === 'function') loadRestartLog(); } catch (e) {}
      }
    }

    async function backup() {
      const statusEl = $('inbounds-status');
      const backupsStatusEl = $('backups-status');

      function _baseName(p, fallback) {
        try {
          if (!p) return fallback;
          const parts = String(p).split(/\//);
          const b = parts[parts.length - 1];
          return b || fallback;
        } catch (e) {
          return fallback;
        }
      }

      const fileLabel = _baseName(window.XKEEN_FILES && window.XKEEN_FILES.inbounds, '03_inbounds.json');

      try {
        const res = await fetch('/api/backup-inbounds', { method: 'POST' });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          const msg = 'Бэкап ' + fileLabel + ' создан: ' + (data.filename || '');
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
          const msg = 'Ошибка создания бэкапа ' + fileLabel + ': ' + ((data && data.error) || 'неизвестная ошибка');
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Ошибка создания бэкапа ' + fileLabel + '.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      }
    }

    function init() {
      const hasAny =
        $('inbounds-body') ||
        $('inbounds-save-btn') ||
        document.querySelector('input[name="inbounds_mode"]');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      setCollapsedFromStorage();
      wireHeader('inbounds-header', toggleCard);

      // Buttons
      wireButton('inbounds-save-btn', save);
      wireButton('inbounds-backup-btn', backup);
      wireButton('inbounds-restore-auto-btn', () => {
        try {
          if (window.XKeen && XKeen.backups && typeof XKeen.backups.restoreAuto === 'function') {
            XKeen.backups.restoreAuto('inbounds');
          } else {
            if (typeof showToast === 'function') showToast('Модуль бэкапов не загружен.', true);
          }
        } catch (e) {}
      });
      wireButton('inbounds-open-editor-btn', () => {
        try {
          if (window.XKeen && XKeen.jsonEditor && typeof XKeen.jsonEditor.open === 'function') {
            XKeen.jsonEditor.open('inbounds');
          } else {
            if (typeof showToast === 'function') showToast('Модуль JSON-редактора не загружен.', true);
          }
        } catch (e) {}
      });

      // Initial load
      load();

      // Autosave on radio change when "autorestart" is enabled
      wireModeAutosave();
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
