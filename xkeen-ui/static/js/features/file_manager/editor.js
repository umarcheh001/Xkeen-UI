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

  // -------------------------- text file viewer/editor (CodeMirror modal) --------------------------
  const STATE = {
    wired: false,
    cm: null,
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
    if (ext === 'jsonc') return { name: 'jsonc', json: true };
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
      try {
        const v = cm.getValue();
        STATE.dirty = (STATE.ctx && !STATE.ctx.readOnly) ? (v !== STATE.lastSaved) : false;
        const ui2 = els();
        if (ui2 && ui2.saveBtn) ui2.saveBtn.disabled = !STATE.dirty || !!(STATE.ctx && STATE.ctx.readOnly);
      } catch (e) {}
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

    const cm = ensureCm();
    const ro = !!(ctx && ctx.readOnly);

    if (cm) {
      try {
        let mode = guessMode(ctx && ctx.name, text);
        const isJson = !!(mode && typeof mode === 'object' && mode.json);
        const ensured = await ensureCmAssets({ mode, jsonLint: isJson });
        if (!ensured.modeOk) mode = 'text/plain';

        const canLintJson = isJson && ensured.jsonLintOk;
        try {
          const gutters = canLintJson
            ? ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers']
            : ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'];
          cm.setOption('gutters', gutters);
        } catch (e) {}

        cm.setOption('mode', mode);
        cm.setOption('lint', canLintJson);
        cm.setOption('readOnly', ro ? 'nocursor' : false);
        cm.setValue(String(text || ''));
        cm.clearHistory();
        kickRefresh(cm, true);
      } catch (e) {}
    } else if (ui.textarea) {
      ui.textarea.value = String(text || '');
      setTimeout(() => { try { ui.textarea.focus(); } catch (e) {} }, 0);
    }

    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}
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

    const cm = STATE.cm;
    const text = cm ? String(cm.getValue() || '') : String((ui.textarea && ui.textarea.value) || '');
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

    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

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
  }

  FM.editor = {
    wire,
    open,
    requestClose,
    download,
    save,
  };
})();
