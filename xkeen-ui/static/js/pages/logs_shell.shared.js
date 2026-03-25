// Build-managed shell for Xray logs UX.
//
// Goal of commit 44: panel logs should no longer depend on ad-hoc legacy script
// injection. The legacy feature implementation remains intact, but the page now
// loads and orchestrates it through a single build-managed contract.

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.pages = XK.pages || {};

  let _featurePromise = null;

  function safe(fn) {
    try { return fn(); } catch (e) {
      try { console.error(e); } catch (e2) {}
      return undefined;
    }
  }

  function getFeatureApi() {
    try {
      const api = XK.features ? XK.features.xrayLogs : null;
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
      .then(() => getFeatureApi())
      .catch((error) => {
        try { console.error('[XKeen] panel logs shell failed to load xray logs feature', error); } catch (e) {}
        throw error;
      })
      .finally(() => {
        if (!getFeatureApi()) _featurePromise = null;
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

  XK.pages.logsShell = {
    isReady,
    ensureReady,
    activateView,
    deactivateView,
    refreshStatus,
  };
})();
