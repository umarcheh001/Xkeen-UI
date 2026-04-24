import { isXkeenMipsRuntime } from '../features/xkeen_runtime.js';
import { buildJsonSchemaHoverInfo, buildJsoncPointerMap } from '../vendor/codemirror_json_schema.js';
import { completeYamlTextFromSchema, hoverYamlTextFromSchema } from './yaml_schema.js';

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
    jsonModeConfigured: false,
    jsonSchemasByModelUri: new Map(),
    nextModelId: 1,
    // WeakMaps are supported in modern browsers; if not, we fall back to expando properties.
    roByHost: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    moByHost: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    customContextMenuEl: null,
    customContextMenuCtx: null,
    customContextMenuCleanupByEditor: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    customContextMenuClipboardShadow: '',
    yamlAssistByModel: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    snippetProvidersByModel: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    quickFixProvidersByModel: typeof WeakMap !== 'undefined' ? new WeakMap() : null,
    jsonHoverProvidersInstalled: false,
    yamlAssistProvidersInstalled: false,
    jsonSnippetProvidersInstalled: false,
    quickFixProvidersInstalled: false,
  };
  const _CUSTOM_CONTEXT_MENU_CLEANUP_KEY = '__xkMonacoCustomContextMenuCleanup';


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
      if (!_applyManagedJsonDiagnostics(monaco)) return;
      _state.jsonCommentsEnabled = true;
    } catch (e) {}
  }

  function _isJsonLanguage(language) {
    const lang = _normalizeLanguage(language);
    return lang === 'json' || lang === 'jsonc';
  }

  function _getJsonDefaults(monaco) {
    try {
      if (!monaco || !monaco.languages || !monaco.languages.json || !monaco.languages.json.jsonDefaults) return null;
      const defaults = monaco.languages.json.jsonDefaults;
      if (!defaults || typeof defaults.setDiagnosticsOptions !== 'function') return null;
      return defaults;
    } catch (e) {}
    return null;
  }

  function _jsonModelUri(model) {
    try {
      if (!model || !model.uri || typeof model.uri.toString !== 'function') return '';
      return String(model.uri.toString());
    } catch (e) {}
    return '';
  }

  function _jsonModelPath(model) {
    try {
      if (model && model.uri && typeof model.uri.path === 'string') return String(model.uri.path || '');
    } catch (e) {}
    return '';
  }

  function _basenamePath(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    if (!raw) return '';
    const parts = raw.split('/');
    return String(parts[parts.length - 1] || '');
  }

  function _schemaFileMatchPatternsForModel(model) {
    const patterns = [];
    const seen = new Set();
    const push = (value) => {
      const text = String(value || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      patterns.push(text);
    };

    const modelUri = _jsonModelUri(model);
    const modelPath = _jsonModelPath(model);
    const modelBase = _basenamePath(modelPath || modelUri);

    push(modelUri);
    push(modelPath);
    if (modelPath) {
      try { push(decodeURIComponent(modelPath)); } catch (e) {}
    }
    if (modelBase) {
      push(modelBase);
      push(`*/${modelBase}`);
      push(`**/${modelBase}`);
    }
    return patterns.length ? patterns : (modelUri ? [modelUri] : []);
  }

  function _supportsJsonSchemaOnModel(model) {
    try {
      if (!model || typeof model.getLanguageId !== 'function') return false;
      const languageId = String(model.getLanguageId() || '').toLowerCase();
      return languageId === 'json' || languageId === 'jsonc';
    } catch (e) {}
    return false;
  }

  function _schemaRegistrationUriForModel(modelUri) {
    return `xkeen://json-schema/${encodeURIComponent(String(modelUri || 'model'))}`;
  }

  function _applyManagedJsonDiagnostics(monaco) {
    try {
      const defaults = _getJsonDefaults(monaco);
      if (!defaults) return false;

      const current = (typeof defaults.diagnosticsOptions === 'function')
        ? (defaults.diagnosticsOptions() || {})
        : {};
      const externalSchemas = Array.isArray(current.schemas)
        ? current.schemas.filter((entry) => !String((entry && entry.uri) || '').startsWith('xkeen://json-schema/'))
        : [];
      const managedSchemas = Array.from(_state.jsonSchemasByModelUri.entries()).map(([modelUri, entry]) => ({
        uri: entry && entry.uri ? entry.uri : _schemaRegistrationUriForModel(modelUri),
        fileMatch: Array.isArray(entry && entry.fileMatch) && entry.fileMatch.length ? entry.fileMatch : [modelUri],
        schema: entry ? entry.schema : null,
      })).filter((entry) => !!(entry && entry.schema));

      defaults.setDiagnosticsOptions({
        ...(current || {}),
        validate: true,
        allowComments: true,
        trailingCommas: 'ignore',
        schemas: [...externalSchemas, ...managedSchemas],
      });
      return true;
    } catch (e) {}
    return false;
  }

  function _setModelJsonSchema(model, schema, monaco) {
    const modelUri = _jsonModelUri(model);
    if (!modelUri) return false;
    if (!_supportsJsonSchemaOnModel(model)) {
      _state.jsonSchemasByModelUri.delete(modelUri);
      try { _applyManagedJsonDiagnostics(monaco); } catch (e) {}
      return false;
    }
    if (schema && typeof schema === 'object') {
      _state.jsonSchemasByModelUri.set(modelUri, {
        uri: _schemaRegistrationUriForModel(modelUri),
        fileMatch: _schemaFileMatchPatternsForModel(model),
        schema,
      });
    } else {
      _state.jsonSchemasByModelUri.delete(modelUri);
    }
    try { _applyManagedJsonDiagnostics(monaco); } catch (e) {}
    return true;
  }

  function _getModelJsonSchema(model) {
    const modelUri = _jsonModelUri(model);
    if (!modelUri) return null;
    try {
      const entry = _state.jsonSchemasByModelUri.get(modelUri);
      return entry && entry.schema && typeof entry.schema === 'object' ? entry.schema : null;
    } catch (e) {}
    return null;
  }

  function _ensureJsonModeConfiguration(monaco) {
    try {
      const defaults = _getJsonDefaults(monaco);
      if (!defaults) return false;
      if (!_state.jsonModeConfigured && typeof defaults.setModeConfiguration === 'function') {
        defaults.setModeConfiguration({
          completionItems: true,
          diagnostics: true,
          documentFormattingEdits: true,
          documentRangeFormattingEdits: true,
          documentSymbols: true,
          foldingRanges: true,
          hovers: false,
          colors: true,
          selectionRanges: true,
          tokens: true,
        });
        _state.jsonModeConfigured = true;
      }
      return true;
    } catch (e) {}
    return false;
  }

  function _normalizeModelUri(monaco, rawUri, language) {
    if (!monaco || !monaco.Uri || typeof monaco.Uri.parse !== 'function') return null;
    const raw = String(rawUri || '').trim();
    if (raw) {
      try { return monaco.Uri.parse(raw); } catch (e) {}
      return null;
    }
    if (!_isJsonLanguage(language)) return null;
    try {
      const nextId = Math.max(1, Number(_state.nextModelId || 1));
      _state.nextModelId = nextId + 1;
      return monaco.Uri.parse(`xkeen://json/model-${nextId}.jsonc`);
    } catch (e) {}
    return null;
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

  function _isEditorHoverEnabled(opts, snapshot) {
    if (opts && opts.schemaHover === false) return false;
    if (opts && opts.schemaHoverEnabled === false) return false;
    try {
      const settings = snapshot && typeof snapshot === 'object'
        ? snapshot
        : ((_getSettingsApi() && typeof _getSettingsApi().get === 'function') ? _getSettingsApi().get() : null);
      const editor = (settings && settings.editor && typeof settings.editor === 'object') ? settings.editor : {};
      return editor.schemaHoverEnabled !== false;
    } catch (e) {
      return true;
    }
  }

  function _isBeginnerModeEnabled() {
    try {
      const api = _getSettingsApi();
      const settings = (api && typeof api.get === 'function') ? api.get() : null;
      const editor = (settings && settings.editor && typeof settings.editor === 'object') ? settings.editor : {};
      return editor.beginnerModeEnabled === true;
    } catch (e) {
      return false;
    }
  }

  function _resolveEditorHoverOptions(opts, snapshot) {
    const options = (opts && opts.hover && typeof opts.hover === 'object') ? { ...opts.hover } : {};
    if (opts && typeof opts.hoverEnabled === 'boolean') options.enabled = opts.hoverEnabled;
    if (typeof options.enabled !== 'boolean') options.enabled = _isEditorHoverEnabled(opts, snapshot);
    return options;
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

  function _getCustomContextMenuCleanup(editor) {
    if (!editor) return null;
    try {
      if (_state.customContextMenuCleanupByEditor) return _state.customContextMenuCleanupByEditor.get(editor) || null;
    } catch (e) {}
    try {
      return typeof editor[_CUSTOM_CONTEXT_MENU_CLEANUP_KEY] === 'function' ? editor[_CUSTOM_CONTEXT_MENU_CLEANUP_KEY] : null;
    } catch (e) {}
    return null;
  }

  function _setCustomContextMenuCleanup(editor, cleanup) {
    if (!editor) return;
    try {
      if (_state.customContextMenuCleanupByEditor) {
        if (typeof cleanup === 'function') _state.customContextMenuCleanupByEditor.set(editor, cleanup);
        else _state.customContextMenuCleanupByEditor.delete(editor);
        return;
      }
    } catch (e) {}
    try {
      if (typeof cleanup === 'function') editor[_CUSTOM_CONTEXT_MENU_CLEANUP_KEY] = cleanup;
      else delete editor[_CUSTOM_CONTEXT_MENU_CLEANUP_KEY];
    } catch (e) {}
  }

  function _defaultFormatMenuLabel(language) {
    const lang = _normalizeLanguage(language);
    if (lang === 'json' || lang === 'jsonc') return '\u0424\u043e\u0440\u043c\u0430\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c JSON';
    return '\u0424\u043e\u0440\u043c\u0430\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442';
  }

  function _normalizeMenuLabel(value, fallback) {
    const text = String(value ?? '').trim();
    return text || String(fallback || '');
  }

  function _normalizeCustomContextMenuOptions(opts, language) {
    const o = opts || {};
    const hasCustomMenu = Object.prototype.hasOwnProperty.call(o, 'customContextMenu');
    const raw = hasCustomMenu ? o.customContextMenu : null;
    if (raw === false) return { enabled: false };
    if (!hasCustomMenu && Object.prototype.hasOwnProperty.call(o, 'contextmenu') && o.contextmenu === false) {
      return { enabled: false };
    }
    const cfg = (raw && typeof raw === 'object') ? raw : {};
    return {
      enabled: true,
      labels: {
        goToSymbol: _normalizeMenuLabel(cfg.goToSymbolLabel, '\u041f\u0435\u0440\u0435\u0439\u0442\u0438 \u043a \u0441\u0438\u043c\u0432\u043e\u043b\u0443...'),
        changeAllOccurrences: _normalizeMenuLabel(cfg.changeAllOccurrencesLabel, '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u0432\u0441\u0435 \u0432\u0445\u043e\u0436\u0434\u0435\u043d\u0438\u044f'),
        cut: _normalizeMenuLabel(cfg.cutLabel, '\u0412\u044b\u0440\u0435\u0437\u0430\u0442\u044c'),
        copy: _normalizeMenuLabel(cfg.copyLabel, '\u041a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c'),
        paste: _normalizeMenuLabel(cfg.pasteLabel, '\u0412\u0441\u0442\u0430\u0432\u0438\u0442\u044c'),
        selectAll: _normalizeMenuLabel(cfg.selectAllLabel, '\u0412\u044b\u0434\u0435\u043b\u0438\u0442\u044c \u0432\u0441\u0451'),
        format: _normalizeMenuLabel(cfg.formatLabel, _defaultFormatMenuLabel(language)),
        commandPalette: _normalizeMenuLabel(cfg.commandPaletteLabel, '\u041f\u0430\u043b\u0438\u0442\u0440\u0430 \u043a\u043e\u043c\u0430\u043d\u0434'),
      },
      onFormatFallback: typeof cfg.onFormatFallback === 'function' ? cfg.onFormatFallback : null,
    };
  }

  function _customContextMenuItemHtml(action, label, shortcut) {
    const text = String(label || '');
    const hint = String(shortcut || '').trim();
    return [
      '<button type="button" class="xk-routing-monaco-menu-item" data-action="', String(action || ''), '">',
      '<span class="xk-routing-monaco-menu-label">', text, '</span>',
      hint ? '<span class="xk-routing-monaco-menu-shortcut">' + hint + '</span>' : '',
      '</button>',
    ].join('');
  }

  function _buildCustomContextMenuMarkup(cfg) {
    const labels = (cfg && cfg.labels) ? cfg.labels : {};
    return [
      _customContextMenuItemHtml('goToSymbol', labels.goToSymbol, 'Ctrl+Shift+O'),
      _customContextMenuItemHtml('changeAllOccurrences', labels.changeAllOccurrences, 'Ctrl+F2'),
      '<div class="xk-routing-monaco-menu-sep" role="separator"></div>',
      _customContextMenuItemHtml('cut', labels.cut, 'Ctrl+X'),
      _customContextMenuItemHtml('copy', labels.copy, 'Ctrl+C'),
      _customContextMenuItemHtml('paste', labels.paste, 'Ctrl+V'),
      '<div class="xk-routing-monaco-menu-sep" role="separator"></div>',
      _customContextMenuItemHtml('selectAll', labels.selectAll, 'Ctrl+A'),
      _customContextMenuItemHtml('format', labels.format, 'Shift+Alt+F'),
      '<div class="xk-routing-monaco-menu-sep" role="separator"></div>',
      _customContextMenuItemHtml('commandPalette', labels.commandPalette, 'F1'),
    ].join('');
  }

  function hideCustomContextMenu() {
    const menu = _state.customContextMenuEl;
    _state.customContextMenuCtx = null;
    if (!menu) return;
    try { menu.hidden = true; } catch (e) {}
    try { menu.classList.remove('is-open'); } catch (e) {}
    try { menu.style.removeProperty('left'); } catch (e) {}
    try { menu.style.removeProperty('top'); } catch (e) {}
  }

  async function _handleCustomContextMenuAction(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
    if (!btn || btn.disabled) return;
    try { ev.preventDefault(); } catch (e) {}
    try { ev.stopPropagation(); } catch (e) {}
    const action = String(btn.dataset.action || '');
    const ctx = _state.customContextMenuCtx;
    hideCustomContextMenu();
    if (!ctx || !ctx.editor) return;
    try {
      await runCustomContextMenuAction(ctx.editor, action, ctx.options || null);
    } catch (e) {}
  }

  function ensureCustomContextMenuDom(cfg) {
    let menu = _state.customContextMenuEl;
    if (!menu || !menu.isConnected) {
      menu = document.createElement('div');
      menu.className = 'xk-routing-monaco-menu';
      menu.hidden = true;
      menu.addEventListener('pointerdown', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
        if (btn) {
          _handleCustomContextMenuAction(ev);
          return;
        }
        try { ev.stopPropagation(); } catch (e) {}
      });
      menu.addEventListener('mousedown', (ev) => {
        try { ev.stopPropagation(); } catch (e) {}
      });
      menu.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
        if (!btn) return;
        try { ev.preventDefault(); } catch (e) {}
        try { ev.stopPropagation(); } catch (e) {}
      });
      menu.addEventListener('contextmenu', (ev) => {
        try { ev.preventDefault(); } catch (e) {}
        try { ev.stopPropagation(); } catch (e) {}
      });
      document.body.appendChild(menu);
      _state.customContextMenuEl = menu;
    }
    menu.innerHTML = _buildCustomContextMenuMarkup(cfg || _normalizeCustomContextMenuOptions({}, 'plaintext'));
    return menu;
  }

  function _getCustomContextMenuAction(editor, actionId) {
    try {
      if (!editor || typeof editor.getAction !== 'function') return null;
      const action = editor.getAction(String(actionId || ''));
      if (!action || typeof action.run !== 'function') return null;
      return action;
    } catch (e) {}
    return null;
  }

  function _isCustomContextMenuActionSupported(editor, actionId) {
    const action = _getCustomContextMenuAction(editor, actionId);
    if (!action) return false;
    try {
      if (typeof action.isSupported === 'function') return !!action.isSupported();
    } catch (e) {}
    try {
      if (typeof action.isEnabled === 'function') return !!action.isEnabled();
    } catch (e) {}
    return true;
  }

  async function _runCustomContextMenuEditorAction(editor, actionId) {
    const action = _getCustomContextMenuAction(editor, actionId);
    if (!action) return false;
    try {
      if (typeof action.isSupported === 'function' && !action.isSupported()) return false;
    } catch (e) {}
    try {
      await action.run();
      return true;
    } catch (e) {}
    return false;
  }

  function _getCustomContextMenuSelections(editor) {
    if (!editor) return [];
    try {
      if (typeof editor.getSelections === 'function') {
        const ranges = editor.getSelections();
        if (Array.isArray(ranges) && ranges.length) return ranges.filter(Boolean);
      }
    } catch (e) {}
    try {
      if (typeof editor.getSelection === 'function') {
        const range = editor.getSelection();
        if (range) return [range];
      }
    } catch (e) {}
    return [];
  }

  function _getCustomContextMenuSelectionText(editor) {
    if (!editor) return '';
    try {
      const model = (typeof editor.getModel === 'function') ? editor.getModel() : null;
      if (!model || typeof model.getValueInRange !== 'function') return '';
      const selections = _getCustomContextMenuSelections(editor);
      if (!selections.length) return '';
      return selections.map((range) => {
        try { return String(model.getValueInRange(range) || ''); } catch (e) { return ''; }
      }).join('\n');
    } catch (e) {}
    return '';
  }

  function _isCustomContextMenuReadOnly(editor) {
    try {
      const monacoApi = window.monaco || null;
      const readOnlyOption = monacoApi && monacoApi.editor && monacoApi.editor.EditorOption
        ? monacoApi.editor.EditorOption.readOnly
        : null;
      if (editor && typeof editor.getOption === 'function' && readOnlyOption != null) {
        return !!editor.getOption(readOnlyOption);
      }
    } catch (e) {}
    try {
      if (editor && typeof editor.getRawOptions === 'function') {
        const raw = editor.getRawOptions();
        if (raw && Object.prototype.hasOwnProperty.call(raw, 'readOnly')) return !!raw.readOnly;
      }
    } catch (e) {}
    return false;
  }

  function _execCustomContextMenuEdits(editor, edits, source) {
    if (!editor || !Array.isArray(edits) || !edits.length) return false;
    try {
      if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
    } catch (e) {}
    try {
      if (typeof editor.executeEdits === 'function') {
        editor.executeEdits(String(source || 'xk-monaco-menu'), edits);
        try { if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop(); } catch (e2) {}
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function _writeCustomContextMenuClipboardText(text) {
    const value = String(text ?? '');
    _state.customContextMenuClipboardShadow = value;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) {}

    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = !!document.execCommand('copy');
      try { document.body.removeChild(ta); } catch (e) {}
      return ok;
    } catch (e) {}
    return false;
  }

  async function _readCustomContextMenuClipboardText() {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const value = await navigator.clipboard.readText();
        if (typeof value === 'string') {
          _state.customContextMenuClipboardShadow = value;
          return value;
        }
      }
    } catch (e) {}
    return String(_state.customContextMenuClipboardShadow || '');
  }

  async function runCustomContextMenuAction(editor, action, cfg) {
    if (!editor) return false;
    try { if (typeof editor.focus === 'function') editor.focus(); } catch (e) {}

    const selections = _getCustomContextMenuSelections(editor);
    const hasSelection = selections.some((range) => {
      try { return !!range && !(range.isEmpty && range.isEmpty()); } catch (e) { return false; }
    });

    if (action === 'copy') {
      const selectedText = _getCustomContextMenuSelectionText(editor);
      if (!selectedText) return false;
      await _writeCustomContextMenuClipboardText(selectedText);
      return true;
    }

    if (action === 'cut') {
      if (_isCustomContextMenuReadOnly(editor) || !hasSelection) return false;
      const selectedText = _getCustomContextMenuSelectionText(editor);
      if (!selectedText) return false;
      await _writeCustomContextMenuClipboardText(selectedText);
      return _execCustomContextMenuEdits(editor, selections.map((range) => ({ range, text: '', forceMoveMarkers: true })), 'xk-monaco-menu-cut');
    }

    if (action === 'paste') {
      if (_isCustomContextMenuReadOnly(editor)) return false;
      const value = await _readCustomContextMenuClipboardText();
      if (typeof value !== 'string') return false;
      const targetSelections = selections.length ? selections : _getCustomContextMenuSelections(editor);
      if (!targetSelections.length) return false;
      return _execCustomContextMenuEdits(editor, targetSelections.map((range) => ({ range, text: value, forceMoveMarkers: true })), 'xk-monaco-menu-paste');
    }

    if (action === 'goToSymbol') return _runCustomContextMenuEditorAction(editor, 'editor.action.quickOutline');

    if (action === 'changeAllOccurrences') {
      if (_isCustomContextMenuReadOnly(editor)) return false;
      return _runCustomContextMenuEditorAction(editor, 'editor.action.changeAll');
    }

    if (action === 'selectAll') {
      if (await _runCustomContextMenuEditorAction(editor, 'editor.action.selectAll')) return true;
      try {
        const model = (typeof editor.getModel === 'function') ? editor.getModel() : null;
        if (model && typeof editor.setSelection === 'function' && typeof model.getFullModelRange === 'function') {
          editor.setSelection(model.getFullModelRange());
          return true;
        }
      } catch (e) {}
      return false;
    }

    if (action === 'format') {
      if (_isCustomContextMenuReadOnly(editor)) return false;
      if (await _runCustomContextMenuEditorAction(editor, 'editor.action.formatDocument')) return true;
      if (cfg && typeof cfg.onFormatFallback === 'function') {
        try {
          return (await cfg.onFormatFallback(editor)) !== false;
        } catch (e) {}
      }
      return false;
    }

    if (action === 'commandPalette') return _runCustomContextMenuEditorAction(editor, 'editor.action.quickCommand');

    return false;
  }

  function _updateCustomContextMenuState(editor, cfg) {
    const menu = ensureCustomContextMenuDom(cfg);
    const hasSelection = !!_getCustomContextMenuSelectionText(editor);
    const readOnly = _isCustomContextMenuReadOnly(editor);
    const items = Array.from(menu.querySelectorAll('button[data-action]'));
    items.forEach((btn) => {
      const action = String(btn.dataset.action || '');
      let disabled = false;
      if (action === 'copy' || action === 'cut') disabled = !hasSelection;
      if ((action === 'cut' || action === 'paste' || action === 'format' || action === 'changeAllOccurrences') && readOnly) disabled = true;
      if (action === 'goToSymbol') disabled = !_isCustomContextMenuActionSupported(editor, 'editor.action.quickOutline');
      if (action === 'changeAllOccurrences') disabled = disabled || !_isCustomContextMenuActionSupported(editor, 'editor.action.changeAll');
      if (action === 'format') disabled = disabled || (!_isCustomContextMenuActionSupported(editor, 'editor.action.formatDocument') && !(cfg && typeof cfg.onFormatFallback === 'function'));
      if (action === 'commandPalette') disabled = !_isCustomContextMenuActionSupported(editor, 'editor.action.quickCommand');
      btn.disabled = disabled;
    });
  }

  function showCustomContextMenu(editor, ev, cfg) {
    if (!editor || !ev) return;
    const menu = ensureCustomContextMenuDom(cfg);
    _state.customContextMenuCtx = { editor, options: cfg || null };
    _updateCustomContextMenuState(editor, cfg);
    menu.hidden = false;
    menu.classList.add('is-open');
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const vw = Math.max(320, window.innerWidth || 0);
    const vh = Math.max(240, window.innerHeight || 0);
    const left = Math.max(8, Math.min((ev.clientX || 0), vw - rect.width - 8));
    const top = Math.max(8, Math.min((ev.clientY || 0), vh - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function _shouldBypassCustomContextMenuTarget(target) {
    const el = target && target.nodeType === 3 ? target.parentElement : target;
    if (!el || typeof el.closest !== 'function') return false;
    if (el.closest('.xk-routing-monaco-menu')) return true;
    if (el.closest('.quick-input-widget, .context-view, .rename-box, .rename-input, .monaco-inputbox, .monaco-findInput, .find-widget')) return true;
    const input = el.closest('input, textarea, select, [contenteditable="true"]');
    if (!input) return false;
    try {
      if (input.classList && input.classList.contains('inputarea')) return false;
    } catch (e) {}
    return true;
  }

  function uninstallCustomContextMenu(editor) {
    const cleanup = _getCustomContextMenuCleanup(editor);
    if (typeof cleanup !== 'function') return;
    try { cleanup(); } catch (e) {}
    _setCustomContextMenuCleanup(editor, null);
    if (_state.customContextMenuCtx && _state.customContextMenuCtx.editor === editor) hideCustomContextMenu();
  }

  function installCustomContextMenu(editor, host, opts) {
    uninstallCustomContextMenu(editor);
    const cfg = _normalizeCustomContextMenuOptions(opts, (opts && opts.language) || 'plaintext');
    if (!editor || !host || !cfg.enabled) return null;

    const onContextMenu = (ev) => {
      if (_shouldBypassCustomContextMenuTarget(ev ? ev.target : null)) return;
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}
      try { if (typeof editor.focus === 'function') editor.focus(); } catch (e) {}
      showCustomContextMenu(editor, ev, cfg);
    };
    const hide = () => { hideCustomContextMenu(); };
    const onDocumentMouseDown = (ev) => {
      const menu = _state.customContextMenuEl;
      if (menu) {
        try {
          const path = ev && typeof ev.composedPath === 'function' ? ev.composedPath() : null;
          if (Array.isArray(path) && path.includes(menu)) return;
        } catch (e) {}
        if (ev && ev.target && typeof menu.contains === 'function' && menu.contains(ev.target)) return;
      }
      hide();
    };
    const onKeyDown = (ev) => {
      if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) hide();
    };
    const cleanup = () => {
      try { host.removeEventListener('contextmenu', onContextMenu, true); } catch (e) {}
      try { document.removeEventListener('mousedown', onDocumentMouseDown, true); } catch (e) {}
      try { document.removeEventListener('scroll', hide, true); } catch (e) {}
      try { window.removeEventListener('resize', hide, true); } catch (e) {}
      try { window.removeEventListener('blur', hide, true); } catch (e) {}
      try { document.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
    };

    host.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide, true);
    window.addEventListener('blur', hide, true);
    document.addEventListener('keydown', onKeyDown, true);
    _setCustomContextMenuCleanup(editor, cleanup);

    try {
      if (editor && typeof editor.onDidDispose === 'function') {
        editor.onDidDispose(() => {
          uninstallCustomContextMenu(editor);
        });
      }
    } catch (e) {}

    return cleanup;
  }

  function _setModelYamlAssist(model, assist) {
    if (!model) return;
    if (_state.yamlAssistByModel) {
      try {
        if (assist) _state.yamlAssistByModel.set(model, assist);
        else _state.yamlAssistByModel.delete(model);
        return;
      } catch (e) {}
    }
    try {
      if (assist) model.__xkYamlAssist = assist;
      else delete model.__xkYamlAssist;
    } catch (e) {}
  }

  function _getModelYamlAssist(model) {
    if (!model) return null;
    if (_state.yamlAssistByModel) {
      try { return _state.yamlAssistByModel.get(model) || null; } catch (e) {}
    }
    try { return model.__xkYamlAssist || null; } catch (e) {}
    return null;
  }

  function _resolveYamlAssistSchema(assist) {
    if (!assist) return null;
    try {
      if (typeof assist.getSchema === 'function') return assist.getSchema() || null;
    } catch (e) {}
    try {
      if (assist && typeof assist === 'object' && assist.schema) return assist.schema;
    } catch (e) {}
    return null;
  }

  function _monacoCompletionKind(monaco, item) {
    try {
      if (item && item.type === 'property') return monaco.languages.CompletionItemKind.Field;
      if (item && item.type === 'snippet') return monaco.languages.CompletionItemKind.Snippet;
      return monaco.languages.CompletionItemKind.Value;
    } catch (e) {}
    return 12;
  }

  function _setModelSnippetProvider(model, provider) {
    if (!model) return;
    if (_state.snippetProvidersByModel) {
      try {
        if (provider) _state.snippetProvidersByModel.set(model, provider);
        else _state.snippetProvidersByModel.delete(model);
        return;
      } catch (e) {}
    }
    try {
      if (provider) model.__xkSnippetProvider = provider;
      else delete model.__xkSnippetProvider;
    } catch (e) {}
  }

  function _getModelSnippetProvider(model) {
    if (!model) return null;
    if (_state.snippetProvidersByModel) {
      try { return _state.snippetProvidersByModel.get(model) || null; } catch (e) {}
    }
    try { return model.__xkSnippetProvider || null; } catch (e) {}
    return null;
  }

  function _setModelQuickFixProvider(model, provider) {
    if (!model) return;
    if (_state.quickFixProvidersByModel) {
      try {
        if (provider) _state.quickFixProvidersByModel.set(model, provider);
        else _state.quickFixProvidersByModel.delete(model);
        return;
      } catch (e) {}
    }
    try {
      if (provider) model.__xkQuickFixProvider = provider;
      else delete model.__xkQuickFixProvider;
    } catch (e) {}
  }

  function _getModelQuickFixProvider(model) {
    if (!model) return null;
    if (_state.quickFixProvidersByModel) {
      try { return _state.quickFixProvidersByModel.get(model) || null; } catch (e) {}
    }
    try { return model.__xkQuickFixProvider || null; } catch (e) {}
    return null;
  }

  function _resolveJsoncPointerAtOffset(text, offset) {
    try {
      const map = buildJsoncPointerMap(String(text || ''));
      if (!map || typeof map.forEach !== 'function') return '';
      const safeOffset = Math.max(0, Number(offset || 0));
      let bestPointer = '';
      let bestSpan = Infinity;
      map.forEach((range, pointer) => {
        const from = Math.max(0, Number(range && range.valueFrom || 0));
        const to = Math.max(from, Number(range && range.valueTo || from));
        if (safeOffset < from || safeOffset > to) return;
        const span = to - from;
        if (span < bestSpan) {
          bestSpan = span;
          bestPointer = String(pointer || '');
        }
      });
      return bestPointer;
    } catch (e) {}
    return '';
  }

  function _invokeJsonSnippetProvider(provider, model, position) {
    if (!provider || !model || typeof model.getOffsetAt !== 'function') return [];
    let text = '';
    try { text = model.getValue() || ''; } catch (e) { text = ''; }
    let offset = 0;
    try { offset = model.getOffsetAt(position); } catch (e) { offset = 0; }
    const pointer = _resolveJsoncPointerAtOffset(text, offset);
    let snippets = null;
    try {
      const fn = typeof provider === 'function'
        ? provider
        : (provider && typeof provider.getSnippets === 'function' ? (ctx) => provider.getSnippets(ctx) : null);
      if (!fn) return [];
      snippets = fn({ text, offset, pointer, model, position, language: 'json' });
    } catch (e) {
      snippets = null;
    }
    return Array.isArray(snippets) ? snippets : [];
  }

  function _resolveQuickFixGetter(provider) {
    if (!provider) return null;
    if (typeof provider === 'function') return provider;
    if (provider && typeof provider.getQuickFixes === 'function') {
      return (ctx) => provider.getQuickFixes(ctx);
    }
    return null;
  }

  function _offsetRangeForModel(monaco, model, from, to) {
    const safeFrom = Math.max(0, Number(from || 0));
    const safeTo = Math.max(safeFrom, Number(to || safeFrom));
    const start = model.getPositionAt(safeFrom);
    const end = model.getPositionAt(safeTo);
    return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
  }

  function _buildQuickFixWorkspaceEdits(monaco, model, fix) {
    if (!monaco || !model || !fix || !Array.isArray(fix.edits) || !fix.edits.length) return [];
    return fix.edits.map((item) => ({
      resource: model.uri,
      versionId: (typeof model.getVersionId === 'function') ? model.getVersionId() : undefined,
      textEdit: {
        range: _offsetRangeForModel(monaco, model, item.from, item.to),
        text: item.insert || '',
      },
    }));
  }

  function _getQuickFixesForModel(model, ctx) {
    const provider = _getModelQuickFixProvider(model);
    const getter = _resolveQuickFixGetter(provider);
    if (!getter || !model) return [];
    let text = '';
    try { text = model.getValue() || ''; } catch (e) { text = ''; }
    const language = (() => {
      try { return model.getLanguageId ? model.getLanguageId() : ''; } catch (e) {}
      return '';
    })();
    const schema = _getModelJsonSchema(model);
    const yamlAssist = _getModelYamlAssist(model);
    let offset = Number.isFinite(ctx && ctx.offset) ? Number(ctx.offset) : NaN;
    if (!Number.isFinite(offset)) {
      try {
        if (ctx && ctx.position && typeof model.getOffsetAt === 'function') offset = model.getOffsetAt(ctx.position);
      } catch (e) {
        offset = NaN;
      }
    }
    try {
      const list = getter({
        ...(ctx || {}),
        text,
        model,
        language,
        schema,
        yamlAssist,
        offset,
      });
      return Array.isArray(list) ? list : [];
    } catch (e) {}
    return [];
  }

  function _ensureYamlAssistProviders(monaco) {
    if (!monaco || !monaco.languages || _state.yamlAssistProvidersInstalled) return;

    monaco.languages.registerCompletionItemProvider('yaml', {
      triggerCharacters: [':', '-', ' '],
      provideCompletionItems(model, position) {
        const assist = _getModelYamlAssist(model);
        const schema = _resolveYamlAssistSchema(assist);
        if (!schema || !model || typeof model.getOffsetAt !== 'function') return { suggestions: [] };

        const snippetProvider = _getModelSnippetProvider(model) || (assist && assist.snippetProvider) || null;
        const result = completeYamlTextFromSchema(model.getValue(), schema, {
          offset: model.getOffsetAt(position),
          snippetProvider,
        });
        if (!result || !Array.isArray(result.options) || !result.options.length) return { suggestions: [] };

        const start = model.getPositionAt(Math.max(0, Number(result.from || 0)));
        const end = model.getPositionAt(Math.max(0, Number(result.to || result.from || 0)));
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

        return {
          suggestions: result.options.map((item, index) => {
            const isSnippet = item.type === 'snippet';
            const insertText = isSnippet
              ? (item.monacoSnippet || item.insertText || item.label)
              : (item.insertText || item.label);
            const base = {
              label: item.label,
              kind: _monacoCompletionKind(monaco, item),
              insertText,
              detail: item.detail || '',
              documentation: item.documentation && item.documentation.markdown
                ? { value: item.documentation.markdown }
                : (item.documentation && item.documentation.plain ? item.documentation.plain : ''),
              range,
              sortText: `${isSnippet ? '9' : (item.type === 'property' ? '0' : '1')}-${String(index).padStart(4, '0')}-${item.label}`,
              filterText: item.label,
            };
            if (isSnippet) {
              try {
                base.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
              } catch (e) {}
            }
            return base;
          }),
        };
      },
    });

    monaco.languages.registerHoverProvider('yaml', {
      provideHover(model, position) {
        if (!_isEditorHoverEnabled()) return null;
        const assist = _getModelYamlAssist(model);
        const schema = _resolveYamlAssistSchema(assist);
        if (!schema || !model || typeof model.getOffsetAt !== 'function') return null;
        const result = hoverYamlTextFromSchema(model.getValue(), schema, {
          offset: model.getOffsetAt(position),
          beginnerMode: _isBeginnerModeEnabled(),
        });
        if (!result || !result.markdown) return null;
        const start = model.getPositionAt(Math.max(0, Number(result.from || 0)));
        const end = model.getPositionAt(Math.max(0, Number(result.to || result.from || 0)));
        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          contents: [{ value: result.markdown }],
        };
      },
    });

    _state.yamlAssistProvidersInstalled = true;
  }

  function _ensureJsonSnippetProviders(monaco) {
    if (!monaco || !monaco.languages || _state.jsonSnippetProvidersInstalled) return;

    const provider = {
      triggerCharacters: ['/', '"', ' ', ','],
      provideCompletionItems(model, position) {
        if (!_supportsJsonSchemaOnModel(model) || !model || typeof model.getOffsetAt !== 'function') {
          return { suggestions: [] };
        }
        const snippetProvider = _getModelSnippetProvider(model);
        if (!snippetProvider) return { suggestions: [] };

        const snippets = _invokeJsonSnippetProvider(snippetProvider, model, position);
        if (!snippets.length) return { suggestions: [] };

        const offset = (() => { try { return model.getOffsetAt(position); } catch (e) { return 0; } })();
        const start = model.getPositionAt(offset);
        const end = model.getPositionAt(offset);
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

        const suggestions = snippets
          .filter((item) => item && item.label && (item.insertText || item.monacoSnippet))
          .map((item, index) => {
            const insertText = item.monacoSnippet || item.insertText || '';
            const docParts = [];
            if (item.documentation) docParts.push(String(item.documentation));
            if (item.warning) docParts.push(`⚠ ${String(item.warning)}`);
            const docValue = docParts.join('\n\n');
            return {
              label: `📦 ${String(item.label)}`,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: String(item.detail || 'snippet'),
              documentation: docValue ? { value: docValue } : '',
              range,
              sortText: `9-${String(index).padStart(4, '0')}-${item.label}`,
              filterText: `snippet ${item.label}`,
            };
          });
        return { suggestions };
      },
    };
    try { monaco.languages.registerCompletionItemProvider('json', provider); } catch (e) {}
    try { monaco.languages.registerCompletionItemProvider('jsonc', provider); } catch (e) {}
    _state.jsonSnippetProvidersInstalled = true;
  }

  function _ensureJsonHoverProviders(monaco) {
    if (!monaco || !monaco.languages || _state.jsonHoverProvidersInstalled) return;

    monaco.languages.registerHoverProvider('json', {
      provideHover(model, position) {
        if (!_isEditorHoverEnabled()) return null;
        if (!_supportsJsonSchemaOnModel(model) || !model || typeof model.getOffsetAt !== 'function') return null;
        const schema = _getModelJsonSchema(model);
        if (!schema) return null;

        const result = buildJsonSchemaHoverInfo(model.getValue(), schema, model.getOffsetAt(position), {
          beginnerMode: _isBeginnerModeEnabled(),
        });
        if (!result || !result.markdown) return null;

        const start = model.getPositionAt(Math.max(0, Number(result.from || 0)));
        const end = model.getPositionAt(Math.max(0, Number(result.to || result.from || 0)));
        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          contents: [{ value: result.markdown }],
        };
      },
    });

    _state.jsonHoverProvidersInstalled = true;
  }

  function _ensureQuickFixProviders(monaco) {
    if (!monaco || !monaco.languages || _state.quickFixProvidersInstalled) return;
    const kind = (monaco.languages.CodeActionKind && monaco.languages.CodeActionKind.QuickFix)
      ? monaco.languages.CodeActionKind.QuickFix
      : 'quickfix';
    const provider = {
      providedCodeActionKinds: [kind],
      provideCodeActions(model, range) {
        if (!model || typeof model.getOffsetAt !== 'function') return { actions: [], dispose() {} };
        const position = {
          lineNumber: Math.max(1, Number(range && range.startLineNumber || 1)),
          column: Math.max(1, Number(range && range.startColumn || 1)),
        };
        const fixes = _getQuickFixesForModel(model, { position });
        if (!fixes.length) return { actions: [], dispose() {} };
        const actions = fixes.map((fix) => ({
          title: fix.title || 'Исправить',
          kind,
          isPreferred: !!fix.isPreferred,
          edit: { edits: _buildQuickFixWorkspaceEdits(monaco, model, fix) },
        })).filter((item) => item && item.edit && Array.isArray(item.edit.edits) && item.edit.edits.length);
        return { actions, dispose() {} };
      },
    };
    try { monaco.languages.registerCodeActionProvider('json', provider); } catch (e) {}
    try { monaco.languages.registerCodeActionProvider('jsonc', provider); } catch (e) {}
    try { monaco.languages.registerCodeActionProvider('yaml', provider); } catch (e) {}
    _state.quickFixProvidersInstalled = true;
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
    const customContextMenu = _normalizeCustomContextMenuOptions(o, language);
    const useCustomContextMenu = !!customContextMenu.enabled;

    try {
      const monaco = await _ensureMonaco();
      // If caller requests JSON-with-comments, enable it for Monaco JSON diagnostics.
      try {
        if (o.allowComments || reqLangRaw === 'jsonc') _maybeEnableJsonComments(monaco);
        if (_isJsonLanguage(language)) _ensureJsonModeConfiguration(monaco);
      } catch (e) {}
      // Ensure the requested language is registered (best-effort).
      try { await _ensureLanguage(monaco, language); } catch (e) {}
      try { _ensureJsonHoverProviders(monaco); } catch (e) {}
      try { _ensureJsonSnippetProviders(monaco); } catch (e) {}
      try { _ensureYamlAssistProviders(monaco); } catch (e) {}
      try { _ensureQuickFixProviders(monaco); } catch (e) {}
      try { applyTheme(monaco); } catch (e) {}
      try { wireThemeSync(monaco); } catch (e) {}

      const typo = _editorTypographyOpts((_getSettingsApi() && typeof _getSettingsApi().get === 'function') ? _getSettingsApi().get() : null);
      const runtimeLanguage = _isLanguageRegistered(monaco, language) ? _runtimeLanguageId(language) : 'plaintext';
      const explicitModelUri = _normalizeModelUri(monaco, o.uri || o.modelUri || '', language);
      let ownedModel = null;
      let model = null;
      let currentSchema = (o.schema && typeof o.schema === 'object') ? o.schema : null;

      try {
        if (explicitModelUri && monaco.editor && typeof monaco.editor.getModel === 'function') {
          model = monaco.editor.getModel(explicitModelUri) || null;
        }
      } catch (e) {}

      try {
        if (model && typeof model.getValue === 'function' && typeof model.setValue === 'function' && model.getValue() !== value) {
          model.setValue(value);
        }
      } catch (e) {}

      try {
        if (!model && explicitModelUri && monaco.editor && typeof monaco.editor.createModel === 'function') {
          model = monaco.editor.createModel(value, runtimeLanguage, explicitModelUri);
          ownedModel = model;
        }
      } catch (e) {}

      const editor = monaco.editor.create(el, {
        ...(model ? { model } : { value }),
        readOnly,
        contextmenu: useCustomContextMenu ? false : ((typeof o.contextmenu === 'boolean') ? o.contextmenu : true),
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
        hover: _resolveEditorHoverOptions(o),
        smoothScrolling: false,
        cursorSmoothCaretAnimation: 'off',
        tabSize: (typeof o.tabSize === 'number') ? o.tabSize : 2,
        insertSpaces: (typeof o.insertSpaces === 'boolean') ? o.insertSpaces : true,
        fontFamily: o.fontFamily || typo.fontFamily,
        fontSize: (typeof o.fontSize === 'number') ? o.fontSize : typo.fontSize,
        lineHeight: (typeof o.lineHeight === 'number') ? o.lineHeight : typo.lineHeight,
      });

      model = editor && typeof editor.getModel === 'function' ? editor.getModel() : model;

      // Apply language to the model explicitly (Monaco may ignore unknown option fields).
      try {
        if (model && monaco.editor && monaco.editor.setModelLanguage && language && language !== 'plaintext') {
          monaco.editor.setModelLanguage(model, runtimeLanguage);
        }
        if (model) _setModelYamlAssist(model, (language === 'yaml' && o.yamlAssist) ? o.yamlAssist : null);
        if (model) _setModelSnippetProvider(model, o.snippetProvider || null);
        if (model) _setModelQuickFixProvider(model, o.quickFixProvider || null);
      } catch (e) {}
      try {
        if (model && o.schema) _setModelJsonSchema(model, o.schema, monaco);
      } catch (e) {}
      try {
        if (editor) {
          editor.setSchema = (schema) => {
            if (!model) return false;
            currentSchema = (schema && typeof schema === 'object') ? schema : null;
            return _setModelJsonSchema(model, currentSchema, monaco);
          };
          editor.getSchema = () => currentSchema || null;
          editor.setSnippetProvider = (provider) => {
            if (!model) return false;
            _setModelSnippetProvider(model, provider || null);
            return true;
          };
          editor.getSnippetProvider = () => (model ? _getModelSnippetProvider(model) : null);
          editor.setQuickFixProvider = (provider) => {
            if (!model) return false;
            _setModelQuickFixProvider(model, provider || null);
            return true;
          };
          editor.getQuickFixProvider = () => (model ? _getModelQuickFixProvider(model) : null);
          editor.getQuickFixes = (request) => {
            if (!model) return [];
            const req = request && typeof request === 'object' ? { ...request } : {};
            if (!req.position) {
              try {
                if (typeof editor.getPosition === 'function') req.position = editor.getPosition();
              } catch (e) {}
            }
            return _getQuickFixesForModel(model, req);
          };
          editor.applyQuickFix = (fix) => {
            if (!model || !fix) return false;
            const edits = _buildQuickFixWorkspaceEdits(monaco, model, fix);
            if (!edits.length) return false;
            try {
              const operations = edits.map((item) => ({
                range: item.textEdit.range,
                text: item.textEdit.text,
              }));
              editor.pushUndoStop();
              editor.executeEdits('xkeen-quickfix', operations);
              editor.pushUndoStop();
              return true;
            } catch (e) {}
            return false;
          };
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

      // React to UI settings changes (editor font scale and hover hints) unless caller explicitly overrides typography.
      try {
        const settingsApi = _getSettingsApi();
        const manageFontFamily = !o.fontFamily;
        const manageFontSize = typeof o.fontSize !== 'number';
        const manageLineHeight = typeof o.lineHeight !== 'number';
        if (settingsApi && typeof settingsApi.subscribe === 'function') {
          const applyManagedUiSettings = (snapshot) => {
            try {
              const patch = {};
              if (manageFontFamily || manageFontSize || manageLineHeight) {
                const nextTypo = _editorTypographyOpts(snapshot);
                if (manageFontFamily) patch.fontFamily = nextTypo.fontFamily;
                if (manageFontSize) patch.fontSize = nextTypo.fontSize;
                if (manageLineHeight) patch.lineHeight = nextTypo.lineHeight;
              }
              patch.hover = _resolveEditorHoverOptions(o, snapshot);
              if (Object.keys(patch).length && editor && typeof editor.updateOptions === 'function') {
                editor.updateOptions(patch);
                try {
                  if ((manageFontFamily || manageFontSize || manageLineHeight) && editor.layout) editor.layout();
                } catch (e2) {}
              }
            } catch (e2) {}
          };
          const unsubscribeUiSettings = settingsApi.subscribe((nextSnapshot) => {
            applyManagedUiSettings(nextSnapshot);
          });
          if (editor && typeof editor.onDidDispose === 'function') {
            editor.onDidDispose(() => {
              try { unsubscribeUiSettings(); } catch (e2) {}
              try { if (model) _setModelYamlAssist(model, null); } catch (e3) {}
              try { if (model) _setModelSnippetProvider(model, null); } catch (e3b) {}
              try { if (model) _setModelQuickFixProvider(model, null); } catch (e3c) {}
              try { if (model) _setModelJsonSchema(model, null, monaco); } catch (e4) {}
              try { if (ownedModel && typeof ownedModel.dispose === 'function') ownedModel.dispose(); } catch (e5) {}
            });
          }
        }
      } catch (e) {}

      try {
        if (useCustomContextMenu) {
          installCustomContextMenu(editor, el, o);
        }
      } catch (e) {
        try {
          if (editor && typeof editor.updateOptions === 'function') editor.updateOptions({ contextmenu: true });
        } catch (e2) {}
      }

      try {
        if (editor && typeof editor.onDidDispose === 'function') {
          editor.onDidDispose(() => {
          try { if (model) _setModelYamlAssist(model, null); } catch (e2) {}
          try { if (model) _setModelSnippetProvider(model, null); } catch (e2b) {}
          try { if (model) _setModelQuickFixProvider(model, null); } catch (e2c) {}
          try { if (model) _setModelJsonSchema(model, null, monaco); } catch (e3) {}
          try { if (ownedModel && typeof ownedModel.dispose === 'function') ownedModel.dispose(); } catch (e4) {}
        });
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
    hideCustomContextMenu,
    installCustomContextMenu,
    layoutOnVisible,
    toFacade,
    uninstallCustomContextMenu,
    setModelSnippetProvider(model, provider) {
      _setModelSnippetProvider(model, provider || null);
      return true;
    },
    getModelSnippetProvider(model) {
      return _getModelSnippetProvider(model);
    },
    setQuickFixProvider(editor, provider) {
      const target = editor && editor.raw ? editor.raw : editor;
      try { if (target && typeof target.setQuickFixProvider === 'function') return target.setQuickFixProvider(provider || null); } catch (e) {}
      const model = target && typeof target.getModel === 'function' ? target.getModel() : null;
      if (!model) return false;
      _setModelQuickFixProvider(model, provider || null);
      return true;
    },
    getQuickFixProvider(editor) {
      const target = editor && editor.raw ? editor.raw : editor;
      try { if (target && typeof target.getQuickFixProvider === 'function') return target.getQuickFixProvider(); } catch (e) {}
      const model = target && typeof target.getModel === 'function' ? target.getModel() : null;
      return model ? _getModelQuickFixProvider(model) : null;
    },
  };
})();
