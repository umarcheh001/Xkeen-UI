// Stage 5 panel frontend loader.
//
// The server announces only stable bundle keys. Import factories live here so
// persisted module state can never turn into an executable browser specifier.

const BUNDLE_LOADERS = Object.freeze({
  'panel-core': () => Promise.resolve({}),
  'panel-routing': () => import('./panel.routing.bundle.js'),
  'panel-mihomo': () => import('./panel.mihomo.bundle.js'),
  'terminal-lazy': () => import('./terminal.lazy.entry.js'),
  'file-manager-lazy': () => import('./file_manager.lazy.entry.js'),
  'diagnostics-panel': () => import('./panel.diagnostics.bundle.js'),
  'editor-runtime': () => import('./panel.editor.bundle.js'),
});

const modulePromises = Object.create(null);
const moduleResults = Object.create(null);
const reportedFailures = new Set();

function getPageConfig() {
  try {
    const config = window.XKeen?.pageConfig;
    return config && typeof config === 'object' ? config : {};
  } catch (error) {
    return {};
  }
}

function getFrontendModules() {
  const frontendModules = getPageConfig().frontendModules;
  return frontendModules && typeof frontendModules === 'object' ? frontendModules : {};
}

function getBundles() {
  const bundles = getFrontendModules().bundles;
  return Array.isArray(bundles) ? bundles : [];
}

function descriptorFor(key) {
  const normalized = String(key || '');
  return getBundles().find((bundle) => bundle && bundle.key === normalized) || null;
}

function hasOwnedRoot(domRoots) {
  const roots = Array.isArray(domRoots) ? domRoots : [];
  if (!roots.length) return true;
  return roots.some((identifier) => {
    try {
      return !!document.getElementById(String(identifier || ''));
    } catch (error) {
      return false;
    }
  });
}

function result(status, key, api = null) {
  return { status, key: String(key || ''), api: api || null };
}

function reportFailureOnce(key, error) {
  const normalized = String(key || '');
  if (!normalized || reportedFailures.has(normalized)) return;
  reportedFailures.add(normalized);
  try { console.error('[XKeen] panel module failed:', normalized, error); } catch (secondaryError) {}
}

async function activateBundle(key, descriptor, mod, reason) {
  if (mod && typeof mod.activate === 'function') {
    const api = await mod.activate({ descriptor, reason: String(reason || '') });
    return result('ready', key, api || mod);
  }
  if (mod && typeof mod.ensureTerminalBundleReady === 'function') {
    await mod.ensureTerminalBundleReady();
  }
  if (mod && typeof mod.ensureFileManagerBundleReady === 'function') {
    await mod.ensureFileManagerBundleReady();
  }
  return result('ready', key, mod);
}

export function isPanelModuleActive(key) {
  return !!descriptorFor(key);
}

export function getPanelModuleApi(key) {
  const cached = moduleResults[String(key || '')];
  return cached && cached.status === 'ready' ? cached.api : null;
}

export async function ensurePanelModule(key, reason = '') {
  const normalized = String(key || '');
  const descriptor = descriptorFor(normalized);
  if (!descriptor) return result('inactive', normalized);
  if (!hasOwnedRoot(descriptor.domRoots)) return result('missing-root', normalized);

  if (moduleResults[normalized]) return moduleResults[normalized];
  if (modulePromises[normalized]) return modulePromises[normalized];

  const load = BUNDLE_LOADERS[normalized];
  if (typeof load !== 'function') {
    const failed = result('failed', normalized);
    moduleResults[normalized] = failed;
    reportFailureOnce(normalized, new Error('unknown panel module key'));
    return failed;
  }

  modulePromises[normalized] = Promise.resolve()
    .then(() => load())
    .then((mod) => activateBundle(normalized, descriptor, mod, reason))
    .then((loaded) => {
      moduleResults[normalized] = loaded;
      return loaded;
    })
    .catch((error) => {
      const failed = result('failed', normalized);
      moduleResults[normalized] = failed;
      reportFailureOnce(normalized, error);
      return failed;
    })
    .finally(() => {
      delete modulePromises[normalized];
    });

  return modulePromises[normalized];
}

export function ensurePanelModuleForView(view) {
  const normalized = String(view || '');
  const descriptor = getBundles().find((bundle) => (
    bundle && Array.isArray(bundle.views) && bundle.views.includes(normalized)
  ));
  if (!descriptor) return Promise.resolve(result('inactive', normalized));
  return ensurePanelModule(descriptor.key, `view:${normalized}`);
}

export function getPanelFrontendDescriptor() {
  return getFrontendModules();
}

export const panelModuleLoaderApi = Object.freeze({
  ensure: ensurePanelModule,
  ensureForView: ensurePanelModuleForView,
  getApi: getPanelModuleApi,
  isActive: isPanelModuleActive,
  getDescriptor: getPanelFrontendDescriptor,
});
