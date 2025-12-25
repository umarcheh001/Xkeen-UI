// DEPRECATED / UNUSED (Stage 7+)
//
// This file used to implement the "Milestone A" output pipeline.
// Since Stage 7, output routing + rendering live in:
//   static/js/terminal/core/output_controller.js
//
// Kept only as a small stub so old references are obvious during refactor.
// It should NOT be used by new code.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  // No-op plugin wrapper (Registry-safe)
  function createModule() {
    try {
      if (console && console.warn) console.warn('[terminal] DEPRECATED: terminal/modules/output_pipeline.js is unused since Stage 7 (use core/output_controller.js)');
    } catch (e) {}
    return {
      id: 'output_pipeline_DEPRECATED',
      priority: -999,
      init: function () {},
      onOpen: function () {},
      onClose: function () {},
    };
  }

  window.XKeen.terminal.output_pipeline = { createModule: createModule };
})();
