// Terminal core: tiny event bus
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function createEventBus() {
    const handlers = Object.create(null);

    function on(event, fn) {
      const e = String(event || '');
      if (!e || typeof fn !== 'function') return () => {};
      (handlers[e] = handlers[e] || []).push(fn);
      return () => off(e, fn);
    }

    function off(event, fn) {
      const e = String(event || '');
      const arr = handlers[e];
      if (!arr || !arr.length) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }

    function emit(event, payload) {
      const e = String(event || '');
      const arr = handlers[e];
      if (!arr || !arr.length) return;
      // copy to avoid re-entrancy issues
      arr.slice().forEach((fn) => {
        try { fn(payload); } catch (err) { /* swallow */ }
      });
    }

    return { on, off, emit };
  }

  window.XKeen.terminal.core.createEventBus = createEventBus;
})();
