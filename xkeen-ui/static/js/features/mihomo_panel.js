import {
  clearSharedMihomoEditor,
  confirmMihomoAction,
  escapeMihomoHtml,
  getMihomoCommandJobApi,
  getMihomoEditorActionsApi,
  getMihomoEditorEngineApi,
  getMihomoFormattersApi,
  getSharedMihomoEditor,
  setSharedMihomoEditor,
} from './mihomo_runtime.js';
import {
  attachXkeenEditorToolbar,
  buildXkeenEditorCommonKeys,
  getXkeenEditorToolbarDefaultItems,
  getXkeenEditorToolbarIcons,
  getXkeenEditorToolbarMiniItems,
  getXkeenFilePath,
  getXkeenPageFlagsConfig,
  setXkeenPageConfigValue,
} from './xkeen_runtime.js';

let mihomoPanelModuleApi = null;

(() => {
  'use strict';

  // Mihomo panel (editor + templates + validate + profiles/backups) extracted from main.js.
  // Canonical module API:
  //   mihomoPanelApi.init()
  //   mihomoPanelApi.loadConfig/saveConfig
  //   mihomoPanelApi.validateFromEditor/saveAndRestart
  //   mihomoPanelApi.loadProfiles/loadBackups/cleanBackups
  // Legacy globals are published by features/compat/mihomo_panel.js.

  const MP = mihomoPanelModuleApi || {};
  mihomoPanelModuleApi = MP;

  const IDS = {
    view: 'view-mihomo',
    textarea: 'mihomo-editor',
    monacoHost: 'mihomo-editor-monaco',
    engineSelect: 'mihomo-editor-engine-select',
    status: 'mihomo-status',
    body: 'mihomo-body',
    arrow: 'mihomo-arrow',

    btnLoad: 'mihomo-load-btn',
    btnSave: 'mihomo-save-btn',
    btnFormatYaml: 'mihomo-format-yaml-btn',
    btnValidate: 'mihomo-validate-btn',
    btnSaveRestart: 'mihomo-save-restart-btn',
    btnOpenZashboardUi: 'mihomo-open-zashboard-btn',

    // Templates
    tplSelect: 'mihomo-template-select',
    tplRefresh: 'mihomo-templates-refresh-btn',
    tplLoad: 'mihomo-template-load-btn',
    tplSaveFromEditor: 'mihomo-template-savefromeditor-btn',

    // Profiles/backups panel
    profilesHeader: 'mihomo-profiles-link',
    profilesPanel: 'mihomo-profiles-panel',
    profilesArrow: 'mihomo-profiles-arrow',
    profilesRefresh: 'mihomo-refresh-profiles-btn',
    profilesList: 'mihomo-profiles-list',
    newProfileName: 'mihomo-new-profile-name',
    saveProfileBtn: 'mihomo-save-profile-btn',

    backupsRefresh: 'mihomo-refresh-backups-btn',
    backupsList: 'mihomo-backups-list',
    backupsActiveOnly: 'mihomo-backups-active-only',
    backupsActiveProfileLabel: 'mihomo-backups-active-profile-label',
    backupsCleanLimit: 'mihomo-backups-clean-limit',
    backupsCleanBtn: 'mihomo-backups-clean-btn',

    // Validation modal
    validationModal: 'mihomo-validation-modal',
    validationBody: 'mihomo-validation-modal-body',
  };

  let _inited = false;
  let _cm = null;
  let _engine = 'codemirror';
  let _monaco = null;
  let _monacoFacade = null;
  let _engineTouched = false;
  let _engineSyncing = false;
  let _templates = [];
  let _templatesLoaded = false;
  let _chosenTemplateName = null;
  let _activeProfileName = null;

  // Editor dirty tracking (to avoid accidental overwrites when loading templates/config).
  let _editorDirty = false;
  let _suppressDirty = false;
  let _lastTemplateSelectValue = '';
  let _monacoDirtyDisposable = null;

  // Monaco fullscreen (CSS-driven)
  let _monacoFsWired = false;

  async function ensureFormattersReady() {
    await import('../ui/prettier_loader.js');
    await import('../ui/formatters.js');
    return getMihomoFormattersApi();
  }

  // YAML error marker (CodeMirror only; backend validate / Prettier errors).
  let _yamlErrorLine = null;
  let _yamlErrorLineHandle = null;
  let _viewStateStore = null;
  let _restartLogModulePromise = null;

  function $(id) {
    return document.getElementById(id);
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

  function refreshRestartLog() {
    void getRestartLogFeatureApi().then((api) => {
      if (api && typeof api.load === 'function') return api.load();
      return null;
    }).catch(() => {});
    return null;
  }

  function escapeHtml(s) {
    return escapeMihomoHtml(s);
  }

  async function confirmAction(opts, fallbackText) {
    return confirmMihomoAction(opts, fallbackText);
  }

  function setStatus(msg, isError, noToast) {
    const el = $(IDS.status);
    if (el) el.textContent = String(msg ?? '');
    if (noToast) return;
    try {
      if (msg) toast(String(msg), !!isError);
    } catch (e) {}
  }

  function hasInitialMihomoConfig() {
    try {
      return !!getXkeenPageFlagsConfig().mihomoConfigExists;
    } catch (e) {}
    return true;
  }

  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }


  // -------------------------- engine toggle (CodeMirror / Monaco) --------------------------
  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function getEngineHelper() {
    return getMihomoEditorEngineApi();
  }

  function getEditorActions() {
    return getMihomoEditorActionsApi();
  }

  function getSharedEditor() {
    return _cm || getSharedMihomoEditor();
  }

  const CM6_SCOPE = 'mihomo-panel';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function getEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, withCm6Scope(opts));
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine, withCm6Scope(opts));
    } catch (e) {}
    return null;
  }

  function isCm6Runtime(runtime) {
    try { return !!(runtime && runtime.backend === 'cm6'); } catch (e) {}
    return false;
  }

  function isCm6Editor(editor) {
    try {
      if (!editor) return false;
      if (editor.__xkeenCm6Bridge || editor.backend === 'cm6') return true;
      const wrap = (typeof editor.getWrapperElement === 'function') ? editor.getWrapperElement() : null;
      return !!(wrap && wrap.classList && wrap.classList.contains('xkeen-cm6-editor'));
    } catch (e) {}
    return false;
  }

  function disposeCodeMirrorEditor(editor) {
    if (!editor) return false;
    try { if (typeof editor.dispose === 'function') return !!editor.dispose(); } catch (e) {}
    try {
      if (typeof editor.toTextArea === 'function') {
        editor.toTextArea();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function showNode(node) {
    if (!node) return;
    try { node.classList.remove('hidden'); } catch (e) {}
    try { node.style.display = ''; } catch (e2) {}
  }

  function hideNode(node) {
    if (!node) return;
    try { node.classList.add('hidden'); } catch (e) {}
    try { node.style.display = 'none'; } catch (e2) {}
  }

  function cmWrapper(cm) {
    try { return (cm && typeof cm.getWrapperElement === 'function') ? cm.getWrapperElement() : null; } catch (e) { return null; }
  }

  function showCmToolbar(show) {
    try {
      const cm = getSharedEditor();
      if (cm && cm._xkeenToolbarEl) cm._xkeenToolbarEl.style.display = show ? '' : 'none';
    } catch (e) {}
  }

  // Fallback fullscreen button in the engine header (for Monaco mode when CodeMirror isn't loaded yet)
  function ensureHeaderFsButton() {
    try {
      const sel = $(IDS.engineSelect);
      const wrap = sel && sel.closest ? sel.closest('.xk-editor-engine') : null;
      const host = wrap || $(IDS.view) || document.body;
      if (!host || !host.querySelector) return null;

      const existing = host.querySelector('button.xk-mihomo-fs-btn');
      if (existing) return existing;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xkeen-cm-tool xk-mihomo-fs-btn';
      try { btn.dataset.tip = 'Фулскрин (F11 / Esc)'; } catch (e) {}
      try { btn.dataset.actionId = 'fs_hdr'; } catch (e) {}
      const icons = getXkeenEditorToolbarIcons();
      btn.innerHTML = icons.fullscreen || '⛶';

      btn.addEventListener('click', (e) => {
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        try { toggleEditorFullscreen(getSharedEditor()); } catch (err) {}
      });

      // Place it right next to the engine select.
      if (wrap) wrap.appendChild(btn);
      else host.appendChild(btn);

      return btn;
    } catch (e) {
      return null;
    }
  }

  function syncHeaderFsButton(engine) {
    try {
      const btn = ensureHeaderFsButton();
      if (!btn) return;

      const isMonaco = (String(engine || '').toLowerCase() === 'monaco');
      const cm = getSharedEditor();
      const hasToolbar = !!(cm && cm._xkeenToolbarEl);

      // Show header button only when Monaco is active AND no CM toolbar exists.
      btn.style.display = (isMonaco && !hasToolbar) ? '' : 'none';
    } catch (e) {}
  }


  function ensureMonacoHost() {
    let host = $(IDS.monacoHost);
    if (host) return host;

    const ta = $(IDS.textarea);
    if (!ta || !ta.parentNode) return null;

    host = document.createElement('div');
    host.id = IDS.monacoHost;
    host.className = 'xk-monaco-editor hidden';

    try { ta.parentNode.insertBefore(host, ta); } catch (e) {
      try { ta.parentNode.appendChild(host); } catch (e2) {}
    }
    return host;
  }

  async function ensureMonacoEditor() {
    if (_monaco) return _monaco;

    const host = ensureMonacoHost();
    if (!host) return null;

    const runtime = await ensureEditorRuntime('monaco');
    if (!runtime || typeof runtime.create !== 'function') return null;

    // initial value from CodeMirror/textarea
    let value = '';
    try { if (_cm && _cm.getValue) value = String(_cm.getValue() || ''); } catch (e) {}
    if (!value) {
      try {
        const ta = $(IDS.textarea);
        if (ta) value = String(ta.value || '');
      } catch (e2) {}
    }

    try {
      _monaco = await runtime.create(host, {
        language: 'yaml',
        value,
        tabSize: 2,
        insertSpaces: true,
        wordWrap: 'on',
      });
      if (!_monaco) return null;

      // Dirty tracking (user edits only).
      try {
        if (!_monacoDirtyDisposable && typeof _monaco.onDidChangeModelContent === 'function') {
          _monacoDirtyDisposable = _monaco.onDidChangeModelContent(() => {
            if (!_suppressDirty) _editorDirty = true;
          });
        }
      } catch (e) {}

      try {
        const helper = getEngineHelper();
        _monacoFacade = (helper && typeof helper.fromMonaco === 'function') ? helper.fromMonaco(_monaco) : null;
      } catch (e) {
        _monacoFacade = null;
      }
      return _monaco;
    } catch (e) {
      try { console.error(e); } catch (e2) {}
      return null;
    }
  }

  function showCodeMirror(show) {
    const cm = getSharedEditor();
    const w = cmWrapper(cm);
    const ta = $(IDS.textarea);

    if (w) {
      if (show) showNode(w);
      else hideNode(w);
      if (show) {
        try { if (cm && cm.refresh) cm.refresh(); } catch (e) {}
      }
      return;
    }

    if (ta) {
      if (show) showNode(ta);
      else hideNode(ta);
    }
  }

  function showMonaco(show) {
    const host = ensureMonacoHost();
    if (!host) return;

    if (show) showNode(host);
    else hideNode(host);

    if (show && _monaco && typeof _monaco.layout === 'function') {
      try {
        const runtime = getEditorRuntime('monaco');
        if (runtime && typeof runtime.layoutOnVisible === 'function') runtime.layoutOnVisible(_monaco, host);
        else _monaco.layout();
      } catch (e) {}
      try { setTimeout(() => { try { _monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
    }
  }

  // ------------------------ fullscreen (CodeMirror + Monaco) ------------------------

  // CodeMirror toolbar is attached near the CodeMirror wrapper. When we reuse it in Monaco mode
  // (to keep UI consistent), it must sit above the Monaco host instead of ending up under it.
  function repositionCmToolbarForEngine(engine) {
    try {
      const cm = getSharedEditor();
      const bar = cm && cm._xkeenToolbarEl;
      if (!bar || !bar.parentNode) return;

      // Prefer placing the toolbar into the dedicated host in the topbar.
      // This keeps the layout tight (no extra vertical gaps) and matches Routing Xray UX.
      const hostSlot = document.getElementById('mihomo-toolbar-host');
      if (hostSlot) {
        if (!hostSlot.contains(bar)) hostSlot.appendChild(bar);
        try { bar.classList.add('xk-toolbar-in-host'); } catch (e) {}
        return;
      }

      const isMonaco = (String(engine || '').toLowerCase() === 'monaco');

      if (isMonaco) {
        const host = ensureMonacoHost();
        if (!host || !host.parentNode) return;
        // Place the toolbar right above Monaco host (top-right above the editor).
        if (bar.nextSibling !== host) host.parentNode.insertBefore(bar, host);
        return;
      }

      const w = cmWrapper(cm);
      if (!w || !w.parentNode) return;
      // Restore the toolbar above CodeMirror wrapper.
      if (bar.nextSibling !== w) w.parentNode.insertBefore(bar, w);
    } catch (e) {}
  }

  function _syncToolbarFsClass(isFs) {
    try {
      const cm = getSharedEditor();
      if (cm && cm._xkeenToolbarEl) cm._xkeenToolbarEl.classList.toggle('is-fullscreen', !!isFs);
    } catch (e) {}
  }

  function syncToolbarForEngine(engine) {
    try {
      const cm = getSharedEditor();
      if (!cm || !cm._xkeenToolbarEl || !cm._xkeenToolbarEl.querySelectorAll) return;
      const bar = cm._xkeenToolbarEl;
      const isMonaco = (String(engine || '').toLowerCase() === 'monaco');

      // Keep the toolbar container visible so layout doesn't jump.
      bar.style.display = '';

      const btns = bar.querySelectorAll('button.xkeen-cm-tool');

      // Prefer the real CodeMirror fullscreen action when it exists; otherwise fall back to fs_any.
      let hasFs = false;
      (btns || []).forEach((btn) => {
        try {
          const id = (btn.dataset && btn.dataset.actionId) ? String(btn.dataset.actionId) : '';
          if (id === 'fs') hasFs = true;
        } catch (e) {}
      });

      (btns || []).forEach((btn) => {
        const id = (btn.dataset && btn.dataset.actionId) ? String(btn.dataset.actionId) : '';
        const isFs = (id === 'fs');
        const isFsAny = (id === 'fs_any');

        if (isMonaco) {
          // In Monaco mode show only one fullscreen button: fs (preferred) or fs_any.
          btn.style.display = hasFs ? (isFs ? '' : 'none') : (isFsAny ? '' : 'none');
        } else {
          // In CodeMirror mode hide the fallback button to avoid duplicates.
          btn.style.display = isFsAny ? 'none' : '';
        }
      });
    } catch (e) {}
  }


  function isMonacoFullscreen() {
    try {
      const host = ensureMonacoHost();
      return !!(host && host.classList && host.classList.contains('is-fullscreen'));
    } catch (e) {}
    return false;
  }

  function setMonacoFullscreen(on) {
    const host = ensureMonacoHost();
    if (!host) return;
    const enabled = !!on;

    // Some containers use transforms; position:fixed would become relative to that ancestor.
    // To guarantee true fullscreen, portal the host to <body> while fullscreen is active.
    const st = host.__xkFs || (host.__xkFs = { on: false, placeholder: null, parent: null, next: null });

    if (enabled) {
      if (!st.on) {
        st.on = true;
        try {
          st.parent = host.parentNode;
          st.next = host.nextSibling;
          st.placeholder = document.createComment('xk-monaco-fs');
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

    // Keep toolbar visible above fullscreen editor (and re-apply after CM toolbar sync).
    try { _syncToolbarFsClass(enabled); } catch (e) {}
    try { setTimeout(() => { try { _syncToolbarFsClass(enabled); } catch (e2) {} }, 0); } catch (e3) {}

    try { if (_monaco && typeof _monaco.layout === 'function') _monaco.layout(); } catch (e) {}
    try { setTimeout(() => { try { if (_monaco && typeof _monaco.layout === 'function') _monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
    try { if (_monaco && typeof _monaco.focus === 'function') _monaco.focus(); } catch (e) {}
  }

  function wireMonacoFullscreenOnce() {
    if (_monacoFsWired) return;
    _monacoFsWired = true;

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

    const ed = cm || _cm;
    try {
      const actions = getEditorActions();
      if (actions && typeof actions.toggleFullscreen === 'function' && actions.toggleFullscreen(ed)) return;
    } catch (e) {}
    try {
      if (ed && typeof ed.getOption === 'function' && typeof ed.setOption === 'function') ed.setOption('fullScreen', !ed.getOption('fullScreen'));
    } catch (e) {}
  }

  function setEngineSelectValue(engine) {
    const sel = $(IDS.engineSelect);
    if (!sel) return;
    try { sel.value = normalizeEngine(engine); } catch (e) {}
  }

  async function resolvePreferredEngine() {
    let engine = 'codemirror';
    const ee = getEngineHelper();
    try {
      if (ee && typeof ee.ensureLoaded === 'function') engine = normalizeEngine(await ee.ensureLoaded());
      else if (ee && typeof ee.get === 'function') engine = normalizeEngine(ee.get());
    } catch (e) {
      try { engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror'); } catch (e2) { engine = 'codemirror'; }
    }
    return engine;
  }

  async function switchEngine(nextEngine, opts) {
    const next = normalizeEngine(nextEngine);
    if (!next) return _engine;
    if (next === _engine && !(opts && opts.force)) return _engine;

    const preservedView = captureCurrentViewState();
    _engineSyncing = true;
    try {
      try { clearYamlErrorMarker(); } catch (e) {}

      if (next === 'monaco') {
        // If CodeMirror was in fullscreen, exit it first to avoid CSS/layout glitches.
        try {
          const cm = getSharedEditor();
          const actions = getEditorActions();
          if (actions && typeof actions.setFullscreen === 'function') actions.setFullscreen(cm, false);
          else if (cm && cm.getOption && cm.setOption && cm.getOption('fullScreen')) cm.setOption('fullScreen', false);
        } catch (e0) {}

        const ed = await ensureMonacoEditor();
        if (!ed) {
          // Fallback to CodeMirror and persist it to global helper (best-effort).
          try {
            const ee = getEngineHelper();
            if (ee && typeof ee.set === 'function') ee.set('codemirror');
          } catch (e2) {}
          showMonaco(false);
          showCodeMirror(true);
          showCmToolbar(true);
          try { syncToolbarForEngine('codemirror'); } catch (e) {}
          try { syncHeaderFsButton('codemirror'); } catch (e) {}
          _engine = 'codemirror';
          return _engine;
        }

        // Sync text from CodeMirror to Monaco on entry.
        try {
          const cm = getSharedEditor();
          const v = (cm && cm.getValue) ? String(cm.getValue() || '') : String(($(IDS.textarea) && $(IDS.textarea).value) || '');
          if (ed && ed.setValue) ed.setValue(v);
        } catch (e3) {}

        showCodeMirror(false);
        // Keep toolbar visible in Monaco mode (only fullscreen button is shown).
        showCmToolbar(true);
        showMonaco(true);

        // Move CM toolbar above Monaco host so the fullscreen button is in the top-right corner.
        try { repositionCmToolbarForEngine('monaco'); } catch (e) {}

        try { syncToolbarForEngine('monaco'); } catch (e) {}
        try { syncHeaderFsButton('monaco'); } catch (e) {}
        try { wireMonacoFullscreenOnce(); } catch (e) {}

        _engine = 'monaco';
        try { if (preservedView) restoreCurrentViewState(preservedView); } catch (e5a) {}
        try { bindViewStateTracking(); } catch (e5b) {}
        try { if (_monacoFacade && _monacoFacade.focus) _monacoFacade.focus(); else if (_monaco && _monaco.focus) _monaco.focus(); } catch (e4) {}
        return _engine;
      }

      // Switch to CodeMirror (sync text back from Monaco).
      // If Monaco is fullscreen, exit it before hiding to avoid leaving body scroll locked.
      try { if (isMonacoFullscreen()) setMonacoFullscreen(false); } catch (e0) {}
      try {
        const cm = ensureEditor();
        if (_monaco && cm && cm.setValue) cm.setValue(String(_monaco.getValue() || ''));
      } catch (e5) {}

      showMonaco(false);
      showCodeMirror(true);
      showCmToolbar(true);

      // Restore CM toolbar position above the CodeMirror wrapper.
      try { repositionCmToolbarForEngine('codemirror'); } catch (e) {}

      try { syncToolbarForEngine('codemirror'); } catch (e) {}

      _engine = 'codemirror';
      try { if (preservedView) restoreCurrentViewState(preservedView); } catch (e6a) {}
      try { bindViewStateTracking(); } catch (e6b) {}
      try {
        const cm = getSharedEditor();
        if (cm && cm.focus) cm.focus();
      } catch (e6) {}
      return _engine;
    } finally {
      _engineSyncing = false;
    }
  }

  function initEngineToggle() {
    const sel = $(IDS.engineSelect);
    if (!sel) return;
    if (sel.dataset && sel.dataset.xkWired === '1') return;

    // Initial value from settings/local fallback (async, non-blocking).
    (async () => {
      try {
        const pref = await resolvePreferredEngine();
        setEngineSelectValue(pref);
        await switchEngine(pref, { force: false });
      } catch (e) {}
    })();

    sel.addEventListener('change', async () => {
      const next = normalizeEngine(sel.value);
      _engineTouched = true;
      try {
        await switchEngine(next, { force: false });

        const ee = getEngineHelper();
        if (ee && typeof ee.set === 'function') {
          try { await ee.set(next); } catch (e) {}
        }
      } finally {
        try { setTimeout(() => { _engineTouched = false; }, 0); } catch (e) { _engineTouched = false; }
      }
    });

    if (sel.dataset) sel.dataset.xkWired = '1';

    // Keep in sync with other editors when preference changes globally.
    const ee = getEngineHelper();
    const onGlobal = (detail) => {
      try {
        if (_engineTouched) return;
        const eng = normalizeEngine(detail && detail.engine);
        if (!eng) return;
        try { if (sel.value !== eng) sel.value = eng; } catch (e) {}
        if (eng !== _engine) {
          switchEngine(eng, { force: false }).catch(() => {});
        }
      } catch (e) {}
    };

    try {
      if (ee && typeof ee.onChange === 'function') {
        ee.onChange(onGlobal);
      } else {
        document.addEventListener('xkeen-editor-engine-change', (ev) => {
          onGlobal(ev && ev.detail ? ev.detail : {});
        });
      }
    } catch (e) {}
  }


  function ensureEditor() {
    const ta = $(IDS.textarea);
    if (!ta) return null;

    const runtime = getEditorRuntime('codemirror');
    const preferCm6 = isCm6Runtime(runtime);

    if (_cm) {
      if (!preferCm6 || isCm6Editor(_cm)) return _cm;
      try { disposeCodeMirrorEditor(_cm); } catch (e) {}
      _cm = null;
    }
    const cached = getSharedMihomoEditor();
    if (cached) {
      if (!preferCm6 || isCm6Editor(cached)) {
        _cm = cached;
        return _cm;
      }
      try { disposeCodeMirrorEditor(cached); } catch (e) {}
      clearSharedMihomoEditor(cached);
    }

    const extra = buildXkeenEditorCommonKeys();
    if (!runtime || typeof runtime.create !== 'function') return null;

    _cm = runtime.create(ta, {
      mode: 'yaml',
      theme: cmThemeFromPage(),
      lineNumbers: true,
      styleActiveLine: true,
      showIndentGuides: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      showTrailingSpace: true,
      highlightSelectionMatches: true,
      rulers: [{ column: 120 }],
      lineWrapping: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys: Object.assign({}, extra, {
        'Ctrl-S': () => { MP.saveConfig(); },
        'Cmd-S': () => { MP.saveConfig(); },
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-H': 'replaceAll',
      }),
      viewportMargin: 30,
    });

    try {
      _cm.getWrapperElement().classList.add('xkeen-cm');
    } catch (e) {}

    setSharedMihomoEditor(_cm);

    // Dirty tracking (user edits only).
    try {
      if (!_cm._xkeenDirtyWired) {
        _cm.on('change', () => { if (!_suppressDirty) _editorDirty = true; });
        _cm._xkeenDirtyWired = true;
      }
    } catch (e) {}

    try {
      const baseItems = getXkeenEditorToolbarDefaultItems();
      const miniItems = getXkeenEditorToolbarMiniItems();
      if (baseItems.length || miniItems.length) {
        // IMPORTANT:
        // attachXkeenEditorToolbar(cm, items) expects an items list.
        // If called without it, it creates an empty toolbar (no buttons),
        // which выглядит как "тулбар пропал".
        const sourceItems = baseItems.length ? baseItems : miniItems;
        const icons = getXkeenEditorToolbarIcons();

        // Replace fullscreen action: in this card it must work for the active engine.
        const items = sourceItems.map((it) => {
          if (it && it.id === 'fs') return Object.assign({}, it, { onClick: (cm) => toggleEditorFullscreen(cm) });
          return it;
        });

        // Fallback fullscreen button for Monaco even when CM fullscreen addon isn't loaded.
        try {
          if (icons.fullscreen && !items.some((it) => it && it.id === 'fs_any')) {
            items.push({
              id: 'fs_any',
              svg: icons.fullscreen,
              label: 'Фулскрин',
              fallbackHint: 'F11 / Esc',
              onClick: () => toggleEditorFullscreen(_cm),
            });
          }
        } catch (e) {}

        attachXkeenEditorToolbar(_cm, items);
        // Keep the toolbar in the compact topbar host (if present).
        try { repositionCmToolbarForEngine(_engine); } catch (e) {}
        try { syncToolbarForEngine(_engine); } catch (e) {}
        try { syncHeaderFsButton(_engine); } catch (e) {}
      }
    } catch (e) {}

    return _cm;
  }

  function getEditorText() {
    try {
      if (_engine === 'monaco' && _monaco) return String(_monaco.getValue() || '');
    } catch (e) {}
    const cm = getSharedEditor();
    if (cm && cm.getValue) return String(cm.getValue() || '');
    const ta = $(IDS.textarea);
    return ta ? String(ta.value || '') : '';
  }

  // Set text into all known backends so switching engines stays lossless.
  function setEditorText(text) {
    const v = String(text ?? '');
    const cm = getSharedEditor();
    try { if (cm && cm.setValue) cm.setValue(v); } catch (e) {}
    try { if (_monaco && _monaco.setValue) _monaco.setValue(v); } catch (e) {}
    try {
      const ta = $(IDS.textarea);
      if (ta) ta.value = v;
    } catch (e) {}
  }

  function setEditorTextClean(text) {
    _suppressDirty = true;
    try { setEditorText(text); } finally { _suppressDirty = false; }
    _editorDirty = false;
  }

  function markEditorClean() {
    _editorDirty = false;
  }

  function isEditorDirty() {
    return !!_editorDirty;
  }

  function getActiveEditorFacade() {
    if (_engine === 'monaco' && _monacoFacade) return _monacoFacade;

    const helper = getEngineHelper();
    const cm = getSharedEditor();
    if (cm) {
      const runtime = getEditorRuntime('codemirror');
      if (runtime && typeof runtime.toFacade === 'function') {
        try {
          return runtime.toFacade(cm, {
            layout: () => {
              try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
            },
          });
        } catch (e) {}
      }
      if (helper && typeof helper.fromCodeMirror === 'function') {
        try {
          return helper.fromCodeMirror(cm, {
            layout: () => {
              try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
            },
          });
        } catch (e) {}
      }
    }

    const ta = $(IDS.textarea);
    if (ta && helper && typeof helper.fromTextarea === 'function') {
      try { return helper.fromTextarea(ta, { kind: 'codemirror' }); } catch (e) {}
    }

    return null;
  }

  function getViewStateStore() {
    if (_viewStateStore) return _viewStateStore;
    const helper = getEngineHelper();
    if (!helper || typeof helper.createViewStateStore !== 'function') return null;
    try {
      _viewStateStore = helper.createViewStateStore({
        buildKey: () => 'xkeen.mihomo.panel.viewstate.v1::config',
      });
    } catch (e) {
      _viewStateStore = null;
    }
    return _viewStateStore;
  }

  function captureCurrentViewState() {
    const store = getViewStateStore();
    if (!store || typeof store.capture !== 'function') return null;
    return store.capture({
      engine: _engine,
      facade: getActiveEditorFacade(),
      textarea: $(IDS.textarea),
      capture: () => {
        const fac = getActiveEditorFacade();
        if (fac && typeof fac.saveViewState === 'function') {
          return fac.saveViewState({ memoryOnly: true });
        }
        return null;
      },
    });
  }

  function loadSavedViewState(engine) {
    const store = getViewStateStore();
    if (!store || typeof store.load !== 'function') return null;
    return store.load({ ctx: 'config', engine: engine || _engine });
  }

  function restoreCurrentViewState(view) {
    const store = getViewStateStore();
    if (!store || typeof store.restore !== 'function') return false;
    return !!store.restore({
      ctx: 'config',
      engine: _engine,
      facade: getActiveEditorFacade(),
      textarea: $(IDS.textarea),
      view,
    });
  }

  function saveCurrentViewState(opts) {
    const store = getViewStateStore();
    if (!store || typeof store.save !== 'function') return null;
    return store.save({
      ctx: 'config',
      engine: (opts && opts.engine) || _engine,
      view: (opts && typeof opts.view !== 'undefined') ? opts.view : captureCurrentViewState(),
    });
  }

  function bindViewStateTracking() {
    const store = getViewStateStore();
    if (!store || typeof store.bind !== 'function') return;
    store.bind({
      ctx: 'config',
      engine: _engine,
      monaco: _engine === 'monaco' ? _monaco : null,
      codemirror: _engine === 'codemirror' ? getSharedEditor() : null,
      textarea: $(IDS.textarea),
      waitMs: 180,
      capture: () => captureCurrentViewState(),
    });
  }

  function clearYamlErrorMarker() {
    const cm = getSharedEditor();
    if (!cm) {
      _yamlErrorLine = null;
      _yamlErrorLineHandle = null;
      return;
    }
    try {
      if (_yamlErrorLineHandle) {
        cm.removeLineClass(_yamlErrorLineHandle, 'background', 'cm-error-line');
      } else if (typeof _yamlErrorLine === 'number') {
        cm.removeLineClass(_yamlErrorLine, 'background', 'cm-error-line');
      }
    } catch (e) {}
    _yamlErrorLine = null;
    _yamlErrorLineHandle = null;
  }

  function markYamlErrorLine(line0) {
    // Always clear previous marker in CodeMirror.
    clearYamlErrorMarker();
    if (typeof line0 !== 'number' || line0 < 0) return;

    // Monaco: best-effort focus on the line (no background marker for now).
    if (_engine === 'monaco' && _monaco) {
      try {
        const line1 = Math.max(1, line0 + 1);
        if (_monaco.revealLineInCenter) _monaco.revealLineInCenter(line1);
        if (_monaco.setPosition) _monaco.setPosition({ lineNumber: line1, column: 1 });
        if (_monaco.focus) _monaco.focus();
        return;
      } catch (e) {}
    }

    // CodeMirror marker (background highlight + scroll).
    const cm = getSharedEditor();
    if (!cm) return;

    try {
      _yamlErrorLine = line0;
      _yamlErrorLineHandle = cm.addLineClass(line0, 'background', 'cm-error-line');
      if (cm.scrollIntoView) cm.scrollIntoView({ line: line0, ch: 0 }, 200);
    } catch (e) {}
  }

  function extractYamlLineCol(textOrLog) {
    const s = String(textOrLog ?? '');
    // Common patterns:
    //  - "yaml: line 12: ..."
    //  - "line 12, column 3"
    //  - "line 12: column 3"
    //  - "line 12:3"
    let m = /line\s+(\d+)\s*(?:[:,]\s*column\s*(\d+))?/i.exec(s);
    if (m) {
      const line = parseInt(m[1], 10);
      const col = m[2] ? parseInt(m[2], 10) : null;
      if (Number.isFinite(line)) return { line, col };
    }
    m = /line\s+(\d+)\s*,\s*col(?:umn)?\s*(\d+)/i.exec(s);
    if (m) {
      const line = parseInt(m[1], 10);
      const col = parseInt(m[2], 10);
      if (Number.isFinite(line)) return { line, col: Number.isFinite(col) ? col : null };
    }
    m = /line\s+(\d+)\s*:\s*(\d+)/i.exec(s);
    if (m) {
      const line = parseInt(m[1], 10);
      const col = parseInt(m[2], 10);
      if (Number.isFinite(line)) return { line, col: Number.isFinite(col) ? col : null };
    }
    return null;
  }


  function refreshEditorIfAny() {
    // If Monaco is active, ensure layout (especially after tab/card open).
    if (_engine === 'monaco' && _monaco && typeof _monaco.layout === 'function') {
      try { _monaco.layout(); } catch (e) {}
      try { setTimeout(() => { try { _monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
      return;
    }

    const cm = getSharedEditor();
    try {
      if (cm && cm.refresh) cm.refresh();
    } catch (e) {}
  }


  function getMihomoCardToggles() {
    try {
      return Array.from(document.querySelectorAll('[data-xk-toggle="mihomo-card"]'));
    } catch (e) {
      return [];
    }
  }

  function syncMihomoCardToggleState(isOpen) {
    getMihomoCardToggles().forEach((header) => {
      try { header.setAttribute('aria-expanded', isOpen ? 'true' : 'false'); } catch (e) {}
    });
  }

  function wireMihomoCardToggle() {
    getMihomoCardToggles().forEach((header) => {
      if (!header || (header.dataset && header.dataset.xkToggleWired === '1')) return;
      const onToggle = (e) => {
        if (e) {
          if (e.type === 'keydown') {
            const key = String(e.key || '');
            if (key !== 'Enter' && key !== ' ') return;
          }
          e.preventDefault();
        }
        toggleMihomoCard();
      };
      header.addEventListener('click', onToggle);
      header.addEventListener('keydown', onToggle);
      if (header.dataset) header.dataset.xkToggleWired = '1';
    });
  }

  function wireValidationModal() {
    const modal = $(IDS.validationModal);
    if (!modal || (modal.dataset && modal.dataset.xkDismissWired === '1')) return;

    modal.addEventListener('click', (e) => {
      if (e && e.target === modal) hideValidationModal();
    });

    try {
      const dismissers = modal.querySelectorAll('[data-dismiss="mihomo-validation"]');
      dismissers.forEach((btn) => {
        if (!btn || (btn.dataset && btn.dataset.xkDismissWired === '1')) return;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          hideValidationModal();
        });
        if (btn.dataset) btn.dataset.xkDismissWired = '1';
      });
    } catch (e) {}

    if (modal.dataset) modal.dataset.xkDismissWired = '1';
  }

  function toggleMihomoCard() {
    const body = $(IDS.body);
    const arrow = $(IDS.arrow);
    if (!body || !arrow) return;
    const willOpen = (body.style.display === '' || body.style.display === 'none');
    body.style.display = willOpen ? 'block' : 'none';
    arrow.textContent = willOpen ? '▲' : '▼';
    syncMihomoCardToggleState(willOpen);
    if (willOpen) refreshEditorIfAny();
  }

  function shouldAutoRestartAfterSave() {
    const cb = document.getElementById('global-autorestart-xkeen');
    return cb ? !!cb.checked : true;
  }

  function getCommandJobApi() {
    return getMihomoCommandJobApi();
  }

  async function clearSharedRestartLogUi() {
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
  }

  async function appendSharedRestartLog(chunk) {
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
  }

  async function waitForRestartJob(jobId, onChunk) {
    const CJ = getCommandJobApi();
    if (CJ && typeof CJ.waitForCommandJob === 'function') {
      return CJ.waitForCommandJob(String(jobId), {
        maxWaitMs: 5 * 60 * 1000,
        onChunk: (chunk) => {
          if (!chunk) return;
          try { onChunk(chunk); } catch (e) {}
        }
      });
    }

    let lastLen = 0;
    while (true) {
      const pr = await fetch(`/api/run-command/${encodeURIComponent(String(jobId))}`);
      const pj = await pr.json().catch(() => ({}));
      const out = (pj && typeof pj.output === 'string') ? pj.output : '';
      if (out.length > lastLen) {
        const chunk = out.slice(lastLen);
        lastLen = out.length;
        if (chunk) {
          try { onChunk(chunk); } catch (e) {}
        }
      }
      if (!pr.ok || pj.ok === false || pj.status === 'finished' || pj.status === 'error') {
        return pj;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function loadLiveConfigIntoEditor() {
    try {
      const res = await fetch('/api/mihomo-config');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          error: (data && data.error) || 'Не удалось загрузить config.yaml.',
        };
      }

      const content = data.content || '';
      setEditorTextClean(content);
      try {
        const savedView = loadSavedViewState(_engine);
        if (savedView) restoreCurrentViewState(savedView);
      } catch (e) {}
      try { bindViewStateTracking(); } catch (e2) {}

      return { ok: true, content };
    } catch (e) {
      console.error(e);
      return { ok: false, error: 'Ошибка загрузки config.yaml.' };
    }
  }

  async function confirmDiscardDirtyEditorChanges(opts) {
    if (!isEditorDirty()) return true;

    const o = opts || {};
    const message = String(o.message || 'Несохранённые изменения в редакторе будут потеряны. Продолжить?');
    const danger = !Object.prototype.hasOwnProperty.call(o, 'danger') || !!o.danger;
    return !!(await confirmAction({
      title: String(o.title || 'Продолжить'),
      message,
      okText: String(o.okText || 'Продолжить'),
      cancelText: String(o.cancelText || 'Отмена'),
      danger,
    }, message));
  }

  // ---------- Core actions ----------

  // opts:
  //   - notify: boolean, show toast notifications (default: true)
  //
  // UX note:
  //   We intentionally DO NOT toast the "loading..." phase to avoid noisy double-toasts
  //   on page refresh / navigation. The status line is enough.
  MP.loadConfig = async function loadConfig(opts) {
    const notify = (opts && Object.prototype.hasOwnProperty.call(opts, 'notify')) ? !!opts.notify : true;
    try {
      setStatus('Загрузка config.yaml...', false, true);
      const res = await fetch('/api/mihomo-config');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Не удалось загрузить config.yaml.', true, !notify);
        return false;
      }
      const content = data.content || '';
      setEditorTextClean(content);
      try {
        const savedView = loadSavedViewState(_engine);
        if (savedView) restoreCurrentViewState(savedView);
      } catch (e) {}
      try { bindViewStateTracking(); } catch (e2) {}
      setStatus('config.yaml загружен (' + content.length + ' байт).', false, !notify);
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
          window.updateLastActivity('loaded', 'mihomo', fp);
        }
      } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки config.yaml.', true, !notify);
      return false;
    }
  };

  MP.saveConfig = async function saveConfig() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, сохранять нечего.', true);
      return false;
    }

    const restart = shouldAutoRestartAfterSave();
    if (restart && MP._restartJobRunning) {
      setStatus('Перезапуск уже выполняется…', true);
      return false;
    }

    const btn = $(IDS.btnSave);
    const setBtnBusy = (busy) => {
      if (!btn) return;
      try { btn.disabled = !!busy; } catch (e) {}
      try { btn.classList.toggle('is-busy', !!busy); } catch (e) {}
    };

    try {
      if (restart) {
        MP._restartJobRunning = true;
        setBtnBusy(true);
        clearYamlErrorMarker();
        setStatus('Сохраняю config.yaml и запускаю перезапуск…', false, true);
        await clearSharedRestartLogUi();
        await appendSharedRestartLog('⏳ Запуск xkeen -restart (job)…\n');
      } else {
        setStatus('Сохранение config.yaml...', false);
      }

      const url = restart ? '/api/mihomo-config?async=1' : '/api/mihomo-config';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, restart }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Ошибка сохранения config.yaml.', true);
        return false;
      }
      markEditorClean();
      try { setXkeenPageConfigValue('flags.mihomoConfigExists', true); } catch (e) {}
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
          window.updateLastActivity('saved', 'mihomo', fp);
        }
      } catch (e) {}

      if (restart) {
        const jobId = data.restart_job_id || data.job_id || data.restartJobId || null;
        if (!jobId) {
          setStatus('Перезапуск запущен, но job_id не получен.', true);
          return false;
        }

        setStatus('Перезапуск в очереди (job ' + String(jobId) + ')…', false, true);
        const result = await waitForRestartJob(String(jobId), (chunk) => {
          try { void appendSharedRestartLog(chunk); } catch (e) {}
        });
        const ok = !!(result && result.ok);

        if (ok) {
          setStatus('Готово', false);
        } else {
          const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
          const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
          const detail = err
            ? ('Ошибка: ' + err)
            : (exitCode !== null
                ? ('Ошибка (exit_code=' + exitCode + ')')
                : 'Ошибка перезапуска.');
          setStatus('Ошибка', true);
          try { if (detail && detail !== 'Ошибка') await appendSharedRestartLog('\n' + detail + '\n'); } catch (e) {}
          try { if (detail) setStatus(detail, true, true); } catch (e) {}
        }

        return ok;
      }

      const msg = 'config.yaml сохранён.';
      setStatus(msg, false, !!(data && data.restarted));
      try {
        if (data.restarted) refreshRestartLog();
      } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сохранения config.yaml.', true);
      return false;
    } finally {
      if (restart) {
        MP._restartJobRunning = false;
        setBtnBusy(false);
      }
    }
  };

  MP.saveAndRestart = async function saveAndRestart() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, сохранять нечего.', true);
      return false;
    }
    // Feature E: job-based restart (no long-running HTTP request).
    if (MP._restartJobRunning) {
      setStatus('Перезапуск уже выполняется…', true);
      return false;
    }

    const btn = $(IDS.btnSaveRestart);
    const setBtnBusy = (busy) => {
      if (!btn) return;
      try { btn.disabled = !!busy; } catch (e) {}
      try { btn.classList.toggle('is-busy', !!busy); } catch (e) {}
    };

    const clearRestartLogUi = async () => {
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
      MP._restartJobRunning = true;
      setBtnBusy(true);
      clearYamlErrorMarker();

      // Avoid noisy "loading..." toast: status line + streaming log is enough.
      setStatus('Сохраняю config.yaml и запускаю перезапуск…', false, true);
      await clearRestartLogUi();
      await appendRestartLog('⏳ Запуск xkeen -restart (job)…\n');

      // Backend endpoint: returns 202 + restart_job_id.
      const res = await fetch('/api/mihomo/generate_apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configOverride: content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const errMsg = (data && data.error) ? String(data.error) : 'Ошибка сохранения/перезапуска.';
        try {
          const lc = extractYamlLineCol(errMsg);
          if (lc && Number.isFinite(lc.line)) markYamlErrorLine(Math.max(0, lc.line - 1));
        } catch (e2) {}
        setStatus(errMsg, true);
        return false;
      }

      const jobId = data.restart_job_id || data.job_id || data.restartJobId || null;
      if (!jobId) {
        setStatus('Перезапуск запущен, но job_id не получен.', true);
        return false;
      }

      // Config is saved at this point.
      markEditorClean();
      bumpLastActivity('saved');

      setStatus('Перезапуск в очереди (job ' + String(jobId) + ')…', false, true);

      // Stream output via existing command_jobs polling/WS util.
      const CJ = getCommandJobApi();
      let result = null;

      if (CJ && typeof CJ.waitForCommandJob === 'function') {
        result = await CJ.waitForCommandJob(String(jobId), {
          maxWaitMs: 5 * 60 * 1000,
          onChunk: (chunk) => {
            try { void appendRestartLog(chunk); } catch (e) {}
          }
        });
      } else {
        // Minimal HTTP polling fallback.
        let lastLen = 0;
        while (true) {
          const pr = await fetch(`/api/run-command/${encodeURIComponent(String(jobId))}`);
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
        setStatus('Готово', false);
      } else {
        const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
        const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
        const msg = err ? ('Ошибка: ' + err) : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : 'Ошибка перезапуска.');
        // Requirement: final toast should be exactly "Ошибка"; show details in status/log without extra toast.
        setStatus('Ошибка', true);
        try { if (msg && msg !== 'Ошибка') await appendRestartLog('\n' + msg + '\n'); } catch (e) {}
        try { if (msg) setStatus(msg, true, true); } catch (e) {}
      }

      return ok;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка перезапуска (job).', true);
      return false;
    } finally {
      MP._restartJobRunning = false;
      setBtnBusy(false);
    }
  };

  MP.openZashboardUi = function openZashboardUi() {
    const url = window.location.protocol + '//' + window.location.host + '/mihomo_panel/ui/';
    try {
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      window.location.href = url;
    }
  };



  MP.formatYamlFromEditor = async function formatYamlFromEditor() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, форматировать нечего.', true);
      return false;
    }

    clearYamlErrorMarker();

    // Browser-side Prettier formatting (offline-capable via static/vendor).
    try {
      const formatters = await ensureFormattersReady();

      if (!formatters || typeof formatters.formatYaml !== 'function') {
        setStatus('Форматирование YAML недоступно (formatters не загружены).', true);
        return false;
      }

      // Avoid noisy "loading..." toast; keep only final result.
      setStatus('Форматирую YAML…', false, true);

      const r = await formatters.formatYaml(content);
      if (!r || !r.ok) {
        const err = (r && r.error) ? String(r.error) : 'unknown';
        const msg =
          (err === 'prettier_not_available')
            ? 'Prettier недоступен — форматирование YAML пропущено.'
            : ('Ошибка форматирования YAML: ' + err);
        try {
          const lc = extractYamlLineCol(err);
          if (lc && Number.isFinite(lc.line)) markYamlErrorLine(Math.max(0, lc.line - 1));
        } catch (e2) {}
        setStatus(msg, true);
        return false;
      }

      // In case the underlying Prettier build returns a Promise (v3+),
      // normalize defensively.
      const out = String(await Promise.resolve(r.text ?? ''));
      if (out === content) {
        clearYamlErrorMarker();
        setStatus('YAML уже отформатирован.', false);
        return true;
      }

      setEditorText(out);
      clearYamlErrorMarker();
      bumpLastActivity('formatted');
      setStatus('YAML отформатирован.', false);
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка форматирования YAML: ' + e, true);
      return false;
    }
  };

  // ---------- Validate modal ----------

  function formatValidationLogHtml(text) {
    if (!text) return '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    return lines
      .map((line) => {
        const safe = escapeHtml(line);
        let cls = 'log-line';
        if (/fatal|panic/i.test(line)) cls += ' log-fatal';
        else if (/error|\berr\b|err\[/i.test(line)) cls += ' log-error';
        else if (/warn/i.test(line)) cls += ' log-warn';
        else if (/info/i.test(line)) cls += ' log-info';
        else if (/debug/i.test(line)) cls += ' log-debug';
        return '<div class="' + cls + '">' + (safe || '&nbsp;') + '</div>';
      })
      .join('');
  }

  function showValidationModal(text) {
    const modal = $(IDS.validationModal);
    const body = $(IDS.validationBody);
    if (!modal || !body) return;
    body.innerHTML = formatValidationLogHtml(String(text ?? ''));
    modal.classList.remove('hidden');
    try { document.body.classList.add('modal-open'); } catch (e) {}
  }

  function hideValidationModal() {
    const modal = $(IDS.validationModal);
    if (!modal) return;
    modal.classList.add('hidden');
    try { document.body.classList.remove('modal-open'); } catch (e) {}
  }

  MP.validateFromEditor = async function validateFromEditor() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, проверять нечего.', true);
      return false;
    }

    clearYamlErrorMarker();
    setStatus('Проверяю конфиг через mihomo...', false);

    try {
      const res = await fetch('/api/mihomo/validate_raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: content }),
      });
      const data = await res.json().catch(() => ({}));
      const log = (data && typeof data.log === 'string') ? data.log : '';
      if (log.trim()) showValidationModal(log);

      if (!res.ok) {
        setStatus('Ошибка проверки конфига: ' + (data && (data.error || res.status)), true);
        return false;
      }

      const firstLine = (log.split('\n').find((l) => l.trim()) || '').trim();
      if (data.ok) {
        clearYamlErrorMarker();
        setStatus(firstLine || 'mihomo сообщает, что конфиг валиден (exit code 0).', false);
        return true;
      }
      try {
        const lc = extractYamlLineCol(firstLine || log);
        if (lc && Number.isFinite(lc.line)) markYamlErrorLine(Math.max(0, lc.line - 1));
      } catch (e2) {}
      setStatus('В таком виде конфиг не будет работать: ' + (firstLine || 'ошибка проверки.'), true);
      return false;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сети при проверке конфига: ' + e, true);
      return false;
    }
  };

  // ---------- Templates (config.yaml snippets) ----------

  function bumpLastActivity(kind) {
    try {
      if (typeof window.updateLastActivity === 'function') {
        const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
        window.updateLastActivity(kind || 'info', 'mihomo', fp);
      }
    } catch (e) {}
  }

  function getSelectedTemplateName() {
    const sel = $(IDS.tplSelect);
    if (!sel) return null;
    const v = String(sel.value || '').trim();
    return v || null;
  }

  MP.loadTemplatesList = async function loadTemplatesList(opts) {
    try {
      const o = opts || {};
      const silent = !!o.silent;
      if (!silent) setStatus('Загрузка списка шаблонов...', false);

      const res = await fetch('/api/mihomo-templates');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (!silent) setStatus((data && data.error) || 'Не удалось загрузить список шаблонов.', true);
        return false;
      }
      _templates = Array.isArray(data.templates) ? data.templates : [];
      _templatesLoaded = true;

      const sel = $(IDS.tplSelect);
      if (sel) {
        const current = sel.value;
        sel.innerHTML = '<option value="">— выбери шаблон —</option>';
        _templates.forEach((t) => {
          const name = String(t && t.name ? t.name : '').trim();
          if (!name) return;
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      }

      if (!silent) setStatus('Шаблоны загружены: ' + _templates.length, false);
      bumpLastActivity('loaded');
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки списка шаблонов.', true);
      return false;
    }
  };

  MP.saveEditorAsTemplate = async function saveEditorAsTemplate() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой — нечего сохранять в шаблон.', true);
      return false;
    }

    const name = window.prompt('Имя шаблона (например: myprofile.yaml):', _chosenTemplateName || '');
    if (!name) {
      setStatus('Сохранение шаблона отменено.', false);
      return false;
    }

    try {
      setStatus('Сохраняю шаблон...', false);
      const res = await fetch('/api/mihomo-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Не удалось сохранить шаблон.', true);
        return false;
      }
      _chosenTemplateName = name;
      setStatus('Шаблон сохранён: ' + name, false);
      bumpLastActivity('saved');
      // Refresh list but silently.
      try { await MP.loadTemplatesList({ silent: true }); } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сохранения шаблона.', true);
      return false;
    }
  };

  MP.loadSelectedTemplateToEditor = async function loadSelectedTemplateToEditor(opts) {
    const options = opts || {};
    const confirmDirty = !Object.prototype.hasOwnProperty.call(options, 'confirmDirty') || !!options.confirmDirty;

    try {
      if (!_templatesLoaded) {
        await MP.loadTemplatesList({ silent: true });
      }

      const chosen = getSelectedTemplateName();
      if (!chosen) {
        // Convenience: allow choosing by number if select is empty
        if (_templates && _templates.length) {
          const msg = _templates
            .map((t, i) => `${i + 1}. ${t.name}`)
            .join('\n');
          const num = window.prompt('Выбери номер шаблона:\n' + msg);
          if (!num) {
            setStatus('Шаблон не выбран.', true);
            return false;
          }
          const idx = parseInt(num, 10) - 1;
          if (!Number.isFinite(idx) || idx < 0 || idx >= _templates.length) {
            setStatus('Некорректный номер шаблона.', true);
            return false;
          }
          const tpl = _templates[idx];
          const templateConfirmText = 'Заменить содержимое редактора шаблоном ' + (tpl.name || 'template') + '?';
          const ok = await confirmAction({
            title: 'Загрузить шаблон',
            message: templateConfirmText,
            okText: 'Загрузить',
            cancelText: 'Отмена',
            danger: true,
          }, templateConfirmText);
          if (!ok) {
            setStatus('Загрузка шаблона отменена.', false);
            return false;
          }
          _chosenTemplateName = tpl.name;
        } else {
          setStatus('Шаблон не выбран.', true);
          return false;
        }
      } else {
        _chosenTemplateName = chosen;
      }

      if (confirmDirty && !(await confirmDiscardDirtyEditorChanges({
        title: 'Загрузить шаблон',
        message: 'Заменить содержимое редактора шаблоном "' + (_chosenTemplateName || 'template') + '"? Несохранённые изменения будут потеряны.',
        okText: 'Загрузить',
        cancelText: 'Отмена',
      }))) {
        setStatus('Загрузка шаблона отменена.', false);
        return false;
      }

      setStatus('Загрузка шаблона...', false);
      const res = await fetch('/api/mihomo-template?name=' + encodeURIComponent(_chosenTemplateName));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Не удалось загрузить шаблон.', true);
        return false;
      }
      const content = data.content || '';
      setEditorTextClean(content);
      setStatus('Шаблон ' + _chosenTemplateName + ' загружен в редактор. Не забудьте сохранить config.yaml.', false);
      bumpLastActivity('loaded');
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки шаблона.', true);
      return false;
    }
  };

  // ---------- Profiles / backups ----------

  function updateBackupsFilterUI() {
    const label = $(IDS.backupsActiveProfileLabel);
    const checkbox = $(IDS.backupsActiveOnly);
    if (!label || !checkbox) return;
    if (_activeProfileName) {
      label.textContent = 'Активный профиль: ' + _activeProfileName;
      checkbox.disabled = false;
    } else {
      label.textContent = 'Активный профиль не выбран';
      checkbox.disabled = true;
    }
  }

  function getBackupsFilterProfile() {
    const checkbox = $(IDS.backupsActiveOnly);
    if (!checkbox || !checkbox.checked) return null;
    return _activeProfileName || null;
  }

  function formatBackupDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    try { return d.toLocaleString(); } catch (e) { return String(value); }
  }

  function parseBackupFilename(filename) {
    const m = filename && filename.match(/^(.+?)_(\d{8})_(\d{6})\.yaml$/);
    if (!m) return { profile: null, created: null };
    const base = m[1];
    const profile = base.endsWith('.yaml') ? base : base + '.yaml';
    let created = null;
    try {
      const year = Number(m[2].slice(0, 4));
      const month = Number(m[2].slice(4, 6)) - 1;
      const day = Number(m[2].slice(6, 8));
      const hours = Number(m[3].slice(0, 2));
      const minutes = Number(m[3].slice(2, 4));
      const seconds = Number(m[3].slice(4, 6));
      const d = new Date(year, month, day, hours, minutes, seconds);
      if (!Number.isNaN(d.getTime())) created = d;
    } catch (e) {
      created = null;
    }
    return { profile, created };
  }

  MP.loadProfiles = async function loadProfiles() {
    const tbody = $(IDS.profilesList);
    if (!tbody) return false;
    tbody.innerHTML = '<tr><td colspan="3">Загрузка...</td></tr>';
    try {
      const res = await fetch('/api/mihomo/profiles');
      const data = await res.json().catch(() => null);
      if (!Array.isArray(data)) {
        tbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки профилей</td></tr>';
        return false;
      }
      tbody.innerHTML = '';
      _activeProfileName = null;
      data.forEach((p) => {
        const name = String(p && p.name ? p.name : '');
        const isActive = !!(p && p.is_active);
        if (isActive) _activeProfileName = name;
        const tr = document.createElement('tr');
        tr.dataset.name = name;
        tr.innerHTML = [
          '<td>' + escapeHtml(name) + '</td>',
          '<td>' + (isActive ? 'да' : '') + '</td>',
          '<td>' +
            '<button data-action="load" title="В редактор">📥</button> ' +
            '<button data-action="activate">✅ Активировать</button> ' +
            '<button data-action="delete">🗑️ Удалить</button>' +
          '</td>',
        ].join('');
        tbody.appendChild(tr);
      });
      updateBackupsFilterUI();
      return true;
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки профилей</td></tr>';
      return false;
    }
  };

  MP.loadBackups = async function loadBackups() {
    const tbody = $(IDS.backupsList);
    if (!tbody) return false;
    tbody.innerHTML = '<tr><td colspan="4">Загрузка...</td></tr>';
    try {
      let url = '/api/mihomo/backups';
      const profile = getBackupsFilterProfile();
      if (profile) url += '?profile=' + encodeURIComponent(profile);
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!Array.isArray(data)) {
        tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки бэкапов</td></tr>';
        return false;
      }

      tbody.innerHTML = '';
      data.forEach((b) => {
        const tr = document.createElement('tr');
        tr.dataset.filename = b.filename;

        const created = formatBackupDate(b.created_at);
        const isOwnProfile = !_activeProfileName || !b.profile || _activeProfileName === b.profile;
        const restoreAttrs = isOwnProfile
          ? ' title="Восстановить"'
          : ' disabled title="Восстановить: активный профиль (' + escapeHtml(_activeProfileName) +
            ') не совпадает с профилем бэкапа (' + escapeHtml(b.profile) + ')"';

        tr.innerHTML = [
          '<td>' +
            '<div class="backup-filename-marquee" title="' + escapeHtml(b.filename) + '">' +
              '<span class="backup-filename-marquee-inner">' + escapeHtml(b.filename) + '</span>' +
            '</div>' +
          '</td>',
          '<td>' + escapeHtml(b.profile || '') + '</td>',
          '<td>' + escapeHtml(created) + '</td>',
          '<td>' +
            '<button data-action="preview" title="В редактор">👁️</button> ' +
            '<button data-action="restore"' + restoreAttrs + '>⏪</button> ' +
            '<button data-action="delete" title="Удалить бэкап">🗑️</button>' +
          '</td>',
        ].join('');
        tbody.appendChild(tr);
      });

      return true;
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки бэкапов</td></tr>';
      return false;
    }
  };

  MP.createProfileFromEditor = async function createProfileFromEditor() {
    const nameInput = $(IDS.newProfileName);
    const name = String((nameInput && nameInput.value) || '').trim();
    const cfg = String(getEditorText() || '').trim();
    if (!name || !cfg) {
      setStatus('Имя профиля и config.yaml не должны быть пустыми.', true);
      return false;
    }

    try {
      const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: cfg,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setStatus(data.error || 'Ошибка создания профиля.', true);
        return false;
      }
      setStatus('Профиль ' + name + ' создан.', false);
      await MP.loadProfiles();
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка создания профиля.', true);
      return false;
    }
  };

  MP.cleanBackups = async function cleanBackups() {
    const limitInput = $(IDS.backupsCleanLimit);
    const raw = String((limitInput && limitInput.value) || '5');
    const limit = parseInt(raw, 10);
    if (Number.isNaN(limit) || limit < 0) {
      setStatus('Лимит должен быть целым числом ≥ 0.', true);
      return false;
    }

    const profile = getBackupsFilterProfile();
    const confirmText =
      'Очистить бэкапы' +
      (profile ? ' для профиля ' + profile : ' для всех профилей') +
      ', оставив не более ' + limit + ' шт.?';

    const ok = await confirmAction({
      title: 'Очистить бэкапы',
      message: confirmText,
      okText: 'Очистить',
      cancelText: 'Отменить',
      danger: true,
    }, confirmText);

    if (!ok) return false;

    try {
      const res = await fetch('/api/mihomo/backups/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit, profile }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setStatus(data.error || 'Ошибка очистки бэкапов.', true);
        return false;
      }
      const remaining = (data.remaining && data.remaining.length) || 0;
      let msg = 'Очистка бэкапов выполнена. Осталось ' + remaining + ' файлов.';
      if (profile) msg += ' Профиль: ' + profile + '.';
      setStatus(msg, false);
      await MP.loadBackups();
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка очистки бэкапов.', true);
      return false;
    }
  };

  function attachProfilesHandlers() {
    const tbody = $(IDS.profilesList);
    if (!tbody) return;
    if (tbody.dataset && tbody.dataset.xkeenBound === '1') return;
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const name = tr && tr.dataset.name;
      const action = btn.dataset.action;
      if (!name || !action) return;

      if (action === 'load') {
        try {
          const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name));
          const text = await res.text();
          if (!res.ok) {
            setStatus('Ошибка загрузки профиля ' + name, true);
            return;
          }
          setEditorText(text);
          setStatus('Профиль ' + name + ' загружен в редактор.', false);
          refreshEditorIfAny();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка загрузки профиля.', true);
        }
        return;
      }

      if (action === 'activate') {
        if (!(await confirmDiscardDirtyEditorChanges({
          title: 'Активировать профиль',
          message: 'Активировать профиль ' + name + '? Несохранённые изменения в редакторе будут потеряны, а config.yaml будет заменён содержимым профиля.',
          okText: 'Активировать',
          cancelText: 'Отмена',
        }))) return;

        try {
          const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name) + '/activate', { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setStatus(data.error || 'Ошибка активации профиля.', true);
            return;
          }
          let msg = 'Профиль ' + name + ' активирован.';
          setStatus(msg, false, !!(data && data.restarted));
          await MP.loadProfiles();
          const syncResult = await loadLiveConfigIntoEditor();
          if (!syncResult.ok) {
            setStatus(msg + ' config.yaml уже изменён на сервере, но редактор не удалось обновить. Загрузите config.yaml ещё раз.', true);
          }
          if (data.restarted) {
            try { refreshRestartLog(); } catch (e) {}
          }
        } catch (err) {
          console.error(err);
          setStatus('Ошибка активации профиля.', true);
        }
        return;
      }

      if (action === 'delete') {
        const ok = await confirmAction({
          title: 'Удалить профиль',
          message: 'Удалить профиль ' + name + '?',
          okText: 'Удалить',
          cancelText: 'Отменить',
          danger: true,
        }, 'Удалить профиль ' + name + '?');
        if (!ok) return;

        try {
          const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setStatus(data.error || 'Ошибка удаления профиля.', true);
            return;
          }
          setStatus('Профиль ' + name + ' удалён.', false);
          await MP.loadProfiles();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка удаления профиля.', true);
        }
      }
    });
    if (tbody.dataset) tbody.dataset.xkeenBound = '1';
  }

  function attachBackupsHandlers() {
    const tbody = $(IDS.backupsList);
    if (!tbody) return;
    if (tbody.dataset && tbody.dataset.xkeenBound === '1') return;
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const tr = btn.closest('tr');
      const filename = tr && tr.dataset.filename;
      const action = btn.dataset.action;
      if (!filename || !action) return;

      if (action === 'preview') {
        try {
          const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename));
          const text = await res.text();
          if (!res.ok) {
            setStatus('Ошибка загрузки бэкапа ' + filename, true);
            return;
          }
          setEditorText(text);
          const info = parseBackupFilename(filename);
          let msg = 'Бэкап';
          if (info.profile) msg += ' профиля ' + info.profile;
          else msg += ' ' + filename;
          if (info.created instanceof Date && !Number.isNaN(info.created.getTime())) {
            try { msg += ' от ' + info.created.toLocaleString(); } catch (e) {}
          }
          msg += ' загружен в редактор (не применён).';
          setStatus(msg, false);
          refreshEditorIfAny();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка загрузки бэкапа.', true);
        }
        return;
      }

      if (action === 'restore') {
        if (!(await confirmDiscardDirtyEditorChanges({
          title: 'Восстановить бэкап',
          message: 'Восстановление из бэкапа заменит текущее содержимое редактора. Несохранённые изменения будут потеряны.',
          okText: 'Продолжить',
          cancelText: 'Отмена',
        }))) return;

        const ok = await confirmAction({
          title: 'Восстановить бэкап',
          message: 'Восстановить конфиг из бэкапа ' + filename + '?',
          okText: 'Восстановить',
          cancelText: 'Отменить',
          danger: true,
        }, 'Восстановить конфиг из бэкапа ' + filename + '?');
        if (!ok) return;
        try {
          const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename) + '/restore', { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setStatus(data.error || 'Ошибка восстановления бэкапа.', true);
            return;
          }
          let msg = 'Бэкап ' + filename + ' восстановлен.';
          setStatus(msg, false, !!(data && data.restarted));
          const syncResult = await loadLiveConfigIntoEditor();
          if (syncResult.ok) {
            if (!data.restarted) {
              setStatus('Бэкап ' + filename + ' восстановлен. Перезапуск не выполнен автоматически.', false);
            }
          } else {
            setStatus('Бэкап ' + filename + ' восстановлен, но редактор не удалось обновить. Загрузите config.yaml ещё раз.', true);
          }
          try { if (data.restarted) refreshRestartLog(); } catch (e) {}
        } catch (err) {
          console.error(err);
          setStatus('Ошибка восстановления бэкапа.', true);
        }
        return;
      }

      if (action === 'delete') {
        const ok = await confirmAction({
          title: 'Удалить бэкап',
          message: 'Удалить бэкап ' + filename + '? Это действие необратимо.',
          okText: 'Удалить',
          cancelText: 'Отменить',
          danger: true,
        }, 'Удалить бэкап ' + filename + '? Это действие необратимо.');
        if (!ok) return;
        try {
          const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename), { method: 'DELETE' });
          const data = await res.json().catch(() => null);
          if (!res.ok || (data && data.error)) {
            setStatus((data && data.error) || 'Ошибка удаления бэкапа.', true);
            return;
          }
          setStatus('Бэкап ' + filename + ' удалён.', false);
          await MP.loadBackups();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка удаления бэкапа.', true);
        }
      }
    });
    if (tbody.dataset) tbody.dataset.xkeenBound = '1';
  }

  // ---------- Init / wiring ----------

  function wireButton(btnId, handler) {
    const btn = $(btnId);
    if (!btn) return;
    if (btn.dataset && btn.dataset.xkeenWired === '1') return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      handler();
    });
    if (btn.dataset) btn.dataset.xkeenWired = '1';
  }

  MP.init = function init() {
    const root = $(IDS.view) || document.body;
    const ta = $(IDS.textarea);
    if (!ta) return; // not on this page

    if (_inited || (root.dataset && root.dataset.xkeenMihomoPanelInited === '1')) return;
    _inited = true;
    if (root.dataset) root.dataset.xkeenMihomoPanelInited = '1';

    const finishInit = () => {
      ensureEditor();
      try { initEngineToggle(); } catch (e) {}
      try { syncHeaderFsButton(_engine); } catch (e) {}
      try { bindViewStateTracking(); } catch (e2) {}
      try { wireMihomoCardToggle(); } catch (e3) {}
      try { wireValidationModal(); } catch (e4) {}

      // Main actions
      wireButton(IDS.btnLoad, () => MP.loadConfig());
      wireButton(IDS.btnSave, () => MP.saveConfig());
      wireButton(IDS.btnFormatYaml, () => MP.formatYamlFromEditor());
      wireButton(IDS.btnValidate, () => MP.validateFromEditor());
      wireButton(IDS.btnSaveRestart, () => MP.saveAndRestart());
      wireButton(IDS.btnOpenZashboardUi, () => MP.openZashboardUi());

      // Templates
      wireButton(IDS.tplRefresh, () => MP.loadTemplatesList());
      wireButton(IDS.tplLoad, () => MP.loadSelectedTemplateToEditor());
      wireButton(IDS.tplSaveFromEditor, () => MP.saveEditorAsTemplate());

      // Template select: auto-load on change (with overwrite confirmation if there are unsaved edits).
      const tplSel = $(IDS.tplSelect);
      if (tplSel && (!tplSel.dataset || tplSel.dataset.xkeenAutoLoad !== '1')) {
        _lastTemplateSelectValue = String(tplSel.value || '');
        tplSel.addEventListener('change', async () => {
          const next = String(tplSel.value || '');
          const prev = _lastTemplateSelectValue;
          if (!next) {
            _lastTemplateSelectValue = '';
            return;
          }

          if (isEditorDirty()) {
            const msg = 'Заменить содержимое редактора шаблоном “' + next + '”? Несохранённые изменения будут потеряны.';
            const ok = await confirmAction({
              title: 'Загрузить шаблон',
              message: msg,
              okText: 'Загрузить',
              cancelText: 'Отмена',
              danger: true,
            }, msg);

            if (!ok) {
              try { tplSel.value = prev; } catch (e) {}
              return;
            }
          }

          const loaded = await MP.loadSelectedTemplateToEditor({ confirmDirty: false });
          if (!loaded) {
            try { tplSel.value = prev; } catch (e) {}
            return;
          }
          _lastTemplateSelectValue = next;
          try {
            const d = (tplSel && tplSel.closest) ? tplSel.closest('details') : null;
            if (d && d.classList && d.classList.contains('xk-mihomo-menu')) d.open = false;
          } catch (e) {}
        });
        if (tplSel.dataset) tplSel.dataset.xkeenAutoLoad = '1';
      }

      // Auto-close the compact ⋯ menu after clicking an action button (keeps UI tidy).
      try {
        const details = document.querySelector('details.xk-mihomo-menu');
        const panel = details ? details.querySelector('.xk-mihomo-menu-panel') : null;
        if (details && panel && !(details.dataset && details.dataset.xkAutoClose === '1')) {
          panel.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('button') : null;
            if (!btn) return;
            try { details.open = false; } catch (e2) {}
          });
          if (details.dataset) details.dataset.xkAutoClose = '1';
        }
      } catch (e) {}

      // Profiles panel toggler
      const header = $(IDS.profilesHeader);
      const panel = $(IDS.profilesPanel);
      const arrow = $(IDS.profilesArrow);
      if (header && panel && (!header.dataset || header.dataset.xkeenWired !== '1')) {
        header.addEventListener('click', async (e) => {
          e.preventDefault();
          const visible = panel.style.display !== 'none';
          panel.style.display = visible ? 'none' : 'block';
          if (arrow) arrow.textContent = visible ? '▼' : '▲';
          if (!visible) {
            await MP.loadProfiles();
            await MP.loadBackups();
          }
        });
        if (header.dataset) header.dataset.xkeenWired = '1';
      }

      wireButton(IDS.profilesRefresh, async () => {
        setStatus('Обновляю список профилей…', false);
        const ok = await MP.loadProfiles();
        setStatus(ok ? 'Список профилей обновлён.' : 'Ошибка загрузки профилей.', !ok);
      });

      wireButton(IDS.backupsRefresh, async () => {
        setStatus('Обновляю список бэкапов…', false);
        const ok = await MP.loadBackups();
        setStatus(ok ? 'Список бэкапов обновлён.' : 'Ошибка загрузки бэкапов.', !ok);
      });

      wireButton(IDS.saveProfileBtn, () => MP.createProfileFromEditor());
      wireButton(IDS.backupsCleanBtn, () => MP.cleanBackups());

      const filter = $(IDS.backupsActiveOnly);
      if (filter && (!filter.dataset || filter.dataset.xkeenWired !== '1')) {
        filter.addEventListener('change', () => {
          MP.loadBackups();
        });
        if (filter.dataset) filter.dataset.xkeenWired = '1';
      }

      attachProfilesHandlers();
      attachBackupsHandlers();
      // Initial loads:
      // avoid an unnecessary 404 on fresh installs/dev fallback when config.yaml
      // does not exist yet. The user can still click "Load" explicitly later.
      if (hasInitialMihomoConfig()) {
        try { MP.loadConfig({ notify: false }); } catch (e) {}
      } else {
        try { setEditorTextClean(''); } catch (e) {}
        try { setStatus('config.yaml пока не создан. Открыт пустой редактор.', false, true); } catch (e) {}
      }
      try { MP.loadTemplatesList({ silent: true }); } catch (e) {}
    };

    try {
      Promise.resolve(ensureEditorRuntime('codemirror', {
        mode: 'yaml',
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
              mode: 'yaml',
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

  MP.getEditorText = getEditorText;
  MP.setEditorText = setEditorText;
  MP.refreshEditor = refreshEditorIfAny;
  MP.isEditorDirty = isEditorDirty;
})();

export function getMihomoPanelApi() {
  try {
    if (mihomoPanelModuleApi && typeof mihomoPanelModuleApi.init === 'function') return mihomoPanelModuleApi;
  } catch (error) {
    console.error(error);
  }
  return null;
}

function callMihomoPanelApi(method, ...args) {
  const api = getMihomoPanelApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initMihomoPanel(...args) {
  return callMihomoPanelApi('init', ...args);
}

export function loadMihomoPanel(...args) {
  return callMihomoPanelApi('loadConfig', ...args);
}

export function onShowMihomoPanel(...args) {
  return callMihomoPanelApi('refreshEditor', ...args);
}

export function saveMihomoPanel(...args) {
  return callMihomoPanelApi('saveConfig', ...args);
}

export function saveAndRestartMihomoPanel(...args) {
  return callMihomoPanelApi('saveAndRestart', ...args);
}

export function validateMihomoPanel(...args) {
  return callMihomoPanelApi('validateFromEditor', ...args);
}

export function formatMihomoPanelYaml(...args) {
  return callMihomoPanelApi('formatYamlFromEditor', ...args);
}

export function loadMihomoTemplatesList(...args) {
  return callMihomoPanelApi('loadTemplatesList', ...args);
}

export function saveMihomoEditorAsTemplate(...args) {
  return callMihomoPanelApi('saveEditorAsTemplate', ...args);
}

export function loadSelectedMihomoTemplate(...args) {
  return callMihomoPanelApi('loadSelectedTemplateToEditor', ...args);
}

export function loadMihomoProfiles(...args) {
  return callMihomoPanelApi('loadProfiles', ...args);
}

export function loadMihomoBackups(...args) {
  return callMihomoPanelApi('loadBackups', ...args);
}

export function createMihomoProfileFromEditor(...args) {
  return callMihomoPanelApi('createProfileFromEditor', ...args);
}

export function cleanMihomoBackups(...args) {
  return callMihomoPanelApi('cleanBackups', ...args);
}

export function openMihomoZashboardUi(...args) {
  return callMihomoPanelApi('openZashboardUi', ...args);
}

export function getMihomoPanelEditorText(...args) {
  return callMihomoPanelApi('getEditorText', ...args);
}

export function setMihomoPanelEditorText(...args) {
  return callMihomoPanelApi('setEditorText', ...args);
}

export function isMihomoPanelEditorDirty(...args) {
  return callMihomoPanelApi('isEditorDirty', ...args);
}

export function disposeMihomoPanel(...args) {
  return callMihomoPanelApi('dispose', ...args);
}

export const mihomoPanelApi = Object.freeze({
  get: getMihomoPanelApi,
  init: initMihomoPanel,
  load: loadMihomoPanel,
  onShow: onShowMihomoPanel,
  save: saveMihomoPanel,
  saveAndRestart: saveAndRestartMihomoPanel,
  validate: validateMihomoPanel,
  formatYaml: formatMihomoPanelYaml,
  loadTemplatesList: loadMihomoTemplatesList,
  saveEditorAsTemplate: saveMihomoEditorAsTemplate,
  loadSelectedTemplateToEditor: loadSelectedMihomoTemplate,
  loadProfiles: loadMihomoProfiles,
  loadBackups: loadMihomoBackups,
  createProfileFromEditor: createMihomoProfileFromEditor,
  cleanBackups: cleanMihomoBackups,
  openZashboardUi: openMihomoZashboardUi,
  getEditorText: getMihomoPanelEditorText,
  setEditorText: setMihomoPanelEditorText,
  isEditorDirty: isMihomoPanelEditorDirty,
  dispose: disposeMihomoPanel,
});
