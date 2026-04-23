import { getLogsShellApi, activateLogsShellView, deactivateLogsShellView } from './logs_shell.shared.js';
import { getConfigShellApi, activateRoutingConfigView } from './config_shell.shared.js';
import { ensurePanelLazyFeature, getPanelLazyRuntimeApi } from './panel.lazy_bindings.runtime.js';
import { initMihomoPanel, onShowMihomoPanel } from '../features/mihomo_panel.js';
import {
  getXkeenStateValue,
  hasXkeenXrayCore,
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

function hasXrayCore() {
  return hasXkeenXrayCore();
}

function ensureFileManagerReady() {
  const api = getPanelLazyRuntimeApi();
  return (api && typeof api.ensureFileManagerReady === 'function')
    ? api.ensureFileManagerReady()
    : Promise.resolve(false);
}

async function resolveFileManagerModuleApi() {
  try {
    const mod = await import('../features/file_manager.js');
    if (mod && typeof mod.getFileManagerApi === 'function') return mod.getFileManagerApi();
  } catch (error) {
    try { console.error('[XKeen] file manager module resolve failed', error); } catch (e) {}
  }
  return null;
}

const viewInitFlags = Object.create(null);
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

export function applyPanelViewRuntime(name) {
  const viewName = String(name || '');
  if (!viewName) return;

  if (viewName === 'mihomo') {
    initViewOnce('mihomo', () => {
      initMihomoPanel();
    }).catch((error) => {
      try { console.error('[XKeen] view init failed:', viewName, error); } catch (e) {}
    });
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
    initViewOnce('routing', async () => {
      if (!hasXrayCore()) return;
      const configShell = getConfigShellApi();
      if (!configShell) throw new Error('routing config shell unavailable');
      const ready = await activateRoutingConfigView({ reason: 'init' });
      if (!ready) throw new Error('routing config shell not ready');
    }).catch((error) => {
      try { console.error('[XKeen] view init failed:', viewName, error); } catch (e) {}
    });

    const configShell = getConfigShellApi();
    if (configShell) {
      safe(() => activateRoutingConfigView({ reason: 'tab' }));
      if (typeof configShell.isOutboundsReady === 'function' && configShell.isOutboundsReady()) {
        safe(() => configShell.activateOutboundsView({ reason: 'tab' }));
      }
    }
  }

  if (viewName === 'mihomo') {
    safe(() => onShowMihomoPanel({ reason: 'tab' }));
  }

  if (viewName === 'xkeen') {
    ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((key) => {
      const editor = getEditor(key);
      if (editor && editor.refresh) safe(() => editor.refresh());
    });
  }

  if (viewName === 'xray-logs') {
    const logsShell = getLogsShellApi();
    if (logsShell) {
      Promise.resolve(activateLogsShellView({ reason: 'tab' })).catch((error) => {
        try { console.error('[XKeen] logs shell activate failed', error); } catch (e) {}
      });
    }
  } else {
    const logsShell = getLogsShellApi();
    if (logsShell) {
      safe(() => deactivateLogsShellView());
    }
  }

  if (viewName === 'files') {
    ensureFileManagerReady().then(async (ready) => {
      if (!ready) return;
      const fileManager = await resolveFileManagerModuleApi();
      if (fileManager && typeof fileManager.onShow === 'function') safe(() => fileManager.onShow());
    }).catch((error) => {
      try { console.error('[XKeen] files view activation failed', error); } catch (e) {}
    });
  }

  safe(() => syncXkeenBodyScrollLock());
}

let panelShellViewRuntimeBound = false;
export function bindPanelShellViewRuntime(sharedShell) {
  if (panelShellViewRuntimeBound) return;
  panelShellViewRuntimeBound = true;

  document.addEventListener('xkeen:panel-view-changed', (event) => {
    const detail = event && event.detail ? event.detail : {};
    const viewName = String(detail.view || '');
    if (!viewName) return;
    applyPanelViewRuntime(viewName);
  });

  try {
    const current = sharedShell && typeof sharedShell.getCurrentView === 'function'
      ? String(sharedShell.getCurrentView() || '')
      : '';
    if (current) applyPanelViewRuntime(current);
  } catch (e) {}
}

export const panelViewRuntimeApi = Object.freeze({
  apply: applyPanelViewRuntime,
  bind: bindPanelShellViewRuntime,
});
