import { getTopLevelScreenRegistryApi } from './top_level_screen_registry.js';
import {
  applyScreenDocumentState,
  attachScreenRoot,
  captureCurrentDocumentScreenSnapshot,
  detachScreenRoot,
  ensureScreenStyles,
  fetchTopLevelScreenSnapshot,
} from './top_level_screen_host.shared.js';

function isMihomoLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'mihomo_generator' ||
      document.body?.classList.contains('mihomo-generator-page') ||
      document.getElementById('profileSelect') ||
      document.getElementById('previewTextarea')
    );
  } catch (error) {
    return false;
  }
}

async function resolveMihomoBootstrapModule() {
  return import('./mihomo_generator.screen.bootstrap.js');
}

function createMihomoGeneratorScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isMihomoLocation()
      ? captureCurrentDocumentScreenSnapshot('mihomo_generator')
      : await fetchTopLevelScreenSnapshot('mihomo_generator', '/mihomo_generator');
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolveMihomoBootstrapModule();
    if (boot) {
      runtimeApi = await mod.bootMihomoGeneratorScreen();
      initialized = !!(runtimeApi && typeof runtimeApi.init === 'function');
      return runtimeApi;
    }

    runtimeApi = mod.getMihomoGeneratorTopLevelApi();
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
      if (!runtimeApi && isMihomoLocation()) {
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

export function registerMihomoGeneratorTopLevelScreen() {
  const registry = getTopLevelScreenRegistryApi();
  const screen = createMihomoGeneratorScreen();
  registry.registerScreen('mihomo_generator', screen);
  if (isMihomoLocation()) {
    Promise.resolve(screen.mount()).catch(() => {});
  }
  return screen;
}
