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

function isMihomoLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'mihomo_generator' ||
      document.body?.classList.contains('mihomo-generator-page')
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
  const activation = createScreenActivationTracker();

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isMihomoLocation()
      ? captureCurrentDocumentScreenSnapshot('mihomo_generator')
      : await fetchTopLevelScreenSnapshot('mihomo_generator', '/mihomo_generator');
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false, isCurrent = null) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolveMihomoBootstrapModule();
    if (boot) {
      // The screen was left while its scripts were loading: do not start it
      // against markup that is no longer on the page.
      if (typeof isCurrent === 'function' && !isCurrent()) return null;
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

      // Not awaited: the router must be free to leave this screen while its
      // scripts are still loading (see createScreenActivationTracker).
      activation.start(async (isCurrent) => {
        if (!initialized) {
          await ensureRuntimeApi(true, isCurrent);
        } else if (!runtimeApi) {
          await ensureRuntimeApi(false);
        }
        // Left before the scripts arrived: nothing was started, the next visit starts it.
        if (!isCurrent()) return;

        if (runtimeApi && typeof runtimeApi.restoreState === 'function' && serializedState) {
          try { await runtimeApi.restoreState(serializedState, context); } catch (error) {}
        }

        if (runtimeApi && typeof runtimeApi.activate === 'function') {
          await runtimeApi.activate(context);
          // Left while it was starting up: stop what it has just started.
          if (!activation.isActive() && typeof runtimeApi.deactivate === 'function') {
            await runtimeApi.deactivate(context);
          }
        }
      }, (error) => recoverScreenActivationFailure(context, error));
    },
    async deactivate(context) {
      if (activation.leave()) {
        // Its scripts have not finished starting: there is no state to keep
        // and nothing to stop yet, and waiting for them is what made "Back"
        // look dead.
        detachScreenRoot(snapshot);
        return;
      }
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
