(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.util = XKeen.util || {};

  // Per-tab identity helper.
  // Motivation:
  // - sessionStorage is usually per-tab, but many browsers clone its contents when a tab
  //   is duplicated. If we store PTY session_id under a fixed key, two tabs may end up
  //   fighting for the same backend PTY session.
  // - window.name is empty in a newly created tab and survives reloads within the same tab.
  //   We use it as a stable per-tab id and namespace PTY keys.
  if (!XKeen.util.getTabId) {
    XKeen.util.getTabId = function getTabId() {
      const PREFIX = 'xkeen_tab_id_v1:';

      function gen() {
        try {
          if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return PREFIX + window.crypto.randomUUID();
          }
        } catch (e) {}
        // Fallback for older browsers
        return PREFIX + (String(Math.random()).slice(2) + '-' + String(Date.now()));
      }

      try {
        const cur = String(window.name || '');
        if (cur && cur.startsWith(PREFIX)) return cur;
        const id = gen();
        window.name = id;
        return id;
      } catch (e) {
        // As a last resort, return a non-persistent id.
        return gen();
      }
    };
  }
})();
