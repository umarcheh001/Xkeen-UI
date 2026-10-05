// The backups feature belongs to tool.backups. Screens that only offer a
// backup or restore button load it when that button is used, so a profile
// without the module does not download it together with the routing screen.

let backupsModulePromise = null;

export function loadBackupsFeatureApi() {
  if (!backupsModulePromise) {
    backupsModulePromise = import('./backups.js').catch((error) => {
      backupsModulePromise = null;
      throw error;
    });
  }
  return backupsModulePromise
    .then((mod) => (mod && typeof mod.getBackupsApi === 'function' ? mod.getBackupsApi() : null))
    .catch(() => null);
}
