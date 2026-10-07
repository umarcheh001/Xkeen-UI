import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/dat/prefs.js
  DAT card prefs + path helpers.

  RC-06a

  The folder, the file name and the download address of each DAT file are
  kept on the router, in the UI settings (routing.dat). The browser storage
  used to be their only home, so another browser, another port of the panel
  or a visit by name instead of by address showed the shipped values again.
  It is still written, as a copy for the moment before the settings arrive
  and for a router that cannot be reached.
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.state = RC.state || {};

  RC.dat = RC.dat || {};
  const DAT = RC.dat;

  const LS_KEYS = RC.LS_KEYS || {};
  const PREF_KEY = (LS_KEYS.datPrefs || 'xk.routing.dat.prefs.v1');
  const KINDS = ['geosite', 'geoip'];
  const FIELDS = ['dir', 'name', 'url'];
  const PUSH_DELAY_MS = 400;

  const DEFAULTS = {
    geosite: {
      dir: '/opt/etc/xray/dat',
      name: 'geosite.dat',
      url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
    },
    geoip: {
      dir: '/opt/etc/xray/dat',
      name: 'geoip.dat',
      url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat',
    },
  };

  // What the operator has just typed and the router has not confirmed yet.
  // It outranks everything: the answer of the router may be seconds away.
  let pending = null;
  let pushTimer = null;
  let migrated = false;

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function normalizePath(dir, name) {
    const d = String(dir || '').trim().replace(/\/+$/g, '');
    const n = String(name || '').trim().replace(/^\/+/, '');
    if (!d) return '/' + n;
    if (!n) return d;
    return d + '/' + n;
  }

  function mergeKindDefaults(kind, value) {
    const k = String(kind || '').toLowerCase() === 'geoip' ? 'geoip' : 'geosite';
    const merged = { ...(DEFAULTS[k] || {}), ...((value && typeof value === 'object') ? value : {}) };

    if (!String(merged.dir || '').trim()) merged.dir = DEFAULTS[k].dir;
    if (!String(merged.name || '').trim()) merged.name = DEFAULTS[k].name;
    if (!String(merged.url || '').trim()) merged.url = DEFAULTS[k].url;

    return merged;
  }

  function settingsApi() {
    const api = XK.ui && XK.ui.settings;
    return (api && typeof api.get === 'function') ? api : null;
  }

  function onlyKnownFields(value) {
    const out = {};
    KINDS.forEach((kind) => {
      const source = value && typeof value === 'object' ? value[kind] : null;
      if (!source || typeof source !== 'object') return;
      const kept = {};
      FIELDS.forEach((field) => {
        if (typeof source[field] === 'string') kept[field] = source[field].trim();
      });
      if (Object.keys(kept).length) out[kind] = kept;
    });
    return out;
  }

  // null: the settings of the router have not arrived yet.
  function routerPrefs() {
    try {
      const api = settingsApi();
      if (!api) return null;
      if (typeof api.isLoadedFromServer === 'function' && !api.isLoadedFromServer()) return null;
      const settings = api.get();
      return onlyKnownFields(settings && settings.routing ? settings.routing.dat : null);
    } catch (e) {
      return null;
    }
  }

  function browserPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      return raw ? onlyKnownFields(JSON.parse(raw)) : {};
    } catch (e) {
      return {};
    }
  }

  function load() {
    const fromBrowser = browserPrefs();
    const fromRouter = routerPrefs() || {};
    const typed = pending || {};
    const result = {};
    KINDS.forEach((kind) => {
      result[kind] = mergeKindDefaults(kind, {
        ...(fromBrowser[kind] || {}),
        ...(fromRouter[kind] || {}),
        ...(typed[kind] || {}),
      });
    });
    return result;
  }

  function sameAsRouter(prefs) {
    const fromRouter = routerPrefs();
    if (!fromRouter) return false;
    return KINDS.every((kind) => FIELDS.every((field) => {
      const wanted = prefs[kind] ? prefs[kind][field] : undefined;
      if (typeof wanted !== 'string') return true;
      return fromRouter[kind] && fromRouter[kind][field] === wanted;
    }));
  }

  function pushToRouter() {
    pushTimer = null;
    const api = settingsApi();
    const sent = pending;
    if (!api || typeof api.patch !== 'function' || !sent) return;
    if (sameAsRouter(sent)) {
      pending = null;
      return;
    }
    Promise.resolve(api.patch({ routing: { dat: sent } }))
      .then(() => {
        // Typed again while the request was on its way: that one is newer.
        if (pending === sent) pending = null;
      })
      .catch(() => {
        // The router did not take it. The value stays in this page and in
        // the browser storage, and goes again with the next change.
      });
  }

  function save(prefs) {
    const clean = onlyKnownFields(prefs);
    // A shipped value is not the operator's choice: it is stored as "not
    // set", so that a later release may ship a better one.
    KINDS.forEach((kind) => {
      FIELDS.forEach((field) => {
        if (clean[kind] && clean[kind][field] === DEFAULTS[kind][field]) clean[kind][field] = '';
      });
    });
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(clean));
    } catch (e) {}
    pending = clean;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushToRouter, PUSH_DELAY_MS);
  }

  // A panel that kept these values in the browser alone: hand them over once,
  // when the router turns out to have none.
  function moveBrowserPrefsToRouter() {
    if (migrated) return;
    const fromRouter = routerPrefs();
    if (!fromRouter) return;
    migrated = true;
    if (Object.keys(fromRouter).length) return;
    const fromBrowser = browserPrefs();
    if (!Object.keys(fromBrowser).length) return;
    const api = settingsApi();
    if (!api || typeof api.patch !== 'function') return;
    Promise.resolve(api.patch({ routing: { dat: fromBrowser } })).catch(() => { migrated = false; });
  }

  try {
    document.addEventListener('xkeen:ui-settings-changed', moveBrowserPrefsToRouter);
  } catch (e) {}
  moveBrowserPrefsToRouter();

  DAT.prefs = DAT.prefs || {};
  DAT.prefs.DEFAULTS = DEFAULTS;
  DAT.prefs.PREF_KEY = PREF_KEY;
  DAT.prefs.normalizePath = normalizePath;
  DAT.prefs.load = load;
  DAT.prefs.save = save;
  DAT.prefs.cloneDefaults = cloneDefaults;
})();
