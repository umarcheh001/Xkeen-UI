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

  const STATIC_BASE = (() => {
    try {
      const base = (typeof window.XKEEN_STATIC_BASE === 'string' && window.XKEEN_STATIC_BASE)
        ? window.XKEEN_STATIC_BASE
        : '/static/';
      return base.endsWith('/') ? base : (base + '/');
    } catch (e) {
      return '/static/';
    }
  })();

  const loadedScripts = new Set();
  const loadingScripts = new Map();

  function toStaticUrl(path) {
    const raw = String(path || '');
    if (!raw) return '';

    let url = '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      url = raw;
    } else if (raw.startsWith('/')) {
      url = raw;
    } else {
      url = STATIC_BASE + raw.replace(/^\/+/, '');
    }

    try {
      const ver = (typeof window.XKEEN_STATIC_VER === 'string' && window.XKEEN_STATIC_VER)
        ? window.XKEEN_STATIC_VER
        : '';
      if (ver && url && !/[?&]v=/.test(url)) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(ver);
      }
    } catch (e) {}

    return url;
  }

  function loadScriptOnce(path) {
    const url = toStaticUrl(path);
    if (!url) return Promise.resolve(false);
    if (loadedScripts.has(url)) return Promise.resolve(true);
    if (loadingScripts.has(url)) return loadingScripts.get(url);

    try {
      const found = document.querySelector('script[src="' + url + '"]') || document.querySelector('script[data-xk-src="' + url + '"]');
      if (found) {
        const state = (found.dataset && found.dataset.xkLoadState) ? String(found.dataset.xkLoadState) : '';
        if (state === 'ready') {
          loadedScripts.add(url);
          return Promise.resolve(true);
        }
        if (state === 'loading' && loadingScripts.has(url)) return loadingScripts.get(url);
        try { found.remove(); } catch (e) {}
      }
    } catch (e) {}

    const promise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = url;
      try { script.async = false; } catch (e) {}
      script.dataset.xkSrc = url;
      script.dataset.xkLoadState = 'loading';
      script.onload = () => {
        try { script.dataset.xkLoadState = 'ready'; } catch (e) {}
        loadedScripts.add(url);
        resolve(true);
      };
      script.onerror = () => {
        try { console.error('[xk] failed to load script:', url); } catch (e) {}
        try { script.dataset.xkLoadState = 'error'; } catch (e) {}
        try { script.remove(); } catch (e2) {}
        resolve(false);
      };
      (document.body || document.documentElement).appendChild(script);
    });

    loadingScripts.set(url, promise.finally(() => {
      try { loadingScripts.delete(url); } catch (e) {}
    }));
    return loadingScripts.get(url);
  }

  async function loadScriptsInOrder(list) {
    const items = Array.isArray(list) ? list : [];
    for (let i = 0; i < items.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await loadScriptOnce(items[i]);
      if (!ok) return false;
    }
    return true;
  }

  function loadIsolatedUmdScriptOnce(path) {
    const url = toStaticUrl(path);
    if (!url) return Promise.resolve(false);
    if (loadedScripts.has(url)) return Promise.resolve(true);
    if (loadingScripts.has(url)) return loadingScripts.get(url);

    const promise = (async () => {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res || !res.ok) return false;
        const code = await res.text();
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          'self',
          'window',
          'globalThis',
          'define',
          'exports',
          'module',
          code + '\n//# sourceURL=' + String(url).replace(/\s/g, '%20')
        );
        fn.call(window, window, window, window, undefined, undefined, undefined);
        loadedScripts.add(url);
        return true;
      } catch (e) {
        try { console.error('[xk] failed to load isolated UMD script:', url, e); } catch (e2) {}
        return false;
      }
    })();

    loadingScripts.set(url, promise.finally(() => {
      try { loadingScripts.delete(url); } catch (e) {}
    }));
    return loadingScripts.get(url);
  }

  async function loadUmdScriptsInOrder(list) {
    const items = Array.isArray(list) ? list : [];
    for (let i = 0; i < items.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await loadIsolatedUmdScriptOnce(items[i]);
      if (!ok) return false;
    }
    return true;
  }

  const loaderApi = {
    staticBase: STATIC_BASE,
    toUrl: toStaticUrl,
    loadScriptOnce,
    loadScriptsInOrder,
    loadIsolatedUmdScriptOnce,
    loadUmdScriptsInOrder,
  };

  const featureScripts = {
    routingTemplates: ['js/features/routing_templates.js'],
    github: ['js/features/github.js'],
    serviceStatus: ['js/features/service_status.js'],
    restartLog: ['js/features/restart_log.js'],
    donate: ['js/features/donate.js'],
    backups: ['js/features/backups.js'],
    jsonEditor: ['js/ui/json_editor_modal.js'],
    datContents: ['js/ui/dat_contents_modal.js'],
    xkeenTexts: ['js/features/xkeen_texts.js'],
    commandsList: ['js/features/commands_list.js'],
    coresStatus: ['js/features/cores_status.js'],
    formatters: ['js/ui/prettier_loader.js', 'js/ui/formatters.js'],
    xrayPreflight: ['js/ui/xray_preflight_modal.js'],
    uiSettingsPanel: ['js/ui/settings_panel.js'],
    mihomoImport: ['js/features/mihomo_import.js'],
    mihomoProxyTools: ['js/features/mihomo_import.js', 'js/features/mihomo_proxy_tools.js'],
    mihomoHwidSub: ['js/features/mihomo_hwid_sub.js'],
  };

  const featureReady = Object.create(null);
  const featureLoading = Object.create(null);
  const editorSupportPromises = Object.create(null);
  let terminalLoaded = false;
  let terminalPromise = null;
  let fileManagerLoaded = false;
  let fileManagerPromise = null;

  function normalizeEditorEngine(engine) {
    const next = String(engine || '').toLowerCase().trim();
    return (next === 'monaco' || next === 'codemirror') ? next : '';
  }

  function getEditorSupportScripts(engine) {
    const next = normalizeEditorEngine(engine);
    if (next === 'monaco') return ['js/ui/monaco_loader.js', 'js/ui/monaco_shared.js'];
    if (next === 'codemirror') return [];
    return [];
  }

  function getEditorLoader(engine) {
    const next = normalizeEditorEngine(engine);
    try {
      if (!window.XKeen) return null;
      if (next === 'monaco') return XK.monacoLoader || null;
      if (next === 'codemirror') return null;
    } catch (e) {}
    return null;
  }

  function getCodeMirror6Runtime() {
    try {
      return (window.XKeen && XKeen.ui && XKeen.ui.cm6Runtime) ? XKeen.ui.cm6Runtime : null;
    } catch (e) {}
    return null;
  }

  function hasCodeMirrorSharedLayer() {
    try {
      return !!(
        window.XKeen && XKeen.ui && XKeen.ui.editorActions &&
        typeof window.buildCmExtraKeysCommon === 'function' &&
        typeof window.xkeenAttachCmToolbar === 'function' &&
        XKeen.ui.editorLinks && typeof XKeen.ui.editorLinks.setEnabled === 'function'
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
      return !!(
        window.XKeen &&
        loader &&
        typeof loader.ensureSupport === 'function' &&
        ((typeof loader.isReady === 'function' && loader.isReady()) || (typeof loader.ensureMonaco === 'function')) &&
        XK.ui &&
        XK.ui.monacoShared &&
        typeof XK.ui.monacoShared.createEditor === 'function'
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
        return !!(
          getEditorLoader('monaco') &&
          XK.ui &&
          XK.ui.monacoShared &&
          typeof XK.ui.monacoShared.createEditor === 'function'
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
    try {
      switch (String(name || '')) {
        case 'routingTemplates':
          return XK.features ? XK.features.routingTemplates : null;
        case 'github':
          return XK.github || null;
        case 'serviceStatus':
          return XK.features ? XK.features.serviceStatus : null;
        case 'xrayLogs':
          return XK.features ? XK.features.xrayLogs : null;
        case 'restartLog':
          return XK.features ? XK.features.restartLog : null;
        case 'inbounds':
          return XK.features ? XK.features.inbounds : null;
        case 'outbounds':
          return XK.features ? XK.features.outbounds : null;
        case 'donate':
          return XK.features ? XK.features.donate : null;
        case 'backups':
          return XK.backups || null;
        case 'jsonEditor':
          return XK.jsonEditor || null;
        case 'datContents':
          return (XK.ui && XK.ui.datContents) ? XK.ui.datContents : null;
        case 'xkeenTexts':
          return XK.features ? XK.features.xkeenTexts : null;
        case 'commandsList':
          return XK.features ? XK.features.commandsList : null;
        case 'coresStatus':
          return XK.features ? XK.features.coresStatus : null;
        case 'formatters':
          return (XK.ui && XK.ui.formatters &&
            (typeof XK.ui.formatters.formatJson === 'function' || typeof XK.ui.formatters.formatYaml === 'function'))
            ? XK.ui.formatters
            : null;
        case 'xrayPreflight':
          return (XK.ui && typeof XK.ui.showXrayPreflightError === 'function') ? XK.ui : null;
        case 'uiSettingsPanel':
          return (XK.ui && XK.ui.settingsPanel) ? XK.ui.settingsPanel : null;
        case 'mihomoImport':
          return XK.features ? XK.features.mihomoImport : null;
        case 'mihomoProxyTools':
          return XK.features ? XK.features.mihomoProxyTools : null;
        case 'mihomoHwidSub':
          return XK.features ? XK.features.mihomoHwidSub : null;
        default:
          return null;
      }
    } catch (e) {
      return null;
    }
  }

  function getBuildManagedFeatureLoader(name) {
    try {
      switch (String(name || '')) {
        case 'xrayLogs': {
          const api = XK.pages ? XK.pages.logsShell : null;
          return api && typeof api.ensureReady === 'function' ? api : null;
        }
        case 'inbounds': {
          const api = XK.pages ? XK.pages.configShell : null;
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
          const api = XK.pages ? XK.pages.configShell : null;
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
      case 'routingTemplates':
        if (feature && typeof feature.init === 'function') feature.init();
        break;
      case 'github':
        if (feature && typeof feature.init === 'function') {
          feature.init({ repoUrl: window.XKEEN_GITHUB_REPO_URL || '' });
        }
        break;
      case 'serviceStatus':
      case 'xrayLogs':
      case 'restartLog':
      case 'inbounds':
      case 'outbounds':
      case 'donate':
      case 'jsonEditor':
      case 'xkeenTexts':
      case 'commandsList':
      case 'coresStatus':
      case 'mihomoImport':
      case 'mihomoProxyTools':
      case 'mihomoHwidSub':
        if (feature && typeof feature.init === 'function') feature.init();
        break;
      case 'backups':
      case 'datContents':
      case 'formatters':
      case 'xrayPreflight':
      case 'uiSettingsPanel':
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

      const scripts = Array.isArray(featureScripts[key]) ? featureScripts[key] : [];
      const existing = getFeatureApi(key);
      if ((!existing || isFeatureStub(existing)) && scripts.length) {
        const ok = await loadScriptsInOrder(scripts);
        if (!ok) throw new Error('failed to load lazy feature: ' + key);
      }

      safeInvoke(() => initFeature(key));
      safeInvoke(() => {
        const loaded = getFeatureApi(key);
        if (loaded && loaded.__xkLazyStubInstalled) {
          try { delete loaded.__xkLazyStubInstalled; } catch (e) {}
        }
      });

      featureReady[key] = true;
      emitLazyEvent('xkeen:lazy-feature-ready', { name: key, api: getFeatureApi(key) });
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

  function ensureTerminalReady() {
    if (terminalLoaded) return Promise.resolve(true);
    if (terminalPromise) return terminalPromise;

    terminalPromise = (async () => {
      const xtermOk = await loadUmdScriptsInOrder([
        'xterm/xterm.js',
        'xterm/xterm-addon-fit.js',
        'xterm/xterm-addon-search.js',
        'xterm/xterm-addon-web-links.js',
        'xterm/xterm-addon-webgl.js',
        'xterm/xterm-addon-unicode11.js',
        'xterm/xterm-addon-serialize.js',
        'xterm/xterm-addon-clipboard.js',
        'xterm/xterm-addon-ligatures.js',
      ]);
      if (!xtermOk) throw new Error('failed to load xterm libraries');

      const termOk = await loadScriptsInOrder([
        'js/terminal/_core.js',
        'js/terminal/core/events.js',
        'js/terminal/core/logger.js',
        'js/terminal/core/config.js',
        'js/terminal/core/ui.js',
        'js/terminal/core/api.js',
        'js/terminal/transport/pty_transport.js',
        'js/terminal/transport/lite_transport.js',
        'js/terminal/transport/index.js',
        'js/terminal/core/state.js',
        'js/terminal/core/registry.js',
        'js/terminal/commands/registry.js',
        'js/terminal/commands/router.js',
        'js/terminal/commands/builtins/xkeen_restart.js',
        'js/terminal/commands/builtins/sysmon.js',
        'js/terminal/core/session_controller.js',
        'js/terminal/core/context.js',
        'js/terminal/core/public_api.js',
        'js/terminal/core/output_controller.js',
        'js/terminal/core/input_controller.js',
        'js/terminal/capabilities.js',
        'js/terminal/pty.js',
        'js/terminal/core/xterm_manager.js',
        'js/terminal/lite_runner.js',
        'js/terminal/search.js',
        'js/terminal/history.js',
        'js/terminal/quick_commands.js',
        'js/terminal/chrome.js',
        'js/terminal/modules/overlay_controller.js',
        'js/terminal/modules/status_controller.js',
        'js/terminal/modules/terminal_controller.js',
        'js/terminal/modules/ui_controller.js',
        'js/terminal/modules/buffer_actions.js',
        'js/terminal/modules/ssh_profiles.js',
        'js/terminal/modules/reconnect_controller.js',
        'js/terminal/modules/output_prefs.js',
        'js/terminal/modules/confirm_prompt.js',
        'js/terminal/xray_tail.js',
        'js/terminal/terminal.js',
      ]);
      if (!termOk) throw new Error('failed to load terminal modules');

      safeInvoke(() => {
        if (XK.terminal && typeof XK.terminal.init === 'function') XK.terminal.init();
      });

      safeInvoke(() => {
        const api = XK.terminal && XK.terminal.api;
        if (api && api.__xkLazyStubInstalled && XK.terminal && XK.terminal.core && typeof XK.terminal.core.createPublicApi === 'function') {
          console.warn('[XKeen] terminal.api is still a lazy stub after init; reinstalling public API (regression guard)');
          XK.terminal.api = XK.terminal.core.createPublicApi();
        }
      });

      terminalLoaded = true;
      emitLazyEvent('xkeen:lazy-terminal-ready', { terminal: XK.terminal || null });
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
      const ok = await loadScriptsInOrder([
        'js/features/file_manager/common.js',
        'js/features/file_manager/api.js',
        'js/features/file_manager/errors.js',
        'js/features/file_manager/progress.js',
        'js/features/file_manager/prefs.js',
        'js/features/file_manager/state.js',
        'js/features/file_manager/bookmarks.js',
        'js/features/file_manager/terminal.js',
        'js/features/file_manager/list_model.js',
        'js/features/file_manager/status.js',
        'js/features/file_manager/storage.js',
        'js/features/file_manager/render.js',
        'js/features/file_manager/listing.js',
        'js/features/file_manager/selection.js',
        'js/features/file_manager/transfers.js',
        'js/features/file_manager/remote.js',
        'js/features/file_manager/ops.js',
        'js/features/file_manager/actions.js',
        'js/features/file_manager/props.js',
        'js/features/file_manager/hash.js',
        'js/features/file_manager/actions_modals.js',
        'js/features/file_manager/dragdrop.js',
        'js/features/file_manager/context_menu.js',
        'js/features/file_manager/chrome.js',
        'js/features/file_manager/editor.js',
        'js/features/file_manager/navigation.js',
        'js/features/file_manager/wire.js',
        'js/features/file_manager.js',
        'js/features/file_manager/init.js',
      ]);
      if (!ok) throw new Error('failed to load file manager modules');

      safeInvoke(() => {
        const q = (window.location && typeof window.location.search === 'string') ? window.location.search : '';
        const isDebug = !!window.XKEEN_DEV || /(?:^|[?&])debug=1(?:&|$)/.test(q);
        if (!isDebug) return;
        const FM = (XK.features && XK.features.fileManager) ? XK.features.fileManager : null;
        if (!FM) console.error('[FM] missing XKeen.features.fileManager after lazy load');
        if (FM && (!FM.state || !FM.state.S)) console.error('[FM] missing FM.state.S (state container not initialized)');
        if (FM && (!FM.contextMenu || typeof FM.contextMenu.show !== 'function')) console.error('[FM] missing FM.contextMenu.show (context_menu.js not loaded)');
        if (FM && (!FM.editor)) console.error('[FM] missing FM.editor (editor.js not loaded)');
      });

      fileManagerLoaded = true;
      emitLazyEvent('xkeen:lazy-file-manager-ready', { fileManager: XK.features ? XK.features.fileManager : null });
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
      const scripts = getEditorSupportScripts(next);
      const wrappersReady = hasEditorRuntimeWrappers(next);
      if (!wrappersReady && scripts.length) {
        const scriptsOk = await loadScriptsInOrder(scripts);
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

  function installLazyCompatibilityApi() {
    XK.lazy = XK.lazy || {};
    XK.lazy.ensureTerminalReady = ensureTerminalReady;
    XK.lazy.ensureFileManagerReady = ensureFileManagerReady;
    XK.lazy.ensureEditorSupport = ensureEditorSupport;
    XK.lazy.ensureCodeMirrorSupport = ensureCodeMirrorSupport;
    XK.lazy.ensureMonacoSupport = ensureMonacoSupport;
    XK.lazy.ensureFeature = ensureFeature;
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

  const lazyApi = {
    loader: loaderApi,
    featureScripts,
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
  };

  XK.runtime.loader = loaderApi;
  XK.runtime.lazy = lazyApi;
  installLazyCompatibilityApi();
  installDefaultStubs();
})();
