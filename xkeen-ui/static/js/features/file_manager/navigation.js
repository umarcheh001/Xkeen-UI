(() => {
  'use strict';

  // File Manager navigation helpers (open / enter / go up).
  // attach to window.XKeen.features.fileManager.nav.

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;
  const C = (FM && FM.common) ? FM.common : {};

  const A = (FM && FM.api) ? FM.api : {};

  FM.nav = FM.nav || {};
  const N = FM.nav;

  function getS() {
    try { return (FM && FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function toast(msg, type) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, type); } catch (e) {}
  }

  function el(id) {
    try { return (C && typeof C.el === 'function') ? C.el(id) : document.getElementById(id); } catch (e) { return null; }
  }

  function qs(sel, root) {
    try { return (C && typeof C.qs === 'function') ? C.qs(sel, root) : (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function safeName(s) {
    try { return (C && typeof C.safeName === 'function') ? C.safeName(s) : String(s == null ? '' : s); } catch (e) { return String(s == null ? '' : s); }
  }

  function joinLocal(cwd, name) {
    try { return (C && typeof C.joinLocal === 'function') ? C.joinLocal(cwd, name) : ''; } catch (e) { return ''; }
  }

  function joinRemote(cwd, name) {
    try { return (C && typeof C.joinRemote === 'function') ? C.joinRemote(cwd, name) : ''; } catch (e) { return ''; }
  }

  function parentLocal(cwd) {
    try { return (C && typeof C.parentLocal === 'function') ? C.parentLocal(cwd) : '/'; } catch (e) { return '/'; }
  }

  function parentRemote(cwd) {
    try { return (C && typeof C.parentRemote === 'function') ? C.parentRemote(cwd) : '.'; } catch (e) { return '.'; }
  }

  function isAllowedLocalPath(path, roots) {
    try { return (C && typeof C.isAllowedLocalPath === 'function') ? !!C.isAllowedLocalPath(path, roots) : true; } catch (e) { return true; }
  }

  function isUnderRoot(path, root) {
    try { return (C && typeof C._isUnderRoot === 'function') ? !!C._isUnderRoot(path, root) : false; } catch (e) { return false; }
  }

  async function fetchJson(url, init) {
    if (A && typeof A.fetchJson === 'function') return await A.fetchJson(url, init);
    throw new Error('FM.api.fetchJson missing');
  }

  function xhrDownloadFile(args) {
    try { if (FM.api && typeof FM.api.xhrDownloadFile === 'function') return FM.api.xhrDownloadFile(args || {}); } catch (e) {}
    try { if (FM.transfers && typeof FM.transfers.xhrDownloadFile === 'function') return FM.transfers.xhrDownloadFile(args || {}); } catch (e) {}
    return null;
  }

  function fmCardEl() {
    try { return (FM.chrome && typeof FM.chrome.cardEl === 'function') ? FM.chrome.cardEl() : null; } catch (e) { return null; }
  }

  // -------------------------- UX: busy overlay for slow remote open --------------------------
  function _fmBusyEls() {
    const overlay = el('fm-open-overlay');
    const text = el('fm-open-overlay-text');

    // Prefer FM.chrome.cardEl(), but fall back to a simple query.
    let card = null;
    try { card = fmCardEl(); } catch (e) { card = null; }
    if (!card) {
      try { card = qs('.fm-card', el('view-files')); } catch (e) { card = null; }
    }

    return { overlay, text, card };
  }

  function setOpenBusy(on, msg) {
    const ui = _fmBusyEls();
    if (!ui || !ui.overlay) return;
    const isOn = !!on;

    const S = getS();
    try { if (S) S.openBusy = isOn; } catch (e) {}
    try { if (S) S.openBusySinceMs = isOn ? Date.now() : 0; } catch (e) {}

    if (isOn) {
      try { if (ui.text && msg) ui.text.textContent = String(msg); } catch (e) {}
      try { ui.overlay.classList.remove('hidden'); } catch (e) {}
      try { ui.overlay.setAttribute('aria-hidden', 'false'); } catch (e) {}
      try { if (ui.card) ui.card.classList.add('fm-busy'); } catch (e) {}
    } else {
      try { ui.overlay.classList.add('hidden'); } catch (e) {}
      try { ui.overlay.setAttribute('aria-hidden', 'true'); } catch (e) {}
      try { if (ui.card) ui.card.classList.remove('fm-busy'); } catch (e) {}
    }
  }

  function getFocusedItem(side) {
    try { return (FM.selection && typeof FM.selection.getFocusedItem === 'function') ? FM.selection.getFocusedItem(side) : null; } catch (e) { return null; }
  }

  async function tryOpenInEditor(side, it, fullPath) {
    const name = safeName(it && it.name);
    if (!name) return false;
    const S = getS();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return false;
    const target = String(p.target || 'local');
    const sid = String(p.sid || '');

    // Quick extension heuristic (avoid calling read API for obvious binary blobs)
    const lower = name.toLowerCase();
    const ext = lower.includes('.') ? lower.split('.').pop() : '';
    const likelyText = ['txt','log','conf','cfg','ini','json','jsonc','yml','yaml','md','sh','bash','rules','list','lst','csv','tsv','xml','html','htm','js','ts','css','py','go','rs','java','c','h','cpp','hpp','sql','toml'].includes(ext);

    if (!likelyText) {
      // Still allow opening unknown extensions if they look small & harmless (best-effort).
      // We'll attempt read and fall back to download if backend says "not_text".
    }

    const url = `/api/fs/read?target=${encodeURIComponent(target)}&path=${encodeURIComponent(fullPath)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;

    const showBusy = (target === 'remote');
    if (showBusy) {
      // Display a spinner overlay to make it clear that the file is being fetched over the network.
      try { setOpenBusy(true, `Открываю: ${name}…`); } catch (e) {}
    }

    let out = null;
    try {
      out = await fetchJson(url, { method: 'GET' });
    } catch (e) {
      out = null;
    }

    try {
      if (!out || !out.res) return false;
      if (out.res.status === 415 && out.data && out.data.error === 'not_text') {
        return false;
      }
      if (out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
        const errMsg = (out.data && out.data.error) ? String(out.data.error) : `HTTP ${out.res.status}`;
        try { toast('FM: не удалось открыть файл: ' + errMsg, 'error'); } catch (e) {}
        return false;
      }

      const text = String(out.data.text || '');
      const truncated = !!out.data.truncated;
      const ctx = {
        target,
        sid: target === 'remote' ? sid : '',
        path: fullPath,
        name,
        side,
        truncated,
        readOnly: truncated, // avoid accidental overwrite of partial content
      };

      try { if (FM.editor && typeof FM.editor.wire === 'function') FM.editor.wire(); } catch (e) {}

      // Editor.open is async (loads modes/lint). Await to keep the busy overlay until the editor is ready.
      try {
        return (FM.editor && typeof FM.editor.open === 'function') ? await FM.editor.open(ctx, text) : false;
      } catch (e) {
        return false;
      }
    } finally {
      if (showBusy) {
        try { setOpenBusy(false); } catch (e) {}
      }
    }
  }

  async function openFocused(side) {
    const S = getS();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;

    // Guard against rapid repeated "open" clicks while a remote file is still loading.
    try { if (S && S.openBusy) return; } catch (e) {}

    const it = getFocusedItem(side);
    if (!it) return;
    const type = String((it && it.type) || '');
    const linkDir = !!(it && it.link_dir);
    const isDir = type === 'dir' || (type === 'link' && linkDir);

    if (isDir) {
      if (p.target === 'local') {
        p.cwd = joinLocal(p.cwd, it.name);
      } else {
        p.cwd = joinRemote(p.cwd, it.name);
      }
      try { p.selected && typeof p.selected.clear === 'function' && p.selected.clear(); } catch (e) {}
      p.focusName = '';
      try { if (FM.listing && typeof FM.listing.listPanel === 'function') await FM.listing.listPanel(side, { fromInput: false }); } catch (e) {}
      return;
    }

    // Symlink to directory? Some backends don't expose link_dir.
    // Try to open links as directories first; if it fails, fallback to file download.
    if (type === 'link') {
      const prevCwd = p.cwd;
      const prevFocus = p.focusName;
      const prevSel = new Set(p.selected || []);
      const nextCwd = (p.target === 'remote') ? joinRemote(prevCwd, it.name) : joinLocal(prevCwd, it.name);
      p.cwd = nextCwd;
      try { p.selected && typeof p.selected.clear === 'function' && p.selected.clear(); } catch (e) {}
      p.focusName = '';
      let ok = false;
      try { ok = !!(FM.listing && typeof FM.listing.listPanel === 'function' ? await FM.listing.listPanel(side, { fromInput: false }) : false); } catch (e) { ok = false; }
      if (ok) return;
      // restore and continue as file
      p.cwd = prevCwd;
      p.focusName = prevFocus;
      p.selected = prevSel;
    }

    // Files: open in built-in CodeMirror editor (for text) or download (binary/unknown).
    if (p.target === 'remote' && !p.sid) {
      toast('Открыть/скачать: remote без сессии', 'info');
      return;
    }

    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);

    // Try opening as text first (backend will refuse binary with 415 not_text).
    try {
      const opened = await tryOpenInEditor(side, it, fullPath);
      if (opened) return;
    } catch (e) {}

    const url = (p.target === 'remote')
      ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
      : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;

    xhrDownloadFile({ url, filenameHint: safeName(it.name), titleLabel: 'Download' });
  }

  async function goUp(side) {
    const S = getS();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;

    const cur = String(p.cwd || '');
    const cand = (p.target === 'local') ? parentLocal(cur) : parentRemote(cur);

    // Local FS is sandboxed by roots; don't navigate above allowed roots.
    if (p.target === 'local' && !isAllowedLocalPath(cand, p.roots)) {
      // At sandbox boundary. If multiple roots exist, cycle to the next root (handy on routers).
      const roots = Array.isArray(p.roots) ? p.roots.slice() : [];
      if (roots.length > 1) {
        // Pick the most specific root we are currently under.
        let curRoot = roots[0];
        for (const r of roots) {
          if (isUnderRoot(cur, r) && String(r).length >= String(curRoot).length) curRoot = r;
        }
        const idx = roots.indexOf(curRoot);
        const next = roots[(idx + 1) % roots.length];
        if (next && next !== curRoot) {
          p.cwd = next;
          try { p.selected && typeof p.selected.clear === 'function' && p.selected.clear(); } catch (e) {}
          p.focusName = '';
          try { if (FM.listing && typeof FM.listing.listPanel === 'function') await FM.listing.listPanel(side, { fromInput: false }); } catch (e) {}
        }
      }
      return;
    }

    p.cwd = cand;
    try { p.selected && typeof p.selected.clear === 'function' && p.selected.clear(); } catch (e) {}
    p.focusName = '';
    try { if (FM.listing && typeof FM.listing.listPanel === 'function') await FM.listing.listPanel(side, { fromInput: false }); } catch (e) {}
  }

  // exports
  N.tryOpenInEditor = tryOpenInEditor;
  N.openFocused = openFocused;
  N.goUp = goUp;
})();
