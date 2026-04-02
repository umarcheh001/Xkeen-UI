import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/dat/prefs.js
  DAT card prefs + path helpers.

  RC-06a
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

  function load() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (!raw) return cloneDefaults();
      const v = JSON.parse(raw);
      return {
        geosite: mergeKindDefaults('geosite', v.geosite || {}),
        geoip: mergeKindDefaults('geoip', v.geoip || {}),
      };
    } catch (e) {
      return cloneDefaults();
    }
  }

  function save(prefs) {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs || {}));
    } catch (e) {}
  }

  DAT.prefs = DAT.prefs || {};
  DAT.prefs.DEFAULTS = DEFAULTS;
  DAT.prefs.PREF_KEY = PREF_KEY;
  DAT.prefs.normalizePath = normalizePath;
  DAT.prefs.load = load;
  DAT.prefs.save = save;
})();
