// Environment-driven section visibility (whitelist).
//
// Two env vars are supported (read at UI start):
//   - XKEEN_UI_PANEL_SECTIONS_WHITELIST
//   - XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST
//
// Templates expose them via:
//   window.XKeen.env.panelSectionsWhitelist
//   window.XKeen.env.devtoolsSectionsWhitelist
//
// Elements opt-in by having `data-xk-section`. It can contain multiple tokens
// separated by spaces (any match allows the element).

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  function parseWhitelist(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw)) raw = raw.join(',');
    const s = String(raw || '').trim();
    if (!s) return null;

    const low = s.toLowerCase();
    if (low === '*' || low === 'all' || low === 'any') return null;

    const parts = s.split(/[\s,;]+/).map((p) => String(p || '').trim()).filter(Boolean);
    const set = new Set();
    parts.forEach((p) => {
      const t = p.toLowerCase();
      if (!t) return;
      if (t === '*' || t === 'all' || t === 'any') return;
      set.add(t);
    });
    return set.size ? set : null;
  }

  function isAllowed(tokenString, allowSet) {
    if (!allowSet) return true;
    const raw = String(tokenString || '').trim();
    if (!raw) return false;
    const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    for (const t of tokens) {
      if (allowSet.has(String(t).toLowerCase())) return true;
    }
    return false;
  }

  function forceHide(el) {
    if (!el) return;
    try {
      el.style.display = 'none';
      if (el.dataset) el.dataset.xkForceHidden = '1';
    } catch (e) {}
  }

  function applyWhitelistToElements(allowSet, root) {
    if (!allowSet) return;
    const scope = root || document;
    const els = Array.from(scope.querySelectorAll('[data-xk-section]'));
    els.forEach((el) => {
      const tokens = el.dataset ? el.dataset.xkSection : '';
      if (!isAllowed(tokens, allowSet)) {
        forceHide(el);
      }
    });
  }

  function applyPanelWhitelist(allowSet) {
    if (!allowSet) return;

    // Tabs (including non-view buttons like Donate/Generator).
    const tabs = Array.from(document.querySelectorAll('.top-tabs.header-tabs .top-tab-btn'));
    tabs.forEach((btn) => {
      const tokens = btn.dataset ? (btn.dataset.xkSection || '') : '';
      if (tokens && !isAllowed(tokens, allowSet)) {
        forceHide(btn);
      }
    });

    // Views.
    const views = Array.from(document.querySelectorAll('.view-section[data-xk-section]'));
    views.forEach((v) => {
      const tokens = v.dataset ? (v.dataset.xkSection || '') : '';
      if (tokens && !isAllowed(tokens, allowSet)) {
        forceHide(v);
      }
    });

    // If the active view got hidden, jump to the first visible view-tab.
    try {
      const active = document.querySelector('.top-tabs.header-tabs .top-tab-btn.active[data-view]');
      const activeHidden = active && (active.style.display === 'none' || (active.dataset && active.dataset.xkForceHidden === '1'));
      if (activeHidden) {
        const first = tabs.find((b) => {
          if (!b) return false;
          const isView = !!(b.dataset && b.dataset.view);
          if (!isView) return false;
          const hidden = (b.style.display === 'none') || (b.dataset && b.dataset.xkForceHidden === '1');
          return !hidden;
        });
        if (first && first.dataset && first.dataset.view) {
          if (typeof window.showView === 'function') window.showView(first.dataset.view);
          else if (XK.ui && XK.ui.tabs && typeof XK.ui.tabs.show === 'function') XK.ui.tabs.show(first.dataset.view);
        }
      }
    } catch (e) {}
  }

  function applyDevtoolsWhitelist(allowSet) {
    if (!allowSet) return;

    // Hide whitelisted blocks.
    applyWhitelistToElements(allowSet, document);

    // Tabs: pick the first visible tab if current is hidden.
    try {
      const btnTools = document.getElementById('dt-tab-btn-tools');
      const btnLogs = document.getElementById('dt-tab-btn-logs');
      const toolsHidden = btnTools && (btnTools.style.display === 'none' || (btnTools.dataset && btnTools.dataset.xkForceHidden === '1'));
      const logsHidden = btnLogs && (btnLogs.style.display === 'none' || (btnLogs.dataset && btnLogs.dataset.xkForceHidden === '1'));

      const want = (!toolsHidden) ? 'tools' : ((!logsHidden) ? 'logs' : null);
      if (!want) return;

      if (XK.features && XK.features.devtools && typeof XK.features.devtools.setActiveTab === 'function') {
        XK.features.devtools.setActiveTab(want);
      } else {
        // Best effort: click.
        const btn = (want === 'logs') ? btnLogs : btnTools;
        if (btn) btn.click();
      }
    } catch (e) {}
  }

  function init() {
    const env = (XK && XK.env) ? XK.env : {};
    const panelSet = parseWhitelist(env.panelSectionsWhitelist);
    const devSet = parseWhitelist(env.devtoolsSectionsWhitelist);

    // Apply on DOM ready.
    document.addEventListener('DOMContentLoaded', () => {
      try {
        const isDevtools = !!document.querySelector('.dt-container') || !!document.getElementById('dt-tab-tools');
        if (isDevtools) {
          applyDevtoolsWhitelist(devSet);
          return;
        }
        const isPanel = !!document.querySelector('.top-tabs.header-tabs') || !!document.getElementById('view-routing');
        if (isPanel) {
          applyPanelWhitelist(panelSet);
        }
      } catch (e) {}
    });
  }

  XK.ui.sections = XK.ui.sections || {
    parseWhitelist,
    isAllowed,
    applyPanelWhitelist,
    applyDevtoolsWhitelist,
  };

  try { init(); } catch (e) {}
})();
