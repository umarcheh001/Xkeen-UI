import './shell.shared.js';
import './logs_shell.shared.js';
import './panel_shell.shared.js';
import './config_shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import './panel.shared_compat.bundle.js';
import {
  applyPanelShellScrollSettings,
  getCurrentPanelShellView,
  showPanelShellView,
} from './panel_shell.shared.js';
import { applyPanelViewRuntime } from './panel.view_runtime.js';
import { hasXkeenMihomoCore, hasXkeenXrayCore } from '../features/xkeen_runtime.js';
import { bootPanelPage } from './panel.bootstrap_tail.bundle.js';
import { initPanelOperatorHeader } from './panel.mihomo_header.js';

let _panelFeatureBundlesPromise = null;
let _panelStartupReleased = false;

function now() {
  try { return window.performance ? window.performance.now() : Date.now(); } catch (error) { return Date.now(); }
}

function waitForDocumentReady() {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
}

function waitForStablePaint() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 250);
    window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
  });
}

function releasePanelStartupOverlay() {
  if (_panelStartupReleased) return Promise.resolve();
  _panelStartupReleased = true;

  try { window.clearTimeout(window.__xkPanelStartupFailOpen); } catch (error) {}
  const overlay = document.getElementById('global-xkeen-spinner');
  const startedAt = Number(window.__xkPanelStartupAt || 0);
  const delay = Math.max(0, 320 - (startedAt ? now() - startedAt : 320));

  return new Promise((resolve) => {
    window.setTimeout(() => {
      document.body?.classList.remove('xk-panel-startup');
      if (!overlay || !overlay.classList.contains('is-startup')) {
        resolve();
        return;
      }

      overlay.setAttribute('aria-busy', 'false');
      overlay.classList.add('is-leaving');
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        overlay.removeEventListener('transitionend', finish);
        overlay.classList.remove('is-active', 'is-startup', 'is-leaving');
        resolve();
      };
      overlay.addEventListener('transitionend', finish);
      window.setTimeout(finish, 260);
    }, delay);
  });
}

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
      initPanelOperatorHeader();
      applyPanelShellScrollSettings();
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
  initPanelOperatorHeader();
  try {
    await loadPanelFeatureBundles();
    await waitForDocumentReady();
    bootPanelPage();
    await waitForStablePaint();
  } finally {
    await releasePanelStartupOverlay();
  }

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
