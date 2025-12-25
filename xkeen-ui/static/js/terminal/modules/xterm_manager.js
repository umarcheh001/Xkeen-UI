// DEPRECATED / UNUSED (Stage 7+)
//
// This legacy XTerm manager module is not loaded anymore (panel.html uses the core version):
//   static/js/terminal/core/xterm_manager.js
//
// Kept only as a small stub so old references are obvious during refactor.
// It should NOT be used by new code.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  // If core implementation exists, re-export it for accidental loaders.
  try {
    if (window.XKeen.terminal.core && window.XKeen.terminal.core.xterm_manager) {
      window.XKeen.terminal.xterm_manager = window.XKeen.terminal.core.xterm_manager;
      return;
    }
  } catch (e) {}

  // Otherwise export a Registry-safe no-op stub.
  function createModule() {
    try {
      if (console && console.warn) console.warn('[terminal] DEPRECATED: terminal/modules/xterm_manager.js is unused since Stage 7 (use core/xterm_manager.js)');
    } catch (e) {}
    return {
      id: 'xterm_manager_DEPRECATED',
      priority: -999,
      init: function () {},
      onOpen: function () {},
      onClose: function () {},
    };
  }

  window.XKeen.terminal.xterm_manager = { createModule: createModule };
})();
