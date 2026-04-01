import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager footer status (selected count/size + free space)
  // attach to the shared file manager namespace.status

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = FM.common || {};

  FM.status = FM.status || {};
  const STS = FM.status;

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function safeName(s) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(s); } catch (e) {}
    return String(s == null ? '' : s);
  }

  function fmtSize(n) {
    try { if (C && typeof C.fmtSize === 'function') return C.fmtSize(n); } catch (e) {}
    // minimal fallback
    try {
      const x = Number(n);
      if (!isFinite(x) || x < 0) return '';
      if (x == 0) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = x;
      let i = 0;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      const s = (i === 0) ? String(Math.round(v)) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
      return s.replace(/\.0+$/, '').replace(/(\.[1-9])0$/, '$1') + ' ' + u[i];
    } catch (e) {
      return '';
    }
  }

  function _panel(side) {
    const S = _S();
    if (!S || !S.panels) return null;
    return S.panels[side] || null;
  }

  function _activeSide() {
    const S = _S();
    const s = S && S.activeSide ? String(S.activeSide) : 'left';
    return (s === 'right') ? 'right' : 'left';
  }

  let _lastKey = '';

  function _setStatusMarkup(box, selValue, freeValue) {
    try {
      while (box.firstChild) box.removeChild(box.firstChild);

      box.appendChild(document.createTextNode('Выделено: '));
      const sv = document.createElement('span');
      sv.className = 'fm-status-v';
      sv.textContent = String(selValue || '0');
      box.appendChild(sv);

      if (freeValue) {
        box.appendChild(document.createTextNode(' • Свободно: '));
        const fv = document.createElement('span');
        fv.className = 'fm-status-v';
        fv.textContent = String(freeValue);
        box.appendChild(fv);
      }
    } catch (e) {
      // Safe fallback
      try {
        const t = freeValue ? (`Выделено: ${selValue} • Свободно: ${freeValue}`) : (`Выделено: ${selValue}`);
        box.textContent = t;
      } catch (e2) {}
    }
  }

  STS.updateFooterStatus = function updateFooterStatus() {
    const box = el('fm-footer-status');
    if (!box) return;

    const side = _activeSide();
    const p = _panel(side);
    if (!p) {
      try { box.textContent = ''; } catch (e) {}
      _lastKey = '';
      return;
    }

    // Selection: count of selected items (not focused fallback)
    let selNames = [];
    try {
      if (p.selected && typeof p.selected.size === 'number') {
        selNames = Array.from(p.selected || []).map((x) => safeName(x)).filter(Boolean);
      }
    } catch (e) {
      selNames = [];
    }

    const selCount = selNames.length;

    // Build a quick index of current items by name.
    const byName = new Map();
    try {
      (p.items || []).forEach((it) => {
        const nm = safeName(it && it.name);
        if (nm) byName.set(nm, it);
      });
    } catch (e) {}

    let bytes = 0;
    let hasDirs = false;
    let fileCount = 0;

    try {
      for (const nm of selNames) {
        const it = byName.get(nm);
        if (!it) continue;
        const type = String((it && it.type) || '');
        const linkDir = !!(it && it.link_dir);
        const isDir = (type === 'dir') || (type === 'link' && linkDir);
        if (isDir) {
          hasDirs = true;
          continue;
        }
        if (type === 'file') {
          fileCount += 1;
          const sz = Number(it && it.size);
          if (isFinite(sz) && sz >= 0) bytes += sz;
        }
      }
    } catch (e) {}

    let selValue = String(selCount);
    if (fileCount > 0) {
      const s = fmtSize(bytes);
      if (s) selValue += ` (${s})`;
    }
    if (hasDirs) selValue += ' + dirs';

    // Free space (local only)
    let freeValue = '';
    try {
      if (String(p.target || 'local') === 'local' && p.space && (p.space.free !== null && p.space.free !== undefined)) {
        const fs = fmtSize(p.space.free);
        if (fs) freeValue = fs;
      }
    } catch (e) {
      freeValue = '';
    }

    const key = selValue + '|' + freeValue;
    if (key === _lastKey) return;
    _lastKey = key;

    _setStatusMarkup(box, selValue, freeValue);
  };

})();
