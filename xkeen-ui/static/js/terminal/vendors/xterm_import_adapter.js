import {
  appendTerminalDebug,
  markTerminalDebugState,
} from '../../features/terminal_debug.js';

export const REQUIRED_XTERM_VENDOR_SPECS = [
  '../../../xterm/xterm.js',
  '../../../xterm/xterm-addon-fit.js',
  '../../../xterm/xterm-addon-serialize.js',
];

export const OPTIONAL_XTERM_VENDOR_SPECS = [];

const vendorImportCache = new Map();

function getGlobalScope() {
  try { return globalThis; } catch (error) {}
  try { return window; } catch (error) {}
  try { return self; } catch (error) {}
  return null;
}

function stashAmdGlobals(scope) {
  const names = ['define', 'require', 'requirejs'];
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

async function importClassicVendorOnce(specifier, required = true) {
  const url = resolveVendorUrl(specifier);
  if (vendorImportCache.has(url)) return vendorImportCache.get(url);

  const promise = (async () => {
    appendTerminalDebug('lazy:vendor:begin', { url, required, loader: 'dynamic-import' });
    markTerminalDebugState({
      status: 'loading-vendor',
      lastStage: 'lazy:vendor:begin',
      currentUrl: url,
      loader: 'dynamic-import',
    });

    const scope = getGlobalScope();
    let amdStash = null;
    try {
      if (scope) {
        appendTerminalDebug('lazy:vendor:amd-shield', { url, active: true });
        amdStash = stashAmdGlobals(scope);
      }
      await import(/* @vite-ignore */ url);
      appendTerminalDebug('lazy:vendor:done', { url, loader: 'dynamic-import' });
      return true;
    } catch (error) {
      appendTerminalDebug('lazy:vendor:error', {
        url,
        required,
        loader: 'dynamic-import',
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
