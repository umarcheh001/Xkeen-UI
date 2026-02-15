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

  function ensureWired() {
    if (_inited) return;
    _inited = true;

    const modal = el('json-editor-modal');
    const closeBtn = el('json-editor-close-btn');
    const cancelBtn = el('json-editor-cancel-btn');
    const saveBtn = el('json-editor-save-btn');
    const formatBtn = el('json-editor-format-btn');

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

  function getCurrentText(textarea) {
    if (_cm) return _cm.getValue();
    if (textarea) return textarea.value || '';
    return '';
  }

  async function formatCurrent() {
    ensureWired();
    const textarea = el('json-editor-textarea');
    const text = String(getCurrentText(textarea) || '');
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
      if (_cm) {
        updateLintForText(_cm, next);
        _cm.setValue(next);
        try { _cm.focus(); } catch (e) {}
      } else {
        textarea.value = next;
        textarea.focus();
      }
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
    const textarea = el('json-editor-textarea');

    let text = '';
    if (_cm) text = _cm.getValue();
    else if (textarea) text = textarea.value || '';
    else return;
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
