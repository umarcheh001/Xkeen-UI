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
    // last loaded config snapshot (for extras detection)
    let lastConfig = null;
    let lastExtrasTags = [];
    let lastSocksPort = null;
    // guard against double-fire when clicking labels / rapid toggles
    let autoSaveInFlight = false;

    // Apply modal state
    let _applyModalBound = false;
    let _applyModalResolver = null;
    let _applyModalEscHandler = null;
    let _applyModalCtx = null;

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

    function analyzeConfig(cfg) {
      const extras = [];
      let socksPort = null;
      try {
        const inb = Array.isArray(cfg) ? cfg : (cfg && cfg.inbounds);
        if (Array.isArray(inb)) {
          inb.forEach((it) => {
            if (!it || typeof it !== 'object') return;
            const tag = (typeof it.tag === 'string') ? it.tag.trim() : '';
            if (tag === 'redirect' || tag === 'tproxy') return;
            if (tag) extras.push(tag);
            else extras.push('(без тега)');
            if (tag === 'socks-in') {
              const p = Number(it.port);
              if (Number.isFinite(p) && p > 0) socksPort = Math.trunc(p);
            }
          });
        }
      } catch (e) {}

      // de-dup extras for nicer UI
      const seen = new Set();
      const uniq = [];
      extras.forEach((t) => {
        const k = String(t || '');
        if (!k || seen.has(k)) return;
        seen.add(k);
        uniq.push(k);
      });
      return { extrasTags: uniq, socksPort };
    }

    function _extractInbounds(cfg) {
      try {
        if (Array.isArray(cfg)) return cfg;
        if (cfg && typeof cfg === 'object' && Array.isArray(cfg.inbounds)) return cfg.inbounds;
      } catch (e) {}
      return [];
    }

    function _portSpecContains(spec, port) {
      try {
        const p = Number(port);
        if (!Number.isFinite(p)) return false;

        if (typeof spec === 'number') {
          const n = Math.trunc(spec);
          return n === Math.trunc(p);
        }

        if (typeof spec === 'string') {
          const s = spec.trim();
          if (!s) return false;

          // Fast path: pure number
          if (/^\d+$/.test(s)) return Math.trunc(p) == parseInt(s, 10);

          // Comma-separated list, allow ranges like 1000-2000 or 1000:2000
          const parts = s.split(',').map(x => x.trim()).filter(Boolean);
          for (const part of parts) {
            if (!part) continue;
            // Range
            const m = part.match(/^(\d+)\s*[-:]\s*(\d+)$/);
            if (m) {
              const a = parseInt(m[1], 10);
              const b = parseInt(m[2], 10);
              if (Number.isFinite(a) && Number.isFinite(b)) {
                const lo = Math.min(a, b);
                const hi = Math.max(a, b);
                if (Math.trunc(p) >= lo && Math.trunc(p) <= hi) return true;
              }
              continue;
            }
            if (/^\d+$/.test(part)) {
              const n = parseInt(part, 10);
              if (Math.trunc(p) === n) return true;
            }
          }
        }
      } catch (e) {}
      return false;
    }

    function findPortConflicts(cfg, port, preserveExtras) {
      const conflicts = [];
      const inb = _extractInbounds(cfg);
      if (!Array.isArray(inb) || !inb.length) return conflicts;

      inb.forEach((it) => {
        try {
          if (!it || typeof it !== 'object') return;
          const tag = (typeof it.tag === 'string') ? it.tag.trim() : '';
          // We'll replace socks-in if user enables it, so don't treat it as a conflict.
          if (tag === 'socks-in') return;

          // If user disables preserving extras, check only system tags.
          if (!preserveExtras && tag !== 'redirect' && tag !== 'tproxy') return;

          const spec = it.port;
          if (_portSpecContains(spec, port)) {
            const t = tag ? tag : '(без тега)';
            conflicts.push(t + (spec != null ? ' (port=' + String(spec) + ')' : ''));
          }
        } catch (e) {}
      });

      // de-dup for nicer UI
      const seen = new Set();
      const uniq = [];
      conflicts.forEach((x) => {
        const k = String(x || '');
        if (!k || seen.has(k)) return;
        seen.add(k);
        uniq.push(k);
      });
      return uniq;
    }

    function formatExtrasShort(tags) {
      try {
        const arr = Array.isArray(tags) ? tags.filter(Boolean) : [];
        if (!arr.length) return '';
        const head = arr.slice(0, 3).join(', ');
        if (arr.length <= 3) return head;
        return head + ` и ещё ${arr.length - 3}`;
      } catch (e) {
        return '';
      }
    }

    function shouldShowApplyModal() {
      return currentMode === 'custom' || (Array.isArray(lastExtrasTags) && lastExtrasTags.length > 0);
    }

    function setModeRadio(mode) {
      const radios = document.querySelectorAll('input[name="inbounds_mode"]');
      if (!radios || !radios.length) return;
      radios.forEach((r) => {
        try {
          if (!mode || (mode !== 'mixed' && mode !== 'tproxy' && mode !== 'redirect')) {
            r.checked = false;
          } else {
            r.checked = (r.value === mode);
          }
        } catch (e) {}
      });
    }

    function getApplyModalEls() {
      return {
        modal: $('inbounds-apply-modal'),
        closeBtn: $('inbounds-apply-close-btn'),
        cancelBtn: $('inbounds-apply-cancel-btn'),
        okBtn: $('inbounds-apply-ok-btn'),
        desc: $('inbounds-apply-desc'),
        preserve: $('inbounds-apply-preserve-extras'),
        extrasHint: $('inbounds-apply-extras-hint'),
        addSocks: $('inbounds-apply-add-socks'),
        socksRow: $('inbounds-apply-socks-row'),
        socksPort: $('inbounds-apply-socks-port'),
        warn: $('inbounds-apply-warn'),
        error: $('inbounds-apply-error'),
      };
    }

    function showApplyModal(ctx) {
      const ui = getApplyModalEls();
      if (!ui.modal || !ui.okBtn || !ui.cancelBtn || !ui.closeBtn || !ui.preserve || !ui.addSocks || !ui.socksPort) {
        return Promise.resolve({ preserveExtras: true, addSocks: false, socksPort: null });
      }

      // Close any previous unresolved modal.
      if (typeof _applyModalResolver === 'function') {
        try { _applyModalResolver(null); } catch (e) {}
        _applyModalResolver = null;
      }
      _applyModalCtx = ctx || {};

      // Bind handlers once.
      if (!_applyModalBound) {
        _applyModalBound = true;

        function hideWith(val) {
          const ui2 = getApplyModalEls();
          try { if (ui2.error) { ui2.error.style.display = 'none'; ui2.error.textContent = ''; } } catch (e0) {}
          try { if (ui2.warn) { ui2.warn.style.display = 'none'; ui2.warn.textContent = ''; } } catch (e0w) {}
          try { ui2.modal.classList.add('hidden'); } catch (e1) {}
          if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
            try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e2) {}
          } else {
            try { document.body.classList.remove('modal-open'); } catch (e3) {}
          }

          if (_applyModalEscHandler) {
            try { document.removeEventListener('keydown', _applyModalEscHandler); } catch (e4) {}
          }

          const r = _applyModalResolver;
          _applyModalResolver = null;
          if (typeof r === 'function') {
            try { r(val); } catch (e5) {}
          }
        }

        function refreshWarn() {
          const ui2 = getApplyModalEls();
          try { if (ui2.warn) { ui2.warn.style.display = 'none'; ui2.warn.textContent = ''; } } catch (e0) {}
          try {
            if (!ui2.warn || !ui2.addSocks || !ui2.addSocks.checked) return;
            const raw = Number(ui2.socksPort.value || ui2.socksPort.placeholder || 1080);
            const p2 = Math.trunc(raw);
            if (!Number.isFinite(p2) || p2 < 1 || p2 > 65535) return;
            const preserveExtras = !!(ui2.preserve && ui2.preserve.checked);
            const cfg = (_applyModalCtx && _applyModalCtx.config) ? _applyModalCtx.config : lastConfig;
            const hits = findPortConflicts(cfg, p2, preserveExtras);
            if (hits && hits.length) {
              ui2.warn.textContent = '⚠️ Порт ' + p2 + ' уже используется: ' + hits.join(', ') + '. Выберите другой порт, иначе Xray может не запуститься.';
              ui2.warn.style.display = 'block';
            }
          } catch (e1) {}
        }

        // Backdrop click closes.
        ui.modal.addEventListener('click', (e) => {
          if (e.target === ui.modal) hideWith(null);
        });
        ui.closeBtn.addEventListener('click', (e) => { e.preventDefault(); hideWith(null); });
        ui.cancelBtn.addEventListener('click', (e) => { e.preventDefault(); hideWith(null); });

        ui.addSocks.addEventListener('change', () => {
          const ui2 = getApplyModalEls();
          const on = !!ui2.addSocks.checked;
          try { ui2.socksRow.style.display = on ? 'block' : 'none'; } catch (e) {}
          try { refreshWarn(); } catch (e) {}
        });

        try {
          ui.preserve.addEventListener('change', () => {
            try { refreshWarn(); } catch (e) {}
          });
        } catch (e) {}

        try {
          ui.socksPort.addEventListener('input', () => {
            try { refreshWarn(); } catch (e) {}
          });
          ui.socksPort.addEventListener('change', () => {
            try { refreshWarn(); } catch (e) {}
          });
        } catch (e) {}

        ui.okBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const ui2 = getApplyModalEls();
          const preserveExtras = !!ui2.preserve.checked;
          const addSocks = !!ui2.addSocks.checked;
          let socksPort = null;

          try { if (ui2.error) { ui2.error.style.display = 'none'; ui2.error.textContent = ''; } } catch (e0) {}

          if (addSocks) {
            const p = Number(ui2.socksPort.value || ui2.socksPort.placeholder || 1080);
            const p2 = Math.trunc(p);
            if (!Number.isFinite(p2) || p2 < 1 || p2 > 65535) {
              try {
                if (ui2.error) {
                  ui2.error.textContent = 'Некорректный порт. Укажите число 1…65535.';
                  ui2.error.style.display = 'block';
                }
                ui2.socksPort.focus();
              } catch (e1) {}
              return;
            }
            socksPort = p2;
          }

          hideWith({ preserveExtras, addSocks, socksPort });
        });

        // ESC closes.
        _applyModalEscHandler = (e) => {
          if (e && (e.key === 'Escape' || e.key === 'Esc')) {
            hideWith(null);
          }
        };
      }

      // Populate UI
      const extrasShort = formatExtrasShort(_applyModalCtx.extrasTags || []);
      try {
        if (ui.desc) {
          const m = String(_applyModalCtx.selectedMode || '');
          ui.desc.textContent = `Применение пресета режима: ${m}.`;
        }
      } catch (e) {}
      try {
        if (ui.extrasHint) {
          if (extrasShort) {
            ui.extrasHint.textContent = 'Обнаружены пользовательские секции: ' + extrasShort + '.';
          } else {
            ui.extrasHint.textContent = 'Пользовательские секции не обнаружены.';
          }
        }
      } catch (e) {}

      try { ui.preserve.checked = true; } catch (e) {}
      try { ui.addSocks.checked = false; } catch (e) {}
      try { ui.socksRow.style.display = 'none'; } catch (e) {}
      try {
        const p = Number(_applyModalCtx.socksPort) || 1080;
        ui.socksPort.value = String(Math.trunc(p));
      } catch (e) {}
      try { if (ui.warn) { ui.warn.style.display = 'none'; ui.warn.textContent = ''; } } catch (e) {}
      try { if (ui.error) { ui.error.style.display = 'none'; ui.error.textContent = ''; } } catch (e) {}

      // Show modal
      try { ui.modal.classList.remove('hidden'); } catch (e) {}
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
      } else {
        try { document.body.classList.add('modal-open'); } catch (e) {}
      }

      // Attach ESC handler (created in one-time binding above).
      try { if (_applyModalEscHandler) document.removeEventListener('keydown', _applyModalEscHandler); } catch (e) {}
      try { if (_applyModalEscHandler) document.addEventListener('keydown', _applyModalEscHandler); } catch (e) {}

      setTimeout(() => {
        try { ui.cancelBtn.focus(); } catch (e) {}
      }, 0);

      return new Promise((resolve) => {
        _applyModalResolver = resolve;
      });
    }

    async function load(opts) {
      const statusEl = $('inbounds-status');
      const silent = !!(opts && opts.silent);
      try {
        const file = getActiveFragment();
        const url = file ? ('/api/inbounds?file=' + encodeURIComponent(file)) : '/api/inbounds';
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          if (statusEl && !silent) statusEl.textContent = 'Не удалось загрузить inbounds.';
          return;
        }
        const data = await res.json().catch(() => ({}));
        const mode = data && data.mode;

        lastConfig = (data && data.config) ? data.config : null;
        const a = analyzeConfig(lastConfig);
        lastExtrasTags = a.extrasTags || [];
        lastSocksPort = a.socksPort;

        // remember current applied mode
        currentMode = mode || null;

        if (mode === 'mixed' || mode === 'tproxy' || mode === 'redirect') {
          const radio = document.querySelector('input[name="inbounds_mode"][value="' + mode + '"]');
          if (radio) radio.checked = true;
        }

        if (statusEl && !silent) {
          const extrasShort = formatExtrasShort(lastExtrasTags);
          if (mode === 'custom') {
            statusEl.textContent = extrasShort
              ? ('Обнаружен пользовательский конфиг (не совпадает с пресетами). Пользовательские секции: ' + extrasShort + '.')
              : 'Обнаружен пользовательский конфиг (не совпадает с пресетами).';
          } else if (mode) {
            statusEl.textContent = extrasShort
              ? ('Текущий режим: ' + mode + '. Есть пользовательские секции: ' + extrasShort + '.')
              : ('Текущий режим: ' + mode);
          } else {
            statusEl.textContent = 'Режим не определён (файл отсутствует или повреждён).';
          }
        }

        try {
          if (typeof updateLastActivity === 'function') {
            const fp = window.XKEEN_FILES && window.XKEEN_FILES.inbounds ? window.XKEEN_FILES.inbounds : '';
            updateLastActivity('loaded', 'inbounds', fp);
          }
        } catch (e) {}
      } catch (e) {
        console.error(e);
        if (statusEl && !silent) statusEl.textContent = 'Ошибка загрузки inbounds.';
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

      // When config is custom or contains extras, ask how to apply preset.
      let preserve_extras = true;
      let add_socks = false;
      let socks_port = null;
      const isPresetMode = (mode === 'mixed' || mode === 'tproxy' || mode === 'redirect');
      if (isPresetMode && shouldShowApplyModal()) {
        const opts = await showApplyModal({
          selectedMode: mode,
          extrasTags: lastExtrasTags,
          socksPort: lastSocksPort,
          config: lastConfig,
        });
        if (!opts) {
          if (statusEl) statusEl.textContent = 'Отменено.';
          // Revert selection to the last known backend mode when user cancels.
          setModeRadio(currentMode);
          return;
        }
        preserve_extras = !!opts.preserveExtras;
        add_socks = !!opts.addSocks;
        socks_port = opts.socksPort != null ? Number(opts.socksPort) : null;
      }

      try {
        const file = getActiveFragment();
        const url = file ? ('/api/inbounds?file=' + encodeURIComponent(file)) : '/api/inbounds';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, restart, preserve_extras, add_socks, socks_port }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          let msg = 'Режим сохранён: ' + (data.mode || mode) + '.';
          if (statusEl) statusEl.textContent = msg;

          // keep currentMode in sync
          currentMode = (data && data.mode) ? data.mode : mode;
          // Refresh extras snapshot silently (so next apply doesn't show modal unnecessarily).
          try { await load({ silent: true }); } catch (e) {}
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
