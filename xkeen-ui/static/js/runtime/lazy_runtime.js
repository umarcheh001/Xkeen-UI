import {
  getXkeenCm6RuntimeApi,
  getXkeenDatContentsApi,
  getXkeenEditorActionsApi,
  getXkeenEditorLinksApi,
  getXkeenEditorToolbarApi,
  getXkeenJsonEditorApi,
  getXkeenMonacoLoaderApi,
  getXkeenMonacoSharedApi,
  getXkeenPagesApi,
  getXkeenTerminalRoot,
  isXkeenDebugRuntime,
} from '../features/xkeen_runtime.js';
import {
  appendTerminalDebug,
  finishTerminalDebugRun,
  markTerminalDebugState,
} from '../features/terminal_debug.js';

// Narrow lazy runtime adapter for generic deferred bundles and shell-bound feature APIs.
// Do not add page-specific loaders here; new code must use direct import() or panel-local lazy bindings.

(() => {
  "use strict";

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.runtime = XK.runtime || {};

  function safeInvoke(fn) {
    try { return fn(); } catch (e) {
      try { console.error(e); } catch (e2) {}
      return undefined;
    }
  }

  function emitLazyEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(String(name || ''), { detail: detail || {} }));
    } catch (e) {}
  }

  const bundleLoaders = {
    terminal: () => import('../pages/terminal.lazy.entry.js').then((mod) => {
      if (mod && typeof mod.ensureTerminalBundleReady === 'function') return mod.ensureTerminalBundleReady();
      return true;
    }),
    fileManager: () => import('../pages/file_manager.lazy.entry.js').then((mod) => {
      if (mod && typeof mod.ensureFileManagerBundleReady === 'function') return mod.ensureFileManagerBundleReady();
      return true;
    }),
    monacoShared: () => import('../pages/editor_monaco.shared.js'),
    codemirrorShared: () => import('../pages/codemirror6.shared.js'),
  };

  const featureLoaders = {
    backups: () => import('../features/backups.js'),
    jsonEditor: () => import('../ui/json_editor_modal.js'),
    datContents: () => import('../ui/dat_contents_modal.js'),
  };

  function getFeatureLoader(name) {
    const key = String(name || '');
    return key ? (featureLoaders[key] || null) : null;
  }

  const featureModules = Object.create(null);
  const featureModulePromises = Object.create(null);

  function loadFeatureModule(name) {
    const key = String(name || '');
    if (!key) return Promise.resolve(null);
    if (featureModules[key]) return Promise.resolve(featureModules[key]);
    if (featureModulePromises[key]) return featureModulePromises[key];

    const loader = getFeatureLoader(key);
    if (typeof loader !== 'function') return Promise.resolve(null);

    featureModulePromises[key] = Promise.resolve()
      .then(() => loader())
      .then((mod) => {
        featureModules[key] = mod || null;
        return featureModules[key];
      })
      .catch((error) => {
        featureModules[key] = null;
        throw error;
      })
      .finally(() => {
        featureModulePromises[key] = null;
      });

    return featureModulePromises[key];
  }

  const featureReady = Object.create(null);
  const featureLoading = Object.create(null);
  const editorSupportPromises = Object.create(null);
  let terminalLoaded = false;
  let terminalPromise = null;
  let fileManagerLoaded = false;
  let fileManagerPromise = null;

  let fileManagerApiModulePromise = null;

  function loadFileManagerApiModule() {
    if (!fileManagerApiModulePromise) {
      fileManagerApiModulePromise = import('../features/file_manager.js').catch((error) => {
        fileManagerApiModulePromise = null;
        throw error;
      });
    }
    return fileManagerApiModulePromise;
  }

  async function getFileManagerRuntimeApi() {
    try {
      const mod = await loadFileManagerApiModule();
      const getter = mod && typeof mod.getFileManagerApi === 'function' ? mod.getFileManagerApi : null;
      const api = typeof getter === 'function' ? getter() : null;
      return api || null;
    } catch (error) {
      return null;
    }
  }

  function normalizeEditorEngine(engine) {
    const next = String(engine || '').toLowerCase().trim();
    return (next === 'monaco' || next === 'codemirror') ? next : '';
  }

  function getBundleLoader(name) {
    const key = String(name || '');
    return key ? (bundleLoaders[key] || null) : null;
  }

  function getEditorSupportBundleLoader(engine) {
    const next = normalizeEditorEngine(engine);
    if (next === 'monaco') return getBundleLoader('monacoShared');
    if (next === 'codemirror') return getBundleLoader('codemirrorShared');
    return null;
  }

  function getEditorLoader(engine) {
    const next = normalizeEditorEngine(engine);
    try {
      if (next === 'monaco') return getXkeenMonacoLoaderApi();
      if (next === 'codemirror') return null;
    } catch (e) {}
    return null;
  }

  function getCodeMirror6Runtime() {
    return getXkeenCm6RuntimeApi();
  }

  function hasCodeMirrorSharedLayer() {
    try {
      const editorActions = getXkeenEditorActionsApi();
      const editorLinks = getXkeenEditorLinksApi();
      const editorToolbar = getXkeenEditorToolbarApi();
      return !!(
        editorActions &&
        editorToolbar && typeof editorToolbar.buildCommonKeys === 'function' &&
        typeof editorToolbar.attach === 'function' &&
        editorLinks && typeof editorLinks.setEnabled === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  function hasCodeMirrorSupport() {
    try {
      if (!hasCodeMirrorSharedLayer()) return false;
      const cm6Runtime = getCodeMirror6Runtime();
      if (!cm6Runtime) return false;
      if (typeof cm6Runtime.isReady === 'function' && cm6Runtime.isReady()) return true;
      return typeof cm6Runtime.create === 'function' || typeof cm6Runtime.ensure === 'function';
    } catch (e) {
      return false;
    }
  }

  function hasMonacoSupport() {
    try {
      const loader = getEditorLoader('monaco');
      const monacoShared = getXkeenMonacoSharedApi();
      return !!(
        loader &&
        typeof loader.ensureSupport === 'function' &&
        ((typeof loader.isReady === 'function' && loader.isReady()) || (typeof loader.ensureMonaco === 'function')) &&
        monacoShared &&
        typeof monacoShared.createEditor === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  function hasEditorSupport(engine) {
    const next = normalizeEditorEngine(engine);
    if (next === 'monaco') return hasMonacoSupport();
    if (next === 'codemirror') return hasCodeMirrorSupport();
    return false;
  }

  function hasEditorRuntimeWrappers(engine) {
    const next = normalizeEditorEngine(engine);
    try {
      if (next === 'monaco') {
        const monacoShared = getXkeenMonacoSharedApi();
        return !!(
          getEditorLoader('monaco') &&
          monacoShared &&
          typeof monacoShared.createEditor === 'function'
        );
      }
      if (next === 'codemirror') {
        return !!(
          hasCodeMirrorSharedLayer() &&
          !!getCodeMirror6Runtime()
        );
      }
    } catch (e) {}
    return false;
  }

  function getFeatureApi(name) {
    const key = String(name || '');
    try {
      switch (key) {
        case 'backups': {
          const mod = featureModules[key] || null;
          const getter = mod && typeof mod.getBackupsApi === 'function' ? mod.getBackupsApi : null;
          const api = typeof getter === 'function' ? getter() : null;
          return api || XK.backups || null;
        }
        case 'xrayLogs':
        case 'inbounds':
        case 'outbounds': {
          const managed = getBuildManagedFeatureLoader(key);
          return managed || null;
        }
        case 'jsonEditor':
          return getXkeenJsonEditorApi();
        case 'datContents':
          return getXkeenDatContentsApi();
        default:
          return null;
      }
    } catch (e) {
      return null;
    }
  }

  function getBuildManagedFeatureLoader(name) {
    try {
      const pagesApi = getXkeenPagesApi();
      switch (String(name || '')) {
        case 'xrayLogs': {
          const api = pagesApi ? (pagesApi.logsShell || null) : null;
          return api && typeof api.ensureReady === 'function' ? api : null;
        }
        case 'inbounds': {
          const api = pagesApi ? (pagesApi.configShell || null) : null;
          return (api && typeof api.ensureInboundsReady === 'function') ? {
            isReady: function () {
              return !!(typeof api.isInboundsReady === 'function' && api.isInboundsReady());
            },
            ensureReady: function () {
              if (typeof api.activateInboundsView === 'function') {
                return api.activateInboundsView({ reason: 'lazy-runtime' });
              }
              return api.ensureInboundsReady();
            },
          } : null;
        }
        case 'outbounds': {
          const api = pagesApi ? (pagesApi.configShell || null) : null;
          return (api && typeof api.ensureOutboundsReady === 'function') ? {
            isReady: function () {
              return !!(typeof api.isOutboundsReady === 'function' && api.isOutboundsReady());
            },
            ensureReady: function () {
              if (typeof api.activateOutboundsView === 'function') {
                return api.activateOutboundsView({ reason: 'lazy-runtime' });
              }
              return api.ensureOutboundsReady();
            },
          } : null;
        }
        default:
          return null;
      }
    } catch (e) {
      return null;
    }
  }

  function isFeatureStub(feature) {
    try {
      return !!(feature && feature.__xkLazyStubInstalled);
    } catch (e) {
      return false;
    }
  }

  function initFeature(name) {
    const feature = getFeatureApi(name);
    switch (String(name || '')) {
      case 'xrayLogs':
      case 'inbounds':
      case 'outbounds':
      case 'backups':
      case 'jsonEditor':
        if (feature && typeof feature.init === 'function') feature.init();
        break;
      case 'datContents':
      default:
        break;
    }
  }

  function isFeatureReady(name) {
    const key = String(name || '');
    const buildLoader = getBuildManagedFeatureLoader(key);
    if (buildLoader && typeof buildLoader.isReady === 'function') {
      try {
        if (buildLoader.isReady()) return true;
      } catch (e) {}
    }
    return !!featureReady[key];
  }

  function ensureFeature(name) {
    const key = String(name || '');
    if (!key) return Promise.resolve(false);
    if (isFeatureReady(key)) return Promise.resolve(true);
    if (featureLoading[key]) return featureLoading[key];

    featureLoading[key] = (async () => {
      const buildLoader = getBuildManagedFeatureLoader(key);
      if (buildLoader && typeof buildLoader.ensureReady === 'function') {
        const managed = await buildLoader.ensureReady();
        if (!managed) throw new Error('failed to load build-managed feature: ' + key);
        featureReady[key] = true;
        emitLazyEvent('xkeen:lazy-feature-ready', { name: key, api: getFeatureApi(key) || managed });
        return true;
      }

      const existing = getFeatureApi(key);
      if (!existing || isFeatureStub(existing)) {
        try {
          const mod = await loadFeatureModule(key);
          if (!mod && typeof getFeatureLoader(key) === 'function') {
            throw new Error('missing lazy feature module after import: ' + key);
          }
        } catch (error) {
          throw new Error('failed to import lazy feature module: ' + key);
        }
      }

      safeInvoke(() => initFeature(key));
      let loadedApi = null;
      safeInvoke(() => {
        loadedApi = getFeatureApi(key);
        if (loadedApi && loadedApi.__xkLazyStubInstalled) {
          try { delete loadedApi.__xkLazyStubInstalled; } catch (e) {}
        }
      });
      loadedApi = getFeatureApi(key) || loadedApi;
      if (!loadedApi || isFeatureStub(loadedApi)) {
        throw new Error('lazy feature did not install api: ' + key);
      }

      featureReady[key] = true;
      emitLazyEvent('xkeen:lazy-feature-ready', { name: key, api: loadedApi });
      return true;
    })().catch((err) => {
      try { console.error('[XKeen] lazy feature failed:', key, err); } catch (e) {}
      featureReady[key] = false;
      emitLazyEvent('xkeen:lazy-feature-failed', { name: key, error: err || null });
      return false;
    }).finally(() => {
      featureLoading[key] = null;
    });

    return featureLoading[key];
  }

  function isTerminalReady() {
    return !!terminalLoaded;
  }

  function withLoaderTimeout(promise, timeoutMs, label) {
    const waitMs = Math.max(1000, Number(timeoutMs) || 0);
    if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise);

    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(String(label || 'lazy loader timeout')));
        }, waitMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function ensureTerminalReady() {
    if (terminalLoaded) return Promise.resolve(true);
    if (terminalPromise) return terminalPromise;

    terminalPromise = (async () => {
      const bundleLoader = getBundleLoader('terminal');
      if (typeof bundleLoader !== 'function') throw new Error('missing terminal bundle loader');

      const termOk = await withLoaderTimeout(bundleLoader(), 8000, 'terminal bundle timeout');
      if (!termOk) throw new Error('failed to load terminal bundle');

      let terminalRoot = getXkeenTerminalRoot() || XK.terminal || null;

      if (!terminalRoot || typeof terminalRoot.init !== 'function') {
        try {
          await import('../terminal/terminal.js');
        } catch (error) {}
        terminalRoot = getXkeenTerminalRoot() || XK.terminal || null;
      }

      const initResult = safeInvoke(() => {
        if (terminalRoot && typeof terminalRoot.ensureReady === 'function') return terminalRoot.ensureReady();
        if (terminalRoot && typeof terminalRoot.init === 'function') return terminalRoot.init();
        if (terminalRoot && typeof terminalRoot.bootstrap === 'function') {
          terminalRoot.bootstrap();
          return true;
        }
        return false;
      });

      safeInvoke(() => {
        terminalRoot = getXkeenTerminalRoot() || XK.terminal || null;
        const api = terminalRoot ? terminalRoot.api : null;
        if (api && api.__xkLazyStubInstalled && terminalRoot && terminalRoot.core && typeof terminalRoot.core.createPublicApi === 'function') {
          console.warn('[XKeen] terminal.api is still a lazy stub after init; reinstalling public API (regression guard)');
          terminalRoot.api = terminalRoot.core.createPublicApi();
        }
      });

      if (initResult === false) {
        try { console.warn('[XKeen] terminal bundle loaded but init is deferred: terminal UI/context not ready yet'); } catch (e) {}
        terminalLoaded = false;
        terminalPromise = null;
        emitLazyEvent('xkeen:lazy-terminal-deferred', { terminal: getXkeenTerminalRoot() || XK.terminal || null });
        return false;
      }

      terminalLoaded = true;
      emitLazyEvent('xkeen:lazy-terminal-ready', { terminal: getXkeenTerminalRoot() || XK.terminal || null });
      return true;
    })().catch((err) => {
      try { console.error('[XKeen] terminal lazy load failed:', err); } catch (e) {}
      terminalLoaded = false;
      terminalPromise = null;
      emitLazyEvent('xkeen:lazy-terminal-failed', { error: err || null });
      return false;
    });

    return terminalPromise;
  }

  function ensureFileManagerReady() {
    if (fileManagerLoaded) return Promise.resolve(true);
    if (fileManagerPromise) return fileManagerPromise;

    fileManagerPromise = (async () => {
      const bundleLoader = getBundleLoader('fileManager');
      if (typeof bundleLoader !== 'function') throw new Error('missing file manager bundle loader');

      const ok = await bundleLoader();
      if (!ok) throw new Error('failed to load file manager bundle');

      const fileManagerApi = await getFileManagerRuntimeApi();

      safeInvoke(() => {
        const isDebug = isXkeenDebugRuntime();
        if (!isDebug) return;
        const FM = fileManagerApi;
        if (!FM) console.error('[FM] missing fileManager API after lazy load');
        if (FM && (!FM.state || !FM.state.S)) console.error('[FM] missing FM.state.S (state container not initialized)');
        if (FM && (!FM.contextMenu || typeof FM.contextMenu.show !== 'function')) console.error('[FM] missing FM.contextMenu.show (context_menu.js not loaded)');
        if (FM && (!FM.editor)) console.error('[FM] missing FM.editor (editor.js not loaded)');
      });

      fileManagerLoaded = true;
      emitLazyEvent('xkeen:lazy-file-manager-ready', { fileManager: fileManagerApi });
      return true;
    })().catch((err) => {
      try { console.error('[XKeen] file manager lazy load failed:', err); } catch (e) {}
      fileManagerLoaded = false;
      fileManagerPromise = null;
      emitLazyEvent('xkeen:lazy-file-manager-failed', { error: err || null });
      return false;
    });

    return fileManagerPromise;
  }

  function ensureEditorSupport(engine, opts) {
    const next = normalizeEditorEngine(engine);
    if (!next) return Promise.resolve(false);
    if (hasEditorSupport(next)) return Promise.resolve(true);
    if (editorSupportPromises[next]) return editorSupportPromises[next];

    editorSupportPromises[next] = (async () => {
      const bundleLoader = getEditorSupportBundleLoader(next);
      const wrappersReady = hasEditorRuntimeWrappers(next);
      if (!wrappersReady && typeof bundleLoader === 'function') {
        const scriptsOk = await bundleLoader();
        if (!scriptsOk) throw new Error('failed to load ' + next + ' shared support');
      }

      if (next === 'codemirror') {
        const cm6Runtime = getCodeMirror6Runtime();
        if (cm6Runtime && typeof cm6Runtime.ensure === 'function') {
          const st = await cm6Runtime.ensure(opts || {});
          if (!st || st.ok === false) return false;
          return hasEditorSupport(next);
        }
      }

      if (next === 'codemirror') {
        return hasEditorSupport(next);
      }

      const loader = getEditorLoader(next);
      if (!loader || typeof loader.ensureSupport !== 'function') {
        return hasEditorSupport(next);
      }

      const st = await loader.ensureSupport(opts || {});
      if (!st || st.ok !== true) return false;
      return hasEditorSupport(next);
    })().catch((err) => {
      try { console.error('[XKeen] ' + next + ' lazy load failed:', err); } catch (e) {}
      return false;
    }).finally(() => {
      if (hasEditorSupport(next)) delete editorSupportPromises[next];
      else editorSupportPromises[next] = null;
    });

    return editorSupportPromises[next];
  }

  function ensureMonacoSupport(opts) {
    return ensureEditorSupport('monaco', opts);
  }

  function ensureCodeMirrorSupport(opts) {
    return ensureEditorSupport('codemirror', opts);
  }


  function installTerminalStub() {
    try {
      XK.terminal = XK.terminal || {};
      XK.terminal.api = XK.terminal.api || {};
      const api = XK.terminal.api;
      if (api.__xkLazyStubInstalled) return;

      api.__xkLazyStubInstalled = true;

      function normalizeOpenArgs(a, b) {
        let cmd = '';
        let mode = '';

        if (a && typeof a === 'object') {
          cmd = (typeof a.cmd === 'string') ? a.cmd : '';
          mode = (typeof a.mode === 'string') ? a.mode : '';
          return { cmd, mode };
        }

        if (typeof a === 'string' && typeof b === 'string') return { cmd: a, mode: b };

        if (typeof a === 'string' && b == null) {
          const s = a.trim();
          const known = { shell: 1, pty: 1, xkeen: 1 };
          if (known[s] && s.indexOf(' ') === -1 && s.indexOf('\t') === -1) {
            return { cmd: '', mode: s };
          }
          return { cmd: a, mode: '' };
        }

        return { cmd: '', mode: '' };
      }

      const stubOpen = (a, b) => {
        const next = normalizeOpenArgs(a, b);
        return ensureTerminalReady().then((ready) => {
          if (!ready) return false;
          try {
            const T = XK.terminal || null;
            if (!T) return false;
            if (T.api && typeof T.api.open === 'function' && T.api.open !== stubOpen) {
              return T.api.open({ cmd: String(next.cmd || ''), mode: String(next.mode || '') });
            }
            if (T.ui_actions && typeof T.ui_actions.openTerminal === 'function') {
              return T.ui_actions.openTerminal(String(next.cmd || ''), String(next.mode || 'shell'));
            }
          } catch (e) {}
          return false;
        });
      };

      const stubSend = (text, opts) => ensureTerminalReady().then((ready) => {
        if (!ready) return { handled: false, result: { ok: false, error: 'terminal not ready' } };
        try {
          const T = XK.terminal || null;
          if (!T) return { handled: false, result: { ok: false, error: 'terminal missing' } };
          if (T.api && typeof T.api.send === 'function' && T.api.send !== stubSend) {
            return T.api.send(text, opts || {});
          }
        } catch (e) {}
        return { handled: false, result: { ok: false, error: 'send unavailable' } };
      });

      if (typeof api.open !== 'function') api.open = stubOpen;
      if (typeof api.send !== 'function') api.send = stubSend;
    } catch (e) {}
  }

  function installBackupsStub() {
    try {
      XK.backups = XK.backups || {};
      const api = XK.backups;
      if (api.__xkLazyStubInstalled) return;

      api.__xkLazyStubInstalled = true;

      const stubLoad = () => ensureFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XK.backups && typeof XK.backups.load === 'function' && XK.backups.load !== stubLoad) return XK.backups.load();
        return false;
      });
      const stubInit = () => ensureFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XK.backups && typeof XK.backups.init === 'function' && XK.backups.init !== stubInit) return XK.backups.init();
        if (XK.backups && typeof XK.backups.load === 'function' && XK.backups.load !== stubLoad) return XK.backups.load();
        return false;
      });
      const stubRefresh = () => ensureFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XK.backups && typeof XK.backups.refresh === 'function' && XK.backups.refresh !== stubRefresh) return XK.backups.refresh();
        if (XK.backups && typeof XK.backups.load === 'function' && XK.backups.load !== stubLoad) return XK.backups.load();
        return false;
      });
      const stubRestoreAuto = (target) => ensureFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XK.backups && typeof XK.backups.restoreAuto === 'function' && XK.backups.restoreAuto !== stubRestoreAuto) return XK.backups.restoreAuto(target);
        return false;
      });
      const stubViewSnapshot = (name) => ensureFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XK.backups && typeof XK.backups.viewSnapshot === 'function' && XK.backups.viewSnapshot !== stubViewSnapshot) return XK.backups.viewSnapshot(name);
        return false;
      });
      const stubRestoreSnapshot = (name) => ensureFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XK.backups && typeof XK.backups.restoreSnapshot === 'function' && XK.backups.restoreSnapshot !== stubRestoreSnapshot) return XK.backups.restoreSnapshot(name);
        return false;
      });

      if (typeof api.init !== 'function') api.init = stubInit;
      if (typeof api.load !== 'function') api.load = stubLoad;
      if (typeof api.refresh !== 'function') api.refresh = stubRefresh;
      if (typeof api.restoreAuto !== 'function') api.restoreAuto = stubRestoreAuto;
      if (typeof api.viewSnapshot !== 'function') api.viewSnapshot = stubViewSnapshot;
      if (typeof api.restoreSnapshot !== 'function') api.restoreSnapshot = stubRestoreSnapshot;
    } catch (e) {}
  }

  function installJsonEditorStub() {
    try {
      XK.jsonEditor = XK.jsonEditor || {};
      const api = XK.jsonEditor;
      if (api.__xkLazyStubInstalled) return;

      api.__xkLazyStubInstalled = true;

      const stubInit = () => ensureFeature('jsonEditor');
      const stubOpen = (target) => ensureFeature('jsonEditor').then((ready) => {
        if (!ready) return false;
        if (XK.jsonEditor && typeof XK.jsonEditor.open === 'function' && XK.jsonEditor.open !== stubOpen) return XK.jsonEditor.open(target);
        return false;
      });
      const stubClose = () => ensureFeature('jsonEditor').then((ready) => {
        if (!ready) return false;
        if (XK.jsonEditor && typeof XK.jsonEditor.close === 'function' && XK.jsonEditor.close !== stubClose) return XK.jsonEditor.close();
        return false;
      });
      const stubSave = () => ensureFeature('jsonEditor').then((ready) => {
        if (!ready) return false;
        if (XK.jsonEditor && typeof XK.jsonEditor.save === 'function' && XK.jsonEditor.save !== stubSave) return XK.jsonEditor.save();
        return false;
      });
      const stubIsDirty = () => false;

      if (typeof api.init !== 'function') api.init = stubInit;
      if (typeof api.open !== 'function') api.open = stubOpen;
      if (typeof api.close !== 'function') api.close = stubClose;
      if (typeof api.save !== 'function') api.save = stubSave;
      if (typeof api.isDirty !== 'function') api.isDirty = stubIsDirty;
    } catch (e) {}
  }

  function installDatContentsStub() {
    try {
      XK.ui = XK.ui || {};
      XK.ui.datContents = XK.ui.datContents || {};
      const api = XK.ui.datContents;
      if (api.__xkLazyStubInstalled) return;

      api.__xkLazyStubInstalled = true;

      const stubOpen = (kind, opts) => ensureFeature('datContents').then((ready) => {
        if (!ready) return false;
        if (XK.ui && XK.ui.datContents && typeof XK.ui.datContents.open === 'function' && XK.ui.datContents.open !== stubOpen) return XK.ui.datContents.open(kind, opts);
        return false;
      });
      const stubClose = () => ensureFeature('datContents').then((ready) => {
        if (!ready) return false;
        if (XK.ui && XK.ui.datContents && typeof XK.ui.datContents.close === 'function' && XK.ui.datContents.close !== stubClose) return XK.ui.datContents.close();
        return false;
      });

      if (typeof api.open !== 'function') api.open = stubOpen;
      if (typeof api.close !== 'function') api.close = stubClose;
    } catch (e) {}
  }

  function installDefaultStubs() {
    installTerminalStub();
    installBackupsStub();
    installJsonEditorStub();
    installDatContentsStub();
  }

  const lazyApi = Object.freeze({
    getFeatureApi,
    isFeatureStub,
    isFeatureReady,
    isTerminalReady,
    ensureFeature,
    ensureTerminalReady,
    ensureFileManagerReady,
    ensureEditorSupport,
    ensureMonacoSupport,
    ensureCodeMirrorSupport,
  });

  XK.runtime.lazy = lazyApi;
  installDefaultStubs();
})();
