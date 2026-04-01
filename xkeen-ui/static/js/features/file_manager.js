import { isXkeenMipsRuntime } from './xkeen_runtime.js';
import { getFileManagerApiRoot, getFileManagerNamespace } from './file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager glue entry (thin)
  // After split into modules, this file keeps only:
  // - FM.onShow
  // - FM.init
  // - context menu dispatcher wiring
  // - initial render/refresh/capabilities bootstrap

  const FM = getFileManagerNamespace();

  // --- tiny helpers (prefer FM.common, but keep safe fallbacks)
  function C() {
    try { return (FM && FM.common) ? FM.common : {}; } catch (e) { return {}; }
  }

  function ST() {
    try { return (FM && FM.state) ? FM.state : {}; } catch (e) { return {}; }
  }

  function getS() {
    try {
      const st = ST();
      return (st && st.S) ? st.S : null;
    } catch (e) {
      return null;
    }
  }

  function el(id) {
    const c = C();
    try { if (c && typeof c.el === 'function') return c.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qsa(sel, root) {
    const c = C();
    try { if (c && typeof c.qsa === 'function') return c.qsa(sel, root); } catch (e) {}
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e2) { return []; }
  }

  function storageGetJSON(key, fallback) {
    const c = C();
    try { if (c && typeof c.storageGetJSON === 'function') return c.storageGetJSON(key, fallback); } catch (e) {}
    try {
      const raw = window.localStorage ? window.localStorage.getItem(String(key)) : null;
      if (!raw) return fallback;
      const j = JSON.parse(raw);
      return (j == null) ? fallback : j;
    } catch (e2) {
      return fallback;
    }
  }

  function show(node) {
    if (!node) return;
    try {
      if (node.dataset && (
        node.dataset.xkForceHidden === '1' ||
        node.dataset.xkHideUnusedHidden === '1'
      )) return;
    } catch (e) {}
    try { node.style.display = ''; } catch (e) {}
  }

  function hide(node) {
    if (!node) return;
    try { node.style.display = 'none'; } catch (e) {}
  }

  function toggleHidden(node, hidden) {
    const c = C();
    try {
      if (c && typeof c.toggleHidden === 'function') {
        c.toggleHidden(node, hidden);
        return;
      }
    } catch (e) {}
    if (!node) return;
    try { node.hidden = !!hidden; } catch (e2) {}
  }

  function isLiteMode() {
    const c = C();
    try { if (c && typeof c.isLiteMode === 'function') return !!c.isLiteMode(); } catch (e) {}
    try {
      const S = getS();
      if (S && typeof S.liteMode === 'boolean') return !!S.liteMode;
    } catch (e2) {}
    return isXkeenMipsRuntime();
  }

  function applyLiteUi(liteMode) {
    const on = !!liteMode;
    const view = el('view-files');
    const root = el('fm-root');

    try { if (view && view.dataset) view.dataset.fmLite = on ? '1' : '0'; } catch (e) {}
    try { if (root && root.dataset) root.dataset.fmLite = on ? '1' : '0'; } catch (e2) {}

    qsa('[data-fm-lite-hide="1"]').forEach((node) => {
      toggleHidden(node, on);
    });
    toggleHidden(el('fm-terminal-here-btn'), on);
  }

  function setLiteNote(note) {
    if (!note) return;
    note.textContent = 'Lite-режим для слабого роутера: доступны local просмотр и базовые операции, remote, фоновые job/ws-операции, drag&drop и terminal отключены.';
    show(note);
  }

  function isLiteBlockedAction(act) {
    const name = String(act || '');
    return name === 'terminal_here'
      || name === 'copy'
      || name === 'move'
      || name === 'delete'
      || name === 'archive_create'
      || name === 'archive_extract'
      || name === 'checksum';
  }

  async function fetchJson(url, init) {
    try {
      if (FM.api && typeof FM.api.fetchJson === 'function') return await FM.api.fetchJson(url, init);
    } catch (e) {}

    const res = await fetch(url, init || {});
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { res, data };
  }

  // --- capabilities bootstrap (remoteFs enabled/supported + disable remote target if needed)
  async function detectCapabilities() {
    const S = getS();
    if (!S) return;

    const tabBtn = el('top-tab-files');
    const note = el('fm-disabled-note');
    const volumesBtn = el('fm-volumes-btn');

    try {
      const { res, data } = await fetchJson('/api/capabilities', { method: 'GET' });
      if (!res || !res.ok || !data) return;

      S.caps = data;

      // USB storage button
      try {
        const su = data.storageUsb || {};
        if (volumesBtn) {
          // TEMP: hide "Диски" UI by default.
          // Reason: `ndmc show usb` output differs across firmware versions; on some devices
          // parsing/enrichment may be unreliable (showing mounted volumes as unmounted).
          // You can force-enable for debugging with:
          //   - URL: ?usbdisks=1
          //   - or localStorage: xkeen.fm.usbdisks=1
          let forceEnable = false;
          try {
            const sp = new URLSearchParams(String((window.location && window.location.search) || ''));
            forceEnable = (sp.get('usbdisks') === '1');
          } catch (e) {}
          try {
            if (!forceEnable && window.localStorage) {
              forceEnable = (String(window.localStorage.getItem('xkeen.fm.usbdisks') || '') === '1');
            }
          } catch (e2) {}

          if (forceEnable && su && su.enabled) {
            try { if (volumesBtn.dataset) delete volumesBtn.dataset.xkForceHidden; } catch (e3) {}
            show(volumesBtn);
          } else {
            try { if (volumesBtn.dataset) volumesBtn.dataset.xkForceHidden = '1'; } catch (e4) {}
            hide(volumesBtn);
          }
        }
      } catch (e) {}

      const rf = data.remoteFs || {};
      const arch = String(rf.arch || '').toLowerCase();
      const isMips = arch.startsWith('mips') || String(rf.reason || '') === 'arch_mips_disabled';
      S.liteMode = !!isMips;
      applyLiteUi(S.liteMode);

      // "Hide unused" layout preference: if enabled, hide Files tab when remote FS is unusable.
      let hideUnused = false;
      try {
        const c = C();
        const L = c && typeof c.getLayoutApi === 'function' ? c.getLayoutApi() : null;
        if (L && typeof L.load === 'function') hideUnused = !!(L.load() || {}).hideUnused;
        else hideUnused = !!(storageGetJSON('xkeen-layout-v1', null) || {}).hideUnused;
      } catch (e) {}

      const enabled = !!rf.enabled;
      const supported = !!rf.supported;
      const featureUsable = !!enabled && !!supported && !isMips;

      if (tabBtn) {
        if (isMips) show(tabBtn);
        else if (hideUnused && !featureUsable) hide(tabBtn);
        else show(tabBtn);
      }

      S.enabled = enabled;

      // Disable "remote" in target select if backend is not supported.
      try {
        const allowRemote = !!enabled && !!supported && !isMips;
        ['left', 'right'].forEach((side) => {
          const st = ST();
          const pd = (st && typeof st.panelDom === 'function') ? st.panelDom(side) : null;
          const p = (S.panels && S.panels[side]) ? S.panels[side] : null;
          if (!pd || !pd.targetSelect || !p) return;

          const opt = Array.from(pd.targetSelect.options || []).find(o => String(o.value) === 'remote');
          if (opt) {
            opt.disabled = !allowRemote;
            toggleHidden(opt, !allowRemote);
          }
          toggleHidden(pd.connectBtn, !allowRemote);
          toggleHidden(pd.disconnectBtn, !allowRemote);

          if (!allowRemote && p.target === 'remote') {
            p.target = 'local';
            p.sid = '';
          }
          if (!allowRemote) {
            try { pd.targetSelect.value = 'local'; } catch (e) {}
          }
        });
      } catch (e) {}

      // Load remote caps for Connect modal only when remote is actually usable.
      try {
        if (enabled && supported && !isMips) {
          if (FM.remote && typeof FM.remote.loadRemoteCaps === 'function') await FM.remote.loadRemoteCaps();
          if (FM.remote && typeof FM.remote.applyCapsToConnectModal === 'function') FM.remote.applyCapsToConnectModal();
        }
      } catch (e) {}

      // Inline hint inside view
      if (note) {
        if (isMips) {
          setLiteNote(note);
        } else if (!enabled || !supported) {
          const reason = rf.reason ? String(rf.reason) : 'disabled';
          let msg = 'Remote файловый менеджер недоступен: ' + reason + '.';
          if (reason === 'lftp_missing') msg += ' Установите lftp через Entware: opkg install lftp.';
          else if (reason === 'disabled') msg += ' Включите XKEEN_REMOTEFM_ENABLE=1.';
          note.textContent = msg;
          show(note);
        } else {
          hide(note);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  function setContextMenuDispatcher() {
    try {
      if (!FM.contextMenu || typeof FM.contextMenu.setDispatcher !== 'function') return;

      FM.contextMenu.setDispatcher(async (act, ctx) => {
        const S = getS();
        const side = String((ctx && ctx.side) || (S && S.activeSide) || 'left');
        const lite = isLiteMode();

        const NAV = (FM && FM.nav) ? FM.nav : {};
        const OPS = (FM && FM.ops) ? FM.ops : {};
        const SEL = (FM && FM.selection) ? FM.selection : {};
        const ACT = (FM && FM.actions) ? FM.actions : {};
        const LIST = (FM && FM.listing) ? FM.listing : {};

        // Navigation / open
        if (act === 'open') {
          if (NAV && typeof NAV.openFocused === 'function') await NAV.openFocused(side);
          return;
        }
        if (act === 'up') {
          if (NAV && typeof NAV.goUp === 'function') await NAV.goUp(side);
          return;
        }

        if (lite && isLiteBlockedAction(act)) return;

        // Terminal
        if (act === 'terminal_here') {
          if (FM.terminal && typeof FM.terminal.openHere === 'function') {
            await FM.terminal.openHere(side, { name: String((ctx && ctx.name) || ''), isDir: !!(ctx && ctx.isDir) });
          }
          return;
        }

        // Listing
        if (act === 'refresh') {
          if (LIST && typeof LIST.listPanel === 'function') await LIST.listPanel(side, { fromInput: true });
          return;
        }

        // Download
        if (act === 'download') {
          if (OPS && typeof OPS.downloadSelection === 'function') OPS.downloadSelection(side);
          return;
        }

        // Clipboard
        if (act === 'copy_path') {
          if (SEL && typeof SEL.copyFullPaths === 'function') SEL.copyFullPaths(side);
          return;
        }

        // Ops (copy/move/delete/restore)
        if (act === 'copy') { if (OPS && typeof OPS.runCopyMove === 'function') await OPS.runCopyMove('copy'); return; }
        if (act === 'move') { if (OPS && typeof OPS.runCopyMove === 'function') await OPS.runCopyMove('move'); return; }
        if (act === 'delete') { if (OPS && typeof OPS.runDelete === 'function') await OPS.runDelete(); return; }
        if (act === 'restore') { if (OPS && typeof OPS.runRestore === 'function') await OPS.runRestore(); return; }

        // Selection
        if (act === 'select_all') { if (SEL && typeof SEL.selectAllVisible === 'function') SEL.selectAllVisible(side); return; }
        if (act === 'invert_sel') { if (SEL && typeof SEL.invertSelectionVisible === 'function') SEL.invertSelectionVisible(side); return; }
        if (act === 'mask_sel') { if (SEL && typeof SEL.openMaskModal === 'function') SEL.openMaskModal(); return; }

        // Dialogs
        if (act === 'mkdir') { if (ACT && typeof ACT.openCreateModal === 'function') ACT.openCreateModal('dir'); return; }
        if (act === 'touch') { if (ACT && typeof ACT.openCreateModal === 'function') ACT.openCreateModal('file'); return; }
        if (act === 'rename') { if (ACT && typeof ACT.openRenameModal === 'function') ACT.openRenameModal(); return; }

        if (act === 'archive_create') { if (ACT && typeof ACT.openArchiveModal === 'function') ACT.openArchiveModal(); return; }
        if (act === 'archive_extract') { if (ACT && typeof ACT.openExtractModal === 'function') ACT.openExtractModal(); return; }
        if (act === 'archive_list') { if (ACT && typeof ACT.openArchiveListModal === 'function') ACT.openArchiveListModal(); return; }

        if (act === 'chmod') { if (ACT && typeof ACT.openChmodModal === 'function') ACT.openChmodModal(); return; }
        if (act === 'chown') { if (ACT && typeof ACT.openChownModal === 'function') ACT.openChownModal(); return; }

        if (act === 'props') { if (ACT && typeof ACT.openPropsModal === 'function') await ACT.openPropsModal(side); return; }
        if (act === 'checksum') { if (ACT && typeof ACT.openHashModal === 'function') await ACT.openHashModal(side); return; }

        // Upload
        if (act === 'upload') {
          const inp = el('fm-upload-input');
          if (inp) {
            try { inp.value = ''; } catch (e) {}
            try { inp.click(); } catch (e2) {}
          }
        }
      });
    } catch (e) {}
  }

  // --- public API
  FM.onShow = function onShow() {
    // lazy refresh when tab is opened
    try {
      if (FM.render && typeof FM.render.renderPanel === 'function') {
        FM.render.renderPanel('left');
        FM.render.renderPanel('right');
      }

      const S = getS();
      if (S && S.panels && !S.panels.left.items.length && !S.panels.right.items.length) {
        if (FM.listing && typeof FM.listing.refreshAll === 'function') FM.listing.refreshAll();
      }
    } catch (e) {}
  };

  FM.init = function init() {
    const root = el('fm-root');
    if (!root) return;

    // avoid double init
    if (root.dataset && root.dataset.fmInit === '1') return;
    if (root.dataset) root.dataset.fmInit = '1';

    const S = getS();
    if (!S || !S.panels) return;

    // init default paths
    ['left', 'right'].forEach((side) => {
      const p = S.panels[side];
      if (p && !p.cwd) p.cwd = '/opt/var';
    });

    // default active side (restored from prefs when available)
    try {
      const st = ST();
      const want = (S && (S.activeSide === 'right' || S.activeSide === 'left')) ? S.activeSide : 'left';
      if (st && typeof st.setActiveSide === 'function') st.setActiveSide(want);
    } catch (e) {}

    // Back-compat glue for old callers
    try {
      FM.api = FM.api || {};
      if (FM.render && typeof FM.render.renderPanel === 'function') FM.api.renderPanel = FM.render.renderPanel;
      if (FM.listing && typeof FM.listing.listPanel === 'function') ST().listPanel = FM.listing.listPanel;
    } catch (e) {}

    try {
      applyLiteUi(isLiteMode());
      if (isLiteMode()) setLiteNote(el('fm-disabled-note'));
    } catch (e) {}

    // Context menu dispatcher
    setContextMenuDispatcher();

    // Wire UI events (panels + global handlers)
    try {
      if (FM.wire && typeof FM.wire.wirePanel === 'function') {
        FM.wire.wirePanel('left');
        FM.wire.wirePanel('right');
      }
    } catch (e) {}

    // Extra feature wiring (USB storage modal, etc.)
    try {
      if (FM.storage && typeof FM.storage.init === 'function') FM.storage.init();
    } catch (e) {}

    // Capabilities -> initial render + listing
    Promise.resolve()
      .then(() => detectCapabilities())
      .catch(() => {})
      .finally(() => {
        try { if (FM.render && typeof FM.render.renderPanel === 'function') FM.render.renderPanel('left'); } catch (e) {}
        try { if (FM.render && typeof FM.render.renderPanel === 'function') FM.render.renderPanel('right'); } catch (e) {}
        try { if (FM.listing && typeof FM.listing.refreshAll === 'function') FM.listing.refreshAll(); } catch (e) {}
      });
  };
})();
export function getFileManagerApi() {
  try {
    return getFileManagerApiRoot();
  } catch (error) {
    return null;
  }
}

function callFileManagerApi(method, ...args) {
  const api = getFileManagerApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initFileManager(...args) {
  return callFileManagerApi('init', ...args);
}

export function onShowFileManager(...args) {
  return callFileManagerApi('onShow', ...args);
}

export const fileManagerApi = Object.freeze({
  get: getFileManagerApi,
  init: initFileManager,
  onShow: onShowFileManager,
});
