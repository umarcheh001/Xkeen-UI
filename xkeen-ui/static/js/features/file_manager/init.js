(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  // Thin entrypoint for the File Manager feature.
  // All feature parts are attached under `window.XKeen.features.fileManager.*`
  // by their respective scripts loaded before this file.

  FM.initOnce = FM.initOnce || function initOnce() {
    if (!FM || typeof FM.init !== 'function') return false;
    safe(() => FM.init());
    return true;
  };

  // Initialize immediately on load (FM.init() keeps its own guard).
  FM.initOnce();
})();
