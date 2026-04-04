import { getTopLevelScreenRegistryApi } from './top_level_screen_registry.js';
import {
  applyScreenDocumentState,
  attachScreenRoot,
  captureCurrentDocumentScreenSnapshot,
  detachScreenRoot,
  ensureScreenStyles,
  fetchTopLevelScreenSnapshot,
} from './top_level_screen_host.shared.js';

function isXkeenLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'xkeen' ||
      document.body?.classList.contains('xkeen-page') ||
      document.getElementById('xkeen-body') ||
      document.getElementById('xkeen-config-editor')
    );
  } catch (error) {
    return false;
  }
}

async function resolveXkeenBootstrapModule() {
  return import('./xkeen.screen.bootstrap.js');
}

function createXkeenScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isXkeenLocation()
      ? captureCurrentDocumentScreenSnapshot('xkeen')
      : await fetchTopLevelScreenSnapshot('xkeen', '/xkeen');
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolveXkeenBootstrapModule();
    if (boot) {
      runtimeApi = await mod.bootXkeenScreen();
      initialized = true;
      return runtimeApi;
    }

    runtimeApi = mod.getXkeenTopLevelApi();
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
        try { await runtimeApi.restoreState(serializedState, context); } catch (error) {}
      }

      if (runtimeApi && typeof runtimeApi.activate === 'function') {
        await runtimeApi.activate(context);
      }
    },
    async deactivate(context) {
      if (!runtimeApi && isXkeenLocation()) {
        await ensureRuntimeApi(false);
      }
      if (runtimeApi && typeof runtimeApi.serializeState === 'function') {
        try { serializedState = await runtimeApi.serializeState(context); } catch (error) {}
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

export function registerXkeenTopLevelScreen() {
  const registry = getTopLevelScreenRegistryApi();
  const screen = createXkeenScreen();
  registry.registerScreen('xkeen', screen);
  if (isXkeenLocation()) {
    Promise.resolve(screen.mount()).catch(() => {});
  }
  return screen;
}
