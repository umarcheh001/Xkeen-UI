// Terminal module registry
//
// Provides a small plugin lifecycle system so terminal.js stays an orchestrator.
//
// Milestone C contract:
//   Each plugin is created with createModule(ctx) and can implement lifecycle hooks.
//   Hooks (all optional):
//     init(ctx)
//     onOpen(ctx)
//     onClose(ctx)
//     onModeChange(ctx, mode)
//     attachTerm(ctx, term)
//     detachTerm(ctx, term)
//
// Ordering:
//   Plugins are executed by ascending priority (default 100), then by registration order.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  function createRegistry(ctx) {
    const mods = [];
    let regSeq = 0;
    let sortedCache = null;

    function invalidate() { sortedCache = null; }

    function getSorted() {
      if (sortedCache) return sortedCache;
      sortedCache = mods.slice().sort((a, b) => {
        const ap = Number.isFinite(a.priority) ? a.priority : 100;
        const bp = Number.isFinite(b.priority) ? b.priority : 100;
        if (ap !== bp) return ap - bp;
        return a.seq - b.seq;
      });
      return sortedCache;
    }

    // register(...)
    //  - register('name', factoryOrModule, { priority })
    //  - register(factoryOrModule, { priority })
    //  - register(moduleObject, { priority })
    function register(nameOrModule, factoryOrModule, opts) {
      let name = null;
      let fm = null;
      let options = opts || null;

      if (typeof nameOrModule === 'string') {
        name = String(nameOrModule || '').trim();
        fm = factoryOrModule;
      } else {
        fm = nameOrModule;
        options = factoryOrModule || null;
        try {
          if (fm && typeof fm === 'object' && fm.id) name = String(fm.id || '').trim();
          else if (typeof fm === 'function' && fm.name) name = String(fm.name || '').trim();
        } catch (e) {}
      }

      const fallbackName = 'mod_' + String(mods.length + 1);
      const n = name || fallbackName;

      let mod = null;
      try {
        mod = (typeof fm === 'function') ? fm(ctx) : fm;
      } catch (e) {
        try { console.error('[terminal.registry] factory failed:', n, e); } catch (_) {}
        mod = null;
      }
      const m = mod || {};

      let pr = 100;
      try {
        if (options && options.priority != null) pr = Number(options.priority);
        else if (m && m.priority != null) pr = Number(m.priority);
      } catch (e) {}
      if (!Number.isFinite(pr)) pr = 100;

      mods.push({ id: (m && m.id) ? String(m.id) : n, name: n, priority: pr, seq: (regSeq++), mod: m });
      invalidate();
    }

    function callHook(hookName, ...args) {
      const list = getSorted();
      for (const it of list) {
        const mod = it.mod;
        const fn = mod && mod[hookName];
        if (typeof fn !== 'function') continue;
        try { fn(ctx, ...args); } catch (e) {
          try { console.error('[terminal.registry] hook error:', it.name, hookName, e); } catch (_) {}
        }
      }
    }

    function initAll() { callHook('init'); }
    function onOpen() { callHook('onOpen'); }
    function onClose() { callHook('onClose'); }
    function onModeChange(mode) { callHook('onModeChange', mode); }
    function attachTerm(term) { callHook('attachTerm', term); }
    function detachTerm(term) { callHook('detachTerm', term); }

    function list() {
      return getSorted().map((x) => ({ id: x.id, name: x.name, priority: x.priority }));
    }

    return { register, initAll, onOpen, onClose, onModeChange, attachTerm, detachTerm, list };
  }

  window.XKeen.terminal.core.createRegistry = createRegistry;
})();
