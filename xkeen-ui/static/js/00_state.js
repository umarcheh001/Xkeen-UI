(() => {
  "use strict";

  // -------------------------------------------------------------------
  // XKeen bootstrap contract (Stage 5 final model)
  // -------------------------------------------------------------------
  // 1) window.XKeen remains the shared bootstrap/root namespace only.
  //    It may host:
  //    - XKeen.core / XKeen.state / XKeen.util / XKeen.ui / XKeen.runtime / XKeen.env
  //    - compat-only feature bridges that are attached explicitly from
  //      static/js/features/compat/* when a legacy runtime still requires them
  //
  // 2) Canonical feature APIs are ESM-first and module-local.
  //    - static/js/features/*.js export get*Api()/init*() wrappers
  //    - window.XKeen is not the source of truth for new feature-to-feature calls
  //
  // 3) static/js/pages/*.init.js and *.shared.js stay wiring/bootstrap only.
  //    They import canonical modules directly and opt into compat bridges
  //    only at the entrypoints where legacy globals are still required.
  //
  // 4) Do not add new window.* global aliases or migration proxy helpers here.
  //    Legacy bridges belong in features/compat/* and should be deleted once
  //    the remaining runtime consumers are migrated.
  // -------------------------------------------------------------------

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const XK = window.XKeen;

  XK.core = XK.core || {};
  XK.state = XK.state || {};
  XK.util = XK.util || {};
  XK.ui = XK.ui || {};

  // Compat-only container for explicit legacy feature bridges.
  XK.features = XK.features || {};
})();
