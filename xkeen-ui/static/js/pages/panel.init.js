import { getPanelShellApi, initPanelShell } from './panel_shell.shared.js';
import { bindPanelShellViewRuntime } from './panel.view_runtime.js';
import { ensurePanelLazyFeature } from './panel.lazy_bindings.runtime.js';
import { initLocalIo } from '../features/local_io.js';

function isPanelPage() {
  return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
}

function safe(fn) {
  try { fn(); } catch (error) { console.error(error); }
}

function hasXrayCore() {
  try {
    if (typeof window.XKEEN_HAS_XRAY === 'boolean') return !!window.XKEEN_HAS_XRAY;
    const value = String(window.XKEEN_HAS_XRAY || '').toLowerCase();
    if (value) return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  } catch (error) {}
  return true;
}

function initModules() {
  safe(() => {
    if (hasXrayCore()) initLocalIo();
  });

  safe(() => {
    const hasRestartLogBlock =
      !!document.querySelector('[data-xk-restart-log="1"]') ||
      !!document.getElementById('restart-log');
    if (!hasRestartLogBlock) return;
    ensurePanelLazyFeature('restartLog').catch((error) => {
      try { console.error('[XKeen] restart log feature failed:', error); } catch (secondaryError) {}
    });
  });
}

function init() {
  if (!isPanelPage()) return;

  initModules();

  const sharedShell = getPanelShellApi();
  if (!sharedShell) return;

  bindPanelShellViewRuntime(sharedShell);
  if (!(typeof sharedShell.isInitialized === 'function' && sharedShell.isInitialized())) {
    initPanelShell();
  }
}

export function initPanelPage() {
  return init();
}

export function bootPanelPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    return;
  }

  init();
}

export default initPanelPage;
