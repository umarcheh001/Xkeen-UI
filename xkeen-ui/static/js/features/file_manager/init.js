import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  // Thin entrypoint for the File Manager feature.
  // All feature parts are attached under `the shared file manager namespace.*`
  // by their respective scripts loaded before this file.

  FM.initOnce = FM.initOnce || function initOnce() {
    if (!FM || typeof FM.init !== 'function') return false;
    safe(() => FM.init());
    return true;
  };

  // Initialize immediately on load (FM.init() keeps its own guard).
  FM.initOnce();
})();
