// Build-managed lazy bundle for terminal runtime.
// Keeps the original side-effect ordering, but moves loading to standard import().
//
// NOTE:
// xterm.js vendor bundles in /static/xterm are legacy UMD browser scripts.
// Some addons (notably unicode11 / serialize) rely on classic-script globals
// such as top-level `this === window`. Importing them as ESM breaks that
// contract and causes errors like:
//   Cannot set properties of undefined (setting 'Unicode11Addon')
// Therefore we load vendor xterm files via classic <script> tags, then import
// only our own application modules through ESM.

const XTERM_SCRIPT_IMPORTS = [
  '../../xterm/xterm.js',
  '../../xterm/xterm-addon-fit.js',
  '../../xterm/xterm-addon-search.js',
  '../../xterm/xterm-addon-web-links.js',
  '../../xterm/xterm-addon-webgl.js',
  '../../xterm/xterm-addon-unicode11.js',
  '../../xterm/xterm-addon-serialize.js',
  '../../xterm/xterm-addon-clipboard.js',
  '../../xterm/xterm-addon-ligatures.js',
];

const TERMINAL_IMPORTS = [
  '../terminal/_core.js',
  '../terminal/core/events.js',
  '../terminal/core/logger.js',
  '../terminal/core/config.js',
  '../terminal/core/ui.js',
  '../terminal/core/api.js',
  '../terminal/transport/pty_transport.js',
  '../terminal/transport/lite_transport.js',
  '../terminal/transport/index.js',
  '../terminal/core/state.js',
  '../terminal/core/registry.js',
  '../terminal/commands/registry.js',
  '../terminal/commands/router.js',
  '../terminal/commands/builtins/xkeen_restart.js',
  '../terminal/commands/builtins/sysmon.js',
  '../terminal/core/session_controller.js',
  '../terminal/core/context.js',
  '../terminal/core/public_api.js',
  '../terminal/core/output_controller.js',
  '../terminal/core/input_controller.js',
  '../terminal/capabilities.js',
  '../terminal/pty.js',
  '../terminal/core/xterm_manager.js',
  '../terminal/lite_runner.js',
  '../terminal/search.js',
  '../terminal/history.js',
  '../terminal/quick_commands.js',
  '../terminal/chrome.js',
  '../terminal/modules/overlay_controller.js',
  '../terminal/modules/status_controller.js',
  '../terminal/modules/terminal_controller.js',
  '../terminal/modules/ui_controller.js',
  '../terminal/modules/buffer_actions.js',
  '../terminal/modules/ssh_profiles.js',
  '../terminal/modules/reconnect_controller.js',
  '../terminal/modules/output_prefs.js',
  '../terminal/modules/confirm_prompt.js',
  '../terminal/xray_tail.js',
  '../terminal/terminal.js',
];

let terminalBundlePromise = null;
const classicScriptCache = new Map();

function resolveClassicScriptUrl(specifier) {
  return new URL(specifier, import.meta.url).toString();
}

function buildSourceUrlComment(url) {
  return '\n//# sourceURL=' + String(url || '').replace(/\s/g, '%20');
}

function withShadowedGlobals(names, fn) {
  const globalScope = window;
  const restore = [];
  const list = Array.isArray(names) ? names : [];

  try {
    for (const name of list) {
      const key = String(name || '').trim();
      if (!key) continue;
      const hadOwn = Object.prototype.hasOwnProperty.call(globalScope, key);
      restore.push({ key, hadOwn, value: globalScope[key] });
      globalScope[key] = undefined;
    }
    return fn();
  } finally {
    for (let i = restore.length - 1; i >= 0; i -= 1) {
      const entry = restore[i];
      try {
        if (entry.hadOwn) globalScope[entry.key] = entry.value;
        else delete globalScope[entry.key];
      } catch (error) {
        globalScope[entry.key] = entry.value;
      }
    }
  }
}

async function fetchClassicScriptSource(url) {
  try {
    const response = await fetch(String(url || ''), { cache: 'force-cache' });
    if (!response || !response.ok) return '';
    return await response.text();
  } catch (error) {
    return '';
  }
}

function evalClassicScript(url, code) {
  if (!code) return false;

  try {
    return withShadowedGlobals(['define', 'require', 'module', 'exports'], () => {
      const globalEval = (0, eval);
      globalEval(String(code) + buildSourceUrlComment(url));
      return true;
    });
  } catch (error) {
    return false;
  }
}

function loadClassicScriptOnce(specifier) {
  const url = resolveClassicScriptUrl(specifier);
  if (classicScriptCache.has(url)) return classicScriptCache.get(url);

  const promise = (async () => {
    const code = await fetchClassicScriptSource(url);
    if (!code) throw new Error('failed to fetch classic script: ' + url);
    const ok = evalClassicScript(url, code);
    if (!ok) throw new Error('failed to evaluate classic script: ' + url);
    return true;
  })().catch((error) => {
    classicScriptCache.delete(url);
    throw error;
  });

  classicScriptCache.set(url, promise);
  return promise;
}

export async function ensureTerminalBundleReady() {
  if (terminalBundlePromise) return terminalBundlePromise;

  terminalBundlePromise = (async () => {
    for (const specifier of XTERM_SCRIPT_IMPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await loadClassicScriptOnce(specifier);
    }
    for (const specifier of TERMINAL_IMPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await import(specifier);
    }
    return true;
  })().catch((error) => {
    terminalBundlePromise = null;
    throw error;
  });

  return terminalBundlePromise;
}

export { TERMINAL_IMPORTS, XTERM_SCRIPT_IMPORTS };
