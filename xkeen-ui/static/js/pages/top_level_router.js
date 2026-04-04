import { ensureXkeenRoot } from '../features/xkeen_runtime.js';
import {
  getTopLevelScreenRegistryApi,
  resolveTopLevelRoute,
  normalizeTopLevelScreenName,
} from './top_level_screen_registry.js';

const ROUTE_CHANGE_EVENT = 'xkeen:top-level-route-change';

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

function getLocationRef() {
  try {
    const win = getWindowRef();
    return win && win.location ? win.location : null;
  } catch (error) {
    return null;
  }
}

function getHistoryRef() {
  try {
    const win = getWindowRef();
    return win && win.history ? win.history : null;
  } catch (error) {
    return null;
  }
}

function toPlainRoute(route) {
  if (!route || typeof route !== 'object') return null;
  return {
    name: String(route.name || ''),
    pathname: String(route.pathname || ''),
    search: String(route.search || ''),
    hash: String(route.hash || ''),
    href: String(route.href || ''),
    url: String(route.url || ''),
  };
}

function coerceResolvedRoute(input) {
  if (!input) return null;
  if (input && typeof input === 'object' && typeof input.name === 'string' && typeof input.href === 'string') {
    return toPlainRoute(input);
  }
  return resolveTopLevelRoute(input);
}

function getCurrentRouteFromLocation() {
  const locationRef = getLocationRef();
  return locationRef ? resolveTopLevelRoute(locationRef.href) : null;
}

function scrollToHash(hash) {
  const value = String(hash || '').trim();
  if (!value || value === '#') return false;

  try {
    const id = decodeURIComponent(value.slice(1));
    if (!id) return false;
    const node = document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`);
    if (!node || typeof node.scrollIntoView !== 'function') return false;
    node.scrollIntoView({ block: 'start', inline: 'nearest' });
    return true;
  } catch (error) {
    return false;
  }
}

function pushHistoryState(route, replace) {
  const historyRef = getHistoryRef();
  if (!historyRef || !route) return false;

  try {
    const fn = replace ? historyRef.replaceState : historyRef.pushState;
    if (typeof fn !== 'function') return false;
    fn.call(historyRef, {
      xkeenTopLevelRoute: route.name,
      href: route.href,
    }, '', route.href);
    return true;
  } catch (error) {
    return false;
  }
}

function hardNavigate(route, replace) {
  const locationRef = getLocationRef();
  const nextUrl = route && typeof route === 'object'
    ? String(route.url || route.href || '')
    : String(route || '');
  if (!locationRef || !nextUrl) return false;

  try {
    if (replace && typeof locationRef.replace === 'function') {
      locationRef.replace(nextUrl);
    } else if (typeof locationRef.assign === 'function') {
      locationRef.assign(nextUrl);
    } else {
      locationRef.href = nextUrl;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function dispatchRouteChange(detail) {
  try {
    const win = getWindowRef();
    if (!win || typeof win.dispatchEvent !== 'function') return;
    win.dispatchEvent(new CustomEvent(ROUTE_CHANGE_EVENT, { detail }));
  } catch (error) {}
}

function createTopLevelRouterApi() {
  const registry = getTopLevelScreenRegistryApi();
  const state = {
    started: false,
    activeRoute: null,
    activeScreenName: '',
    currentScreenMounted: false,
    transitionChain: Promise.resolve(),
  };

  function getActiveRoute() {
    return state.activeRoute ? toPlainRoute(state.activeRoute) : getCurrentRouteFromLocation();
  }

  function emitRouteChange(route, meta) {
    const detail = {
      route: toPlainRoute(route),
      screen: String((route && route.name) || state.activeScreenName || ''),
      trigger: String((meta && meta.trigger) || ''),
      reason: String((meta && meta.reason) || ''),
      replace: !!(meta && meta.replace),
      inApp: !!(meta && meta.inApp),
      initial: !!(meta && meta.initial),
    };
    dispatchRouteChange(detail);
  }

  async function runScreenLifecycle(screen, method, context) {
    if (!screen || typeof screen[method] !== 'function') return;
    await screen[method](context);
  }

  async function transitionToRoute(route, meta) {
    const currentRoute = getActiveRoute();
    const currentScreen = registry.getScreen(state.activeScreenName);
    const nextScreen = registry.getScreen(route.name);
    if (!nextScreen) return false;

    if (currentScreen !== nextScreen || !state.currentScreenMounted) {
      await runScreenLifecycle(nextScreen, 'mount', {
        router: api,
        route,
        trigger: meta.trigger,
        reason: meta.reason,
      });
    }

    if (currentScreen && currentScreen !== nextScreen) {
      await runScreenLifecycle(currentScreen, 'deactivate', {
        router: api,
        from: currentRoute,
        to: route,
        trigger: meta.trigger,
        reason: meta.reason,
      });
    }

    state.currentScreenMounted = true;
    state.activeRoute = toPlainRoute(route);
    state.activeScreenName = route.name;

    await runScreenLifecycle(nextScreen, 'activate', {
      router: api,
      route,
      previousRoute: currentRoute,
      trigger: meta.trigger,
      reason: meta.reason,
    });

    emitRouteChange(route, Object.assign({}, meta, { inApp: true }));
    scrollToHash(route.hash);
    return true;
  }

  function queueTransition(route, meta) {
    state.transitionChain = state.transitionChain
      .catch(() => {})
      .then(async () => {
        try {
          await transitionToRoute(route, meta);
        } catch (error) {
          try { console.error('[XKeen] top-level router transition failed', error); } catch (secondaryError) {}
          hardNavigate(route, true);
        }
      });
    return true;
  }

  function handleSameScreenNavigation(route, meta) {
    state.activeRoute = toPlainRoute(route);
    state.activeScreenName = route.name;
    emitRouteChange(route, Object.assign({}, meta, { inApp: true }));
    scrollToHash(route.hash);
    return true;
  }

  function navigate(input, opts) {
    const route = resolveTopLevelRoute(input);
    if (!route) return false;

    const currentRoute = getActiveRoute();
    const currentScreenName = normalizeTopLevelScreenName(state.activeScreenName || (currentRoute && currentRoute.name));
    const replace = !!(opts && opts.replace);
    const meta = {
      trigger: String((opts && opts.trigger) || 'programmatic'),
      reason: String((opts && opts.reason) || 'navigate'),
      replace,
    };

    if (!currentRoute) return false;

    if (currentRoute.href === route.href) {
      scrollToHash(route.hash);
      return true;
    }

    if (currentScreenName && route.name === currentScreenName) {
      pushHistoryState(route, replace);
      return handleSameScreenNavigation(route, meta);
    }

    if (!registry.hasScreen(route.name)) return false;

    pushHistoryState(route, replace);
    return queueTransition(route, meta);
  }

  function handlePopstate() {
    const route = getCurrentRouteFromLocation();
    if (!route) return;

    const currentScreenName = normalizeTopLevelScreenName(state.activeScreenName || (state.activeRoute && state.activeRoute.name));
    if (route.name === currentScreenName) {
      handleSameScreenNavigation(route, {
        trigger: 'popstate',
        reason: 'popstate',
        replace: true,
      });
      return;
    }

    if (!registry.hasScreen(route.name)) {
      hardNavigate(route, true);
      return;
    }

    queueTransition(route, {
      trigger: 'popstate',
      reason: 'popstate',
      replace: true,
    });
  }

  function start() {
    if (state.started) return api;

    const win = getWindowRef();
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('popstate', handlePopstate);
    }

    state.started = true;
    return api;
  }

  function bootstrapCurrentScreen(opts) {
    const name = normalizeTopLevelScreenName(opts && opts.initialScreen);
    const route = coerceResolvedRoute(opts && opts.route) || getCurrentRouteFromLocation();
    const nextRoute = route && route.name ? route : null;
    if (!name && !nextRoute) return api;

    state.activeScreenName = name || (nextRoute && nextRoute.name) || '';
    state.activeRoute = toPlainRoute(nextRoute);
    state.currentScreenMounted = false;
    start();

    if (nextRoute) {
      emitRouteChange(nextRoute, {
        trigger: 'bootstrap',
        reason: 'bootstrap',
        initial: true,
        replace: true,
        inApp: false,
      });
    }

    return api;
  }

  const api = {
    start,
    navigate,
    hardNavigate,
    bootstrapCurrentScreen,
    getActiveRoute,
    getActiveScreenName() {
      return state.activeScreenName || '';
    },
    hasScreen(name) {
      return registry.hasScreen(name);
    },
    listScreens() {
      return registry.listScreens();
    },
    eventName: ROUTE_CHANGE_EVENT,
  };

  return api;
}

let _topLevelRouterApi = null;

export function getTopLevelRouterApi() {
  if (_topLevelRouterApi) return _topLevelRouterApi;

  try {
    const root = ensureTopLevelRoot();
    if (root && root.router && typeof root.router === 'object') {
      _topLevelRouterApi = root.router;
      return _topLevelRouterApi;
    }
  } catch (error) {}

  _topLevelRouterApi = createTopLevelRouterApi();

  try {
    const root = ensureTopLevelRoot();
    if (root) root.router = _topLevelRouterApi;
  } catch (error) {}

  return _topLevelRouterApi;
}

export { resolveTopLevelRoute, ROUTE_CHANGE_EVENT };
