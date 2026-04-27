import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager context menu (ПКМ)
  // Exports:
  //   the shared file manager namespace.contextMenu.setDispatcher(fn)
  //   the shared file manager namespace.contextMenu.wireGlobal()
  //   the shared file manager namespace.contextMenu.show(opts)
  //   the shared file manager namespace.contextMenu.hide()

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  FM.contextMenu = FM.contextMenu || {};
  const CM = FM.contextMenu;

  const C = FM.common || {};
  const ST = FM.state || {};
  const SEL = FM.selection || {};

  function getS() {
    try {
      const st = (FM && FM.state) ? FM.state : ST;
      return (st && st.S) ? st.S : {};
    } catch (e) {
      return {};
    }
  }

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function safeName(name, fallback) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(name, fallback); } catch (e) {}
    const s = String(name == null ? '' : name);
    return s || String(fallback || '');
  }

  function toast(msg, kind) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, kind); } catch (e) {}
  }

  function setActiveSide(side) {
    try { if (ST && typeof ST.setActiveSide === 'function') ST.setActiveSide(side); } catch (e) {}
  }

  function getSelectionNames(side) {
    try { if (SEL && typeof SEL.getSelectionNames === 'function') return SEL.getSelectionNames(side) || []; } catch (e) {}
    try {
      const s = getS();
      const p = (s.panels && s.panels[side]) ? s.panels[side] : null;
      return p ? Array.from(p.selected || []) : [];
    } catch (e2) {
      return [];
    }
  }

  function isTrashPanel(p) {
    try { if (ST && typeof ST.isTrashPanel === 'function') return !!ST.isTrashPanel(p); } catch (e) {}
    return false;
  }

  function isLiteMode() {
    try { if (C && typeof C.isLiteMode === 'function') return !!C.isLiteMode(); } catch (e) {}
    try {
      const s = getS();
      if (s && typeof s.liteMode === 'boolean') return !!s.liteMode;
    } catch (e2) {}
    return false;
  }

  function _isArchiveFileName(n) {
    const s = String(n || '').toLowerCase();
    return s.endsWith('.zip')
      || s.endsWith('.tar')
      || s.endsWith('.tar.gz')
      || s.endsWith('.tgz')
      || s.endsWith('.tar.xz')
      || s.endsWith('.txz')
      || s.endsWith('.tar.bz2')
      || s.endsWith('.tbz2');
  }

  // --- dispatcher (provided by file_manager.js)
  let _dispatcher = null;
  CM.setDispatcher = function setDispatcher(fn) {
    _dispatcher = (typeof fn === 'function') ? fn : null;
  };

  async function _dispatch(act, ctx) {
    if (typeof _dispatcher !== 'function') return;
    return _dispatcher(act, ctx);
  }

  // -------------------------- DOM helpers --------------------------
  function ensureCtxMenuEl() {
    let m = el('fm-context-menu');
    if (m) return m;
    try {
      m = document.createElement('div');
      m.id = 'fm-context-menu';
      m.className = 'fm-context-menu hidden';
      m.setAttribute('role', 'menu');
      m.setAttribute('aria-label', 'Файловое меню');
      document.body.appendChild(m);
    } catch (e) {
      return null;
    }
    return m;
  }

  function hide() {
    const m = ensureCtxMenuEl();
    if (!m) return;
    try { m.classList.add('hidden'); } catch (e) {}
    try { m.innerHTML = ''; } catch (e) {}
    try {
      const s = getS();
      if (s) s.ctxMenu = Object.assign({}, (s.ctxMenu || {}), { shown: false });
    } catch (e) {}
  }

  function _ctxSep() {
    const d = document.createElement('div');
    d.className = 'fm-context-sep';
    d.setAttribute('role', 'separator');
    return d;
  }

  function _ctxBtn(label, action, kbd) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm-context-item';
    b.dataset.action = String(action || '');
    const left = document.createElement('span');
    left.className = 'fm-context-label';
    left.textContent = String(label || '');
    b.appendChild(left);
    if (kbd) {
      const right = document.createElement('span');
      right.className = 'fm-context-kbd';
      right.textContent = String(kbd || '');
      b.appendChild(right);
    }
    return b;
  }

  function build(menu, opts) {
    if (!menu) return;
    const o = opts || {};
    const s = getS();
    const side = String((o.side) || s.activeSide || 'left');
    const p = (s.panels && s.panels[side]) ? s.panels[side] : null;
    const isRemotePanel = !!p && String(p.target || 'local') === 'remote';
    const hasRow = !!o.hasRow;
    const isDir = !!o.isDir;

    const rowName = safeName(o.name || '');
    const selNames = p ? (getSelectionNames(side) || []) : [];
    const hasSelection = !!(selNames && selNames.length);
    const inTrash = !!(p && isTrashPanel(p));
    const lite = isLiteMode();

    // Archive actions (local only): prefer selection, fallback to the row item.
    const candNames = (selNames && selNames.length) ? selNames : (rowName ? [rowName] : []);
    const canArchive = (!isRemotePanel) && !inTrash && (candNames.length > 0);
    let canExtract = false;
    try {
      if ((!isRemotePanel) && !inTrash && candNames.length === 1) {
        const nm = safeName(candNames[0]);
        if (nm && _isArchiveFileName(nm)) {
          const it = (p && p.items) ? (p.items || []).find(x => safeName(x && x.name) === nm) : null;
          const t = String((it && it.type) || '');
          const isD = (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
          canExtract = !isD;
        }
      }
    } catch (e) { canExtract = false; }

    // Diff: appear on a single non-dir file row (cross-panel mode), or when
    // exactly two non-dir files are selected (pair mode). No remote/local
    // restriction — both panels independently fetch via /api/fs/read.
    let canCompareSelected = false;
    let canCompareCross = false;
    try {
      const _itemByName = (n) => (p && p.items)
        ? (p.items || []).find(x => safeName(x && x.name) === n) : null;
      const _isDirItem = (it) => {
        const t = String((it && it.type) || '');
        return t === 'dir' || (t === 'link' && !!(it && it.link_dir));
      };
      if (!inTrash && selNames.length === 2) {
        const both = selNames.every((n) => {
          const it = _itemByName(n);
          return !!it && !_isDirItem(it);
        });
        if (both) canCompareSelected = true;
      }
      if (!inTrash && hasRow && !isDir && rowName) {
        canCompareCross = true;
      }
    } catch (e) {
      canCompareSelected = false;
      canCompareCross = false;
    }

    // Capabilities (best-effort; default allow)
    let canChmod = true;
    let canChown = true;
    try {
      const rf = (s.caps && s.caps.remoteFs) ? s.caps.remoteFs : null;
      const fa = (rf && rf.fs_admin) ? rf.fs_admin : null;
      const local = (fa && fa.local) ? fa.local : {};
      const remote = (fa && fa.remote) ? fa.remote : {};
      const isRemote = isRemotePanel;
      canChmod = isRemote ? !!remote.chmod : !!local.chmod;
      canChown = isRemote ? !!remote.chown : !!local.chown;
      const protos = Array.isArray(remote.chown_protocols) ? remote.chown_protocols.map(String) : [];
      if (isRemote && protos.length) {
        const rproto = String((p && p.rproto) || '').trim().toLowerCase();
        if (rproto) {
          canChown = canChown && protos.includes(rproto);
        } else {
          // If protocol is unknown on the UI side, keep menu visible only if SFTP is allowed.
          canChown = canChown && protos.includes('sftp');
        }
      }
      // Remote requires active session.
      if (isRemote && (!p || !p.sid)) {
        canChmod = false;
        canChown = false;
      }
    } catch (e) {
      // keep defaults
    }

    menu.innerHTML = '';

    if (!hasRow && hasSelection) {
      menu.appendChild(_ctxBtn('Скачать', 'download', ''));
      if (!lite && canArchive) menu.appendChild(_ctxBtn('Архивировать…', 'archive_create', ''));
      if (canExtract) menu.appendChild(_ctxBtn('Содержимое архива…', 'archive_list', ''));
      if (!lite && canExtract) menu.appendChild(_ctxBtn('Распаковать…', 'archive_extract', ''));
      if (canCompareSelected) menu.appendChild(_ctxBtn('Сравнить выделенные', 'compare', ''));
      menu.appendChild(_ctxBtn('Свойства…', 'props', ''));
      menu.appendChild(_ctxSep());
    }

    if (hasRow) {
      menu.appendChild(_ctxBtn(isDir ? 'Открыть папку' : 'Открыть', 'open', 'Enter'));
      if (!lite && !isRemotePanel) {
        menu.appendChild(_ctxBtn(isDir ? 'Терминал здесь' : 'Терминал в папке', 'terminal_here', ''));
      }
      menu.appendChild(_ctxBtn('Скачать', 'download', ''));
      if (!lite && canArchive) menu.appendChild(_ctxBtn('Архивировать…', 'archive_create', ''));
      if (canExtract) menu.appendChild(_ctxBtn('Содержимое архива…', 'archive_list', ''));
      if (!lite && canExtract) menu.appendChild(_ctxBtn('Распаковать…', 'archive_extract', ''));
      menu.appendChild(_ctxBtn('Копировать полный путь', 'copy_path', 'Ctrl+Shift+C'));
      if (canCompareSelected) {
        menu.appendChild(_ctxBtn('Сравнить выделенные', 'compare', ''));
      } else if (canCompareCross) {
        menu.appendChild(_ctxBtn('Сравнить с другой панелью', 'compare', ''));
      }
      menu.appendChild(_ctxSep());
      if (!lite) menu.appendChild(_ctxBtn('Копировать', 'copy', 'F5'));
      if (!lite) menu.appendChild(_ctxBtn('Переместить', 'move', 'F6'));
      menu.appendChild(_ctxBtn('Переименовать', 'rename', 'F2'));
      menu.appendChild(_ctxBtn('Свойства…', 'props', ''));
      if (!lite && !isDir) menu.appendChild(_ctxBtn('Checksum (MD5/SHA256)…', 'checksum', ''));
      if (canChmod) menu.appendChild(_ctxBtn('Права (chmod)…', 'chmod', ''));
      if (canChown) menu.appendChild(_ctxBtn('Владелец (chown)…', 'chown', ''));
      if (inTrash) menu.appendChild(_ctxBtn('Восстановить', 'restore', ''));
      if (!lite) menu.appendChild(_ctxBtn(inTrash ? 'Удалить навсегда' : 'В корзину', 'delete', 'F8'));
      menu.appendChild(_ctxSep());
    }

    menu.appendChild(_ctxBtn('Создать папку', 'mkdir', 'F7'));
    menu.appendChild(_ctxBtn('Создать файл', 'touch', 'Shift+F7'));
    menu.appendChild(_ctxSep());
    menu.appendChild(_ctxBtn('Выделить всё', 'select_all', 'Ctrl+A'));
    menu.appendChild(_ctxBtn('Инвертировать выделение', 'invert_sel', 'Ctrl+I'));
    menu.appendChild(_ctxBtn('Выделить по маске…', 'mask_sel', 'Ctrl+M'));
    if (!hasRow) {
      // For an empty-area menu, provide path copy (cwd/selection).
      menu.appendChild(_ctxBtn('Копировать полный путь', 'copy_path', 'Ctrl+Shift+C'));
    }
    menu.appendChild(_ctxSep());
    menu.appendChild(_ctxBtn('Загрузить (Upload)…', 'upload', ''));
    if (!lite && !hasRow && !isRemotePanel) {
      menu.appendChild(_ctxBtn('Терминал здесь', 'terminal_here', ''));
    }
    menu.appendChild(_ctxBtn('Вверх', 'up', 'Backspace'));
    menu.appendChild(_ctxBtn('Обновить', 'refresh', '⟳'));
  }

  function show(opts) {
    const m = ensureCtxMenuEl();
    if (!m) return;

    const s = getS();
    const side = String((opts && opts.side) || s.activeSide || 'left');
    const name = safeName((opts && opts.name) || '');
    const isDir = !!(opts && opts.isDir);
    const hasRow = !!(opts && opts.hasRow);

    // store context for actions
    try { const st = getS(); st.ctxMenu = { shown: true, side, name, isDir, hasRow }; } catch (e) {}

    build(m, { side, hasRow, isDir, name });

    // Position (fixed to viewport)
    try {
      m.style.position = 'fixed';
      m.style.left = '0px';
      m.style.top = '0px';
      m.style.maxWidth = 'calc(100vw - 16px)';
      m.style.maxHeight = 'calc(100vh - 16px)';
    } catch (e) {}

    try { m.classList.remove('hidden'); } catch (e) {}

    const x0 = Number((opts && opts.x) || 0);
    const y0 = Number((opts && opts.y) || 0);

    // Clamp into viewport after measuring
    try {
      const pad = 8;
      const w = m.offsetWidth || 240;
      const h = m.offsetHeight || 200;
      const vw = window.innerWidth || (w + pad * 2);
      const vh = window.innerHeight || (h + pad * 2);
      const x = Math.max(pad, Math.min(vw - w - pad, x0));
      const y = Math.max(pad, Math.min(vh - h - pad, y0));
      m.style.left = x + 'px';
      m.style.top = y + 'px';
    } catch (e) {}
  }

  function wireGlobal() {
    // only once
    try {
      if (document.body && document.body.dataset && document.body.dataset.fmCtxInit === '1') return;
      if (document.body && document.body.dataset) document.body.dataset.fmCtxInit = '1';
    } catch (e) {}

    const m = ensureCtxMenuEl();
    if (!m) return;

    // Menu action dispatcher
    m.addEventListener('click', async (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button.fm-context-item[data-action]') : null;
      const act = b ? String(b.dataset.action || '') : '';
      if (!act) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}

      const s = getS();
      const ctx = (s && s.ctxMenu) ? s.ctxMenu : {};
      const side = String(ctx.side || (s && s.activeSide) || 'left');

      // Close menu first (so UI feels snappy)
      hide();

      // Ensure side active for actions relying on S.activeSide
      try { setActiveSide(side); } catch (e3) {}

      // If menu was opened on a row, ensure focus is on that row
      try {
        const s = getS();
      const p = (s.panels && s.panels[side]) ? s.panels[side] : null;
        if (p && ctx.name) p.focusName = safeName(ctx.name);
      } catch (e4) {}

      try {
        await _dispatch(act, ctx);
      } catch (err) {
        toast('FM: действие не выполнено', 'error');
      }
    }, true);

    // Close on outside click / scroll / resize / Escape
    document.addEventListener('mousedown', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      if (e && e.target && mm.contains(e.target)) return;
      hide();
    }, true);

    // Do NOT close the menu when user scrolls over it (wheel/trackpad) —
    // it's too easy to dismiss the menu accidentally.
    // Still close it on wheel/scroll happening outside of the menu.
    document.addEventListener('wheel', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;

      // When the pointer is over the menu, keep it open and prevent the
      // underlying panel/page from scrolling (otherwise a scroll event would
      // fire and close the menu anyway).
      if (e && e.target && mm.contains(e.target)) {
        try { e.preventDefault(); } catch (e2) {}
        try { e.stopPropagation(); } catch (e3) {}
        return;
      }

      hide();
    }, { capture: true, passive: false });

    document.addEventListener('scroll', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      // Allow scrolling inside the context menu without dismissing it.
      if (e && e.target && mm.contains(e.target)) return;
      hide();
    }, true);

    window.addEventListener('resize', () => hide(), true);

    document.addEventListener('keydown', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      if (e && e.key === 'Escape') {
        try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}
        hide();
      }
    }, true);
  }

  // exports
  CM.wireGlobal = wireGlobal;
  CM.show = show;
  CM.hide = hide;
})();
