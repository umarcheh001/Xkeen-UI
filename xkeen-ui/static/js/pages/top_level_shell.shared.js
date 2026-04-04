import { getTopLevelRouterApi, resolveTopLevelRoute } from './top_level_router.js';
import {
  getTopLevelScreenRegistryApi,
  normalizeTopLevelScreenName,
} from './top_level_screen_registry.js';

function getWindowRef() {
  try {
    return window || null;
  } catch (error) {
    return null;
  }
}

function createCurrentDocumentScreen(name, bootstrap) {
  let mounted = false;

  return {
    name,
    async mount(context) {
      if (mounted) return;
      mounted = true;
      await bootstrap(context);
    },
    activate() {},
    deactivate() {},
    dispose() {},
    isMounted() {
      return mounted;
    },
  };
}

export async function bootTopLevelShell(opts) {
  const name = normalizeTopLevelScreenName(opts && opts.initialScreen);
  const bootstrap = opts && typeof opts.bootstrap === 'function' ? opts.bootstrap : null;
  const onError = opts && typeof opts.onError === 'function' ? opts.onError : null;
  if (!name || !bootstrap) return null;

  const registry = getTopLevelScreenRegistryApi();
  const router = getTopLevelRouterApi();
  const route = resolveTopLevelRoute(getWindowRef()?.location?.href || '') || null;
  const screen = createCurrentDocumentScreen(name, bootstrap);

  registry.registerScreen(name, screen);
  router.bootstrapCurrentScreen({
    initialScreen: name,
    route: route ? route.url : '',
  });

  try {
    await screen.mount({
      router,
      route: route || router.getActiveRoute(),
      trigger: 'bootstrap',
      reason: 'bootstrap',
    });
    return router;
  } catch (error) {
    if (onError) {
      onError(error);
    } else {
      try { console.error('[XKeen] top-level shell bootstrap failed', error); } catch (secondaryError) {}
    }
    return null;
  }
}
