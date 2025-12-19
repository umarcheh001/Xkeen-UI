(() => {
  "use strict";

  // -------------------------------------------------------------------
  // XKeen modularity conventions (base contract)
  // -------------------------------------------------------------------
  // 1) Single namespace:
  //    window.XKeen = window.XKeen || {}
  //    - XKeen.state : data/cache only (editors, flags, selected core, tab-id, ...)
  //    - XKeen.util  : pure helpers (no DOM)
  //    - XKeen.ui    : UI helpers (toast/modal/spinner/theme)
  //    - XKeen.<feature> (or XKeen.features.<feature>) : feature logic modules
  //
  // 2) Separation:
  //    - static/js/features/*.js  : logic + minimal DOM access via OWN ids
  //    - static/js/pages/*.init.js: wiring only (DOMContentLoaded + .init())
  //
  // 3) Temporary legacy proxies while migrating main.js:
  //    window.oldFn = (...args) => XKeen.newModule.fn(...args)
  //    Remove these proxies once all callers are migrated.
  // -------------------------------------------------------------------

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;

  XK.state = XK.state || {};
  XK.util = XK.util || {};
  XK.ui = XK.ui || {};

  // Optional container if you prefer XKeen.features.<name>
  XK.features = XK.features || {};
})();
