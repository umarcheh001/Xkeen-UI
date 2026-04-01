import { getPanelShellApi, initPanelShell } from './panel_shell.shared.js';
import { bindPanelShellViewRuntime } from './panel.view_runtime.js';
import { ensurePanelLazyFeature } from './panel.lazy_bindings.runtime.js';
import { initLocalIo } from '../features/local_io.js';
import { hasXkeenXrayCore } from '../features/xkeen_runtime.js';

function isPanelPage() {
  return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
}

function safe(fn) {
  try { fn(); } catch (error) { console.error(error); }
}

function hasXrayCore() {
  return hasXkeenXrayCore();
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
