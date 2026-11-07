// After a panel update: stop the browser from mixing old and new static files.
//
// Untouched static files are served with a short no-revalidation window
// (routes/ui_assets.py: get_static_asset_max_age), and ES module imports carry
// no ?v= parameter. A panel opened right before an update therefore kept
// running old modules from the browser cache for up to ten minutes after it.
// The server cannot revoke a max-age it has already sent, so the page (always
// no-store) carries the build stamp, and this script:
//   - remembers which static files this browser has loaded (they are what may
//     sit in its cache, including lazily imported modules);
//   - when the stamp changes, revalidates them with bounded concurrency and
//     reloads the page after every request has succeeded.
(() => {
  'use strict';

  const script = document.currentScript;
  const stamp = script ? String(script.getAttribute('data-build-stamp') || '') : '';
  const staticBase = script ? String(script.getAttribute('data-static-base') || '/static/') : '/static/';
  if (!stamp) return;

  const STAMP_KEY = 'xkeen-ui-build-stamp';
  const SEEN_KEY = 'xkeen-ui-static-seen-v1';
  const SEEN_LIMIT = 800;
  const REFETCH_TIMEOUT_MS = 15000;
  const REFETCH_CONCURRENCY = 4;
  const LOAD_FALLBACK_MS = 8000;

  // Same rule as routes/ui_assets.py (_IMMUTABLE_ASSET_ROOTS and
  // _HASHED_ASSET_BASENAME_RE): such files are unique per build already.
  const IMMUTABLE_ROOTS = ['frontend-build/assets/', 'frontend-build/modules/', 'assets/', 'monaco-editor/'];
  const HASHED_BASENAME_RE = /^.+\-[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9]+$/;

  let storage = null;
  try {
    storage = window.localStorage;
    storage.getItem(STAMP_KEY);
  } catch (e) {
    return;
  }

  function trackedKey(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch (e) {
      return '';
    }
    if (url.origin !== location.origin) return '';
    if (url.pathname.indexOf(staticBase) !== 0) return '';
    const rel = url.pathname.slice(staticBase.length);
    if (!rel) return '';
    // This script is addressed by the build stamp, a new build means a new URL.
    if (script.src && url.pathname === new URL(script.src, location.href).pathname) return '';
    const basename = rel.slice(rel.lastIndexOf('/') + 1);
    for (const root of IMMUTABLE_ROOTS) {
      if (rel.indexOf(root) === 0 && HASHED_BASENAME_RE.test(basename)) return '';
    }
    return url.pathname + url.search;
  }

  function readSeen() {
    try {
      const parsed = JSON.parse(storage.getItem(SEEN_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(trackedKey).filter(Boolean).slice(-SEEN_LIMIT) : [];
    } catch (e) {
      return [];
    }
  }

  function writeSeen(list) {
    try {
      storage.setItem(SEEN_KEY, JSON.stringify(list.slice(-SEEN_LIMIT)));
    } catch (e) {}
  }

  // --- Remember what this browser loads -------------------------------------

  const pendingSeen = new Set();
  let persistTimer = 0;

  function persistSeen() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    if (!pendingSeen.size) return;
    // Merge with what other tabs stored meanwhile; recently seen go last so the
    // limit drops the oldest.
    const merged = readSeen().filter((key) => !pendingSeen.has(key));
    pendingSeen.forEach((key) => merged.push(key));
    pendingSeen.clear();
    writeSeen(merged);
  }

  function noteEntries(entries) {
    for (const entry of entries) {
      const key = trackedKey(entry && entry.name);
      if (key) pendingSeen.add(key);
    }
    if (pendingSeen.size && !persistTimer) persistTimer = setTimeout(persistSeen, 1500);
  }

  try {
    const observer = new PerformanceObserver((list) => noteEntries(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
  } catch (e) {}
  window.addEventListener('pagehide', persistSeen);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSeen();
  });

  // --- React to a new build --------------------------------------------------

  const previous = storage.getItem(STAMP_KEY);
  if (previous === stamp) return;
  const seenBefore = readSeen();

  function servedFromCache() {
    const keys = [];
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        const key = trackedKey(entry.name);
        if (key && entry.transferSize === 0 && entry.decodedBodySize > 0) keys.push(key);
      }
    } catch (e) {}
    return keys;
  }

  async function refresh() {
    const cachedNow = servedFromCache();
    const keys = Array.from(new Set(seenBefore.concat(cachedNow)));
    // A browser that meets the stamp for the first time only needs a reload
    // when this very page actually ran something from its cache.
    const needsReload = previous !== null || cachedNow.length > 0;
    if (keys.length) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REFETCH_TIMEOUT_MS);
      const gone = new Set();
      let next = 0;
      let failed = false;
      async function worker() {
        while (next < keys.length && !failed && !controller.signal.aborted) {
          const key = keys[next++];
          try {
            const response = await fetch(key, {
              cache: 'no-cache', credentials: 'same-origin', signal: controller.signal,
            });
            if (response.status === 404) {
              gone.add(key);
            } else if (!response.ok) {
              failed = true;
              controller.abort();
            } else {
              await response.arrayBuffer();
            }
          } catch (e) {
            failed = true;
            controller.abort();
          }
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(REFETCH_CONCURRENCY, keys.length) }, worker));
      } finally {
        clearTimeout(timer);
      }
      if (gone.size) writeSeen(readSeen().filter((key) => !gone.has(key)));
      if (failed || controller.signal.aborted) return false;
    }
    try {
      storage.setItem(STAMP_KEY, stamp);
    } catch (e) {
      return false;
    }
    if (needsReload) location.reload();
    return needsReload;
  }

  const done = new Promise((resolve) => {
    let started = false;
    const fallback = setTimeout(run, LOAD_FALLBACK_MS);
    function run() {
      if (started) return;
      started = true;
      clearTimeout(fallback);
      refresh().then(resolve, () => resolve(false));
    }
    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run, { once: true });
  });

  window.XKeen = window.XKeen || {};
  window.XKeen.buildRefresh = { stamp, previous, done };
})();
