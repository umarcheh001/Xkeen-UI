(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};

  function _wireCollapsibles() {
    try {
      if (SH && typeof SH.wireCollapsibleState === 'function') {
        SH.wireCollapsibleState({ selector: 'details.dt-collapsible[id]', storagePrefix: 'xk.devtools.collapse.' });
        return;
      }
    } catch (e) {}
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
    try { if (XK.features.devtoolsUpdate && typeof XK.features.devtoolsUpdate.init === 'function') XK.features.devtoolsUpdate.init(); } catch (e) {}
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
