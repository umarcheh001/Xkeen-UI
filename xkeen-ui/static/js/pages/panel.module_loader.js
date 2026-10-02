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
  'editor-codemirror': () => import('./panel.editor.codemirror.bundle.js'),
  'editor-monaco': () => import('./panel.editor.monaco.bundle.js'),
  'editor-diff': () => import('./panel.editor.diff.bundle.js'),
  'editor-enhancements': () => import('./panel.editor.enhancements.bundle.js'),
});

const STYLE_URLS = Object.freeze({
  xterm: new URL('../../xterm/xterm.css', import.meta.url).href,
});

const modulePromises = Object.create(null);
const moduleResults = Object.create(null);
const reportedFailures = new Set();
const stylePromises = Object.create(null);

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

function getEditorDescriptor() {
  const editor = getFrontendModules().editor;
  return editor && typeof editor === 'object' ? editor : {};
}

function hasEditorCapability(capability) {
  const key = String(capability || '').trim();
  const capabilities = getEditorDescriptor().capabilities;
  return !!(key && Array.isArray(capabilities) && capabilities.includes(key));
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

function ensureModuleStyle(cssKey) {
  const key = String(cssKey || '');
  const href = STYLE_URLS[key];
  if (!href) return Promise.resolve(false);
  if (stylePromises[key]) return stylePromises[key];

  stylePromises[key] = new Promise((resolve, reject) => {
    const selector = `link[data-xk-module-css="${key}"]`;
    const existing = document.head?.querySelector(selector);
    if (existing) {
      resolve(true);
      return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.xkModuleCss = key;
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => reject(new Error(`failed to load module stylesheet: ${key}`)), { once: true });
    document.head.appendChild(link);
  }).catch((error) => {
    delete stylePromises[key];
    throw error;
  });

  return stylePromises[key];
}

export async function ensurePanelModuleStyles(key) {
  const descriptor = descriptorFor(key);
  if (!descriptor || !hasOwnedRoot(descriptor.domRoots)) return false;
  const cssKeys = Array.isArray(descriptor.cssKeys) ? descriptor.cssKeys : [];
  await Promise.all(cssKeys.map((cssKey) => ensureModuleStyle(cssKey)));
  return true;
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
    .then(() => ensurePanelModuleStyles(normalized))
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

export function getPanelEditorDescriptor() {
  return getEditorDescriptor();
}

export function isPanelEditorCapabilityActive(capability) {
  return hasEditorCapability(capability);
}

export const panelModuleLoaderApi = Object.freeze({
  ensure: ensurePanelModule,
  ensureForView: ensurePanelModuleForView,
  getApi: getPanelModuleApi,
  isActive: isPanelModuleActive,
  getDescriptor: getPanelFrontendDescriptor,
  getEditorDescriptor: getPanelEditorDescriptor,
  isEditorCapabilityActive: isPanelEditorCapabilityActive,
  ensureStyles: ensurePanelModuleStyles,
});
