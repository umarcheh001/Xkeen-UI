(() => {
  "use strict";

  // Bootstrap: utilities and tiny polyfills that other modules may rely on.
  // IMPORTANT: keep this file DOM-free (belongs to XKeen.util).
  // Stage 5 final rule: do not publish feature bridges, migration proxies,
  // or window.* aliases from this bootstrap layer.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.util = XK.util || {};
})();
