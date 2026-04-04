import { ensureXkeenRoot } from '../features/xkeen_runtime.js';

const TOP_LEVEL_SCREEN_ROUTES = Object.freeze({
  panel: '/',
  devtools: '/devtools',
  mihomo_generator: '/mihomo_generator',
});

function ensureTopLevelRoot() {
  try {
    const xk = ensureXkeenRoot();
    if (!xk) return null;
    xk.topLevel = xk.topLevel && typeof xk.topLevel === 'object' ? xk.topLevel : {};
    return xk.topLevel;
  } catch (error) {
    return null;
  }
}

function getWindowRef() {
  try {
    return window || null;
  } catch (error) {
    return null;
  }
}

function normalizePathname(pathname) {
  const raw = String(pathname || '').trim() || '/';
  if (raw === '/') return '/';
  return raw.replace(/\/+$/, '') || '/';
}

function getLocationHref() {
  try {
    const win = getWindowRef();
    return win && win.location ? String(win.location.href || '') : '';
  } catch (error) {
    return '';
  }
}

function getLocationOrigin() {
  try {
    const win = getWindowRef();
    return win && win.location ? String(win.location.origin || '') : '';
  } catch (error) {
    return '';
  }
}

export function normalizeTopLevelScreenName(name) {
  const key = String(name || '').trim();
  if (!key) return '';
  return Object.prototype.hasOwnProperty.call(TOP_LEVEL_SCREEN_ROUTES, key) ? key : '';
}

export function getTopLevelScreenRouteMap() {
  return TOP_LEVEL_SCREEN_ROUTES;
}

export function getTopLevelScreenRoute(name) {
  const key = normalizeTopLevelScreenName(name);
  return key ? TOP_LEVEL_SCREEN_ROUTES[key] : '';
}

export function listTopLevelScreenNames() {
  return Object.keys(TOP_LEVEL_SCREEN_ROUTES);
}

export function resolveTopLevelRoute(input) {
  const origin = getLocationOrigin();
  if (!origin) return null;

  try {
    const url = input instanceof URL
      ? new URL(input.toString())
      : new URL(String(input || '').trim() || getLocationHref() || '/', getLocationHref() || (origin + '/'));
    if (String(url.origin || '') !== origin) return null;

    const pathname = normalizePathname(url.pathname);
    const name = listTopLevelScreenNames().find((candidate) => TOP_LEVEL_SCREEN_ROUTES[candidate] === pathname) || '';
    if (!name) return null;

    return {
      name,
      pathname,
      search: String(url.search || ''),
      hash: String(url.hash || ''),
      href: pathname + String(url.search || '') + String(url.hash || ''),
      url: url.toString(),
    };
  } catch (error) {
    return null;
  }
}

function createTopLevelScreenRegistryApi() {
  const screens = new Map();

  return {
    registerScreen(name, screen) {
      const key = normalizeTopLevelScreenName(name);
      if (!key || !screen || typeof screen !== 'object') return null;
      screens.set(key, screen);
      return screen;
    },
    unregisterScreen(name) {
      const key = normalizeTopLevelScreenName(name);
      if (!key) return false;
      return screens.delete(key);
    },
    getScreen(name) {
      const key = normalizeTopLevelScreenName(name);
      return key ? (screens.get(key) || null) : null;
    },
    hasScreen(name) {
      const key = normalizeTopLevelScreenName(name);
      return !!(key && screens.has(key));
    },
    listScreens() {
      return Array.from(screens.keys());
    },
    getRoute(name) {
      return getTopLevelScreenRoute(name);
    },
    resolveRoute(input) {
      return resolveTopLevelRoute(input);
    },
  };
}

let _topLevelScreenRegistryApi = null;

export function getTopLevelScreenRegistryApi() {
  if (_topLevelScreenRegistryApi) return _topLevelScreenRegistryApi;

  try {
    const root = ensureTopLevelRoot();
    if (root && root.screenRegistry && typeof root.screenRegistry === 'object') {
      _topLevelScreenRegistryApi = root.screenRegistry;
      return _topLevelScreenRegistryApi;
    }
  } catch (error) {}

  _topLevelScreenRegistryApi = createTopLevelScreenRegistryApi();

  try {
    const root = ensureTopLevelRoot();
    if (root) root.screenRegistry = _topLevelScreenRegistryApi;
  } catch (error) {}

  return _topLevelScreenRegistryApi;
}
