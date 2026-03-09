(() => {
  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};

  // Do not re-init.
  if (XKeen.ui.monacoShared) return;

  const _state = {
    themeWired: false,
    themesDefined: false,
    langLoaded: new Set(),
    jsonCommentsEnabled: false,
    // WeakMaps are supported in modern browsers; if not, we fall back to expando properties.
    roByHost: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    moByHost: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
  };

  function _normalizeLanguage(lang) {
    const s = String(lang || '').toLowerCase().trim();
    if (!s) return 'plaintext';
    // Monaco core reliably supports 'json'. Some panels use 'jsonc' for JSON-with-comments.
    // In minimal Monaco builds, 'jsonc' might not be registered as a separate language id.
    // We keep 'jsonc' as a signal for diagnostics (allowComments), but still load json contribution.
    if (s === 'yml') return 'yaml';
    return s;
  }

  function _maybeEnableJsonComments(monaco) {
    try {
      if (_state.jsonCommentsEnabled) return;
      if (!monaco || !monaco.languages || !monaco.languages.json || !monaco.languages.json.jsonDefaults) return;
      if (typeof monaco.languages.json.jsonDefaults.setDiagnosticsOptions !== 'function') return;

      const cur = (typeof monaco.languages.json.jsonDefaults.diagnosticsOptions === 'function')
        ? monaco.languages.json.jsonDefaults.diagnosticsOptions()
        : {};

      // Enable JSON-with-comments (JSONC-like) behavior.
      // Note: Monaco JSON diagnostics options are global for the page.
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        ...(cur || {}),
        allowComments: true,
        trailingCommas: 'ignore',
      });
      _state.jsonCommentsEnabled = true;
    } catch (e) {}
  }

  async function _ensureLanguage(monaco, language) {
    // Best-effort: load language contribution modules on demand.
    try {
      const lang = _normalizeLanguage(language);
      if (!lang || lang === 'plaintext') return;
      if (_state.langLoaded && _state.langLoaded.has(lang)) return;

      const req = window.require;
      if (!req || typeof req !== 'function') {
        // No AMD require() (should not happen if Monaco is loaded), but keep graceful.
        if (_state.langLoaded) _state.langLoaded.add(lang);
        return;
      }

      let modules = null;
      if (lang === 'json' || lang === 'jsonc') {
        modules = ['vs/language/json/monaco.contribution'];
      } else if (lang === 'yaml') {
        // YAML is shipped as a basic language (tokenization only).
        modules = ['vs/basic-languages/monaco.contribution'];
      } else if (lang === 'ini') {
        modules = ['vs/basic-languages/monaco.contribution'];
      } else if (lang === 'shell' || lang === 'bash' || lang === 'sh') {
        modules = ['vs/basic-languages/monaco.contribution'];
      }

      if (!modules) {
        if (_state.langLoaded) _state.langLoaded.add(lang);
        return;
      }

      await new Promise((resolve) => {
        const TIMEOUT_MS = 2200;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve(true);
        };
        try {
          const t = setTimeout(() => finish(), TIMEOUT_MS);
          req(modules, () => {
            try { clearTimeout(t); } catch (e) {}
            finish();
          }, () => {
            try { clearTimeout(t); } catch (e) {}
            finish();
          });
        } catch (e) {
          finish();
        }
      });

      try { if (_state.langLoaded) _state.langLoaded.add(lang); } catch (e) {}
    } catch (e) {
      // Ignore.
    }
  }

  function _getCssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      const s = (v || '').toString().trim();
      return s || fallback;
    } catch (e) {}
    return fallback;
  }

  function _getCssVarNum(name, fallback) {
    try {
      const s = _getCssVar(name, '');
      const n = parseFloat(String(s).trim());
      return Number.isFinite(n) ? n : fallback;
    } catch (e) {}
    return fallback;
  }

  function _getThemeName() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      return (t === 'light') ? 'xkeen-light' : 'xkeen-dark';
    } catch (e) {}
    return 'xkeen-dark';
  }

  function ensureThemes(monaco) {
    try {
      if (!monaco || !monaco.editor || typeof monaco.editor.defineTheme !== 'function') return;
      if (_state.themesDefined || window.__xkeenMonacoThemesDefined) {
        _state.themesDefined = true;
        return;
      }

      const accent = _getCssVar('--accent', '#60a5fa');

      // Panel surface vars (used for widgets/context menu). Keep in sync with styles.css modal vars.
      const modalBg = _getCssVar('--modal-bg', '#0b1220');
      const modalText = _getCssVar('--modal-text', '#e5e7eb');
      const modalBorder = _getCssVar('--modal-border', '#111827');
      const shadow = _getCssVar('--xk-tooltip-shadow', 'rgba(15, 23, 42, 0.18)');

      // Keep colors close to our panel cards (styles.css: .card background is #020617)
      monaco.editor.defineTheme('xkeen-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#020617',
          'editor.foreground': '#e5e7eb',
          'editorLineNumber.foreground': '#64748b',
          'editorLineNumber.activeForeground': '#e5e7eb',
          'editorCursor.foreground': accent,
          'editor.selectionBackground': '#1d4ed850',
          'editor.inactiveSelectionBackground': '#1d4ed820',
          'editorIndentGuide.background1': '#1f2937',
          'editorIndentGuide.activeBackground1': '#334155',
          'editorRuler.foreground': '#111827',
          'editorGutter.background': '#020617',
          'editorWhitespace.foreground': '#334155',
          'editorWidget.background': modalBg,
          'editorWidget.border': modalBorder,
          'editorSuggestWidget.background': modalBg,
          'editorSuggestWidget.border': modalBorder,
          'editorSuggestWidget.foreground': modalText,
          'editorSuggestWidget.selectedBackground': '#1d4ed840',
          'editorHoverWidget.background': modalBg,
          'editorHoverWidget.border': modalBorder,
          // Context menu / command palette
          'menu.background': modalBg,
          'menu.foreground': modalText,
          'menu.selectionBackground': '#1d4ed840',
          'menu.selectionForeground': modalText,
          'menu.separatorBackground': 'rgba(148, 163, 184, 0.18)',
          'menu.border': modalBorder,
          'widget.shadow': shadow,
          'scrollbarSlider.background': '#33415555',
          'scrollbarSlider.hoverBackground': '#33415588',
          'scrollbarSlider.activeBackground': '#334155aa',
        },
      });

      monaco.editor.defineTheme('xkeen-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#ffffff',
          'editor.foreground': '#111827',
          'editorLineNumber.foreground': '#94a3b8',
          'editorLineNumber.activeForeground': '#111827',
          'editorCursor.foreground': accent,
          'editor.selectionBackground': '#2563eb30',
          'editor.inactiveSelectionBackground': '#2563eb18',
          'editorIndentGuide.background1': '#e5e7eb',
          'editorIndentGuide.activeBackground1': '#cbd5e1',
          'editorRuler.foreground': '#e5e7eb',
          'editorGutter.background': '#ffffff',
          'editorWhitespace.foreground': '#cbd5e1',
          'editorWidget.background': _getCssVar('--modal-bg', '#ffffff'),
          'editorWidget.border': _getCssVar('--modal-border', '#e5e7eb'),
          'editorSuggestWidget.background': _getCssVar('--modal-bg', '#ffffff'),
          'editorSuggestWidget.border': _getCssVar('--modal-border', '#e5e7eb'),
          'editorSuggestWidget.foreground': _getCssVar('--modal-text', '#111827'),
          'editorSuggestWidget.selectedBackground': '#2563eb1e',
          'editorHoverWidget.background': _getCssVar('--modal-bg', '#ffffff'),
          'editorHoverWidget.border': _getCssVar('--modal-border', '#e5e7eb'),
          // Context menu / command palette
          'menu.background': _getCssVar('--modal-bg', '#ffffff'),
          'menu.foreground': _getCssVar('--modal-text', '#111827'),
          'menu.selectionBackground': '#2563eb1e',
          'menu.selectionForeground': _getCssVar('--modal-text', '#111827'),
          'menu.separatorBackground': 'rgba(15, 23, 42, 0.12)',
          'menu.border': _getCssVar('--modal-border', '#e5e7eb'),
          'widget.shadow': _getCssVar('--xk-tooltip-shadow', 'rgba(15, 23, 42, 0.14)'),
          'scrollbarSlider.background': '#94a3b855',
          'scrollbarSlider.hoverBackground': '#94a3b888',
          'scrollbarSlider.activeBackground': '#94a3b8aa',
        },
      });

      _state.themesDefined = true;
      try { window.__xkeenMonacoThemesDefined = true; } catch (e) {}
    } catch (e) {}
  }

  function applyTheme(monaco) {
    try {
      if (!monaco || !monaco.editor || typeof monaco.editor.setTheme !== 'function') return;
      ensureThemes(monaco);
      monaco.editor.setTheme(_getThemeName());
    } catch (e) {}
  }

  function wireThemeSync(monaco) {
    try {
      if (_state.themeWired || window.__xkeenMonacoThemeWired) return;
      _state.themeWired = true;
      try { window.__xkeenMonacoThemeWired = true; } catch (e) {}

      document.addEventListener('xkeen-theme-change', () => {
        try {
          const m = monaco || window.monaco;
          if (m && m.editor) applyTheme(m);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function _isVisible(el) {
    try {
      if (!el) return false;
      if (el.offsetParent !== null) return true;
      // offsetParent is null for position:fixed elements, so also check rect.
      const r = el.getBoundingClientRect();
      return !!(r && r.width > 0 && r.height > 0);
    } catch (e) {}
    return false;
  }

  function layoutOnVisible(editor, host) {
    if (!editor || typeof editor.layout !== 'function') return () => {};
    const el = host;

    const bump = () => {
      try {
        if (!_isVisible(el)) return;
        editor.layout();
        // A couple of extra layouts to survive "created while hidden" and slow rendering.
        try {
          requestAnimationFrame(() => {
            try { editor.layout(); } catch (e) {}
            try { setTimeout(() => { try { editor.layout(); } catch (e2) {} }, 0); } catch (e3) {}
            try { setTimeout(() => { try { editor.layout(); } catch (e4) {} }, 120); } catch (e5) {}
          });
        } catch (e) {}
      } catch (e) {}
    };

    // ResizeObserver: react to container resize.
    let ro = null;
    try {
      if (typeof ResizeObserver !== 'undefined' && el) {
        ro = _state.roByHost ? _state.roByHost.get(el) : (el.__xkMonacoRO || null);
        if (!ro) {
          ro = new ResizeObserver(() => {
            try { bump(); } catch (e) {}
          });
          ro.observe(el);
          if (_state.roByHost) _state.roByHost.set(el, ro);
          else el.__xkMonacoRO = ro;
        }
      }
    } catch (e) {}

    // MutationObserver: react to display/class changes (modals/tabs).
    let mo = null;
    try {
      if (typeof MutationObserver !== 'undefined' && el) {
        mo = _state.moByHost ? _state.moByHost.get(el) : (el.__xkMonacoMO || null);
        if (!mo) {
          mo = new MutationObserver(() => {
            try { bump(); } catch (e) {}
          });
          mo.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
          if (_state.moByHost) _state.moByHost.set(el, mo);
          else el.__xkMonacoMO = mo;
        }
      }
    } catch (e) {}

    // Run once now.
    try { bump(); } catch (e) {}

    // Return disposer (best-effort).
    return () => {
      try {
        if (ro && ro.disconnect) ro.disconnect();
        if (mo && mo.disconnect) mo.disconnect();
      } catch (e) {}
    };
  }

  async function _ensureMonaco() {
    if (!window.XKeen || !XKeen.monacoLoader || typeof XKeen.monacoLoader.ensureMonaco !== 'function') {
      throw new Error('Monaco loader not found (monaco_loader.js)');
    }
    const monaco = await XKeen.monacoLoader.ensureMonaco();
    if (!monaco || !monaco.editor || typeof monaco.editor.create !== 'function') {
      throw new Error('Monaco editor API is not available');
    }
    return monaco;
  }

  function _typographyOpts() {
    // Keep typography consistent with CodeMirror in our panel.
    const scale = _getCssVarNum('--xk-font-scale', 1);
    const fontSize = Math.max(12, Math.round(16 * scale));
    const lineHeight = Math.max(18, Math.round(fontSize * 1.45));
    const fontFamily = _getCssVar(
      '--xk-mono-font-family',
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
    );
    return { fontFamily, fontSize, lineHeight };
  }

  async function createEditor(host, opts) {
    const el = host;
    if (!el) return null;

    // Ensure consistent class for shared CSS (fullscreen, modal sizing, etc.)
    try {
      if (el.classList && !el.classList.contains('xk-monaco-editor')) el.classList.add('xk-monaco-editor');
    } catch (e) {}

    const o = opts || {};
    const reqLangRaw = String(o.language || 'plaintext').toLowerCase().trim();
    const language = _normalizeLanguage(reqLangRaw);
    const readOnly = !!o.readOnly;
    const value = String(o.value ?? '');

    try {
      const monaco = await _ensureMonaco();
      // If caller requests JSON-with-comments, enable it for Monaco JSON diagnostics.
      try {
        if (o.allowComments || reqLangRaw === 'jsonc') _maybeEnableJsonComments(monaco);
      } catch (e) {}
      // Ensure the requested language is registered (best-effort).
      try { await _ensureLanguage(monaco, language); } catch (e) {}
      try { applyTheme(monaco); } catch (e) {}
      try { wireThemeSync(monaco); } catch (e) {}

      const typo = _typographyOpts();

      const editor = monaco.editor.create(el, {
        value,
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        stickyScroll: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: o.wordWrap || 'on',
        tabSize: (typeof o.tabSize === 'number') ? o.tabSize : 2,
        insertSpaces: (typeof o.insertSpaces === 'boolean') ? o.insertSpaces : true,
        fontFamily: o.fontFamily || typo.fontFamily,
        fontSize: (typeof o.fontSize === 'number') ? o.fontSize : typo.fontSize,
        lineHeight: (typeof o.lineHeight === 'number') ? o.lineHeight : typo.lineHeight,
      });

      // Apply language to the model explicitly (Monaco may ignore unknown option fields).
      try {
        const m = editor && editor.getModel ? editor.getModel() : null;
        if (m && monaco.editor && monaco.editor.setModelLanguage && language && language !== 'plaintext') {
          // 'jsonc' might not exist as a separate language id; fall back to 'json'.
          const langToSet = (language === 'jsonc') ? 'json' : language;
          monaco.editor.setModelLanguage(m, langToSet);
        }
      } catch (e) {}

      // Attach onChange callback (best-effort).
      try {
        if (o.onChange && typeof o.onChange === 'function' && editor && typeof editor.onDidChangeModelContent === 'function') {
          editor.onDidChangeModelContent(() => {
            try { o.onChange(); } catch (e) {}
          });
        }
      } catch (e) {}

      // Ensure it lays out even if created in hidden container.
      try { layoutOnVisible(editor, el); } catch (e) {}

      return editor;
    } catch (e) {
      return null;
    }
  }

  function toFacade(editor) {
    const ed = editor;
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
        try {
          if (typeof y === 'number' && ed.setScrollTop) ed.setScrollTop(Math.max(0, y));
          else if (ed.setScrollTop) ed.setScrollTop(0);
        } catch (e) {}
      },
      layout: () => {
        try { if (ed.layout) ed.layout(); } catch (e) {}
      },
      dispose: () => {
        try { if (ed.dispose) ed.dispose(); } catch (e) {}
      },
      onChange: (cb) => {
        try {
          if (!cb || typeof cb !== 'function') return () => {};
          if (ed && typeof ed.onDidChangeModelContent === 'function') {
            const d = ed.onDidChangeModelContent(() => {
              try { cb(); } catch (e) {}
            });
            return () => { try { if (d && d.dispose) d.dispose(); } catch (e) {} };
          }
        } catch (e) {}
        return () => {};
      },
    };
  }

  XKeen.ui.monacoShared = {
    ensureThemes,
    applyTheme,
    wireThemeSync,
    createEditor,
    layoutOnVisible,
    toFacade,
  };
})();
