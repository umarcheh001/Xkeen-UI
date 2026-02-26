(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.core = XK.core || {};
  const storage = (XK.core.storage = XK.core.storage || {});

  function _ls() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function get(key, defVal) {
    const ls = _ls();
    if (!ls) return defVal;
    try {
      const v = ls.getItem(String(key));
      return (v === null || typeof v === 'undefined') ? defVal : v;
    } catch (e) {
      return defVal;
    }
  }

  function set(key, value) {
    const ls = _ls();
    if (!ls) return false;
    try {
      ls.setItem(String(key), String(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function remove(key) {
    const ls = _ls();
    if (!ls) return false;
    try {
      ls.removeItem(String(key));
      return true;
    } catch (e) {
      return false;
    }
  }

  function getJSON(key, defVal) {
    const raw = get(key, null);
    if (raw === null) return defVal;
    try { return JSON.parse(String(raw)); } catch (e) { return defVal; }
  }

  function setJSON(key, obj) {
    try { return set(key, JSON.stringify(obj)); } catch (e) { return false; }
  }

  function ns(prefix) {
    const p = String(prefix || '');
    return {
      get: (k, d) => get(p + String(k), d),
      set: (k, v) => set(p + String(k), v),
      remove: (k) => remove(p + String(k)),
      getJSON: (k, d) => getJSON(p + String(k), d),
      setJSON: (k, o) => setJSON(p + String(k), o),
    };
  }

  storage.get = storage.get || get;
  storage.set = storage.set || set;
  storage.remove = storage.remove || remove;
  storage.getJSON = storage.getJSON || getJSON;
  storage.setJSON = storage.setJSON || setJSON;
  storage.ns = storage.ns || ns;
})();
