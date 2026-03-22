(() => {
  // panel.html wiring (Milestones 1-2): init modules + remove inline onclick dependencies.

  function isPanelPage() {
    return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
  }

  function safe(fn) {
    try { fn(); } catch (e) { console.error(e); }
  }

  function getCoreHttp() {
    try {
      if (window.XKeen && XKeen.core && XKeen.core.http) return XKeen.core.http;
    } catch (e) {}
    return null;
  }

  // Per-view one-time init (reduces unnecessary work + avoids API calls on tabs the user never opens).
  const _viewInitFlags = Object.create(null);
  function initViewOnce(name, fn) {
    const key = String(name || '');
    if (!key) return Promise.resolve(false);
    const state = _viewInitFlags[key];
    if (state === true) return Promise.resolve(true);
    if (state && typeof state.then === 'function') return state;

    const run = Promise.resolve()
      .then(() => fn())
      .then((result) => {
        _viewInitFlags[key] = true;
        return result;
      })
      .catch((err) => {
        try { delete _viewInitFlags[key]; } catch (e) {}
        throw err;
      });

    _viewInitFlags[key] = run;
    return run;
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
const _xkLoading = new Map();

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
  if (_xkLoading.has(url)) return _xkLoading.get(url);

  // Existing tag?
  try {
    const found = document.querySelector('script[src="' + url + '"]') || document.querySelector('script[data-xk-src="' + url + '"]');
    if (found) {
      const state = (found.dataset && found.dataset.xkLoadState) ? String(found.dataset.xkLoadState) : '';
      if (state === 'ready') {
        _xkLoaded.add(url);
        return Promise.resolve(true);
      }
      if (state === 'loading' && _xkLoading.has(url)) {
        return _xkLoading.get(url);
      }
      try { found.remove(); } catch (e) {}
    }
  } catch (e) {}

  const promise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    // preserve execution order when awaited sequentially
    try { s.async = false; } catch (e) {}
    s.dataset.xkSrc = url;
    s.dataset.xkLoadState = 'loading';
    s.onload = () => {
      try { s.dataset.xkLoadState = 'ready'; } catch (e) {}
      _xkLoaded.add(url);
      resolve(true);
    };
    s.onerror = () => {
      console.error('[xk] failed to load script:', url);
      try { s.dataset.xkLoadState = 'error'; } catch (e) {}
      try { s.remove(); } catch (e2) {}
      resolve(false);
    };
    (document.body || document.documentElement).appendChild(s);
  });
  _xkLoading.set(url, promise.finally(() => {
    try { _xkLoading.delete(url); } catch (e) {}
  }));
  return _xkLoading.get(url);
}

async function loadScriptsInOrder(list) {
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i < items.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await loadScriptOnce(items[i]);
    if (!ok) return false;
  }
  return true;
}


function loadIsolatedUmdScriptOnce(path) {
  const url = _toUrl(path);
  if (!url) return Promise.resolve(false);
  if (_xkLoaded.has(url)) return Promise.resolve(true);
  if (_xkLoading.has(url)) return _xkLoading.get(url);

  const promise = (async () => {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res || !res.ok) return false;
      const code = await res.text();
      // Evaluate UMD bundles in an isolated scope where AMD/CommonJS globals
      // are shadowed, so Monaco's live AMD loader on window stays intact.
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
      _xkLoaded.add(url);
      return true;
    } catch (e) {
      console.error('[xk] failed to load isolated UMD script:', url, e);
      return false;
    }
  })();

  _xkLoading.set(url, promise.finally(() => {
    try { _xkLoading.delete(url); } catch (e) {}
  }));
  return _xkLoading.get(url);
}

async function loadUmdScriptsInOrder(list) {
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i < items.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await loadIsolatedUmdScriptOnce(items[i]);
    if (!ok) return false;
  }
  return true;
}

let _terminalLoaded = false;
let _terminalPromise = null;

function ensureTerminalReady() {
  if (_terminalLoaded) return Promise.resolve(true);
  if (_terminalPromise) return _terminalPromise;

  _terminalPromise = (async () => {
    // XTerm libs first (global Terminal + addons)
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

    // Terminal modules (kept in the same order as the old <script> list in panel.html)
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
  })().catch((err) => {
    try { console.error('[XKeen] terminal lazy load failed:', err); } catch (e) {}
    _terminalLoaded = false;
    _terminalPromise = null;
    return false;
  });

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
      ensureTerminalReady().then((ready) => {
        if (ready) openTerminal(mode);
      });
    }, true);
    if (btn.dataset) btn.dataset.xkLazyTerminal = '1';
  }

  wire(shellBtn, 'shell');
  wire(ptyBtn, 'pty');
}

// Decide which terminal open button to show on initial page load.
// Before terminal scripts are lazy-loaded, both buttons exist in markup.
// We hide one of them based on PTY availability from /api/capabilities.
let _terminalCapsInit = false;
function initTerminalCapabilityButtons() {
  if (_terminalCapsInit) return;
  _terminalCapsInit = true;

  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');
  if (!shellBtn && !ptyBtn) return;

  function apply(data) {
    const ws = !!(data && data.websocket);
    const hasPty = !!(
      data &&
      data.terminal &&
      typeof data.terminal === 'object' &&
      'pty' in data.terminal
        ? data.terminal.pty
        : ws
    );
    try {
      window.XKeen = window.XKeen || {};
      window.XKeen.state = window.XKeen.state || {};
      window.XKeen.state.hasWs = ws;
      window.XKeen.state.hasPty = hasPty;
    } catch (e) {}

    if (hasPty) {
      if (ptyBtn) { try { ptyBtn.style.display = ''; ptyBtn.disabled = false; } catch (e) {} }
      if (shellBtn) { try { shellBtn.style.display = 'none'; shellBtn.disabled = true; } catch (e) {} }
    } else {
      if (shellBtn) { try { shellBtn.style.display = ''; shellBtn.disabled = false; } catch (e) {} }
      if (ptyBtn) { try { ptyBtn.style.display = 'none'; ptyBtn.disabled = true; } catch (e) {} }
    }
  }

  // Keep server-side default (based on PTY support) until we know live capabilities.
  // This removes the "two buttons" glitch on initial load.
  Promise.resolve().then(() => {
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      return http.fetchJSON('/api/capabilities', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    }
    return fetch('/api/capabilities', { cache: 'no-store' })
      .then((r) => (r && r.ok) ? r.json() : null)
      .catch(() => null);
  })
    .then((data) => apply(data))
    .catch(() => {
      // On error: keep current default button.
    });
}


let _fileManagerLoaded = false;
let _fileManagerPromise = null;
let _monacoSupportPromise = null;

function ensureFileManagerReady() {
  if (_fileManagerLoaded) return Promise.resolve(true);
  if (_fileManagerPromise) return _fileManagerPromise;

  _fileManagerPromise = (async () => {
    const ok = await loadScriptsInOrder([
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
    if (!ok) throw new Error('failed to load file manager modules');

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
  })().catch((err) => {
    try { console.error('[XKeen] file manager lazy load failed:', err); } catch (e) {}
    _fileManagerLoaded = false;
    _fileManagerPromise = null;
    return false;
  });

  return _fileManagerPromise;
}

function hasMonacoSupport() {
  try {
    return !!(
      window.XKeen &&
      XKeen.monacoLoader &&
      typeof XKeen.monacoLoader.ensureMonaco === 'function' &&
      XKeen.ui &&
      XKeen.ui.monacoShared &&
      typeof XKeen.ui.monacoShared.createEditor === 'function'
    );
  } catch (e) {
    return false;
  }
}

function ensureMonacoSupport() {
  if (hasMonacoSupport()) return Promise.resolve(true);
  if (_monacoSupportPromise) return _monacoSupportPromise;

  _monacoSupportPromise = (async () => {
    const ok = await loadScriptsInOrder([
      'js/ui/monaco_loader.js',
      'js/ui/monaco_shared.js',
    ]);
    if (!ok) throw new Error('failed to load Monaco support');
    return hasMonacoSupport();
  })().catch((err) => {
    try { console.error('[XKeen] monaco lazy load failed:', err); } catch (e) {}
    _monacoSupportPromise = null;
    return false;
  }).finally(() => {
    if (hasMonacoSupport()) _monacoSupportPromise = null;
  });

  return _monacoSupportPromise;
}



// Expose lazy initializers for modules that want to use Terminal/File Manager APIs
// without always paying the initial load cost.
safe(() => {
  window.XKeen = window.XKeen || {};
  XKeen.lazy = XKeen.lazy || {};
  XKeen.lazy.ensureTerminalReady = ensureTerminalReady;
  XKeen.lazy.ensureFileManagerReady = ensureFileManagerReady;
  XKeen.lazy.ensureMonacoSupport = ensureMonacoSupport;
  XKeen.lazy.ensureFeature = ensureLazyFeature;

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
        return ensureTerminalReady().then((ready) => {
          if (!ready) return false;
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
        return ensureTerminalReady().then((ready) => {
          if (!ready) return { handled: false, result: { ok: false, error: 'terminal not ready' } };
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

  try {
    XKeen.backups = XKeen.backups || {};
    const api = XKeen.backups;

    if (!api.__xkLazyStubInstalled) {
      api.__xkLazyStubInstalled = true;

      const stubInit = () => ensureLazyFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XKeen.backups && typeof XKeen.backups.init === 'function' && XKeen.backups.init !== stubInit) {
          return XKeen.backups.init();
        }
        if (XKeen.backups && typeof XKeen.backups.load === 'function' && XKeen.backups.load !== stubLoad) {
          return XKeen.backups.load();
        }
        return false;
      });
      const stubLoad = () => ensureLazyFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XKeen.backups && typeof XKeen.backups.load === 'function' && XKeen.backups.load !== stubLoad) {
          return XKeen.backups.load();
        }
        return false;
      });
      const stubRefresh = () => ensureLazyFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XKeen.backups && typeof XKeen.backups.refresh === 'function' && XKeen.backups.refresh !== stubRefresh) {
          return XKeen.backups.refresh();
        }
        if (XKeen.backups && typeof XKeen.backups.load === 'function' && XKeen.backups.load !== stubLoad) {
          return XKeen.backups.load();
        }
        return false;
      });
      const stubRestoreAuto = (target) => ensureLazyFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XKeen.backups && typeof XKeen.backups.restoreAuto === 'function' && XKeen.backups.restoreAuto !== stubRestoreAuto) {
          return XKeen.backups.restoreAuto(target);
        }
        return false;
      });
      const stubViewSnapshot = (name) => ensureLazyFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XKeen.backups && typeof XKeen.backups.viewSnapshot === 'function' && XKeen.backups.viewSnapshot !== stubViewSnapshot) {
          return XKeen.backups.viewSnapshot(name);
        }
        return false;
      });
      const stubRestoreSnapshot = (name) => ensureLazyFeature('backups').then((ready) => {
        if (!ready) return false;
        if (XKeen.backups && typeof XKeen.backups.restoreSnapshot === 'function' && XKeen.backups.restoreSnapshot !== stubRestoreSnapshot) {
          return XKeen.backups.restoreSnapshot(name);
        }
        return false;
      });

      if (typeof api.init !== 'function') api.init = stubInit;
      if (typeof api.load !== 'function') api.load = stubLoad;
      if (typeof api.refresh !== 'function') api.refresh = stubRefresh;
      if (typeof api.restoreAuto !== 'function') api.restoreAuto = stubRestoreAuto;
      if (typeof api.viewSnapshot !== 'function') api.viewSnapshot = stubViewSnapshot;
      if (typeof api.restoreSnapshot !== 'function') api.restoreSnapshot = stubRestoreSnapshot;
    }
  } catch (e2) {}

  try {
    XKeen.jsonEditor = XKeen.jsonEditor || {};
    const api = XKeen.jsonEditor;

    if (!api.__xkLazyStubInstalled) {
      api.__xkLazyStubInstalled = true;

      const stubInit = () => ensureLazyFeature('jsonEditor');
      const stubOpen = (target) => ensureLazyFeature('jsonEditor').then((ready) => {
        if (!ready) return false;
        if (XKeen.jsonEditor && typeof XKeen.jsonEditor.open === 'function' && XKeen.jsonEditor.open !== stubOpen) {
          return XKeen.jsonEditor.open(target);
        }
        return false;
      });
      const stubClose = () => ensureLazyFeature('jsonEditor').then((ready) => {
        if (!ready) return false;
        if (XKeen.jsonEditor && typeof XKeen.jsonEditor.close === 'function' && XKeen.jsonEditor.close !== stubClose) {
          return XKeen.jsonEditor.close();
        }
        return false;
      });
      const stubSave = () => ensureLazyFeature('jsonEditor').then((ready) => {
        if (!ready) return false;
        if (XKeen.jsonEditor && typeof XKeen.jsonEditor.save === 'function' && XKeen.jsonEditor.save !== stubSave) {
          return XKeen.jsonEditor.save();
        }
        return false;
      });
      const stubIsDirty = () => false;

      if (typeof api.init !== 'function') api.init = stubInit;
      if (typeof api.open !== 'function') api.open = stubOpen;
      if (typeof api.close !== 'function') api.close = stubClose;
      if (typeof api.save !== 'function') api.save = stubSave;
      if (typeof api.isDirty !== 'function') api.isDirty = stubIsDirty;
    }
  } catch (e3) {}

  try {
    XKeen.ui = XKeen.ui || {};
    XKeen.ui.datContents = XKeen.ui.datContents || {};
    const api = XKeen.ui.datContents;

    if (!api.__xkLazyStubInstalled) {
      api.__xkLazyStubInstalled = true;

      const stubOpen = (kind, opts) => ensureLazyFeature('datContents').then((ready) => {
        if (!ready) return false;
        if (XKeen.ui && XKeen.ui.datContents && typeof XKeen.ui.datContents.open === 'function' && XKeen.ui.datContents.open !== stubOpen) {
          return XKeen.ui.datContents.open(kind, opts);
        }
        return false;
      });
      const stubClose = () => ensureLazyFeature('datContents').then((ready) => {
        if (!ready) return false;
        if (XKeen.ui && XKeen.ui.datContents && typeof XKeen.ui.datContents.close === 'function' && XKeen.ui.datContents.close !== stubClose) {
          return XKeen.ui.datContents.close();
        }
        return false;
      });

      if (typeof api.open !== 'function') api.open = stubOpen;
      if (typeof api.close !== 'function') api.close = stubClose;
    }
  } catch (e4) {}
});

const _lazyFeatureReady = Object.create(null);
const _lazyFeatureLoading = Object.create(null);
const LAZY_FEATURE_SCRIPTS = {
  routingTemplates: ['js/features/routing_templates.js'],
  github: ['js/features/github.js'],
  serviceStatus: ['js/features/service_status.js'],
  xrayLogs: ['js/features/xray_logs.js'],
  restartLog: ['js/features/restart_log.js'],
  inbounds: ['js/features/inbounds.js'],
  outbounds: ['js/features/outbounds.js'],
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
};

function isMipsTarget() {
  try {
    if (typeof window.XKEEN_IS_MIPS === 'boolean') return !!window.XKEEN_IS_MIPS;
    const v = String(window.XKEEN_IS_MIPS || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch (e) {}
  return false;
}

function hasXrayCore() {
  try {
    if (typeof window.XKEEN_HAS_XRAY === 'boolean') return !!window.XKEEN_HAS_XRAY;
    const v = String(window.XKEEN_HAS_XRAY || '').toLowerCase();
    if (v) return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch (e) {}
  return true;
}

const LIGHT_XRAY_BADGE_POLL_MS = 10000;
let _lightXrayBadgeTimer = null;
let _lightXrayBadgeVisibilityBound = false;
const LIGHT_XKEEN_STATUS_POLL_MS = 15000;
let _lightXkeenStatusTimer = null;
let _lightXkeenStatusVisibilityBound = false;
const LIGHT_DONATE_HIDE_KEY = 'xkeen_ui_hide_donate';

function getLightweightDonateHidePref() {
  try {
    const raw = localStorage.getItem(LIGHT_DONATE_HIDE_KEY);
    return raw === '1' || raw === 'true' || raw === 'yes';
  } catch (e) {
    return false;
  }
}

function syncLightweightDonateButtonVisibility() {
  const btn = document.getElementById('top-tab-donate');
  if (!btn) return;
  btn.classList.toggle('hidden', getLightweightDonateHidePref());
}

function setLightweightXrayHeaderBadgeState(state, level) {
  const badge = document.getElementById('xray-logs-badge');
  if (!badge) return;

  const st = String(state || '').toLowerCase() === 'on' ? 'on' : 'off';
  badge.dataset.state = st;

  if (st === 'on') {
    const lvl = String(level || '').trim().toLowerCase();
    badge.title = (lvl && lvl !== 'none')
      ? ('Логи Xray включены (loglevel=' + lvl + ').')
      : 'Логи Xray включены.';
    return;
  }

  badge.title = 'Логи Xray выключены.';
}

function hasLoadedXrayLogsFeature() {
  try {
    const api = (window.XKeen && XKeen.features) ? XKeen.features.xrayLogs : null;
    return !!(api && typeof api.init === 'function' && typeof api.refreshStatus === 'function');
  } catch (e) {
    return false;
  }
}

function stopLightweightXrayBadgePolling() {
  if (_lightXrayBadgeTimer) {
    try { clearInterval(_lightXrayBadgeTimer); } catch (e) {}
    _lightXrayBadgeTimer = null;
  }
}

async function refreshLightweightXrayHeaderBadge() {
  if (!hasXrayCore()) return false;
  if (hasLoadedXrayLogsFeature()) {
    stopLightweightXrayBadgePolling();
    return true;
  }

  try {
    let data = null;
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      data = await http.fetchJSON('/api/xray-logs/status', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    } else {
      const res = await fetch('/api/xray-logs/status', { cache: 'no-store' });
      data = await res.json().catch(() => null);
      if (!res.ok) data = null;
    }

    const level = String((data && data.loglevel) ? data.loglevel : 'none').toLowerCase();
    setLightweightXrayHeaderBadgeState(level === 'none' ? 'off' : 'on', level);
    return true;
  } catch (e) {
    setLightweightXrayHeaderBadgeState('off', 'none');
    return false;
  }
}

function startLightweightXrayBadgePolling() {
  if (!hasXrayCore()) return;
  if (_lightXrayBadgeTimer || hasLoadedXrayLogsFeature()) return;

  void refreshLightweightXrayHeaderBadge();

  _lightXrayBadgeTimer = setInterval(() => {
    if (hasLoadedXrayLogsFeature()) {
      stopLightweightXrayBadgePolling();
      return;
    }
    try {
      if (document.visibilityState === 'hidden') return;
    } catch (e) {}
    void refreshLightweightXrayHeaderBadge();
  }, LIGHT_XRAY_BADGE_POLL_MS);

  if (_lightXrayBadgeVisibilityBound) return;
  _lightXrayBadgeVisibilityBound = true;

  document.addEventListener('visibilitychange', () => {
    if (!_lightXrayBadgeTimer || hasLoadedXrayLogsFeature()) return;
    try {
      if (document.visibilityState === 'visible') void refreshLightweightXrayHeaderBadge();
    } catch (e) {}
  });
}

function getGlobalAutorestartCheckbox() {
  return document.getElementById('global-autorestart-xkeen');
}

function lightweightShouldAutoRestartAfterSave() {
  const cb = getGlobalAutorestartCheckbox();
  return !!(cb && cb.checked);
}

function bindLightweightAutorestartCheckbox() {
  const cb = getGlobalAutorestartCheckbox();
  if (!cb) return;

  try {
    if (window.localStorage) {
      const stored = localStorage.getItem('xkeen_global_autorestart');
      if (stored === '1') cb.checked = true;
      else if (stored === '0') cb.checked = false;
    }
  } catch (e) {}

  if (cb.dataset && cb.dataset.xkeenBound === '1') return;

  cb.addEventListener('change', () => {
    try {
      if (!window.localStorage) return;
      localStorage.setItem('xkeen_global_autorestart', cb.checked ? '1' : '0');
    } catch (e) {}
  });

  if (cb.dataset) cb.dataset.xkeenBound = '1';
}

if (typeof window.shouldAutoRestartAfterSave !== 'function') {
  window.shouldAutoRestartAfterSave = lightweightShouldAutoRestartAfterSave;
}

function setLightweightXkeenHeaderState(state, core) {
  const lamp = document.getElementById('xkeen-service-lamp');
  const textEl = document.getElementById('xkeen-service-text');
  const coreEl = document.getElementById('xkeen-core-text');
  const startBtn = document.getElementById('xkeen-start-btn');

  if (startBtn) {
    const showStart = String(state || '').toLowerCase() === 'stopped';
    startBtn.hidden = !showStart;
    startBtn.setAttribute('aria-hidden', showStart ? 'false' : 'true');
  }

  if (!lamp || !textEl || !coreEl) return;

  const st = String(state || '');
  lamp.dataset.state = st;

  let text = 'Статус неизвестен';
  switch (st) {
    case 'running':
      text = 'Сервис запущен';
      break;
    case 'stopped':
      text = 'Сервис остановлен';
      break;
    case 'pending':
      text = 'Проверка статуса...';
      break;
    case 'error':
      text = 'Ошибка статуса';
      break;
    default:
      break;
  }

  textEl.textContent = text;

  if (core) {
    const label = String(core || '').toLowerCase() === 'mihomo' ? 'mihomo' : 'xray';
    coreEl.textContent = 'Ядро: ' + label;
    coreEl.dataset.core = label;
    coreEl.classList.add('has-core');
    coreEl.disabled = false;
    lamp.title = text + ' (ядро: ' + label + ')';
    return;
  }

  coreEl.textContent = '';
  coreEl.dataset.core = '';
  coreEl.classList.remove('has-core');
  coreEl.disabled = false;
  lamp.title = text;
}

function hasLoadedServiceStatusFeature() {
  try {
    const api = (window.XKeen && XKeen.features) ? XKeen.features.serviceStatus : null;
    return !!(api && typeof api.init === 'function' && typeof api.refresh === 'function');
  } catch (e) {
    return false;
  }
}

function stopLightweightXkeenStatusPolling() {
  if (_lightXkeenStatusTimer) {
    try { clearInterval(_lightXkeenStatusTimer); } catch (e) {}
    _lightXkeenStatusTimer = null;
  }
}

async function refreshLightweightXkeenHeaderStatus(opts) {
  const o = opts || {};
  const lamp = document.getElementById('xkeen-service-lamp');
  if (!lamp) return false;

  if (hasLoadedServiceStatusFeature()) {
    stopLightweightXkeenStatusPolling();
    return true;
  }

  const curState = String(lamp.dataset.state || '');
  if (!o.silent && (!curState || curState === 'pending')) {
    setLightweightXkeenHeaderState('pending');
  }

  try {
    let data = null;
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      data = await http.fetchJSON('/api/xkeen/status', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    } else {
      const res = await fetch('/api/xkeen/status', { cache: 'no-store' });
      data = await res.json().catch(() => null);
      if (!res.ok) data = null;
    }

    if (!data) throw new Error('empty status payload');

    setLightweightXkeenHeaderState(data.running ? 'running' : 'stopped', data.core || null);
    return true;
  } catch (e) {
    setLightweightXkeenHeaderState('error');
    return false;
  }
}

function startLightweightXkeenStatusPolling() {
  bindLightweightAutorestartCheckbox();

  if (_lightXkeenStatusTimer || hasLoadedServiceStatusFeature()) return;

  void refreshLightweightXkeenHeaderStatus({ silent: false });

  _lightXkeenStatusTimer = setInterval(() => {
    if (hasLoadedServiceStatusFeature()) {
      stopLightweightXkeenStatusPolling();
      return;
    }
    try {
      if (document.visibilityState === 'hidden') return;
    } catch (e) {}
    void refreshLightweightXkeenHeaderStatus({ silent: true });
  }, LIGHT_XKEEN_STATUS_POLL_MS);

  if (_lightXkeenStatusVisibilityBound) return;
  _lightXkeenStatusVisibilityBound = true;

  document.addEventListener('visibilitychange', () => {
    if (!_lightXkeenStatusTimer || hasLoadedServiceStatusFeature()) return;
    try {
      if (document.visibilityState === 'visible') void refreshLightweightXkeenHeaderStatus({ silent: true });
    } catch (e) {}
  });
}

const CORE_UI_WATCH_INITIAL_DELAY_MS = 8000;
const CORE_UI_WATCH_POLL_MS = 15000;
const CORE_UI_WATCH_HIDDEN_POLL_MS = 60000;
const CORE_UI_WATCH_ERROR_BACKOFF_MS = 60000;
const CORE_UI_WATCH_FOCUS_COOLDOWN_MS = 2500;

function normalizeCoreList(list) {
  const raw = Array.isArray(list) ? list : [];
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const name = String(raw[i] || '').trim().toLowerCase();
    if (!name || (name !== 'xray' && name !== 'mihomo')) continue;
    if (seen[name]) continue;
    seen[name] = true;
    out.push(name);
  }
  out.sort();
  return out;
}

function coreListSignature(list) {
  return normalizeCoreList(list).join(',');
}

function getInitialDetectedCores() {
  try {
    if (Array.isArray(window.XKEEN_DETECTED_CORES)) {
      return normalizeCoreList(window.XKEEN_DETECTED_CORES);
    }
  } catch (e) {}
  try {
    if (window.XKEEN_CORE_UI_FALLBACK === true) return [];
  } catch (e2) {}
  try {
    return normalizeCoreList(window.XKEEN_AVAILABLE_CORES);
  } catch (e3) {}
  return [];
}

function formatCoreName(name) {
  const key = String(name || '').toLowerCase();
  if (key === 'xray') return 'Xray';
  if (key === 'mihomo') return 'Mihomo';
  return String(name || '');
}

function describeCoreUiTopologyChange(prevCores, nextCores) {
  const prev = normalizeCoreList(prevCores);
  const next = normalizeCoreList(nextCores);
  const added = next.filter((name) => prev.indexOf(name) === -1);
  const removed = prev.filter((name) => next.indexOf(name) === -1);

  if (added.length && !removed.length) {
    if (added.length === 1) {
      return 'Найдено ядро ' + formatCoreName(added[0]) + '. На панели появились новые разделы.';
    }
    return 'Найдены новые ядра: ' + added.map(formatCoreName).join(', ') + '. Панель покажет дополнительные разделы.';
  }

  if (removed.length && !added.length) {
    if (removed.length === 1) {
      return 'Ядро ' + formatCoreName(removed[0]) + ' больше не найдено. Лишние разделы будут скрыты.';
    }
    return 'Часть ядер больше не найдена: ' + removed.map(formatCoreName).join(', ') + '. Панель скроет лишние разделы.';
  }

  if (!prev.length && next.length) {
    return 'Найдены установленные ядра: ' + next.map(formatCoreName).join(', ') + '. Панель перестроится под доступные разделы.';
  }

  if (prev.length && !next.length) {
    return 'Установленные ядра больше не обнаружены. Панель вернётся к безопасному режиму отображения.';
  }

  return 'Конфигурация ядер изменилась. Панель нужно обновить.';
}

let _coreUiKnownDetectedCores = getInitialDetectedCores();
let _coreUiKnownSignature = coreListSignature(_coreUiKnownDetectedCores);
let _coreUiWatchTimer = null;
let _coreUiWatchInFlight = false;
let _coreUiReloadScheduled = false;
let _coreUiPendingSignature = '';
let _coreUiPendingMessage = '';
let _coreUiLastCheckAt = 0;
let _coreUiWatchInited = false;

function notifyPanelInfo(message) {
  const text = String(message || '').trim();
  if (!text) return;
  try {
    if (typeof window.toast === 'function') {
      window.toast(text, 'info');
      return;
    }
  } catch (e) {}
}

function hasUnsavedPanelChanges() {
  try {
    if (window.routingIsDirty === true) return true;
  } catch (e) {}

  try {
    const mihomoPanel = window.XKeen && XKeen.features ? XKeen.features.mihomoPanel : null;
    if (mihomoPanel && typeof mihomoPanel.isEditorDirty === 'function' && mihomoPanel.isEditorDirty()) {
      return true;
    }
  } catch (e) {}

  try {
    const jsonEditor = window.XKeen ? XKeen.jsonEditor : null;
    if (jsonEditor && typeof jsonEditor.isDirty === 'function' && jsonEditor.isDirty()) {
      return true;
    }
  } catch (e) {}

  try {
    const fileManager = (window.XKeen && XKeen.features) ? XKeen.features.fileManager : null;
    const editor = fileManager ? fileManager.editor : null;
    if (editor && typeof editor.isDirty === 'function' && editor.isDirty()) {
      return true;
    }
  } catch (e) {}

  return false;
}

function getCoreUiRefreshButton() {
  return document.getElementById('panel-core-ui-refresh-btn');
}

async function confirmCoreUiManualReload() {
  if (!hasUnsavedPanelChanges()) return true;

  const title = 'Обновить панель?';
  const message = 'Панель перестроится под новый набор ядер, несохранённые изменения будут потеряны.';

  try {
    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
      return await XKeen.ui.confirm({
        title,
        message,
        okText: 'Обновить',
        cancelText: 'Отмена',
        danger: true,
      });
    }
  } catch (e) {}

  try {
    return window.confirm(message);
  } catch (e2) {
    return false;
  }
}

function revealCoreUiRefreshButton(message) {
  const btn = getCoreUiRefreshButton();
  if (!btn) return;
  try { btn.classList.remove('hidden'); } catch (e) {}
  try { btn.disabled = false; } catch (e2) {}
  try { btn.title = String(message || btn.title || ''); } catch (e3) {}
}

function reloadPanelForCoreUiChange(message) {
  if (_coreUiReloadScheduled) return;
  _coreUiReloadScheduled = true;

  const text = String(message || 'Найдено изменение в наборе ядер.');
  notifyPanelInfo(text + ' Перезагружаем панель...');

  try {
    if (_coreUiWatchTimer) clearTimeout(_coreUiWatchTimer);
  } catch (e) {}
  _coreUiWatchTimer = null;

  setTimeout(() => {
    try {
      window.location.reload();
    } catch (e) {
      try { window.location.href = window.location.href; } catch (e2) {}
    }
  }, 900);
}

function deferCoreUiReload(message, nextCores) {
  const nextSig = coreListSignature(nextCores);
  if (_coreUiPendingSignature === nextSig) return;

  _coreUiPendingSignature = nextSig;
  _coreUiPendingMessage = String(message || 'Конфигурация ядер изменилась.');
  revealCoreUiRefreshButton(_coreUiPendingMessage);
  notifyPanelInfo(_coreUiPendingMessage + ' Сохраните изменения и нажмите "Обновить панель".');

  try {
    if (_coreUiWatchTimer) clearTimeout(_coreUiWatchTimer);
  } catch (e) {}
  _coreUiWatchTimer = null;
}

function parseDetectedCoresFromPayload(data) {
  if (!data || typeof data !== 'object') return null;

  if (Array.isArray(data.cores)) {
    return normalizeCoreList(data.cores);
  }

  if (data.cores && typeof data.cores === 'object') {
    const out = [];
    if (data.cores.xray && data.cores.xray.installed) out.push('xray');
    if (data.cores.mihomo && data.cores.mihomo.installed) out.push('mihomo');
    return normalizeCoreList(out);
  }

  return null;
}

async function fetchDetectedCores() {
  const http = getCoreHttp();
  if (http && typeof http.fetchJSON === 'function') {
    try {
      const data = await http.fetchJSON('/api/xkeen/core', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      });
      if (!data || data.ok !== true) return null;
      return parseDetectedCoresFromPayload(data);
    } catch (e) {
      return null;
    }
  }

  try {
    const res = await fetch('/api/xkeen/core', { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) return null;
    return parseDetectedCoresFromPayload(data);
  } catch (e) {
    return null;
  }
}

function scheduleCoreUiWatch(delayMs) {
  if (_coreUiReloadScheduled || _coreUiPendingSignature) return;

  const wait = (typeof delayMs === 'number' && delayMs >= 0) ? delayMs : CORE_UI_WATCH_POLL_MS;
  try {
    if (_coreUiWatchTimer) clearTimeout(_coreUiWatchTimer);
  } catch (e) {}
  _coreUiWatchTimer = setTimeout(() => {
    _coreUiWatchTimer = null;
    void checkCoreUiTopology('timer');
  }, wait);
}

async function handleCoreUiTopologyChange(prevCores, nextCores) {
  const message = describeCoreUiTopologyChange(prevCores, nextCores);
  if (hasUnsavedPanelChanges()) {
    deferCoreUiReload(message, nextCores);
    return;
  }
  reloadPanelForCoreUiChange(message);
}

async function checkCoreUiTopology(reason) {
  if (_coreUiReloadScheduled || _coreUiPendingSignature || _coreUiWatchInFlight) return;

  try {
    if (document.visibilityState === 'hidden') {
      scheduleCoreUiWatch(CORE_UI_WATCH_HIDDEN_POLL_MS);
      return;
    }
  } catch (e) {}

  const now = Date.now();
  if (reason === 'focus' && (now - _coreUiLastCheckAt) < CORE_UI_WATCH_FOCUS_COOLDOWN_MS) {
    scheduleCoreUiWatch(CORE_UI_WATCH_POLL_MS);
    return;
  }

  _coreUiWatchInFlight = true;
  _coreUiLastCheckAt = now;

  let nextDelay = CORE_UI_WATCH_POLL_MS;
  try {
    const nextCores = await fetchDetectedCores();
    if (!nextCores) {
      nextDelay = CORE_UI_WATCH_ERROR_BACKOFF_MS;
      return;
    }

    const prevCores = _coreUiKnownDetectedCores.slice();
    const nextSig = coreListSignature(nextCores);
    if (nextSig !== _coreUiKnownSignature) {
      _coreUiKnownDetectedCores = nextCores.slice();
      _coreUiKnownSignature = nextSig;
      void handleCoreUiTopologyChange(prevCores, nextCores);
      return;
    }
  } finally {
    _coreUiWatchInFlight = false;
  }

  scheduleCoreUiWatch(nextDelay);
}

function wireCoreUiRefreshButton() {
  const btn = getCoreUiRefreshButton();
  if (!btn) return;
  if (btn.dataset && btn.dataset.xkCoreRefreshWired === '1') return;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = await confirmCoreUiManualReload();
    if (!ok) return;
    reloadPanelForCoreUiChange(_coreUiPendingMessage || 'Перестраиваем панель под доступные ядра.');
  });

  if (btn.dataset) btn.dataset.xkCoreRefreshWired = '1';
}

function initCoreUiAutoDetect() {
  if (_coreUiWatchInited) return;
  _coreUiWatchInited = true;

  wireCoreUiRefreshButton();

  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'visible') {
        void checkCoreUiTopology('visibility');
      }
    } catch (e) {}
  });

  window.addEventListener('focus', () => {
    void checkCoreUiTopology('focus');
  });

  scheduleCoreUiWatch(CORE_UI_WATCH_INITIAL_DELAY_MS);
}

function getLazyFeatureApi(name) {
  try {
    switch (String(name || '')) {
      case 'routingTemplates':
        return (window.XKeen && XKeen.features) ? XKeen.features.routingTemplates : null;
      case 'github':
        return window.XKeen ? XKeen.github : null;
      case 'serviceStatus':
        return (window.XKeen && XKeen.features) ? XKeen.features.serviceStatus : null;
      case 'xrayLogs':
        return (window.XKeen && XKeen.features) ? XKeen.features.xrayLogs : null;
      case 'restartLog':
        return (window.XKeen && XKeen.features) ? XKeen.features.restartLog : null;
      case 'inbounds':
        return (window.XKeen && XKeen.features) ? XKeen.features.inbounds : null;
      case 'outbounds':
        return (window.XKeen && XKeen.features) ? XKeen.features.outbounds : null;
      case 'donate':
        return (window.XKeen && XKeen.features) ? XKeen.features.donate : null;
      case 'backups':
        return window.XKeen ? XKeen.backups : null;
      case 'jsonEditor':
        return window.XKeen ? XKeen.jsonEditor : null;
      case 'datContents':
        return (window.XKeen && XKeen.ui) ? XKeen.ui.datContents : null;
      case 'xkeenTexts':
        return (window.XKeen && XKeen.features) ? XKeen.features.xkeenTexts : null;
      case 'commandsList':
        return (window.XKeen && XKeen.features) ? XKeen.features.commandsList : null;
      case 'coresStatus':
        return (window.XKeen && XKeen.features) ? XKeen.features.coresStatus : null;
      case 'formatters':
        return (window.XKeen && XKeen.ui && XKeen.ui.formatters &&
          (typeof XKeen.ui.formatters.formatJson === 'function' || typeof XKeen.ui.formatters.formatYaml === 'function'))
          ? XKeen.ui.formatters
          : null;
      case 'xrayPreflight':
        return (window.XKeen && XKeen.ui && typeof XKeen.ui.showXrayPreflightError === 'function')
          ? XKeen.ui
          : null;
      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

function isLazyFeatureStub(feature) {
  try {
    return !!(feature && feature.__xkLazyStubInstalled);
  } catch (e) {
    return false;
  }
}

function initLazyFeature(name) {
  const feature = getLazyFeatureApi(name);
  switch (String(name || '')) {
    case 'routingTemplates':
      if (feature && typeof feature.init === 'function') feature.init();
      break;
    case 'github':
      if (feature && typeof feature.init === 'function') feature.init({ repoUrl: window.XKEEN_GITHUB_REPO_URL || '' });
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
      if (feature && typeof feature.init === 'function') feature.init();
      break;
    case 'backups':
      break;
    case 'datContents':
    case 'formatters':
    case 'xrayPreflight':
    case 'uiSettingsPanel':
      break;
    default:
      break;
  }
}

function ensureLazyFeature(name) {
  const key = String(name || '');
  if (!key) return Promise.resolve(false);
  if (_lazyFeatureReady[key]) return Promise.resolve(true);
  if (_lazyFeatureLoading[key]) return _lazyFeatureLoading[key];

  _lazyFeatureLoading[key] = (async () => {
    const scripts = Array.isArray(LAZY_FEATURE_SCRIPTS[key]) ? LAZY_FEATURE_SCRIPTS[key] : [];
    const existing = getLazyFeatureApi(key);
    if ((!existing || isLazyFeatureStub(existing)) && scripts.length) {
      const ok = await loadScriptsInOrder(scripts);
      if (!ok) throw new Error('failed to load lazy feature: ' + key);
    }
    safe(() => initLazyFeature(key));
    safe(() => {
      const loaded = getLazyFeatureApi(key);
      if (loaded && loaded.__xkLazyStubInstalled) {
        try { delete loaded.__xkLazyStubInstalled; } catch (e) {}
      }
    });
    _lazyFeatureReady[key] = true;
    if (key === 'xrayLogs') stopLightweightXrayBadgePolling();
    if (key === 'serviceStatus') stopLightweightXkeenStatusPolling();
    return true;
  })().catch((err) => {
    try { console.error('[XKeen] lazy feature failed:', key, err); } catch (e) {}
    _lazyFeatureReady[key] = false;
    return false;
  }).finally(() => {
    _lazyFeatureLoading[key] = null;
  });

  return _lazyFeatureLoading[key];
}

function replayDeferredClick(el) {
  if (!el) return;
  try {
    if (el.dataset) el.dataset.xkLazyReplay = '1';
  } catch (e) {}
  fireDeferredClick(el);
}

function fireDeferredClick(el) {
  if (!el) return;
  try {
    el.click();
  } catch (e) {
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e2) {}
  }
}

function replayDeferredEvent(el, type) {
  if (!el || !type) return;
  if (String(type) === 'click') {
    replayDeferredClick(el);
    return;
  }
  try {
    el.dispatchEvent(new Event(String(type), { bubbles: true, cancelable: true }));
  } catch (e) {}
}

function consumeReplayFlag(el) {
  try {
    if (!el || !el.dataset || el.dataset.xkLazyReplay !== '1') return false;
    delete el.dataset.xkLazyReplay;
    return true;
  } catch (e) {
    return false;
  }
}

function wireLazyFeatureClicks() {
  if (document.body && document.body.dataset && document.body.dataset.xkLazyFeatureClicks === '1') return;

  document.addEventListener('click', (e) => {
    const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!raw) return;

    const serviceTrigger = raw.closest('#xkeen-start-btn, #xkeen-stop-btn, #xkeen-restart-btn, #xkeen-core-text');
    if (serviceTrigger && !_lazyFeatureReady.serviceStatus) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('serviceStatus').then((ready) => {
        if (!ready) return;
        fireDeferredClick(serviceTrigger);
      });
      return;
    }

    const xrayActionBtn = raw.closest('#view-xray-logs button');
    if (xrayActionBtn && !_lazyFeatureReady.xrayLogs) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        fireDeferredClick(xrayActionBtn);
      });
      return;
    }

    const templateBtn = raw.closest('#routing-import-template-btn');
    if (templateBtn) {
      if (consumeReplayFlag(templateBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('routingTemplates').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('routingTemplates');
          if (api && typeof api.open === 'function') api.open();
          else replayDeferredClick(templateBtn);
        } catch (err) {}
      });
      return;
    }

    const githubExportBtn = raw.closest('#github-export-btn');
    if (githubExportBtn) {
      if (consumeReplayFlag(githubExportBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('github').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('github');
          if (api && typeof api.openExportModal === 'function') api.openExportModal();
          else replayDeferredClick(githubExportBtn);
        } catch (err) {}
      });
      return;
    }

    const githubCatalogBtn = raw.closest('#github-open-catalog-btn');
    if (githubCatalogBtn) {
      if (consumeReplayFlag(githubCatalogBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('github').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('github');
          if (api && typeof api.openCatalogModal === 'function') api.openCatalogModal();
          else replayDeferredClick(githubCatalogBtn);
        } catch (err) {}
      });
      return;
    }

    const donateBtn = raw.closest('#top-tab-donate');
    if (donateBtn) {
      if (consumeReplayFlag(donateBtn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('donate').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('donate');
          if (api && typeof api.open === 'function') {
            api.open();
            return;
          }
        } catch (err) {}
        replayDeferredClick(donateBtn);
      });
      return;
    }

    const settingsBtn = raw.closest('#ui-settings-open-btn');
    if (settingsBtn && !_lazyFeatureReady.uiSettingsPanel) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('uiSettingsPanel').then((ready) => {
        if (!ready) return;
        fireDeferredClick(settingsBtn);
      });
      return;
    }

    const xkeenAction = raw.closest('#port-proxying-save-btn, #port-exclude-save-btn, #ip-exclude-save-btn, #xkeen-config-save-btn');
    if (xkeenAction && !_lazyFeatureReady.xkeenTexts) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xkeenTexts').then((ready) => {
        if (!ready) return;
        fireDeferredClick(xkeenAction);
      });
      return;
    }

    const commandsAction = raw.closest('.command-item, #cores-check-btn, #core-xray-update-btn, #core-mihomo-update-btn');
    if (commandsAction && (!_lazyFeatureReady.commandsList || !_lazyFeatureReady.coresStatus)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      Promise.all([
        ensureLazyFeature('commandsList'),
        ensureLazyFeature('coresStatus'),
      ]).then((results) => {
        if (results.every(Boolean)) fireDeferredClick(commandsAction);
      });
      return;
    }

    const backupsHeader = raw.closest('#routing-backups-header');
    if (backupsHeader && !_lazyFeatureReady.backups) {
      if (consumeReplayFlag(backupsHeader)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('backups').then((ready) => {
        if (!ready) return;
        try {
          const api = getLazyFeatureApi('backups');
          if (api && typeof api.load === 'function') api.load();
        } catch (err) {}
        replayDeferredClick(backupsHeader);
      });
      return;
    }

    const inboundsTrigger = raw.closest('#inbounds-header, [id^="inbounds-"], [name="inbounds_mode"]');
    if (inboundsTrigger && !_lazyFeatureReady.inbounds) {
      if (consumeReplayFlag(inboundsTrigger)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('inbounds').then((ready) => {
        if (!ready) return;
        replayDeferredClick(inboundsTrigger);
      });
      return;
    }

    const outboundsTrigger = raw.closest('#outbounds-header, [id^="outbounds-"]');
    if (outboundsTrigger && !_lazyFeatureReady.outbounds) {
      if (consumeReplayFlag(outboundsTrigger)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('outbounds').then((ready) => {
        if (!ready) return;
        replayDeferredClick(outboundsTrigger);
      });
      return;
    }
  }, true);

  document.addEventListener('change', (e) => {
    const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!raw) return;

    const xrayControl = raw.closest('#view-xray-logs select, #view-xray-logs input, #view-xray-logs textarea');
    if (xrayControl && !_lazyFeatureReady.xrayLogs) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        replayDeferredEvent(xrayControl, 'change');
      });
    }
  }, true);

  document.addEventListener('input', (e) => {
    const raw = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
    if (!raw) return;

    const xrayInput = raw.closest('#view-xray-logs input, #view-xray-logs textarea');
    if (xrayInput && !_lazyFeatureReady.xrayLogs) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        replayDeferredEvent(xrayInput, 'input');
      });
    }
  }, true);

  if (document.body && document.body.dataset) document.body.dataset.xkLazyFeatureClicks = '1';
}
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
      try {
        return !!(el && el.dataset && (
          el.dataset.xkForceHidden === '1' ||
          el.dataset.xkHideUnusedHidden === '1'
        ));
      } catch (e) { return false; }
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
      const hidden = (btn.style.display === 'none') || isForceHidden(btn);
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
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }
    if (name === 'xkeen') {
      initViewOnce('xkeen', async () => {
        const ready = await ensureLazyFeature('xkeenTexts');
        if (!ready) throw new Error('xkeen texts not ready');
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }
    if (name === 'commands') {
      initViewOnce('commands', async () => {
        const results = await Promise.all([
          ensureLazyFeature('commandsList'),
          ensureLazyFeature('coresStatus'),
        ]);
        if (!results.every(Boolean)) throw new Error('commands view features not ready');
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
      });
    }

    if (name === 'routing') {
      initViewOnce('routing', () => {
        if (hasXrayCore() && window.XKeen && XKeen.routing && typeof XKeen.routing.init === 'function') {
          XKeen.routing.init();
        }
      }).catch((err) => {
        try { console.error('[XKeen] view init failed:', name, err); } catch (e) {}
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
      ensureLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        const section = document.getElementById('view-xray-logs');
        if (!section || section.style.display === 'none') return;

        if (window.XKeen && XKeen.features && XKeen.features.xrayLogs) {
          if (typeof XKeen.features.xrayLogs.viewOnce === 'function') safe(() => XKeen.features.xrayLogs.viewOnce());
          if (typeof XKeen.features.xrayLogs.refreshStatus === 'function') safe(() => XKeen.features.xrayLogs.refreshStatus());

          try {
            const liveEl = document.getElementById('xray-log-live');
            if (liveEl && liveEl.checked && typeof XKeen.features.xrayLogs.start === 'function') {
              safe(() => XKeen.features.xrayLogs.start());
            }
          } catch (e) {}
          return;
        }

        if (typeof window.fetchXrayLogsOnce === 'function') safe(() => window.fetchXrayLogsOnce('manual'));
        if (typeof window.refreshXrayLogStatus === 'function') safe(() => window.refreshXrayLogStatus());

        try {
          const liveEl = document.getElementById('xray-log-live');
          if (liveEl && liveEl.checked && typeof window.startXrayLogAuto === 'function') {
            safe(() => window.startXrayLogAuto());
          }
        } catch (e) {}
      });
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
      ensureFileManagerReady().then((ready) => {
        if (!ready) return;
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
	  // routing/mihomoPanel/mihomoImport are initialized lazily when their tabs are opened (see showView).
    safe(() => {
      if (hasXrayCore() && window.XKeen && XKeen.localIO && typeof XKeen.localIO.init === 'function') XKeen.localIO.init();
    });
    safe(() => {
      const hasRestartLogBlock =
        !!document.querySelector('[data-xk-restart-log="1"]') ||
        !!document.getElementById('restart-log');
      if (!hasRestartLogBlock) return;
      ensureLazyFeature('restartLog').catch((err) => {
        try { console.error('[XKeen] restart log feature failed:', err); } catch (e) {}
      });
    });
	  // xkeenTexts/commandsList are initialized lazily when their tabs are opened (see showView).
  }

  function init() {
    if (!isPanelPage()) return;

    // Initialize all modular features
    initModules();
    syncLightweightDonateButtonVisibility();

    // Tabs (replaces inline onclick="showView(...)")
    wireTabs();
    wireLazyFeatureClicks();
    startLightweightXkeenStatusPolling();
    startLightweightXrayBadgePolling();

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
    initCoreUiAutoDetect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
