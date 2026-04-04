import { getTopLevelScreenRegistryApi } from './top_level_screen_registry.js';
import {
  applyScreenDocumentState,
  attachScreenRoot,
  captureCurrentDocumentScreenSnapshot,
  detachScreenRoot,
  ensureScreenStyles,
  fetchTopLevelScreenSnapshot,
} from './top_level_screen_host.shared.js';

function isDevtoolsLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'devtools' ||
      document.body?.classList.contains('devtools-page') ||
      document.getElementById('dt-tab-tools') ||
      document.getElementById('dt-tab-logs')
    );
  } catch (error) {
    return false;
  }
}

async function resolveDevtoolsBootstrapModule() {
  return import('./devtools.screen.bootstrap.js');
}

function createDevtoolsScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isDevtoolsLocation()
      ? captureCurrentDocumentScreenSnapshot('devtools')
      : await fetchTopLevelScreenSnapshot('devtools', '/devtools');
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolveDevtoolsBootstrapModule();
    if (boot) {
      runtimeApi = await mod.bootDevtoolsScreen();
      initialized = !!(runtimeApi && typeof runtimeApi.init === 'function');
      return runtimeApi;
    }

    runtimeApi = mod.getDevtoolsTopLevelApi();
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
      if (!runtimeApi && isDevtoolsLocation()) {
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

export function registerDevtoolsTopLevelScreen() {
  const registry = getTopLevelScreenRegistryApi();
  const screen = createDevtoolsScreen();
  registry.registerScreen('devtools', screen);
  if (isDevtoolsLocation()) {
    Promise.resolve(screen.mount()).catch(() => {});
  }
  return screen;
}
