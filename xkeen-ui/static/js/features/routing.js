(() => {
  "use strict";

  // Routing editor module.
  // Public API:
  //   XKeen.routing.init() -> creates CodeMirror editor and wires routing buttons.
  //   XKeen.routing.load/save/validate/format/backup/restoreAuto/toggleCard
  //
  // Key goals:
  //  - Own routing editor lifecycle (CodeMirror + JSONC-aware lint).
  //  - Keep backward compatibility (main.js + terminal.js call legacy globals).

  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.features = XKeen.features || {};

  const CORE_HTTP = (window.XKeen && window.XKeen.core && window.XKeen.core.http) ? window.XKeen.core.http : null;
  const CORE_STORAGE = (window.XKeen && window.XKeen.core && window.XKeen.core.storage) ? window.XKeen.core.storage : null;

  function _storeGet(key) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.get === 'function') return CORE_STORAGE.get(key); } catch (e) {}
    try { return localStorage.getItem(String(key)); } catch (e2) { return null; }
  }
  function _storeSet(key, val) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.set === 'function') return CORE_STORAGE.set(key, val); } catch (e) {}
    try { localStorage.setItem(String(key), String(val)); } catch (e2) {}
  }
  function _storeRemove(key) {
    try { if (CORE_STORAGE && typeof CORE_STORAGE.remove === 'function') return CORE_STORAGE.remove(key); } catch (e) {}
    try { localStorage.removeItem(String(key)); } catch (e2) {}
  }

  function _withCSRF(init, methodHint) {
    try {
      if (CORE_HTTP && typeof CORE_HTTP.withCSRF === 'function') return CORE_HTTP.withCSRF(init, methodHint);
    } catch (e) {}
    return init || {};
  }


  const IDS = {
    textarea: 'routing-editor',
    status: 'routing-status',
    error: 'routing-error',
    helpLine: 'routing-help-line',

    // Editor engine toggle (CodeMirror / Monaco)
    engineSelect: 'routing-editor-engine-select',
    monacoContainer: 'routing-editor-monaco',

    // Routing fragment selector (optional)
    fragmentSelect: 'routing-fragment-select',
    fragmentRefresh: 'routing-fragment-refresh-btn',
    fragmentAllToggle: 'routing-fragment-all-toggle',
    fileCode: 'routing-file-code',

    // Mode badge (Routing vs Fragment)
    modeBadge: 'routing-editor-mode-badge',

    // JSONC comments status (sidecar present / used)
    commentsStatus: 'routing-comments-status',

    btnSave: 'routing-save-btn',
    btnFormat: 'routing-format-btn',
    btnBackup: 'routing-backup-btn',
    btnRestoreAuto: 'routing-restore-auto-btn',

    // Optional (might not exist in some builds)
    btnClearComments: 'routing-clear-comments-btn',
    btnSort: 'routing-sort-btn',

    // Collapse
    header: 'routing-header',
    body: 'routing-body',
    arrow: 'routing-arrow',

    // Global flag
    autoRestart: 'global-autorestart-xkeen',
  };

  let _inited = false;
  let _cm = null;
  let _errorMarker = null;

  // Active routing fragment file (basename or absolute). Controlled by dropdown.
  let _activeFragment = null;

  // Semantic mode: 'routing' (routing config) or 'fragment' (generic Xray JSON).
  let _routingMode = 'routing';

  // Active editor engine: 'codemirror' (default) or 'monaco'
  let _engine = 'codemirror';
  let _monaco = null;
  let _monacoFacade = null;
  let _monacoHostEl = null;
  let _engineSelectEl = null;
  let _engineTouched = false;

  // Prevent concurrent editor engine switches (init + onShow may race on slow devices).
  // If Monaco gets created twice, it may throw: "Element already has context attribute".
  let _engineSwitchChain = Promise.resolve();

  // Monaco diagnostics debounce (markers).
  let _monacoDiagTimer = null;


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
      if (name) _storeSet('xkeen.routing.fragment', String(name));
    } catch (e) {}
  }

  function rememberFragmentsScopeAll(enabled) {
    try { _storeSet('xkeen.routing.fragments.all', enabled ? '1' : '0'); } catch (e) {}
  }

  function restoreFragmentsScopeAll() {
    try {
      const v = _storeGet('xkeen.routing.fragments.all');
      if (v === null || v === undefined) return false;
      return String(v) === '1' || String(v).toLowerCase() === 'true';
    } catch (e) {}
    return false;
  }

  function isFragmentsScopeAllEnabled() {
    try {
      const cb = $(IDS.fragmentAllToggle);
      if (cb) return !!cb.checked;
    } catch (e) {}
    return restoreFragmentsScopeAll();
  }

  function restoreRememberedFragment() {
    try {
      const v = _storeGet('xkeen.routing.fragment');
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

  function _activeFileNameForUI() {
    try {
      const f = getActiveFragment();
      if (f) return String(f);
    } catch (e) {}
    try {
      const sel = $(IDS.fragmentSelect);
      const cur = sel && sel.dataset ? String(sel.dataset.current || '') : '';
      if (cur) return cur;
    } catch (e2) {}
    return '';
  }

  function _updateModeBadge() {
    const badge = $(IDS.modeBadge);
    if (!badge) return;
    const isRouting = String(_routingMode || '') === 'routing';
    badge.textContent = isRouting ? 'Routing mode' : 'Fragment mode';
    try {
      badge.setAttribute('data-profile', isRouting ? 'routing' : 'fragment');
      badge.setAttribute('data-tooltip', 'Режим редактора: ' + (isRouting ? 'Routing mode' : 'Fragment mode'));
    } catch (e) {}
  }

  function _updateFileScopedTooltips() {
    const file = _activeFileNameForUI();
    if (!file) return;

    try {
      const saveBtn = $(IDS.btnSave);
      if (saveBtn) saveBtn.setAttribute('data-tooltip', 'Сохранить файл: ' + file);
    } catch (e) {}

    try {
      const backupBtn = $(IDS.btnBackup);
      if (backupBtn) backupBtn.setAttribute('data-tooltip', 'Backup для файла: ' + file);
    } catch (e) {}

    try {
      const raBtn = $(IDS.btnRestoreAuto);
      if (raBtn) raBtn.setAttribute('data-tooltip', 'Restore autobackup для файла: ' + file);
    } catch (e) {}
  }



  function _isPlainObject(v) {
    return !!(v && typeof v === 'object' && !Array.isArray(v));
  }

  function _detectRoutingModeFromParsed(obj, fileName) {
    // Heuristics:
    // - classic routing: root.routing is an object
    // - routing-only fragment: root has rules/balancers/domainStrategy
    // - fallback by file name contains 'routing'
    try {
      if (_isPlainObject(obj) && _isPlainObject(obj.routing)) return 'routing';
      if (_isPlainObject(obj)) {
        if (Array.isArray(obj.rules) || Array.isArray(obj.balancers)) return 'routing';
        if (obj.domainStrategy != null) return 'routing';
      }
    } catch (e) {}
    try {
      const fn = String(fileName || getActiveFragment() || '');
      if (fn && /routing/i.test(fn)) return 'routing';
    } catch (e2) {}
    return 'fragment';
  }

  function _detectRoutingModeFromText(rawText) {
    const fileName = getActiveFragment();
    const cleaned = stripJsonComments(String(rawText ?? ''));
    try {
      const obj = JSON.parse(cleaned);
      return _detectRoutingModeFromParsed(obj, fileName);
    } catch (e) {
      // If JSON is broken, fall back to file name / simple substring match.
      try {
        const fn = String(fileName || '');
        if (fn && /routing/i.test(fn)) return 'routing';
      } catch (e2) {}
      try {
        if (/\"routing\"\s*:\s*\{/.test(String(rawText || ''))) return 'routing';
      } catch (e3) {}
      return 'fragment';
    }
  }

  function _setElHidden(el, hide) {
    if (!el) return;
    try {
      if (hide) {
        if (el.dataset && el.dataset.xkPrevDisplay === undefined) {
          el.dataset.xkPrevDisplay = (el.style && el.style.display) ? String(el.style.display) : '';
        }
        el.style.display = 'none';
      } else {
        if (el.dataset && el.dataset.xkPrevDisplay !== undefined) {
          el.style.display = String(el.dataset.xkPrevDisplay || '');
          try { delete el.dataset.xkPrevDisplay; } catch (e) {}
        } else {
          el.style.display = '';
        }
      }
    } catch (e) {}
  }

  function _applyRoutingModeUI(mode) {
    const root = document.getElementById('view-routing') || document.body;
    const isRouting = String(mode || '') === 'routing';

    try {
      const els = root.querySelectorAll ? root.querySelectorAll('.xk-only-routing') : [];
      (els || []).forEach((el) => _setElHidden(el, !isRouting));
    } catch (e) {}

    // Update primary button labels/tooltips so the editor doesn't lie.
    try {
      const saveBtn = $(IDS.btnSave);
      if (saveBtn) {
        saveBtn.textContent = isRouting ? '💾 Save routing' : '💾 Save file';
        saveBtn.setAttribute('data-tooltip', isRouting
          ? 'Сохранить текущий роутинг (routing.json).'
          : 'Сохранить выбранный JSON‑файл (как есть, с поддержкой JSONC‑комментариев).');
      }
    } catch (e) {}

    // Keep the mode badge + file-scoped tooltips in sync.
    try { _updateModeBadge(); } catch (e) {}
    try { _updateFileScopedTooltips(); } catch (e) {}

    // Expose current mode (handy for other modules / debugging).
    try {
      if (window.XKeen && window.XKeen.state) window.XKeen.state.routingMode = isRouting ? 'routing' : 'fragment';
    } catch (e) {}
  }

  function _setRoutingMode(mode, reason) {
    const next = String(mode || '').toLowerCase() === 'routing' ? 'routing' : 'fragment';
    if (next === _routingMode) return;
    _routingMode = next;
    try { _applyRoutingModeUI(_routingMode); } catch (e) {}
    try {
      const ev = new CustomEvent('xkeen-routing-mode', { detail: { mode: _routingMode, reason: String(reason || '') } });
      window.dispatchEvent(ev);
    } catch (e2) {}
  }

  function _maybeUpdateModeFromParsed(obj) {
    try {
      const next = _detectRoutingModeFromParsed(obj, getActiveFragment());
      _setRoutingMode(next, 'parsed');
    } catch (e) {}
  }

  function _setCommentsBadge(found, using, bn) {
    const el = $(IDS.commentsStatus);
    if (!el) return;
    const has = !!found;
    el.classList.toggle('xk-comments-on', has);
    el.classList.toggle('xk-comments-off', !has);
    if (has) {
      el.textContent = using ? 'Комментарии: включены' : 'Комментарии: включены (не используются)';
      try {
        el.title = bn ? ('JSONC: ' + String(bn)) : 'JSONC sidecar найден';
      } catch (e) {}
    } else {
      el.textContent = 'Комментарии: выключены';
      try { el.title = 'JSONC sidecar не найден'; } catch (e) {}
    }
  }

  function _applyCommentsHeaders(res) {
    try {
      const found = (res && res.headers && res.headers.get('X-XKeen-JSONC') === '1');
      const using = (res && res.headers && res.headers.get('X-XKeen-JSONC-Using') === '1');
      const bn = (res && res.headers) ? (res.headers.get('X-XKeen-JSONC-File') || '') : '';
      _setCommentsBadge(found, using, bn);
    } catch (e) {}
  }

  async function refreshFragmentsList(opts) {
    const sel = $(IDS.fragmentSelect);
    if (!sel) return;

    const all = isFragmentsScopeAllEnabled();
    const url = all ? '/api/routing/fragments?all=1' : '/api/routing/fragments';

    const notify = !!(opts && opts.notify);
    let data = null;
    try {
      if (CORE_HTTP && typeof CORE_HTTP.fetchJSON === 'function') {
        data = await CORE_HTTP.fetchJSON(url, { method: 'GET', cache: 'no-store' }).catch(() => null);
      } else {
        const res = await fetch(url, { cache: 'no-store' });
        data = await res.json().catch(() => null);
      }
    } catch (e) {
      data = null;
    }
    if (!data || !data.ok || !Array.isArray(data.items)) {
      // Fallback: keep whatever is rendered by server
      try {
        if (notify && typeof window.toast === 'function') {
          window.toast(all ? 'Не удалось обновить список файлов Xray' : 'Не удалось обновить список файлов роутинга', 'error');
        }
      } catch (e) {}
      return;
    }

    const currentDefault = (data.current || sel.dataset.current || '').toString();
    const remembered = restoreRememberedFragment();
    const preferred = (getActiveFragment() || remembered || currentDefault || (data.items[0] ? data.items[0].name : '')).toString();

    // Optional UX: when switching from "All files" -> routing-only list,
    // explain why selection may jump back to the routing file.
    const prevSelection = (opts && opts.prevSelection) ? String(opts.prevSelection) : null;
    const scopeChanged = (opts && opts.scopeChanged) ? String(opts.scopeChanged) : '';

    function decorateName(n) {
      const name = String(n || '');
      if (!name) return '';
      // Mark special Hysteria2 fragments (used only when assembling hysteria2 configs)
      if (/_hys2\.json$/i.test(name)) return name + ' (Hysteria2)';
      return name;
    }

    // Rebuild options
    try { if (sel.dataset) sel.dataset.dir = String(data.dir || ''); } catch (e) {}
    sel.innerHTML = '';
    const names = data.items.map((it) => String(it.name || '')).filter(Boolean);

    // If currentDefault isn't in list, keep it as "custom"
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

    // Select preferred if exists
    try {
      const finalChoice = names.indexOf(preferred) !== -1 ? preferred : (currentDefault || (names[0] || ''));
      if (finalChoice) sel.value = finalChoice;
      _activeFragment = sel.value || finalChoice || null;
      rememberActiveFragment(_activeFragment);
      updateActiveFileLabel((data.dir ? String(data.dir).replace(/\/+$/, '') + '/' : '') + (_activeFragment || ''), data.dir || '');
      // Keep legacy global in sync
      try {
        if (window.XKEEN_FILES) window.XKEEN_FILES.routing = (data.dir ? String(data.dir).replace(/\/+$/, '') + '/' : '') + (_activeFragment || '');
      } catch (e) {}
    } catch (e) {}

    // If scope was reduced and a non-routing file disappeared from the list, clarify the jump.
    try {
      if (scopeChanged === 'off' && prevSelection && _activeFragment && prevSelection !== _activeFragment) {
        if (names.indexOf(prevSelection) === -1) {
          if (typeof window.toast === 'function') {
            window.toast('«Все файлы» выключено — переключено на: ' + String(_activeFragment), 'info');
          }
        }
      }
    } catch (e) {}

    // Keep badge/tooltips up-to-date (selection may change during refresh).
    try { _updateModeBadge(); } catch (e) {}
    try { _updateFileScopedTooltips(); } catch (e) {}

    // Wire refresh button (once)
    try {
      const btn = $(IDS.fragmentRefresh);
      if (btn && !btn.dataset.xkWired) {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          await refreshFragmentsList({ notify: true });
        });
        btn.dataset.xkWired = '1';
      }
      if (btn) {
        btn.setAttribute('data-tooltip', all
          ? 'Обновить список JSON-файлов Xray из /opt/etc/xray/configs/ (кроме 01_log.json)'
          : 'Обновить список файлов роутинга из /opt/etc/xray/configs/');
      }
    } catch (e) {}

    // Success toast (only when explicitly requested)
    try {
      if (notify && typeof window.toast === 'function') {
        window.toast(all ? 'Список файлов Xray обновлён' : 'Список файлов роутинга обновлён', 'success');
      }
    } catch (e) {}
  }




  function setStatus(msg, isError) {
    const el = $(IDS.status);
    if (el) el.textContent = String(msg ?? '');
    if (msg) toast(msg, !!isError);
  }

  function stripJsonComments(text) {
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.stripJsonComments === 'function') {
        return XKeen.util.stripJsonComments(String(text ?? ''));
      }
    } catch (e) {}
    try {
      if (typeof window.stripJsonComments === 'function') {
        return window.stripJsonComments(String(text ?? ''));
      }
    } catch (e) {}
    return String(text ?? '');
  }

  function hasUserComments(text) {
    const s = String(text ?? '');
    const cleaned = stripJsonComments(s);
    return cleaned !== s;
  }

  async function confirmCommentsLoss(actionLabel) {
    const title = 'Потеря комментариев';
    const prefix = actionLabel ? (String(actionLabel) + ': ') : '';
    const message = prefix + 'эта операция перезапишет документ и удалит все комментарии (//, /* */, #). Продолжить?';

    try {
      if (window.XKeen && window.XKeen.ui && typeof window.XKeen.ui.confirm === 'function') {
        return await window.XKeen.ui.confirm({
          title,
          message,
          okText: 'Продолжить',
          cancelText: 'Отмена',
          danger: true,
        });
      }
    } catch (e) {}

    try { return window.confirm(message); } catch (e) {}
    return false;
  }


const HELP_MODAL_ID = 'xkeen-routing-help-modal';
const HELP_IFRAME_ID = 'xkeen-routing-help-iframe';

function ensureHelpModal() {
  let modal = document.getElementById(HELP_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = HELP_MODAL_ID;
  modal.className = 'modal hidden';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Routing help');

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.maxWidth = '960px';

  const header = document.createElement('div');
  header.className = 'modal-header';

  const title = document.createElement('span');
  title.className = 'modal-title';
  title.textContent = 'Справка по комментариям routing (JSONC)';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.style.paddingTop = '8px';

  const iframe = document.createElement('iframe');
  iframe.id = HELP_IFRAME_ID;
  iframe.src = '/static/routing-comments-help.html';
  iframe.loading = 'lazy';
  iframe.style.width = '100%';
  // Let the iframe occupy the whole modal body. We disable the modal-body
  // scrolling for this modal via CSS to avoid a "double scroll" (modal + iframe).
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.borderRadius = '10px';

  body.appendChild(iframe);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.style.justifyContent = 'flex-end';

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'btn-secondary';
  okBtn.textContent = 'Закрыть';

  actions.appendChild(okBtn);

  content.appendChild(header);
  content.appendChild(body);
  content.appendChild(actions);
  modal.appendChild(content);

  function close() { closeHelp(); }
  closeBtn.addEventListener('click', close);
  okBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  document.body.appendChild(modal);
  return modal;
}

function openHelp() {
  const modal = ensureHelpModal();
  modal.classList.remove('hidden');
  try { document.body.classList.add('modal-open'); } catch (e) {}
}

function closeHelp() {
  const modal = document.getElementById(HELP_MODAL_ID);
  if (!modal) return;
  modal.classList.add('hidden');
  try { document.body.classList.remove('modal-open'); } catch (e) {}
}

  function shouldAutoRestartAfterSave() {
    const cb = $(IDS.autoRestart);
    return !!(cb && cb.checked);
  }

  function clearErrorMarker() {
    try {
      if (_errorMarker && typeof _errorMarker.clear === 'function') _errorMarker.clear();
    } catch (e) {}
    _errorMarker = null;
  }

  function setError(message, line /* 0-based */) {
    const errEl = $(IDS.error);
    if (errEl) errEl.textContent = String(message ?? '');

    // Always clear previous CM marker (if any).
    clearErrorMarker();

    // In Monaco mode we don't create CodeMirror line markers.
    // Monaco editor markers are managed separately (runMonacoDiagnostics).
    if (_engine === 'monaco') return;

    if (!_cm || !_cm.getDoc) return;

    if (typeof line !== 'number' || line < 0) return;
    try {
      const doc = _cm.getDoc();
      const lineText = doc.getLine(line) || '';
      _errorMarker = doc.markText(
        { line, ch: 0 },
        { line, ch: Math.max(1, lineText.length) },
        { className: 'cm-error-line' }
      );
      if (_cm.scrollIntoView) _cm.scrollIntoView({ line, ch: 0 }, 200);
    } catch (e) {
      // ignore
    }
  }

  function extractJsonErrorPos(err) {
    const msg = String(err && err.message ? err.message : '');
    const m = /position\s+(\d+)/i.exec(msg);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  function posToLineCh(text, pos) {
    // Converts a char index into {line, ch} by scanning newlines.
    const s = String(text ?? '');
    const p = typeof pos === 'number' && pos >= 0 ? pos : 0;

    let line = 0;
    let lastNL = -1;
    const lim = Math.min(p, s.length);
    for (let i = 0; i < lim; i++) {
      if (s.charCodeAt(i) === 10) {
        line++;
        lastNL = i;
      }
    }
    return { line, ch: Math.max(0, p - (lastNL + 1)) };
  }

  // ------------------------ Monaco diagnostics (JSON markers) ------------------------

  function stripJsonCommentsWithMap(input) {
    // Returns { cleaned, map } where map[cleanedIndex] = rawIndex.
    const raw = String(input ?? '');
    const cleaned = [];
    const map = [];

    let inString = false;
    let escape = false;
    let i = 0;
    const n = raw.length;

    while (i < n) {
      const ch = raw[i];

      if (inString) {
        cleaned.push(ch);
        map.push(i);

        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        i++;
        continue;
      }

      if (ch === '"') {
        inString = true;
        cleaned.push(ch);
        map.push(i);
        i++;
        continue;
      }

      // Single-line comment //
      if (ch === '/' && i + 1 < n && raw[i + 1] === '/') {
        i += 2;
        while (i < n && raw[i] !== '\n') i++;
        continue;
      }

      // Single-line comment starting with #
      if (ch === '#') {
        i++;
        while (i < n && raw[i] !== '\n') i++;
        continue;
      }

      // Multi-line comment /* ... */
      if (ch === '/' && i + 1 < n && raw[i + 1] === '*') {
        i += 2;
        while (i + 1 < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
        if (i + 1 < n) i += 2;
        continue;
      }

      cleaned.push(ch);
      map.push(i);
      i++;
    }

    return { cleaned: cleaned.join(''), map };
  }

  function clearMonacoMarkers() {
    try {
      if (!_monaco) return;
      const api = window.monaco;
      if (!api || !api.editor || typeof api.editor.setModelMarkers !== 'function') return;
      const model = (_monaco.getModel && _monaco.getModel()) ? _monaco.getModel() : null;
      if (!model) return;
      api.editor.setModelMarkers(model, 'xkeen', []);
    } catch (e) {}
  }

  function setMonacoMarkers(markers) {
    try {
      if (!_monaco) return;
      const api = window.monaco;
      if (!api || !api.editor || typeof api.editor.setModelMarkers !== 'function') return;
      const model = (_monaco.getModel && _monaco.getModel()) ? _monaco.getModel() : null;
      if (!model) return;
      api.editor.setModelMarkers(model, 'xkeen', Array.isArray(markers) ? markers : []);
    } catch (e) {}
  }

  function indexToMonacoLineCol(text, rawIndex) {
    // Monaco uses 1-based line/column.
    const s = String(text ?? '');
    const p = Math.max(0, Math.min(typeof rawIndex === 'number' ? rawIndex : 0, s.length));
    let line = 1;
    let col = 1;
    for (let i = 0; i < p; i++) {
      if (s.charCodeAt(i) === 10) { // \n
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  }

  function runMonacoDiagnostics() {
    // Validate JSONC (strip comments) and show errors as Monaco markers (no auto-fix).
    const raw = getEditorText();

    if (!String(raw ?? '').trim()) {
      setError('Файл пуст. Введи корректный JSON.', null);
      try {
        const api = window.monaco;
        const sev = (api && api.MarkerSeverity && api.MarkerSeverity.Error) ? api.MarkerSeverity.Error : 8;
        setMonacoMarkers([{
          severity: sev,
          message: 'Файл пуст',
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        }]);
      } catch (e) {}
      return false;
    }

    const sm = stripJsonCommentsWithMap(raw);
    const cleaned = sm.cleaned;

    try {
      const obj = JSON.parse(cleaned);
      setError('', null);
      clearMonacoMarkers();
      _maybeUpdateModeFromParsed(obj);
      return true;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      const pos = extractJsonErrorPos(e) ?? 0;

      let rawIdx = 0;
      try {
        if (sm && Array.isArray(sm.map) && sm.map.length) {
          const p = Math.max(0, Math.min(pos, sm.map.length - 1));
          rawIdx = sm.map[p];
        }
      } catch (e2) { rawIdx = 0; }

      const lc = indexToMonacoLineCol(raw, rawIdx);

      try {
        const api = window.monaco;
        const sev = (api && api.MarkerSeverity && api.MarkerSeverity.Error) ? api.MarkerSeverity.Error : 8;
        setMonacoMarkers([{
          severity: sev,
          message: msg || 'JSON parse error',
          startLineNumber: lc.line,
          startColumn: lc.col,
          endLineNumber: lc.line,
          endColumn: lc.col + 1,
        }]);
      } catch (e3) {}

      setError('Ошибка JSON: ' + msg, null);
      return false;
    }
  }

  function scheduleMonacoDiagnostics() {
    try { if (_monacoDiagTimer) clearTimeout(_monacoDiagTimer); } catch (e) {}
    _monacoDiagTimer = setTimeout(() => {
      _monacoDiagTimer = null;
      try {
        if (_engine === 'monaco' && _monaco) runMonacoDiagnostics();
      } catch (e) {}
    }, 400);
  }


  function validate() {
    // Monaco: show diagnostics as editor markers (debounced on input).
    try {
      if (_engine === 'monaco' && _monaco) return runMonacoDiagnostics();
    } catch (e) {}

    const raw = getEditorText();
    const cleaned = stripJsonComments(raw);

    if (!String(raw ?? '').trim()) {
      setError('Файл пуст. Введи корректный JSON.', null);
      return false;
    }

    try {
      const obj = JSON.parse(cleaned);
      setError('', null);
      _maybeUpdateModeFromParsed(obj);
      return true;
    } catch (e) {
      const pos = extractJsonErrorPos(e);
      if (typeof pos === 'number') {
        const lc = posToLineCh(cleaned, pos);
        setError('Ошибка JSON: ' + (e && e.message ? e.message : e), lc.line);
      } else {
        setError('Ошибка JSON: ' + (e && e.message ? e.message : e), null);
      }
      return false;
    }
  }

  function jsoncLint(text) {
    // CodeMirror lint adapter: return array of annotations
    const raw = String(text ?? '');
    const sm = stripJsonCommentsWithMap(raw);
    const cleaned = sm.cleaned;

    try {
      JSON.parse(cleaned);
      return [];
    } catch (e) {
      const pos = extractJsonErrorPos(e) ?? 0;

      let rawIdx = 0;
      try {
        if (sm && Array.isArray(sm.map) && sm.map.length) {
          const p = Math.max(0, Math.min(pos, sm.map.length - 1));
          rawIdx = sm.map[p];
        }
      } catch (e2) { rawIdx = 0; }

      const lc = posToLineCh(raw, rawIdx);

      return [
        {
          from: { line: lc.line, ch: lc.ch },
          to: { line: lc.line, ch: lc.ch + 1 },
          message: (e && e.message) ? e.message : 'JSON parse error',
          severity: 'error',
        },
      ];
    }
  }

  async function load() {
    const statusEl = $(IDS.status);
    if (statusEl) statusEl.textContent = 'Загрузка файла…';
    try {
      const file = getActiveFragment();
      const url = file ? ('/api/routing?file=' + encodeURIComponent(file)) : '/api/routing';
      const res = await fetch(url, { cache: 'no-store' });
      _applyCommentsHeaders(res);
      if (!res.ok) {
        if (statusEl) statusEl.textContent = 'Не удалось загрузить файл.';
        toast('Не удалось загрузить файл.', true);
        return;
      }

      // Optional server notice (e.g. JSON-with-comments -> JSONC auto-migration)
      try {
        const b64 = res.headers.get('X-XKeen-Notice-B64');
        if (b64) {
          const kind = res.headers.get('X-XKeen-Notice-Kind') || 'info';
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const msg = new TextDecoder('utf-8').decode(bytes);
          if (msg) toast(msg, kind);
        }
      } catch (e) {}

      const text = await res.text();
      setEditorTextAll(text);
      scrollEditorsTop();

      try { _setRoutingMode(_detectRoutingModeFromText(text), 'load'); } catch (e) {}

      try {
        // Keep compatibility with existing monolith flags, if present.
        window.routingSavedContent = text;
        window.routingIsDirty = false;
        const saveBtn = $(IDS.btnSave);
        if (saveBtn) saveBtn.classList.remove('dirty');
      } catch (e) {}

      const okJson = validate();
      if (statusEl) statusEl.textContent = okJson ? (_routingMode === 'routing' ? 'Routing загружен.' : 'Файл загружен.') : 'Файл загружен, но содержит ошибку JSON.';
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = window.XKEEN_FILES && window.XKEEN_FILES.routing ? window.XKEEN_FILES.routing : '';
          window.updateLastActivity('loaded', 'routing', fp);
        }
      } catch (e) {}
    } catch (e) {
      console.error(e);
      _setCommentsBadge(false, false, '');
      if (statusEl) statusEl.textContent = 'Ошибка загрузки файла.';
      toast('Ошибка загрузки файла.', true);
    }
  }

  async function save() {
    const statusEl = $(IDS.status);
    const rawText = getEditorText();
    const cleaned = stripJsonComments(rawText);
    try {
      JSON.parse(cleaned);
      setError('', null);
    } catch (e) {
      setError('Ошибка JSON: ' + (e && e.message ? e.message : e), null);
      if (statusEl) statusEl.textContent = 'Ошибка: некорректный JSON.';
      toast('Ошибка: некорректный JSON.', true);
      return;
    }

    const restart = shouldAutoRestartAfterSave();

    try {
      const file = getActiveFragment();
      const url = '/api/routing?restart=' + (restart ? '1' : '0') + (file ? ('&file=' + encodeURIComponent(file)) : '');
      const res = await fetch(url, _withCSRF({
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: rawText,
      }, 'POST'));

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (res.ok && data && data.ok) {
        // Saving always writes the JSONC sidecar.
        _setCommentsBadge(true, true, '');
        try {
          window.routingSavedContent = rawText;
          window.routingIsDirty = false;
          const saveBtn = $(IDS.btnSave);
          if (saveBtn) saveBtn.classList.remove('dirty');
        } catch (e) {}

        let msg = (_routingMode === 'routing') ? 'Routing сохранён.' : 'Файл сохранён.';
        if (statusEl) statusEl.textContent = msg;
        if (!data || !data.restarted) {
          toast(msg, false);
        }
        try {
          if (typeof window.updateLastActivity === 'function') {
            const fp = window.XKEEN_FILES && window.XKEEN_FILES.routing ? window.XKEEN_FILES.routing : '';
            window.updateLastActivity('saved', 'routing', fp);
          }
        } catch (e) {}
      } else {
        const msg = 'Save error: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status) || 'неизвестная ошибка');
        if (statusEl) statusEl.textContent = msg;
        toast(msg, true);
      }
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Ошибка при сохранении файла.';
      toast('Ошибка при сохранении файла.', true);
    }
  }


  async function getPreferPrettierFlag() {
    // Load server settings only on demand (no auto-fetch on page load).
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.settings) {
        if (typeof XKeen.ui.settings.fetchOnce === 'function') {
          const st = await XKeen.ui.settings.fetchOnce().catch(() => null);
          if (st && st.format && typeof st.format.preferPrettier === 'boolean') {
            return !!st.format.preferPrettier;
          }
        }
        if (typeof XKeen.ui.settings.get === 'function') {
          const st2 = XKeen.ui.settings.get();
          if (st2 && st2.format && typeof st2.format.preferPrettier === 'boolean') {
            return !!st2.format.preferPrettier;
          }
        }
      }
    } catch (e) {}
    return false;
  }
  async function format() {
    const statusEl = $(IDS.status);
    const text = getEditorText();
    const cleaned = stripJsonComments(text);
    try {
      // Validate first (JSONC comments allowed)
      JSON.parse(cleaned);
    } catch (e) {
      setError('Ошибка JSON: ' + (e && e.message ? e.message : e), null);
      if (statusEl) statusEl.textContent = 'Не удалось отформатировать: некорректный JSON.';
      toast('Не удалось отформатировать: некорректный JSON.', true);
      return;
    }

    // If enabled in ui-settings, try browser-side Prettier first.
    // Fallback is preserved: server-side formatter -> JSON.stringify.
    let preferPrettier = false;
    try {
      preferPrettier = await getPreferPrettierFlag();
    } catch (e) {
      preferPrettier = false;
    }

    if (preferPrettier) {
      try {
        const F = (window.XKeen && XKeen.ui && XKeen.ui.formatters) ? XKeen.ui.formatters : null;
        if (F && typeof F.formatJson === 'function') {
          const r = await F.formatJson(text, { parser: 'jsonc' });
          if (r && r.ok === true && typeof r.text === 'string') {
            setEditorTextAll(r.text);
            scrollEditorsTop();
            setError('', null);
            if (statusEl) statusEl.textContent = 'JSON отформатирован.';
            toast('JSON отформатирован.', false);
            return;
          }
        }
      } catch (e) {
        // continue with fallback
      }
    }

    // Prefer server-side formatter that preserves comments (JSONC/JS style).
    // Falls back to classic JSON.stringify (will remove comments).
    let serverFormatted = null;
    try {
      const res = await fetch('/api/json/format', _withCSRF({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }, 'POST'));
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok === true && typeof data.text === 'string') {
        serverFormatted = data.text;
      }
    } catch (e) {
      serverFormatted = null;
    }

    try {
      if (typeof serverFormatted === 'string') {
        setEditorTextAll(serverFormatted);
      } else {
        // Legacy fallback (comments will be lost)
        if (hasUserComments(text)) {
          const ok = await confirmCommentsLoss('Форматирование');
          if (!ok) return;
        }
        const obj = JSON.parse(cleaned);
        setEditorTextAll(JSON.stringify(obj, null, 2));
      }

      scrollEditorsTop();
      setError('', null);
      if (statusEl) statusEl.textContent = 'JSON отформатирован.';
      toast('JSON отформатирован.', false);
    } catch (e) {
      setError('Ошибка JSON: ' + (e && e.message ? e.message : e), null);
      if (statusEl) statusEl.textContent = 'Не удалось отформатировать: некорректный JSON.';
      toast('Не удалось отформатировать: некорректный JSON.', true);
    }
  }

  function clearComments() {
    const statusEl = $(IDS.status);
    const text = getEditorText();
    const cleaned = stripJsonComments(text);
    _cm.setValue(cleaned);
    validate();
    if (statusEl) statusEl.textContent = 'Комментарии удалены.';
    toast('Комментарии удалены.', false);
  }
  async function sortRules() {
    if (_routingMode !== 'routing') {
      try { toast('Сортировка доступна только для routing.rules.', 'info'); } catch (e) { try { toast('Сортировка доступна только для routing.rules.', false); } catch (e2) {} }
      return;
    }
    const statusEl = $(IDS.status);
    const text = getEditorText();
    const cleaned = stripJsonComments(text);

    
    if (hasUserComments(text)) {
      const ok = await confirmCommentsLoss('Сортировка routing.rules');
      if (!ok) return;
    }
    try {
      const obj = JSON.parse(cleaned);
      if (!obj.routing || !Array.isArray(obj.routing.rules)) {
        if (statusEl) statusEl.textContent = 'Не найден массив routing.rules для сортировки.';
        toast('Не найден массив routing.rules для сортировки.', true);
        return;
      }
      const rules = obj.routing.rules.slice();
      rules.sort((a, b) => {
        const oa = (a.outboundTag || a.outbound || '').toString();
        const ob = (b.outboundTag || b.outbound || '').toString();
        if (oa < ob) return -1;
        if (oa > ob) return 1;
        const ta = (a.type || '').toString();
        const tb = (b.type || '').toString();
        if (ta < tb) return -1;
        if (ta > tb) return 1;
        return 0;
      });
      obj.routing.rules = rules;
      setEditorTextAll(JSON.stringify(obj, null, 2));
      setError('', null);
      if (statusEl) statusEl.textContent = 'Правила routing.rules упорядочены.';
      toast('Правила routing.rules упорядочены.', false);
    } catch (e) {
      setError('Ошибка JSON: ' + (e && e.message ? e.message : e), null);
      if (statusEl) statusEl.textContent = 'Не удалось упорядочить правила: некорректный JSON.';
      toast('Не удалось упорядочить правила: некорректный JSON.', true);
    }
  }

  async function backup() {
    const statusEl = $(IDS.status);
    const backupsStatusEl = document.getElementById('backups-status');
    try {
      const file = getActiveFragment();
      let url = '';
      if (_routingMode === 'routing') {
        url = '/api/backup' + (file ? ('?file=' + encodeURIComponent(file)) : '');
      } else {
        if (!file) {
          const msg = 'Выберите файл для бэкапа.';
          if (statusEl) statusEl.textContent = msg;
          toast(msg, true);
          return;
        }
        url = '/api/backup-fragment?file=' + encodeURIComponent(file);
      }
      const res = await fetch(url, _withCSRF({ method: 'POST' }, 'POST'));
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.ok && data && data.ok) {
        const msg = 'Бэкап создан: ' + (data.filename || '(без имени)');
        if (statusEl) statusEl.textContent = msg;
        if (backupsStatusEl) backupsStatusEl.textContent = '';
        toast(msg, false);
        // Refresh backups list (module)
        try {
          if (window.XKeen && XKeen.backups) {
            if (typeof XKeen.backups.refresh === 'function') await XKeen.backups.refresh();
            else if (typeof XKeen.backups.load === 'function') await XKeen.backups.load();
          }
        } catch (e) {}
      } else {
        const msg = 'Ошибка создания бэкапа: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status) || 'неизвестная ошибка');
        if (statusEl) statusEl.textContent = msg;
        toast(msg, true);
      }
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка создания бэкапа.';
      if (statusEl) statusEl.textContent = msg;
      toast(msg, true);
    }
  }

  async function restoreAuto() {
    const statusEl = $(IDS.status);
    const file = getActiveFragment();

    // Use a human label for confirmations
    let label = '';
    if (_routingMode === 'routing') {
      // Use the actual routing file name (supports 05_routing_hys2.json)
      label = '05_routing.json';
      try {
        if (file) {
          label = String(file).split(/[\\/]/).pop() || label;
        } else if (window.XKEEN_FILES && window.XKEEN_FILES.routing) {
          label = String(window.XKEEN_FILES.routing).split(/[\\/]/).pop() || label;
        }
      } catch (e) {}
    } else {
      label = file ? String(file).split(/[\\/]/).pop() : 'выбранный файл';
    }

    if (!confirm('Восстановить из авто-бэкапа файл ' + label + '?')) return;

    try {
      let endpoint = '/api/restore-auto';
      let body = { target: 'routing' };
      if (_routingMode !== 'routing') {
        if (!file) {
          const msg = 'Выберите файл для восстановления из авто-бэкапа.';
          if (statusEl) statusEl.textContent = msg;
          toast(msg, true);
          return;
        }
        endpoint = '/api/restore-auto-fragment';
        body = { file: file };
      } else {
        // Support multiple routing fragments (e.g. 05_routing_hys2.json)
        if (file) body.file = file;
      }

      const res = await fetch(endpoint, _withCSRF({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 'POST'));
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.ok && data && data.ok) {
        const fname = data.filename || '';
        const msg = 'Файл ' + label + ' восстановлен из авто-бэкапа ' + fname;
        if (statusEl) statusEl.textContent = msg;
        toast(msg, false);
        await load();
      } else {
        const msg = 'Ошибка восстановления из авто-бэкапа: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status) || 'неизвестная ошибка');
        if (statusEl) statusEl.textContent = msg;
        toast(msg, true);
      }
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка восстановления из авто-бэкапа.';
      if (statusEl) statusEl.textContent = msg;
      toast(msg, true);
    }
  }

  function toggleCard() {
    const body = $(IDS.body);
    const arrow = $(IDS.arrow);
    if (!body || !arrow) return;

    const willOpen = body.style.display === 'none';
    body.style.display = willOpen ? 'block' : 'none';
    arrow.textContent = willOpen ? '▲' : '▼';
    if (willOpen) {
      if (_engine === 'monaco') {
        try { if (_monaco && _monaco.layout) _monaco.layout(); } catch (e) {}
      } else if (_cm && _cm.refresh) {
        try { _cm.refresh(); } catch (e) {}
      }
    }
  }

  function wireButton(btnId, handler) {
    const btn = $(btnId);
    if (!btn) return;
    if (btn.dataset && btn.dataset.xkeenWired === '1') return;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        Promise.resolve(handler()).catch((err) => {
          try { console.error(err); } catch (e) {}
        });
      } catch (err) {
        try { console.error(err); } catch (e) {}
      }
    });
    if (btn.dataset) btn.dataset.xkeenWired = '1';
  }

  function wireUI() {
    // Main buttons
    wireButton(IDS.btnSave, () => {
      // keep legacy behavior: validate before save
      if (validate()) save();
      else setStatus('Ошибка: некорректный JSON.', true);
    });
    wireButton(IDS.btnFormat, format);
    wireButton(IDS.btnBackup, backup);
    wireButton(IDS.btnRestoreAuto, restoreAuto);

    // Optional utilities
    wireButton(IDS.btnClearComments, clearComments);
    wireButton(IDS.btnSort, sortRules);

    // Collapse header
    const header = $(IDS.header);
    if (header && !(header.dataset && header.dataset.xkeenWired === '1')) {
      header.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('button, a, input, textarea, select, label')) return;
        toggleCard();
      });
      if (header.dataset) header.dataset.xkeenWired = '1';
    }
    // Fragment selector (routing fragments in /opt/etc/xray/configs/*routing*.json)
    const fragSel = $(IDS.fragmentSelect);
    if (fragSel && !(fragSel.dataset && fragSel.dataset.xkeenWired === '1')) {
      fragSel.addEventListener('change', async (e) => {
        const next = String(fragSel.value || '');
        if (!next) return;

        // If there are unsaved changes, ask before switching.
        let dirty = false;
        try { dirty = !!window.routingIsDirty; } catch (e) {}
        if (dirty) {
          const ok = await (window.XKeen && window.XKeen.ui && typeof window.XKeen.ui.confirm === 'function'
            ? window.XKeen.ui.confirm({
                title: 'Несохранённые изменения',
                message: 'В редакторе есть несохранённые изменения. Переключить файл и потерять их?',
                okText: 'Переключить',
                cancelText: 'Остаться',
                danger: true,
              })
            : Promise.resolve(window.confirm('Есть несохранённые изменения. Переключить файл и потерять их?')));
          if (!ok) {
            // revert selection
            try { fragSel.value = _activeFragment || fragSel.value; } catch (e) {}
            return;
          }
        }

        _activeFragment = next;
        rememberActiveFragment(_activeFragment);
        try {
          const dir = fragSel.dataset && fragSel.dataset.dir ? String(fragSel.dataset.dir) : '';
          updateActiveFileLabel((dir ? dir.replace(/\/+$/, '') + '/' : '') + _activeFragment, dir);
        } catch (e2) {}

        // Update tooltips immediately so actions are self-documenting even before load() completes.
        try { _updateFileScopedTooltips(); } catch (e) {}
        try { _updateModeBadge(); } catch (e) {}

        // Keep legacy global in sync for labels
        try {
          const dir2 = fragSel.dataset && fragSel.dataset.dir ? String(fragSel.dataset.dir) : '';
          if (window.XKEEN_FILES) window.XKEEN_FILES.routing = (dir2 ? dir2.replace(/\/+$/, '') + '/' : '') + _activeFragment;
        } catch (e3) {}

        await load();
      });
      if (fragSel.dataset) fragSel.dataset.xkeenWired = '1';
    }

    // "All files" toggle for fragment selector (optional)
    const allCb = $(IDS.fragmentAllToggle);
    if (allCb && !(allCb.dataset && allCb.dataset.xkWired === '1')) {
      try { allCb.checked = restoreFragmentsScopeAll(); } catch (e) {}
      allCb.addEventListener('change', async () => {
        const enabled = !!allCb.checked;
        const prevSel = getActiveFragment();
        rememberFragmentsScopeAll(enabled);
        await refreshFragmentsList({ notify: true, scopeChanged: enabled ? 'on' : 'off', prevSelection: prevSel });
        // Do not auto-switch file here: keep selection. Reload content so the editor stays consistent.
        try { await load(); } catch (e) {}
      });
      if (allCb.dataset) allCb.dataset.xkWired = '1';
    }

    // Help line
    const help = $(IDS.helpLine);
    if (help && !(help.dataset && help.dataset.xkeenWired === '1')) {
      help.addEventListener('click', (e) => {
        e.preventDefault();
        openHelp();
      });
      if (help.dataset) help.dataset.xkeenWired = '1';
    }

    // Auto-close the compact ⋯ menu after clicking an action button (keeps UI tidy).
    try {
      const details = document.querySelector('details.xk-routing-menu');
      const panel = details ? details.querySelector('.xk-routing-menu-panel') : null;
      if (details && panel && !(details.dataset && details.dataset.xkAutoClose === '1')) {
        panel.addEventListener('click', (e) => {
          const btn = e.target && e.target.closest ? e.target.closest('button') : null;
          if (!btn) return;
          // Keep menu open for non-action controls (currently only the scope toggle lives in a <label>).
          // For any button click, close the menu.
          try { details.open = false; } catch (e2) {}
        });
        if (details.dataset) details.dataset.xkAutoClose = '1';
      }
    } catch (e) {}

  }

  function createEditor() {
    const textarea = $(IDS.textarea);
    if (!textarea || !window.CodeMirror) return null;

    // If main.js provides shared keybindings, reuse them.
    let cmExtraKeysCommon = null;
    try {
      if (typeof window.buildCmExtraKeysCommon === 'function') {
        cmExtraKeysCommon = window.buildCmExtraKeysCommon();
      }
    } catch (e) {}

    const extraKeys = Object.assign({}, cmExtraKeysCommon || {}, {
      'Ctrl-F': 'findPersistent',
      'Cmd-F': 'findPersistent',
      'Ctrl-G': 'findNext',
      'Cmd-G': 'findNext',
      'Shift-Ctrl-G': 'findPrev',
      'Shift-Cmd-G': 'findPrev',
      'Ctrl-H': 'replace',
      'Shift-Ctrl-H': 'replaceAll',
    });

    const cm = window.CodeMirror.fromTextArea(textarea, {
      // Routing supports JSON with comments (raw *.jsonc is saved alongside the
      // cleaned JSON for xray), so enable commenting in the editor.
      mode: { name: 'javascript', json: true },
      theme: 'material-darker',
      lineNumbers: true,
      styleActiveLine: true,
      showIndentGuides: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      highlightSelectionMatches: true,
      showTrailingSpace: true,
      rulers: [{ column: 120 }],
      lineWrapping: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers'],

      // Prefer brace+comment folding when available (requires addon/fold/comment-fold.js)
      foldOptions: (function() {
        try {
          const F = window.CodeMirror && window.CodeMirror.fold;
          if (!F) return undefined;
          const finders = [];
          if (typeof F.brace === 'function') finders.push(F.brace);
          if (typeof F.comment === 'function') finders.push(F.comment);
          if (finders.length >= 2 && typeof F.combine === 'function') return { rangeFinder: F.combine.apply(null, finders) };
          if (finders.length === 1) return { rangeFinder: finders[0] };
          return undefined;
        } catch (e) {
          return undefined;
        }
      })(),

      // IMPORTANT: JSONC-aware lint (strip comments first)
      lint: { getAnnotations: jsoncLint, async: false },

      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys,
      // Continue line/block comments on Enter (requires addon/comment/continuecomment.js)
      continueComments: true,
      viewportMargin: Infinity,
    });

    // Add an overlay to highlight lines starting with '#' as comments (JSONC extension).
    try {
      if (cm && typeof cm.addOverlay === 'function') {
        const hashCommentOverlay = {
          token: function(stream) {
            if (stream.sol()) {
              stream.eatSpace();
              if (stream.peek && stream.peek() === '#') {
                stream.skipToEnd();
                return 'comment';
              }
            }
            stream.skipToEnd();
            return null;
          }
        };
        cm.addOverlay(hashCommentOverlay);
      }
    } catch (e) {}
    // Cosmetic class + toolbar
    // IMPORTANT: Keep ONLY one help entry in the toolbar.
    // The default CodeMirror help (red '?') is removed, because its purpose overlaps with
    // our routing comments help. We keep the yellow JSONC help button only.
    try {
      if (cm.getWrapperElement) {
        cm.getWrapperElement().classList.add('xkeen-cm');
        if (typeof window.xkeenAttachCmToolbar === 'function' && window.XKEEN_CM_TOOLBAR_DEFAULT) {
          const base = Array.isArray(window.XKEEN_CM_TOOLBAR_DEFAULT) ? window.XKEEN_CM_TOOLBAR_DEFAULT : [];
          const items = [];
          let inserted = false;
          (base || []).forEach((it) => {
            // Drop the default CodeMirror help button (red '?').
            if (it && it.id === 'help') {
              if (!inserted) {
                items.push({
                  id: 'help_comments',
                  svg: (window.XKEEN_CM_ICONS && window.XKEEN_CM_ICONS.help) ? window.XKEEN_CM_ICONS.help : it.svg,
                  label: 'Справка (комментарии)',
                  fallbackHint: 'JSONC',
                  isCommentsHelp: true,
                  onClick: () => openHelp(),
                });
                inserted = true;
              }
              return;
            }
            items.push(it);
          });

          // If defaults did not contain a help button at all, still add JSONC help at the end.
          if (!inserted) {
            items.push({
              id: 'help_comments',
              svg: (window.XKEEN_CM_ICONS && window.XKEEN_CM_ICONS.help) ? window.XKEEN_CM_ICONS.help : '',
              label: 'Справка (комментарии)',
              fallbackHint: 'JSONC',
              isCommentsHelp: true,
              onClick: () => openHelp(),
            });
          }
          window.xkeenAttachCmToolbar(cm, items);
        }
      }
    } catch (e) {}

cm.on('change', () => {
      validate();
    });

    return cm;
  }

  function moveToolbarToHost(cm) {
    try {
      const host = document.getElementById('routing-toolbar-host');
      if (!host || !cm || !cm._xkeenToolbarEl) return;
      if (host.contains(cm._xkeenToolbarEl)) return;
      host.appendChild(cm._xkeenToolbarEl);
      // Mark so CSS can adjust spacing when toolbar lives inside the header.
      try { cm._xkeenToolbarEl.classList.add('xk-toolbar-in-host'); } catch (e) {}
      // If Monaco is active, keep only the JSONC help button visible.
      try { syncToolbarForEngine(_engine); } catch (e) {}
    } catch (e) {}
  }

  function syncToolbarForEngine(engine) {
    try {
      if (!_cm || !_cm._xkeenToolbarEl || !_cm._xkeenToolbarEl.querySelectorAll) return;
      const bar = _cm._xkeenToolbarEl;
      const isMonaco = (String(engine || '').toLowerCase() === 'monaco');

      // Always keep the toolbar container visible in the host so layout doesn't jump.
      bar.style.display = '';

      const btns = bar.querySelectorAll('button.xkeen-cm-tool');
      (btns || []).forEach((btn) => {
        const isCommentsHelp = !!(
          btn.classList.contains('is-comments-help') ||
          (btn.dataset && btn.dataset.actionId === 'help_comments')
        );
        // In Monaco mode show only the yellow JSONC help button.
        btn.style.display = (isMonaco && !isCommentsHelp) ? 'none' : '';
      });
    } catch (e) {}
  }

  // ------------------------ editor engine toggle (CodeMirror / Monaco) ------------------------

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  // Legacy per-feature key (used before global editorEngine helper existed).
  const LEGACY_LS_KEY = 'xkeen.routing.editor.engine';
  const GLOBAL_LS_KEY = 'xkeen.editor.engine';

  function _settingsLoadedFromServer() {
    try {
      return !!(XKeen.ui && XKeen.ui.settings && typeof XKeen.ui.settings.isLoadedFromServer === 'function' && XKeen.ui.settings.isLoadedFromServer());
    } catch (e) {}
    return false;
  }

  function _hasGlobalEditorEngine() {
    try {
      return !!(XKeen.ui && XKeen.ui.editorEngine && typeof XKeen.ui.editorEngine.get === 'function' && typeof XKeen.ui.editorEngine.set === 'function');
    } catch (e) {}
    return false;
  }

  function _readLocal(key) {
    try { return String(_storeGet(key) || ''); } catch (e) { return ''; }
  }

  function _writeLocal(key, val) {
    try { _storeSet(key, String(val || '')); } catch (e) {}
  }

  function _removeLocal(key) {
    try { _storeRemove(key); } catch (e) {}
  }

  function migrateLegacyEngineIfNeeded() {
    // If server settings are already known, do not override them.
    if (_settingsLoadedFromServer()) {
      try { _removeLocal(LEGACY_LS_KEY); } catch (e) {}
      return;
    }

    // If global fallback already exists, just drop legacy.
    const cur = normalizeEngine(_readLocal(GLOBAL_LS_KEY));
    if (cur && _readLocal(GLOBAL_LS_KEY)) {
      try { _removeLocal(LEGACY_LS_KEY); } catch (e) {}
      return;
    }

    // Migrate legacy → global fallback.
    const legacyRaw = _readLocal(LEGACY_LS_KEY);
    const legacy = legacyRaw ? normalizeEngine(legacyRaw) : '';
    if (legacyRaw && legacy) {
      _writeLocal(GLOBAL_LS_KEY, legacy);
      try { _removeLocal(LEGACY_LS_KEY); } catch (e) {}
    }
  }

  function getPreferredEngine() {
    // Primary: global helper (which itself prefers server settings).
    if (_hasGlobalEditorEngine()) {
      try { return normalizeEngine(XKeen.ui.editorEngine.get()); } catch (e) {}
    }

    // Fallback (shouldn't happen in new builds): cached settings.
    try {
      if (XKeen.ui && XKeen.ui.settings && typeof XKeen.ui.settings.get === 'function') {
        const st = XKeen.ui.settings.get();
        return normalizeEngine(st && st.editor ? st.editor.engine : null);
      }
    } catch (e) {}

    // Last resort: legacy local key.
    const legacy = _readLocal(LEGACY_LS_KEY);
    return legacy ? normalizeEngine(legacy) : 'codemirror';
  }

  function persistPreferredEngine(engine) {
    const next = normalizeEngine(engine);

    if (_hasGlobalEditorEngine()) {
      try {
        // Async best-effort (server first, fallback local).
        const p = XKeen.ui.editorEngine.set(next);
        if (p && typeof p.then === 'function') p.catch(() => {});
      } catch (e) {}
      return;
    }

    // Very old fallback path: try PATCH server settings, otherwise write legacy LS.
    (async () => {
      let serverOk = false;
      try {
        if (XKeen.ui && XKeen.ui.settings && typeof XKeen.ui.settings.patch === 'function') {
          await XKeen.ui.settings.patch({ editor: { engine: next } });
          serverOk = true;
        }
      } catch (e) {
        serverOk = false;
      }

      if (!serverOk) {
        try { _writeLocal(LEGACY_LS_KEY, next); } catch (e) {}
      } else {
        try { _removeLocal(LEGACY_LS_KEY); } catch (e) {}
      }
    })();
  }

  function wireGlobalEngineSyncOnce() {
    // Keep routing toggle/editor synced when engine changes elsewhere.
    try {
      if (window.__xkeenRoutingEngineSyncWired) return;
      window.__xkeenRoutingEngineSyncWired = true;

      if (_hasGlobalEditorEngine() && typeof XKeen.ui.editorEngine.onChange === 'function') {
        XKeen.ui.editorEngine.onChange((detail) => {
          try {
            const eng = normalizeEngine(detail && detail.engine);
            if (!eng) return;

            // If user is actively changing the select, don't fight.
            if (_engineTouched) return;

            try { if (_engineSelectEl && _engineSelectEl.value !== eng) _engineSelectEl.value = eng; } catch (e) {}
            if (eng !== _engine) {
              switchEngine(eng, { persist: false });
            }
          } catch (e) {}
        });
        return;
      }

      // Fallback: listen to the DOM event directly.
      document.addEventListener('xkeen-editor-engine-change', (ev) => {
        try {
          const eng = normalizeEngine(ev && ev.detail ? ev.detail.engine : null);
          if (!eng) return;
          if (_engineTouched) return;

          try { if (_engineSelectEl && _engineSelectEl.value !== eng) _engineSelectEl.value = eng; } catch (e) {}
          if (eng !== _engine) switchEngine(eng, { persist: false });
        } catch (e) {}
      });
    } catch (e) {}
  }

  function ensureMonacoHost() {
    if (_monacoHostEl) return _monacoHostEl;
    const ta = $(IDS.textarea);
    if (!ta || !ta.parentNode) return null;

    let host = $(IDS.monacoContainer);
    if (!host) {
      host = document.createElement('div');
      host.id = IDS.monacoContainer;
      host.className = 'xk-monaco-editor';
      host.style.display = 'none';
      // Insert right after the textarea (CodeMirror replaces it with its wrapper).
      try {
        if (ta.nextSibling) ta.parentNode.insertBefore(host, ta.nextSibling);
        else ta.parentNode.appendChild(host);
      } catch (e) {
        ta.parentNode.appendChild(host);
      }
    }
    _monacoHostEl = host;
    return host;
  }

  function _getMonacoShared() {
    try {
      return (window.XKeen && XKeen.ui && XKeen.ui.monacoShared) ? XKeen.ui.monacoShared : null;
    } catch (e) {}
    return null;
  }

  async function ensureMonacoEditor() {
    if (_monaco) return _monaco;

    const host = ensureMonacoHost();
    if (!host) return null;

    const ms = _getMonacoShared();
    if (!ms || typeof ms.createEditor !== 'function') {
      toast('Monaco shared не найден (monaco_shared.js).', true);
      return null;
    }

    try {
      _monaco = await ms.createEditor(host, {
        value: (_cm && typeof _cm.getValue === 'function') ? _cm.getValue() : '',
        // Xray configs commonly use JSON with user comments (JSONC-like).
        // Backend сохраняет чистый JSON + отдельный .jsonc сайдкар, поэтому в UI
        // разрешаем комментарии для удобства.
        language: 'jsonc',
        allowComments: true,
        tabSize: 2,
        insertSpaces: true,
        wordWrap: 'on',
        onChange: () => {
          try { scheduleMonacoDiagnostics(); } catch (e) {}
        },
      });

      if (!_monaco) {
        toast('Не удалось загрузить Monaco Editor (CDN недоступен?).', true);
        return null;
      }

      // Facade for modules expecting CodeMirror-like API (getValue/setValue/scrollTo).
      try {
        _monacoFacade = (typeof ms.toFacade === 'function') ? ms.toFacade(_monaco) : null;
      } catch (e) {
        _monacoFacade = null;
      }

      if (!_monacoFacade) {
        _monacoFacade = {
          getValue: () => { try { return _monaco.getValue(); } catch (e) { return ''; } },
          setValue: (v) => { try { _monaco.setValue(String(v ?? '')); } catch (e) {} },
          focus: () => { try { _monaco.focus(); } catch (e) {} },
          scrollTo: (_x, y) => {
            try {
              if (typeof y === 'number') _monaco.setScrollTop(Math.max(0, y));
              else _monaco.setScrollTop(0);
            } catch (e) {}
          },
        };
      }

      // Ensure layout fix for hidden containers (modals/tabs/engine switch).
      try {
        if (typeof ms.layoutOnVisible === 'function') ms.layoutOnVisible(_monaco, host);
      } catch (e) {}

      return _monaco;
    } catch (e) {
      try { console.error(e); } catch (e2) {}
      toast('Ошибка загрузки Monaco (см. консоль).', true);
      return null;
    }
  }

  function getEditorText() {
    try {
      if (_engine === 'monaco' && _monaco) return String(_monaco.getValue() || '');
    } catch (e) {}
    try {
      if (_cm && typeof _cm.getValue === 'function') return String(_cm.getValue() || '');
    } catch (e) {}
    const ta = $(IDS.textarea);
    return ta ? String(ta.value || '') : '';
  }

  function setEditorTextAll(text) {
    const v = String(text ?? '');
    try { if (_cm && typeof _cm.setValue === 'function') _cm.setValue(v); } catch (e) {}
    try { if (_monaco && typeof _monaco.setValue === 'function') _monaco.setValue(v); } catch (e) {}
    try {
      const ta = $(IDS.textarea);
      if (ta) ta.value = v;
    } catch (e) {}
  }

  function scrollEditorsTop() {
    try { if (_cm && typeof _cm.scrollTo === 'function') _cm.scrollTo(0, 0); } catch (e) {}
    try { if (_monaco && typeof _monaco.setScrollTop === 'function') _monaco.setScrollTop(0); } catch (e) {}
  }

  function showCodeMirror(show) {
    try {
      if (!_cm || !_cm.getWrapperElement) return;
      const w = _cm.getWrapperElement();
      if (!w) return;
      w.style.display = show ? '' : 'none';
      if (show && _cm.refresh) _cm.refresh();
    } catch (e) {}
  }

  function showMonaco(show) {
    const host = ensureMonacoHost();
    if (!host) return;
    host.style.display = show ? '' : 'none';

    if (show && _monaco && typeof _monaco.layout === 'function') {
      const ms = _getMonacoShared();
      if (ms && typeof ms.layoutOnVisible === 'function') {
        try { ms.layoutOnVisible(_monaco, host); } catch (e) {}
        return;
      }

      // Fallback: do a couple of layouts on the next frames (slow routers/browsers).
      try {
        requestAnimationFrame(() => {
          try { _monaco.layout(); } catch (e) {}
          try { setTimeout(() => { try { _monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
        });
      } catch (e) {
        try { _monaco.layout(); } catch (e2) {}
      }
    }
  }

  function isMonacoAlive(ed) {
    const e = ed || _monaco;
    if (!e) return false;
    // Monaco editor instances throw when disposed; probe with harmless calls.
    try {
      if (typeof e.getModel === 'function') {
        const m = e.getModel();
        if (!m) return false;
        if (typeof m.isDisposed === 'function' && m.isDisposed()) return false;
      }
      if (typeof e.getValue === 'function') e.getValue();
      return true;
    } catch (e2) {
      return false;
    }
  }

  function relayoutMonaco(reason) {
    if (_engine !== 'monaco') return;
    const host = ensureMonacoHost();
    if (!host) return;

    // If we don't have a healthy instance, recreate it.
    if (!isMonacoAlive(_monaco)) {
      try {
        if (_monaco && typeof _monaco.dispose === 'function') _monaco.dispose();
      } catch (e) {}
      _monaco = null;
      _monacoFacade = null;
    }

    const doLayout = () => {
      try {
        if (!_monaco || typeof _monaco.layout !== 'function') return;
        const ms = _getMonacoShared();
        if (ms && typeof ms.layoutOnVisible === 'function') {
          ms.layoutOnVisible(_monaco, host);
          return;
        }
        _monaco.layout();
      } catch (e) {}
    };

    // Try several times: tab switches / BFCache restore can yield 0px size for a moment.
    try {
      requestAnimationFrame(() => {
        doLayout();
        try { setTimeout(doLayout, 0); } catch (e) {}
        try { setTimeout(doLayout, 80); } catch (e) {}
        try { setTimeout(doLayout, 250); } catch (e) {}
      });
    } catch (e) {
      doLayout();
    }

    // Optional debug hook
    try {
      if (reason && window.console && console.debug) console.debug('[routing] monaco relayout:', reason);
    } catch (e) {}
  }

  async function onShow(opts) {
    // Called when routing view becomes visible (tab switch) or when page is restored.
    const reason = (opts && opts.reason) ? String(opts.reason) : '';

    // Keep selection/UI in sync with global preference.
    try {
      const desired = normalizeEngine(getPreferredEngine());
      if (_engineSelectEl && desired && _engineSelectEl.value !== desired) {
        _engineSelectEl.value = desired;
      }
      if (desired && desired !== _engine) {
        await switchEngine(desired, { persist: false });
      }
    } catch (e) {}

    // Refresh CodeMirror if active.
    try {
      if (_engine === 'codemirror' && _cm && typeof _cm.refresh === 'function') {
        _cm.refresh();
      }
    } catch (e) {}

    // Ensure Monaco exists + layout when active.
    if (_engine === 'monaco') {
      try {
        await ensureMonacoEditor();
      } catch (e) {}
      try { relayoutMonaco(reason || 'show'); } catch (e) {}
    }
  }

  function wirePageReturnOnce() {
    // BFCache restore (Safari/Chrome) can keep DOM but lose Monaco layout/workers.
    try {
      if (window.__xkeenRoutingPageReturnWired) return;
      window.__xkeenRoutingPageReturnWired = true;

      window.addEventListener('pageshow', (ev) => {
        // Always run: even non-persisted navigations sometimes need a relayout.
        try {
          if (document.visibilityState === 'visible') onShow({ reason: ev && ev.persisted ? 'bfcache' : 'pageshow' });
        } catch (e) {}
      });

      document.addEventListener('visibilitychange', () => {
        try {
          if (document.visibilityState === 'visible') onShow({ reason: 'visibility' });
        } catch (e) {}
      });
    } catch (e) {}
  }

  function showCmToolbar(show) {
    try {
      if (_cm && _cm._xkeenToolbarEl) {
        _cm._xkeenToolbarEl.style.display = show ? '' : 'none';
      }
    } catch (e) {}
  }

  async function _doSwitchEngine(nextEngine, opts) {
    const next = normalizeEngine(nextEngine);
    if (next === _engine) return;

    if (next === 'monaco') {
      const ed = await ensureMonacoEditor();
      if (!ed) {
        // Revert UI selection
        try { if (_engineSelectEl) _engineSelectEl.value = _engine; } catch (e) {}
        return;
      }
      // Sync text from CodeMirror to Monaco on entry
      try { if (_cm && typeof _cm.getValue === 'function') ed.setValue(_cm.getValue()); } catch (e) {}

      showCodeMirror(false);
      showMonaco(true);
      // Keep only JSONC help visible in the toolbar host.
      try { syncToolbarForEngine('monaco'); } catch (e) {}

      _engine = 'monaco';
      // Expose facade so other modules (templates/cards) keep working
      try { XKeen.state.routingEditor = _monacoFacade || XKeen.state.routingEditor; } catch (e) {}
      try { if (_monacoFacade && _monacoFacade.focus) _monacoFacade.focus(); } catch (e) {}
      try { validate(); } catch (e) {}
    } else {
      // Sync text back from Monaco to CodeMirror
      try {
        if (_monaco && _cm && typeof _cm.setValue === 'function') _cm.setValue(_monaco.getValue());
      } catch (e) {}

      // Leave Monaco: clear markers and cancel pending diagnostics.
      try { if (_monacoDiagTimer) clearTimeout(_monacoDiagTimer); } catch (e) {}
      _monacoDiagTimer = null;
      try { clearMonacoMarkers(); } catch (e) {}

      showMonaco(false);
      showCodeMirror(true);
      // Restore full CodeMirror toolbar.
      try { syncToolbarForEngine('codemirror'); } catch (e) {}

      _engine = 'codemirror';
      try { XKeen.state.routingEditor = _cm; } catch (e) {}
      try { if (_cm && _cm.focus) _cm.focus(); } catch (e) {}
      try { validate(); } catch (e) {}
    }
  }

  function switchEngine(nextEngine, opts) {
    // Serialize all switches to avoid racing Monaco creation.
    _engineSwitchChain = _engineSwitchChain
      .catch(() => {})
      .then(() => _doSwitchEngine(nextEngine, opts));
    return _engineSwitchChain;
  }

  function ensureEngineToggleUI() {
    const host = document.getElementById('routing-toolbar-host');
    if (!host) return;
    if (document.getElementById(IDS.engineSelect)) {
      _engineSelectEl = document.getElementById(IDS.engineSelect);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'xk-editor-engine';

    const label = document.createElement('span');
    label.className = 'xk-editor-engine-label';
    label.textContent = 'Редактор:';

    const sel = document.createElement('select');
    sel.id = IDS.engineSelect;
    sel.className = 'xk-editor-engine-select';

    const o1 = document.createElement('option');
    o1.value = 'codemirror';
    o1.textContent = 'CodeMirror';
    const o2 = document.createElement('option');
    o2.value = 'monaco';
    o2.textContent = 'Monaco';

    sel.appendChild(o1);
    sel.appendChild(o2);

    wrap.appendChild(label);
    wrap.appendChild(sel);
    // Help lives in the editor toolbar (yellow JSONC help). Do not duplicate here.

    // Put it at the beginning of the toolbar host.
    host.insertBefore(wrap, host.firstChild);

    _engineSelectEl = sel;

    // Migrate legacy routing-only preference into global fallback (once).
    try { migrateLegacyEngineIfNeeded(); } catch (e) {}

    // Keep synced with other editors (global helper / event).
    try { wireGlobalEngineSyncOnce(); } catch (e) {}

    // Determine initial engine (global helper is primary).
    const initial = normalizeEngine(getPreferredEngine());
    sel.value = initial;

    // Apply initial engine immediately (if it isn't the default).
    if (initial && initial !== _engine) {
      switchEngine(initial, { persist: false });
    }

    sel.addEventListener('change', () => {
      _engineTouched = true;
      const v = normalizeEngine(sel.value);

      // Switch UI immediately.
      switchEngine(v, { persist: false });

      // Persist globally (server settings primary; localStorage is fallback).
      persistPreferredEngine(v);

      // Allow external changes again after a short moment.
      try { setTimeout(() => { _engineTouched = false; }, 150); } catch (e) { _engineTouched = false; }
    });

    // Lazy server read (do not override user choice).
    try {
      if (_hasGlobalEditorEngine() && XKeen.ui && XKeen.ui.editorEngine && typeof XKeen.ui.editorEngine.ensureLoaded === 'function') {
        XKeen.ui.editorEngine.ensureLoaded().then((eng) => {
          if (_engineTouched) return;
          const desired = normalizeEngine(eng);
          try { if (_engineSelectEl) _engineSelectEl.value = desired; } catch (e) {}
          if (desired && desired !== _engine) switchEngine(desired, { persist: false });
        }).catch(() => {});
      }
    } catch (e) {}


  }


  function init() {
    const textarea = $(IDS.textarea);
    if (!textarea) return;
    if (_inited) return;
    _inited = true;

    _cm = createEditor();
    XKeen.state.routingEditor = _cm;

    // Ensure Monaco container exists (hidden by default)
    try { ensureMonacoHost(); } catch (e) {}

    // Build engine toggle UI (default CodeMirror, no auto-fetch beyond routing)
    try { ensureEngineToggleUI(); } catch (e) {}

    // Place CodeMirror toolbar into the compact header (same line as file selector)
    try {
      // next tick — CodeMirror may replace textarea synchronously, but toolbar can be attached right away
      setTimeout(() => moveToolbarToHost(_cm), 0);
    } catch (e) {}

    // Notify theme module that editors are ready (safe to dispatch multiple times)
    try { document.dispatchEvent(new CustomEvent('xkeen-editors-ready')); } catch (e) {}

    // Fix Monaco after tab switches / navigation away+back (BFCache)
    try { wirePageReturnOnce(); } catch (e) {}

    wireUI();
    refreshFragmentsList().finally(() => load());
  }

  XKeen.routing = {
    init,
    onShow,
    load,
    save,
    validate,
    format,
    clearComments,
    sortRules,
    backup,
    restoreAuto,
    toggleCard,
    openHelp,
    closeHelp,
    setError,
  };

  // Alias for consistency with other feature modules.
  XKeen.features.routing = XKeen.routing;
})();
