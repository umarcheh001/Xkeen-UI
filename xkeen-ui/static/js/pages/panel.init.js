(() => {
  // panel.html wiring (Milestones 1-2): init modules + remove inline onclick dependencies.

  function isPanelPage() {
    return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
  }

  function safe(fn) {
    try { fn(); } catch (e) { console.error(e); }
  }

	// Per-view one-time init (reduces unnecessary work + avoids API calls on tabs the user never opens).
	const _viewInitFlags = Object.create(null);
	function initViewOnce(name, fn) {
	  if (_viewInitFlags[name]) return;
	  _viewInitFlags[name] = true;
	  safe(fn);
	}


// Commit J: page-scoped loading for heavy features (Terminal, File Manager).
// On weak hardware we avoid parsing/loading large scripts until the user actually opens the feature.
const STATIC_BASE = (function () {
  try {
    const b = (typeof window.XKEEN_STATIC_BASE === 'string' && window.XKEEN_STATIC_BASE) ? window.XKEEN_STATIC_BASE : '/static/';
    return b.endsWith('/') ? b : (b + '/');
  } catch (e) {
    return '/static/';
  }
})();

const _xkLoaded = new Set();

function _toUrl(path) {
  const p = String(path || '');
  if (!p) return '';
  let url = '';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    url = p;
  } else if (p.startsWith('/')) {
    url = p;
  } else {
    url = STATIC_BASE + p.replace(/^\/+/, '');
  }
  // Cache-buster for lazy-loaded scripts (terminal, file manager, etc.)
  try {
    const ver = (typeof window.XKEEN_STATIC_VER === 'string' && window.XKEEN_STATIC_VER) ? window.XKEEN_STATIC_VER : '';
    if (ver && url && !/[?&]v=/.test(url)) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(ver);
    }
  } catch (e) {}
  return url;
}

function loadScriptOnce(path) {
  const url = _toUrl(path);
  if (!url) return Promise.resolve(false);
  if (_xkLoaded.has(url)) return Promise.resolve(true);

  // Existing tag?
  try {
    const found = document.querySelector('script[src="' + url + '"]') || document.querySelector('script[data-xk-src="' + url + '"]');
    if (found) {
      _xkLoaded.add(url);
      return Promise.resolve(true);
    }
  } catch (e) {}

  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    // preserve execution order when awaited sequentially
    try { s.async = false; } catch (e) {}
    s.dataset.xkSrc = url;
    s.onload = () => { _xkLoaded.add(url); resolve(true); };
    s.onerror = () => {
      console.error('[xk] failed to load script:', url);
      _xkLoaded.add(url);
      resolve(false);
    };
    (document.body || document.documentElement).appendChild(s);
  });
}

async function loadScriptsInOrder(list) {
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i < items.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    await loadScriptOnce(items[i]);
  }
  return true;
}


function withUmdGlobals(run) {
  // Some of our pages include AMD loader (Monaco). UMD bundles like xterm detect
  // `define.amd` and register as AMD module, which means they won't expose globals
  // (Terminal, FitAddon, ...). For runtime lazy-load we temporarily disable UMD hooks.
  const g = window;
  const hadDefine = Object.prototype.hasOwnProperty.call(g, 'define');
  const hadExports = Object.prototype.hasOwnProperty.call(g, 'exports');
  const hadModule = Object.prototype.hasOwnProperty.call(g, 'module');

  const savedDefine = g.define;
  const savedExports = g.exports;
  const savedModule = g.module;

  try { g.define = undefined; } catch (e) {}
  try { g.exports = undefined; } catch (e) {}
  try { g.module = undefined; } catch (e) {}

  return Promise.resolve()
    .then(() => run())
    .finally(() => {
      try { if (hadDefine) g.define = savedDefine; else delete g.define; } catch (e1) {}
      try { if (hadExports) g.exports = savedExports; else delete g.exports; } catch (e2) {}
      try { if (hadModule) g.module = savedModule; else delete g.module; } catch (e3) {}
    });
}

let _terminalLoaded = false;
let _terminalPromise = null;

function ensureTerminalReady() {
  if (_terminalLoaded) return Promise.resolve(true);
  if (_terminalPromise) return _terminalPromise;

  _terminalPromise = (async () => {
    // XTerm libs first (global Terminal + addons)
    await withUmdGlobals(() => loadScriptsInOrder([
      'xterm/xterm.js',
      'xterm/xterm-addon-fit.js',
      'xterm/xterm-addon-search.js',
      'xterm/xterm-addon-web-links.js',
      'xterm/xterm-addon-webgl.js',
      'xterm/xterm-addon-unicode11.js',
      'xterm/xterm-addon-serialize.js',
      'xterm/xterm-addon-clipboard.js',
      'xterm/xterm-addon-ligatures.js',
    ]));

    // Terminal modules (kept in the same order as the old <script> list in panel.html)
    await loadScriptsInOrder([
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

    safe(() => {
      if (window.XKeen && XKeen.terminal && typeof XKeen.terminal.init === 'function') {
        XKeen.terminal.init();
      }
    });

    // Regression guard:
    // If a lazy stub API was installed before Terminal scripts loaded, the real
    // terminal core must overwrite it (see terminal/core/public_api.js).
    // If someone accidentally breaks that overwrite logic, commands list will
    // open PTY but won't be able to send commands.
    safe(() => {
      try {
        const api = window.XKeen && XKeen.terminal && XKeen.terminal.api;
        if (api && api.__xkLazyStubInstalled && window.XKeen && XKeen.terminal && XKeen.terminal.core && typeof XKeen.terminal.core.createPublicApi === 'function') {
          // Self-heal (and leave a breadcrumb in console for debugging).
          console.warn('[XKeen] terminal.api is still a lazy stub after init; reinstalling public API (regression guard)');
          XKeen.terminal.api = XKeen.terminal.core.createPublicApi();
        }
      } catch (e) {}
    });

    _terminalLoaded = true;
    return true;
  })();

  return _terminalPromise;
}

function openTerminal(mode) {
  const m = String(mode || 'shell').toLowerCase();
  safe(() => {
    const T = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal : null;
    if (!T) return;
    if (T.api && typeof T.api.open === 'function') {
      void T.api.open({ cmd: '', mode: m });
      return;
    }
    if (T.ui_actions && typeof T.ui_actions.openTerminal === 'function') {
      T.ui_actions.openTerminal('', m);
    }
  });
}

function wireTerminalLazyOpen() {
  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');

  function wire(btn, mode) {
    if (!btn) return;
    if (btn.dataset && btn.dataset.xkLazyTerminal === '1') return;
    btn.addEventListener('click', (e) => {
      if (_terminalLoaded) return; // terminal scripts will handle further clicks
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureTerminalReady().then(() => openTerminal(mode));
    }, true);
    if (btn.dataset) btn.dataset.xkLazyTerminal = '1';
  }

  wire(shellBtn, 'shell');
  wire(ptyBtn, 'pty');
}

// Decide which terminal open button to show on initial page load.
// Before terminal scripts are lazy-loaded, both buttons exist in markup.
// We hide one of them based on /api/capabilities.websocket (WS runtime).
let _terminalCapsInit = false;
function initTerminalCapabilityButtons() {
  if (_terminalCapsInit) return;
  _terminalCapsInit = true;

  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');
  if (!shellBtn && !ptyBtn) return;

  function apply(hasWs) {
    const ws = !!hasWs;
    try {
      window.XKeen = window.XKeen || {};
      window.XKeen.state = window.XKeen.state || {};
      window.XKeen.state.hasWs = ws;
    } catch (e) {}

    if (ws) {
      if (ptyBtn) { try { ptyBtn.style.display = ''; ptyBtn.disabled = false; } catch (e) {} }
      if (shellBtn) { try { shellBtn.style.display = 'none'; shellBtn.disabled = true; } catch (e) {} }
    } else {
      if (shellBtn) { try { shellBtn.style.display = ''; shellBtn.disabled = false; } catch (e) {} }
      if (ptyBtn) { try { ptyBtn.style.display = 'none'; ptyBtn.disabled = true; } catch (e) {} }
    }
  }

  // Keep server-side default (based on arch) until we know the actual WS runtime.
  // This removes the "two buttons" glitch on initial load.
  fetch('/api/capabilities', { cache: 'no-store' })
    .then((r) => (r && r.ok) ? r.json() : null)
    .then((data) => apply(!!(data && data.websocket)))
    .catch(() => {
      // On error: keep current default button.
    });
}


let _fileManagerLoaded = false;
let _fileManagerPromise = null;

function ensureFileManagerReady() {
  if (_fileManagerLoaded) return Promise.resolve(true);
  if (_fileManagerPromise) return _fileManagerPromise;

  _fileManagerPromise = (async () => {
    await loadScriptsInOrder([
      // NOTE: no per-file cache-busters here.
      // `_toUrl()` will append a single `?v=${window.XKEEN_STATIC_VER}`
      // to all lazy-loaded scripts.
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
      // Thin entrypoint (must be last)
      'js/features/file_manager/init.js',
    ]);

    // Dev guards: help diagnose script order issues (use ?debug=1 or window.XKEEN_DEV=true)
    try {
      const q = (window.location && typeof window.location.search === 'string') ? window.location.search : '';
      const isDebug = !!window.XKEEN_DEV || /(?:^|[?&])debug=1(?:&|$)/.test(q);
      if (isDebug) {
        const FM = (window.XKeen && window.XKeen.features && window.XKeen.features.fileManager) ? window.XKeen.features.fileManager : null;
        if (!FM) console.error('[FM] missing XKeen.features.fileManager after lazy load');
        if (FM && (!FM.state || !FM.state.S)) console.error('[FM] missing FM.state.S (state container not initialized)');
        if (FM && (!FM.contextMenu || typeof FM.contextMenu.show !== 'function')) console.error('[FM] missing FM.contextMenu.show (context_menu.js not loaded)');
        if (FM && (!FM.editor)) console.error('[FM] missing FM.editor (editor.js not loaded)');
      }
    } catch (e) {}

    _fileManagerLoaded = true;
    return true;
  })();

  return _fileManagerPromise;
}



// Expose lazy initializers for modules that want to use Terminal/File Manager APIs
// without always paying the initial load cost.
safe(() => {
  window.XKeen = window.XKeen || {};
  XKeen.lazy = XKeen.lazy || {};
  XKeen.lazy.ensureTerminalReady = ensureTerminalReady;
  XKeen.lazy.ensureFileManagerReady = ensureFileManagerReady;

  // Terminal API stub: allows other features (File Manager, Commands, etc.)
  // to call terminal API even if Terminal scripts are not loaded yet.
  // IMPORTANT: This is a *temporary* stub.
  // The real Terminal core must overwrite it when it loads, otherwise
  // `XKeen.terminal.api.send()` stays a stub forever.
  // See: static/js/terminal/core/public_api.js (regression note).
  try {
    XKeen.terminal = XKeen.terminal || {};
    XKeen.terminal.api = XKeen.terminal.api || {};
    const api = XKeen.terminal.api;

    if (!api.__xkLazyStubInstalled) {
      api.__xkLazyStubInstalled = true;

      function _normalizeTerminalOpenArgs(a, b) {
        // Match terminal.core.public_api.normalizeOpenArgs contract:
        //   open({cmd, mode})
        //   open(cmd, mode)
        //   open(mode)  // when mode is known and cmd omitted
        let cmd = '';
        let mode = '';

        if (a && typeof a === 'object') {
          cmd = (typeof a.cmd === 'string') ? a.cmd : '';
          mode = (typeof a.mode === 'string') ? a.mode : '';
          return { cmd, mode };
        }

        if (typeof a === 'string' && typeof b === 'string') {
          return { cmd: a, mode: b };
        }

        if (typeof a === 'string' && b == null) {
          const s = a.trim();
          // Known modes (keep in sync with terminal core)
          const KNOWN = { shell: 1, pty: 1, xkeen: 1 };
          if (KNOWN[s] && s.indexOf(' ') === -1 && s.indexOf('\t') === -1) {
            return { cmd: '', mode: s };
          }
          return { cmd: a, mode: '' };
        }

        return { cmd: '', mode: '' };
      }

      const stubOpen = (a, b) => {
        const { cmd, mode } = _normalizeTerminalOpenArgs(a, b);
        // Return a promise so callers may await terminal readiness/open.
        return ensureTerminalReady().then(() => {
          try {
            const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
            if (!T) return false;
            if (T.api && typeof T.api.open === 'function' && T.api.open !== stubOpen) {
              return T.api.open({ cmd: String(cmd || ''), mode: String(mode || '') });
            }
            if (T.ui_actions && typeof T.ui_actions.openTerminal === 'function') {
              return T.ui_actions.openTerminal(String(cmd || ''), String(mode || 'shell'));
            }
          } catch (e2) {}
          return false;
        });
      };

      const stubSend = (text, opts) => {
        // Return a promise so callers may await delivery.
        return ensureTerminalReady().then(() => {
          try {
            const T = window.XKeen && XKeen.terminal ? XKeen.terminal : null;
            if (!T) return { handled: false, result: { ok: false, error: 'terminal missing' } };
            if (T.api && typeof T.api.send === 'function' && T.api.send !== stubSend) {
              return T.api.send(text, opts || {});
            }
          } catch (e2) {}
          return { handled: false, result: { ok: false, error: 'send unavailable' } };
        });
      };

      if (typeof api.open !== 'function') api.open = stubOpen;
      if (typeof api.send !== 'function') api.send = stubSend;
    }
  } catch (e1) {}
});

  // Legacy initializers from main.js were removed. If you add a new module,
  // just extend initModules() below.

  function getEditor(name) {
    try {
      if (window.XKeen && XKeen.state && XKeen.state[name]) return XKeen.state[name];
    } catch (e) {}
    try {
      return window[name];
    } catch (e) {}
    return null;
  }

  const LAST_VIEW_KEY = 'xkeen.panel.last_view.v1';

  function _rememberView(name) {
    try { localStorage.setItem(LAST_VIEW_KEY, String(name || 'routing')); } catch (e) {}
  }

  function _restoreView() {
    try {
      const v = localStorage.getItem(LAST_VIEW_KEY);
      return v ? String(v) : '';
    } catch (e) {
      return '';
    }
  }

  function showView(viewName) {
    let name = String(viewName || 'routing');

    const sections = {
      routing: document.getElementById('view-routing'),
      mihomo: document.getElementById('view-mihomo'),
      xkeen: document.getElementById('view-xkeen'),
      'xray-logs': document.getElementById('view-xray-logs'),
      commands: document.getElementById('view-commands'),
      files: document.getElementById('view-files'),
    };

    function isForceHidden(el) {
      try { return !!(el && el.dataset && el.dataset.xkForceHidden === '1'); } catch (e) { return false; }
    }

    // If the requested view is not available (e.g. hidden by env whitelist),
    // fall back to the first available one.
    try {
      const requestedEl = sections[name];
      if (!requestedEl || isForceHidden(requestedEl)) {
        const first = Object.keys(sections).find((k) => {
          const el = sections[k];
          return !!(el && !isForceHidden(el));
        });
        name = first || 'routing';
      }
    } catch (e) {}

    // hide/show sections
    Object.entries(sections).forEach(([key, el]) => {
      if (!el) return;
      if (isForceHidden(el)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = key === name ? 'block' : 'none';
    });

    // active tab state (ignore hidden tabs)
    document.querySelectorAll('.top-tab-btn[data-view]').forEach((btn) => {
      const hidden = (btn.style.display === 'none') || (btn.dataset && btn.dataset.xkForceHidden === '1');
      btn.classList.toggle('active', !hidden && btn.dataset.view === name);
    });

    // Show the RAW/GUI quick-focus block only on the Xray routing tab.
    try {
      const routingFocusGroup = document.querySelector('.xkeen-ctrl-group-routing-focus');
      if (routingFocusGroup) {
        const isRoutingView = name === 'routing';
        routingFocusGroup.style.display = isRoutingView ? '' : 'none';
        routingFocusGroup.setAttribute('aria-hidden', isRoutingView ? 'false' : 'true');
      }
    } catch (e) {}

    try { _rememberView(name); } catch (e) {}

	  // View-scoped init for heavier modules to avoid doing work (and API calls)
	  // on tabs the user never opens.
	  if (name === 'mihomo') {
	    initViewOnce('mihomo', () => {
	      if (window.XKeen && XKeen.features && XKeen.features.mihomoPanel && typeof XKeen.features.mihomoPanel.init === 'function') {
	        XKeen.features.mihomoPanel.init();
	      }
	      if (window.XKeen && XKeen.features && XKeen.features.mihomoImport && typeof XKeen.features.mihomoImport.init === 'function') {
	        XKeen.features.mihomoImport.init();
	      }
	      if (window.XKeen && XKeen.features && XKeen.features.mihomoProxyTools && typeof XKeen.features.mihomoProxyTools.init === 'function') {
	        XKeen.features.mihomoProxyTools.init();
	      }
	    });
	  }
	  if (name === 'xkeen') {
	    initViewOnce('xkeen', () => {
	      if (window.XKeen && XKeen.features && XKeen.features.xkeenTexts && typeof XKeen.features.xkeenTexts.init === 'function') {
	        XKeen.features.xkeenTexts.init();
	      }
	    });
	  }
	  if (name === 'commands') {
	    initViewOnce('commands', () => {
	      if (window.XKeen && XKeen.features && XKeen.features.commandsList && typeof XKeen.features.commandsList.init === 'function') {
	        XKeen.features.commandsList.init();
	      }
	      if (window.XKeen && XKeen.features && XKeen.features.coresStatus && typeof XKeen.features.coresStatus.init === 'function') {
	        XKeen.features.coresStatus.init();
	      }
	    });
	  }

    // refresh editors when tab becomes visible
    if (name === 'routing') {
      // Monaco can be initialized while hidden (0px) or get a broken layout
      // after switching tabs/pages in some browsers. Give the routing module a
      // chance to relayout/recreate the active engine.
      try {
        if (window.XKeen && XKeen.routing && typeof XKeen.routing.onShow === 'function') {
          safe(() => XKeen.routing.onShow({ reason: 'tab' }));
        }
      } catch (e) {}
    }

    if (name === 'mihomo') {
      const ed = getEditor('mihomoEditor');
      if (ed && ed.refresh) safe(() => ed.refresh());
    }
    if (name === 'xkeen') {
      ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((k) => {
        const ed = getEditor(k);
        if (ed && ed.refresh) safe(() => ed.refresh());
      });
    }

    // xray logs: always refresh snapshot when opening the tab.
    // If the user explicitly enabled the "Live" toggle (persisted preference),
    // resume streaming while the tab is visible.
    if (name === 'xray-logs') {
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs) {
        if (typeof XKeen.features.xrayLogs.viewOnce === 'function') safe(() => XKeen.features.xrayLogs.viewOnce());
        if (typeof XKeen.features.xrayLogs.refreshStatus === 'function') safe(() => XKeen.features.xrayLogs.refreshStatus());

        // If the user has the "Live" toggle enabled (persisted preference),
        // resume streaming when the tab becomes visible again.
        try {
          const liveEl = document.getElementById('xray-log-live');
          if (liveEl && liveEl.checked && typeof XKeen.features.xrayLogs.start === 'function') {
            safe(() => XKeen.features.xrayLogs.start());
          }
        } catch (e) {}
      } else {
        if (typeof window.fetchXrayLogsOnce === 'function') safe(() => window.fetchXrayLogsOnce('manual'));
        if (typeof window.refreshXrayLogStatus === 'function') safe(() => window.refreshXrayLogStatus());

        try {
          const liveEl = document.getElementById('xray-log-live');
          if (liveEl && liveEl.checked && typeof window.startXrayLogAuto === 'function') {
            safe(() => window.startXrayLogAuto());
          }
        } catch (e) {}
      }
    } else {
      // Leaving the tab stops any active stream.
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs && typeof XKeen.features.xrayLogs.stop === 'function') {
        safe(() => XKeen.features.xrayLogs.stop());
      } else if (typeof window.stopXrayLogAuto === 'function') {
        safe(() => window.stopXrayLogAuto());
      }
    }

    // file manager: lazy-load + init + refresh when tab becomes visible
    if (name === 'files') {
      ensureFileManagerReady().then(() => {
        try {
          const FM = (window.XKeen && XKeen.features && XKeen.features.fileManager) ? XKeen.features.fileManager : null;
          // init.js is the entrypoint and calls FM.init() once.
          if (FM && typeof FM.onShow === 'function') safe(() => FM.onShow());
        } catch (e) {}
      });
    }

    // Ensure body scroll-lock state stays correct when switching tabs.
    // (e.g. when leaving a fullscreen card view).
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function wireTabs() {
    const buttons = document.querySelectorAll('.top-tab-btn[data-view]');
    buttons.forEach((btn) => {
      if (btn.dataset && btn.dataset.xkeenWiredTabs === '1') return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showView(btn.dataset.view);
      });
      if (btn.dataset) btn.dataset.xkeenWiredTabs = '1';
    });
  }

  function initModules() {
    // The list mirrors README milestones (safe to call even if module absent)
    safe(() => {
      if (window.XKeen && XKeen.routing && typeof XKeen.routing.init === 'function') XKeen.routing.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.routingTemplates && typeof XKeen.features.routingTemplates.init === 'function') {
        XKeen.features.routingTemplates.init();
      }
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.inbounds && typeof XKeen.features.inbounds.init === 'function') XKeen.features.inbounds.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.outbounds && typeof XKeen.features.outbounds.init === 'function') XKeen.features.outbounds.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs && typeof XKeen.features.xrayLogs.init === 'function') XKeen.features.xrayLogs.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.restartLog && typeof XKeen.features.restartLog.init === 'function') XKeen.features.restartLog.init();
    });
	  // mihomoPanel/mihomoImport are initialized lazily when the tab is opened (see showView).
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.serviceStatus && typeof XKeen.features.serviceStatus.init === 'function') XKeen.features.serviceStatus.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.localIO && typeof XKeen.localIO.init === 'function') XKeen.localIO.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.github && typeof XKeen.github.init === 'function') XKeen.github.init({ repoUrl: window.XKEEN_GITHUB_REPO_URL || '' });
    });
    safe(() => {
      if (window.XKeen && XKeen.backups && typeof XKeen.backups.init === 'function') XKeen.backups.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.jsonEditor && typeof XKeen.jsonEditor.init === 'function') XKeen.jsonEditor.init();
    });
	  // xkeenTexts/commandsList are initialized lazily when their tabs are opened (see showView).

    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.donate && typeof XKeen.features.donate.init === 'function') {
        XKeen.features.donate.init();
      }
    });
  }

  function init() {
    if (!isPanelPage()) return;

    // Initialize all modular features
    initModules();

    // Tabs (replaces inline onclick="showView(...)")
    wireTabs();

    // Terminal: load heavy xterm+modules only when user opens it
    wireTerminalLazyOpen();

    // Hide the extra terminal button immediately (capabilities-based)
    initTerminalCapabilityButtons();

    // Auto-open terminal from URL (?terminal=pty|shell) without loading terminal scripts on every page load.
    try {
      const url = new URL(window.location.href);
      const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
      if (mode === 'pty' || mode === 'shell') {
        ensureTerminalReady();
      }
    } catch (e) {}

    // Expose the new API + legacy alias (for compatibility)
    window.XKeen = window.XKeen || {};
    XKeen.ui = XKeen.ui || {};
    XKeen.ui.tabs = XKeen.ui.tabs || {};
    XKeen.ui.tabs.show = showView;
    window.showView = showView;

    // Initial view: remember the last opened tab when possible.
    const activeBtn = document.querySelector('.top-tab-btn.active[data-view]') || document.querySelector('.top-tab-btn[data-view]');
    const remembered = _restoreView();
    const initial = remembered || (activeBtn && activeBtn.dataset && activeBtn.dataset.view ? activeBtn.dataset.view : 'routing');
    showView(initial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
