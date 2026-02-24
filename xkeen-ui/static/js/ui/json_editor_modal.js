(() => {
  // JSON editor modal for 03_inbounds.json / 04_outbounds.json
  // Public API:
  //   XKeen.jsonEditor.open('inbounds'|'outbounds')
  //   XKeen.jsonEditor.close()
  //   XKeen.jsonEditor.save()
  //   XKeen.jsonEditor.init()  (optional)

  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.ui = XKeen.ui || {};
  XKeen.jsonEditor = XKeen.jsonEditor || {};

  let _inited = false;
  let _cm = null;
  let _monaco = null;
  let _monacoFacade = null;
  let _kind = 'codemirror';
  let _engineUnsub = null;
  let _currentTarget = null;

  function el(id) {
    return document.getElementById(id);
  }


  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  function shouldRestartAfterSave() {
    // Panel toggle; on other pages default to true.
    const cb = el('global-autorestart-xkeen');
    if (!cb) return true;
    return !!cb.checked;
  }

  function setError(msg) {
    const errorEl = el('json-editor-error');
    if (errorEl) errorEl.textContent = msg ? String(msg) : '';
  }

  function activeFileParam(kind) {
    try {
      if (window.XKeen && XKeen.state && XKeen.state.fragments && XKeen.state.fragments[kind]) {
        return String(XKeen.state.fragments[kind] || '').trim();
      }
    } catch (e) {}
    // Fallback: use whatever is shown as active file label in window.XKEEN_FILES
    try {
      const fp = window.XKEEN_FILES && window.XKEEN_FILES[kind];
      if (!fp) return '';
      const parts = String(fp).split('/');
      const b = parts[parts.length - 1];
      return String(b || '').trim();
    } catch (e) {}
    return '';
  }

  function buildTargetUrl(target, baseUrl) {
    const active = activeFileParam(target);
    return baseUrl + (active ? ('?file=' + encodeURIComponent(active)) : '');
  }

  function setHeader(target) {
    const titleEl = el('json-editor-title');
    const fileLabelEl = el('json-editor-file-label');

    function _baseName(p, fallback) {
      try {
        if (!p) return fallback;
        const parts = String(p).split('/');
        const b = parts[parts.length - 1];
        return b || fallback;
      } catch (e) {
        return fallback;
      }
    }

    function _activeFileParam(kind) {
      try {
        if (window.XKeen && XKeen.state && XKeen.state.fragments && XKeen.state.fragments[kind]) {
          return String(XKeen.state.fragments[kind] || '').trim();
        }
      } catch (e) {}
      // Fallback: use whatever is shown as active file label in window.XKEEN_FILES
      try {
        const fp = window.XKEEN_FILES && window.XKEEN_FILES[kind];
        const b = _baseName(fp, '');
        return b || '';
      } catch (e) {}
      return '';
    }

    if (target === 'inbounds') {
      const active = activeFileParam('inbounds');
      const base = active ? active : _baseName(window.XKEEN_FILES && window.XKEEN_FILES.inbounds, '03_inbounds.json');
      if (titleEl) titleEl.textContent = 'Редактор ' + base;
      if (fileLabelEl) fileLabelEl.textContent = 'Файл: ' + base;
      return buildTargetUrl('inbounds', '/api/inbounds');
    }

    if (target === 'outbounds') {
      const active = activeFileParam('outbounds');
      const base = active ? active : _baseName(window.XKEEN_FILES && window.XKEEN_FILES.outbounds, '04_outbounds.json');
      if (titleEl) titleEl.textContent = 'Редактор ' + base;
      if (fileLabelEl) fileLabelEl.textContent = 'Файл: ' + base;
      return buildTargetUrl('outbounds', '/api/outbounds');
    }

    return null;
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

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function getEngineHelper() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) { return null; }
  }

  function getMonacoShared() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.monacoShared) ? XKeen.ui.monacoShared : null; } catch (e) { return null; }
  }

  function setEngineSelect(engine) {
    const sel = el('json-editor-engine-select');
    if (!sel) return;
    try { sel.value = normalizeEngine(engine); } catch (e) {}
  }

  function showEditorKind(kind) {
    const k = normalizeEngine(kind);
    const host = el('json-editor-monaco');

    // CodeMirror wrapper
    try {
      if (_cm && _cm.getWrapperElement) {
        const w = _cm.getWrapperElement();
        if (w) w.style.display = (k === 'codemirror') ? '' : 'none';
      }
    } catch (e) {}

    // Textarea fallback (if CM failed)
    try {
      const ta = el('json-editor-textarea');
      if (ta && !_cm) ta.style.display = (k === 'codemirror') ? '' : 'none';
    } catch (e) {}

    // Monaco host
    try {
      if (host) host.classList.toggle('hidden', k !== 'monaco');
    } catch (e) {}
  }

  async function ensureEditor(textarea) {
    if (_cm || !window.CodeMirror || !textarea) return _cm;

    // Lazy-load JSON linter (jsonlint + addon/lint/json-lint) if available.
    try {
      if (window.XKeen && XKeen.cmLoader && typeof XKeen.cmLoader.ensureJsonLint === 'function') {
        await XKeen.cmLoader.ensureJsonLint();
      }
    } catch (e) {}

    const canLint = jsonLintAvailable();

    _cm = CodeMirror.fromTextArea(textarea, {
      mode: { name: 'javascript', json: true },
      theme: cmThemeFromPage(),
      lineNumbers: true,
      styleActiveLine: true,
      showIndentGuides: true,
      matchBrackets: true,
      showTrailingSpace: true,
      rulers: [{ column: 120 }],
      lineWrapping: true,
      gutters: ['CodeMirror-lint-markers'],
      lint: canLint,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys: {
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-H': 'replaceAll',
      },
      viewportMargin: Infinity,
    });

    try {
      if (_cm.getWrapperElement) {
        _cm.getWrapperElement().classList.add('xkeen-cm');
      }
    } catch (e) {}

    // For theme sync (ui/theme.js)
    try {
      XKeen.state.jsonModalEditor = _cm;
    } catch (e) {}

    return _cm;
  }

  async function ensureMonacoEditor(initialText) {
    const host = el('json-editor-monaco');
    if (_monacoFacade && _monaco) return _monacoFacade;
    if (!host) return null;

    const shared = getMonacoShared();
    if (!shared || typeof shared.createEditor !== 'function') return null;

    _monaco = await shared.createEditor(host, {
      language: 'json',
      readOnly: false,
      value: String(initialText ?? ''),
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
    });

    if (_monaco) {
      try { _monacoFacade = shared.toFacade(_monaco); } catch (e) { _monacoFacade = null; }
    }
    return _monacoFacade;
  }

  function getCurrentValue() {
    const textarea = el('json-editor-textarea');
    if (_kind === 'monaco' && _monacoFacade) return _monacoFacade.getValue();
    if (_cm) return _cm.getValue();
    if (textarea) return textarea.value || '';
    return '';
  }

  function setCurrentValue(text) {
    const textarea = el('json-editor-textarea');
    const v = String(text ?? '');
    if (_kind === 'monaco' && _monacoFacade) {
      try { _monacoFacade.setValue(v); } catch (e) {}
      return;
    }
    if (_cm) {
      try { updateLintForText(_cm, v); } catch (e) {}
      _cm.setValue(v);
      return;
    }
    if (textarea) textarea.value = v;
  }

  async function switchEngine(nextEngine, opts) {
    const next = normalizeEngine(nextEngine);
    if (next === _kind) return;

    const prevText = getCurrentValue();
    let cmCursor = null;
    let cmScroll = null;
    try { if (_cm) cmCursor = _cm.getCursor(); } catch (e) {}
    try { if (_cm) cmScroll = _cm.getScrollInfo(); } catch (e) {}

    _kind = next;
    setEngineSelect(_kind);

    if (_kind === 'monaco') {
      const fac = await ensureMonacoEditor(prevText);
      if (fac) {
        try { fac.setValue(prevText); } catch (e) {}
        try { fac.layout(); } catch (e) {}
        try { fac.focus(); } catch (e) {}
      }
    } else {
      const textarea = el('json-editor-textarea');
      const cm = await ensureEditor(textarea);
      if (cm) {
        try { cm.setOption('theme', cmThemeFromPage()); } catch (e) {}
        updateLintForText(cm, prevText);
        cm.setValue(prevText);
        try {
          if (cmCursor) cm.setCursor(cmCursor);
          if (cmScroll && typeof cm.scrollTo === 'function') cm.scrollTo(cmScroll.left || 0, cmScroll.top || 0);
        } catch (e) {}
        setTimeout(() => {
          try { cm.refresh(); cm.focus(); } catch (e) {}
        }, 0);
      } else if (textarea) {
        textarea.value = prevText;
        textarea.focus();
      }
    }

    showEditorKind(_kind);

    // Persist as global preference (best-effort)
    try {
      const helper = getEngineHelper();
      if (helper && typeof helper.set === 'function' && !(opts && opts.noPersist)) {
        helper.set(_kind);
      }
    } catch (e) {}
  }

  function ensureWired() {
    if (_inited) return;
    _inited = true;

    const modal = el('json-editor-modal');
    const closeBtn = el('json-editor-close-btn');
    const cancelBtn = el('json-editor-cancel-btn');
    const saveBtn = el('json-editor-save-btn');
    const formatBtn = el('json-editor-format-btn');
    const engineSel = el('json-editor-engine-select');

    const onClose = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      close();
    };

    if (closeBtn) closeBtn.addEventListener('click', onClose);
    if (cancelBtn) cancelBtn.addEventListener('click', onClose);

    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        save();
      });
    }

    if (formatBtn) {
      formatBtn.addEventListener('click', (e) => {
        e.preventDefault();
        formatCurrent();
      });
    }

    if (engineSel && !(engineSel.dataset && engineSel.dataset.xkeenWired === '1')) {
      engineSel.addEventListener('change', (e) => {
        const v = e && e.target ? e.target.value : null;
        switchEngine(v);
      });
      if (engineSel.dataset) engineSel.dataset.xkeenWired = '1';
    }

    // Sync with global engine changes (best-effort)
    try {
      const helper = getEngineHelper();
      if (helper && typeof helper.onChange === 'function') {
        if (_engineUnsub) { try { _engineUnsub(); } catch (e) {} }
        _engineUnsub = helper.onChange((d) => {
          try {
            const m = el('json-editor-modal');
            if (!m || m.classList.contains('hidden')) return;
            const eng = normalizeEngine(d && d.engine);
            if (eng && eng !== _kind) switchEngine(eng, { noPersist: true });
          } catch (e) {}
        });
      }
    } catch (e) {}

    // Close on overlay click
    if (modal && !(modal.dataset && modal.dataset.xkeenOverlayWired === '1')) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
      });
      if (modal.dataset) modal.dataset.xkeenOverlayWired = '1';
    }

    // Close on ESC
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = el('json-editor-modal');
      if (m && !m.classList.contains('hidden')) close();
    });
  }

  async function open(target) {
    ensureWired();

    const url = setHeader(target);
    if (!url) return;

    const modal = el('json-editor-modal');
    const textarea = el('json-editor-textarea');
    if (!modal || !textarea) return;

    _currentTarget = target;
    setError('');
    modal.classList.remove('hidden');

    // Adopt preferred engine (server/local). Default is CodeMirror.
    try {
      const helper = getEngineHelper();
      if (helper && typeof helper.ensureLoaded === 'function') {
        await helper.ensureLoaded();
      }
      const pref = helper && typeof helper.get === 'function' ? helper.get() : 'codemirror';
      _kind = normalizeEngine(pref);
      setEngineSelect(_kind);
    } catch (e) {
      _kind = 'codemirror';
      setEngineSelect(_kind);
    }

    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        setError('Не удалось загрузить конфиг.');
        return;
      }

      const data = await res.json().catch(() => ({}));
      const finalText = (data && typeof data.text === 'string')
        ? data.text
        : (data && data.config ? JSON.stringify(data.config, null, 2) : '{}');

      // JSONC sidecar status (no absolute paths in UI)
      try {
        const badge = el('json-editor-comments-status');
        if (badge) {
          const hasSidecar = !!(data && data.raw_path);
          badge.classList.toggle('xk-comments-on', hasSidecar);
          badge.classList.toggle('xk-comments-off', !hasSidecar);
          badge.textContent = hasSidecar ? 'Комментарии: включены' : 'Комментарии: выключены';
        }
      } catch (e) {}

      if (_kind === 'monaco') {
        await ensureMonacoEditor(finalText || '');
        try { if (_monacoFacade) { _monacoFacade.setValue(finalText || ''); _monacoFacade.focus(); _monacoFacade.layout(); } } catch (e) {}
      } else {
        const cm = await ensureEditor(textarea);
        if (cm) {
          try { cm.setOption('theme', cmThemeFromPage()); } catch (e) {}
          updateLintForText(cm, finalText || '');
          cm.setValue(finalText || '');
          setTimeout(() => {
            try { cm.refresh(); cm.focus(); } catch (e) {}
          }, 0);
        } else {
          textarea.value = finalText || '';
          textarea.focus();
        }
      }

      showEditorKind(_kind);
    } catch (e) {
      console.error(e);
      setError('Ошибка загрузки конфига.');
    }
  }

  function close() {
    const modal = el('json-editor-modal');
    if (modal) modal.classList.add('hidden');
    setError('');
    _currentTarget = null;
  }



  function hasJsonComments(text) {
    const t = String(text || '');
    // Rough detection: ignore URLs by requiring comment token not preceded by ':'
    return /(^|[^:])\/\/|\n\s*#|\/\*/.test(t);
  }

  function updateLintForText(cm, text) {
    if (!cm) return;
    try {
      const canLint = jsonLintAvailable();
      // JSONC comments produce false positives in strict JSON linter.
      cm.setOption('lint', canLint && !hasJsonComments(text));
    } catch (e) {}
  }

  async function formatCurrent() {
    ensureWired();
    const text = String(getCurrentValue() || '');
    if (!text.trim()) {
      setError('Пустой JSON.');
      return;
    }
    setError('');
    try {
      const res = await fetch('/api/json/format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok !== true || typeof data.text !== 'string') {
        const msg = 'Ошибка форматирования: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setError(msg);
        toast(msg, true);
        return;
      }

      const next = String(data.text || '');
      setCurrentValue(next);
      try {
        if (_kind === 'monaco' && _monacoFacade) _monacoFacade.focus();
        if (_kind !== 'monaco' && _cm) _cm.focus();
      } catch (e) {}
      toast('JSON отформатирован.', false);
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка форматирования.';
      setError(msg);
      toast(msg, true);
    }
  }

  async function save() {
    ensureWired();

    if (!_currentTarget) return;

    const target = _currentTarget;
    const text = String(getCurrentValue() || '');
    if (text === null || typeof text !== 'string') return;
    // Send raw JSON/JSONC text to backend (keeps comments).
    const url = target === 'inbounds'
      ? buildTargetUrl('inbounds', '/api/inbounds')
      : buildTargetUrl('outbounds', '/api/outbounds');

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          restart: shouldRestartAfterSave(),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data || data.ok !== true) {
        const msg = 'Ошибка сохранения: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setError(msg);
        toast(msg, true);
        return;
      }

      close();

      // Refresh related panels (modular)
      try {
        if (target === 'inbounds' && window.XKeen && XKeen.features && XKeen.features.inbounds && typeof XKeen.features.inbounds.load === 'function') {
          await XKeen.features.inbounds.load();
        }
        if (target === 'outbounds' && window.XKeen && XKeen.features && XKeen.features.outbounds && typeof XKeen.features.outbounds.load === 'function') {
          await XKeen.features.outbounds.load();
        }
      } catch (e) {
        console.error(e);
      }
      if (!data || !data.restarted) {
        // Show correct file name (supports *_hys2 variants)
        function _baseName(p, fallback) {
          try {
            if (!p) return fallback;
            const parts = String(p).split(/[\\/]/);
            const b = parts[parts.length - 1];
            return b || fallback;
          } catch (e) {
            return fallback;
          }
        }

        const files = (window.XKEEN_FILES && typeof window.XKEEN_FILES === 'object') ? window.XKEEN_FILES : {};
        const label = target === 'inbounds'
          ? _baseName(files.inbounds, '03_inbounds.json')
          : _baseName(files.outbounds, '04_outbounds.json');

        toast(label + ' сохранён.', false);
      }

      try {
        if (typeof window.loadRestartLog === 'function') window.loadRestartLog();
      } catch (e) {}
    } catch (e) {
      console.error(e);
      setError('Ошибка сохранения.');
      toast('Ошибка сохранения.', true);
    }
  }

  XKeen.jsonEditor.init = ensureWired;
  XKeen.jsonEditor.open = open;
  XKeen.jsonEditor.close = close;
  XKeen.jsonEditor.save = save;
})();
