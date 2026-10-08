import { getTopLevelScreenRegistryApi } from './top_level_screen_registry.js';
import {
  applyScreenDocumentState,
  attachScreenRoot,
  captureCurrentDocumentScreenSnapshot,
  createScreenActivationTracker,
  detachScreenRoot,
  ensureScreenStyles,
  fetchTopLevelScreenSnapshot,
  recoverScreenActivationFailure,
} from './top_level_screen_host.shared.js';

function isModulesLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'modules' ||
      document.body?.classList.contains('modules-page') ||
      document.getElementById('xk-modules-manager')
    );
  } catch (error) {
    return false;
  }
}

function hasModulesHost(root) {
  try {
    return !!root?.querySelector('#xk-modules-manager');
  } catch (error) {
    return false;
  }
}

function createModulesScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;
  const activation = createScreenActivationTracker();

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isModulesLocation()
      ? captureCurrentDocumentScreenSnapshot('modules')
      : await fetchTopLevelScreenSnapshot('modules', '/modules');
    if (!snapshot?.root || !hasModulesHost(snapshot.root)) {
      throw new Error('modules snapshot missing required host marker');
    }
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false, isCurrent = null) {
    if (runtimeApi && !boot) return runtimeApi;
    const mod = await import('./modules.screen.bootstrap.js');
    if (boot) {
      if (typeof isCurrent === 'function' && !isCurrent()) return null;
      runtimeApi = await mod.bootModulesScreen();
      initialized = true;
    } else {
      runtimeApi = mod.getModulesTopLevelApi();
    }
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
      if (!attachScreenRoot(nextSnapshot) || !document.getElementById('xk-modules-manager')) {
        throw new Error('modules screen root attach failed');
      }

      activation.start(async (isCurrent) => {
        if (!initialized) {
          await ensureRuntimeApi(true, isCurrent);
        } else if (!runtimeApi) {
          await ensureRuntimeApi(false);
        }
        if (!isCurrent()) return;
        if (runtimeApi && typeof runtimeApi.restoreState === 'function' && serializedState) {
          try { await runtimeApi.restoreState(serializedState, context); } catch (error) {}
        }
        if (runtimeApi && typeof runtimeApi.activate === 'function') {
          await runtimeApi.activate(context);
          if (!activation.isActive() && typeof runtimeApi.deactivate === 'function') {
            await runtimeApi.deactivate(context);
          }
        }
      }, (error) => recoverScreenActivationFailure(context, error));
    },
    async deactivate(context) {
      if (activation.leave()) {
        detachScreenRoot(snapshot);
        return;
      }
      if (!runtimeApi && isModulesLocation()) await ensureRuntimeApi(false);
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

export function registerModulesTopLevelScreen() {
  const registry = getTopLevelScreenRegistryApi();
  const screen = createModulesScreen();
  registry.registerScreen('modules', screen);
  if (isModulesLocation()) {
    Promise.resolve(screen.mount()).catch(() => {});
  }
  return screen;
}
