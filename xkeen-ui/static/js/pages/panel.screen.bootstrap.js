import './shell.shared.js';
import './logs_shell.shared.js';
import './panel_shell.shared.js';
import './config_shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import './panel.shared_compat.bundle.js';
import { getCurrentPanelShellView, showPanelShellView } from './panel_shell.shared.js';
import { applyPanelViewRuntime } from './panel.view_runtime.js';
import { hasXkeenMihomoCore, hasXkeenXrayCore } from '../features/xkeen_runtime.js';
import { bootPanelPage } from './panel.bootstrap_tail.bundle.js';

let _panelFeatureBundlesPromise = null;

export async function loadPanelFeatureBundles() {
  if (_panelFeatureBundlesPromise) return _panelFeatureBundlesPromise;

  _panelFeatureBundlesPromise = (async () => {
    if (hasXkeenXrayCore()) {
      await import('./panel.routing.bundle.js');
    }

    if (hasXkeenMihomoCore()) {
      await import('./panel.mihomo.bundle.js');
    }

    return true;
  })();

  return _panelFeatureBundlesPromise;
}

function createPanelTopLevelApi() {
  return {
    activate() {
      try {
        const currentView = String(getCurrentPanelShellView() || '');
        if (currentView) {
          showPanelShellView(currentView);
          applyPanelViewRuntime(currentView);
        }
      } catch (error) {}
    },
    deactivate() {},
    serializeState() {
      try {
        return {
          currentView: String(getCurrentPanelShellView() || ''),
        };
      } catch (error) {
        return null;
      }
    },
    restoreState(state) {
      const nextView = state && typeof state === 'object' ? String(state.currentView || '') : '';
      if (!nextView) return false;
      try {
        showPanelShellView(nextView);
        return true;
      } catch (error) {
        return false;
      }
    },
  };
}

let _panelTopLevelApi = null;

export async function bootPanelScreen() {
  await loadPanelFeatureBundles();
  bootPanelPage();

  if (!_panelTopLevelApi) {
    _panelTopLevelApi = createPanelTopLevelApi();
  }

  return _panelTopLevelApi;
}

export function getPanelTopLevelApi() {
  if (_panelTopLevelApi) return _panelTopLevelApi;
  _panelTopLevelApi = createPanelTopLevelApi();
  return _panelTopLevelApi;
}
