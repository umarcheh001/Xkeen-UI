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

    // Active inbounds fragment file (basename or absolute). Controlled by dropdown.
    let _activeFragment = null;

    const IDS = {
      fragmentSelect: 'inbounds-fragment-select',
      fragmentRefresh: 'inbounds-fragment-refresh-btn',
      fileCode: 'inbounds-file-code',
    };

    function $(id) {
      return document.getElementById(id);
    }

    function getSelectedFragmentFromUI() {
      try {
        const sel = $(IDS.fragmentSelect);
        if (sel && sel.value) return String(sel.value);
      } catch (e) {}
      return null;
    }

    function rememberActiveFragment(name) {
      try {
        if (name) localStorage.setItem('xkeen.inbounds.fragment', String(name));
      } catch (e) {}
    }

    function restoreRememberedFragment() {
      try {
        const v = localStorage.getItem('xkeen.inbounds.fragment');
        if (v) return String(v);
      } catch (e) {}
      return null;
    }

    function getActiveFragment() {
      return getSelectedFragmentFromUI() || _activeFragment || restoreRememberedFragment() || null;
    }

    function updateActiveFileLabel(fullPathOrName, configsDir) {
      const codeEl = $(IDS.fileCode);
      if (!codeEl) return;
      const v = String(fullPathOrName || '');
      if (v) {
        codeEl.textContent = v;
        return;
      }
      try {
        const f = getActiveFragment();
        if (f && configsDir) {
          codeEl.textContent = String(configsDir).replace(/\/+$/, '') + '/' + f;
        } else if (f) {
          codeEl.textContent = f;
        }
      } catch (e) {}
    }

    async function refreshFragmentsList(opts) {
      const sel = $(IDS.fragmentSelect);
      if (!sel) return;

      const notify = !!(opts && opts.notify);

      let data = null;
      try {
        const res = await fetch('/api/inbounds/fragments', { cache: 'no-store' });
        data = await res.json().catch(() => null);
      } catch (e) {
        data = null;
      }

      if (!data || !data.ok || !Array.isArray(data.items)) {
        try { if (notify && typeof window.toast === 'function') window.toast('Не удалось обновить список inbounds', 'error'); } catch (e) {}
        return;
      }

      const currentDefault = (data.current || sel.dataset.current || '').toString();
      const remembered = restoreRememberedFragment();
      const preferred = (getActiveFragment() || remembered || currentDefault || (data.items[0] ? data.items[0].name : '')).toString();

      function decorateName(n) {
        const name = String(n || '');
        if (!name) return '';
        if (/_hys2\.json$/i.test(name)) return name + ' (Hysteria2)';
        return name;
      }

      try { if (sel.dataset) sel.dataset.dir = String(data.dir || ''); } catch (e) {}
      sel.innerHTML = '';

      const names = data.items.map((it) => String(it.name || '')).filter(Boolean);
      if (currentDefault && names.indexOf(currentDefault) === -1) {
        const opt = document.createElement('option');
        opt.value = currentDefault;
        opt.textContent = decorateName(currentDefault) + ' (текущий)';
        sel.appendChild(opt);
      }

      data.items.forEach((it) => {
        const name = String(it.name || '');
        if (!name) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = decorateName(name);
        sel.appendChild(opt);
      });

      try {
        const finalChoice = names.indexOf(preferred) !== -1 ? preferred : (currentDefault || (names[0] || ''));
        if (finalChoice) sel.value = finalChoice;
        _activeFragment = sel.value || finalChoice || null;
        rememberActiveFragment(_activeFragment);

        const dir = data.dir ? String(data.dir).replace(/\/+$/, '') : '';
        updateActiveFileLabel((dir ? dir + '/' : '') + (_activeFragment || ''), dir);
        // Sync legacy global file label for other modules (modal editor, backups)
        try {
          if (window.XKEEN_FILES) window.XKEEN_FILES.inbounds = (dir ? dir + '/' : '') + (_activeFragment || '');
        } catch (e) {}
        try {
          window.XKeen = window.XKeen || {};
          window.XKeen.state = window.XKeen.state || {};
          window.XKeen.state.fragments = window.XKeen.state.fragments || {};
          window.XKeen.state.fragments.inbounds = _activeFragment;
        } catch (e) {}
      } catch (e) {}

      // Wire refresh button (once)
      try {
        const btn = $(IDS.fragmentRefresh);
        if (btn && !btn.dataset.xkWired) {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            await refreshFragmentsList({ notify: true });
            await load();
          });
          btn.dataset.xkWired = '1';
        }
      } catch (e) {}

      // Success toast (only when explicitly requested)
      try { if (notify && typeof window.toast === 'function') window.toast('Список inbounds обновлён', 'success'); } catch (e) {}

      // Wire select change (once)
      try {
        if (!sel.dataset.xkWired) {
          sel.addEventListener('change', async (e) => {
            const next = String(sel.value || '');
            if (!next) return;
            _activeFragment = next;
            rememberActiveFragment(_activeFragment);
            try {
              const dir = sel.dataset && sel.dataset.dir ? String(sel.dataset.dir) : '';
              updateActiveFileLabel((dir ? dir.replace(/\/+$/, '') + '/' : '') + _activeFragment, dir);
              if (window.XKEEN_FILES) window.XKEEN_FILES.inbounds = (dir ? dir.replace(/\/+$/, '') + '/' : '') + _activeFragment;
            } catch (e2) {}
            try {
              window.XKeen = window.XKeen || {};
              window.XKeen.state = window.XKeen.state || {};
              window.XKeen.state.fragments = window.XKeen.state.fragments || {};
              window.XKeen.state.fragments.inbounds = _activeFragment;
            } catch (e3) {}
            await load();
          });
          sel.dataset.xkWired = '1';
        }
      } catch (e) {}
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
        const file = getActiveFragment();
        const url = file ? ('/api/inbounds?file=' + encodeURIComponent(file)) : '/api/inbounds';
        const res = await fetch(url, { cache: 'no-store' });
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
        const file = getActiveFragment();
        const url = file ? ('/api/inbounds?file=' + encodeURIComponent(file)) : '/api/inbounds';
        const res = await fetch(url, {
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
        const file = getActiveFragment();
        const url = file ? ('/api/backup-inbounds?file=' + encodeURIComponent(file)) : '/api/backup-inbounds';
        const res = await fetch(url, { method: 'POST' });
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

      // Fragment selector
      refreshFragmentsList();

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
