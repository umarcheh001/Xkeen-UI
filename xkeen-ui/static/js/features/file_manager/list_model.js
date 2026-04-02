import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager listing model (sort/filter/visibility)
  // attach to the shared file manager namespace.listModel

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.listModel = FM.listModel || {};
  const LM = FM.listModel;

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function isDirLike(it) {
    try {
      const t = String(it && it.type || '');
      return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
    } catch (e) {
      return false;
    }
  }

  function isHiddenName(name) {
    const n = String(name || '');
    // keep '.' and '..' (even if they ever appear) as not-hidden
    if (n === '.' || n === '..') return false;
    return n.startsWith('.');
  }

  function cmpStr(a, b) {
    const aa = String(a || '').toLowerCase();
    const bb = String(b || '').toLowerCase();
    return aa.localeCompare(bb);
  }

  function sortItems(items, sortPref) {
    const arr = Array.from(items || []);
    const S = _S();
    const pref = sortPref || (S && S.prefs && S.prefs.sort) || { key: 'name', dir: 'asc', dirsFirst: true };
    const key = String(pref.key || 'name');
    const dir = String(pref.dir || 'asc');
    const mul = (dir === 'desc') ? -1 : 1;
    const dirsFirst = (pref && typeof pref.dirsFirst === 'boolean') ? !!pref.dirsFirst : true;

    const keyFn = (it) => {
      if (!it) return null;
      if (key === 'size') {
        if (isDirLike(it)) return null; // sort dirs by name fallback
        const n = Number(it.size);
        return isFinite(n) ? n : 0;
      }
      if (key === 'mtime') {
        const n = Number(it.mtime);
        return isFinite(n) ? n : 0;
      }
      if (key === 'perm') {
        return String(it.perm || '');
      }
      // name
      return String(it.name || '');
    };

    arr.sort((a, b) => {
      const ad = isDirLike(a);
      const bd = isDirLike(b);
      if (dirsFirst) {
        if (ad && !bd) return -1;
        if (!ad && bd) return 1;
      }

      // For size sorting, directories don't have a meaningful size – sort them by name
      // but still respect the current direction.
      if (key === 'size' && ad && bd) {
        const c = cmpStr(a && a.name, b && b.name);
        if (c) return c * mul;
      }

      const av = keyFn(a);
      const bv = keyFn(b);

      // number compare
      if (typeof av === 'number' || typeof bv === 'number') {
        const an = (typeof av === 'number') ? av : 0;
        const bn = (typeof bv === 'number') ? bv : 0;
        if (an !== bn) return (an < bn ? -1 : 1) * mul;
      } else {
        const c = cmpStr(av, bv);
        if (c) return c * mul;
      }

      // deterministic fallback: name asc, then type
      const cn = cmpStr(a && a.name, b && b.name);
      if (cn) return cn;
      return cmpStr(a && a.type, b && b.type);
    });

    return arr;
  }

  function visibleSortedItems(side) {
    const S = _S();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return [];
    const sorted = sortItems(p.items || [], S && S.prefs ? S.prefs.sort : null);

    // Hidden files toggle
    let out = (S && S.prefs && S.prefs.showHidden) ? sorted : sorted.filter((it) => !isHiddenName(it && it.name));

    // Quick filter for current folder (substring match, supports multiple terms separated by spaces)
    const q = String(p.filter || '').trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      if (terms.length) {
        out = out.filter((it) => {
          const nm = String(it && it.name || '').toLowerCase();
          return terms.every((t) => nm.includes(t));
        });
      }
    }

    return out;
  }

  // exports
  LM.isDirLike = isDirLike;
  LM.isHiddenName = isHiddenName;
  LM.cmpStr = cmpStr;
  LM.sortItems = sortItems;
  LM.visibleSortedItems = visibleSortedItems;
})();