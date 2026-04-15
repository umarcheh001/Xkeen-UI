import {
  appendTerminalDebug,
  markTerminalDebugState,
} from '../../features/terminal_debug.js';

export const REQUIRED_XTERM_VENDOR_SPECS = [
  '../../../xterm/xterm.js',
  '../../../xterm/xterm-addon-fit.js',
];

export const OPTIONAL_XTERM_VENDOR_SPECS = [
  '../../../xterm/xterm-addon-search.js',
  '../../../xterm/xterm-addon-web-links.js',
  '../../../xterm/xterm-addon-unicode11.js',
  '../../../xterm/xterm-addon-clipboard.js',
  '../../../xterm/xterm-addon-serialize.js',
];

const THIS_BOUND_CLASSIC_VENDOR_SPECS = new Set([
  '../../../xterm/xterm-addon-unicode11.js',
  '../../../xterm/xterm-addon-serialize.js',
]);

const vendorImportCache = new Map();

function getGlobalScope() {
  try { return globalThis; } catch (error) {}
  try { return window; } catch (error) {}
  try { return self; } catch (error) {}
  return null;
}

function stashAmdGlobals(scope) {
  const names = ['define', 'require', 'requirejs', 'exports', 'module'];
  const stash = [];
  for (const name of names) {
    let existed = false;
    let value;
    try {
      existed = Object.prototype.hasOwnProperty.call(scope, name);
      value = scope[name];
    } catch (error) {}
    stash.push({ name, existed, value });
    try { scope[name] = undefined; } catch (error) {}
  }
  return stash;
}

function restoreAmdGlobals(scope, stash) {
  const items = Array.isArray(stash) ? stash : [];
  for (const item of items) {
    if (!item || !item.name) continue;
    try {
      if (item.existed) scope[item.name] = item.value;
      else delete scope[item.name];
    } catch (error) {
      try { scope[item.name] = item.value; } catch (nestedError) {}
    }
  }
}

function nextTick(delay = 0) {
  return new Promise((resolve) => {
    try { setTimeout(resolve, delay); } catch (error) { resolve(); }
  });
}

function resolveVendorUrl(specifier) {
  return new URL(specifier, import.meta.url).toString();
}

async function runClassicVendorWithGlobalThis(url, scope) {
  if (!scope) throw new Error('global scope is unavailable');
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable');

  const resp = await fetch(url, { cache: 'force-cache' });
  if (!resp || !resp.ok) {
    const status = resp ? String(resp.status || '') : '';
    throw new Error('vendor fetch failed' + (status ? ': ' + status : ''));
  }

  const source = await resp.text();
  const run = new Function('window', 'self', 'globalThis', String(source || '') + '\n//# sourceURL=' + url);
  run.call(scope, scope, scope, scope);
  return true;
}

async function importClassicVendorOnce(specifier, required = true) {
  const url = resolveVendorUrl(specifier);
  if (vendorImportCache.has(url)) return vendorImportCache.get(url);

  const promise = (async () => {
    const classicThis = THIS_BOUND_CLASSIC_VENDOR_SPECS.has(specifier);
    const loader = classicThis ? 'classic-global-this' : 'dynamic-import';
    appendTerminalDebug('lazy:vendor:begin', { url, required, loader });
    markTerminalDebugState({
      status: 'loading-vendor',
      lastStage: 'lazy:vendor:begin',
      currentUrl: url,
      loader,
    });

    const scope = getGlobalScope();
    let amdStash = null;
    try {
      if (scope) {
        appendTerminalDebug('lazy:vendor:amd-shield', { url, active: true });
        amdStash = stashAmdGlobals(scope);
      }
      if (classicThis) await runClassicVendorWithGlobalThis(url, scope);
      else await import(/* @vite-ignore */ url);
      appendTerminalDebug('lazy:vendor:done', { url, loader });
      return true;
    } catch (error) {
      appendTerminalDebug('lazy:vendor:error', {
        url,
        required,
        loader,
        error: error ? String(error.message || error) : 'load failed',
      });
      if (required) throw error;
      return false;
    } finally {
      if (scope && amdStash) {
        try { restoreAmdGlobals(scope, amdStash); } catch (error) {}
      }
    }
  })().catch((error) => {
    vendorImportCache.delete(url);
    if (required) throw error;
    return false;
  });

  vendorImportCache.set(url, promise);
  return promise;
}

export async function ensureXtermVendorReady() {
  for (const specifier of REQUIRED_XTERM_VENDOR_SPECS) {
    // eslint-disable-next-line no-await-in-loop
    await importClassicVendorOnce(specifier, true);
    // eslint-disable-next-line no-await-in-loop
    await nextTick(0);
  }

  for (const specifier of OPTIONAL_XTERM_VENDOR_SPECS) {
    // eslint-disable-next-line no-await-in-loop
    await importClassicVendorOnce(specifier, false);
    // eslint-disable-next-line no-await-in-loop
    await nextTick(0);
  }

  return true;
}
