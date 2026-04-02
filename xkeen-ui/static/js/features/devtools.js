import { getDevtoolsNamespace, getDevtoolsSharedApi, setDevtoolsNamespaceApi } from './devtools_namespace.js';

let devtoolsModuleApi = null;

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const DT = getDevtoolsNamespace();

  const SH = getDevtoolsSharedApi() || {};

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
      const logs = DT.devtoolsLogs || null;
      if (logs && typeof logs.setActiveTab === 'function') return logs.setActiveTab(tabName);
    } catch (e) {}
    return null;
  }

  function init() {
    // Collapsible cards (Logging / Interface / Theme / etc.)
    try { _wireCollapsibles(); } catch (e) {}

    // Feature modules
    try { if (DT.devtoolsService && typeof DT.devtoolsService.init === 'function') DT.devtoolsService.init(); } catch (e) {}
    try { if (DT.devtoolsLogs && typeof DT.devtoolsLogs.init === 'function') DT.devtoolsLogs.init(); } catch (e) {}
    try { if (DT.devtoolsUpdate && typeof DT.devtoolsUpdate.init === 'function') DT.devtoolsUpdate.init(); } catch (e) {}
    try { if (DT.devtoolsEnv && typeof DT.devtoolsEnv.init === 'function') DT.devtoolsEnv.init(); } catch (e) {}
    try { if (DT.devtoolsTheme && typeof DT.devtoolsTheme.init === 'function') DT.devtoolsTheme.init(); } catch (e) {}
    try { if (DT.devtoolsTerminalTheme && typeof DT.devtoolsTerminalTheme.init === 'function') DT.devtoolsTerminalTheme.init(); } catch (e) {}
    try { if (DT.devtoolsCodeMirrorTheme && typeof DT.devtoolsCodeMirrorTheme.init === 'function') DT.devtoolsCodeMirrorTheme.init(); } catch (e) {}
    try { if (DT.devtoolsCustomCss && typeof DT.devtoolsCustomCss.init === 'function') DT.devtoolsCustomCss.init(); } catch (e) {}
  }

  devtoolsModuleApi = {
    init,
    setActiveTab,
  };
  setDevtoolsNamespaceApi('devtools', devtoolsModuleApi);
})();

export function getDevtoolsApi() {
  try {
    if (devtoolsModuleApi && typeof devtoolsModuleApi.init === 'function') return devtoolsModuleApi;
  } catch (error) {
    return null;
  }
  return null;
}

export function initDevtools(...args) {
  const api = getDevtoolsApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export function setActiveDevtoolsTab(...args) {
  const api = getDevtoolsApi();
  if (!api || typeof api.setActiveTab !== 'function') return null;
  return api.setActiveTab(...args);
}
export const devtoolsApi = Object.freeze({
  get: getDevtoolsApi,
  init: initDevtools,
  setActiveTab: setActiveDevtoolsTab,
});
