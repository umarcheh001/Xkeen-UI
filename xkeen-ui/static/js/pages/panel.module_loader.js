// Stage 5 panel frontend loader.
//
// The server announces only stable bundle keys. Import factories live here so
// persisted module state can never turn into an executable browser specifier.

import { toastXkeen } from '../features/xkeen_runtime.js';

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

// A browser keeps a failed module fetch in its module map, so importing the
// same specifier again never reaches the network. A retry therefore asks for
// the bundle entry under a fresh query string; the keys and files here mirror
// BUNDLE_LOADERS.
const BUNDLE_SOURCES = Object.freeze({
  'panel-routing': './panel.routing.bundle.js',
  'panel-mihomo': './panel.mihomo.bundle.js',
  'terminal-lazy': './terminal.lazy.entry.js',
  'file-manager-lazy': './file_manager.lazy.entry.js',
  'diagnostics-panel': './panel.diagnostics.bundle.js',
  'editor-runtime': './panel.editor.bundle.js',
  'editor-codemirror': './panel.editor.codemirror.bundle.js',
  'editor-monaco': './panel.editor.monaco.bundle.js',
  'editor-diff': './panel.editor.diff.bundle.js',
  'editor-enhancements': './panel.editor.enhancements.bundle.js',
});

const STYLE_URLS = Object.freeze({
  xterm: new URL('../../xterm/xterm.css', import.meta.url).href,
});

// The link to a router drops for a few seconds whenever the proxy core
// restarts, so a bundle that failed to download is asked for again: twice on
// its own, and then on every later request instead of staying dead until the
// page is reloaded. A file deeper in the bundle that failed stays failed in
// the browser, which is why the notice also mentions reloading the page.
const LOAD_RETRY_DELAYS_MS = Object.freeze([1500, 4000]);
const FAILURE_NOTICE_GAP_MS = 8000;

const modulePromises = Object.create(null);
const moduleResults = Object.create(null);
const reportedFailures = new Set();
const failureNoticeAt = Object.create(null);
const loadAttempts = Object.create(null);
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

export function notifyPanelLoadFailure(key) {
  const normalized = String(key || '');
  const now = Date.now();
  if (failureNoticeAt[normalized] && (now - failureNoticeAt[normalized]) < FAILURE_NOTICE_GAP_MS) return;
  failureNoticeAt[normalized] = now;
  try {
    toastXkeen('Не удалось загрузить часть панели. Проверьте связь с роутером и повторите действие; если не поможет — обновите страницу.', 'error');
  } catch (error) {}
}

function wait(delayMs) {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

function importBundle(key, load) {
  const attempt = loadAttempts[key] || 0;
  loadAttempts[key] = attempt + 1;
  const source = BUNDLE_SOURCES[key];
  if (!attempt || !source) return load();
  const url = new URL(source, import.meta.url);
  url.searchParams.set('xk-retry', String(attempt));
  return import(/* @vite-ignore */ url.href);
}

async function loadWithRetry(key, load) {
  let lastError = null;
  for (let attempt = 0; attempt <= LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await wait(LOAD_RETRY_DELAYS_MS[attempt - 1]);
    try {
      await ensurePanelModuleStyles(key);
      return await importBundle(key, load);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
    link.addEventListener('error', () => {
      // A dead link left in the page would pass for a loaded stylesheet.
      link.remove();
      reject(new Error(`failed to load module stylesheet: ${key}`));
    }, { once: true });
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

  modulePromises[normalized] = loadWithRetry(normalized, load)
    .then((mod) => activateBundle(normalized, descriptor, mod, reason).then((loaded) => {
      moduleResults[normalized] = loaded;
      return loaded;
    }, (error) => {
      // The code arrived and broke while starting: asking again would run a
      // half-initialised bundle twice, so this failure stays.
      const failed = result('failed', normalized);
      moduleResults[normalized] = failed;
      reportFailureOnce(normalized, error);
      notifyPanelLoadFailure(normalized);
      return failed;
    }), (error) => {
      // Nothing was cached, the next request downloads the bundle again.
      reportFailureOnce(normalized, error);
      notifyPanelLoadFailure(normalized);
      return result('failed', normalized);
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
