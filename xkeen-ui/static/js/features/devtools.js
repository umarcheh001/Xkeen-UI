import { getDevtoolsNamespace, getDevtoolsSharedApi, setDevtoolsNamespaceApi } from './devtools_namespace.js';

let devtoolsModuleApi = null;
let devtoolsInitialized = false;

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const DT = getDevtoolsNamespace();

  const SH = getDevtoolsSharedApi() || {};
  const _moduleInitState = Object.create(null);
  const _moduleInitTimers = Object.create(null);

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

  function _initModuleOnce(stateKey, namespaceKey, initArg) {
    if (_moduleInitState[stateKey]) return true;

    const featureApi = DT && DT[namespaceKey];
    if (!featureApi || typeof featureApi.init !== 'function') return false;

    _moduleInitState[stateKey] = true;
    try {
      featureApi.init(initArg);
      return true;
    } catch (error) {
      _moduleInitState[stateKey] = false;
      throw error;
    }
  }

  function _scheduleModuleInit(stateKey, namespaceKey, initArg, delay = 0) {
    if (_moduleInitState[stateKey]) return;
    if (_moduleInitTimers[stateKey]) return;

    _moduleInitTimers[stateKey] = window.setTimeout(() => {
      _moduleInitTimers[stateKey] = null;
      try {
        if (document.visibilityState === 'hidden') return;
      } catch (e) {}
      try { _initModuleOnce(stateKey, namespaceKey, initArg); } catch (e) {}
    }, Math.max(0, Number(delay || 0)));
  }

  function _wireDeferredModuleInit(stateKey, namespaceKey, targetId, initArg, opts) {
    const cfg = opts && typeof opts === 'object' ? opts : {};
    const target = document.getElementById(targetId);
    if (!target) {
      if (typeof cfg.idleDelay === 'number') _scheduleModuleInit(stateKey, namespaceKey, initArg, cfg.idleDelay);
      return;
    }

    const activate = () => {
      try { _initModuleOnce(stateKey, namespaceKey, initArg); } catch (e) {}
      cleanup();
    };

    const onToggle = () => {
      try {
        if (typeof target.open === 'boolean' && !target.open) return;
      } catch (e) {}
      activate();
    };

    const onFocusIn = () => activate();
    const onPointerDown = () => activate();
    const onMouseEnter = () => activate();

    function cleanup() {
      try { target.removeEventListener('toggle', onToggle); } catch (e) {}
      try { target.removeEventListener('focusin', onFocusIn, true); } catch (e) {}
      try { target.removeEventListener('pointerdown', onPointerDown, true); } catch (e) {}
      try { target.removeEventListener('mouseenter', onMouseEnter); } catch (e) {}
    }

    try { target.addEventListener('toggle', onToggle); } catch (e) {}
    try { target.addEventListener('focusin', onFocusIn, true); } catch (e) {}
    try { target.addEventListener('pointerdown', onPointerDown, true); } catch (e) {}
    try { target.addEventListener('mouseenter', onMouseEnter, { once: true }); } catch (e) {}

    try {
      const hash = String(window.location.hash || '').trim();
      if (cfg.hash && hash === String(cfg.hash)) {
        activate();
        return;
      }
    } catch (e) {}

    if (typeof cfg.idleDelay === 'number') _scheduleModuleInit(stateKey, namespaceKey, initArg, cfg.idleDelay);
  }

  function init() {
    if (devtoolsInitialized) return;
    devtoolsInitialized = true;

    // Collapsible cards (Logging / Interface / Theme / etc.)
    try { _wireCollapsibles(); } catch (e) {}

    // Core host modules: keep the shell responsive, but defer heavy sections/fetches.
    try { _initModuleOnce('service', 'devtoolsService'); } catch (e) {}
    try { _initModuleOnce('logs', 'devtoolsLogs', { deferInitialFetch: true }); } catch (e) {}

    try { _wireDeferredModuleInit('update', 'devtoolsUpdate', 'dt-update-card', undefined, { hash: '#dt-update-card', idleDelay: 700 }); } catch (e) {}
    try { _wireDeferredModuleInit('env', 'devtoolsEnv', 'dt-env-card', undefined, { idleDelay: 1200 }); } catch (e) {}
    try { _wireDeferredModuleInit('terminalTheme', 'devtoolsTerminalTheme', 'dt-terminal-theme-card', undefined, { hash: '#dt-terminal-theme-card', idleDelay: 1800 }); } catch (e) {}

    try { _scheduleModuleInit('theme', 'devtoolsTheme', undefined, 2000); } catch (e) {}
    try { _scheduleModuleInit('customCss', 'devtoolsCustomCss', undefined, 2200); } catch (e) {}
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
