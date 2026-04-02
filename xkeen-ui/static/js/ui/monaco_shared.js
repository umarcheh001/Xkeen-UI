import { isXkeenMipsRuntime } from '../features/xkeen_runtime.js';

(() => {
  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
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


  function _installClipboardCompat() {
    try {
      if (window.__xkMonacoClipboardCompatInstalled) return;
      window.__xkMonacoClipboardCompatInstalled = true;
    } catch (e) {}

    let nav = null;
    try { nav = window.navigator || null; } catch (e) {}
    if (!nav) return;

    let clipboard = null;
    try { clipboard = nav.clipboard || null; } catch (e) {}
    if (!clipboard) return;

    const noopWriteText = function () { return Promise.resolve(); };
    const compatWrite = function () { return Promise.resolve(); };

    // Never fake read()/readText() here.
    // Monaco uses clipboard readability to decide how Paste should behave.
    // A fake readText() that resolves to '' makes Paste appear to work while
    // actually inserting an empty string.
    try { if (typeof clipboard.writeText !== 'function') clipboard.writeText = noopWriteText; } catch (e) {}
    try { if (typeof clipboard.write !== 'function') clipboard.write = compatWrite; } catch (e) {}
  }

  function _installExpectedRejectionFilter() {
    try {
      if (window.__xkMonacoExpectedRejectionFilterInstalled) return;
      window.__xkMonacoExpectedRejectionFilterInstalled = true;
    } catch (e) {}

    try {
      window.addEventListener('unhandledrejection', function (event) {
        const reason = event ? event.reason : null;
        const name = (() => {
          try { return String((reason && reason.name) || ''); } catch (e) { return ''; }
        })();
        const message = (() => {
          try {
            if (reason && typeof reason.message === 'string') return reason.message;
            return String(reason || '');
          } catch (e) {
            return '';
          }
        })();
        const stack = (() => {
          try { return String((reason && reason.stack) || ''); } catch (e) { return ''; }
        })();
        const hint = [name, message, stack].join('\n');
        const monacoScoped = /editor\.api-|monaco\.|\/vs\//i.test(hint);
        const cancellationLike = /(^|\b)cancel(ed|led)?(\b|:)/i.test(name) || /Canceled:\s*Canceled/i.test(message);
        if (monacoScoped && cancellationLike) {
          try { event.preventDefault(); } catch (e) {}
        }
      }, true);
    } catch (e) {}
  }

  _installClipboardCompat();
  _installExpectedRejectionFilter();

  const PERF_LIMITS = {
    softLines: 1800,
    softChars: 110000,
    webkitSoftLines: 320,
    webkitSoftChars: 22000,
  };

  function _shouldRelaxForSafari(opts) {
    const o = opts || {};
    if (o.disableSafariOptimizations) return false;
    return _isWebKitSafari();
  }

  function _isMipsTarget() {
    if (isXkeenMipsRuntime()) return true;
    try {
      return /mips/i.test(String((window.navigator && window.navigator.userAgent) || ''));
    } catch (e) {}
    return false;
  }

  function _isWebKitSafari() {
    try {
      const nav = window.navigator || {};
      const ua = String(nav.userAgent || '');
      const vendor = String(nav.vendor || '');
      if (!ua) return false;
      if (!/Safari/i.test(ua)) return false;
      if (!/Apple/i.test(vendor)) return false;
      if (/(Chrome|Chromium|CriOS|Edg|OPR|OPT|Opera|Vivaldi|DuckDuckGo|Firefox|FxiOS|Arc|Brave)/i.test(ua)) return false;
      return true;
    } catch (e) {}
    return false;
  }

  function _countLines(text) {
    const s = String(text ?? '');
    if (!s) return 1;
    let n = 1;
    for (let i = 0; i < s.length; i += 1) {
      if (s.charCodeAt(i) === 10) n += 1;
    }
    return n;
  }

  function _computePerfProfile(value, opts) {
    const o = opts || {};
    const raw = String(value ?? '');
    const lineCount = _countLines(raw);
    const charCount = raw.length;
    const requested = String(o.performanceProfile || '').toLowerCase().trim();
    const safariLite = _shouldRelaxForSafari(o)
      && (lineCount >= PERF_LIMITS.webkitSoftLines || charCount >= PERF_LIMITS.webkitSoftChars);
    const lite = requested === 'lite'
      || (requested !== 'default' && (_isMipsTarget() || safariLite || lineCount >= PERF_LIMITS.softLines || charCount >= PERF_LIMITS.softChars));
    return { lite, lineCount, charCount };
  }

  function _normalizeLanguage(lang) {
    const s = String(lang || '').toLowerCase().trim();
    if (!s) return 'plaintext';
    // Monaco core reliably supports 'json'. Some panels use 'jsonc' for JSON-with-comments.
    // In minimal Monaco builds, 'jsonc' might not be registered as a separate language id.
    // We keep 'jsonc' as a signal for diagnostics (allowComments), but still load json contribution.
    if (s === 'yml') return 'yaml';
    return s;
  }

  function _runtimeLanguageId(language) {
    const lang = _normalizeLanguage(language);
    if (lang === 'jsonc') return 'json';
    if (lang === 'bash' || lang === 'sh') return 'shell';
    return lang;
  }

  function _isLanguageRegistered(monaco, language) {
    try {
      if (!monaco || !monaco.languages || typeof monaco.languages.getLanguages !== 'function') return false;
      const runtimeLang = _runtimeLanguageId(language);
      if (!runtimeLang || runtimeLang === 'plaintext') return true;
      const languages = monaco.languages.getLanguages();
      return Array.isArray(languages) && languages.some((entry) => {
        return String((entry && entry.id) || '').toLowerCase() === runtimeLang;
      });
    } catch (e) {}
    return false;
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
    // Monaco's editor.main bundle in this project already registers the languages we use
    // (json/jsonc, yaml, shell, ini, html, css, js, python, markdown, toml, xml).
    // Requiring contribution modules again can trigger duplicate AMD module warnings.
    try {
      const runtimeLang = _runtimeLanguageId(language);
      if (!runtimeLang || runtimeLang === 'plaintext') return;
      if (_state.langLoaded && _state.langLoaded.has(runtimeLang)) return;
      if (_isLanguageRegistered(monaco, runtimeLang)) {
        if (_state.langLoaded) _state.langLoaded.add(runtimeLang);
      } else {
        // Unknown/unsupported language ids fall back to plaintext later.
        try { if (_state.langLoaded) _state.langLoaded.add(runtimeLang); } catch (e) {}
      }
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

  function _getThemeMode() {
    try {
      return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    } catch (e) {}
    return 'dark';
  }

  function _getWidgetPalette(mode) {
    const activeMode = _getThemeMode();
    const isActive = activeMode === mode;
    const isLight = mode === 'light';
    const fallback = isLight
      ? {
          accent: '#3f6fcb',
          modalBg: '#fffffff5',
          modalText: '#162033',
          modalMuted: '#5f718fd1',
          modalBorder: '#3f6fcb1f',
          shadow: 'rgba(15, 23, 42, 0.14)',
          inputBg: '#f8fbff',
          inputPlaceholder: '#7b8aa5',
          listFocus: '#3f6fcb24',
          listHover: '#60a5fa16',
          countBadgeBg: '#3f6fcb',
          countBadgeFg: '#ffffff',
          peekTitleBg: '#eef4ff',
          peekEditorBg: '#ffffff',
          markerBg: '#f8fbff',
          markerErrorBg: '#fff1f2',
          markerErrorHeaderBg: '#ffe4e6',
          markerWarningBg: '#fff7ed',
          markerWarningHeaderBg: '#ffedd5',
          markerInfoBg: '#eff6ff',
          markerInfoHeaderBg: '#dbeafe',
          errorBg: '#fff1f2',
          errorFg: '#9f1239',
          errorBorder: '#fb7185',
        }
      : {
          accent: '#60a5fa',
          modalBg: '#060e1eeb',
          modalText: '#f8fbff',
          modalMuted: '#bfdbfebd',
          modalBorder: '#475569d1',
          shadow: 'rgba(15, 23, 42, 0.55)',
          inputBg: 'rgba(8, 20, 46, 0.92)',
          inputPlaceholder: '#8ea8d9',
          listFocus: '#1d4ed840',
          listHover: 'rgba(96, 165, 250, 0.12)',
          countBadgeBg: '#2563eb',
          countBadgeFg: '#f8fbff',
          peekTitleBg: '#0b162a',
          peekEditorBg: '#020617',
          markerBg: '#07111f',
          markerErrorBg: '#1a0b12',
          markerErrorHeaderBg: '#2a0f18',
          markerWarningBg: '#1a1407',
          markerWarningHeaderBg: '#32240a',
          markerInfoBg: '#08162a',
          markerInfoHeaderBg: '#0d2340',
          errorBg: '#2a0f18',
          errorFg: '#fecdd3',
          errorBorder: '#fb7185',
        };

    return {
      accent: isActive ? _getCssVar('--accent', fallback.accent) : fallback.accent,
      modalBg: isActive ? _getCssVar('--xk-monaco-widget-bg', fallback.modalBg) : fallback.modalBg,
      modalText: isActive ? _getCssVar('--xk-monaco-widget-text', fallback.modalText) : fallback.modalText,
      modalMuted: isActive ? _getCssVar('--xk-monaco-widget-muted', fallback.modalMuted) : fallback.modalMuted,
      modalBorder: isActive ? _getCssVar('--xk-monaco-widget-border', fallback.modalBorder) : fallback.modalBorder,
      shadow: isActive ? _getCssVar('--xk-monaco-widget-shadow', fallback.shadow) : fallback.shadow,
      inputBg: isActive ? _getCssVar('--xk-monaco-input-bg', fallback.inputBg) : fallback.inputBg,
      inputPlaceholder: isActive ? _getCssVar('--xk-monaco-widget-muted', fallback.inputPlaceholder) : fallback.inputPlaceholder,
      listFocus: isActive ? _getCssVar('--xk-monaco-widget-hover', fallback.listFocus) : fallback.listFocus,
      listHover: isActive ? _getCssVar('--xk-monaco-widget-hover', fallback.listHover) : fallback.listHover,
      countBadgeBg: fallback.countBadgeBg,
      countBadgeFg: fallback.countBadgeFg,
      peekTitleBg: isActive ? _getCssVar('--xk-monaco-problem-header-bg', fallback.peekTitleBg) : fallback.peekTitleBg,
      peekEditorBg: fallback.peekEditorBg,
      markerBg: isActive ? _getCssVar('--xk-monaco-problem-bg', fallback.markerBg) : fallback.markerBg,
      markerErrorBg: isActive ? _getCssVar('--xk-monaco-problem-bg', fallback.markerErrorBg) : fallback.markerErrorBg,
      markerErrorHeaderBg: isActive ? _getCssVar('--xk-monaco-problem-header-bg', fallback.markerErrorHeaderBg) : fallback.markerErrorHeaderBg,
      markerWarningBg: fallback.markerWarningBg,
      markerWarningHeaderBg: fallback.markerWarningHeaderBg,
      markerInfoBg: fallback.markerInfoBg,
      markerInfoHeaderBg: fallback.markerInfoHeaderBg,
      errorBg: isActive ? _getCssVar('--xk-monaco-input-bg', fallback.errorBg) : fallback.errorBg,
      errorFg: isActive ? _getCssVar('--xk-monaco-widget-text', fallback.errorFg) : fallback.errorFg,
      errorBorder: isActive ? _getCssVar('--xk-monaco-widget-border', fallback.errorBorder) : fallback.errorBorder,
    };
  }

  function ensureThemes(monaco) {
    try {
      if (!monaco || !monaco.editor || typeof monaco.editor.defineTheme !== 'function') return;
      // Re-define themes on each apply so widget colors stay in sync with current CSS vars.
      const darkUi = _getWidgetPalette('dark');
      const lightUi = _getWidgetPalette('light');

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
          'editorCursor.foreground': darkUi.accent,
          'editor.selectionBackground': '#1d4ed850',
          'editor.inactiveSelectionBackground': '#1d4ed820',
          'editorIndentGuide.background1': '#1f2937',
          'editorIndentGuide.activeBackground1': '#334155',
          'editorRuler.foreground': '#111827',
          'editorGutter.background': '#020617',
          'editorWhitespace.foreground': '#334155',
          'editorWidget.background': darkUi.modalBg,
          'editorWidget.foreground': darkUi.modalText,
          'editorWidget.border': darkUi.modalBorder,
          'editorWidget.resizeBorder': darkUi.accent,
          'editorSuggestWidget.background': darkUi.modalBg,
          'editorSuggestWidget.border': darkUi.modalBorder,
          'editorSuggestWidget.foreground': darkUi.modalText,
          'editorSuggestWidget.selectedBackground': '#1d4ed840',
          'editorSuggestWidget.highlightForeground': darkUi.accent,
          'editorSuggestWidget.selectedForeground': darkUi.modalText,
          'editorSuggestWidget.selectedIconForeground': darkUi.accent,
          'editorHoverWidget.background': darkUi.modalBg,
          'editorHoverWidget.foreground': darkUi.modalText,
          'editorHoverWidget.border': darkUi.modalBorder,
          'editorHoverWidget.statusBarBackground': darkUi.peekTitleBg,
          'focusBorder': darkUi.accent,
          'descriptionForeground': darkUi.modalMuted,
          'disabledForeground': '#7f93b4',
          'textLink.foreground': '#7db6ff',
          'textLink.activeForeground': '#c7e0ff',
          'editorLink.activeForeground': '#7db6ff',
          // Context menu / command palette
          'menu.background': darkUi.modalBg,
          'menu.foreground': darkUi.modalText,
          'menu.selectionBackground': darkUi.listFocus,
          'menu.selectionForeground': darkUi.modalText,
          'menu.selectionBorder': 'transparent',
          'menu.separatorBackground': 'rgba(148, 163, 184, 0.18)',
          'menu.border': darkUi.modalBorder,
          'editorActionList.background': darkUi.modalBg,
          'editorActionList.foreground': darkUi.modalText,
          'editorActionList.focusBackground': darkUi.listFocus,
          'editorActionList.focusForeground': darkUi.modalText,
          'widget.shadow': darkUi.shadow,
          'quickInput.background': darkUi.modalBg,
          'quickInput.foreground': darkUi.modalText,
          'quickInputTitle.background': darkUi.peekTitleBg,
          'quickInputList.focusBackground': darkUi.listFocus,
          'quickInputList.focusForeground': darkUi.modalText,
          'quickInputList.focusIconForeground': darkUi.accent,
          'quickInputList.focusOutline': 'transparent',
          'quickInputList.countBadgeBackground': darkUi.countBadgeBg,
          'quickInputList.countBadgeForeground': darkUi.countBadgeFg,
          'pickerGroup.border': darkUi.modalBorder,
          'pickerGroup.foreground': darkUi.modalMuted,
          'input.background': darkUi.inputBg,
          'input.foreground': darkUi.modalText,
          'input.border': darkUi.modalBorder,
          'input.placeholderForeground': darkUi.inputPlaceholder,
          'inputOption.activeBackground': 'rgba(96, 165, 250, 0.16)',
          'inputOption.activeBorder': darkUi.accent,
          'inputOption.activeForeground': darkUi.modalText,
          'inputValidation.errorBackground': darkUi.errorBg,
          'inputValidation.errorForeground': darkUi.errorFg,
          'inputValidation.errorBorder': darkUi.errorBorder,
          'list.hoverBackground': darkUi.listHover,
          'list.activeSelectionBackground': darkUi.listFocus,
          'list.activeSelectionForeground': darkUi.modalText,
          'list.inactiveSelectionBackground': darkUi.listHover,
          'list.focusBackground': darkUi.listFocus,
          'list.focusForeground': darkUi.modalText,
          'list.focusOutline': 'transparent',
          'peekView.border': darkUi.modalBorder,
          'peekViewEditor.background': darkUi.peekEditorBg,
          'peekViewEditor.matchHighlightBackground': 'rgba(96, 165, 250, 0.18)',
          'peekViewEditorGutter.background': darkUi.peekEditorBg,
          'peekViewResult.background': darkUi.modalBg,
          'peekViewResult.fileForeground': darkUi.modalText,
          'peekViewResult.lineForeground': darkUi.modalMuted,
          'peekViewResult.matchHighlightBackground': 'rgba(96, 165, 250, 0.18)',
          'peekViewResult.selectionBackground': darkUi.listFocus,
          'peekViewResult.selectionForeground': darkUi.modalText,
          'peekViewTitle.background': darkUi.peekTitleBg,
          'peekViewTitleLabel.foreground': darkUi.modalText,
          'peekViewTitleDescription.foreground': darkUi.modalMuted,
          'problemsErrorIcon.foreground': '#f6a5b5',
          'problemsWarningIcon.foreground': '#f8cc79',
          'problemsInfoIcon.foreground': '#8cc7ff',
          'editorMarkerNavigation.background': darkUi.markerBg,
          'editorMarkerNavigationError.background': darkUi.markerErrorBg,
          'editorMarkerNavigationError.headerBackground': darkUi.markerErrorHeaderBg,
          'editorMarkerNavigationWarning.background': darkUi.markerWarningBg,
          'editorMarkerNavigationWarning.headerBackground': darkUi.markerWarningHeaderBg,
          'editorMarkerNavigationInfo.background': darkUi.markerInfoBg,
          'editorMarkerNavigationInfo.headerBackground': darkUi.markerInfoHeaderBg,
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
          'editorCursor.foreground': lightUi.accent,
          'editor.selectionBackground': '#2563eb30',
          'editor.inactiveSelectionBackground': '#2563eb18',
          'editorIndentGuide.background1': '#e5e7eb',
          'editorIndentGuide.activeBackground1': '#cbd5e1',
          'editorRuler.foreground': '#e5e7eb',
          'editorGutter.background': '#ffffff',
          'editorWhitespace.foreground': '#cbd5e1',
          'editorWidget.background': lightUi.modalBg,
          'editorWidget.foreground': lightUi.modalText,
          'editorWidget.border': lightUi.modalBorder,
          'editorWidget.resizeBorder': lightUi.accent,
          'editorSuggestWidget.background': lightUi.modalBg,
          'editorSuggestWidget.border': lightUi.modalBorder,
          'editorSuggestWidget.foreground': lightUi.modalText,
          'editorSuggestWidget.selectedBackground': '#2563eb1e',
          'editorSuggestWidget.highlightForeground': lightUi.accent,
          'editorSuggestWidget.selectedForeground': lightUi.modalText,
          'editorSuggestWidget.selectedIconForeground': lightUi.accent,
          'editorHoverWidget.background': lightUi.modalBg,
          'editorHoverWidget.foreground': lightUi.modalText,
          'editorHoverWidget.border': lightUi.modalBorder,
          'editorHoverWidget.statusBarBackground': lightUi.peekTitleBg,
          'focusBorder': lightUi.accent,
          'descriptionForeground': lightUi.modalMuted,
          'disabledForeground': '#7b8aa5',
          'textLink.foreground': '#2f5fc7',
          'textLink.activeForeground': '#1e429f',
          'editorLink.activeForeground': '#2f5fc7',
          // Context menu / command palette
          'menu.background': lightUi.modalBg,
          'menu.foreground': lightUi.modalText,
          'menu.selectionBackground': '#2563eb1e',
          'menu.selectionForeground': lightUi.modalText,
          'menu.selectionBorder': 'transparent',
          'menu.separatorBackground': 'rgba(15, 23, 42, 0.12)',
          'menu.border': lightUi.modalBorder,
          'editorActionList.background': lightUi.modalBg,
          'editorActionList.foreground': lightUi.modalText,
          'editorActionList.focusBackground': lightUi.listFocus,
          'editorActionList.focusForeground': lightUi.modalText,
          'widget.shadow': lightUi.shadow,
          'quickInput.background': lightUi.modalBg,
          'quickInput.foreground': lightUi.modalText,
          'quickInputTitle.background': lightUi.peekTitleBg,
          'quickInputList.focusBackground': lightUi.listFocus,
          'quickInputList.focusForeground': lightUi.modalText,
          'quickInputList.focusIconForeground': lightUi.accent,
          'quickInputList.focusOutline': 'transparent',
          'quickInputList.countBadgeBackground': lightUi.countBadgeBg,
          'quickInputList.countBadgeForeground': lightUi.countBadgeFg,
          'pickerGroup.border': lightUi.modalBorder,
          'pickerGroup.foreground': lightUi.modalMuted,
          'input.background': lightUi.inputBg,
          'input.foreground': lightUi.modalText,
          'input.border': lightUi.modalBorder,
          'input.placeholderForeground': lightUi.inputPlaceholder,
          'inputOption.activeBackground': '#2563eb16',
          'inputOption.activeBorder': lightUi.accent,
          'inputOption.activeForeground': lightUi.modalText,
          'inputValidation.errorBackground': lightUi.errorBg,
          'inputValidation.errorForeground': lightUi.errorFg,
          'inputValidation.errorBorder': lightUi.errorBorder,
          'list.hoverBackground': lightUi.listHover,
          'list.activeSelectionBackground': lightUi.listFocus,
          'list.activeSelectionForeground': lightUi.modalText,
          'list.inactiveSelectionBackground': lightUi.listHover,
          'list.focusBackground': lightUi.listFocus,
          'list.focusForeground': lightUi.modalText,
          'list.focusOutline': 'transparent',
          'peekView.border': lightUi.modalBorder,
          'peekViewEditor.background': lightUi.peekEditorBg,
          'peekViewEditor.matchHighlightBackground': '#2563eb1e',
          'peekViewEditorGutter.background': lightUi.peekEditorBg,
          'peekViewResult.background': lightUi.modalBg,
          'peekViewResult.fileForeground': lightUi.modalText,
          'peekViewResult.lineForeground': lightUi.modalMuted,
          'peekViewResult.matchHighlightBackground': '#2563eb1e',
          'peekViewResult.selectionBackground': lightUi.listFocus,
          'peekViewResult.selectionForeground': lightUi.modalText,
          'peekViewTitle.background': lightUi.peekTitleBg,
          'peekViewTitleLabel.foreground': lightUi.modalText,
          'peekViewTitleDescription.foreground': lightUi.modalMuted,
          'problemsErrorIcon.foreground': '#d6506f',
          'problemsWarningIcon.foreground': '#b7791f',
          'problemsInfoIcon.foreground': '#2563eb',
          'editorMarkerNavigation.background': lightUi.markerBg,
          'editorMarkerNavigationError.background': lightUi.markerErrorBg,
          'editorMarkerNavigationError.headerBackground': lightUi.markerErrorHeaderBg,
          'editorMarkerNavigationWarning.background': lightUi.markerWarningBg,
          'editorMarkerNavigationWarning.headerBackground': lightUi.markerWarningHeaderBg,
          'editorMarkerNavigationInfo.background': lightUi.markerInfoBg,
          'editorMarkerNavigationInfo.headerBackground': lightUi.markerInfoHeaderBg,
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

  function layoutOnVisible(editor, host, opts) {
    if (!editor || typeof editor.layout !== 'function') return () => {};
    const el = host;
    const lite = !!(opts && opts.lite);
    let scheduled = false;

    const bumpNow = () => {
      try {
        if (!_isVisible(el)) return;
        editor.layout();
        if (!lite) {
          try {
            setTimeout(() => {
              try {
                if (_isVisible(el)) editor.layout();
              } catch (e2) {}
            }, 120);
          } catch (e3) {}
        }
      } catch (e) {}
    };

    const bump = () => {
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        bumpNow();
      };
      try {
        requestAnimationFrame(run);
      } catch (e) {
        try { setTimeout(run, 0); } catch (e2) {}
      }
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


  function _getSettingsApi() {
    try {
      return (window.XKeen && XKeen.ui && XKeen.ui.settings) ? XKeen.ui.settings : null;
    } catch (e) {
      return null;
    }
  }

  function _getEditorFontScaleFromSettings(snapshot) {
    try {
      const editor = (snapshot && snapshot.editor && typeof snapshot.editor === 'object') ? snapshot.editor : {};
      const api = _getSettingsApi();
      if (api && typeof api.getEditorFontScale === 'function') {
        return api.getEditorFontScale(snapshot, 'monaco');
      }
      if (api && typeof api.clampEditorFontScale === 'function') {
        if (Object.prototype.hasOwnProperty.call(editor, 'monacoFontScale')) return api.clampEditorFontScale(editor.monacoFontScale);
        if (Object.prototype.hasOwnProperty.call(editor, 'fontScale')) return api.clampEditorFontScale(editor.fontScale);
      }
      const raw = Object.prototype.hasOwnProperty.call(editor, 'monacoFontScale') ? editor.monacoFontScale : editor.fontScale;
      const num = Number(raw);
      if (!Number.isFinite(num)) return 100;
      return Math.max(75, Math.min(200, Math.round(num)));
    } catch (e) {
      return 100;
    }
  }

  function _editorTypographyOpts(snapshot) {
    const typo = _typographyOpts();
    const fontScale = _getEditorFontScaleFromSettings(snapshot);
    typo.fontSize = Math.max(12, Math.round(typo.fontSize * (fontScale / 100)));
    typo.lineHeight = Math.max(18, Math.round(typo.fontSize * 1.45));
    return typo;
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
    const perf = _computePerfProfile(value, o);
    const safari = _shouldRelaxForSafari(o);

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

      const typo = _editorTypographyOpts((_getSettingsApi() && typeof _getSettingsApi().get === 'function') ? _getSettingsApi().get() : null);

      const editor = monaco.editor.create(el, {
        value,
        readOnly,
        contextmenu: (typeof o.contextmenu === 'boolean') ? o.contextmenu : true,
        automaticLayout: !(perf.lite || safari),
        minimap: { enabled: false },
        stickyScroll: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: o.wordWrap || ((perf.lite || safari) ? 'off' : 'on'),
        disableLayerHinting: safari,
        disableMonospaceOptimizations: safari,
        links: !perf.lite && !safari,
        selectionHighlight: !perf.lite && !safari,
        occurrencesHighlight: (perf.lite || safari) ? 'off' : 'singleFile',
        renderLineHighlight: (perf.lite || safari) ? 'none' : 'line',
        quickSuggestions: !perf.lite && !safari,
        suggestOnTriggerCharacters: !perf.lite && !safari,
        folding: !perf.lite && !safari,
        matchBrackets: (perf.lite || safari) ? 'never' : 'always',
        parameterHints: { enabled: !perf.lite && !safari },
        smoothScrolling: false,
        cursorSmoothCaretAnimation: 'off',
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
          const langToSet = _isLanguageRegistered(monaco, language) ? _runtimeLanguageId(language) : 'plaintext';
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

      // React to UI settings changes (editor font scale) unless caller explicitly overrides typography.
      try {
        const settingsApi = _getSettingsApi();
        const manageFontFamily = !o.fontFamily;
        const manageFontSize = typeof o.fontSize !== 'number';
        const manageLineHeight = typeof o.lineHeight !== 'number';
        if (settingsApi && typeof settingsApi.subscribe === 'function' && (manageFontFamily || manageFontSize || manageLineHeight)) {
          const applyManagedTypography = (snapshot) => {
            try {
              const nextTypo = _editorTypographyOpts(snapshot);
              const patch = {};
              if (manageFontFamily) patch.fontFamily = nextTypo.fontFamily;
              if (manageFontSize) patch.fontSize = nextTypo.fontSize;
              if (manageLineHeight) patch.lineHeight = nextTypo.lineHeight;
              if (Object.keys(patch).length && editor && typeof editor.updateOptions === 'function') {
                editor.updateOptions(patch);
                try { if (editor.layout) editor.layout(); } catch (e2) {}
              }
            } catch (e2) {}
          };
          const unsubscribeTypography = settingsApi.subscribe((nextSnapshot) => {
            applyManagedTypography(nextSnapshot);
          });
          if (editor && typeof editor.onDidDispose === 'function') {
            editor.onDidDispose(() => {
              try { unsubscribeTypography(); } catch (e2) {}
            });
          }
        }
      } catch (e) {}

      // Ensure it lays out even if created in hidden container.
      try { layoutOnVisible(editor, el, { lite: perf.lite }); } catch (e) {}

      return editor;
    } catch (e) {
      return null;
    }
  }

  function getEditorEngineHelper() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) return XKeen.ui.editorEngine;
    } catch (e) {}
    return null;
  }

  function toFacade(editor, opts) {
    const helper = getEditorEngineHelper();
    try {
      if (helper && typeof helper.fromMonaco === 'function') {
        const facade = helper.fromMonaco(editor, opts || {});
        if (facade) return facade;
      }
    } catch (e) {}

    const ed = editor;
    return {
      kind: 'monaco',
      engine: 'monaco',
      raw: ed,
      editor: ed,
      getValue: () => {
        try { return String(ed.getValue() || ''); } catch (e) { return ''; }
      },
      get: () => {
        try { return String(ed.getValue() || ''); } catch (e) { return ''; }
      },
      setValue: (v) => {
        try { ed.setValue(String(v ?? '')); } catch (e) {}
      },
      set: (v) => {
        try { ed.setValue(String(v ?? '')); } catch (e) {}
      },
      validate: () => true,
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
      saveViewState: () => {
        try {
          return {
            kind: 'monaco',
            state: (typeof ed.saveViewState === 'function') ? ed.saveViewState() : null,
            pos: (typeof ed.getPosition === 'function') ? ed.getPosition() : null,
            scrollTop: (typeof ed.getScrollTop === 'function') ? ed.getScrollTop() : 0,
            scrollLeft: (typeof ed.getScrollLeft === 'function') ? ed.getScrollLeft() : 0,
          };
        } catch (e) {}
        return { kind: 'monaco' };
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
