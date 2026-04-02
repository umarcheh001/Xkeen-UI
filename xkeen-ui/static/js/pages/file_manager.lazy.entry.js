// Build-managed lazy bundle for file-manager runtime.
// Keeps the original side-effect ordering, but moves loading to standard import().

const FILE_MANAGER_IMPORTS = [
  '../features/file_manager_namespace.js',
  '../features/file_manager/common.js',
  '../features/file_manager/api.js',
  '../features/file_manager/errors.js',
  '../features/file_manager/progress.js',
  '../features/file_manager/prefs.js',
  '../features/file_manager/state.js',
  '../features/file_manager/bookmarks.js',
  '../features/file_manager/terminal.js',
  '../features/file_manager/list_model.js',
  '../features/file_manager/status.js',
  '../features/file_manager/storage.js',
  '../features/file_manager/render.js',
  '../features/file_manager/listing.js',
  '../features/file_manager/selection.js',
  '../features/file_manager/transfers.js',
  '../features/file_manager/remote.js',
  '../features/file_manager/ops.js',
  '../features/file_manager/actions.js',
  '../features/file_manager/props.js',
  '../features/file_manager/hash.js',
  '../features/file_manager/actions_modals.js',
  '../features/file_manager/dragdrop.js',
  '../features/file_manager/context_menu.js',
  '../features/file_manager/chrome.js',
  '../features/file_manager/editor.js',
  '../features/file_manager/navigation.js',
  '../features/file_manager/wire.js',
  '../features/file_manager.js',
  '../features/file_manager/init.js',
];

let fileManagerBundlePromise = null;

export async function ensureFileManagerBundleReady() {
  if (fileManagerBundlePromise) return fileManagerBundlePromise;

  fileManagerBundlePromise = (async () => {
    for (const specifier of FILE_MANAGER_IMPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await import(specifier);
    }
    return true;
  })().catch((error) => {
    fileManagerBundlePromise = null;
    throw error;
  });

  return fileManagerBundlePromise;
}

export { FILE_MANAGER_IMPORTS };
