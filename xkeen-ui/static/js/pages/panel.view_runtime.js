import { ensurePanelLazyFeature } from './panel.lazy_bindings.runtime.js';
import { getPanelLazyFeatureApi } from './panel.lazy_bindings.runtime.js';
import { ensurePanelModuleForView, getPanelModuleApi } from './panel.module_loader.js';
import {
  getXkeenStateValue,
  syncXkeenBodyScrollLock,
} from '../features/xkeen_runtime.js';

function safe(fn) {
  try { return fn(); } catch (error) {
    try { console.error(error); } catch (e) {}
    return undefined;
  }
}

function getEditor(name) {
  try {
    const editor = getXkeenStateValue(name, null);
    if (editor) return editor;
  } catch (e) {}
  try {
    return window[name];
  } catch (e) {}
  return null;
}

function getMihomoClashFeatureApi() {
  return getPanelLazyFeatureApi('mihomoClash');
}

const viewInitFlags = Object.create(null);
let mihomoConfigSubviewRuntimeBound = false;

function bindMihomoConfigSubviewRuntime() {
  if (mihomoConfigSubviewRuntimeBound) return;
  mihomoConfigSubviewRuntimeBound = true;
  document.addEventListener('xkeen:mihomo-config-subview-shown', () => {
    void ensurePanelModuleForView('mihomo').then((loaded) => {
      const api = loaded && loaded.api;
      if (api && typeof api.onShowMihomoPanel === 'function') {
        safe(() => api.onShowMihomoPanel({ reason: 'subview' }));
      }
    }).catch((error) => {
      try { console.error('[XKeen] Mihomo subview activation failed', error); } catch (e) {}
    });
  });
}

function initViewOnce(name, fn) {
  const key = String(name || '');
  if (!key) return Promise.resolve(false);
  const state = viewInitFlags[key];
  if (state === true) return Promise.resolve(true);
  if (state && typeof state.then === 'function') return state;

  const run = Promise.resolve()
    .then(() => fn())
    .then((result) => {
      viewInitFlags[key] = true;
      return result;
    })
    .catch((error) => {
      try { delete viewInitFlags[key]; } catch (e) {}
      throw error;
    });

  viewInitFlags[key] = run;
  return run;
}

export async function applyPanelViewRuntime(name) {
  const viewName = String(name || '');
  if (!viewName) return null;
  const loaded = await ensurePanelModuleForView(viewName);
  if (!loaded || loaded.status !== 'ready') return loaded;
  const moduleApi = loaded && loaded.api ? loaded.api : null;

  if (viewName === 'mihomo') {
    await initViewOnce('mihomo', () => {
      if (!moduleApi || typeof moduleApi.initMihomoPanel !== 'function') {
        throw new Error('Mihomo panel module unavailable');
      }
      return moduleApi.initMihomoPanel();
    }).catch((error) => {
      try { console.error('[XKeen] view init failed:', viewName, error); } catch (e) {}
    });
    ensurePanelLazyFeature('mihomoClash').then((ready) => {
      if (!ready) return;
      const feature = getMihomoClashFeatureApi();
      if (feature && typeof feature.activate === 'function') feature.activate({ reason: 'panel-view' });
    }).catch((error) => {
      try { console.error('[XKeen] Mihomo Clash workspace activation failed', error); } catch (e) {}
    });
  } else {
    const feature = getMihomoClashFeatureApi();
    if (feature && typeof feature.deactivate === 'function') safe(() => feature.deactivate());
  }

  if (viewName === 'xkeen') {
    initViewOnce('xkeen', async () => {
      const ready = await ensurePanelLazyFeature('xkeenTexts');
      if (!ready) throw new Error('xkeen texts not ready');
    }).catch((error) => {
      try { console.error('[XKeen] view init failed:', viewName, error); } catch (e) {}
    });
  }

  if (viewName === 'commands') {
    initViewOnce('commands', async () => {
      const results = await Promise.all([
        ensurePanelLazyFeature('commandsList'),
        ensurePanelLazyFeature('coresStatus'),
      ]);
      if (!results.every(Boolean)) throw new Error('commands view features not ready');
    }).catch((error) => {
      try { console.error('[XKeen] view init failed:', viewName, error); } catch (e) {}
    });
  }

  if (viewName === 'routing') {
    await initViewOnce('routing', async () => {
      const configShell = moduleApi && typeof moduleApi.getConfigShellApi === 'function'
        ? moduleApi.getConfigShellApi()
        : null;
      if (!configShell) throw new Error('routing config shell unavailable');
      const ready = await moduleApi.activateRoutingConfigView({ reason: 'init' });
      if (!ready) throw new Error('routing config shell not ready');
    }).catch((error) => {
      try { console.error('[XKeen] view init failed:', viewName, error); } catch (e) {}
    });

    const configShell = moduleApi && typeof moduleApi.getConfigShellApi === 'function'
      ? moduleApi.getConfigShellApi()
      : null;
    if (configShell) {
      safe(() => moduleApi.activateRoutingConfigView({ reason: 'tab' }));
      if (typeof configShell.isOutboundsReady === 'function' && configShell.isOutboundsReady()) {
        safe(() => configShell.activateOutboundsView({ reason: 'tab' }));
      }
    }
  }

  if (viewName === 'mihomo') {
    if (moduleApi && typeof moduleApi.onShowMihomoPanel === 'function') {
      safe(() => moduleApi.onShowMihomoPanel({ reason: 'tab' }));
    }
  }

  if (viewName === 'xkeen') {
    ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((key) => {
      const editor = getEditor(key);
      if (editor && editor.refresh) safe(() => editor.refresh());
    });
  }

  if (viewName === 'xray-logs') {
    const logsShell = moduleApi && typeof moduleApi.getLogsShellApi === 'function'
      ? moduleApi.getLogsShellApi()
      : null;
    if (logsShell) {
      Promise.resolve(moduleApi.activateLogsShellView({ reason: 'tab' })).catch((error) => {
        try { console.error('[XKeen] logs shell activate failed', error); } catch (e) {}
      });
    }
  } else {
    const routingBundle = getPanelModuleApi('panel-routing');
    const logsShell = routingBundle && typeof routingBundle.getLogsShellApi === 'function'
      ? routingBundle.getLogsShellApi()
      : null;
    if (logsShell) {
      safe(() => routingBundle.deactivateLogsShellView());
    }
  }

  if (viewName === 'files') {
    const fileManager = moduleApi;
    if (fileManager && typeof fileManager.onShow === 'function') {
      safe(() => fileManager.onShow());
    }
  }

  safe(() => syncXkeenBodyScrollLock());
  return loaded;
}

let panelShellViewRuntimeBound = false;
export function bindPanelShellViewRuntime(sharedShell) {
  if (panelShellViewRuntimeBound) return;
  panelShellViewRuntimeBound = true;
  bindMihomoConfigSubviewRuntime();

  document.addEventListener('xkeen:panel-view-changed', (event) => {
    const detail = event && event.detail ? event.detail : {};
    const viewName = String(detail.view || '');
    if (!viewName) return;
    void applyPanelViewRuntime(viewName).catch((error) => {
      try { console.error('[XKeen] panel view runtime failed', error); } catch (e) {}
    });
  });

  try {
    const current = sharedShell && typeof sharedShell.getCurrentView === 'function'
      ? String(sharedShell.getCurrentView() || '')
      : '';
    if (current) {
      void applyPanelViewRuntime(current).catch((error) => {
        try { console.error('[XKeen] panel initial view runtime failed', error); } catch (e) {}
      });
    }
  } catch (e) {}
}

export const panelViewRuntimeApi = Object.freeze({
  apply: applyPanelViewRuntime,
  bind: bindPanelShellViewRuntime,
});
