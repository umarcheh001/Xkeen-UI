let routingModuleApi = null;

import { getRoutingShellApi as getRoutingShellModuleApi } from './routing_shell.js';
import { getRoutingCardsApi as getRoutingCardsModuleApi } from './routing_cards.js';
import { getBackupsApi as getBackupsModuleApi } from './backups.js';
import {
  confirmXkeenAction,
  getXkeenCm6RuntimeApi,
  getXkeenCommandJobApi,
  getXkeenConfigDirtyApi,
  getXkeenCoreHttpApi,
  getXkeenCoreStorageApi,
  attachXkeenEditorToolbar,
  buildXkeenEditorCommonKeys,
  getXkeenEditorEngineApi,
  getXkeenEditorToolbarDefaultItems,
  getXkeenEditorToolbarIcons,
  getXkeenFormattersApi,
  getXkeenSettingsApi,
  getXkeenShowXrayPreflightErrorApi,
  getXkeenUiConfigShellApi,
  getXkeenFilePath,
  getXkeenModalApi,
  isXkeenMipsRuntime,
  toastXkeen,
} from './xkeen_runtime.js';
import { stripJsonComments as stripJsonCommentsUtil } from '../util/strip_json_comments.js';

(() => {
  "use strict";

  // Routing editor module.
  // Canonical module API:
  //   routingApi.init() -> creates CodeMirror editor and wires routing buttons.
  //   routingApi.load/save/validate/format/backup/restoreAuto/toggleCard
  //
  // Key goals:
  //  - Own routing editor lifecycle (CodeMirror + JSONC-aware lint).
  //  - Keep backward compatibility via features/compat/routing.js.

  function _storeGet(key) {
    const coreStorage = getXkeenCoreStorageApi();
    try { if (coreStorage && typeof coreStorage.get === 'function') return coreStorage.get(key); } catch (e) {}
    try { return localStorage.getItem(String(key)); } catch (e2) { return null; }
  }
  function _storeSet(key, val) {
    const coreStorage = getXkeenCoreStorageApi();
    try { if (coreStorage && typeof coreStorage.set === 'function') return coreStorage.set(key, val); } catch (e) {}
    try { localStorage.setItem(String(key), String(val)); } catch (e2) {}
  }
  function _storeRemove(key) {
    const coreStorage = getXkeenCoreStorageApi();
    try { if (coreStorage && typeof coreStorage.remove === 'function') return coreStorage.remove(key); } catch (e) {}
    try { localStorage.removeItem(String(key)); } catch (e2) {}
  }

  function _withCSRF(init, methodHint) {
    const coreHttp = getXkeenCoreHttpApi();
    try { if (coreHttp && typeof coreHttp.withCSRF === 'function') return coreHttp.withCSRF(init, methodHint); } catch (e) {}
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

    // Compact editor meta/status row
    editorMeta: 'routing-editor-meta',
    editorValidBadge: 'routing-editor-valid-badge',
    editorDirtyBadge: 'routing-editor-dirty-badge',
    editorCommentsBadge: 'routing-editor-comments-badge',

    btnSave: 'routing-save-btn',
	    btnReset: 'routing-reset-btn',
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
  let _errorGutterLine = null;
  let _lastJsonErrorLocation = null;

  // Active routing fragment file (basename or absolute). Controlled by dropdown.
  let _activeFragment = null;
  let _fragmentItems = [];
  let _fragmentDir = '';

  // Semantic mode: 'routing' (routing config) or 'fragment' (generic Xray JSON).
  let _routingMode = 'routing';

  // Active editor engine: 'codemirror' (default) or 'monaco'
  let _engine = 'codemirror';
  let _monaco = null;
  let _monacoFacade = null;
  let _cmFacade = null;
  let _monacoHostEl = null;
  let _routingMonacoToolbarEl = null;
  let _engineSelectEl = null;
  let _engineTouched = false;

  // Prevent concurrent editor engine switches (init + onShow may race on slow devices).
  // If Monaco gets created twice, it may throw: "Element already has context attribute".
  let _engineSwitchChain = Promise.resolve();
  let _monacoEnsurePromise = null;
  let _lastPageReturnShowAt = 0;

  let _commentsBadgeBase = { found: false, using: false, bn: '' };
  let _commentsBadgeOverride = null;

  // Monaco diagnostics debounce (markers).
  let _monacoDiagTimer = null;

  // Monaco fullscreen (CSS-driven)
  let _monacoFsWired = false;
  let _routingMonacoMenuEl = null;
  let _routingMonacoMenuCleanup = null;
  let _routingMonacoMenuCtx = null;
  let _routingMonacoClipboardShadow = '';

  // Async restart job state (xkeen -restart) for save with auto-restart.
  let _restartJobRunning = false;

	  // Dirty UI (unsaved changes)
	  let _dirtyTimer = null;
	  let _validateTimer = null;
	  let _editorContentTimer = null;
  let _suppressDirty = 0;
  let _editorPerfProfile = { lite: false, manualSync: false, webkitSafari: false, lineCount: 1, charCount: 0 };
  let _editorSnapshotVersion = 0;
  let _editorSnapshotCache = null;
  let _hashCommentOverlay = null;
  let _jsoncAnalysisCache = {
    raw: null,
    fast: null,
    exact: null,
  };
  let _viewStateStore = null;
  let _featureLifecycle = null;

  const VIEW_STATE_LS_PREFIX = 'xkeen.routing.viewstate.v1::';
  let _lastValidationState = { ok: null, message: '' };
  const PERF_LIMITS = {
    softLines: 1800,
    softChars: 110000,
    viewportMarginLite: 96,
    highlightLengthLite: 1200,
    measureFromLite: 1200,
    viewStateMs: 180,
    viewStateMsLite: 1200,
    dirtyMs: 200,
    dirtyMsLite: 480,
    validateMs: 110,
    validateMsLite: 650,
    editorContentMs: 120,
    editorContentMsLite: 360,
  };


  function $(id) {
    return document.getElementById(id);
  }

  function getModalApi() {
    return getXkeenModalApi();
  }

  function getConfigDirtyApi() {
    return getXkeenConfigDirtyApi();
  }

  function getConfigShellApi() {
    return getXkeenUiConfigShellApi();
  }

  function getConfirmApi() {
    return confirmXkeenAction;
  }

  function getUiSettingsApi() {
    return getXkeenSettingsApi();
  }

  function getFormattersApi() {
    return getXkeenFormattersApi();
  }

  function getEditorEngineApi() {
    return getXkeenEditorEngineApi();
  }

  function getCm6RuntimeApi() {
    return getXkeenCm6RuntimeApi();
  }

  function getCommandJobApi() {
    return getXkeenCommandJobApi();
  }

  function getShowXrayPreflightErrorApi() {
    return getXkeenShowXrayPreflightErrorApi();
  }

  async function ensureFormattersReady() {
    await import('../ui/prettier_loader.js');
    await import('../ui/formatters.js');
    return getXkeenFormattersApi();
  }

  function ensureXrayPreflightReady() {
    return import('../ui/xray_preflight_modal.js');
  }

  let _restartLogModulePromise = null;

  function getRoutingShellApi() {
    const api = getRoutingShellModuleApi();
    return api && typeof api.getState === 'function' ? api : null;
  }

  function getRoutingCardsFeatureApi() {
    try {
      const api = getRoutingCardsModuleApi();
      return api && typeof api.init === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function getBackupsFeatureApi() {
    try {
      const api = getBackupsModuleApi();
      return api && typeof api.init === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function loadRestartLogModule() {
    if (!_restartLogModulePromise) {
      _restartLogModulePromise = import('./restart_log.js').catch((error) => {
        _restartLogModulePromise = null;
        throw error;
      });
    }
    return _restartLogModulePromise;
  }

  async function getRestartLogFeatureApi() {
    try {
      const mod = await loadRestartLogModule();
      const api = mod && typeof mod.getRestartLogApi === 'function' ? mod.getRestartLogApi() : null;
      return api || null;
    } catch (e) {}
    return null;
  }

  function getFeatureLifecycle() {
    if (_featureLifecycle) return _featureLifecycle;
    const shell = getConfigShellApi();
    if (!shell || typeof shell.createFeatureLifecycle !== 'function') return null;
    try {
      _featureLifecycle = shell.createFeatureLifecycle('routing', {
        label: 'Routing',
        fileCodeId: IDS.fileCode,
        dirtySourceName: 'editor',
      });
    } catch (e) {
      _featureLifecycle = null;
    }
    return _featureLifecycle;
  }

  function registerRoutingLayers() {
    const shell = getRoutingShellApi();
    if (!shell || typeof shell.registerLayers !== 'function') return;

    try {
      shell.registerLayers({
        gui: {
          validate: () => validate(),
          setError: (message, line) => setError(message, line),
          openHelp: () => openHelp(),
          closeHelp: () => closeHelp(),
        },
        raw: {
          getText: () => getEditorText(),
          setText: (text, opts) => setEditorTextAll(text, opts || {}),
          saveViewState: (opts) => saveCurrentViewState(opts),
          loadViewState: (file) => loadSavedViewState(file),
          restoreViewState: (view) => restoreViewState(view),
          switchEngine: (engine, opts) => switchEngine(engine, opts),
        },
        orchestration: {
          load: () => load(),
          save: () => save(),
          replaceEditorText: (text, opts) => replaceEditorText(text, opts),
          refreshFragments: (opts) => refreshFragmentsList(opts),
          activeFragment: () => getActiveFragment(),
        },
      });
    } catch (e) {}
  }

  function syncSharedRoutingEditor(editor, facade, engineOverride) {
    const shell = getRoutingShellApi();
    const engine = normalizeEngine(engineOverride || _engine);
    const binding = {
      engine: engine,
      editor: editor || null,
      facade: facade || null,
      getText: () => getEditorText(),
      setText: (text, opts) => {
        setEditorTextAll(text, opts || {});
        return true;
      },
      replaceText: (text, opts) => {
        replaceEditorText(text, opts || {});
        return true;
      },
      validate: () => validate(),
      saveViewState: (opts) => saveCurrentViewState(opts),
      loadViewState: (file) => loadSavedViewState(file),
      restoreViewState: (view) => restoreViewState(view),
    };

    if (shell && typeof shell.bindEditor === 'function') {
      try { shell.bindEditor(binding); } catch (e) {}
      try { registerRoutingLayers(); } catch (e2) {}
    }
  }

  function setRoutingSavedContent(text) {
    const value = String(text ?? '');
    const shell = getRoutingShellApi();
    if (shell && typeof shell.setSavedContent === 'function') {
      try {
        shell.setSavedContent(value);
        return;
      } catch (e) {}
    }
    try { window.routingSavedContent = value; } catch (e2) {}
  }

  function setRoutingDirty(dirty) {
    const value = !!dirty;
    const shell = getRoutingShellApi();
    if (shell && typeof shell.setDirty === 'function') {
      try {
        shell.setDirty(value);
        return;
      } catch (e) {}
    }
    try { window.routingIsDirty = value; } catch (e2) {}
  }

  function isRoutingDirty() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.isDirty === 'function') {
      try {
        return !!shell.isDirty();
      } catch (e) {}
    }
    try { return !!window.routingIsDirty; } catch (e2) {}
    return false;
  }

  function syncShellState(dir, items) {
    if (dir != null) _fragmentDir = String(dir || '');
    if (Array.isArray(items)) _fragmentItems = items.slice();

    const payload = {
      label: 'Routing',
      fileCodeId: IDS.fileCode,
      dir: _fragmentDir,
      items: _fragmentItems,
      activeFragment: getActiveFragment(),
    };

    const lifecycle = getFeatureLifecycle();
    if (lifecycle && typeof lifecycle.syncTab === 'function') {
      try {
        lifecycle.syncTab(payload);
        return;
      } catch (e) {}
    }

    const shell = getConfigShellApi();
    if (!shell || typeof shell.syncTab !== 'function') return;

    try {
      shell.syncTab('routing', payload);
    } catch (e) {}
  }

  function decorateFragmentName(name) {
    const value = String(name || '');
    if (!value) return '';
    if (/_hys2\.json$/i.test(value)) return value + ' (Hysteria2)';
    return value;
  }

  function applyActiveFragment(name, dir, items) {
    _activeFragment = name ? String(name) : null;
    if (_activeFragment) rememberActiveFragment(_activeFragment);
    const nextDir = (dir != null) ? String(dir || '') : _fragmentDir;
    const cleanDir = nextDir ? String(nextDir).replace(/\/+$/, '') : '';
    try {
      updateActiveFileLabel((cleanDir ? cleanDir + '/' : '') + (_activeFragment || ''), cleanDir);
    } catch (e) {}
    try { _updateFileScopedTooltips(); } catch (e2) {}
    try { _updateModeBadge(); } catch (e3) {}
    try { syncShellState(cleanDir, Array.isArray(items) ? items : null); } catch (e4) {}
    return _activeFragment;
  }

  function restoreFragmentSelection(sel, fragment, dir, items) {
    const selectEl = sel || $(IDS.fragmentSelect);
    const value = String(fragment || '').trim();
    if (!selectEl || !value) return;

    let opt = null;
    try {
      opt = Array.from(selectEl.options || []).find((item) => String(item.value || '') === value) || null;
    } catch (e) {}

    if (!opt) {
      try {
        opt = document.createElement('option');
        opt.value = value;
        opt.textContent = decorateFragmentName(value) + ' (текущий)';
        selectEl.appendChild(opt);
      } catch (e2) {}
    }

    try { selectEl.value = value; } catch (e3) {}
    applyActiveFragment(value, dir, items);
  }

  async function guardFragmentSwitch(next, prev, opts) {
    const config = opts && typeof opts === 'object' ? opts : {};
    const lifecycle = getFeatureLifecycle();
    const shell = getConfigShellApi();
    const payload = {
      currentValue: String(prev || ''),
      nextValue: String(next || ''),
      title: 'Несохранённые изменения',
      message: 'В редакторе routing есть несохранённые изменения. Переключить файл и потерять их?',
      okText: 'Переключить',
      cancelText: 'Остаться',
      onCancel: config.onCancel,
      beforeSwitch: config.beforeSwitch,
      commit: config.commit,
    };

    if (lifecycle && typeof lifecycle.guardSwitch === 'function') {
      try { return await lifecycle.guardSwitch(payload); } catch (e) {}
    }

    if (shell && typeof shell.guardSwitch === 'function') {
      try { return await shell.guardSwitch('routing', payload); } catch (e) {}
    }

    const api = getConfigDirtyApi();
    const ok = (api && typeof api.confirmDiscard === 'function')
      ? await api.confirmDiscard('routing', {
          title: payload.title,
          message: payload.message,
          okText: payload.okText,
          cancelText: payload.cancelText,
        })
      : !isRoutingDirty() || !!window.confirm(payload.message);

    if (!ok) {
      if (typeof payload.onCancel === 'function') await Promise.resolve(payload.onCancel());
      return false;
    }
    if (typeof payload.beforeSwitch === 'function') await Promise.resolve(payload.beforeSwitch());
    if (typeof payload.commit === 'function') await Promise.resolve(payload.commit());
    return true;
  }

  function bindConfigAction(btnId, handler, opts) {
    const lifecycle = getFeatureLifecycle();
    if (lifecycle && typeof lifecycle.bindAction === 'function') {
      try {
        if (lifecycle.bindAction(btnId, handler, opts || {})) return;
      } catch (e) {}
    }

    const shell = getConfigShellApi();
    if (shell && typeof shell.bindAction === 'function') {
      try {
        if (shell.bindAction('routing', btnId, handler, opts || {})) return;
      } catch (e) {}
    }
    wireButton(btnId, handler);
  }

  function syncRoutingDirtyContract(dirty) {
    const dirtyOpts = {
      sourceName: 'editor',
      scopeLabel: 'Routing',
      confirmTitle: 'Несохранённые изменения',
      confirmMessage: 'В редакторе routing есть несохранённые изменения. Переключить файл и потерять их?',
      okText: 'Переключить',
      cancelText: 'Остаться',
      label: 'Редактор routing',
      summary: dirty ? 'Текст routing отличается от последней сохранённой версии.' : '',
      currentValue: getEditorText(),
      savedValue: _getSavedContent(),
    };

    const lifecycle = getFeatureLifecycle();
    if (lifecycle && typeof lifecycle.setDirty === 'function') {
      try {
        lifecycle.setDirty(!!dirty, dirtyOpts);
        return;
      } catch (e) {}
    }

    const api = getConfigDirtyApi();
    if (!api || typeof api.setDirty !== 'function') return;
    try {
      api.setDirty('routing', 'editor', !!dirty, dirtyOpts);
    } catch (e) {}
  }

  function isMipsTarget() {
    if (isXkeenMipsRuntime()) return true;
    try {
      return /mips/i.test(String((window.navigator && window.navigator.userAgent) || ''));
    } catch (e2) {}
    return false;
  }

  function isWebKitSafari() {
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

  function countLines(text) {
    const s = String(text ?? '');
    if (!s) return 1;
    let n = 1;
    for (let i = 0; i < s.length; i += 1) {
      if (s.charCodeAt(i) === 10) n += 1;
    }
    return n;
  }

  function computeEditorPerfProfile(text) {
    const raw = String(text ?? '');
    const lineCount = countLines(raw);
    const charCount = raw.length;
    const lite = !!(isMipsTarget() || lineCount >= PERF_LIMITS.softLines || charCount >= PERF_LIMITS.softChars);
    return {
      lite,
      manualSync: lite,
      webkitSafari: false,
      lineCount,
      charCount,
    };
  }

  function readCurrentEditorText() {
    try {
      if (_engine === 'monaco' && _monaco) return String(_monaco.getValue() || '');
    } catch (e) {}
    try {
      if (_cm && typeof _cm.getValue === 'function') return String(_cm.getValue() || '');
    } catch (e) {}
    const ta = $(IDS.textarea);
    return ta ? String(ta.value || '') : '';
  }

  function cacheEditorSnapshot(text) {
    const raw = String(text ?? '');
    const perf = computeEditorPerfProfile(raw);
    _editorPerfProfile = perf;
    _editorSnapshotCache = {
      version: _editorSnapshotVersion,
      text: raw,
      perf,
    };
    return _editorSnapshotCache;
  }

  function invalidateEditorSnapshot() {
    _editorSnapshotVersion += 1;
    _editorSnapshotCache = null;
  }

  function getEditorSnapshot() {
    if (_editorSnapshotCache && _editorSnapshotCache.version === _editorSnapshotVersion) {
      return _editorSnapshotCache;
    }
    return cacheEditorSnapshot(readCurrentEditorText());
  }

  function currentViewStateDebounceMs() {
    return (_editorPerfProfile && _editorPerfProfile.lite) ? PERF_LIMITS.viewStateMsLite : PERF_LIMITS.viewStateMs;
  }

  function currentDirtyDebounceMs() {
    return (_editorPerfProfile && _editorPerfProfile.lite) ? PERF_LIMITS.dirtyMsLite : PERF_LIMITS.dirtyMs;
  }

  function currentValidateDebounceMs() {
    return (_editorPerfProfile && _editorPerfProfile.lite) ? PERF_LIMITS.validateMsLite : PERF_LIMITS.validateMs;
  }

  function currentEditorContentDebounceMs() {
    return (_editorPerfProfile && _editorPerfProfile.lite) ? PERF_LIMITS.editorContentMsLite : PERF_LIMITS.editorContentMs;
  }

  function shouldManualCodeMirrorLint() {
    return !!(_editorPerfProfile && _editorPerfProfile.lite);
  }

  function buildRoutingCodeMirrorDiagnostics(rawText, opts) {
    const raw = String(rawText ?? '');
    if (!String(raw || '').trim()) {
      return [{
        line: 1,
        column: 1,
        length: 1,
        severity: 'error',
        source: 'routing-jsonc',
        message: 'Файл пуст. Введи корректный JSON.',
      }];
    }

    const analysis = getJsoncAnalysis(raw, opts || { preciseLocation: true });
    if (analysis.ok || !analysis.loc) return [];
    const loc = analysis.loc || { line: 1, col: 1 };
    return [{
      line: Math.max(1, Number(loc.line || 1)),
      column: Math.max(1, Number(loc.col || 1)),
      length: 1,
      severity: 'error',
      source: 'routing-jsonc',
      message: String(analysis.message || 'JSON parse error'),
    }];
  }

  function clearCodeMirrorDiagnostics() {
    try {
      if (_cm && typeof _cm.clearDiagnostics === 'function') {
        _cm.clearDiagnostics();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function applyCodeMirrorDiagnostics(list) {
    const diagnostics = Array.isArray(list) ? list : [];
    try {
      if (_cm && typeof _cm.setDiagnostics === 'function') {
        if (diagnostics.length) _cm.setDiagnostics(diagnostics);
        else _cm.clearDiagnostics();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function syncCodeMirrorLintNow() {
    try {
      if (_engine !== 'codemirror' || !_cm) return;
      applyCodeMirrorDiagnostics(buildRoutingCodeMirrorDiagnostics(getEditorText(), { preciseLocation: true }));
    } catch (e) {}
  }

  function shouldUsePreciseJsonLocation(opts) {
    const o = opts || {};
    if (o.preciseLocation === true) return true;
    if (o.preciseLocation === false) return false;
    return !(_editorPerfProfile && _editorPerfProfile.lite);
  }


  function syncRoutingCodeMirrorOverlays(enabled) {
    if (!_cm) return;

    const allowRichOverlays = !!enabled;
    try {
      _cm.state = _cm.state || {};
      _cm.state.__xkRoutingHashOverlayEnabled = allowRichOverlays;
    } catch (e) {}

    try {
      const wrapper = (typeof _cm.getWrapperElement === 'function') ? _cm.getWrapperElement() : null;
      if (wrapper && wrapper.classList) wrapper.classList.toggle('xk-routing-rich-overlays', allowRichOverlays);
    } catch (e) {}

    try {
      if (typeof _cm.setLinksEnabled === 'function') {
        _cm.setLinksEnabled(allowRichOverlays);
      } else if (typeof _cm.setOption === 'function') {
        _cm.setOption('links', allowRichOverlays);
      } else if (typeof window.xkeenCmLinksSetEnabled === 'function') {
        window.xkeenCmLinksSetEnabled(_cm, allowRichOverlays);
      }
    } catch (e) {}
  }

  function getJsoncAnalysis(rawText, opts) {
    const raw = String(rawText ?? '');
    const preciseLocation = shouldUsePreciseJsonLocation(opts);

    if (_jsoncAnalysisCache.raw === raw) {
      if (preciseLocation && _jsoncAnalysisCache.exact) return _jsoncAnalysisCache.exact;
      if (!preciseLocation && (_jsoncAnalysisCache.fast || _jsoncAnalysisCache.exact)) {
        return _jsoncAnalysisCache.fast || _jsoncAnalysisCache.exact;
      }
    } else {
      _jsoncAnalysisCache.raw = raw;
      _jsoncAnalysisCache.fast = null;
      _jsoncAnalysisCache.exact = null;
    }

    const sm = stripJsonCommentsWithMap(raw);
    const cleaned = sm.cleaned;
    let parsed = null;
    let error = null;
    let loc = null;

    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      error = e;
      loc = extractJsonErrorLocation(error, raw, sm, { preciseLocation });
    }

    const analysis = {
      raw,
      sm,
      cleaned,
      ok: !error,
      parsed,
      error,
      loc,
      message: loc && loc.message ? String(loc.message) : String(error && error.message ? error.message : ''),
    };

    if (analysis.ok) {
      _jsoncAnalysisCache.fast = analysis;
      _jsoncAnalysisCache.exact = analysis;
      return analysis;
    }

    if (preciseLocation) {
      _jsoncAnalysisCache.exact = analysis;
      if (!_jsoncAnalysisCache.fast) _jsoncAnalysisCache.fast = analysis;
    } else {
      _jsoncAnalysisCache.fast = analysis;
    }

    return analysis;
  }

  function buildRoutingLintOptions() {
    return true;
  }

  function applyCodeMirrorPerfProfile(text) {
    const next = computeEditorPerfProfile(text);
    _editorPerfProfile = next;

    if (!_cm || typeof _cm.setOption !== 'function') return next;

    const wrapper = (typeof _cm.getWrapperElement === 'function') ? _cm.getWrapperElement() : null;
    const apply = () => {
      try { _cm.setOption('styleActiveLine', !next.lite); } catch (e) {}
      try { _cm.setOption('showIndentGuides', !next.lite); } catch (e) {}
      try { _cm.setOption('matchBrackets', !next.lite); } catch (e) {}
      try { _cm.setOption('highlightSelectionMatches', !next.lite); } catch (e) {}
      try { _cm.setOption('showTrailingSpace', !next.lite); } catch (e) {}
      try { _cm.setOption('lineWrapping', !next.lite); } catch (e) {}
      try { _cm.setOption('foldGutter', !next.lite); } catch (e) {}
      try { _cm.setOption('rulers', next.lite ? [] : [{ column: 120 }]); } catch (e) {}
      try { _cm.setOption('maxHighlightLength', next.lite ? PERF_LIMITS.highlightLengthLite : 10000); } catch (e) {}
      try { _cm.setOption('crudeMeasuringFrom', next.lite ? PERF_LIMITS.measureFromLite : 10000); } catch (e) {}
      try {
        _cm.setOption(
          'gutters',
          next.lite
            ? ['CodeMirror-linenumbers', 'CodeMirror-lint-markers']
            : ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers']
        );
      } catch (e) {}
      try { _cm.setOption('lint', buildRoutingLintOptions(next.lite)); } catch (e) {}
      try {
        _cm.setOption(
          'viewportMargin',
          next.lite
            ? PERF_LIMITS.viewportMarginLite
            : Infinity
        );
      } catch (e) {}
    };

    try {
      if (typeof _cm.operation === 'function') _cm.operation(apply);
      else apply();
    } catch (e) {}

    try {
      if (wrapper && wrapper.classList) wrapper.classList.toggle('xk-cm-lite', !!next.lite);
    } catch (e) {}
    try { syncRoutingCodeMirrorOverlays(!next.lite); } catch (e) {}
    try {
      if (_engine === 'codemirror' && typeof _cm.refresh === 'function') _cm.refresh();
    } catch (e) {}

    return next;
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


  function _viewStateKey(file) {
    return VIEW_STATE_LS_PREFIX + String(file || '__default__');
  }

  function _getViewStateStore() {
    if (_viewStateStore) return _viewStateStore;
    try {
      const helper = _getEditorEngineHelper();
      if (helper && typeof helper.createViewStateStore === 'function') {
        _viewStateStore = helper.createViewStateStore({
          buildKey: (file) => _viewStateKey(file),
        });
      }
    } catch (e) {}
    return _viewStateStore;
  }

  function captureViewState() {
    const store = _getViewStateStore();
    if (store && typeof store.capture === 'function') {
      const saved = store.capture({
        engine: _engine,
        facade: getActiveEditorFacade(),
        capture: () => {
          const fac = getActiveEditorFacade();
          if (fac && typeof fac.saveViewState === 'function') {
            return fac.saveViewState({ memoryOnly: true });
          }
          return null;
        },
      });
      if (saved && typeof saved === 'object') return saved;
    }
    try {
      const fac = getActiveEditorFacade();
      if (fac && typeof fac.saveViewState === 'function') {
        const saved = fac.saveViewState({ memoryOnly: true });
        if (saved && typeof saved === 'object') return saved;
      }
    } catch (e) {}
    try {
      if (_engine === 'monaco' && _monaco) {
        return {
          kind: 'monaco',
          pos: (typeof _monaco.getPosition === 'function') ? _monaco.getPosition() : null,
          scrollTop: (typeof _monaco.getScrollTop === 'function') ? _monaco.getScrollTop() : 0,
        };
      }
      if (_cm) {
        const cur = (typeof _cm.getCursor === 'function') ? _cm.getCursor() : null;
        const si = (typeof _cm.getScrollInfo === 'function') ? _cm.getScrollInfo() : null;
        return {
          kind: 'codemirror',
          cursor: cur,
          scrollTop: si ? si.top : 0,
        };
      }
    } catch (e) {}
    return { kind: _engine || 'codemirror' };
  }

  function saveCurrentViewState(opts) {
    const o = opts || {};
    try {
      const data = captureViewState();
      const store = _getViewStateStore();
      if (store && typeof store.save === 'function') {
        store.save({
          key: _viewStateKey(getActiveFragment()),
          engine: _engine,
          view: data,
          memoryOnly: !!o.memoryOnly,
        });
      } else {
        const key = _viewStateKey(getActiveFragment());
        if (!o.memoryOnly) localStorage.setItem(key, JSON.stringify(data || {}));
      }
      if (o.updateMeta !== false) updateEditorMetaStatus();
    } catch (e) {}
  }

  function scheduleViewStateSave(waitMs, opts) {
    const wait = (typeof waitMs === 'number' && waitMs >= 0) ? waitMs : currentViewStateDebounceMs();
    const o = opts || {};
    const store = _getViewStateStore();
    if (store && typeof store.schedule === 'function') {
      store.schedule({
        key: _viewStateKey(getActiveFragment()),
        engine: _engine,
        waitMs: wait,
        memoryOnly: !!o.memoryOnly,
        capture: () => captureViewState(),
        afterSave: () => {
          try {
            if (o.updateMeta !== false) updateEditorMetaStatus();
          } catch (e) {}
        },
      });
      return;
    }
    try { saveCurrentViewState(o); } catch (e) {}
  }

  function loadSavedViewState(file) {
    const store = _getViewStateStore();
    if (store && typeof store.load === 'function') {
      return store.load({
        key: _viewStateKey(file),
        engine: _engine,
      });
    }
    try {
      const key = _viewStateKey(file);
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {}
    return null;
  }

  function restoreViewState(view) {
    const store = _getViewStateStore();
    if (store && typeof store.restore === 'function') {
      try {
        if (store.restore({
          engine: _engine,
          facade: getActiveEditorFacade(),
          view,
        })) {
          return true;
        }
      } catch (e) {}
    }
    try {
      const fac = getActiveEditorFacade();
      if (fac && typeof fac.restoreViewState === 'function' && fac.restoreViewState(view)) {
        return true;
      }
    } catch (e) {}
    try {
      if (_engine === 'monaco' && _monaco) {
        let pos = view && view.pos ? view.pos : null;
        if (!pos && view && view.cursor) {
          pos = { lineNumber: (view.cursor.line || 0) + 1, column: (view.cursor.ch || 0) + 1 };
        }
        if (pos && typeof _monaco.setPosition === 'function') _monaco.setPosition(pos);
        if (typeof _monaco.setScrollTop === 'function' && typeof view.scrollTop === 'number') {
          _monaco.setScrollTop(Math.max(0, view.scrollTop));
        }
        return true;
      }
      if (_cm) {
        let cur = view && view.cursor ? view.cursor : null;
        if (!cur && view && view.pos) {
          cur = { line: Math.max(0, (view.pos.lineNumber || 1) - 1), ch: Math.max(0, (view.pos.column || 1) - 1) };
        }
        if (cur && typeof _cm.setCursor === 'function') _cm.setCursor(cur);
        if (typeof _cm.scrollTo === 'function' && typeof view.scrollTop === 'number') _cm.scrollTo(null, Math.max(0, view.scrollTop));
        if (typeof _cm.refresh === 'function') _cm.refresh();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function updateEditorMetaStatus() {
    try {
      const validEl = $(IDS.editorValidBadge);
      const dirtyEl = $(IDS.editorDirtyBadge);

      _updateEditorCommentsBadge();

      const ok = _lastValidationState && _lastValidationState.ok;
      const msg = _lastValidationState && _lastValidationState.message ? String(_lastValidationState.message) : '';
      const dirty = isRoutingDirty();

      if (validEl) {
        validEl.textContent = ok === null ? 'JSON: —' : (ok ? 'JSON: valid' : 'JSON: invalid');
        validEl.classList.toggle('is-ok', !!ok);
        validEl.classList.toggle('is-bad', ok === false);
        validEl.setAttribute('data-tooltip', msg || (ok === null
          ? 'Состояние проверки JSON/JSONC пока не определено.'
          : (ok ? 'JSON/JSONC синтаксис корректен.' : 'В тексте есть ошибка синтаксиса JSON/JSONC.')));
      }
      if (dirtyEl) {
        dirtyEl.textContent = dirty ? 'Состояние: изменён' : 'Состояние: сохранён';
        dirtyEl.classList.toggle('is-warn', dirty);
        dirtyEl.classList.toggle('is-ok', !dirty);
        dirtyEl.setAttribute('data-tooltip', dirty
          ? 'Текст редактора отличается от последней сохранённой версии файла.'
          : 'Текущий текст совпадает с последней сохранённой версией файла.');
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
    const isRouting = String(_routingMode || '') === 'routing';
    const modeLabel = isRouting ? 'Routing mode' : 'Fragment mode';

    try {
      const badge = $(IDS.modeBadge);
      if (badge) {
        badge.textContent = modeLabel;
        badge.setAttribute('data-profile', isRouting ? 'routing' : 'fragment');
        badge.setAttribute('data-tooltip', 'Режим редактора: ' + modeLabel);
      }
    } catch (e) {}

    try {
      const sel = $(IDS.fragmentSelect);
      if (sel) {
        const file = _activeFileNameForUI() || String(sel.value || sel.dataset.current || '').trim();
        const tip = file
          ? ('Файл для редактирования: ' + file + ' · Режим: ' + modeLabel)
          : ('Выбор файла для редактирования · Режим: ' + modeLabel);
        sel.setAttribute('data-tooltip', tip);
        sel.setAttribute('title', tip);
        sel.setAttribute('aria-label', 'Файл для редактирования. ' + modeLabel);
      }
    } catch (e) {}
  }

  function _updateFileScopedTooltips() {
    const file = _activeFileNameForUI();
    const isRouting = String(_routingMode || '') === 'routing';
    const saveTip = file
      ? ((isRouting ? 'Сохранить routing-файл: ' : 'Сохранить файл: ') + file)
      : (isRouting ? 'Сохранить текущий routing-файл.' : 'Сохранить текущий файл.');
    const resetTip = file
      ? ('Откатить несохранённые изменения в файле: ' + file)
      : 'Откатить несохранённые изменения и вернуть текст к последней сохранённой версии.';

    try {
      const saveBtn = $(IDS.btnSave);
      if (saveBtn) {
        saveBtn.setAttribute('data-tooltip', saveTip);
        saveBtn.setAttribute('aria-label', isRouting ? 'Сохранить routing-файл' : 'Сохранить файл');
      }
    } catch (e) {}

    try {
      const resetBtn = $(IDS.btnReset);
      if (resetBtn) {
        resetBtn.setAttribute('data-tooltip', resetTip);
        resetBtn.setAttribute('title', resetTip);
      }
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

    // Keep tooltips in sync with the active file / semantic mode.
    try {
      const saveBtn = $(IDS.btnSave);
      if (saveBtn) {
        saveBtn.dataset.mode = isRouting ? 'routing' : 'fragment';
      }
    } catch (e) {}

    // Keep the mode badge + file-scoped tooltips in sync.
    try { _updateModeBadge(); } catch (e) {}
    try { _updateFileScopedTooltips(); } catch (e) {}
    try { syncShellState(); } catch (e) {}

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

  function _updateEditorCommentsBadge() {
    const el = $(IDS.editorCommentsBadge);
    if (!el) return;

    const base = _commentsBadgeBase || { found: false, using: false, bn: '' };
    const override = _commentsBadgeOverride;

    let text = 'Комментарии: —';
    let title = '';
    let mode = 'muted';

    if (override && override.kind) {
      if (override.kind === 'preserved') {
        text = 'Комментарии: JSONC preserve';
        title = override.message || 'Изменения применены с сохранением JSONC-комментариев.';
        mode = 'ok';
      } else if (override.kind === 'fallback-needed') {
        text = 'Комментарии: нужен fallback';
        title = override.reason || 'JSONC-preserve не удалось завершить без legacy rewrite.';
        mode = 'warn';
      } else if (override.kind === 'fallback-used') {
        text = 'Комментарии: legacy rewrite';
        title = override.message || 'Изменения применены старым способом: комментарии в текущем тексте перезаписаны.';
        mode = 'warn';
      } else if (override.kind === 'fallback-cancelled') {
        text = 'Комментарии: fallback отменён';
        title = override.reason || 'Пользователь отменил legacy rewrite — текст оставлен без перезаписи.';
        mode = 'muted';
      }
    } else if (base.found) {
      text = base.using ? 'Комментарии: JSONC active' : 'Комментарии: sidecar найден';
      title = base.bn ? ('JSONC: ' + String(base.bn)) : (base.using ? 'JSONC sidecar используется' : 'JSONC sidecar найден');
      mode = base.using ? 'ok' : 'muted';
    } else {
      text = 'Комментарии: off';
      title = 'JSONC sidecar не найден';
      mode = 'muted';
    }

    el.textContent = text;
    el.classList.remove('is-ok', 'is-warn', 'is-bad', 'is-muted');
    el.classList.add(mode === 'ok' ? 'is-ok' : (mode === 'warn' ? 'is-warn' : 'is-muted'));
    if (title) el.setAttribute('data-tooltip', title);
    else el.removeAttribute('data-tooltip');
  }

  function _setCommentsBadge(found, using, bn) {
    _commentsBadgeBase = { found: !!found, using: !!using, bn: String(bn || '') };
    _commentsBadgeOverride = null;

    const el = $(IDS.commentsStatus);
    if (el) {
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

    _updateEditorCommentsBadge();
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
      const coreHttp = getXkeenCoreHttpApi();
      if (coreHttp && typeof coreHttp.fetchJSON === 'function') {
        data = await coreHttp.fetchJSON(url, { method: 'GET', cache: 'no-store' }).catch(() => null);
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
        if (notify) {
          toastXkeen(all ? 'Не удалось обновить список файлов Xray' : 'Не удалось обновить список файлов роутинга', 'error');
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

    // Rebuild options
    try { if (sel.dataset) sel.dataset.dir = String(data.dir || ''); } catch (e) {}
    sel.innerHTML = '';
    const names = data.items.map((it) => String(it.name || '')).filter(Boolean);

    // If currentDefault isn't in list, keep it as "custom"
    if (currentDefault && names.indexOf(currentDefault) === -1) {
      const opt = document.createElement('option');
      opt.value = currentDefault;
      opt.textContent = decorateFragmentName(currentDefault) + ' (текущий)';
      sel.appendChild(opt);
    }

    data.items.forEach((it) => {
      const name = String(it.name || '');
      if (!name) return;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = decorateFragmentName(name);
      sel.appendChild(opt);
    });

    // Select preferred if exists
    try {
      const finalChoice = names.indexOf(preferred) !== -1 ? preferred : (currentDefault || (names[0] || ''));
      if (finalChoice) sel.value = finalChoice;
      const dir = data.dir ? String(data.dir).replace(/\/+$/, '') : '';
      applyActiveFragment(sel.value || finalChoice || null, dir, data.items);
    } catch (e) {}

    // If scope was reduced and a non-routing file disappeared from the list, clarify the jump.
    try {
      if (scopeChanged === 'off' && prevSelection && _activeFragment && prevSelection !== _activeFragment) {
        if (names.indexOf(prevSelection) === -1) {
          toastXkeen('«Все файлы» выключено — переключено на: ' + String(_activeFragment), 'info');
        }
      }
    } catch (e) {}

    // Keep badge/tooltips up-to-date (selection may change during refresh).
    try { _updateModeBadge(); } catch (e) {}
    try { _updateFileScopedTooltips(); } catch (e) {}
    try { syncShellState(); } catch (e) {}

    // Wire refresh button (once)
    try {
      const btn = $(IDS.fragmentRefresh);
      if (btn && !btn.dataset.xkWired) {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const prev = getActiveFragment();
          const prevDir = _fragmentDir;
          await refreshFragmentsList({ notify: true });
          const next = getActiveFragment();
          if (!next || next === prev) return;
          await guardFragmentSwitch(next, prev, {
            onCancel: () => restoreFragmentSelection(sel, prev, prevDir, _fragmentItems),
            beforeSwitch: () => { try { saveCurrentViewState(); } catch (e2) {} },
            commit: async () => { await load(); },
          });
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
      if (notify) {
        toastXkeen(all ? 'Список файлов Xray обновлён' : 'Список файлов роутинга обновлён', 'success');
      }
    } catch (e) {}
  }




  function setStatus(msg, isError) {
    const el = $(IDS.status);
    if (el) el.textContent = String(msg ?? '');
    if (msg) toast(msg, !!isError);
  }

  function _getSavedContent() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.getSavedContent === 'function') {
      try {
        return String(shell.getSavedContent() || '');
      } catch (e) {}
    }
    try {
      return (typeof window.routingSavedContent === 'string') ? window.routingSavedContent : '';
    } catch (e) {}
    return '';
  }

	  function _isDirtyText(current, saved) {
	    const cur = String(current ?? '');
	    const sv = String(saved ?? '');
	    // If we have a saved baseline — strict compare; otherwise any non-empty content is considered dirty.
	    if (sv.length) return cur !== sv;
	    return cur.trim().length > 0;
	  }

	  function syncDirtyUi(forceDirty) {
	    if (_suppressDirty > 0) return;
	    let dirty = null;
	    if (typeof forceDirty === 'boolean') dirty = forceDirty;
	    else {
	      try { dirty = _isDirtyText(getEditorSnapshot().text, _getSavedContent()); } catch (e) { dirty = false; }
	    }

    try { setRoutingDirty(!!dirty); } catch (e) {}
      try { syncRoutingDirtyContract(!!dirty); } catch (e) {}
	    try {
	      const saveBtn = $(IDS.btnSave);
	      if (saveBtn) saveBtn.classList.toggle('dirty', !!dirty);
	    } catch (e) {}
	    try {
	      const resetBtn = $(IDS.btnReset);
	      if (resetBtn) {
	        resetBtn.disabled = !dirty;
	        resetBtn.classList.toggle('is-active', !!dirty);
	      }
	    } catch (e) {}
      try { updateEditorMetaStatus(); } catch (e) {}
      try { document.dispatchEvent(new CustomEvent('xkeen:routing-editor-dirty', { detail: { dirty: !!dirty } })); } catch (e) {}
	  }

	  function scheduleDirtyCheck(waitMs) {
	    if (_suppressDirty > 0) return;
	    const wait = (typeof waitMs === 'number' && waitMs >= 0) ? waitMs : currentDirtyDebounceMs();
	    try { if (_dirtyTimer) clearTimeout(_dirtyTimer); } catch (e) {}
	    _dirtyTimer = setTimeout(() => {
	      _dirtyTimer = null;
	      try { syncDirtyUi(); } catch (e) {}
	    }, wait);
	  }

	  function scheduleValidate(waitMs) {
	    const wait = (typeof waitMs === 'number' && waitMs >= 0) ? waitMs : currentValidateDebounceMs();
	    try { if (_validateTimer) clearTimeout(_validateTimer); } catch (e) {}
	    _validateTimer = setTimeout(() => {
	      _validateTimer = null;
	      try { validate(); } catch (e) {}
	    }, wait);
	  }

	  function dispatchEditorContentEvent(reason) {
	    try {
	      const snapshot = getEditorSnapshot();
	      document.dispatchEvent(new CustomEvent('xkeen:routing-editor-content', {
	        detail: {
	          reason: String(reason || 'change'),
	          engine: String(_engine || ''),
	          dirty: isRoutingDirty(),
	          file: String(getActiveFragment() || ''),
	          profile: snapshot && snapshot.perf ? {
	            lite: !!snapshot.perf.lite,
	            manualSync: !!snapshot.perf.manualSync,
	            webkitSafari: !!snapshot.perf.webkitSafari,
	            lineCount: Number(snapshot.perf.lineCount || 0),
	            charCount: Number(snapshot.perf.charCount || 0),
	          } : null,
	        }
	      }));
	    } catch (e) {}
	  }

	  function scheduleEditorContentEvent(reason, waitMs) {
	    const wait = (typeof waitMs === 'number' && waitMs >= 0) ? waitMs : currentEditorContentDebounceMs();
	    try { if (_editorContentTimer) clearTimeout(_editorContentTimer); } catch (e) {}
	    _editorContentTimer = setTimeout(() => {
	      _editorContentTimer = null;
	      try { dispatchEditorContentEvent(reason); } catch (e) {}
	    }, wait);
	  }

  function stripJsonComments(text) {
    try {
      return stripJsonCommentsUtil(String(text ?? ''));
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
      const confirmApi = getConfirmApi();
      if (typeof confirmApi === 'function') {
        return await confirmApi({
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

  document.body.appendChild(modal);
  return modal;
}

function openHelp() {
  const modal = ensureHelpModal();
  const api = getModalApi();
  try {
    if (api && typeof api.open === 'function') api.open(modal, { source: 'routing_help_modal' });
    else modal.classList.remove('hidden');
  } catch (e) {}
  try {
    if (!api || typeof api.open !== 'function') document.body.classList.add('modal-open');
  } catch (e2) {}
}

function closeHelp() {
  const modal = document.getElementById(HELP_MODAL_ID);
  if (!modal) return;
  const api = getModalApi();
  try {
    if (api && typeof api.close === 'function') api.close(modal, { source: 'routing_help_modal' });
    else modal.classList.add('hidden');
  } catch (e) {}
  try {
    if (!api || typeof api.close !== 'function') document.body.classList.remove('modal-open');
  } catch (e2) {}
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
    try { clearCodeMirrorDiagnostics(); } catch (e2) {}
    _errorGutterLine = null;
  }


  function clearJsonErrorLocation() {
    _lastJsonErrorLocation = null;
    try {
      const errEl = $(IDS.error);
      if (!errEl) return;
      errEl.classList.remove('is-clickable');
      errEl.removeAttribute('role');
      errEl.removeAttribute('tabindex');
      errEl.removeAttribute('title');
    } catch (e) {}
  }

  function setJsonErrorLocation(loc) {
    const norm = (!loc || typeof loc !== 'object') ? null : {
      line: Number.isFinite(loc.line) ? Math.max(1, Math.floor(loc.line)) : null,
      col: Number.isFinite(loc.col) ? Math.max(1, Math.floor(loc.col)) : null,
      index: Number.isFinite(loc.index) ? Math.max(0, Math.floor(loc.index)) : null,
      message: loc && loc.message ? String(loc.message) : '',
    };
    _lastJsonErrorLocation = norm;
    try {
      const errEl = $(IDS.error);
      if (!errEl) return;
      if (norm && (norm.line || norm.index !== null)) {
        errEl.classList.add('is-clickable');
        errEl.setAttribute('role', 'button');
        errEl.setAttribute('tabindex', '0');
        errEl.setAttribute('title', 'Перейти к месту ошибки');
      } else {
        errEl.classList.remove('is-clickable');
        errEl.removeAttribute('role');
        errEl.removeAttribute('tabindex');
        errEl.removeAttribute('title');
      }
    } catch (e) {}
  }

  function getMonacoModelMarkers(opts) {
    try {
      if (!_monaco) return null;
      const api = window.monaco;
      if (!api || !api.editor || typeof api.editor.getModelMarkers !== 'function') return null;
      const model = (_monaco.getModel && _monaco.getModel()) ? _monaco.getModel() : null;
      if (!model || !model.uri) return null;
      const o = opts || {};
      const markers = api.editor.getModelMarkers({
        resource: model.uri,
        owner: o.anyOwner ? undefined : String(o.owner || 'xkeen'),
      }) || [];
      const errSeverity = (api.MarkerSeverity && api.MarkerSeverity.Error) ? api.MarkerSeverity.Error : 8;
      const filtered = markers.filter((m) => {
        if (!m) return false;
        if (o.excludeOwner && String(m.owner || '') === String(o.excludeOwner)) return false;
        if (o.errorsOnly === false) return true;
        return Number(m.severity || 0) >= errSeverity;
      });
      filtered.sort((a, b) => {
        const aOwn = String(a && a.owner || '');
        const bOwn = String(b && b.owner || '');
        if (o.preferNonOwner) {
          const owner = String(o.preferNonOwner);
          const aPenalty = aOwn === owner ? 1 : 0;
          const bPenalty = bOwn === owner ? 1 : 0;
          if (aPenalty !== bPenalty) return aPenalty - bPenalty;
        }
        const aLine = Number(a && a.startLineNumber || 0);
        const bLine = Number(b && b.startLineNumber || 0);
        if (aLine !== bLine) return aLine - bLine;
        return Number(a && a.startColumn || 0) - Number(b && b.startColumn || 0);
      });
      return filtered;
    } catch (e) {}
    return [];
  }

  function getMonacoMarkerErrorLocation(opts) {
    try {
      const markers = getMonacoModelMarkers(opts);
      const m = markers && markers.length ? markers[0] : null;
      if (!m) return null;
      return {
        line: Number.isFinite(m.startLineNumber) ? m.startLineNumber : 1,
        col: Number.isFinite(m.startColumn) ? m.startColumn : 1,
        index: null,
        message: String(m.message || ''),
        owner: String(m.owner || ''),
      };
    } catch (e) {}
    return null;
  }

  function jumpToJsonErrorLocation() {
    let loc = _lastJsonErrorLocation || null;
    if ((!loc || (!loc.line && loc.index == null)) && _engine === 'monaco') {
      loc = getMonacoMarkerErrorLocation({ anyOwner: true, preferNonOwner: 'xkeen', excludeOwner: '' });
    }
    if (!loc) return false;

    const raw = String(getEditorText() || '');

    try {
      const analysis = getJsoncAnalysis(raw, { preciseLocation: true });
      if (analysis && !analysis.ok && analysis.loc) loc = analysis.loc;
    } catch (e) {}

    if (_engine === 'monaco' && _monaco) {
      try {
        let line = Number.isFinite(loc.line) ? loc.line : null;
        let col = Number.isFinite(loc.col) ? loc.col : null;
        if ((!line || !col) && Number.isFinite(loc.index)) {
          const lc = indexToMonacoLineCol(raw, loc.index);
          line = lc.line;
          col = lc.col;
        }
        if (!line || !col) {
          const markerLoc = getMonacoMarkerErrorLocation();
          if (markerLoc) {
            line = markerLoc.line;
            col = markerLoc.col;
          }
        }
        line = Math.max(1, Number(line || 1));
        col = Math.max(1, Number(col || 1));
        if (_monaco.focus) _monaco.focus();
        if (_monaco.setPosition) _monaco.setPosition({ lineNumber: line, column: col });
        if (_monaco.setSelection) {
          _monaco.setSelection({
            startLineNumber: line,
            startColumn: col,
            endLineNumber: line,
            endColumn: col + 1,
          });
        }
        if (_monaco.revealPositionInCenter) {
          _monaco.revealPositionInCenter({ lineNumber: line, column: col });
        } else if (_monaco.revealLineInCenter) {
          _monaco.revealLineInCenter(line);
        }
        return true;
      } catch (e) {}
    }

    if (_cm) {
      try {
        let line0 = Number.isFinite(loc.line) ? Math.max(0, loc.line - 1) : null;
        let ch0 = Number.isFinite(loc.col) ? Math.max(0, loc.col - 1) : null;
        if ((line0 === null || ch0 === null) && Number.isFinite(loc.index)) {
          const lc = posToLineCh(raw, loc.index);
          line0 = lc.line;
          ch0 = lc.ch;
        }
        line0 = Math.max(0, Number(line0 || 0));
        ch0 = Math.max(0, Number(ch0 || 0));
        let endCh0 = ch0;
        try {
          const lineText = (typeof _cm.getLine === 'function') ? String(_cm.getLine(line0) || '') : '';
          endCh0 = Math.min(lineText.length, ch0 + 1);
        } catch (e2) {}
        if (endCh0 < ch0) endCh0 = ch0;
        if (typeof _cm.revealLine === 'function') _cm.revealLine(line0 + 1);
        else if (typeof _cm.scrollIntoView === 'function') _cm.scrollIntoView({ line: line0, ch: ch0 }, 120);
        else if (typeof _cm.scrollTo === 'function') _cm.scrollTo(null, Math.max(0, line0 * 20));
        if (typeof _cm.setSelections === 'function') {
          _cm.setSelections([{
            anchor: { line: line0, ch: ch0 },
            head: { line: line0, ch: endCh0 },
          }]);
        } else if (typeof _cm.setSelection === 'function') {
          _cm.setSelection(
            { line: line0, ch: ch0 },
            { line: line0, ch: endCh0 }
          );
        } else if (typeof _cm.setCursor === 'function') {
          _cm.setCursor({ line: line0, ch: ch0 });
        }
        if (typeof _cm.focus === 'function') _cm.focus();
        return true;
      } catch (e) {}
    }

    return false;
  }

  function setError(message, line /* 0-based */, options) {
    const opts = (options && typeof options === 'object') ? options : null;
    const autoScroll = !!(opts && opts.scroll);
    const errEl = $(IDS.error);
    if (errEl) errEl.textContent = String(message ?? '');
    if (!String(message ?? '')) clearJsonErrorLocation();

    clearErrorMarker();

    if (_engine === 'monaco') return;
    if (!_cm) return;

    if (!String(message ?? '')) {
      clearCodeMirrorDiagnostics();
      return;
    }

    if (typeof line === 'number' && line >= 0) {
      applyCodeMirrorDiagnostics([{
        line: Math.max(1, line + 1),
        column: 1,
        length: 1,
        severity: 'error',
        source: 'routing-jsonc',
        message: String(message || 'JSON parse error'),
      }]);
      if (autoScroll) {
        try {
          if (typeof _cm.revealLine === 'function') _cm.revealLine(line + 1);
          else if (typeof _cm.scrollIntoView === 'function') _cm.scrollIntoView({ line, ch: 0 }, 200);
        } catch (e) {}
      }
    }
  }

  function extractJsonErrorPos(err) {
    const msg = String(err && err.message ? err.message : '');
    const m = /(?:at\s+)?position\s+(\d+)/i.exec(msg);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  function extractJsonErrorLineCol(err) {
    const directLine = Number.isFinite(err && err.lineNumber) ? Math.floor(err.lineNumber)
      : (Number.isFinite(err && err.line) ? Math.floor(err.line) : null);
    const directCol = Number.isFinite(err && err.columnNumber) ? Math.floor(err.columnNumber)
      : (Number.isFinite(err && err.column) ? Math.floor(err.column) : null);
    if (directLine && directCol) {
      return { line: Math.max(1, directLine), col: Math.max(1, directCol) };
    }

    const msg = String(err && err.message ? err.message : err || '');
    const m = /line\s+(\d+)\D+column\s+(\d+)/i.exec(msg);
    if (!m) return null;
    const line = parseInt(m[1], 10);
    const col = parseInt(m[2], 10);
    if (!Number.isFinite(line) || !Number.isFinite(col)) return null;
    return { line: Math.max(1, line), col: Math.max(1, col) };
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

  function lineColToIndex(text, line1, col1) {
    const s = String(text ?? '');
    const targetLine = Math.max(1, Number.isFinite(line1) ? Math.floor(line1) : 1);
    const targetCol = Math.max(1, Number.isFinite(col1) ? Math.floor(col1) : 1);

    let line = 1;
    let i = 0;
    while (i < s.length && line < targetLine) {
      if (s.charCodeAt(i) === 10) line++;
      i++;
    }
    return Math.max(0, Math.min(i + targetCol - 1, s.length));
  }

  // ------------------------ Monaco diagnostics (JSON markers) ------------------------

  function stripJsonCommentsWithMap(input) {
    // Returns { cleaned, map } where removed comment chars are replaced with
    // whitespace. This keeps line/column positions stable for parser errors.
    const raw = String(input ?? '');
    const cleaned = [];
    const map = [];

    function pushMapped(ch, rawIndex) {
      cleaned.push(ch);
      map.push(rawIndex);
    }

    let inString = false;
    let escape = false;
    let i = 0;
    const n = raw.length;

    while (i < n) {
      const ch = raw[i];

      if (inString) {
        pushMapped(ch, i);

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
        pushMapped(ch, i);
        i++;
        continue;
      }

      // Single-line comment //
      if (ch === '/' && i + 1 < n && raw[i + 1] === '/') {
        pushMapped(' ', i);
        pushMapped(' ', i + 1);
        i += 2;
        while (i < n && raw[i] !== '\n') {
          pushMapped(raw[i] === '\r' ? '\r' : ' ', i);
          i++;
        }
        continue;
      }

      // Single-line comment starting with #
      if (ch === '#') {
        pushMapped(' ', i);
        i++;
        while (i < n && raw[i] !== '\n') {
          pushMapped(raw[i] === '\r' ? '\r' : ' ', i);
          i++;
        }
        continue;
      }

      // Multi-line comment /* ... */
      if (ch === '/' && i + 1 < n && raw[i + 1] === '*') {
        pushMapped(' ', i);
        pushMapped(' ', i + 1);
        i += 2;
        while (i < n) {
          if (i + 1 < n && raw[i] === '*' && raw[i + 1] === '/') {
            pushMapped(' ', i);
            pushMapped(' ', i + 1);
            i += 2;
            break;
          }
          pushMapped((raw[i] === '\n' || raw[i] === '\r') ? raw[i] : ' ', i);
          i++;
        }
        continue;
      }

      pushMapped(ch, i);
      i++;
    }

    return { cleaned: cleaned.join(''), map };
  }

  function probeJsonlintErrorLocation(cleanedText) {
    try {
      const lint = window.jsonlint && (window.jsonlint.parser || window.jsonlint);
      if (!lint || typeof lint.parse !== 'function') return null;

      const prevParseError = lint.parseError;
      let captured = null;
      lint.parseError = function(message, info) {
        captured = { message, info };
        const err = new Error(String(message || 'JSON parse error'));
        err.__xkJsonlintInfo = info || null;
        throw err;
      };

      try {
        lint.parse(String(cleanedText ?? ''));
      } catch (err) {
        const info = (captured && captured.info) || err.__xkJsonlintInfo || null;
        const loc = info && info.loc ? info.loc : null;
        if (!loc) return null;
        return {
          message: String((captured && captured.message) || err.message || 'JSON parse error'),
          line: Number.isFinite(loc.first_line) ? Math.max(1, Math.floor(loc.first_line)) : null,
          col: Number.isFinite(loc.first_column) ? Math.max(1, Math.floor(loc.first_column) + 1) : null,
        };
      } finally {
        lint.parseError = prevParseError;
      }
    } catch (e) {}
    return null;
  }

  function probeRuntimeJsonLintLocation(cleanedText) {
    try {
      const runtime = getEditorRuntime('codemirror', { mode: 'application/json' });
      if (!runtime || typeof runtime.validateText !== 'function') return null;
      const result = runtime.validateText(String(cleanedText ?? ''), { mode: 'application/json' }) || {};
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
      const diag = diagnostics.length ? diagnostics[0] : null;
      if (!diag) return null;
      const point = Number.isFinite(diag.line) && Number.isFinite(diag.column)
        ? { line: Math.max(1, Math.floor(diag.line)), col: Math.max(1, Math.floor(diag.column)) }
        : indexToMonacoLineCol(String(cleanedText ?? ''), Number.isFinite(diag.from) ? diag.from : 0);
      return {
        message: String(diag.message || result.summary || 'JSON parse error'),
        line: Number.isFinite(point && point.line) ? Math.max(1, Math.floor(point.line)) : null,
        col: Number.isFinite(point && point.col) ? Math.max(1, Math.floor(point.col)) : null,
      };
    } catch (e) {}
    return null;
  }

  function extractJsonErrorLocation(err, rawText, stripMap, opts) {
    const raw = String(rawText ?? '');
    const sm = stripMap && typeof stripMap === 'object' ? stripMap : stripJsonCommentsWithMap(raw);
    const cleaned = String(sm && sm.cleaned != null ? sm.cleaned : '');
    const map = Array.isArray(sm && sm.map) ? sm.map : [];
    const preciseLocation = shouldUsePreciseJsonLocation(opts);
    // Keep Safari live validation on the cheap path; exact coordinates still come
    // from explicit preciseLocation flows such as save/error modal handling.
    const wantsParserProbe = preciseLocation;

    const out = {
      message: String((err && err.message) ? err.message : err || 'JSON parse error'),
      index: 0,
      line: 1,
      col: 1,
    };

    let cleanedIndex = extractJsonErrorPos(err);
    let lineCol = null;
    let probed = null;

    if (wantsParserProbe) {
      probed = probeRuntimeJsonLintLocation(cleaned);
      if (!probed) {
        probed = probeJsonlintErrorLocation(cleaned);
      }
      // Browser-provided JSON.parse locations are inconsistent across engines.
      // Safari often reports EOF even when the syntax error is much earlier.
      if (probed && probed.line && probed.col) {
        lineCol = { line: probed.line, col: probed.col };
        if (probed.message) out.message = String(probed.message);
      }
    }

    if ((cleanedIndex == null || !Number.isFinite(cleanedIndex)) && !lineCol) {
      lineCol = extractJsonErrorLineCol(err);
    }

    if (lineCol) {
      cleanedIndex = lineColToIndex(cleaned, lineCol.line, lineCol.col);
    }

    if (!Number.isFinite(cleanedIndex)) cleanedIndex = 0;

    let rawIndex = 0;
    if (map.length) {
      if (cleanedIndex >= map.length) rawIndex = raw.length;
      else rawIndex = map[Math.max(0, cleanedIndex)];
    } else {
      rawIndex = Math.max(0, Math.min(cleanedIndex, raw.length));
    }

    const lc = posToLineCh(raw, rawIndex);
    out.index = rawIndex;
    out.line = lc.line + 1;
    out.col = lc.ch + 1;
    return out;
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
      clearJsonErrorLocation();
      _lastValidationState = { ok: false, message: 'Файл пуст' };
      try { updateEditorMetaStatus(); } catch (e) {}
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
      clearJsonErrorLocation();
      clearMonacoMarkers();
      _maybeUpdateModeFromParsed(obj);
      _lastValidationState = { ok: true, message: 'JSON корректен' };
      try { updateEditorMetaStatus(); } catch (e) {}
      return true;
    } catch (e) {
      const loc = extractJsonErrorLocation(e, raw, sm);
      const msg = String(loc && loc.message ? loc.message : ((e && e.message) ? e.message : e));
      const lc = { line: loc.line, col: loc.col };

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

      const errMsg = 'Ошибка JSON: ' + msg;
      setError(errMsg, null);
      setJsonErrorLocation({ line: lc.line, col: lc.col, index: loc.index });
      _lastValidationState = { ok: false, message: errMsg };
      try { updateEditorMetaStatus(); } catch (e4) {}
      return false;
    }
  }

  function scheduleMonacoDiagnostics() {
    try { if (_monacoDiagTimer) clearTimeout(_monacoDiagTimer); } catch (e) {}
    const wait = Math.max(350, currentValidateDebounceMs());
    _monacoDiagTimer = setTimeout(() => {
      _monacoDiagTimer = null;
      try {
        if (_engine === 'monaco' && _monaco) runMonacoDiagnostics();
      } catch (e) {}
    }, wait);
  }


  function showRoutingJsonErrorModal(err, rawText) {
    try {
      const raw = String(rawText == null ? getEditorText() : rawText);
      const sm = stripJsonCommentsWithMap(raw);
      const loc = extractJsonErrorLocation(err, raw, sm);
      const msg = String(loc && loc.message ? loc.message : ((err && err.message) ? err.message : (err || 'JSON parse error')));
      const line = Number.isFinite(loc && loc.line) ? loc.line : null;
      const col = Number.isFinite(loc && loc.col) ? loc.col : null;
      const hint = line && col
        ? ('Проверьте строку ' + line + ', столбец ' + col + '. Конфиг не отправлялся на сервер.')
        : 'Конфиг не отправлялся на сервер. Исправьте синтаксис JSON и попробуйте снова.';
      const payload = {
        error: msg,
        hint: hint,
        phase: 'json_parse',
        cmd: 'JSON.parse(stripJsonComments(...))',
        stderr: msg + (line && col ? ('\nline: ' + line + ', column: ' + col) : ''),
        stdout: '',
      };
      if (line && col) {
        payload.location = { line: line, column: col };
      }
      const open = () => {
        try {
          const showPreflightError = getShowXrayPreflightErrorApi();
          if (typeof showPreflightError === 'function') {
            showPreflightError(payload);
            return true;
          }
        } catch (e) {}
        return false;
      };
      if (open()) return;

      Promise.resolve(ensureXrayPreflightReady()).then(() => {
        open();
      }).catch(() => {});
    } catch (e) {}
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
	      try { _suppressDirty++; } catch (e) {}
	      try { setEditorTextAll(text); } finally {
	        try { _suppressDirty = Math.max(0, _suppressDirty - 1); } catch (e) { _suppressDirty = 0; }
	      }

      const savedView = loadSavedViewState(file);
      if (!(savedView && restoreViewState(savedView))) {
        scrollEditorsTop();
      }
      try { updateEditorMetaStatus(); } catch (e) {}

      try { _setRoutingMode(_detectRoutingModeFromText(text), 'load'); } catch (e) {}

      try {
        // Keep compatibility with existing monolith flags, if present.
        setRoutingSavedContent(text);
        setRoutingDirty(false);
        const saveBtn = $(IDS.btnSave);
        if (saveBtn) saveBtn.classList.remove('dirty');
      } catch (e) {}
	      try { syncDirtyUi(false); } catch (e) {}

      const okJson = validate();
      try { scheduleEditorContentEvent('load', 30); } catch (e) {}
      if (statusEl) statusEl.textContent = okJson ? (_routingMode === 'routing' ? 'Routing загружен.' : 'Файл загружен.') : 'Файл загружен, но содержит ошибку JSON.';
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = getXkeenFilePath('routing', '');
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
    const analysis = getJsoncAnalysis(rawText, { preciseLocation: true });
    if (analysis.ok) {
      setError('', null);
      clearJsonErrorLocation();
    } else {
      const loc = analysis.loc || { line: 1, col: 1, index: 0 };
      const message = String(analysis.message || (analysis.error && analysis.error.message) || 'JSON parse error');
      setError('Ошибка JSON: ' + message, loc.line - 1);
      setJsonErrorLocation({ line: loc.line, col: loc.col, index: loc.index });
      showRoutingJsonErrorModal(analysis.error, rawText);
      if (statusEl) statusEl.textContent = 'Ошибка: некорректный JSON.';
      toast('Ошибка: некорректный JSON.', true);
      return;
    }

    const restart = shouldAutoRestartAfterSave();

    if (restart && _restartJobRunning) {
      if (statusEl) statusEl.textContent = 'Перезапуск уже выполняется…';
      toast('Перезапуск уже выполняется…', 'info');
      return;
    }

    const saveBtn = $(IDS.btnSave);
    const setBtnBusy = (busy) => {
      if (!saveBtn) return;
      try { saveBtn.disabled = !!busy; } catch (e) {}
      try { saveBtn.classList.toggle('is-busy', !!busy); } catch (e) {}
    };

    const clearRestartLogUi = async () => {
      try {
        const api = await getRestartLogFeatureApi();
        if (api && typeof api.prepareLiveStream === 'function') {
          api.prepareLiveStream({ clear: true, reveal: true });
          return;
        }
      } catch (e) {}
      try {
        const api = await getRestartLogFeatureApi();
        if (api && typeof api.reveal === 'function') {
          api.reveal();
        }
      } catch (e) {}
      try {
        const api = await getRestartLogFeatureApi();
        if (api && typeof api.setRaw === 'function') {
          api.setRaw('');
          return;
        }
      } catch (e) {}
      try {
        const api = await getRestartLogFeatureApi();
        if (api && typeof api.clear === 'function') {
          api.clear();
          return;
        }
      } catch (e) {}

      const els = [];
      try {
        document.querySelectorAll('[data-xk-restart-log="1"]').forEach((el) => {
          if (el) els.push(el);
        });
      } catch (e) {}
      try {
        const legacy = document.getElementById('restart-log');
        if (legacy && els.indexOf(legacy) === -1) els.push(legacy);
      } catch (e) {}
      els.forEach((el) => {
        try { el.dataset.rawText = ''; } catch (e) {}
        try { el.innerHTML = ''; } catch (e) {}
        try { el.scrollTop = 0; } catch (e) {}
      });
    };

    const appendRestartLog = async (chunk) => {
      if (!chunk) return;
      try {
        const api = await getRestartLogFeatureApi();
        if (api && typeof api.append === 'function') {
          api.append(String(chunk));
          return;
        }
      } catch (e) {}
      const els = [];
      try {
        document.querySelectorAll('[data-xk-restart-log="1"]').forEach((el) => {
          if (el) els.push(el);
        });
      } catch (e) {}
      try {
        const legacy = document.getElementById('restart-log');
        if (legacy && els.indexOf(legacy) === -1) els.push(legacy);
      } catch (e) {}
      els.forEach((el) => {
        try {
          const prev = el.textContent || '';
          el.textContent = prev + String(chunk);
          el.scrollTop = el.scrollHeight;
        } catch (e) {}
      });
    };

    try {
      const file = getActiveFragment();
      const url =
        '/api/routing?restart=' + (restart ? '1' : '0') +
        (restart ? '&async=1' : '') +
        (file ? ('&file=' + encodeURIComponent(file)) : '');

      setBtnBusy(true);

      // Save request (fast). Restart is handled as a background job when async=1.
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
          setRoutingSavedContent(rawText);
          setRoutingDirty(false);
          const saveBtn2 = $(IDS.btnSave);
          if (saveBtn2) saveBtn2.classList.remove('dirty');
        } catch (e) {}
	        try { syncDirtyUi(false); } catch (e) {}
        try { saveCurrentViewState(); } catch (e) {}

        let msg = (_routingMode === 'routing') ? 'Routing сохранён.' : 'Файл сохранён.';

        // Update activity bookkeeping
        try {
          if (typeof window.updateLastActivity === 'function') {
            const fp = getXkeenFilePath('routing', '');
            window.updateLastActivity('saved', 'routing', fp);
          }
        } catch (e) {}

        // Async job: stream full, colored output like terminal.
        const jobId = (data && (data.restart_job_id || data.job_id || data.restartJobId)) ? String(data.restart_job_id || data.job_id || data.restartJobId) : '';
        if (restart && jobId) {
          _restartJobRunning = true;
          if (statusEl) statusEl.textContent = msg + ' Перезапуск…';
          await clearRestartLogUi();
          await appendRestartLog('⏳ Запуск xkeen -restart (job)…\n');

          const CJ = getCommandJobApi();
          let result = null;

          if (CJ && typeof CJ.waitForCommandJob === 'function') {
            result = await CJ.waitForCommandJob(jobId, {
              maxWaitMs: 5 * 60 * 1000,
              onChunk: (chunk) => { try { void appendRestartLog(chunk); } catch (e) {} }
            });
          } else {
            // Minimal HTTP polling fallback.
            let lastLen = 0;
            while (true) {
              const pr = await fetch(`/api/run-command/${encodeURIComponent(jobId)}`);
              const pj = await pr.json().catch(() => ({}));
              const out = (pj && typeof pj.output === 'string') ? pj.output : '';
              if (out.length > lastLen) {
                await appendRestartLog(out.slice(lastLen));
                lastLen = out.length;
              }
              if (!pr.ok || pj.ok === false || pj.status === 'finished' || pj.status === 'error') {
                result = pj;
                break;
              }
              await new Promise(r => setTimeout(r, 1000));
            }
          }

          const ok = !!(result && result.ok);
          if (ok) {
            if (statusEl) statusEl.textContent = 'Готово';
            toast('Готово', false);
          } else {
            if (statusEl) statusEl.textContent = 'Ошибка';
            toast('Ошибка', true);

            const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
            const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
            const detail = err ? ('Ошибка: ' + err) : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : '');
            if (detail) { try { await appendRestartLog('\n' + detail + '\n'); } catch (e) {} }
          }

          return ok;
        }

        // Legacy / non-async: keep previous UX (save toast, restart toast handled elsewhere).
        if (statusEl) statusEl.textContent = msg;
        if (!data || !data.restarted) {
          toast(msg, false);
        }
        return true;
      } else {
        const msg = 'Save error: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status) || 'неизвестная ошибка');
        if (statusEl) statusEl.textContent = msg;
        toast(msg, true);
        return false;
      }
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Ошибка при сохранении файла.';
      toast('Ошибка при сохранении файла.', true);
      return false;
    } finally {
      _restartJobRunning = false;
      setBtnBusy(false);
    }
  }


  function runMonacoDiagnostics() {
    const raw = getEditorText();
    const safari = isWebKitSafari();

    if (!String(raw ?? '').trim()) {
      setError('File is empty. Enter valid JSON.', null);
      clearJsonErrorLocation();
      _lastValidationState = { ok: false, message: 'Empty file' };
      try { updateEditorMetaStatus(); } catch (e) {}
      try {
        const api = window.monaco;
        const sev = (api && api.MarkerSeverity && api.MarkerSeverity.Error) ? api.MarkerSeverity.Error : 8;
        setMonacoMarkers([{
          severity: sev,
          message: 'Empty file',
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        }]);
      } catch (e) {}
      return false;
    }

    const analysis = getJsoncAnalysis(raw, { preciseLocation: false });
    if (analysis.ok) {
      setError('', null);
      clearJsonErrorLocation();
      clearMonacoMarkers();
      _maybeUpdateModeFromParsed(analysis.parsed);
      _lastValidationState = { ok: true, message: 'JSON is valid' };
      try { updateEditorMetaStatus(); } catch (e) {}
      return true;
    }

    let loc = analysis.loc || { line: 1, col: 1, index: 0 };
    let msg = String(analysis.message || 'JSON parse error');

    // Safari Monaco already has native JSON markers with reliable coordinates.
    // Prefer them over our local parser result when available.
    const nativeMarker = safari
      ? getMonacoMarkerErrorLocation({ anyOwner: true, preferNonOwner: 'xkeen', excludeOwner: 'xkeen' })
      : null;
    if (nativeMarker && nativeMarker.line && nativeMarker.col) {
      loc = {
        line: nativeMarker.line,
        col: nativeMarker.col,
        index: null,
      };
      if (nativeMarker.message) msg = String(nativeMarker.message);
    }

    if (!(safari && nativeMarker)) {
      try {
        const api = window.monaco;
        const sev = (api && api.MarkerSeverity && api.MarkerSeverity.Error) ? api.MarkerSeverity.Error : 8;
        setMonacoMarkers([{
          severity: sev,
          message: msg,
          startLineNumber: loc.line,
          startColumn: loc.col,
          endLineNumber: loc.line,
          endColumn: loc.col + 1,
        }]);
      } catch (e) {}
    } else {
      clearMonacoMarkers();
    }

    const errMsg = 'JSON error: ' + msg;
    setError(errMsg, null);
    setJsonErrorLocation({ line: loc.line, col: loc.col, index: loc.index, message: msg });
    _lastValidationState = { ok: false, message: errMsg };
    try { updateEditorMetaStatus(); } catch (e) {}

    if (safari) {
      try {
        setTimeout(() => {
          if (_engine !== 'monaco' || !_monaco) return;
          const refreshed = getMonacoMarkerErrorLocation({ anyOwner: true, preferNonOwner: 'xkeen', excludeOwner: 'xkeen' });
          if (!refreshed || !refreshed.line || !refreshed.col) return;
          const refreshedMsg = String(refreshed.message || msg || 'JSON parse error');
          setError('JSON error: ' + refreshedMsg, null);
          setJsonErrorLocation({ line: refreshed.line, col: refreshed.col, index: null, message: refreshedMsg });
          _lastValidationState = { ok: false, message: 'JSON error: ' + refreshedMsg };
          try { updateEditorMetaStatus(); } catch (e2) {}
        }, 80);
      } catch (e) {}
    }

    return false;
  }

  function showRoutingJsonErrorModal(err, rawText) {
    try {
      const raw = String(rawText == null ? getEditorText() : rawText);
      const analysis = getJsoncAnalysis(raw, { preciseLocation: true });
      const loc = analysis.loc || extractJsonErrorLocation(err, raw, null, { preciseLocation: true });
      const msg = String(analysis.message || (loc && loc.message) || ((err && err.message) ? err.message : (err || 'JSON parse error')));
      const line = Number.isFinite(loc && loc.line) ? loc.line : null;
      const col = Number.isFinite(loc && loc.col) ? loc.col : null;
      const hint = line && col
        ? ('Check line ' + line + ', column ' + col + '. The config was not sent to the server.')
        : 'The config was not sent to the server. Fix the JSON syntax and try again.';
      const payload = {
        error: msg,
        hint: hint,
        phase: 'json_parse',
        cmd: 'JSON.parse(stripJsonComments(...))',
        stderr: msg + (line && col ? ('\nline: ' + line + ', column: ' + col) : ''),
        stdout: '',
      };
      if (line && col) payload.location = { line: line, column: col };
      const open = () => {
        try {
          const showPreflightError = getShowXrayPreflightErrorApi();
          if (typeof showPreflightError === 'function') {
            showPreflightError(payload);
            return true;
          }
        } catch (e) {}
        return false;
      };
      if (open()) return;

      Promise.resolve(ensureXrayPreflightReady()).then(() => {
        open();
      }).catch(() => {});
    } catch (e) {}
  }

  function validate() {
    try {
      if (_engine === 'monaco' && _monaco) return runMonacoDiagnostics();
    } catch (e) {}

    const raw = getEditorText();
    if (!String(raw ?? '').trim()) {
      setError('File is empty. Enter valid JSON.', null);
      clearJsonErrorLocation();
      _lastValidationState = { ok: false, message: 'Empty file' };
      try { updateEditorMetaStatus(); } catch (e) {}
      try { syncCodeMirrorLintNow(); } catch (e2) {}
      return false;
    }

    const analysis = getJsoncAnalysis(raw, { preciseLocation: true });
    if (analysis.ok) {
      setError('', null);
      clearJsonErrorLocation();
      _maybeUpdateModeFromParsed(analysis.parsed);
      _lastValidationState = { ok: true, message: 'JSON is valid' };
      try { updateEditorMetaStatus(); } catch (e) {}
      try { syncCodeMirrorLintNow(); } catch (e2) {}
      return true;
    }

    const loc = analysis.loc || { line: 1, col: 1, index: 0 };
    const errMsg = 'JSON error: ' + String(analysis.message || 'JSON parse error');
    setError(errMsg, loc.line - 1);
    setJsonErrorLocation({ line: loc.line, col: loc.col, index: loc.index });
    _lastValidationState = { ok: false, message: errMsg };
    try { updateEditorMetaStatus(); } catch (e) {}
    try { syncCodeMirrorLintNow(); } catch (e2) {}
    return false;
  }


  async function resetToSaved() {
    const saved = _getSavedContent();
    const current = getEditorText();
    const dirty = _isDirtyText(current, saved);

    if (!dirty) {
      toast('Изменений нет — откатывать нечего.', 'info');
      return;
    }

    const confirmApi = getConfirmApi();
    const ok = await (typeof confirmApi === 'function'
      ? confirmApi({
          title: 'Откатить изменения?',
          message: 'Вернуть текст редактора к последней сохранённой версии? Все несохранённые правки будут потеряны.',
          okText: 'Откатить',
          cancelText: 'Отмена',
          danger: true,
        })
      : Promise.resolve(window.confirm('Вернуть текст редактора к последней сохранённой версии? Несохранённые правки будут потеряны.')));
    if (!ok) return;

    try { _suppressDirty++; } catch (e) {}
    try {
      setEditorTextAll(saved);
      scrollEditorsTop();
    } finally {
      try { _suppressDirty = Math.max(0, _suppressDirty - 1); } catch (e) { _suppressDirty = 0; }
    }

    try { setRoutingDirty(false); } catch (e) {}
    try { syncDirtyUi(false); } catch (e) {}
    try { saveCurrentViewState(); } catch (e) {}

    // Discard local edits in routing cards by reloading from the editor.
    try {
      const routingCardsApi = getRoutingCardsFeatureApi();
      const ctrl = routingCardsApi && routingCardsApi.rules ? routingCardsApi.rules.controls : null;
      if (ctrl && typeof ctrl.renderFromEditor === 'function') {
        ctrl.renderFromEditor({ setError: false });
      }
    } catch (e) {}

    try { validate(); } catch (e) {}
    setStatus('Изменения откатены.', false);
  }

  async function getPreferPrettierFlag() {
    // Load server settings only on demand (no auto-fetch on page load).
    try {
      const settingsApi = getUiSettingsApi();
      if (settingsApi) {
        if (typeof settingsApi.fetchOnce === 'function') {
          const st = await settingsApi.fetchOnce().catch(() => null);
          if (st && st.format && typeof st.format.preferPrettier === 'boolean') {
            return !!st.format.preferPrettier;
          }
        }
        if (typeof settingsApi.get === 'function') {
          const st2 = settingsApi.get();
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
        await ensureFormattersReady();
      } catch (e) {}
      try {
        const F = getFormattersApi();
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
    setEditorTextAll(cleaned, { reason: 'clear-comments', wait: 40 });
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
          const backupsApi = getBackupsFeatureApi();
          if (backupsApi) {
            if (typeof backupsApi.refresh === 'function') await backupsApi.refresh();
            else if (typeof backupsApi.load === 'function') await backupsApi.load();
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

  async function restoreAuto(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
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
        } else {
          const routingPath = getXkeenFilePath('routing', '');
          if (routingPath) label = String(routingPath).split(/[\\/]/).pop() || label;
        }
      } catch (e) {}
    } else {
      label = file ? String(file).split(/[\\/]/).pop() : 'выбранный файл';
    }

    if (!o.confirmed) {
      if (!confirm('Восстановить из авто-бэкапа файл ' + label + '?')) return;
    }

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
	    wireButton(IDS.btnReset, resetToSaved);
    wireButton(IDS.btnFormat, format);
    bindConfigAction(IDS.btnBackup, backup, { kind: 'backup' });
    bindConfigAction(IDS.btnRestoreAuto, () => restoreAuto({ confirmed: true }), { kind: 'restoreAuto' });

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
        const prev = _activeFragment || String(fragSel.dataset.current || '');
        const dir = fragSel.dataset && fragSel.dataset.dir ? String(fragSel.dataset.dir) : _fragmentDir;
        await guardFragmentSwitch(next, prev, {
          onCancel: () => restoreFragmentSelection(fragSel, prev, dir, _fragmentItems),
          beforeSwitch: () => { try { saveCurrentViewState(); } catch (e2) {} },
          commit: async () => {
            applyActiveFragment(next, dir);
            await load();
          },
        });
      });
      if (fragSel.dataset) fragSel.dataset.xkeenWired = '1';
    }

    // "All files" toggle for fragment selector (optional)
    const allCb = $(IDS.fragmentAllToggle);
    if (allCb && !(allCb.dataset && allCb.dataset.xkWired === '1')) {
      try { allCb.checked = restoreFragmentsScopeAll(); } catch (e) {}
      allCb.addEventListener('change', async () => {
        const enabled = !!allCb.checked;
        const prevEnabled = !enabled;
        const prevSel = getActiveFragment();
        const prevDir = _fragmentDir;
        rememberFragmentsScopeAll(enabled);
        await refreshFragmentsList({ notify: true, scopeChanged: enabled ? 'on' : 'off', prevSelection: prevSel });
        const nextSel = getActiveFragment();
        if (!nextSel || nextSel === prevSel) return;
        await guardFragmentSwitch(nextSel, prevSel, {
          onCancel: async () => {
            try { allCb.checked = prevEnabled; } catch (e2) {}
            rememberFragmentsScopeAll(prevEnabled);
            await refreshFragmentsList({ notify: false, prevSelection: prevSel });
            restoreFragmentSelection($(IDS.fragmentSelect), prevSel, prevDir, _fragmentItems);
          },
          beforeSwitch: () => { try { saveCurrentViewState(); } catch (e2) {} },
          commit: async () => { await load(); },
        });
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


    // Error line under editor: click/Enter to jump to exact JSON error location.
    const errEl = $(IDS.error);
    if (errEl && !(errEl.dataset && errEl.dataset.xkJumpWired === '1')) {
      const onJump = (e) => {
        try { if (e) { e.preventDefault(); e.stopPropagation(); } } catch (e2) {}
        try { jumpToJsonErrorLocation(); } catch (e3) {}
      };
      errEl.addEventListener('click', onJump);
      errEl.addEventListener('keydown', (e) => {
        const k = e && (e.key || e.code);
        if (k === 'Enter' || k === ' ' || k === 'Spacebar') onJump(e);
      });
      if (errEl.dataset) errEl.dataset.xkJumpWired = '1';
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
    if (!textarea) return null;

    const existing = getExistingRoutingCodeMirror(textarea);
    if (existing) return existing;

    const runtime = getEditorRuntime('codemirror', { mode: 'application/jsonc', allowComments: true });
    if (!runtime || typeof runtime.create !== 'function') return null;

    const initialLite = computeEditorPerfProfile(textarea.value || '').lite;

    // If main.js provides shared keybindings, reuse them.
    let cmExtraKeysCommon = null;
    try {
      cmExtraKeysCommon = buildXkeenEditorCommonKeys();
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

    const cm = runtime.create(textarea, {
      mode: 'application/jsonc',
      language: 'jsonc',
      allowComments: true,
      theme: 'material-darker',
      lineNumbers: true,
      styleActiveLine: !initialLite,
      showIndentGuides: !initialLite,
      matchBrackets: !initialLite,
      autoCloseBrackets: true,
      highlightSelectionMatches: !initialLite,
      showTrailingSpace: !initialLite,
      rulers: initialLite ? [] : [{ column: 120 }],
      lineWrapping: !initialLite,
      foldGutter: !initialLite,
      gutters: initialLite
        ? ['CodeMirror-linenumbers', 'CodeMirror-lint-markers']
        : ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers'],
      maxHighlightLength: initialLite ? PERF_LIMITS.highlightLengthLite : 10000,
      crudeMeasuringFrom: initialLite ? PERF_LIMITS.measureFromLite : 10000,
      lint: true,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys,
      links: !initialLite,
      viewportMargin: initialLite ? PERF_LIMITS.viewportMarginLite : Infinity,
    });

    // Cosmetic class + toolbar
    // IMPORTANT: Keep ONLY one help entry in the toolbar.
    // The default CodeMirror help (red '?') is removed, because its purpose overlaps with
    // our routing comments help. We keep the yellow JSONC help button only.
    try {
      if (cm.getWrapperElement) {
        const wrapper = cm.getWrapperElement();
        wrapper.classList.add('xkeen-cm');
        wrapper.classList.toggle('xk-cm-lite', !!initialLite);
        try { textarea.__xkRoutingCodeMirror = cm; } catch (e) {}
        try { wrapper.__xkRoutingCodeMirror = cm; } catch (e2) {}
        cleanupRoutingCodeMirrorWrappers(wrapper);
        const base = getXkeenEditorToolbarDefaultItems();
        if (base.length) {
          const icons = getXkeenEditorToolbarIcons();
          const items = [];
          let inserted = false;
          base.forEach((it) => {
            // Replace fullscreen action: in routing card it must work for the active engine
            // (CodeMirror or Monaco), not just CodeMirror.
            if (it && it.id === 'fs') {
              items.push(Object.assign({}, it, {
                onClick: () => toggleEditorFullscreen(cm),
              }));
              return;
            }
            // Drop the default CodeMirror help button (red '?').
            if (it && it.id === 'help') {
              if (!inserted) {
                items.push({
                  id: 'help_comments',
                  svg: icons.help || it.svg,
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
              svg: icons.help || '',
              label: 'Справка (комментарии)',
              fallbackHint: 'JSONC',
              isCommentsHelp: true,
              onClick: () => openHelp(),
            });
          }
          attachXkeenEditorToolbar(cm, items);
        }
      }
    } catch (e) {}
    _editorPerfProfile = {
      lite: !!initialLite,
      manualSync: !!initialLite,
      webkitSafari: false,
      lineCount: 1,
      charCount: 0,
    };
    try { syncRoutingCodeMirrorOverlays(!initialLite); } catch (e) {}

	    cm.on('change', () => {
	      if (_suppressDirty > 0) return;
	      invalidateEditorSnapshot();
	      scheduleValidate();
	      scheduleDirtyCheck();
	      scheduleEditorContentEvent('edit');
	    });
    try { cm.on('blur', () => {
      if (shouldManualCodeMirrorLint()) scheduleValidate(0);
      try { saveCurrentViewState({ updateMeta: false }); } catch (e2) {}
    }); } catch (e) {}
    try { cm.on('cursorActivity', () => {
      scheduleViewStateSave(null, { updateMeta: false, memoryOnly: false });
    }); } catch (e) {}
    try { cm.on('scroll', () => {
      scheduleViewStateSave(null, { updateMeta: false, memoryOnly: false });
    }); } catch (e) {}

    return cm;
  }

  function ensureCodeMirrorEditor() {
    if (_cm && typeof _cm.getWrapperElement === 'function') {
      if (!_cmFacade) _cmFacade = createRoutingCodeMirrorFacade(_cm);
      try { syncSharedRoutingEditor(_cm, _cmFacade, 'codemirror'); } catch (e) {}
      try { moveToolbarToHost(_cm); } catch (e) {}
      try { syncRoutingToolbarUi('codemirror'); } catch (e) {}
      return _cm;
    }

    const cm = createEditor();
    if (!cm) return null;

    _cm = cm;
    _cmFacade = createRoutingCodeMirrorFacade(_cm);
    try { syncSharedRoutingEditor(_cm, _cmFacade, 'codemirror'); } catch (e) {}
    try { moveToolbarToHost(_cm); } catch (e) {}
    try { syncRoutingToolbarUi('codemirror'); } catch (e) {}
    return _cm;
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

  function buildRoutingToolbarButton(opts) {
    const o = opts || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xkeen-cm-tool'
      + (o.commentsHelp ? ' is-comments-help' : '');
    btn.setAttribute('aria-label', String(o.label || 'Действие'));
    if (o.actionId) btn.dataset.actionId = String(o.actionId);
    if (o.tip) btn.dataset.tip = String(o.tip);
    if (o.svg) btn.innerHTML = String(o.svg);
    else btn.textContent = String(o.fallbackText || '?');
    btn.addEventListener('click', (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
      try { if (typeof o.onClick === 'function') o.onClick(); } catch (err2) {}
    });
    return btn;
  }

  function ensureRoutingMonacoToolbar() {
    try {
      const host = document.getElementById('routing-toolbar-host');
      if (!host) return null;

      if (_cm && _cm._xkeenToolbarEl) {
        try { moveToolbarToHost(_cm); } catch (e) {}
        if (_routingMonacoToolbarEl) _routingMonacoToolbarEl.style.display = 'none';
        return _cm._xkeenToolbarEl;
      }

      let bar = _routingMonacoToolbarEl;
      if (!bar) {
        const icons = getXkeenEditorToolbarIcons();
        bar = document.createElement('div');
        bar.className = 'xkeen-cm-toolbar xk-routing-monaco-toolbar';
        bar.setAttribute('role', 'toolbar');
        bar.appendChild(buildRoutingToolbarButton({
          actionId: 'help_comments',
          label: 'Справка (комментарии)',
          tip: 'Справка (комментарии)',
          commentsHelp: true,
          svg: icons.help || '',
          fallbackText: '?',
          onClick: () => openHelp(),
        }));
        bar.appendChild(buildRoutingToolbarButton({
          actionId: 'fs',
          label: 'Полный экран',
          tip: 'Полный экран',
          svg: icons.fullscreen || '',
          fallbackText: '[]',
          onClick: () => toggleEditorFullscreen(null),
        }));
        _routingMonacoToolbarEl = bar;
      }

      if (!host.contains(bar)) host.appendChild(bar);
      bar.style.display = (_engine === 'monaco' && !_cm) ? '' : 'none';
      return bar;
    } catch (e) {}
    return null;
  }

  function syncRoutingToolbarUi(engine) {
    const next = normalizeEngine(engine || _engine);
    try {
      if (_cm && _cm._xkeenToolbarEl) {
        moveToolbarToHost(_cm);
        syncToolbarForEngine(next);
      }
    } catch (e) {}
    try {
      if (_routingMonacoToolbarEl) {
        _routingMonacoToolbarEl.style.display = (!_cm && next === 'monaco') ? '' : 'none';
      } else if (!_cm && next === 'monaco') {
        ensureRoutingMonacoToolbar();
      }
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

        const isFs = !!(btn.dataset && btn.dataset.actionId === 'fs');

        // In Monaco mode show only the yellow JSONC help + fullscreen.
        btn.style.display = (isMonaco && !(isCommentsHelp || isFs)) ? 'none' : '';
      });
    } catch (e) {}
  }

  // ------------------------ fullscreen (CodeMirror + Monaco) ------------------------

  function _syncToolbarFsClass(isFs) {
    try {
      if (_cm && _cm._xkeenToolbarEl) {
        _cm._xkeenToolbarEl.classList.toggle('is-fullscreen', !!isFs);
      }
    } catch (e) {}
  }

  function isMonacoFullscreen() {
    try {
      return !!(_monacoHostEl && _monacoHostEl.classList && _monacoHostEl.classList.contains('is-fullscreen'));
    } catch (e) {}
    return false;
  }

  function setMonacoFullscreen(on) {
    const host = ensureMonacoHost();
    if (!host) return;

    const enabled = !!on;
    const st = host.__xkFs || (host.__xkFs = { on: false, placeholder: null, parent: null, next: null });

    if (enabled) {
      if (!st.on) {
        st.on = true;
        try {
          st.parent = host.parentNode;
          st.next = host.nextSibling;
          st.placeholder = document.createComment('xk-routing-monaco-fs');
          if (st.parent) st.parent.insertBefore(st.placeholder, st.next);
        } catch (e) {}
        try { document.body.appendChild(host); } catch (e) {}
      }

      try { host.classList.add('is-fullscreen'); } catch (e) {}
      try { document.body.classList.add('xk-no-scroll'); } catch (e) {}
    } else {
      try { host.classList.remove('is-fullscreen'); } catch (e) {}
      try { document.body.classList.remove('xk-no-scroll'); } catch (e) {}

      if (st.on) {
        st.on = false;
        try {
          if (st.placeholder && st.placeholder.parentNode) {
            st.placeholder.parentNode.replaceChild(host, st.placeholder);
          } else if (st.parent) {
            st.parent.insertBefore(host, st.next || null);
          }
        } catch (e) {}
        st.placeholder = null;
        st.parent = null;
        st.next = null;
      }
    }

    // Keep toolbar visible and pinned (same behaviour as CodeMirror fullscreen).
    try { _syncToolbarFsClass(enabled); } catch (e) {}
    try {
      setTimeout(() => {
        try { _syncToolbarFsClass(enabled); } catch (e2) {}
      }, 0);
    } catch (e) {}

    // Monaco needs layout after container size/position change.
    try { if (_monaco && typeof _monaco.layout === 'function') _monaco.layout(); } catch (e) {}
    try {
      setTimeout(() => {
        try { if (_monaco && typeof _monaco.layout === 'function') _monaco.layout(); } catch (e2) {}
      }, 0);
    } catch (e) {}
    try { if (_monaco && typeof _monaco.focus === 'function') _monaco.focus(); } catch (e) {}
  }

  function wireMonacoFullscreenOnce() {
    if (_monacoFsWired) return;
    _monacoFsWired = true;

    // Exit Monaco fullscreen on Escape.
    document.addEventListener('keydown', (e) => {
      try {
        if (!e || e.key !== 'Escape') return;
        if (_engine !== 'monaco') return;
        if (!isMonacoFullscreen()) return;
        setMonacoFullscreen(false);
      } catch (err) {}
    }, true);
  }

  function toggleEditorFullscreen(cm) {
    if (_engine === 'monaco') {
      try { wireMonacoFullscreenOnce(); } catch (e) {}
      setMonacoFullscreen(!isMonacoFullscreen());
      return;
    }

    // CodeMirror: preserve the original behaviour.
    const ed = cm || _cm;
    try {
      if (ed && typeof ed.getOption === 'function' && typeof ed.setOption === 'function') {
        ed.setOption('fullScreen', !ed.getOption('fullScreen'));
      }
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
      const settingsApi = getUiSettingsApi();
      return !!(settingsApi && typeof settingsApi.isLoadedFromServer === 'function' && settingsApi.isLoadedFromServer());
    } catch (e) {}
    return false;
  }

  function _hasGlobalEditorEngine() {
    try {
      const editorEngineApi = getEditorEngineApi();
      return !!(editorEngineApi && typeof editorEngineApi.get === 'function' && typeof editorEngineApi.set === 'function');
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

  function hasExplicitEnginePreference() {
    try {
      if (_readLocal(GLOBAL_LS_KEY)) return true;
    } catch (e) {}
    try {
      if (_readLocal(LEGACY_LS_KEY)) return true;
    } catch (e) {}
    try {
      const settingsApi = getUiSettingsApi();
      if (_settingsLoadedFromServer() && settingsApi && typeof settingsApi.get === 'function') {
        const st = settingsApi.get();
        return !!normalizeEngine(st && st.editor ? st.editor.engine : null);
      }
    } catch (e) {}
    return false;
  }

  async function resolveInitialEnginePreference() {
    try { migrateLegacyEngineIfNeeded(); } catch (e) {}

    try {
      const localGlobal = normalizeEngine(_readLocal(GLOBAL_LS_KEY));
      if (localGlobal) return localGlobal;
    } catch (e) {}

    try {
      const localLegacy = normalizeEngine(_readLocal(LEGACY_LS_KEY));
      if (localLegacy) return localLegacy;
    } catch (e) {}

    try {
      if (_settingsLoadedFromServer()) {
        const cached = normalizeEngine(getPreferredEngine());
        if (cached) return cached;
      }
    } catch (e) {}

    try {
      const editorEngineApi = getEditorEngineApi();
      if (_hasGlobalEditorEngine() && editorEngineApi && typeof editorEngineApi.ensureLoaded === 'function') {
        const loaded = normalizeEngine(await editorEngineApi.ensureLoaded());
        if (loaded) return loaded;
      }
    } catch (e) {}

    return normalizeEngine(getPreferredEngine()) || 'codemirror';
  }

  function getPreferredEngine() {
    // Primary: global helper (which itself prefers server settings).
    if (_hasGlobalEditorEngine()) {
      try {
        const editorEngineApi = getEditorEngineApi();
        const global = normalizeEngine(editorEngineApi && typeof editorEngineApi.get === 'function' ? editorEngineApi.get() : null);
        if (global && (global !== 'codemirror' || hasExplicitEnginePreference() || !isMipsTarget())) {
          return global;
        }
      } catch (e) {}
    }

    // Fallback (shouldn't happen in new builds): cached settings.
    try {
      const settingsApi = getUiSettingsApi();
      if (settingsApi && typeof settingsApi.get === 'function') {
        const st = settingsApi.get();
        return normalizeEngine(st && st.editor ? st.editor.engine : null);
      }
    } catch (e) {}

    // Last resort: legacy local key.
    const legacy = _readLocal(LEGACY_LS_KEY);
    if (legacy) return normalizeEngine(legacy);
    return isMipsTarget() ? 'monaco' : 'codemirror';
  }

  function persistPreferredEngine(engine) {
    const next = normalizeEngine(engine);

    if (_hasGlobalEditorEngine()) {
      try {
        // Async best-effort (server first, fallback local).
        const editorEngineApi = getEditorEngineApi();
        const p = editorEngineApi ? editorEngineApi.set(next) : null;
        if (p && typeof p.then === 'function') p.catch(() => {});
      } catch (e) {}
      return;
    }

    // Very old fallback path: try PATCH server settings, otherwise write legacy LS.
    (async () => {
      let serverOk = false;
      try {
        const settingsApi = getUiSettingsApi();
        if (settingsApi && typeof settingsApi.patch === 'function') {
          await settingsApi.patch({ editor: { engine: next } });
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

      const editorEngineApi = getEditorEngineApi();
      if (_hasGlobalEditorEngine() && editorEngineApi && typeof editorEngineApi.onChange === 'function') {
        editorEngineApi.onChange((detail) => {
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
    const ta = $(IDS.textarea);
    if (!ta || !ta.parentNode) return null;

    let host = $(IDS.monacoContainer);
    let cmWrapper = null;
    try {
      if (_cm && typeof _cm.getWrapperElement === 'function') cmWrapper = _cm.getWrapperElement();
    } catch (e) {}

    if (!host) {
      host = document.createElement('div');
      host.id = IDS.monacoContainer;
      host.className = 'xk-monaco-editor';
      host.style.display = 'none';
    }

    // Keep Monaco in the same visual slot as the main routing editor.
    try {
      if (cmWrapper && cmWrapper.parentNode) {
        if (host !== cmWrapper.previousSibling) cmWrapper.parentNode.insertBefore(host, cmWrapper);
      } else if (ta.nextSibling) {
        if (host !== ta.nextSibling) ta.parentNode.insertBefore(host, ta.nextSibling);
      } else if (!host.parentNode) {
        ta.parentNode.appendChild(host);
      }
    } catch (e) {
      try {
        if (!host.parentNode) ta.parentNode.appendChild(host);
      } catch (e2) {}
    }

    _monacoHostEl = host;
    return host;
  }

  function _getEditorEngineHelper() {
    try {
      return getEditorEngineApi();
    } catch (e) {}
    return null;
  }

  const CM6_SCOPE = 'routing';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function getRoutingCm6Runtime() {
    try {
      return getCm6RuntimeApi();
    } catch (e) {}
    return null;
  }

  function getEditorRuntime(engine, opts) {
    const next = normalizeEngine(engine);
    if (next === 'codemirror') {
      const cm6 = getRoutingCm6Runtime();
      if (cm6 && typeof cm6.create === 'function') return cm6;
      return null;
    }
    const helper = _getEditorEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(next, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const next = normalizeEngine(engine);
    const scopedOpts = withCm6Scope(opts);
    const helper = _getEditorEngineHelper();

    if (next === 'codemirror') {
      try {
        if (helper && typeof helper.ensureSupport === 'function') {
          await helper.ensureSupport('codemirror', scopedOpts);
        }
      } catch (e) {}
      const cm6 = getRoutingCm6Runtime();
      if (!cm6) return null;
      try {
        if (typeof cm6.ensure === 'function') await cm6.ensure(scopedOpts);
      } catch (e) {}
      return (typeof cm6.create === 'function') ? cm6 : null;
    }

    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(next, scopedOpts);
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(next, scopedOpts);
    } catch (e) {}
    return null;
  }

  function createRoutingCodeMirrorFacade(cm) {
    if (!cm) return null;
    const helper = _getEditorEngineHelper();
    if (!helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      return helper.fromCodeMirror(cm, {
        validate: () => validate(),
        layout: () => {
          try { cm.refresh(); } catch (e) {}
        },
      });
    } catch (e) {}
    return null;
  }

  function createRoutingMonacoFacade(editor) {
    if (!editor) return null;
    const helper = _getEditorEngineHelper();
    if (!helper || typeof helper.fromMonaco !== 'function') return null;
    try {
      return helper.fromMonaco(editor, { validate: () => validate() });
    } catch (e) {}
    return null;
  }

  function getActiveEditorFacade() {
    if (_engine === 'monaco' && _monacoFacade) return _monacoFacade;
    if (_cmFacade) return _cmFacade;
    return null;
  }

  function useRoutingMonacoCustomMenu() {
    return true;
  }

  function disposeRoutingMonacoContextMenu() {
    try { hideRoutingMonacoContextMenu(); } catch (e) {}
    try {
      if (typeof _routingMonacoMenuCleanup === 'function') _routingMonacoMenuCleanup();
    } catch (e) {}
    _routingMonacoMenuCleanup = null;
  }

  function hideRoutingMonacoContextMenu() {
    const menu = _routingMonacoMenuEl;
    _routingMonacoMenuCtx = null;
    if (!menu) return;
    try { menu.hidden = true; } catch (e) {}
    try { menu.classList.remove('is-open'); } catch (e) {}
    try { menu.style.removeProperty('left'); } catch (e) {}
    try { menu.style.removeProperty('top'); } catch (e) {}
  }

  function ensureRoutingMonacoContextMenuDom() {
    if (_routingMonacoMenuEl && _routingMonacoMenuEl.isConnected) return _routingMonacoMenuEl;
    const menu = document.createElement('div');
    menu.className = 'xk-routing-monaco-menu';
    menu.hidden = true;
    menu.innerHTML = [
      '<button type="button" class="xk-routing-monaco-menu-item" data-action="cut">Вырезать</button>',
      '<button type="button" class="xk-routing-monaco-menu-item" data-action="copy">Копировать</button>',
      '<button type="button" class="xk-routing-monaco-menu-item" data-action="paste">Вставить</button>',
      '<div class="xk-routing-monaco-menu-sep" role="separator"></div>',
      '<button type="button" class="xk-routing-monaco-menu-item" data-action="selectAll">Выделить всё</button>',
      '<button type="button" class="xk-routing-monaco-menu-item" data-action="format">Форматировать JSON</button>'
    ].join('');
    const handleMenuAction = async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
      if (!btn || btn.disabled) return;
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}
      const action = String(btn.dataset.action || '');
      const ctx = _routingMonacoMenuCtx;
      hideRoutingMonacoContextMenu();
      if (!ctx || !ctx.editor) return;
      try {
        await runRoutingMonacoMenuAction(ctx.editor, action);
      } catch (e) {}
    };
    menu.addEventListener('pointerdown', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
      if (btn) {
        handleMenuAction(ev);
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
    _routingMonacoMenuEl = menu;
    return menu;
  }

  function getRoutingMonacoSelections(editor) {
    if (!editor) return [];
    try {
      if (typeof editor.getSelections === 'function') {
        const ranges = editor.getSelections();
        if (Array.isArray(ranges) && ranges.length) return ranges.filter(Boolean);
      }
    } catch (e) {}
    try {
      if (typeof editor.getSelection === 'function') {
        const sel = editor.getSelection();
        if (sel) return [sel];
      }
    } catch (e) {}
    return [];
  }

  function getRoutingMonacoSelectionText(editor) {
    if (!editor) return '';
    try {
      const model = (typeof editor.getModel === 'function') ? editor.getModel() : null;
      if (!model || typeof model.getValueInRange !== 'function') return '';
      const selections = getRoutingMonacoSelections(editor);
      if (!selections.length) return '';
      return selections.map((range) => {
        try { return String(model.getValueInRange(range) || ''); } catch (e) { return ''; }
      }).join('\n');
    } catch (e) {}
    return '';
  }

  function isRoutingMonacoReadOnly(editor) {
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

  function execRoutingMonacoEdits(editor, edits, source) {
    if (!editor || !Array.isArray(edits) || !edits.length) return false;
    try {
      if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
    } catch (e) {}
    try {
      if (typeof editor.executeEdits === 'function') {
        editor.executeEdits(String(source || 'xk-routing-menu'), edits);
        try { if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop(); } catch (e2) {}
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function writeRoutingClipboardText(text) {
    const value = String(text ?? '');
    _routingMonacoClipboardShadow = value;
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

  async function readRoutingClipboardText() {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const value = await navigator.clipboard.readText();
        if (typeof value === 'string') {
          _routingMonacoClipboardShadow = value;
          return value;
        }
      }
    } catch (e) {}
    return String(_routingMonacoClipboardShadow || '');
  }

  async function runRoutingMonacoMenuAction(editor, action) {
    if (!editor) return false;
    try { if (typeof editor.focus === 'function') editor.focus(); } catch (e) {}

    const selections = getRoutingMonacoSelections(editor);
    const hasSelection = selections.some((range) => {
      try { return !!range && !(range.isEmpty && range.isEmpty()); } catch (e) { return false; }
    });

    if (action === 'copy') {
      const selectedText = getRoutingMonacoSelectionText(editor);
      if (!selectedText) return false;
      await writeRoutingClipboardText(selectedText);
      return true;
    }

    if (action === 'cut') {
      if (isRoutingMonacoReadOnly(editor) || !hasSelection) return false;
      const selectedText = getRoutingMonacoSelectionText(editor);
      if (!selectedText) return false;
      await writeRoutingClipboardText(selectedText);
      return execRoutingMonacoEdits(editor, selections.map((range) => ({ range, text: '', forceMoveMarkers: true })), 'xk-routing-menu-cut');
    }

    if (action === 'paste') {
      if (isRoutingMonacoReadOnly(editor)) return false;
      const value = await readRoutingClipboardText();
      if (typeof value !== 'string') return false;
      const targetSelections = selections.length ? selections : getRoutingMonacoSelections(editor);
      if (!targetSelections.length) return false;
      return execRoutingMonacoEdits(editor, targetSelections.map((range) => ({ range, text: value, forceMoveMarkers: true })), 'xk-routing-menu-paste');
    }

    if (action === 'selectAll') {
      try {
        const cmd = editor.getAction && editor.getAction('editor.action.selectAll');
        if (cmd && typeof cmd.run === 'function') {
          await cmd.run();
          return true;
        }
      } catch (e) {}
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
      if (isRoutingMonacoReadOnly(editor)) return false;
      try {
        const cmd = editor.getAction && editor.getAction('editor.action.formatDocument');
        if (cmd && typeof cmd.run === 'function') {
          await cmd.run();
          return true;
        }
      } catch (e) {}
      try { formatEditorJson(); } catch (e) {}
      return true;
    }

    return false;
  }

  function updateRoutingMonacoContextMenuState(editor) {
    const menu = ensureRoutingMonacoContextMenuDom();
    const hasSelection = !!getRoutingMonacoSelectionText(editor);
    const readOnly = isRoutingMonacoReadOnly(editor);
    const items = Array.from(menu.querySelectorAll('button[data-action]'));
    items.forEach((btn) => {
      const action = String(btn.dataset.action || '');
      let disabled = false;
      if (action === 'copy' || action === 'cut') disabled = !hasSelection;
      if ((action === 'cut' || action === 'paste' || action === 'format') && readOnly) disabled = true;
      btn.disabled = disabled;
    });
  }

  function showRoutingMonacoContextMenu(editor, ev) {
    if (!editor || !ev) return;
    const menu = ensureRoutingMonacoContextMenuDom();
    _routingMonacoMenuCtx = { editor };
    updateRoutingMonacoContextMenuState(editor);
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

  function installRoutingMonacoContextMenu(editor, host) {
    disposeRoutingMonacoContextMenu();
    if (!editor || !host || !useRoutingMonacoCustomMenu()) return;

    const onContextMenu = (ev) => {
      if (_engine !== 'monaco') return;
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}
      try { if (typeof editor.focus === 'function') editor.focus(); } catch (e) {}
      showRoutingMonacoContextMenu(editor, ev);
    };

    const hide = () => { hideRoutingMonacoContextMenu(); };
    const onDocumentMouseDown = (ev) => {
      const menu = _routingMonacoMenuEl;
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

    host.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide, true);
    window.addEventListener('blur', hide, true);
    document.addEventListener('keydown', onKeyDown, true);

    _routingMonacoMenuCleanup = () => {
      try { host.removeEventListener('contextmenu', onContextMenu, true); } catch (e) {}
      try { document.removeEventListener('mousedown', onDocumentMouseDown, true); } catch (e) {}
      try { document.removeEventListener('scroll', hide, true); } catch (e) {}
      try { window.removeEventListener('resize', hide, true); } catch (e) {}
      try { window.removeEventListener('blur', hide, true); } catch (e) {}
      try { document.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
    };
  }

  function resetMonacoHostDom(hostEl) {
    const host = hostEl || ensureMonacoHost();
    if (!host) return;
    try { hideRoutingMonacoContextMenu(); } catch (e) {}
    try {
      while (host.firstChild) host.removeChild(host.firstChild);
    } catch (e) {
      try { host.textContent = ''; } catch (e2) {}
    }
  }

  async function ensureMonacoEditor() {
    if (isMonacoAlive(_monaco)) return _monaco;
    if (_monacoEnsurePromise) return _monacoEnsurePromise;

    const host = ensureMonacoHost();
    if (!host) return null;

    const runtime = await ensureEditorRuntime('monaco');
    if (!runtime || typeof runtime.create !== 'function') {
      toast('Не удалось загрузить Monaco support.', true);
      return null;
    }

    _monacoEnsurePromise = (async () => {
      try { disposeRoutingMonacoContextMenu(); } catch (e) {}
      try { disposeRoutingMonacoContextMenu(); } catch (e) {}
      try {
        if (_monaco && typeof _monaco.dispose === 'function') _monaco.dispose();
      } catch (e) {}
      _monaco = null;
      _monacoFacade = null;
      resetMonacoHostDom(host);

      try {
        _monaco = await runtime.create(host, {
          value: readCurrentEditorText(),
          contextmenu: !useRoutingMonacoCustomMenu(),
          // Xray configs commonly use JSON with user comments (JSONC-like).
          // Backend сохраняет чистый JSON + отдельный .jsonc сайдкар, поэтому в UI
          // разрешаем комментарии для удобства.
          language: 'jsonc',
          allowComments: true,
          tabSize: 2,
          insertSpaces: true,
          performanceProfile: (_editorPerfProfile && _editorPerfProfile.lite) ? 'lite' : 'default',
          wordWrap: isMipsTarget() ? 'off' : 'on',
          onChange: () => {
            try { invalidateEditorSnapshot(); } catch (e) {}
            try { scheduleMonacoDiagnostics(); } catch (e) {}
	            try { scheduleDirtyCheck(); } catch (e) {}
            try { scheduleEditorContentEvent('edit'); } catch (e) {}
          },
        });

        if (!isMonacoAlive(_monaco)) {
          _monaco = null;
          toast('Не удалось загрузить Monaco Editor.', true);
          return null;
        }

        // Facade for routing consumers so feature modules stay engine-agnostic.
        _monacoFacade = createRoutingMonacoFacade(_monaco);
        try { syncSharedRoutingEditor(_monaco, _monacoFacade, 'monaco'); } catch (e) {}
        try { installRoutingMonacoContextMenu(_monaco, host); } catch (e) {}

        // Ensure layout fix for hidden containers (modals/tabs/engine switch).
        try {
          if (typeof runtime.layoutOnVisible === 'function') runtime.layoutOnVisible(_monaco, host, { lite: !!(_editorPerfProfile && _editorPerfProfile.lite) });
        } catch (e) {}

        try {
          if (_monaco && typeof _monaco.onDidScrollChange === 'function') {
            _monaco.onDidScrollChange(() => {
              try { scheduleViewStateSave(null, { updateMeta: false, memoryOnly: false }); } catch (e) {}
            });
          }
        } catch (e) {}
        try {
          if (_monaco && typeof _monaco.onDidChangeCursorPosition === 'function') {
            _monaco.onDidChangeCursorPosition(() => {
              try { scheduleViewStateSave(null, { updateMeta: false, memoryOnly: false }); } catch (e) {}
            });
          }
        } catch (e) {}
        try {
          if (_monaco && typeof _monaco.onDidBlurEditorText === 'function') {
            _monaco.onDidBlurEditorText(() => {
              try { saveCurrentViewState({ updateMeta: false }); } catch (e) {}
            });
          }
        } catch (e) {}

        return _monaco;
      } catch (e) {
        try { console.error(e); } catch (e2) {}
        toast('Ошибка загрузки Monaco (см. консоль).', true);
        _monaco = null;
        _monacoFacade = null;
        return null;
      }
    })().finally(() => {
      _monacoEnsurePromise = null;
    });

    return _monacoEnsurePromise;
  }

  function getEditorText() {
    try {
      const snapshot = getEditorSnapshot();
      return snapshot ? String(snapshot.text || '') : '';
    } catch (e) {}
    return '';
  }

  function setEditorTextAll(text, opts) {
    const v = String(text ?? '');
    const o = opts || {};
    try { applyCodeMirrorPerfProfile(v); } catch (e) {}
    try { if (_cm && typeof _cm.setValue === 'function') _cm.setValue(v); } catch (e) {}
    try { if (_monaco && typeof _monaco.setValue === 'function') _monaco.setValue(v); } catch (e) {}
    try {
      const ta = $(IDS.textarea);
      if (ta) ta.value = v;
    } catch (e) {}
    try { cacheEditorSnapshot(v); } catch (e) {}
    if (o.broadcast !== false) {
      try { scheduleEditorContentEvent(o.reason || 'set', typeof o.wait === 'number' ? o.wait : 60); } catch (e) {}
    }
  }

  function scrollEditorsTop() {
    try { if (_cm && typeof _cm.scrollTo === 'function') _cm.scrollTo(0, 0); } catch (e) {}
    try { if (_monaco && typeof _monaco.setScrollTop === 'function') _monaco.setScrollTop(0); } catch (e) {}
  }

  function getRoutingCodeMirrorWrappers() {
    const ta = $(IDS.textarea);
    if (!ta) return [];
    try {
      const cached = ta.__xkRoutingCodeMirror;
      const cachedWrap = cached && typeof cached.getWrapperElement === 'function' ? cached.getWrapperElement() : null;
      const all = Array.from(document.querySelectorAll('.CodeMirror, .xkeen-cm6-host'));
      return all.filter((wrap) => {
        try {
          const cm = (wrap && (wrap.__xkRoutingCodeMirror || wrap.CodeMirror)) || null;
          if (cm && typeof cm.getTextArea === 'function') return cm.getTextArea() === ta;
          return !!(cachedWrap && wrap === cachedWrap);
        } catch (e) {
          return false;
        }
      });
    } catch (e) {}
    return [];
  }

  function cleanupRoutingCodeMirrorWrappers(keepWrapper) {
    const wrappers = getRoutingCodeMirrorWrappers();
    for (let i = 0; i < wrappers.length; i += 1) {
      const wrap = wrappers[i];
      if (!wrap || wrap === keepWrapper) continue;
      try {
        const cm = wrap.CodeMirror;
        if (cm && typeof cm.getTextArea === 'function') {
          const ta = cm.getTextArea();
          if (ta && ta.id && ta.id !== IDS.textarea) continue;
        }
      } catch (e) {}
      try { wrap.style.display = 'none'; } catch (e) {}
      try { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch (e) {}
    }
  }

  function getExistingRoutingCodeMirror(textarea) {
    const ta = textarea || $(IDS.textarea);
    if (!ta) return null;

    try {
      const cached = ta.__xkRoutingCodeMirror;
      if (cached && typeof cached.getWrapperElement === 'function') {
        const wrap = cached.getWrapperElement();
        if (wrap && wrap.isConnected) {
          cleanupRoutingCodeMirrorWrappers(wrap);
          return cached;
        }
      }
    } catch (e) {}

    const wrappers = getRoutingCodeMirrorWrappers();
    for (let i = 0; i < wrappers.length; i += 1) {
      const wrap = wrappers[i];
      try {
        const cm = (wrap && (wrap.__xkRoutingCodeMirror || wrap.CodeMirror)) || null;
        if (!cm || typeof cm.getWrapperElement !== 'function') continue;
        if (typeof cm.getTextArea === 'function' && cm.getTextArea() !== ta) continue;
        ta.__xkRoutingCodeMirror = cm;
        try { wrap.__xkRoutingCodeMirror = cm; } catch (e2) {}
        cleanupRoutingCodeMirrorWrappers(wrap);
        return cm;
      } catch (e) {}
    }

    return null;
  }

  function syncRoutingEngineDomState(engine) {
    const next = normalizeEngine(engine || _engine);
    try {
      const body = $(IDS.body);
      if (body) body.setAttribute('data-routing-engine', next);
    } catch (e) {}
  }

  function showCodeMirror(show) {
    try {
      const wrappers = getRoutingCodeMirrorWrappers();
      const current = (_cm && _cm.getWrapperElement) ? _cm.getWrapperElement() : null;
      if (show && current) cleanupRoutingCodeMirrorWrappers(current);
      const ta = $(IDS.textarea);
      try { if (ta) ta.style.display = 'none'; } catch (e) {}
      try { syncRoutingEngineDomState(show ? 'codemirror' : 'monaco'); } catch (e) {}

      for (let i = 0; i < wrappers.length; i += 1) {
        const wrap = wrappers[i];
        if (!wrap) continue;
        if (show && current && wrap === current) wrap.style.removeProperty('display');
        else wrap.style.setProperty('display', 'none', 'important');
      }

      if (show && _cm && typeof _cm.refresh === 'function') _cm.refresh();
    } catch (e) {}
  }

  function showMonaco(show) {
    const host = ensureMonacoHost();
    if (!host) return;
    try { syncRoutingEngineDomState(show ? 'monaco' : 'codemirror'); } catch (e) {}
    if (show) host.style.removeProperty('display');
    else {
      try { hideRoutingMonacoContextMenu(); } catch (e) {}
      host.style.setProperty('display', 'none', 'important');
    }

    if (show && _monaco && typeof _monaco.layout === 'function') {
      const runtime = getEditorRuntime('monaco');
      if (runtime && typeof runtime.layoutOnVisible === 'function') {
        try { runtime.layoutOnVisible(_monaco, host, { lite: !!(_editorPerfProfile && _editorPerfProfile.lite) }); } catch (e) {}
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
      resetMonacoHostDom(host);
    }

    const doLayout = () => {
      try {
        if (!_monaco || typeof _monaco.layout !== 'function') return;
        const runtime = getEditorRuntime('monaco');
        if (runtime && typeof runtime.layoutOnVisible === 'function') {
          runtime.layoutOnVisible(_monaco, host, { lite: !!(_editorPerfProfile && _editorPerfProfile.lite) });
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
    try { updateEditorMetaStatus(); } catch (e) {}
    try {
      const routingCardsApi = getRoutingCardsFeatureApi();
      if (routingCardsApi && typeof routingCardsApi.onShow === 'function') {
        routingCardsApi.onShow({ reason: reason || 'show' });
      }
    } catch (e) {}
  }

  function wirePageReturnOnce() {
    // BFCache restore (Safari/Chrome) can keep DOM but lose Monaco layout/workers.
    try {
      if (window.__xkeenRoutingPageReturnWired) return;
      window.__xkeenRoutingPageReturnWired = true;

      const triggerReturnShow = (reason) => {
        const now = Date.now();
        if ((now - _lastPageReturnShowAt) < 180) return;
        _lastPageReturnShowAt = now;
        try {
          if (document.visibilityState === 'visible') onShow({ reason: String(reason || 'show') });
        } catch (e) {}
      };

      window.addEventListener('pageshow', (ev) => {
        // Always run: even non-persisted navigations sometimes need a relayout.
        triggerReturnShow(ev && ev.persisted ? 'bfcache' : 'pageshow');
      });

      document.addEventListener('visibilitychange', () => {
        try {
          if (document.visibilityState === 'visible') triggerReturnShow('visibility');
          else saveCurrentViewState({ updateMeta: false });
        } catch (e) {}
      });

      window.addEventListener('beforeunload', () => {
        try { saveCurrentViewState({ updateMeta: false }); } catch (e) {}
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

    const preservedView = captureViewState();

    if (next === 'monaco') {
      // If CodeMirror was in fullscreen, exit it first, otherwise its fullscreen CSS may affect layout.
      try {
        if (_cm && typeof _cm.getOption === 'function' && typeof _cm.setOption === 'function' && _cm.getOption('fullScreen')) {
          _cm.setOption('fullScreen', false);
        }
      } catch (e) {}

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
      // Keep only JSONC help + fullscreen visible in the toolbar host.
      try { syncToolbarForEngine('monaco'); } catch (e) {}
      try { syncRoutingToolbarUi('monaco'); } catch (e) {}
      try { wireMonacoFullscreenOnce(); } catch (e) {}

      _engine = 'monaco';
      try { syncSharedRoutingEditor(_monaco, _monacoFacade, 'monaco'); } catch (e) {}
      try { restoreViewState(preservedView); } catch (e) {}
      try { if (_monacoFacade && _monacoFacade.focus) _monacoFacade.focus(); } catch (e) {}
      try { if (_monacoFacade && _monacoFacade.validate) _monacoFacade.validate(); else validate(); } catch (e) {}
      try { saveCurrentViewState(); } catch (e) {}
    } else {
      const cm = ensureCodeMirrorEditor();
      if (!cm) {
        try { if (_engineSelectEl) _engineSelectEl.value = _engine; } catch (e) {}
        return;
      }

      // If Monaco is fullscreen, exit it before hiding to avoid leaving body scroll locked.
      try { if (isMonacoFullscreen()) setMonacoFullscreen(false); } catch (e) {}

      // Sync text back from Monaco to CodeMirror
      try {
        if (_monaco && typeof cm.setValue === 'function') cm.setValue(_monaco.getValue());
      } catch (e) {}

      // Leave Monaco: clear markers and cancel pending diagnostics.
      try { if (_monacoDiagTimer) clearTimeout(_monacoDiagTimer); } catch (e) {}
      _monacoDiagTimer = null;
      try { clearMonacoMarkers(); } catch (e) {}

      showMonaco(false);
      showCodeMirror(true);
      // Restore full CodeMirror toolbar.
      try { syncToolbarForEngine('codemirror'); } catch (e) {}
      try { syncRoutingToolbarUi('codemirror'); } catch (e) {}

      _engine = 'codemirror';
      try { syncSharedRoutingEditor(cm, _cmFacade || createRoutingCodeMirrorFacade(cm), 'codemirror'); } catch (e) {}
      try { restoreViewState(preservedView); } catch (e) {}
      try { if (cm && cm.focus) cm.focus(); } catch (e) {}
      try {
        const fac = _cmFacade || createRoutingCodeMirrorFacade(cm);
        if (fac && fac.validate) fac.validate();
        else validate();
      } catch (e) {}
      try { saveCurrentViewState(); } catch (e) {}
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
      try {
        _engineSelectEl.setAttribute('data-tooltip', 'Выбор движка редактора: CodeMirror или Monaco');
        _engineSelectEl.setAttribute('title', 'Выбор движка редактора: CodeMirror или Monaco');
        _engineSelectEl.setAttribute('aria-label', 'Выбор движка редактора');
      } catch (e) {}
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'xk-editor-engine';

    const sel = document.createElement('select');
    sel.id = IDS.engineSelect;
    sel.className = 'xk-editor-engine-select';
    sel.setAttribute('data-tooltip', 'Выбор движка редактора: CodeMirror или Monaco');
    sel.setAttribute('title', 'Выбор движка редактора: CodeMirror или Monaco');
    sel.setAttribute('aria-label', 'Выбор движка редактора');

    const o1 = document.createElement('option');
    o1.value = 'codemirror';
    o1.textContent = 'CodeMirror';
    const o2 = document.createElement('option');
    o2.value = 'monaco';
    o2.textContent = 'Monaco';

    sel.appendChild(o1);
    sel.appendChild(o2);

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
      const editorEngineApi = getEditorEngineApi();
      if (_hasGlobalEditorEngine() && editorEngineApi && typeof editorEngineApi.ensureLoaded === 'function') {
        editorEngineApi.ensureLoaded().then((eng) => {
          if (_engineTouched) return;
          const desired = normalizeEngine(hasExplicitEnginePreference() ? eng : getPreferredEngine());
          try { if (_engineSelectEl) _engineSelectEl.value = desired; } catch (e) {}
          if (desired && desired !== _engine) switchEngine(desired, { persist: false });
        }).catch(() => {});
      }
    } catch (e) {}


  }


  function init() {
    try {
      document.addEventListener('xkeen:routing-comments-ux', (ev) => {
        const d = ev && ev.detail ? ev.detail : {};
        _commentsBadgeOverride = (d && d.kind) ? { kind: String(d.kind || ''), reason: String(d.reason || ''), message: String(d.message || '') } : null;
        try { updateEditorMetaStatus(); } catch (e) {}
      });
    } catch (e) {}

    const textarea = $(IDS.textarea);
    if (!textarea) return;
    if (_inited) return;
    _inited = true;

    try {
      const lifecycle = getFeatureLifecycle();
      if (lifecycle && typeof lifecycle.setInitialized === 'function') lifecycle.setInitialized(true);
    } catch (e) {}

    const startInit = (resolvedEngine) => {
      const initialEngine = normalizeEngine(resolvedEngine || getPreferredEngine()) || 'codemirror';
      const bootWithMonaco = initialEngine === 'monaco';

      const finishInit = () => {
        if (!bootWithMonaco) {
          _cm = ensureCodeMirrorEditor();
          try { syncSharedRoutingEditor(_cm, _cmFacade || createRoutingCodeMirrorFacade(_cm), 'codemirror'); } catch (e) {}
          try { syncRoutingEngineDomState(_engine); } catch (e2) {}
          try { syncCodeMirrorLintNow(); } catch (e3) {}
        } else {
          try { syncRoutingEngineDomState('monaco'); } catch (e4) {}
        }

        // Ensure Monaco container exists (hidden by default)
        try { ensureMonacoHost(); } catch (e) {}

        // Build engine toggle UI (default CodeMirror, no auto-fetch beyond routing)
        try { ensureEngineToggleUI(); } catch (e) {}

        try {
          if (bootWithMonaco) ensureRoutingMonacoToolbar();
          else if (_cm) setTimeout(() => moveToolbarToHost(_cm), 0);
        } catch (e) {}

        // Fix Monaco after tab switches / navigation away+back (BFCache)
        try { wirePageReturnOnce(); } catch (e) {}

        wireUI();

        Promise.resolve(bootWithMonaco ? _engineSwitchChain : null)
          .catch(() => {})
          .finally(() => {
            if (!_cm && _engine !== 'monaco') {
              try { _cm = ensureCodeMirrorEditor(); } catch (e) {}
            }
            try { syncRoutingToolbarUi(_engine); } catch (e) {}
            try { validate(); } catch (e) {}
            try { document.dispatchEvent(new CustomEvent('xkeen-editors-ready')); } catch (e) {}
            try { updateEditorMetaStatus(); } catch (e) {}
            refreshFragmentsList().finally(() => load());
          });
      };

      try {
        Promise.resolve(ensureEditorRuntime('codemirror', {
          mode: 'jsonc',
          jsonLint: true,
          search: true,
          fold: true,
          fullscreen: true,
          rulers: true,
          autoCloseBrackets: true,
          trailingSpace: true,
          comments: true,
        }))
          .then((runtime) => {
            if (runtime && typeof runtime.ensureAssets === 'function') {
              return runtime.ensureAssets({
                mode: 'jsonc',
                jsonLint: true,
                search: true,
                fold: true,
                fullscreen: true,
                rulers: true,
                autoCloseBrackets: true,
                trailingSpace: true,
                comments: true,
              });
            }
            return null;
          })
          .catch(() => null)
          .finally(finishInit);
        return;
      } catch (e) {}

      finishInit();
    };

    Promise.resolve(resolveInitialEnginePreference())
      .catch(() => normalizeEngine(getPreferredEngine()) || 'codemirror')
      .then(startInit);
  }

  function replaceEditorText(text, opts) {
    const o = opts || {};
    try { _suppressDirty++; } catch (e) {}
    try {
      setEditorTextAll(text, {
        reason: o.reason || 'replace',
        wait: (typeof o.wait === 'number') ? o.wait : 40,
        broadcast: true,
      });
    } finally {
      try { _suppressDirty = Math.max(0, _suppressDirty - 1); } catch (e) { _suppressDirty = 0; }
    }
    try {
      if (o.scrollTop !== false) scrollEditorsTop();
    } catch (e) {}
    try { validate(); } catch (e) {}

    if (o.markDirty === true) {
      try { setRoutingDirty(true); } catch (e) {}
      try { syncDirtyUi(true); } catch (e) {}
    } else if (o.markDirty === false) {
      try {
        setRoutingSavedContent(String(text ?? ''));
        setRoutingDirty(false);
      } catch (e) {}
      try { syncDirtyUi(false); } catch (e) {}
    } else {
      try { scheduleDirtyCheck(0); } catch (e) {}
    }

    try { saveCurrentViewState(); } catch (e) {}
    try { scheduleEditorContentEvent(o.reason || 'replace', 20); } catch (e) {}
  }

  routingModuleApi = {
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
    replaceEditorText,
  };

})();

export function getRoutingApi() {
  try {
    if (routingModuleApi && typeof routingModuleApi.init === 'function') return routingModuleApi;
  } catch (error) {
    console.error(error);
  }
  return null;
}

function callRoutingApi(method, ...args) {
  const api = getRoutingApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initRouting(...args) {
  return callRoutingApi('init', ...args);
}

export function loadRouting(...args) {
  return callRoutingApi('load', ...args);
}

export function onShowRouting(...args) {
  return callRoutingApi('onShow', ...args);
}

export function saveRouting(...args) {
  return callRoutingApi('save', ...args);
}

export function validateRouting(...args) {
  return callRoutingApi('validate', ...args);
}

export function formatRouting(...args) {
  return callRoutingApi('format', ...args);
}

export function clearRoutingComments(...args) {
  return callRoutingApi('clearComments', ...args);
}

export function sortRoutingRules(...args) {
  return callRoutingApi('sortRules', ...args);
}

export function backupRouting(...args) {
  return callRoutingApi('backup', ...args);
}

export function restoreRoutingAutoBackup(...args) {
  return callRoutingApi('restoreAuto', ...args);
}

export function toggleRoutingCard(...args) {
  return callRoutingApi('toggleCard', ...args);
}

export function openRoutingHelp(...args) {
  return callRoutingApi('openHelp', ...args);
}

export function closeRoutingHelp(...args) {
  return callRoutingApi('closeHelp', ...args);
}

export function setRoutingError(...args) {
  return callRoutingApi('setError', ...args);
}

export function replaceRoutingEditorText(...args) {
  return callRoutingApi('replaceEditorText', ...args);
}

export function disposeRouting(...args) {
  return callRoutingApi('dispose', ...args);
}

export const routingApi = Object.freeze({
  get: getRoutingApi,
  init: initRouting,
  load: loadRouting,
  onShow: onShowRouting,
  save: saveRouting,
  validate: validateRouting,
  format: formatRouting,
  clearComments: clearRoutingComments,
  sortRules: sortRoutingRules,
  backup: backupRouting,
  restoreAuto: restoreRoutingAutoBackup,
  toggleCard: toggleRoutingCard,
  openHelp: openRoutingHelp,
  closeHelp: closeRoutingHelp,
  setError: setRoutingError,
  replaceEditorText: replaceRoutingEditorText,
  dispose: disposeRouting,
});
