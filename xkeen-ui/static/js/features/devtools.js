(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  function _wireCollapsibles() {
  // Make selected DevTools blocks collapsible and remember state in localStorage.
  const els = Array.from(document.querySelectorAll('details.dt-collapsible[id]'));
  if (!els.length) return;

  els.forEach((el) => {
    const id = String(el.id || '').trim();
    if (!id) return;
    const key = `xk.devtools.collapse.${id}.open`;
    try {
      const saved = localStorage.getItem(key);
      if (saved === '0') el.open = false;
      if (saved === '1') el.open = true;
    } catch (e) {}

    el.addEventListener('toggle', () => {
      try { localStorage.setItem(key, el.open ? '1' : '0'); } catch (e) {}
    });
  });
}

  function setActiveTab(tabName) {
    try {
      const logs = XK.features && XK.features.devtoolsLogs ? XK.features.devtoolsLogs : null;
      if (logs && typeof logs.setActiveTab === 'function') return logs.setActiveTab(tabName);
    } catch (e) {}
  }

  function init() {
    // Collapsible cards (Logging / Interface / Theme / etc.)
    try { _wireCollapsibles(); } catch (e) {}

    // Feature modules
    try { if (XK.features.devtoolsService && typeof XK.features.devtoolsService.init === 'function') XK.features.devtoolsService.init(); } catch (e) {}
    try { if (XK.features.devtoolsLogs && typeof XK.features.devtoolsLogs.init === 'function') XK.features.devtoolsLogs.init(); } catch (e) {}
    try { if (XK.features.devtoolsEnv && typeof XK.features.devtoolsEnv.init === 'function') XK.features.devtoolsEnv.init(); } catch (e) {}
    try { if (XK.features.devtoolsTheme && typeof XK.features.devtoolsTheme.init === 'function') XK.features.devtoolsTheme.init(); } catch (e) {}
    try { if (XK.features.devtoolsTerminalTheme && typeof XK.features.devtoolsTerminalTheme.init === 'function') XK.features.devtoolsTerminalTheme.init(); } catch (e) {}
    try { if (XK.features.devtoolsCodeMirrorTheme && typeof XK.features.devtoolsCodeMirrorTheme.init === 'function') XK.features.devtoolsCodeMirrorTheme.init(); } catch (e) {}
    try { if (XK.features.devtoolsCustomCss && typeof XK.features.devtoolsCustomCss.init === 'function') XK.features.devtoolsCustomCss.init(); } catch (e) {}
  }

  XK.features.devtools = XK.features.devtools || {};
  XK.features.devtools.init = init;
  XK.features.devtools.setActiveTab = setActiveTab;
})();
