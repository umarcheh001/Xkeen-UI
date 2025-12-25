// Terminal core: tiny logger
//
// Debug logging can be enabled via localStorage:
//   localStorage.setItem('xkeen_term_debug_v1', '1')
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  const DEBUG_KEY = 'xkeen_term_debug_v1';

  function isDebugEnabled() {
    try {
      const v = localStorage.getItem(DEBUG_KEY);
      return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    } catch (e) {}
    return false;
  }

  function createLogger(ns) {
    const prefix = '[' + String(ns || 'terminal') + ']';

    function fmt(args) {
      try { return [prefix].concat(Array.prototype.slice.call(args)); } catch (e) { return [prefix]; }
    }

    function debug() {
      if (!isDebugEnabled()) return;
      try { console.debug.apply(console, fmt(arguments)); } catch (e) {}
    }

    function info() {
      try { console.info.apply(console, fmt(arguments)); } catch (e) {}
    }

    function warn() {
      try { console.warn.apply(console, fmt(arguments)); } catch (e) {}
    }

    function error() {
      try { console.error.apply(console, fmt(arguments)); } catch (e) {}
    }

    return { debug, info, warn, error, enabled: isDebugEnabled };
  }

  window.XKeen.terminal.core.createLogger = createLogger;
})();
