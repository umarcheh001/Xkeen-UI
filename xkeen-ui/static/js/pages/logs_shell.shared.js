// Build-managed shell for Xray logs UX.
//
// Goal of commit 44: panel logs should no longer depend on ad-hoc legacy script
// injection. The legacy feature implementation remains intact, but the page now
// loads and orchestrates it through a single build-managed contract.

import {
  getXkeenPageApi,
  publishXkeenPageApi,
} from '../features/xkeen_runtime.js';

(() => {
  'use strict';

  let _featurePromise = null;
  let _featureModule = null;

  function safe(fn) {
    try { return fn(); } catch (e) {
      try { console.error(e); } catch (e2) {}
      return undefined;
    }
  }

  function getFeatureApi() {
    try {
      const api = _featureModule && typeof _featureModule.getXrayLogsApi === 'function'
        ? _featureModule.getXrayLogsApi()
        : null;
      return api && typeof api.init === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function isReady() {
    return !!getFeatureApi();
  }

  async function ensureReady() {
    const readyApi = getFeatureApi();
    if (readyApi) return readyApi;
    if (_featurePromise) return _featurePromise;

    _featurePromise = import('../features/xray_logs.js')
      .then((mod) => {
        _featureModule = mod || null;
        return getFeatureApi();
      })
      .catch((error) => {
        try { console.error('[XKeen] panel logs shell failed to load xray logs feature', error); } catch (e) {}
        throw error;
      })
      .finally(() => {
        if (!getFeatureApi()) {
          _featurePromise = null;
          _featureModule = null;
        }
      });

    return _featurePromise;
  }

  function getLogsSection() {
    try { return document.getElementById('view-xray-logs'); } catch (e) {}
    return null;
  }

  function isLogsSectionVisible() {
    const section = getLogsSection();
    if (!section) return false;
    try {
      return section.style.display !== 'none';
    } catch (e) {
      return true;
    }
  }

  function isLiveWanted() {
    try {
      const input = document.getElementById('xray-log-live');
      return !!(input && input.checked);
    } catch (e) {
      return false;
    }
  }

  async function activateView(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const api = await ensureReady().catch(() => null);
    if (!api) return false;
    if (!opts.force && !isLogsSectionVisible()) return true;

    safe(() => {
      if (typeof api.viewOnce === 'function') api.viewOnce();
    });
    safe(() => {
      if (typeof api.refreshStatus === 'function') api.refreshStatus();
    });
    if (isLiveWanted()) {
      safe(() => {
        if (typeof api.start === 'function') api.start();
      });
    }
    return true;
  }

  function deactivateView() {
    const api = getFeatureApi();
    if (!api) return false;
    safe(() => {
      if (typeof api.stop === 'function') api.stop();
    });
    return true;
  }

  function refreshStatus() {
    const api = getFeatureApi();
    if (api && typeof api.refreshStatus === 'function') {
      safe(() => api.refreshStatus());
      return true;
    }
    return false;
  }

  publishXkeenPageApi('logsShell', {
    isReady,
    ensureReady,
    activateView,
    deactivateView,
    refreshStatus,
  });
})();


export function getLogsShellApi() {
  try {
    const api = getXkeenPageApi('logsShell');
    return api && typeof api.ensureReady === 'function' ? api : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function callLogsShellApi(method, ...args) {
  const api = getLogsShellApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function ensureLogsShellReady(...args) {
  return callLogsShellApi('ensureReady', ...args);
}

export function activateLogsShellView(...args) {
  return callLogsShellApi('activateView', ...args);
}

export function deactivateLogsShellView(...args) {
  return callLogsShellApi('deactivateView', ...args);
}

export function refreshLogsShellStatus(...args) {
  return callLogsShellApi('refreshStatus', ...args);
}

export const logsShellApi = Object.freeze({
  get: getLogsShellApi,
  ensureReady: ensureLogsShellReady,
  activateView: activateLogsShellView,
  deactivateView: deactivateLogsShellView,
  refreshStatus: refreshLogsShellStatus,
});
