import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager Drag&Drop helpers (no ES modules / bundler)
  // - OS file drop -> upload into panel
  // - Internal FM drag between panels -> move/copy
  //
  // Exports:
  //   the shared file manager namespace.dragdrop.wireDropOpModal()
  //   the shared file manager namespace.dragdrop.openDropOpModal(opts)
  //   the shared file manager namespace.dragdrop.closeDropOpModal(result)
  //   the shared file manager namespace.dragdrop.attachDragDrop({ side, panelDom, openDropOpModal })

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  FM.dragdrop = FM.dragdrop || {};
  const DD = FM.dragdrop;

  const C = FM.common || {};
  const ST = FM.state || {};

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qs(sel, root) {
    try { if (C && typeof C.qs === 'function') return C.qs(sel, root); } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  }

  function qsa(sel, root) {
    try { if (C && typeof C.qsa === 'function') return C.qsa(sel, root); } catch (e) {}
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e2) { return []; }
  }

  function safeName(name, fallback) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(name, fallback); } catch (e) {}
    const s = String(name == null ? '' : name);
    return s || String(fallback || '');
  }

  function joinLocal(a, b) {
    try { if (C && typeof C.joinLocal === 'function') return C.joinLocal(a, b); } catch (e) {}
    const aa = String(a || '').replace(/\/+$/, '');
    const bb = String(b || '').replace(/^\/+/, '');
    return aa ? (aa + '/' + bb) : ('/' + bb);
  }

  function joinRemote(a, b) {
    try { if (C && typeof C.joinRemote === 'function') return C.joinRemote(a, b); } catch (e) {}
    const aa = String(a || '').replace(/\/+$/, '');
    const bb = String(b || '').replace(/^\/+/, '');
    return aa ? (aa + '/' + bb) : ('/' + bb);
  }

  function normRemotePath(p) {
    try { if (C && typeof C.normRemotePath === 'function') return C.normRemotePath(p); } catch (e) {}
    // Fallback: collapse multiple slashes, keep leading slash.
    const s = String(p || '');
    if (!s) return '/';
    const lead = s.startsWith('/') ? '/' : '';
    return lead + s.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/g, '');
  }

  function _trimSlashes(p) {
    return String(p || '').replace(/\/+$/, '') || '/';
  }

  function toast(msg, kind) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, kind); } catch (e) {}
  }

  function setActiveSide(side) {
    try { if (ST && typeof ST.setActiveSide === 'function') ST.setActiveSide(side); } catch (e) {}
  }

  function _panelLabel(side, target, sid, path) {
    const s = String(side || '').toUpperCase();
    const t = String(target || 'local');
    const r = (t === 'remote' && sid) ? ` (${sid})` : '';
    const p = String(path || '');
    return `${s} • ${t}${r} • ${p}`;
  }


  // -------------------------- Drag&Drop: choose Move or Copy --------------------------
  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e) {}
    try { document.body.classList.add('modal-open'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    try { document.body.classList.remove('modal-open'); } catch (e2) {}
  }

  function _setDropOpButtonsDefault(defaultOp) {
    const copyBtn = el('fm-dropop-copy-btn');
    const moveBtn = el('fm-dropop-move-btn');
    if (!copyBtn || !moveBtn) return;
    const op = String(defaultOp || 'move').toLowerCase();
    if (op === 'copy') {
      try { copyBtn.classList.add('btn-primary'); copyBtn.classList.remove('btn-secondary'); } catch (e) {}
      try { moveBtn.classList.add('btn-secondary'); moveBtn.classList.remove('btn-primary'); } catch (e) {}
    } else {
      try { moveBtn.classList.add('btn-primary'); moveBtn.classList.remove('btn-secondary'); } catch (e) {}
      try { copyBtn.classList.add('btn-secondary'); copyBtn.classList.remove('btn-primary'); } catch (e) {}
    }
  }

  function closeDropOpModal(result) {
    const S = ST.S;
    const modal = el('fm-dropop-modal');
    try { modalClose(modal); } catch (e) {}
    const r = S && S.dropOp && S.dropOp.resolve;
    try { if (S && S.dropOp) S.dropOp.resolve = null; } catch (e) {}
    if (typeof r === 'function') {
      try { r(result); } catch (e) {}
    }
  }

  function openDropOpModal(opts) {
    const S = ST.S;
    const o = opts || {};
    const modal = el('fm-dropop-modal');
    const defaultOp = String(o.defaultOp || 'move').toLowerCase() === 'copy' ? 'copy' : 'move';
    if (!modal) return Promise.resolve(defaultOp);

    // Cancel previous pending choice (if any)
    try { if (S && S.dropOp && typeof S.dropOp.resolve === 'function') S.dropOp.resolve(null); } catch (e) {}

    const names = Array.isArray(o.names) ? o.names : [];
    const srcLabel = String(o.srcLabel || '');
    const dstLabel = String(o.dstLabel || '');

    const textEl = el('fm-dropop-text');
    const listEl = el('fm-dropop-list');

    if (textEl) {
      try { textEl.style.whiteSpace = 'pre-wrap'; } catch (e) {}
      const n = names.length;
      const head = n === 1 ? '1 элемент' : `${n} элементов`;
      textEl.textContent = `Источник: ${srcLabel}\nНазначение: ${dstLabel}\nДействие для ${head}?`;
    }

    if (listEl) {
      const showN = 12;
      const shown = names.slice(0, showN);
      listEl.textContent = shown.join('\n') + (names.length > showN ? '\n…' : '');
    }

    _setDropOpButtonsDefault(defaultOp);

    return new Promise((resolve) => {
      try { if (S) { S.dropOp = S.dropOp || {}; S.dropOp.resolve = resolve; } } catch (e) {}
      modalOpen(modal);
      // Focus default button
      try {
        setTimeout(() => {
          const b = (defaultOp === 'copy') ? el('fm-dropop-copy-btn') : el('fm-dropop-move-btn');
          b && b.focus && b.focus();
        }, 0);
      } catch (e) {}
    });
  }

  function wireDropOpModal() {
    const S = ST.S;
    try {
      if (S && S._dropOpWired) return;
      if (S) S._dropOpWired = true;
    } catch (e) {}

    const dropCopy = el('fm-dropop-copy-btn');
    const dropMove = el('fm-dropop-move-btn');
    const dropCancel = el('fm-dropop-cancel-btn');
    const dropClose = el('fm-dropop-close-btn');
    const dropModal = el('fm-dropop-modal');

    const _dropClose = (res) => { try { closeDropOpModal(res); } catch (e) {} };

    if (dropCopy) dropCopy.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} _dropClose('copy'); });
    if (dropMove) dropMove.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} _dropClose('move'); });
    if (dropCancel) dropCancel.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} _dropClose(null); });
    if (dropClose) dropClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} _dropClose(null); });
    if (dropModal) dropModal.addEventListener('click', (e) => { try { if (e && e.target === dropModal) _dropClose(null); } catch (e2) {} });
  }

  function hasFiles(dt) {
    try {
      const types = Array.from((dt && dt.types) || []);
      if (types.includes('Files')) return true;
    } catch (e) {}
    try { return !!(dt && dt.files && dt.files.length); } catch (e2) { return false; }
  }

  function hasInternalFm(dt) {
    try {
      const types = Array.from((dt && dt.types) || []);
      return types.includes('application/x-xkeen-fm') || types.includes('text/x-xkeen-fm');
    } catch (e) {
      return false;
    }
  }

  function getInternalFm(dt) {
    let raw = '';
    try { raw = dt.getData('application/x-xkeen-fm') || ''; } catch (e) {}
    if (!raw) { try { raw = dt.getData('text/x-xkeen-fm') || ''; } catch (e) {} }
    if (!raw) { try { raw = dt.getData('text/plain') || ''; } catch (e) {} }
    raw = String(raw || '');
    if (raw.startsWith('xkeen-fm:')) raw = raw.slice('xkeen-fm:'.length);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function clearDropUi() {
    const root = el('fm-root');
    if (!root) return;
    try { qsa('.fm-list.is-drop-target', root).forEach((n) => n.classList.remove('is-drop-target')); } catch (e) {}
    try { qsa('.fm-row.is-drop-target', root).forEach((n) => n.classList.remove('is-drop-target')); } catch (e) {}
  }

  function setDropUi(pd, overRow) {
    clearDropUi();
    try { pd && pd.list && pd.list.classList.add('is-drop-target'); } catch (e) {}
    if (overRow && overRow.classList && overRow.classList.contains('is-dir')) {
      try { overRow.classList.add('is-drop-target'); } catch (e) {}
    }
  }

  async function _runInternalDrop({ dstSide, e, openDropOpModal }) {
    const S = ST.S;
    if (!S || !S.panels) return;

    const drag = getInternalFm(e.dataTransfer);
    if (!drag || !Array.isArray(drag.names) || !drag.names.length) return;

    const srcSide = String(drag.srcSide || '');
    if (srcSide !== 'left' && srcSide !== 'right') return;

    const srcPanel = S.panels[srcSide];
    const dstPanel = S.panels[dstSide];
    if (!srcPanel || !dstPanel) return;

    const srcInfo = drag.src || {};
    const srcTarget = String(srcInfo.target || srcPanel.target || '');
    const srcSid = String(srcInfo.sid || (srcPanel.target === 'remote' ? srcPanel.sid : '') || '');
    const srcCwd = (srcInfo.cwd != null) ? String(srcInfo.cwd) : String(srcPanel.cwd || '');

    // Validate remote sessions
    if (srcTarget === 'remote' && !srcSid) {
      toast('Источник: remote без сессии', 'info');
      return;
    }
    if (dstPanel.target === 'remote' && !dstPanel.sid) {
      toast('Назначение: remote без сессии', 'info');
      return;
    }

    // Destination dir: panel cwd; if dropped onto a directory row -> that directory.
    let dstPath = String(dstPanel.cwd || '');
    const dropRow = e.target && e.target.closest ? e.target.closest('.fm-row.is-dir[data-name]') : null;
    if (dropRow) {
      const dn = String(dropRow.dataset.name || '');
      if (dn) {
        dstPath = (dstPanel.target === 'remote') ? joinRemote(dstPanel.cwd, dn) : joinLocal(dstPanel.cwd, dn);
      }
    }

    const names = Array.from(drag.names || []).map((x) => safeName(x)).filter((x) => !!x);

    const srcItems = Array.from((srcPanel.items || []));
    const sources = names.map((n) => {
      const it = srcItems.find((x) => safeName(x && x.name) === n) || null;
      const t = String((it && it.type) || '');
      const isDir = (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
      const abs = (srcTarget === 'remote') ? joinRemote(srcCwd, n) : joinLocal(srcCwd, n);
      return { path: abs, name: n, is_dir: !!isDir };
    });

    const defaultOp = e.ctrlKey ? 'copy' : 'move';

    // Ask user what to do (Move or Copy) — this is more reliable than Ctrl on some browsers/devices.
    const srcLabel = _panelLabel(srcSide, srcTarget, srcSid, srcCwd);
    const dstLabel = _panelLabel(dstSide, dstPanel.target, (dstPanel.target === 'remote') ? dstPanel.sid : '', dstPath);

    let chosenOp = defaultOp;
    if (typeof openDropOpModal === 'function') {
      chosenOp = await openDropOpModal({ defaultOp, names, srcLabel, dstLabel });
    }
    if (!chosenOp) return;
    const op = String(chosenOp || defaultOp);

    // Safety: prevent pointless move/copy into the same folder when dropping onto panel background.
    try {
      const sameLocalDir = (srcTarget === 'local' && dstPanel.target === 'local'
        && _trimSlashes(String(srcCwd || '')) === _trimSlashes(String(dstPath || '')));
      const sameRemoteDir = (srcTarget === 'remote' && dstPanel.target === 'remote'
        && String(srcSid || '') === String(dstPanel.sid || '')
        && normRemotePath(String(srcCwd || '')) === normRemotePath(String(dstPath || '')));
      if (sameLocalDir || sameRemoteDir) {
        if (op === 'move') toast('Источник и назначение совпадают (move — нечего делать)', 'info');
        else toast('Копирование в тот же каталог через Drag&Drop не поддерживается. Выберите другой каталог назначения или используйте F5.', 'info');
        return;
      }
    } catch (e2) {}

    const payload = {
      op,
      src: {
        target: srcTarget,
        sid: (srcTarget === 'remote') ? srcSid : undefined,
        cwd: srcCwd,
        paths: names,
      },
      dst: {
        target: dstPanel.target,
        sid: (dstPanel.target === 'remote') ? dstPanel.sid : undefined,
        path: dstPath,
        is_dir: true,
      },
      sources,
      options: { overwrite: 'ask' },
    };

    try {
      if (FM.ops && typeof FM.ops.runCopyMoveWithPayload === 'function') {
        await FM.ops.runCopyMoveWithPayload(op, payload);
      }
    } catch (e3) {}
  }

  function attachDragDrop(opts) {
    const o = opts || {};
    const side = String(o.side || '');
    const pd = o.panelDom || null;
    const openDropOpModal = o.openDropOpModal || DD.openDropOpModal;

    if (side !== 'left' && side !== 'right') return;
    if (!pd || !pd.list) return;

    // Prevent duplicate event handlers when view is re-entered.
    try {
      if (pd.list.dataset && pd.list.dataset.fmDndWired === '1') return;
      if (pd.list.dataset) pd.list.dataset.fmDndWired = '1';
    } catch (e) {}

    // Start drag from file rows
    pd.list.addEventListener('dragstart', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
      if (!row || row.classList.contains('fm-row-header')) return;
      const name = String(row.dataset.name || '');
      if (!name) return;

      const S = ST.S;
      const p = S && S.panels ? S.panels[side] : null;
      if (!p) return;

      // Drag selection if dragging a selected item, otherwise drag only the hovered row.
      const sel = Array.from(p.selected || []);
      const names = (sel.length && sel.indexOf(name) >= 0) ? sel : [name];

      const payload = {
        kind: 'xkeen-fm',
        v: 1,
        srcSide: side,
        src: {
          target: p.target,
          sid: (p.target === 'remote') ? (p.sid || '') : '',
          cwd: p.cwd,
        },
        names,
      };

      try { e.dataTransfer.effectAllowed = 'copyMove'; } catch (e2) {}
      try { e.dataTransfer.setData('application/x-xkeen-fm', JSON.stringify(payload)); } catch (e2) {}
      try { e.dataTransfer.setData('text/x-xkeen-fm', JSON.stringify(payload)); } catch (e2) {}
      try { e.dataTransfer.setData('text/plain', 'xkeen-fm:' + JSON.stringify(payload)); } catch (e2) {}
      try { setActiveSide(side); } catch (e2) {}
    });

    pd.list.addEventListener('dragend', () => {
      clearDropUi();
    });

    pd.list.addEventListener('dragover', (e) => {
      if (!e || !e.dataTransfer) return;

      // OS file upload drop
      if (hasFiles(e.dataTransfer)) {
        e.preventDefault();
        return;
      }

      // Internal FM DnD
      if (!hasInternalFm(e.dataTransfer)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch (e2) {}

      const overRow = e.target && e.target.closest ? e.target.closest('.fm-row.is-dir[data-name]') : null;
      setDropUi(pd, overRow);
    });

    pd.list.addEventListener('dragleave', (e) => {
      // Clear highlight when leaving list area
      try {
        const rt = e.relatedTarget;
        if (!rt || (rt !== pd.list && !pd.list.contains(rt))) clearDropUi();
      } catch (e2) {
        clearDropUi();
      }
    });

    pd.list.addEventListener('drop', async (e) => {
      if (!e || !e.dataTransfer) return;

      // Internal FM DnD
      if (hasInternalFm(e.dataTransfer) && !hasFiles(e.dataTransfer)) {
        e.preventDefault();
        clearDropUi();
        await _runInternalDrop({ dstSide: side, e, openDropOpModal });
        return;
      }

      // OS file drop -> upload into this panel (XHR progress).
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      try {
        // Prefer transfers module, fallback to api export.
        if (FM.transfers && typeof FM.transfers.xhrUploadFiles === 'function') {
          await FM.transfers.xhrUploadFiles({ side, files });
        } else if (FM.api && typeof FM.api.xhrUploadFiles === 'function') {
          await FM.api.xhrUploadFiles({ side, files });
        }
      } catch (e2) {}
    });
  }

  // exports
  DD.wireDropOpModal = wireDropOpModal;
  DD.openDropOpModal = openDropOpModal;
  DD.closeDropOpModal = closeDropOpModal;
  DD.attachDragDrop = attachDragDrop;
})();
