// Build-managed config shell bootstrap.
//
// Goal of commit 45: move config shell orchestration to the shared/build layer
// incrementally. Routing was moved first; inbounds/outbounds now enter the page
// through the same page-level config shell contract instead of relying on
// legacy lazy-runtime script injection.

import '../ui/config_dirty_state.js';
import '../ui/config_shell.js';
import { getRoutingShellApi as getRoutingShellModuleApi } from '../features/routing_shell.js';
import {
  getXkeenPageApi,
  getXkeenUiConfigShellApi,
  publishXkeenPageApi,
} from '../features/xkeen_runtime.js';

(() => {
  'use strict';

  const FEATURE_META = {
    routing: {
      label: 'Routing',
      fileCodeId: 'routing-file-code',
      dirtySourceName: 'editor',
      fragmentSelectId: 'routing-fragment-select',
      load: () => import('../features/routing.js'),
      isVisible: () => true,
      onActivate: (api, options) => {
        try { api.init(); } catch (e) {
          try { console.error('[XKeen] routing config shell init failed', e); } catch (e2) {}
          return false;
        }
        try { syncFeatureTab('routing', 'routing-view-init'); } catch (e3) {}
        if (typeof api.onShow === 'function') {
          try {
            api.onShow({ reason: String((options && options.reason) || 'config-shell') });
          } catch (e4) {}
        }
        return true;
      },
    },
    inbounds: {
      label: 'Inbounds',
      fileCodeId: 'inbounds-file-code',
      dirtySourceName: 'mode',
      fragmentSelectId: 'inbounds-fragment-select',
      load: () => Promise.all([
        import('../features/inbounds.js'),
        import('../features/compat/inbounds.js'),
      ]).then(([mod]) => mod),
      isVisible: () => true,
      onActivate: (api) => {
        try { api.init(); } catch (e) {
          try { console.error('[XKeen] inbounds config shell init failed', e); } catch (e2) {}
          return false;
        }
        try { syncFeatureTab('inbounds', 'inbounds-view-init'); } catch (e3) {}
        return true;
      },
    },
    outbounds: {
      label: 'Outbounds',
      fileCodeId: 'outbounds-file-code',
      dirtySourceName: 'form',
      fragmentSelectId: 'outbounds-fragment-select',
      load: () => Promise.all([
        import('../features/outbounds.js'),
        import('../features/compat/outbounds.js'),
      ]).then(([mod]) => mod),
      isVisible: () => true,
      onActivate: (api) => {
        try { api.init(); } catch (e) {
          try { console.error('[XKeen] outbounds config shell init failed', e); } catch (e2) {}
          return false;
        }
        try { syncFeatureTab('outbounds', 'outbounds-view-init'); } catch (e3) {}
        return true;
      },
    },
  };

  const _lifecycles = Object.create(null);
  const _featurePromises = Object.create(null);
  const _featureModules = Object.create(null);
  const _featureActivated = Object.create(null);

  function getFeatureMeta(name) {
    return FEATURE_META[String(name || '')] || null;
  }

  function getConfigShellApi() {
    const api = getXkeenUiConfigShellApi();
    return api && typeof api.createFeatureLifecycle === 'function' ? api : null;
  }

  function getFeatureApi(name) {
    const key = String(name || '');
    try {
      if (key === 'routing') {
        const mod = _featureModules[key] || null;
        const getter = mod && typeof mod.getRoutingApi === 'function' ? mod.getRoutingApi : null;
        const api = typeof getter === 'function' ? getter() : null;
        return api && typeof api.init === 'function' ? api : null;
      }
      if (key === 'inbounds' || key === 'outbounds') {
        const mod = _featureModules[key] || null;
        if (!mod) return null;
        const getter = key === 'inbounds' ? mod.getInboundsApi : mod.getOutboundsApi;
        const api = typeof getter === 'function' ? getter() : null;
        return api && typeof api.init === 'function' ? api : null;
      }
    } catch (e) {}
    return null;
  }

  function getRoutingShellApi() {
    try {
      const api = getRoutingShellModuleApi();
      return api && typeof api.getState === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function getFragmentSelectValue(featureName) {
    const meta = getFeatureMeta(featureName);
    if (!meta || !meta.fragmentSelectId) return '';
    try {
      const value = document.getElementById(meta.fragmentSelectId);
      return value ? String(value.value || value.dataset.current || '') : '';
    } catch (e) {}
    return '';
  }

  function getActiveFragment(featureName) {
    const key = String(featureName || '');
    if (key === 'routing') {
      try {
        const state = getRoutingShellApi() && getRoutingShellApi().getState ? getRoutingShellApi().getState() : null;
        if (state && typeof state.activeFragment === 'string' && state.activeFragment) return state.activeFragment;
      } catch (e) {}
    }
    return getFragmentSelectValue(key);
  }

  function getFileCodeText(featureName) {
    const meta = getFeatureMeta(featureName);
    if (!meta || !meta.fileCodeId) return '';
    try {
      const code = document.getElementById(meta.fileCodeId);
      return code ? String(code.textContent || '') : '';
    } catch (e) {}
    return '';
  }

  function getActiveFilePath(featureName) {
    const key = String(featureName || '');
    if (key === 'routing') {
      try {
        const state = getRoutingShellApi() && getRoutingShellApi().getState ? getRoutingShellApi().getState() : null;
        if (state && typeof state.activeFilePath === 'string' && state.activeFilePath) return state.activeFilePath;
      } catch (e) {}
    }
    return getFileCodeText(key);
  }

  function ensureFeatureLifecycle(featureName) {
    const key = String(featureName || '');
    if (_lifecycles[key]) return _lifecycles[key];

    const shell = getConfigShellApi();
    const meta = getFeatureMeta(key);
    if (!shell || !meta) return null;

    try {
      _lifecycles[key] = shell.createFeatureLifecycle(key, {
        label: meta.label,
        fileCodeId: meta.fileCodeId,
        dirtySourceName: meta.dirtySourceName,
      });
    } catch (e) {
      _lifecycles[key] = null;
    }
    return _lifecycles[key];
  }

  function syncFeatureTab(featureName, reason) {
    const key = String(featureName || '');
    const meta = getFeatureMeta(key);
    const lifecycle = ensureFeatureLifecycle(key);
    if (!meta || !lifecycle || typeof lifecycle.syncTab !== 'function') return null;

    try {
      return lifecycle.syncTab({
        label: meta.label,
        fileCodeId: meta.fileCodeId,
        activeFragment: getActiveFragment(key),
        activeFilePath: getActiveFilePath(key),
      }, reason || 'build-shell-sync');
    } catch (e) {}
    return null;
  }

  function publishFeatureState(featureName, patch, reason) {
    const lifecycle = ensureFeatureLifecycle(featureName);
    if (!lifecycle || typeof lifecycle.publish !== 'function') return null;
    try {
      return lifecycle.publish(patch || {}, reason || 'feature-state');
    } catch (e) {}
    return null;
  }

  function isFeatureReady(featureName) {
    return !!_featureActivated[String(featureName || '')];
  }

  async function ensureFeatureReady(featureName) {
    const key = String(featureName || '');
    const meta = getFeatureMeta(key);
    if (!meta) return null;

    const readyApi = getFeatureApi(key);
    if (readyApi) {
      const lifecycle = ensureFeatureLifecycle(key);
      if (lifecycle && typeof lifecycle.setInitialized === 'function') {
        try { lifecycle.setInitialized(true); } catch (e) {}
      }
      try { syncFeatureTab(key, key + '-build-shell-ready'); } catch (e2) {}
      return readyApi;
    }

    if (_featurePromises[key]) return _featurePromises[key];

    if (typeof meta.load !== 'function') {
      const lifecycle = ensureFeatureLifecycle(key);
      if (lifecycle && typeof lifecycle.setInitialized === 'function') {
        try { lifecycle.setInitialized(true); } catch (e) {}
      }
      try { syncFeatureTab(key, key + '-build-shell-ready'); } catch (e2) {}
      return getFeatureApi(key) || lifecycle || getConfigShellApi();
    }

    _featurePromises[key] = meta.load()
      .then((mod) => {
        _featureModules[key] = mod || null;
        const api = getFeatureApi(key);
        if (!api) throw new Error('feature api unavailable after import: ' + key);
        const lifecycle = ensureFeatureLifecycle(key);
        if (lifecycle && typeof lifecycle.setInitialized === 'function') {
          try { lifecycle.setInitialized(true); } catch (e) {}
        }
        try { syncFeatureTab(key, key + '-build-shell-ready'); } catch (e2) {}
        return api;
      })
      .catch((error) => {
        try { console.error('[XKeen] config shell failed to load feature', key, error); } catch (e) {}
        throw error;
      })
      .finally(() => {
        if (!getFeatureApi(key)) {
          _featurePromises[key] = null;
          _featureModules[key] = null;
        }
      });

    return _featurePromises[key];
  }

  async function activateFeatureView(featureName, options) {
    const key = String(featureName || '');
    const meta = getFeatureMeta(key);
    const opts = (options && typeof options === 'object') ? options : {};
    if (!meta) return false;

    const api = await ensureFeatureReady(key).catch(() => null);
    if (!api) return false;
    if (!opts.force && typeof meta.isVisible === 'function' && !meta.isVisible()) return true;

    publishFeatureState(key, { initialized: true, loading: !!opts.loading }, key + '-view-activate');

    let activated = true;
    if (typeof meta.onActivate === 'function') {
      activated = meta.onActivate(api, opts) !== false;
    }
    _featureActivated[key] = !!activated;
    return !!activated;
  }

  function isReady() {
    return !!(getConfigShellApi() && getRoutingShellApi());
  }

  async function ensureReady() {
    const lifecycle = ensureFeatureLifecycle('routing');
    if (lifecycle && typeof lifecycle.setInitialized === 'function') {
      try { lifecycle.setInitialized(true); } catch (e) {}
    }
    try { syncFeatureTab('routing', 'build-shell-ready'); } catch (e2) {}
    _featureActivated.routing = true;
    return lifecycle || getConfigShellApi();
  }

  async function activateRoutingView(options) {
    await ensureReady();
    return activateFeatureView('routing', options);
  }

  async function ensureInboundsReady() {
    return ensureFeatureReady('inbounds');
  }

  async function ensureOutboundsReady() {
    return ensureFeatureReady('outbounds');
  }

  async function activateInboundsView(options) {
    return activateFeatureView('inbounds', options);
  }

  async function activateOutboundsView(options) {
    return activateFeatureView('outbounds', options);
  }

  publishXkeenPageApi('configShell', {
    isReady,
    ensureReady,
    isFeatureReady,
    ensureFeatureReady,
    ensureFeatureLifecycle,
    syncFeatureTab,
    ensureRoutingLifecycle: () => ensureFeatureLifecycle('routing'),
    syncRoutingTab: (reason) => syncFeatureTab('routing', reason),
    activateRoutingView,
    isInboundsReady: () => isFeatureReady('inbounds'),
    ensureInboundsReady,
    activateInboundsView,
    isOutboundsReady: () => isFeatureReady('outbounds'),
    ensureOutboundsReady,
    activateOutboundsView,
  });
})();


export function getConfigShellApi() {
  try {
    const api = getXkeenPageApi('configShell');
    return api && typeof api.ensureReady === 'function' ? api : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function callConfigShellApi(method, ...args) {
  const api = getConfigShellApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function ensureConfigShellReady(...args) {
  return callConfigShellApi('ensureReady', ...args);
}

export function activateRoutingConfigView(...args) {
  return callConfigShellApi('activateRoutingView', ...args);
}

export function activateInboundsConfigView(...args) {
  return callConfigShellApi('activateInboundsView', ...args);
}

export function activateOutboundsConfigView(...args) {
  return callConfigShellApi('activateOutboundsView', ...args);
}

export const configShellApi = Object.freeze({
  get: getConfigShellApi,
  ensureReady: ensureConfigShellReady,
  activateRoutingView: activateRoutingConfigView,
  activateInboundsView: activateInboundsConfigView,
  activateOutboundsView: activateOutboundsConfigView,
});
