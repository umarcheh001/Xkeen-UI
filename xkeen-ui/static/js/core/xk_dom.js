(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.core = XK.core || {};
  const dom = (XK.core.dom = XK.core.dom || {});

  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function q(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function qa(sel, root) {
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e) { return []; }
  }

  function on(target, type, handler, opts) {
    if (!target || !type || !handler) return () => {};
    try {
      target.addEventListener(type, handler, opts);
      return () => {
        try { target.removeEventListener(type, handler, opts); } catch (e) {}
      };
    } catch (e) {
      return () => {};
    }
  }

  function once(target, type, handler, opts) {
    if (!target || !type || !handler) return () => {};
    const o = Object.assign({}, (opts || {}), { once: true });
    return on(target, type, handler, o);
  }

  // Export (do not overwrite if already present)
  dom.byId = dom.byId || byId;
  dom.q = dom.q || q;
  dom.qa = dom.qa || qa;
  dom.on = dom.on || on;
  dom.once = dom.once || once;
})();
