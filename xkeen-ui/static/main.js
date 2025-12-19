// -----------------------------------------------------------------------------
// main.js (compat)
// -----------------------------------------------------------------------------
// Intentionally minimal.
//
// The UI was refactored into modules under `static/js/**`.
// Some features (GitHub import/local import, older templates, or external tools)
// still expect legacy global functions like `loadRouting()`.
//
// This file provides:
//   1) Legacy global function aliases -> module methods.
//
// Page initialization is handled by `static/js/pages/*.init.js`.

(() => {
  'use strict';

  // Ensure namespace exists (created earlier by js/00_state.js, but keep safe).
  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.compat = XKeen.compat || {};

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      // Keep compat silent-ish; log for debugging.
      try { console.error(e); } catch (_) {}
      return undefined;
    }
  }

  function byId(id) {
    try {
      return document.getElementById(id);
    } catch (e) {
      return null;
    }
  }

  function linkLegacyFn(name, getter) {
    // Do not override if something already defined (helps with incremental migration).
    if (typeof window[name] === 'function') return;

    window[name] = function legacyWrapper(...args) {
      const fn = safe(getter);
      if (typeof fn !== 'function') {
        // Keep behavior predictable: return a resolved promise for async legacy calls.
        return Promise.resolve(undefined);
      }
      return fn.apply(null, args);
    };
  }

  // ---------------------------------------------------------------------------
  // Legacy aliases for feature loaders (used by GitHub import + local import)
  // ---------------------------------------------------------------------------

  // Routing
  linkLegacyFn('loadRouting', () => XKeen.routing && XKeen.routing.load);
  linkLegacyFn('saveRouting', () => XKeen.routing && XKeen.routing.save);
  linkLegacyFn('backupRouting', () => XKeen.routing && XKeen.routing.backup);

  // Inbounds
  linkLegacyFn('loadInbounds', () => XKeen.features && XKeen.features.inbounds && XKeen.features.inbounds.load);
  // Historical name used by github.js
  linkLegacyFn('loadInboundsMode', () => XKeen.features && XKeen.features.inbounds && XKeen.features.inbounds.load);
  linkLegacyFn('saveInbounds', () => XKeen.features && XKeen.features.inbounds && XKeen.features.inbounds.save);
  linkLegacyFn('backupInbounds', () => XKeen.features && XKeen.features.inbounds && XKeen.features.inbounds.backup);

  // Outbounds
  linkLegacyFn('loadOutbounds', () => XKeen.features && XKeen.features.outbounds && XKeen.features.outbounds.load);
  linkLegacyFn('saveOutbounds', () => XKeen.features && XKeen.features.outbounds && XKeen.features.outbounds.save);
  linkLegacyFn('backupOutbounds', () => XKeen.features && XKeen.features.outbounds && XKeen.features.outbounds.backup);

  // XKeen lists (port_proxying.lst, port_exclude.lst, ip_exclude.lst)
  // Historical names used by github.js.
  linkLegacyFn('loadPortProxying', () => XKeen.features && XKeen.features.xkeenTexts && XKeen.features.xkeenTexts.reloadPortProxying);
  linkLegacyFn('loadPortExclude', () => XKeen.features && XKeen.features.xkeenTexts && XKeen.features.xkeenTexts.reloadPortExclude);
  linkLegacyFn('loadIpExclude', () => XKeen.features && XKeen.features.xkeenTexts && XKeen.features.xkeenTexts.reloadIpExclude);

  // Restart log (older code sometimes calls this after restart/import)
  linkLegacyFn('loadRestartLog', () => XKeen.features && XKeen.features.restartLog && XKeen.features.restartLog.load);

  // Intentionally no auto-init here.
})();
