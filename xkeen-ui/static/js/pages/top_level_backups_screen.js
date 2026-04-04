import { getTopLevelScreenRegistryApi } from './top_level_screen_registry.js';
import {
  applyScreenDocumentState,
  attachScreenRoot,
  captureCurrentDocumentScreenSnapshot,
  detachScreenRoot,
  ensureScreenStyles,
  fetchTopLevelScreenSnapshot,
} from './top_level_screen_host.shared.js';

function isBackupsLocation() {
  try {
    return !!(
      window.XKeen?.pageConfig?.page === 'backups' ||
      document.body?.classList.contains('backups-page') ||
      document.body?.classList.contains('xk-backups-page') ||
      document.getElementById('backups-table') ||
      document.getElementById('backups-status')
    );
  } catch (error) {
    return false;
  }
}

async function resolveBackupsBootstrapModule() {
  return import('./backups.screen.bootstrap.js');
}

function createBackupsScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isBackupsLocation()
      ? captureCurrentDocumentScreenSnapshot('backups')
      : await fetchTopLevelScreenSnapshot('backups', '/backups');
    return snapshot;
  }

  async function ensureRuntimeApi(boot = false) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolveBackupsBootstrapModule();
    if (boot) {
      runtimeApi = await mod.bootBackupsScreen();
      initialized = true;
      return runtimeApi;
    }

    runtimeApi = mod.getBackupsTopLevelApi();
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
      if (!runtimeApi && isBackupsLocation()) {
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

export function registerBackupsTopLevelScreen() {
  const registry = getTopLevelScreenRegistryApi();
  const screen = createBackupsScreen();
  registry.registerScreen('backups', screen);
  if (isBackupsLocation()) {
    Promise.resolve(screen.mount()).catch(() => {});
  }
  return screen;
}
