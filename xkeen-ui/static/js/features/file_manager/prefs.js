(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  // Preferences are stored in localStorage.
  // This module keeps the keys stable so older installs keep working.
  const KEYS = {
    sort: 'xkeen.fm.sort',           // JSON: { key: 'name'|'size'|'perm'|'mtime', dir: 'asc'|'desc', dirsFirst: true }
    showHidden: 'xkeen.fm.dotfiles', // '1'|'0'
    mask: 'xkeen.fm.mask',           // last used selection mask (glob)
    geom: 'xkeen.fm.geom_v1',        // JSON: { w: px, h: px, shiftX: px }
  };

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function loadSortPref() {
    const raw = lsGet(KEYS.sort);
    if (!raw) return { key: 'name', dir: 'asc', dirsFirst: true };
    try {
      const o = JSON.parse(raw);
      const key = String((o && o.key) || 'name');
      const dir = String((o && o.dir) || 'asc');
      const dirsFirst = (o && typeof o.dirsFirst === 'boolean') ? !!o.dirsFirst : true;
      if (!['name', 'size', 'perm', 'mtime'].includes(key)) return { key: 'name', dir: 'asc', dirsFirst: true };
      if (!['asc', 'desc'].includes(dir)) return { key, dir: 'asc', dirsFirst };
      return { key, dir, dirsFirst };
    } catch (e) {
      return { key: 'name', dir: 'asc', dirsFirst: true };
    }
  }

  function saveSortPref(p) {
    const o = {
      key: (p && p.key) || 'name',
      dir: (p && p.dir) || 'asc',
      dirsFirst: (p && typeof p.dirsFirst === 'boolean') ? !!p.dirsFirst : true,
    };
    lsSet(KEYS.sort, JSON.stringify(o));
  }

  function loadShowHiddenPref() {
    const raw = lsGet(KEYS.showHidden);
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  }

  function saveShowHiddenPref(on) {
    lsSet(KEYS.showHidden, on ? '1' : '0');
  }

  function loadMaskPref() {
    const raw = lsGet(KEYS.mask);
    return raw ? String(raw) : '';
  }

  function saveMaskPref(v) {
    lsSet(KEYS.mask, String(v || ''));
  }

  // Public API
  FM.prefs = {
    keys: KEYS,
    lsGet,
    lsSet,
    loadSortPref,
    saveSortPref,
    loadShowHiddenPref,
    saveShowHiddenPref,
    loadMaskPref,
    saveMaskPref,
  };
})();
