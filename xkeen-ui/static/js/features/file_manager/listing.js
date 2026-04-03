import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager listing/controller helpers (no ES modules / bundler):
  // attach to the shared file manager namespace.listing.

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = (FM && FM.common) ? FM.common : {};
  const A = (FM && FM.api) ? FM.api : {};
  const E = (FM && FM.errors) ? FM.errors : {};

  FM.listing = FM.listing || {};
  const L = FM.listing;

  const ST = FM.state || {};
  const S = ST.S;

  function _nowMs() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function panelDom(side) {
    try { return (ST && typeof ST.panelDom === 'function') ? ST.panelDom(side) : null; } catch (e) { return null; }
  }

  function safeName(s, fallback) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(s, fallback); } catch (e) {}
    return String(s == null ? (fallback == null ? '' : fallback) : s);
  }

  function joinLocal(cwd, name) {
    try { if (C && typeof C.joinLocal === 'function') return C.joinLocal(cwd, name); } catch (e) {}
    return '';
  }

  function normRemotePath(p) {
    try { if (C && typeof C.normRemotePath === 'function') return C.normRemotePath(p); } catch (e) {}
    return String(p || '').trim() || '.';
  }

  function _renderPanel(side) {
    try {
      if (FM.render && typeof FM.render.renderPanel === 'function') return FM.render.renderPanel(side);
    } catch (e) {}
    try {
      if (FM.api && typeof FM.api.renderPanel === 'function') return FM.api.renderPanel(side);
    } catch (e) {}
  }

  // Trash root is provided by backend (trash_root). Keep a sane default for older builds.
  function isTmpMntRoot(panel) {
    try {
      return !!panel && panel.target === 'local' && String(panel.cwd || '').replace(/\/+$/, '') === '/tmp/mnt';
    } catch (e) {
      return false;
    }
  }

  function _clearPanelError(side) {
    try { if (E && typeof E.clearPanelError === 'function') return E.clearPanelError(side); } catch (e) {}
    try {
      if (S && S.panels && S.panels[side]) S.panels[side].error = null;
    } catch (e2) {}
  }

  function _presentListError(side, err) {
    try {
      if (E && typeof E.present === 'function') {
        return E.present(err, { place: 'panel', side, action: 'list' });
      }
    } catch (e) {}

    // fallback
    const msg = (err && (err.message || err.toString)) ? String(err.message || err) : 'list_failed';
    toast('FM: ' + msg, 'error');
  }

  // listPanel(side, { fromInput: boolean })
  async function listPanel(side, opts) {
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;
    const pd = panelDom(side);
    if (!pd) return;

    const fromInput = !!(opts && opts.fromInput);

    // Normalize desired cwd
    let desired = p.cwd;
    if (fromInput) {
      try {
        if (pd.pathInput) {
          const v = String(pd.pathInput.value || '').trim();
          if (v) {
            if (p.target === 'remote' && (v === '~' || v === '.')) {
              const rp = String((p.rproto || '')).trim().toLowerCase();
              desired = (rp === 'ftp' || rp === 'ftps') ? '/' : '.';
            } else {
              desired = v;
            }
          }
        }
      } catch (e) {}
    }

    if (p.target === 'remote') {
      desired = normRemotePath(desired);
    }

    // Remote requires session
    if (p.target === 'remote' && !p.sid) {
      _clearPanelError(side);
      p.items = [];
      try { p.selected && typeof p.selected.clear === 'function' && p.selected.clear(); } catch (e) {}
      p.focusName = '';
      _renderPanel(side);
      return false;
    }

    const url = (() => {
      if (p.target === 'local') {
        return `/api/fs/list?target=local&path=${encodeURIComponent(desired || '')}`;
      }
      const rp = String((p.rproto || '')).trim().toLowerCase();
      const def = (rp === 'ftp' || rp === 'ftps') ? '/' : '.';
      return `/api/fs/list?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(desired || def)}`;
    })();

    // Loading state
    try { pd.list && pd.list.classList.add('is-loading'); } catch (e) {}

    let data = null;
    try {
      if (A && typeof A.fetchJsonOk === 'function') {
        data = await A.fetchJsonOk(url, { method: 'GET' }, { action: 'list', side, target: p.target });
      } else if (A && typeof A.fetchJson === 'function') {
        const out = await A.fetchJson(url, { method: 'GET' });
        data = (out && out.data) ? out.data : null;
        if (!out || !out.res || !out.res.ok || !data || !data.ok) {
          const err = (E && typeof E.fromResponse === 'function') ? E.fromResponse(out ? out.res : null, data, { action: 'list', side }) : (A.errorFromResponse ? A.errorFromResponse(out ? out.res : null, data, { action: 'list', side }) : null);
          throw err || new Error('list_failed');
        }
      } else {
        const res = await fetch(url, { method: 'GET' });
        const j = await res.json();
        if (!res.ok || !j || !j.ok) throw new Error('list_failed');
        data = j;
      }
    } catch (err) {
      try { pd.list && pd.list.classList.remove('is-loading'); } catch (e2) {}

      const ae = (() => {
        try { if (E && typeof E.normalize === 'function') return E.normalize(err, { action: 'list', side }); } catch (e3) {}
        return err;
      })();

      // Local sandbox boundary — not an actual error for UX.
      if (ae && String(ae.code || '') === 'path_not_allowed') {
        toast('FM: путь вне sandbox (см. XKEEN_LOCALFM_ROOTS)', 'info');
        _clearPanelError(side);
        _renderPanel(side);
        return false;
      }

      // Avoid stale list actions on an error.
      try { p.items = []; } catch (e3) {}
      try { p.selected = new Set(); } catch (e3) {}
      try { p.focusName = ''; } catch (e3) {}

      _presentListError(side, ae || err);
      return false;
    }

    try { pd.list && pd.list.classList.remove('is-loading'); } catch (e) {}

    // Success: clear panel error
    _clearPanelError(side);

    // Trash usage warnings (local only)
    try {
      const t = data && data.trash ? data.trash : null;
      if (t && (t.is_full || t.is_near_full) && (t.percent !== null && t.percent !== undefined)) {
        const now = _nowMs();
        const level = t.is_full ? 'full' : 'near';
        if (!S.trashUi) S.trashUi = { lastLevel: '', lastTsMs: 0, lastNotice: '' };
        if (S.trashUi.lastLevel !== level || (now - (S.trashUi.lastTsMs || 0)) > 10 * 60 * 1000) {
          S.trashUi.lastLevel = level;
          S.trashUi.lastTsMs = now;
          const pct = Number(t.percent || 0);
          if (t.is_full) toast(`Корзина заполнена (${pct}%). Удаляемые файлы будут удаляться сразу — очистите корзину.`, 'error');
          else toast(`Корзина почти заполнена (${pct}%). Рекомендуется очистить корзину.`, 'info');
        }
      }
    } catch (e) {}

    // Update dynamic trash root from backend (local only).
    try {
      if (p.target === 'local' && data && data.trash_root) {
        if (FM.bookmarks && typeof FM.bookmarks.setTrashRoot === 'function') FM.bookmarks.setTrashRoot(data.trash_root);
      }
    } catch (e) {}

    p.roots = Array.isArray(data.roots) ? data.roots : (p.roots || []);

    if (p.target === 'local') {
      p.cwd = String(data.path || desired || '');
      // Local disk space info (best-effort, may be missing)
      try { p.space = (data && data.space) ? data.space : null; } catch (e) { p.space = null; }
    } else {
      p.cwd = normRemotePath(String(data.path || desired || '.'));
      try { p.space = null; } catch (e) {}
    }

    let nextItems = Array.isArray(data.items) ? data.items : [];

    // If user has exactly one disk label, auto-enter it on first load of the right panel.
    if (!S.autoDiskDone && side === 'right' && isTmpMntRoot(p)) {
      const disks = nextItems.filter((it) => {
        const t = String(it && it.type);
        return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
      });
      if (disks.length === 1) {
        S.autoDiskDone = true;
        p.cwd = joinLocal(p.cwd, safeName(disks[0] && disks[0].name));
        try { p.selected && typeof p.selected.clear === 'function' && p.selected.clear(); } catch (e) {}
        p.focusName = '';
        await listPanel(side, { fromInput: false });
        return true;
      }
    }

    p.items = nextItems;

    // keep selection only for existing names
    const existing = new Set(p.items.map((it) => safeName(it && it.name)));
    const nextSel = new Set();
    try {
      for (const n of (p.selected || [])) {
        if (existing.has(n)) nextSel.add(n);
      }
    } catch (e) {}
    p.selected = nextSel;
    if (p.focusName && !existing.has(p.focusName)) p.focusName = '';
    if (p.anchorName && !existing.has(p.anchorName)) p.anchorName = '';
    if (!p.focusName && p.items.length) p.focusName = safeName(p.items[0] && p.items[0].name);

    _renderPanel(side);
    return true;
  }

  async function refreshAll() {
    await Promise.all([listPanel('left', { fromInput: false }), listPanel('right', { fromInput: false })]);
  }

  // exports
  L.listPanel = listPanel;
  L.refreshAll = refreshAll;

  // compatibility shims for older modules
  try { if (FM.api) FM.api.listPanel = listPanel; } catch (e) {}
  try { if (FM.api) FM.api.refreshAll = refreshAll; } catch (e) {}
  try { if (ST) ST.listPanel = listPanel; } catch (e) {}
})();
