(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  // Local helpers (keep module independent from file_manager.js impl details)
  function el(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function modalOpen(modal) {
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e) {}
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}
  }

  function modalClose(modal) {
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}
  }

  function api() {
    return (FM && FM.api) ? FM.api : {};
  }

  // -------------------------- text file viewer/editor (CodeMirror / Monaco modal) --------------------------
  const STATE = {
    wired: false,
    cm: null,
    monaco: null,
    monacoFacade: null,
    activeKind: 'codemirror',
    activeFacade: null,
    switching: false,
    ctx: null,          // { target, sid, path, name, side, truncated, readOnly }
    dirty: false,
    lastSaved: '',
  };

  function els() {
    const modal = el('fm-editor-modal');
    if (!modal) return null;
    return {
      modal,
      title: el('fm-editor-title'),
      subtitle: el('fm-editor-subtitle'),
      engineSelect: el('fm-editor-engine-select'),
      monacoHost: el('fm-editor-monaco'),
      textarea: el('fm-editor-textarea'),
      saveBtn: el('fm-editor-save-btn'),
      cancelBtn: el('fm-editor-cancel-btn'),
      closeBtn: el('fm-editor-close-btn'),
      downloadBtn: el('fm-editor-download-btn'),
      warn: el('fm-editor-warning'),
      err: el('fm-editor-error'),
    };
  }

  function sampleText(text, maxLen = 4000) {
    const s = String(text == null ? '' : text);
    if (!s) return '';
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function looksLikeJson(text) {
    const s = sampleText(text, 5000).trimStart();
    if (!s) return false;
    const c = s[0];
    if (c !== '{' && c !== '[') return false;
    if (/\b(server|location|upstream)\b\s*\{/i.test(s.slice(0, 2000))) return false;
    return true;
  }

  // JSONC (JSON with comments) note:
  // CodeMirror's built-in JSON linter (jsonlint) is strict JSON and
  // will throw on comment tokens (//, /* */). For *.jsonc we therefore
  // disable lint to avoid false red errors in the editor modal.
  function hasJsonComments(text) {
    const t = String(text || '');
    // Rough detection: ignore URLs by requiring comment token not preceded by ':'
    return /(^|[^:])\/\/|\/\*/.test(t);
  }

  function looksLikeYaml(text) {
    const s = sampleText(text, 3000);
    if (!s) return false;
    if (/^\s*---\s*(\r?\n|$)/.test(s)) return true;
    return /^\s*[A-Za-z0-9_\-\."']+\s*:\s*[^\n]*$/m.test(s.slice(0, 1200));
  }

  function looksLikeShell(text) {
    const s = sampleText(text, 3000);
    if (!s) return false;
    if (/^\s*#!.*\b(sh|bash|ash|zsh)\b/i.test(s)) return true;
    return /^\s*(export\s+\w+|set\s+-[a-zA-Z]+|\w+=.+|\$(\{|\w))/m.test(s.slice(0, 1200));
  }

  function looksLikeXml(text) {
    const s = sampleText(text, 4000).trimStart();
    if (!s) return false;
    if (s.startsWith('<?xml')) return true;
    return /^<\w[\w\-:.]*[\s>]/.test(s);
  }

  function looksLikeNginx(text) {
    const s = sampleText(text, 6000);
    if (!s) return false;
    if (!/[{}]/.test(s)) return false;
    return /\b(http|events|server|location|upstream|map)\b\s*\{/i.test(s) ||
           /\b(listen|server_name|proxy_pass|root|include)\b/i.test(s);
  }

  function guessMode(name, text) {
    const n = String(name || '').toLowerCase();
    const ext = n.includes('.') ? n.split('.').pop() : '';

    if (ext === 'json') return { name: 'javascript', json: true };
    if (ext === 'jsonc') return { name: 'jsonc', json: true, jsonc: true };
    if (ext === 'js' || ext === 'ts') return 'javascript';
    if (ext === 'yaml' || ext === 'yml') return 'yaml';
    if (ext === 'sh' || ext === 'bash') return 'shell';
    if (ext === 'toml') return 'toml';
    if (ext === 'ini' || ext === 'cfg') return 'properties';
    if (ext === 'xml') return 'xml';
    if (ext === 'nginx') return 'nginx';

    if (ext === 'conf') {
      if (looksLikeNginx(text)) return 'nginx';
      return 'properties';
    }

    if (ext === 'log' || ext === 'txt' || ext === '') {
      if (looksLikeJson(text)) return { name: 'javascript', json: true };
      if (looksLikeYaml(text)) return 'yaml';
      if (looksLikeShell(text)) return 'shell';
      if (looksLikeXml(text)) return 'xml';
      if (looksLikeNginx(text)) return 'nginx';
      return 'text/plain';
    }

    if (ext === 'py') return 'python';
    if (ext === 'css') return 'css';
    if (ext === 'html' || ext === 'htm') return 'htmlmixed';
    if (ext === 'md' || ext === 'markdown') return 'markdown';

    return 'text/plain';
  }

  function currentTheme() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      return (t === 'light') ? 'default' : 'material-darker';
    } catch (e) {
      return 'material-darker';
    }
  }

  // -------------------------- engine helpers --------------------------
  function getEditorEngineHelper() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) { return null; }
  }

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function setEngineSelectValue(engine) {
    const ui = els();
    if (!ui || !ui.engineSelect) return;
    try { ui.engineSelect.value = normalizeEngine(engine); } catch (e) {}
  }

  function cmFacade(cm) {
    const ed = cm;
    return {
      getValue: () => {
        try { return String(ed.getValue() || ''); } catch (e) { return ''; }
      },
      setValue: (v) => {
        try { ed.setValue(String(v ?? '')); } catch (e) {}
      },
      focus: () => {
        try { ed.focus(); } catch (e) {}
      },
      scrollTo: (_x, y) => {
        try { ed.scrollTo(null, Math.max(0, typeof y === 'number' ? y : 0)); } catch (e) {}
      },
      layout: () => {
        try { ed.refresh(); } catch (e) {}
      },
      dispose: () => {},
      onChange: (cb) => {
        if (!cb || typeof cb !== 'function') return () => {};
        try {
          const fn = () => { try { cb(); } catch (e) {} };
          ed.on('change', fn);
          return () => { try { ed.off('change', fn); } catch (e) {} };
        } catch (e) {}
        return () => {};
      },
    };
  }

  function activeFacade() {
    if (STATE.activeFacade) return STATE.activeFacade;
    if (STATE.activeKind === 'monaco' && STATE.monacoFacade) return STATE.monacoFacade;
    if (STATE.activeKind === 'codemirror' && STATE.cm) return cmFacade(STATE.cm);
    return null;
  }

  function activeText(ui) {
    const fac = activeFacade();
    if (fac) return String(fac.getValue() || '');
    try {
      const u = ui || els();
      return String((u && u.textarea && u.textarea.value) || '');
    } catch (e) {
      return '';
    }
  }

  function updateDirtyUI() {
    const ctx = STATE.ctx;
    const ui = els();
    if (!ui) return;
    const ro = !!(ctx && ctx.readOnly);
    const v = activeText(ui);
    try {
      STATE.dirty = (ctx && !ro) ? (v !== STATE.lastSaved) : false;
    } catch (e) {
      STATE.dirty = false;
    }
    try { if (ui.saveBtn) ui.saveBtn.disabled = !STATE.dirty || ro; } catch (e) {}
  }

  // -------------------------- CodeMirror lazy assets (modes / JSON lint) --------------------------
  function modeName(mode) {
    try {
      if (!mode) return '';
      if (typeof mode === 'string') {
        if (mode.includes('/')) return '';
        return mode;
      }
      if (typeof mode === 'object' && mode.name) return String(mode.name || '');
    } catch (e) {}
    return '';
  }

  function jsonLintAvailable() {
    try {
      if (!window.jsonlint) return false;
      if (!window.CodeMirror) return false;
      const h = window.CodeMirror.helpers;
      return !!(h && h.lint && h.lint.json);
    } catch (e) {
      return false;
    }
  }

  async function ensureCmAssets({ mode, jsonLint } = {}) {
    const mn = modeName(mode);
    const wantJsonLint = !!jsonLint;

    try {
      if (window.XKeen && XKeen.cmLoader) {
        if (mn && typeof XKeen.cmLoader.ensureMode === 'function') {
          await XKeen.cmLoader.ensureMode(mn);
        }
        if (wantJsonLint && typeof XKeen.cmLoader.ensureJsonLint === 'function') {
          await XKeen.cmLoader.ensureJsonLint();
        }
      }
    } catch (e) {}

    return {
      modeOk: !mn || (window.CodeMirror && window.CodeMirror.modes && window.CodeMirror.modes[mn]),
      jsonLintOk: !wantJsonLint || jsonLintAvailable(),
    };
  }

  function ensureCm() {
    if (STATE.cm) return STATE.cm;
    const ui = els();
    if (!ui || !ui.textarea) return null;
    if (!window.CodeMirror || typeof window.CodeMirror.fromTextArea !== 'function') return null;

    const cm = window.CodeMirror.fromTextArea(ui.textarea, {
      lineNumbers: true,
      lineWrapping: true,
      theme: currentTheme(),
      mode: 'text/plain',

      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,

      // Addons (loaded globally in panel.html)
      showIndentGuides: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      showTrailingSpace: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      lint: false,
      highlightSelectionMatches: { showToken: /\w/, minChars: 2 },
      viewportMargin: 50,

      extraKeys: {
        'Ctrl-S': () => { save(); },
        'Cmd-S': () => { save(); },
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-H': 'replace',
        'Cmd-Alt-F': 'replace',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Esc': () => { requestClose(); },
      },
    });

    try {
      window.__xkeenEditors = window.__xkeenEditors || [];
      window.__xkeenEditors.push(cm);
    } catch (e) {}

    try {
      if (window.xkeenAttachCmToolbar && window.XKEEN_CM_TOOLBAR_DEFAULT) {
        window.xkeenAttachCmToolbar(cm, window.XKEEN_CM_TOOLBAR_DEFAULT);
      }
    } catch (e) {}

    cm.on('change', () => {
      try { updateDirtyUI(); } catch (e) {}
    });

    STATE.cm = cm;
    return cm;
  }

  function setInfo({ subtitle, warn, err } = {}) {
    const ui = els();
    if (!ui) return;
    try { if (ui.subtitle) ui.subtitle.textContent = String(subtitle || ''); } catch (e) {}
    try {
      if (ui.warn) {
        if (warn) { ui.warn.style.display = ''; ui.warn.textContent = String(warn); }
        else { ui.warn.style.display = 'none'; ui.warn.textContent = ''; }
      }
    } catch (e) {}
    try {
      if (ui.err) {
        if (err) { ui.err.style.display = ''; ui.err.textContent = String(err); }
        else { ui.err.style.display = 'none'; ui.err.textContent = ''; }
      }
    } catch (e) {}
  }

  function kickRefresh(cm, focus = true) {
    if (!cm) return;
    const doRefresh = () => { try { cm.refresh(); } catch (e) {} };

    try { cm.scrollTo(0, 0); } catch (e) {}
    try { cm.setCursor({ line: 0, ch: 0 }); } catch (e) {}

    doRefresh();
    try { requestAnimationFrame(doRefresh); } catch (e) { setTimeout(doRefresh, 0); }
    setTimeout(doRefresh, 0);
    setTimeout(doRefresh, 50);
    setTimeout(doRefresh, 150);
    setTimeout(doRefresh, 300);

    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(doRefresh).catch(() => {});
      }
    } catch (e) {}

    if (focus) setTimeout(() => { try { cm.focus(); } catch (e) {} }, 0);
  }

  function showCodeMirror(ui) {
    const cm = STATE.cm;
    try {
      if (cm && typeof cm.getWrapperElement === 'function') {
        const w = cm.getWrapperElement();
        if (w) w.style.display = '';
      }
    } catch (e) {}
    try {
      if (ui && ui.textarea) {
        // If CodeMirror is created, keep the original textarea hidden.
        ui.textarea.style.display = cm ? 'none' : '';
      }
    } catch (e) {}
    try { if (ui && ui.monacoHost) ui.monacoHost.classList.add('hidden'); } catch (e) {}
  }

  function hideCodeMirror(ui) {
    const cm = STATE.cm;
    try {
      if (cm && typeof cm.getWrapperElement === 'function') {
        const w = cm.getWrapperElement();
        if (w) w.style.display = 'none';
      }
    } catch (e) {}
    // If CM not created yet, hide the raw textarea (Monaco will use its own host)
    try { if (ui && ui.textarea) ui.textarea.style.display = 'none'; } catch (e) {}
  }

  function disposeMonaco(ui) {
    try {
      if (STATE.monacoFacade && typeof STATE.monacoFacade.dispose === 'function') STATE.monacoFacade.dispose();
      else if (STATE.monaco && typeof STATE.monaco.dispose === 'function') STATE.monaco.dispose();
    } catch (e) {}
    STATE.monaco = null;
    STATE.monacoFacade = null;
    try {
      const host = (ui && ui.monacoHost) ? ui.monacoHost : (els() && els().monacoHost);
      if (host) host.innerHTML = '';
    } catch (e) {}
  }

  function monacoLanguage(name, text) {
    const mode = guessMode(name, text);
    try {
      if (mode && typeof mode === 'object') {
        if (mode.jsonc) return 'jsonc';
        if (mode.json) return 'json';
        if (mode.name) return monacoLanguage(mode.name, text);
      }
    } catch (e) {}

    const s = String(mode || '').toLowerCase();
    if (s === 'javascript') return 'javascript';
    if (s === 'yaml') return 'yaml';
    if (s === 'shell') return 'shell';
    if (s === 'xml') return 'xml';
    if (s === 'python') return 'python';
    if (s === 'css') return 'css';
    if (s === 'markdown') return 'markdown';
    if (s === 'htmlmixed' || s === 'html') return 'html';
    if (s === 'properties') return 'ini';
    if (s === 'toml') return 'toml';

    // Nginx / unknown modes: keep plain text.
    return 'plaintext';
  }

  function captureView() {
    const kind = STATE.activeKind;
    try {
      if (kind === 'monaco' && STATE.monaco) {
        return {
          kind: 'monaco',
          pos: (typeof STATE.monaco.getPosition === 'function') ? STATE.monaco.getPosition() : null,
          scrollTop: (typeof STATE.monaco.getScrollTop === 'function') ? STATE.monaco.getScrollTop() : 0,
        };
      }
      if (kind === 'codemirror' && STATE.cm) {
        const cm = STATE.cm;
        const cur = (typeof cm.getCursor === 'function') ? cm.getCursor() : null;
        const si = (typeof cm.getScrollInfo === 'function') ? cm.getScrollInfo() : null;
        return {
          kind: 'codemirror',
          cursor: cur,
          scrollTop: si ? si.top : 0,
        };
      }
    } catch (e) {}
    return { kind: kind || 'codemirror' };
  }

  function restoreView(targetKind, view) {
    try {
      if (targetKind === 'monaco' && STATE.monaco) {
        const ed = STATE.monaco;
        // Prefer converted CM cursor if present.
        let pos = view && view.pos ? view.pos : null;
        if (!pos && view && view.cursor) {
          pos = { lineNumber: (view.cursor.line || 0) + 1, column: (view.cursor.ch || 0) + 1 };
        }
        if (pos && typeof ed.setPosition === 'function') ed.setPosition(pos);
        if (typeof ed.setScrollTop === 'function' && typeof view.scrollTop === 'number') ed.setScrollTop(Math.max(0, view.scrollTop));
        if (typeof ed.focus === 'function') ed.focus();
        return;
      }

      if (targetKind === 'codemirror' && STATE.cm) {
        const cm = STATE.cm;
        let cur = view && view.cursor ? view.cursor : null;
        if (!cur && view && view.pos) {
          cur = { line: Math.max(0, (view.pos.lineNumber || 1) - 1), ch: Math.max(0, (view.pos.column || 1) - 1) };
        }
        if (cur && typeof cm.setCursor === 'function') cm.setCursor(cur);
        if (typeof cm.scrollTo === 'function' && typeof view.scrollTop === 'number') cm.scrollTo(null, Math.max(0, view.scrollTop));
        kickRefresh(cm, true);
      }
    } catch (e) {}
  }

  async function activateEngine(nextEngine, { ctx, text, preserveView } = {}) {
    const ui = els();
    if (!ui) return 'codemirror';

    const engine = normalizeEngine(nextEngine);
    const ro = !!(ctx && ctx.readOnly);
    const value = String(text ?? '');
    const view = preserveView ? captureView() : null;

    // Keep the toggle UI in sync.
    setEngineSelectValue(engine);

    // Dispose Monaco if we're leaving it (helps avoid leaks in long sessions).
    if (engine !== 'monaco') {
      try { disposeMonaco(ui); } catch (e) {}
    }

    if (engine === 'monaco') {
      hideCodeMirror(ui);
      try { if (ui.monacoHost) ui.monacoHost.classList.remove('hidden'); } catch (e) {}

      const shared = (window.XKeen && XKeen.ui && XKeen.ui.monacoShared) ? XKeen.ui.monacoShared : null;
      if (!shared || typeof shared.createEditor !== 'function' || !ui.monacoHost) {
        // No Monaco infra → fallback.
        try { if (window.toast) window.toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e) {}
        return activateEngine('codemirror', { ctx, text, preserveView });
      }

      // (Re)create Monaco fresh for the current file.
      try { disposeMonaco(ui); } catch (e) {}

      const lang = monacoLanguage(ctx && ctx.name, value);
      const ed = await shared.createEditor(ui.monacoHost, {
        language: lang,
        readOnly: ro,
        value: value,
        onChange: () => { try { updateDirtyUI(); } catch (e) {} },
      });

      if (!ed) {
        try { if (window.toast) window.toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e) {}
        try {
          const ee = getEditorEngineHelper();
          if (ee && typeof ee.set === 'function') await ee.set('codemirror');
        } catch (e) {}
        return activateEngine('codemirror', { ctx, text, preserveView });
      }

      STATE.monaco = ed;
      try { STATE.monacoFacade = shared.toFacade(ed); } catch (e) { STATE.monacoFacade = null; }
      STATE.activeKind = 'monaco';
      STATE.activeFacade = STATE.monacoFacade;

      // Restore view if we are switching while open.
      if (view) restoreView('monaco', view);

      updateDirtyUI();
      return 'monaco';
    }

    // CodeMirror
    showCodeMirror(ui);
    const cm = ensureCm();

    if (cm) {
      try {
        let mode = guessMode(ctx && ctx.name, value);
        const modeObj = (mode && typeof mode === 'object') ? mode : null;
        const isJson = !!(modeObj && modeObj.json);
        const isJsonc = !!(modeObj && modeObj.jsonc);

        const wantsJsonLint = isJson && !isJsonc && !hasJsonComments(value);
        const ensured = await ensureCmAssets({ mode, jsonLint: wantsJsonLint });
        if (!ensured.modeOk) mode = 'text/plain';

        const canLintJson = wantsJsonLint && ensured.jsonLintOk;
        try {
          const gutters = canLintJson
            ? ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers']
            : ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'];
          cm.setOption('gutters', gutters);
        } catch (e) {}

        cm.setOption('mode', mode);
        cm.setOption('lint', canLintJson);
        cm.setOption('readOnly', ro ? 'nocursor' : false);
        cm.setValue(value);
        cm.clearHistory();
        kickRefresh(cm, true);
      } catch (e) {}
    } else if (ui.textarea) {
      ui.textarea.value = value;
      setTimeout(() => { try { ui.textarea.focus(); } catch (e) {} }, 0);
    }

    STATE.activeKind = 'codemirror';
    STATE.activeFacade = cm ? cmFacade(cm) : null;

    if (view) restoreView('codemirror', view);
    updateDirtyUI();
    return 'codemirror';
  }

  async function open(ctx, text) {
    const ui = els();
    if (!ui) return false;

    STATE.ctx = ctx || null;
    STATE.lastSaved = String(text || '');
    STATE.dirty = false;

    try { if (ui.title) ui.title.textContent = String((ctx && ctx.name) || 'Файл'); } catch (e) {}

    const subtitle = [];
    try {
      if (ctx && ctx.path) subtitle.push(String(ctx.path));
      if (ctx && ctx.target === 'remote' && ctx.sid) subtitle.push('remote');
      if (ctx && ctx.target === 'local') subtitle.push('local');
      if (ctx && ctx.truncated) subtitle.push('частично');
    } catch (e) {}

    setInfo({
      subtitle: subtitle.join(' • '),
      warn: (ctx && ctx.truncated) ? 'Файл открыт частично (ограничение размера). Сохранение отключено.' : '',
      err: '',
    });

    modalOpen(ui.modal);

    // Resolve preferred engine (server settings are primary; local fallback is acceptable).
    let engine = 'codemirror';
    try {
      const ee = getEditorEngineHelper();
      if (ee && typeof ee.ensureLoaded === 'function') {
        engine = normalizeEngine(await ee.ensureLoaded());
      } else if (ee && typeof ee.get === 'function') {
        engine = normalizeEngine(ee.get());
      }
    } catch (e) {
      try {
        const ee = getEditorEngineHelper();
        engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror');
      } catch (e2) {
        engine = 'codemirror';
      }
    }

    setEngineSelectValue(engine);
    STATE.switching = true;
    try {
      await activateEngine(engine, { ctx, text, preserveView: false });
    } finally {
      STATE.switching = false;
    }
    return true;
  }

  async function requestClose() {
    const ui = els();
    if (!ui) return;
    const has = !!STATE.ctx;

    if (has && STATE.dirty) {
      let ok = true;
      try {
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Несохранённые изменения',
            message: 'Закрыть файл без сохранения?',
            okText: 'Закрыть',
            cancelText: 'Отмена',
            danger: true,
          });
        } else {
          ok = window.confirm('Закрыть файл без сохранения?');
        }
      } catch (e) {
        ok = true;
      }
      if (!ok) return;
    }

    try { STATE.ctx = null; } catch (e) {}
    try { STATE.dirty = false; } catch (e) {}
    try { STATE.lastSaved = ''; } catch (e) {}

    // Clean up Monaco to avoid leaks; restore default UI visibility.
    try { disposeMonaco(ui); } catch (e) {}
    try { showCodeMirror(ui); } catch (e) {}

    modalClose(ui.modal);
  }

  function download() {
    const ctx = STATE.ctx;
    if (!ctx) return;

    const target = String(ctx.target || 'local');
    const path = String(ctx.path || '');
    const sid = String(ctx.sid || '');
    const name = String(ctx.name || 'download');

    const url = `/api/fs/download?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;
    const dl = api().xhrDownloadFile;
    if (typeof dl === 'function') dl({ url, filenameHint: name, titleLabel: 'Download' });
  }

  async function save() {
    const ctx = STATE.ctx;
    const ui = els();
    if (!ctx || !ui) return;
    if (ctx.readOnly) return;

    const text = activeText(ui);
    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

    const payload = { target: ctx.target, path: ctx.path, sid: ctx.sid || '', text };
    const f = api().fetchJson;
    if (typeof f !== 'function') {
      setInfo({ err: 'Не удалось сохранить: fetch_unavailable' });
      try { if (ui.saveBtn) ui.saveBtn.disabled = false; } catch (e2) {}
      return;
    }

    let out = null;
    try {
      const { res, data } = await f('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      out = { res, data };
    } catch (e) {
      out = null;
    }

    if (!out || !out.res || out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
      const errMsg = (out && out.data && out.data.error) ? String(out.data.error) : 'save_failed';
      setInfo({ err: 'Не удалось сохранить: ' + errMsg });
      try { if (window.toast) window.toast('FM: не удалось сохранить файл', 'error'); } catch (e) {}
      try { if (ui.saveBtn) ui.saveBtn.disabled = false; } catch (e2) {}
      return;
    }

    STATE.lastSaved = text;
    STATE.dirty = false;
    setInfo({ err: '' });
    try { if (window.toast) window.toast('Сохранено: ' + (ctx.name || 'файл'), 'success'); } catch (e) {}

    try { updateDirtyUI(); } catch (e) {}

    try {
      const lp = api().listPanel;
      if (ctx.side && typeof lp === 'function') await lp(ctx.side, { fromInput: true });
    } catch (e) {}
  }

  function wire() {
    if (STATE.wired) return;
    const ui = els();
    if (!ui) return;
    STATE.wired = true;

    if (ui.cancelBtn) ui.cancelBtn.addEventListener('click', (e) => { e.preventDefault(); requestClose(); });
    if (ui.closeBtn) ui.closeBtn.addEventListener('click', (e) => { e.preventDefault(); requestClose(); });
    if (ui.downloadBtn) ui.downloadBtn.addEventListener('click', (e) => { e.preventDefault(); download(); });
    if (ui.saveBtn) ui.saveBtn.addEventListener('click', (e) => { e.preventDefault(); save(); });

    // Engine toggle (global setting)
    if (ui.engineSelect) {
      try {
        const ee = getEditorEngineHelper();
        if (ee && typeof ee.get === 'function') ui.engineSelect.value = normalizeEngine(ee.get());
      } catch (e) {}

      ui.engineSelect.addEventListener('change', async () => {
        const next = normalizeEngine(ui.engineSelect.value);
        try {
          const ee = getEditorEngineHelper();
          if (ee && typeof ee.set === 'function') await ee.set(next);
        } catch (e) {}
      });
    }

    try {
      const ee = getEditorEngineHelper();
      if (ee && typeof ee.onChange === 'function') {
        ee.onChange(async (d) => {
          const next = normalizeEngine(d && d.engine);
          setEngineSelectValue(next);

          // Switch live only if modal is open.
          if (!STATE.ctx) return;
          if (STATE.switching) return;
          if (next === STATE.activeKind) return;

          STATE.switching = true;
          try {
            const v = activeText();
            await activateEngine(next, { ctx: STATE.ctx, text: v, preserveView: true });
          } catch (e) {
          } finally {
            STATE.switching = false;
          }
        });
      }
    } catch (e) {}
  }

  FM.editor = {
    wire,
    open,
    requestClose,
    download,
    save,
  };
})();
