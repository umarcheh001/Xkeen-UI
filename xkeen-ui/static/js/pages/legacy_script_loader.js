const SCRIPT_REGISTRY_KEY = '__XKEEN_LEGACY_SCRIPT_REGISTRY__';
const ENTRY_REGISTRY_KEY = '__XKEEN_LEGACY_ENTRY_REGISTRY__';

function getGlobalRegistry(key) {
  const scope = window;
  if (!scope[key] || typeof scope[key] !== 'object') {
    scope[key] = Object.create(null);
  }
  return scope[key];
}

function waitForExistingScript(script, src) {
  if (!script) return null;
  if (script.dataset && script.dataset.xkLoaded === '1') {
    return Promise.resolve(script);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      try {
        script.dataset.xkLoaded = '1';
      } catch (_) {}
      resolve(script);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to load legacy script: ${src}`));
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
  });
}

function findExistingScript(src) {
  const scripts = document.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i += 1) {
    const script = scripts[i];
    try {
      if (script.src === src) return script;
    } catch (_) {}
  }
  return null;
}

export function toAssetUrl(relativePath) {
  return new URL(relativePath, import.meta.url).href;
}

export function loadLegacyScriptsSequentially(urls) {
  const registry = getGlobalRegistry(SCRIPT_REGISTRY_KEY);
  const queue = Array.isArray(urls) ? urls.filter(Boolean) : [];

  return queue.reduce((chain, src) => chain.then(() => {
    const existing = registry[src];
    if (existing) {
      if (existing.loaded) return existing.node || true;
      return existing.promise;
    }

    const present = findExistingScript(src);
    if (present) {
      const promise = waitForExistingScript(present, src);
      registry[src] = { loaded: false, promise, node: present };
      return promise.then((node) => {
        registry[src] = { loaded: true, promise: Promise.resolve(node), node };
        return node;
      });
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = false;

    const promise = new Promise((resolve, reject) => {
      script.addEventListener('load', () => {
        try {
          script.dataset.xkLoaded = '1';
        } catch (_) {}
        registry[src] = { loaded: true, promise: Promise.resolve(script), node: script };
        resolve(script);
      }, { once: true });
      script.addEventListener('error', () => {
        delete registry[src];
        reject(new Error(`Failed to load legacy script: ${src}`));
      }, { once: true });
    });

    registry[src] = { loaded: false, promise, node: script };
    (document.head || document.body || document.documentElement).appendChild(script);
    return promise;
  }), Promise.resolve());
}

export function bootLegacyEntry(entryName, urls) {
  const registry = getGlobalRegistry(ENTRY_REGISTRY_KEY);
  const key = String(entryName || 'default');
  if (registry[key]) return registry[key];

  registry[key] = loadLegacyScriptsSequentially(urls).catch((error) => {
    try {
      console.error(`[xkeen-ui] ${key} entry bootstrap failed`, error);
    } catch (_) {}
    delete registry[key];
    throw error;
  });

  return registry[key];
}
