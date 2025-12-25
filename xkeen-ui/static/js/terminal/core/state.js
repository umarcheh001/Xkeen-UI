// Terminal core: default state helpers for the modular context
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function defaultState() {
    return {
      // mirrored/derived values (the authoritative state remains in terminal/_core.js)
      mode: 'shell',
    };
  }

  // Stage 1: minimal reactive store on top of the (legacy) state object.
  //
  // Important: to preserve backward compatibility, the returned store IS the same object
  // (so legacy code can still do ctx.state.mode), but we also attach:
  //   - get(key, fallback)
  //   - set(key, value)
  //   - subscribe(key, fn)  -> unsubscribe
  //   - subscribeAll(fn)    -> unsubscribe
  //
  // It emits events (if provided):
  //   - state:changed  { key, value, prev }
  //   - state:<key>    { value, prev }
  function createStateStore(stateObj, events) {
    const s = stateObj || {};
    const subs = Object.create(null);
    const all = [];

    function emit(ev, payload) {
      try {
        if (events && typeof events.emit === 'function') events.emit(ev, payload);
      } catch (e) {}
    }

    function get(key, fallback) {
      const k = String(key || '');
      if (!k) return fallback;
      try {
        const v = s[k];
        return (v === undefined) ? fallback : v;
      } catch (e) {}
      return fallback;
    }

    function set(key, value) {
      const k = String(key || '');
      if (!k) return false;
      let prev;
      try { prev = s[k]; } catch (e) { prev = undefined; }
      try { s[k] = value; } catch (e2) { return false; }

      // Key subscribers
      const arr = subs[k];
      if (arr && arr.length) {
        arr.slice().forEach((fn) => {
          try { fn(value, prev, k); } catch (e) {}
        });
      }

      // Global subscribers
      if (all.length) {
        all.slice().forEach((fn) => {
          try { fn(k, value, prev); } catch (e) {}
        });
      }

      emit('state:changed', { key: k, value, prev });
      emit('state:' + k, { value, prev });
      return true;
    }

    function subscribe(key, fn) {
      const k = String(key || '');
      if (!k || typeof fn !== 'function') return () => {};
      (subs[k] = subs[k] || []).push(fn);
      return () => {
        const a = subs[k];
        if (!a) return;
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    }

    function subscribeAll(fn) {
      if (typeof fn !== 'function') return () => {};
      all.push(fn);
      return () => {
        const i = all.indexOf(fn);
        if (i >= 0) all.splice(i, 1);
      };
    }

    // Attach as non-enumerable to reduce noise when iterating keys.
    try {
      Object.defineProperty(s, 'get', { value: get, enumerable: false });
      Object.defineProperty(s, 'set', { value: set, enumerable: false });
      Object.defineProperty(s, 'subscribe', { value: subscribe, enumerable: false });
      Object.defineProperty(s, 'subscribeAll', { value: subscribeAll, enumerable: false });
    } catch (e) {
      // Fallback: assign directly
      s.get = get;
      s.set = set;
      s.subscribe = subscribe;
      s.subscribeAll = subscribeAll;
    }

    return s;
  }

  window.XKeen.terminal.core.defaultState = defaultState;
  window.XKeen.terminal.core.createStateStore = createStateStore;
})();
