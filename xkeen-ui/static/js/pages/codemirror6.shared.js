// Build/source managed CM6 runtime bridge.
//
// Source-mode pages currently ship without the offline /static/vendor/npm/
// tree, and browsers do not allow adding a new import map after module
// loading has already started. Because this file itself runs as a module,
// dynamically inserting an import map here is too late and causes noisy
// browser errors. Until a page-level import map is emitted before the entry
// module, keep the CM6 bridge opt-in: only boot when such import map already
// exists.

const IMPORTMAP_SELECTOR = 'script[type="importmap"][data-xkeen-cm6-importmap="1"]';
const GLOBAL_KEY = '__XKEEN_CM6_RUNTIME__';

function getWindow() {
  if (typeof window !== 'undefined') return window;
  return null;
}

function ensureSkippedRuntime(reason) {
  const win = getWindow();
  if (!win) {
    return {
      ok: false,
      ready: false,
      reason: String(reason || 'cm6-unavailable'),
    };
  }

  win.XKeen = win.XKeen || {};
  win.XKeen.ui = win.XKeen.ui || {};

  const existing = win.XKeen.ui.cm6Runtime;
  if (existing && typeof existing === 'object' && typeof existing.ensure === 'function') {
    return existing;
  }

  const runtime = {
    backend: 'cm6-unavailable',
    contractVersion: 1,
    ready: false,
    reason: String(reason || 'cm6-unavailable'),
    isReady() {
      return false;
    },
    async ensure() {
      return {
        ok: false,
        ready: false,
        skipped: true,
        reason: runtime.reason,
      };
    },
  };

  win[GLOBAL_KEY] = runtime;
  win.XKeen.ui.cm6Runtime = runtime;
  return runtime;
}

function hasPreinstalledImportMap() {
  try {
    return !!document.querySelector(IMPORTMAP_SELECTOR);
  } catch (e) {
    return false;
  }
}

async function ensureCodeMirror6Runtime() {
  if (!hasPreinstalledImportMap()) {
    ensureSkippedRuntime('importmap-missing');
    return false;
  }

  try {
    await import('../ui/codemirror6_boot.js?v=20260401cm6fine2');
    return true;
  } catch (e) {
    ensureSkippedRuntime('runtime-load-failed');
    try { console.error('[xkeen] failed to load CM6 runtime bridge', e); } catch (e2) {}
    return false;
  }
}

await ensureCodeMirror6Runtime();
