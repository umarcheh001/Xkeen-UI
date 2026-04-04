import { getTopLevelScreenRegistryApi } from './top_level_screen_registry.js';
import {
  applyScreenDocumentState,
  attachScreenRoot,
  captureCurrentDocumentScreenSnapshot,
  detachScreenRoot,
  ensureScreenStyles,
  fetchTopLevelScreenSnapshot,
} from './top_level_screen_host.shared.js';

function isPanelLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'panel' ||
      document.body?.classList.contains('panel-page') ||
      document.getElementById('top-tab-mihomo-generator')
    );
  } catch (error) {
    return false;
  }
}

async function resolvePanelBootstrapModule() {
  return import('./panel.screen.bootstrap.js');
}

function createPanelScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isPanelLocation()
      ? captureCurrentDocumentScreenSnapshot('panel')
      : await fetchTopLevelScreenSnapshot('panel', '/');
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolvePanelBootstrapModule();
    if (boot) {
      runtimeApi = await mod.bootPanelScreen();
      initialized = true;
      return runtimeApi;
    }

    runtimeApi = mod.getPanelTopLevelApi();
    return runtimeApi;
  }

  return {
    async mount() {
      await ensureSnapshot();
    },
    async activate(context) {
      const nextSnapshot = await ensureSnapshot();
      ensureScreenStyles(nextSnapshot);
      applyScreenDocumentState(nextSnapshot);
      attachScreenRoot(nextSnapshot);

      if (!initialized) {
        await ensureRuntimeApi(true);
      } else if (!runtimeApi) {
        await ensureRuntimeApi(false);
      }

      if (runtimeApi && typeof runtimeApi.restoreState === 'function' && serializedState) {
        try { runtimeApi.restoreState(serializedState, context); } catch (error) {}
      }

      if (runtimeApi && typeof runtimeApi.activate === 'function') {
        await runtimeApi.activate(context);
      }
    },
    async deactivate(context) {
      if (!runtimeApi && isPanelLocation()) {
        await ensureRuntimeApi(false);
      }
      if (runtimeApi && typeof runtimeApi.serializeState === 'function') {
        try { serializedState = runtimeApi.serializeState(context); } catch (error) {}
      }
      if (runtimeApi && typeof runtimeApi.deactivate === 'function') {
        await runtimeApi.deactivate(context);
      }
      detachScreenRoot(snapshot);
    },
    dispose() {
      detachScreenRoot(snapshot);
    },
  };
}

export function registerPanelTopLevelScreen() {
  const registry = getTopLevelScreenRegistryApi();
  const screen = createPanelScreen();
  registry.registerScreen('panel', screen);
  if (isPanelLocation()) {
    Promise.resolve(screen.mount()).catch(() => {});
  }
  return screen;
}
