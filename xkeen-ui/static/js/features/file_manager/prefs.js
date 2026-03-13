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
    bookmarksLocal: 'xkeen.fm.bookmarks.local', // JSON: [{ label: '...', value: '/path' }, ...]
    geom: 'xkeen.fm.geom_v3',        // JSON: { w: px, h: px, shiftX: px }

    // Panels state (persist between reloads)
    panels: 'xkeen.fm.panels_v1',    // JSON: { left:{cwd,target,filter}, right:{cwd,target,filter} }
    activeSide: 'xkeen.fm.activeSide', // 'left'|'right'
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

  function _sanitizeBookmarkItem(it) {
    if (!it || typeof it !== 'object') return null;
    const value = String(it.value || '').trim();
    if (!value) return null;
    const label = String(it.label || '').trim();
    return { label: label || value, value };
  }

  function loadBookmarksLocal(defaultsArr) {
    const raw = lsGet(KEYS.bookmarksLocal);
    const defaults = Array.isArray(defaultsArr) ? defaultsArr : [];
    if (!raw) return defaults.map((x) => _sanitizeBookmarkItem(x)).filter(Boolean);
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return defaults.map((x) => _sanitizeBookmarkItem(x)).filter(Boolean);
      const seen = new Set();
      const out = [];
      for (const it of arr) {
        const s = _sanitizeBookmarkItem(it);
        if (!s) continue;
        if (seen.has(s.value)) continue;
        seen.add(s.value);
        out.push(s);
      }
      return out.length ? out : defaults.map((x) => _sanitizeBookmarkItem(x)).filter(Boolean);
    } catch (e) {
      return defaults.map((x) => _sanitizeBookmarkItem(x)).filter(Boolean);
    }
  }

  function saveBookmarksLocal(arr) {
    const list = Array.isArray(arr) ? arr : [];
    const seen = new Set();
    const out = [];
    for (const it of list) {
      const s = _sanitizeBookmarkItem(it);
      if (!s) continue;
      if (seen.has(s.value)) continue;
      seen.add(s.value);
      out.push(s);
    }
    lsSet(KEYS.bookmarksLocal, JSON.stringify(out));
  }

  function clearBookmarksLocal() {
    try { localStorage.removeItem(KEYS.bookmarksLocal); } catch (e) {}
  }

  function _sanitizePanelSide(sideObj, fallbackObj) {
    const fb = (fallbackObj && typeof fallbackObj === 'object') ? fallbackObj : {};
    const src = (sideObj && typeof sideObj === 'object') ? sideObj : {};

    let target = String(src.target || fb.target || 'local');
    if (target !== 'local' && target !== 'remote') target = String(fb.target || 'local');

    let cwd = String(src.cwd || fb.cwd || '').trim();
    if (!cwd) cwd = String(fb.cwd || '');

    let filter = String((src.filter != null ? src.filter : fb.filter) || '');
    if (filter.length > 256) filter = filter.slice(0, 256);

    return { target, cwd, filter };
  }

  function loadPanelsPref(defaultsObj) {
    const defaults = (defaultsObj && typeof defaultsObj === 'object') ? defaultsObj : { left: {}, right: {} };
    const fbLeft = defaults.left || {};
    const fbRight = defaults.right || {};

    const raw = lsGet(KEYS.panels);
    if (!raw) {
      return {
        left: _sanitizePanelSide(fbLeft, fbLeft),
        right: _sanitizePanelSide(fbRight, fbRight),
      };
    }

    try {
      const j = JSON.parse(raw);
      return {
        left: _sanitizePanelSide(j && j.left, fbLeft),
        right: _sanitizePanelSide(j && j.right, fbRight),
      };
    } catch (e) {
      return {
        left: _sanitizePanelSide(fbLeft, fbLeft),
        right: _sanitizePanelSide(fbRight, fbRight),
      };
    }
  }

  function savePanelsPref(panelsObj) {
    const p = (panelsObj && typeof panelsObj === 'object') ? panelsObj : {};
    const out = {
      left: _sanitizePanelSide(p.left, { target: 'local', cwd: '/opt/var', filter: '' }),
      right: _sanitizePanelSide(p.right, { target: 'local', cwd: '/tmp/mnt', filter: '' }),
    };
    lsSet(KEYS.panels, JSON.stringify(out));
  }

  function loadActiveSidePref() {
    const raw = lsGet(KEYS.activeSide);
    return (raw === 'right') ? 'right' : 'left';
  }

  function saveActiveSidePref(side) {
    if (side !== 'left' && side !== 'right') return;
    lsSet(KEYS.activeSide, side);
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
    loadBookmarksLocal,
    saveBookmarksLocal,
    clearBookmarksLocal,

    loadPanelsPref,
    savePanelsPref,
    loadActiveSidePref,
    saveActiveSidePref,
  };
})();
