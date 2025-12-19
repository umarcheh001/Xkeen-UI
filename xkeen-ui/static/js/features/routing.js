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

  const IDS = {
    textarea: 'routing-editor',
    status: 'routing-status',
    error: 'routing-error',
    helpLine: 'routing-help-line',

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

  function $(id) {
    return document.getElementById(id);
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

    if (!_cm || !_cm.getDoc) return;
    clearErrorMarker();

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

  function validate() {
    const cm = _cm || (XKeen.state ? XKeen.state.routingEditor : null);
    if (!cm || !cm.getValue) return false;

    const raw = cm.getValue();
    const cleaned = stripJsonComments(raw);

    if (!String(raw ?? '').trim()) {
      setError('Файл пуст. Введи корректный JSON.', null);
      return false;
    }

    try {
      JSON.parse(cleaned);
      setError('', null);
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
    const cleaned = stripJsonComments(text);
    try {
      JSON.parse(cleaned);
      return [];
    } catch (e) {
      const pos = extractJsonErrorPos(e) ?? 0;
      const lc = posToLineCh(cleaned, pos);
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
    if (statusEl) statusEl.textContent = 'Загрузка routing…';
    try {
      const res = await fetch('/api/routing');
      if (!res.ok) {
        if (statusEl) statusEl.textContent = 'Не удалось загрузить routing.';
        toast('Не удалось загрузить routing.', true);
        return;
      }
      const text = await res.text();
      if (_cm) {
        _cm.setValue(text);
        _cm.scrollTo(0, 0);
      } else {
        const ta = $(IDS.textarea);
        if (ta) ta.value = text;
      }

      try {
        // Keep compatibility with existing monolith flags, if present.
        window.routingSavedContent = text;
        window.routingIsDirty = false;
        const saveBtn = $(IDS.btnSave);
        if (saveBtn) saveBtn.classList.remove('dirty');
      } catch (e) {}

      if (statusEl) statusEl.textContent = 'Routing загружен.';
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = window.XKEEN_FILES && window.XKEEN_FILES.routing ? window.XKEEN_FILES.routing : '';
          window.updateLastActivity('loaded', 'routing', fp);
        }
      } catch (e) {}
      validate();
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Ошибка загрузки routing.';
      toast('Ошибка загрузки routing.', true);
    }
  }

  async function save() {
    const statusEl = $(IDS.status);
    if (!_cm) return;

    const rawText = _cm.getValue();
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
      const res = await fetch('/api/routing?restart=' + (restart ? '1' : '0'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: rawText,
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (res.ok && data && data.ok) {
        try {
          window.routingSavedContent = rawText;
          window.routingIsDirty = false;
          const saveBtn = $(IDS.btnSave);
          if (saveBtn) saveBtn.classList.remove('dirty');
        } catch (e) {}

        let msg = 'Routing сохранён.';
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
      if (statusEl) statusEl.textContent = 'Ошибка при сохранении routing.';
      toast('Ошибка при сохранении routing.', true);
    }
  }
  async function format() {
    const statusEl = $(IDS.status);
    if (!_cm) return;
    const text = _cm.getValue();
    
    if (hasUserComments(text)) {
      const ok = await confirmCommentsLoss('Форматирование');
      if (!ok) return;
    }
    const cleaned = stripJsonComments(text);
    try {
      const obj = JSON.parse(cleaned);
      _cm.setValue(JSON.stringify(obj, null, 2));
      _cm.scrollTo(0, 0);
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
    if (!_cm) return;
    const text = _cm.getValue();
    const cleaned = stripJsonComments(text);
    _cm.setValue(cleaned);
    validate();
    if (statusEl) statusEl.textContent = 'Комментарии удалены.';
    toast('Комментарии удалены.', false);
  }
  async function sortRules() {
    const statusEl = $(IDS.status);
    if (!_cm) return;
    const text = _cm.getValue();
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
      _cm.setValue(JSON.stringify(obj, null, 2));
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
      const res = await fetch('/api/backup', { method: 'POST' });
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
    const label = '05_routing.json';
    if (!confirm('Восстановить из авто-бэкапа файл ' + label + '?')) return;

    try {
      const res = await fetch('/api/restore-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'routing' }),
      });
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
    if (willOpen && _cm && _cm.refresh) {
      try { _cm.refresh(); } catch (e) {}
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
    // Help line
    const help = $(IDS.helpLine);
    if (help && !(help.dataset && help.dataset.xkeenWired === '1')) {
      help.addEventListener('click', (e) => {
        e.preventDefault();
        openHelp();
      });
      if (help.dataset) help.dataset.xkeenWired = '1';
    }

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

    // Cosmetic class + toolbar if present in legacy main.js
    try {
      if (cm.getWrapperElement) {
        cm.getWrapperElement().classList.add('xkeen-cm');
        if (typeof window.xkeenAttachCmToolbar === 'function' && window.XKEEN_CM_TOOLBAR_DEFAULT) {
          window.xkeenAttachCmToolbar(cm, window.XKEEN_CM_TOOLBAR_DEFAULT);
        }
      }
    } catch (e) {}

    cm.on('change', () => {
      validate();
    });

    return cm;
  }

  function init() {
    const textarea = $(IDS.textarea);
    if (!textarea) return;
    if (_inited) return;
    _inited = true;

    _cm = createEditor();
    XKeen.state.routingEditor = _cm;

    // Notify theme module that editors are ready (safe to dispatch multiple times)
    try { document.dispatchEvent(new CustomEvent('xkeen-editors-ready')); } catch (e) {}

    wireUI();
    load();
  }

  XKeen.routing = {
    init,
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
