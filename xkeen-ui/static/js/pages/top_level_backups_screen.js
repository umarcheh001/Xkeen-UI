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

function hasBackupsSnapshotMarkers(snapshot) {
  const root = snapshot && snapshot.root ? snapshot.root : null;
  if (!root || typeof root.querySelector !== 'function') return false;

  try {
    if (root.querySelector('.xk-backups-page-header')) return true;
    if (root.querySelector('#backups-table')) return true;
    if (root.querySelector('#backups-status')) return true;
  } catch (error) {}

  return false;
}

function hasBackupsDomHost() {
  try {
    return !!(
      document.querySelector('.xk-backups-page-header') ||
      document.getElementById('backups-table') ||
      document.getElementById('backups-status')
    );
  } catch (error) {
    return false;
  }
}

function createBackupsScreen() {
  let snapshot = null;
  let runtimeApi = null;
  let initialized = false;
  let serializedState = null;
  const activation = createScreenActivationTracker();

  async function ensureSnapshot() {
    if (snapshot) return snapshot;
    snapshot = isBackupsLocation()
      ? captureCurrentDocumentScreenSnapshot('backups')
      : await fetchTopLevelScreenSnapshot('backups', '/backups');

    if (!snapshot || !snapshot.root) {
      throw new Error('backups snapshot root missing');
    }

    if (!snapshot.isCurrentDocument && !hasBackupsSnapshotMarkers(snapshot)) {
      throw new Error('backups snapshot missing required host markers');
    }

    return snapshot;
  }

  async function ensureRuntimeApi(boot = false, isCurrent = null) {
    if (runtimeApi && !boot) return runtimeApi;

    const mod = await resolveBackupsBootstrapModule();
    if (boot) {
      // The screen was left while its scripts were loading: do not start it
      // against markup that is no longer on the page.
      if (typeof isCurrent === 'function' && !isCurrent()) return null;
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
      if (!attachScreenRoot(nextSnapshot)) {
        throw new Error('backups screen root attach failed');
      }
      if (!hasBackupsDomHost()) {
        throw new Error('backups screen host markers missing after attach');
      }

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
