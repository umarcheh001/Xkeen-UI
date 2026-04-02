import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager actions & dialogs (create/rename/archive/chmod/chown/pickers)
  // No ES modules / bundler: attach to the shared file manager namespace.actions

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.actions = FM.actions || {};
  const AC = FM.actions;

  const C = FM.common || {};
  FM.api = FM.api || {};
  const A = FM.api;
  const SEL = FM.selection || {};

  // Always point to the shared state object
  const S = (() => {
    try {
      FM.state = FM.state || {};
      FM.state.S = FM.state.S || {};
      return FM.state.S;
    } catch (e) {
      return {};
    }
  })();

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
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e2) { return []; }
  }

  function show(node) {
    if (!node) return;
    try { node.style.display = ''; } catch (e) {}
  }

  function hide(node) {
    if (!node) return;
    try { node.style.display = 'none'; } catch (e) {}
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    try { if (modal) modal.classList.add('hidden'); } catch (e2) {}
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function safeName(s) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(s); } catch (e) {}
    return String(s == null ? '' : s);
  }

  function joinLocal(cwd, name) {
    try { if (C && typeof C.joinLocal === 'function') return C.joinLocal(cwd, name); } catch (e) {}
    const c = String(cwd || '');
    const n = String(name || '');
    if (!c) return n;
    if (!n) return c;
    const sep = c.endsWith('/') ? '' : '/';
    return c + sep + n;
  }

  function joinRemote(cwd, name) {
    try { if (C && typeof C.joinRemote === 'function') return C.joinRemote(cwd, name); } catch (e) {}
    const c0 = String(cwd || '').trim() || '.';
    const n0 = String(name || '').trim();
    if (!n0) return c0;
    if (n0.startsWith('/')) return n0.replace(/\/+$/, '') || '/';
    const sep = c0.endsWith('/') ? '' : '/';
    return (c0 === '.' ? n0 : (c0 + sep + n0)).replace(/\/\/+/, '/');
  }

  function normRemotePath(p) {
    try { if (C && typeof C.normRemotePath === 'function') return C.normRemotePath(p); } catch (e) {}
    let s = String(p || '').trim();
    if (!s || s === '~') return '.';
    if (s === '.') return '.';
    s = s.replace(/\/{2,}/g, '/');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return s || '.';
  }

  function fmtSize(n) {
    try { if (C && typeof C.fmtSize === 'function') return C.fmtSize(n); } catch (e) {}
    try {
      const v = Number(n || 0);
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let x = v;
      let i = 0;
      while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
      return (i === 0 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)) + ' ' + units[i];
    } catch (e2) { return String(n || ''); }
  }

  function fmtTime(ts) {
    try { if (C && typeof C.fmtTime === 'function') return C.fmtTime(ts); } catch (e) {}
    try { return new Date(Number(ts || 0) * 1000).toLocaleString(); } catch (e2) { return ''; }
  }

  function getSelectionNames(side) {
    try { if (SEL && typeof SEL.getSelectionNames === 'function') return SEL.getSelectionNames(side); } catch (e) {}
    return [];
  }

  async function fetchJson(url, init) {
    if (A && typeof A.fetchJson === 'function') return await A.fetchJson(url, init);
    throw new Error('FM.api.fetchJson missing');
  }

  async function listPanel(side, opts) {
    try { if (A && typeof A.listPanel === 'function') return await A.listPanel(side, opts || {}); } catch (e) {}
    return null;
  }

  // -------------------------- create folder / empty file --------------------------
    function _leafName(p) {
      const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
      if (!s) return '';
      const parts = s.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    }

    function _displayCwd(panel) {
      if (!panel) return '';
      if (panel.target === 'remote') {
        const v = String(panel.cwd || '').trim();
        return (!v || v === '.') ? '~' : v;
      }
      return String(panel.cwd || '');
    }

    function _calcCreatePath(panel, name) {
      const nm = String(name || '').trim();
      if (!nm) return '';
      if (panel && panel.target === 'remote') {
        // allow absolute remote paths
        return nm.startsWith('/') ? normRemotePath(nm) : joinRemote(panel.cwd, nm);
      }
      // local
      return nm.startsWith('/') ? nm : joinLocal(panel ? panel.cwd : '', nm);
    }

    function openCreateModal(kind) {
      const modal = el('fm-create-modal');
      if (!modal) return;

      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      S.create = { kind: String(kind || ''), side };

      const title = el('fm-create-title');
      const ok = el('fm-create-ok-btn');
      const nameInput = el('fm-create-name');
      const dest = el('fm-create-dest');
      const err = el('fm-create-error');
      const parents = el('fm-create-parents');
      const createOnlyRow = el('fm-create-createonly-row');
      const createOnly = el('fm-create-createonly');

      if (err) err.textContent = '';
      if (nameInput) {
        try { nameInput.value = ''; } catch (e) {}
        nameInput.placeholder = (kind === 'dir') ? 'new-folder' : 'example.txt';
      }

      if (title) title.textContent = (kind === 'dir') ? 'Создать папку' : 'Создать файл';
      if (ok) ok.textContent = 'Создать';

      // parents checkbox is helpful for nested paths in both cases.
      if (parents) {
        parents.checked = true;
      }

      // create_only only makes sense for files.
      if (createOnlyRow) {
        if (kind === 'file') show(createOnlyRow); else hide(createOnlyRow);
      }
      if (createOnly) {
        createOnly.checked = true;
      }

      if (dest) {
        const tgt = String(p.target || 'local');
        dest.textContent = `${side.toUpperCase()} • ${tgt} • ${_displayCwd(p)}`;
      }

      modalOpen(modal);
      try { setTimeout(() => { try { nameInput && nameInput.focus(); } catch (e) {} }, 0); } catch (e) {}
    }

    function closeCreateModal() {
      modalClose(el('fm-create-modal'));
    }

    // -------------------------- rename (file / folder) --------------------------
    function _isBadLeafName(n) {
      const s = String(n || '').trim();
      if (!s) return true;
      if (s === '.' || s === '..') return true;
      // For rename we only allow leaf names (no path separators)
      if (s.includes('/') || s.includes('\\')) return true;
      return false;
    }

    function _guessSelectRange(name, isDir) {
      const s = String(name || '');
      if (!s) return [0, 0];
      if (isDir) return [0, s.length];
      const dot = s.lastIndexOf('.');
      if (dot > 0 && dot < s.length - 1) return [0, dot];
      return [0, s.length];
    }

    function openRenameModal() {
      const modal = el('fm-rename-modal');
      if (!modal) return;

      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      const names = getSelectionNames(side);
      if (names.length !== 1) {
        toast('Для переименования выберите один файл или папку', 'info');
        return;
      }

      const oldName = safeName(names[0]);
      const it = (p.items || []).find((x) => safeName(x && x.name) === oldName) || null;
      const type = String((it && it.type) || '');
      const isDir = (type === 'dir') || (type === 'link' && !!(it && it.link_dir));

      S.rename = { side, oldName };

      const title = el('fm-rename-title');
      const ok = el('fm-rename-ok-btn');
      const input = el('fm-rename-name');
      const srcEl = el('fm-rename-src');
      const err = el('fm-rename-error');

      if (err) err.textContent = '';
      if (title) title.textContent = isDir ? 'Переименовать папку' : 'Переименовать файл';
      if (ok) ok.textContent = 'Переименовать';

      if (input) {
        try { input.value = oldName; } catch (e) {}
        try { input.setAttribute('spellcheck', 'false'); } catch (e) {}
      }

      if (srcEl) {
        const tgt = String(p.target || 'local');
        const full = (tgt === 'remote') ? joinRemote(p.cwd, oldName) : joinLocal(p.cwd, oldName);
        srcEl.textContent = `${side.toUpperCase()} • ${tgt}${(tgt === 'remote' && p.sid) ? ' (' + p.sid + ')' : ''} • ${full}`;
      }

      modalOpen(modal);

      try {
        setTimeout(() => {
          try {
            if (input && input.focus) input.focus();
            const [a, b] = _guessSelectRange(oldName, isDir);
            if (input && input.setSelectionRange) input.setSelectionRange(a, b);
          } catch (e) {}
        }, 0);
      } catch (e) {}
    }

    function closeRenameModal() {
      modalClose(el('fm-rename-modal'));
    }

    async function doRenameFromModal() {
      const modal = el('fm-rename-modal');
      if (!modal) return;

      const err = el('fm-rename-error');
      if (err) err.textContent = '';

      const side = String((S.rename && S.rename.side) || S.activeSide || 'left');
      const oldName = safeName((S.rename && S.rename.oldName) || '');
      const p = S.panels[side];
      if (!p || !oldName) return;

      const input = el('fm-rename-name');
      const newName = String((input && input.value) || '').trim();

      if (_isBadLeafName(newName)) {
        if (err) err.textContent = 'Введите корректное имя (без "/" и "\\").';
        return;
      }

      if (newName === oldName) {
        closeRenameModal();
        return;
      }

      // Basic collision check in current listing (prevents accidental overwrite).
      try {
        const existing = new Set((p.items || []).map((it) => safeName(it && it.name)));
        if (existing.has(newName)) {
          if (err) err.textContent = 'Такое имя уже существует в текущем каталоге.';
          return;
        }
      } catch (e) {}

      if (p.target === 'remote' && !p.sid) {
        toast('Remote: нет активной сессии (Connect…)', 'info');
        return;
      }

      const srcPath = (p.target === 'remote') ? joinRemote(p.cwd, oldName) : joinLocal(p.cwd, oldName);
      const dstPath = (p.target === 'remote') ? joinRemote(p.cwd, newName) : joinLocal(p.cwd, newName);

      const body = { target: p.target, src: srcPath, dst: dstPath };
      if (p.target === 'remote') body.sid = p.sid;

      const { res, data } = await fetchJson('/api/fs/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'rename_failed';
        if (err) err.textContent = msg;
        toast('FM: ' + msg, 'error');
        return;
      }

      toast('Переименовано: ' + oldName + ' → ' + newName, 'success');

      // Refresh and focus new name
      try {
        p.focusName = newName;
        p.selected.clear();
        p.selected.add(newName);
        p.anchorName = newName;
      } catch (e) {}

      await listPanel(side, { fromInput: false });
      closeRenameModal();
    }


    // -------------------------- archive create / extract --------------------------
    function _isArchiveFileName(n) {
      const s = String(n || '').toLowerCase();
      return s.endsWith('.zip')
        || s.endsWith('.tar')
        || s.endsWith('.tar.gz')
        || s.endsWith('.tgz')
        || s.endsWith('.tar.bz2')
        || s.endsWith('.tbz')
        || s.endsWith('.tbz2')
        || s.endsWith('.tar.xz')
        || s.endsWith('.txz');
    }

    function _stripArchiveExt(n) {
      const s = String(n || '').trim();
      if (!s) return '';
      return s
        .replace(/\.(zip)$/i, '')
        .replace(/\.(tgz)$/i, '')
        .replace(/\.(tar\.gz)$/i, '')
        .replace(/\.(tar\.bz2)$/i, '')
        .replace(/\.(tbz2?)$/i, '')
        .replace(/\.(tar\.xz)$/i, '')
        .replace(/\.(txz)$/i, '')
        .replace(/\.(tar)$/i, '');
    }

    function _ensureArchiveExt(name, fmt) {
      const f = String(fmt || 'zip').toLowerCase();
      const base = _stripArchiveExt(String(name || '').trim()) || 'archive';
      return (f === 'tar.gz' || f === 'tgz' || f === 'tar_gz') ? (base + '.tar.gz') : (base + '.zip');
    }

    function _defaultArchiveBase(side, names) {
      const p = S.panels[side];
      const sel = Array.isArray(names) ? names.map(safeName).filter(Boolean) : [];
      if (sel.length === 1) {
        const one = sel[0];
        // Prefer stripping existing extension for files.
        return _stripArchiveExt(one) || one;
      }
      // Use current directory leaf
      const cwd = String((p && p.cwd) || '').trim();
      if (p && p.target === 'remote') {
        const c = normRemotePath(cwd);
        if (!c || c === '.' || c === '/') return 'selection';
        const parts = c.split('/').filter(Boolean);
        return parts.length ? (parts[parts.length - 1] + '_selection') : 'selection';
      }
      const c = cwd.replace(/\/+$/, '');
      if (!c || c === '/') return 'selection';
      const idx = c.lastIndexOf('/');
      const leaf = (idx >= 0) ? (c.slice(idx + 1) || 'selection') : (c || 'selection');
      return leaf + '_selection';
    }

    function openArchiveModal() {
      const modal = el('fm-archive-modal');
      if (!modal) return;

      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      if (p.target !== 'local') {
        toast('Архивация доступна только для local панели', 'info');
        return;
      }    let names = getSelectionNames(side);
      if (!names.length) {
        const fn = safeName(p.focusName || '');
        if (fn) names = [fn];
      }
      if (!names.length) {
        toast('Выберите файлы/папки для архивирования', 'info');
        return;
      }

      const prevFmt = String((S.archive && S.archive.fmt) || 'zip').toLowerCase();
      const fmt0 = (prevFmt === 'tar.gz') ? 'tar.gz' : 'zip';
      S.archive = { side, names: names.slice(), fmt: fmt0 };

      const srcEl = el('fm-archive-src');
      const listEl = el('fm-archive-list');
      const nameInp = el('fm-archive-name');
      const fmtSel = el('fm-archive-format');
      const ow = el('fm-archive-overwrite');
      const err = el('fm-archive-error');
      const titleEl = el('fm-archive-title');

      if (err) err.textContent = '';
      if (ow) ow.checked = false;
      if (fmtSel) {
        try { fmtSel.value = fmt0; } catch (e) {}
      }
      if (titleEl) {
        titleEl.textContent = (names.length === 1) ? 'Архивировать' : `Архивировать (${names.length})`;
      }
      if (srcEl) {
        srcEl.textContent = `${side.toUpperCase()} • local • ${_displayCwd(p)}`;
      }
      if (listEl) {
        listEl.textContent = names.map(n => '• ' + safeName(n)).join('\n');
      }
      if (nameInp) {
        const base = _defaultArchiveBase(side, names);
        const suggested = _ensureArchiveExt(base, fmt0);
        try { nameInp.value = suggested; } catch (e) {}
        try { nameInp.setAttribute('spellcheck', 'false'); } catch (e) {}
      }

      modalOpen(modal);
      try { setTimeout(() => { try { nameInp && nameInp.focus(); nameInp && nameInp.select && nameInp.select(); } catch (e) {} }, 0); } catch (e) {}
    }

    function closeArchiveModal() {
      modalClose(el('fm-archive-modal'));
    }

    async function doArchiveFromModal() {
      const err = el('fm-archive-error');
      if (err) err.textContent = '';

      const side = String((S.archive && S.archive.side) || S.activeSide || 'left');
      const p = S.panels[side];
      if (!p) return;

      if (p.target !== 'local') {
        toast('Архивация доступна только для local панели', 'info');
        return;
      }

      const names = Array.isArray(S.archive && S.archive.names) ? S.archive.names.slice() : [];
      if (!names.length) {
        if (err) err.textContent = 'Нет выбранных элементов.';
        return;
      }

      const nameInp = el('fm-archive-name');
      const fmtSel = el('fm-archive-format');
      const ow = el('fm-archive-overwrite');
      const fmt = String((fmtSel && fmtSel.value) || 'zip').trim().toLowerCase();
      let nm = String((nameInp && nameInp.value) || '').trim();
      nm = _ensureArchiveExt(nm || 'archive', fmt);

      // leaf only
      if (_isBadLeafName(nm)) {
        if (err) err.textContent = 'Введите имя архива без "/" и "\\".';
        return;
      }

      const items = [];
      for (const n of names) {
        const leaf = safeName(n);
        if (!leaf) continue;
        items.push({ path: joinLocal(p.cwd, leaf) });
      }
      if (!items.length) {
        if (err) err.textContent = 'Нет выбранных элементов.';
        return;
      }

      const body = {
        op: 'zip',
        target: 'local',
        cwd: String(p.cwd || ''),
        name: nm,
        format: fmt,
        overwrite: !!(ow && ow.checked),
        items,
      };

      // Queue as fileops job (FM-20)
      let jobId = '';
      try {
        if (FM.ops && typeof FM.ops.executeJob === 'function') jobId = await FM.ops.executeJob(body);
      } catch (e) { jobId = ''; }

      if (!jobId) {
        const msg = 'archive_job_failed';
        if (err) err.textContent = msg;
        toast('FM: ' + msg, 'error');
        return;
      }

      toast('Архивация запущена', 'info');
      closeArchiveModal();

      // Preselect created archive name; actual refresh will happen when job finishes.
      try {
        const created = safeName(String(nm));
        p.focusName = created;
        p.selected.clear();
        p.selected.add(created);
        p.anchorName = created;
      } catch (e) {}
    }

    function openExtractModal() {
      const modal = el('fm-extract-modal');
      if (!modal) return;

      const titleEl = el('fm-extract-title');

      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      if (p.target !== 'local') {
        toast('Распаковка доступна только для local панели', 'info');
        return;
      }    const names = getSelectionNames(side);
      if (names.length > 1) {
        toast('Для распаковки выберите один архив', 'info');
        return;
      }
      const name = safeName(names.length === 1 ? names[0] : (p.focusName || ''));
      if (!name) {
        toast('Выберите архив для распаковки', 'info');
        return;
      }
      if (!_isArchiveFileName(name)) {
        toast('Выбранный файл не похож на архив (.zip/.tar/.tar.gz)', 'info');
        return;
      }

      S.extract = { side, name };
      if (titleEl) titleEl.textContent = 'Распаковать';

      const archEl = el('fm-extract-archive');
      const destInp = el('fm-extract-dest');
      const mk = el('fm-extract-create-dest');
      const strip = el('fm-extract-strip-top');
      const flat = el('fm-extract-flatten');
      const ow = el('fm-extract-overwrite');
      const err = el('fm-extract-error');

      if (err) err.textContent = '';
      if (mk) mk.checked = true;
      if (strip) strip.checked = false;
      if (flat) { flat.checked = false; flat.disabled = true; }
      if (ow) ow.checked = false;

      const full = joinLocal(p.cwd, name);
      if (archEl) archEl.textContent = `${side.toUpperCase()} • local • ${full}`;

      if (destInp) {
        let base = _stripArchiveExt(name) || (name.replace(/\.[^.]+$/, '') || 'out');

        // For archives like "file.txt.zip" suggest a nicer folder name ("file")
        // and avoid common conflicts (e.g. the original file "file.txt" exists).
        try {
          const m = String(base || '').match(/^(.*)\.([A-Za-z]{1,5})$/);
          if (m && m[1] != null && m[2] != null) {
            const ext = String(m[2] || '').toLowerCase();
            const known = new Set(['txt','log','json','yaml','yml','conf','ini','cfg','sh','md','csv','xml','html','js','css','py','lua','db','sqlite','dat','bin']);
            if (known.has(ext)) base = String(m[1] || base);
          }
        } catch (e) {}

        let suggested = String(base || 'out').trim() || 'out';

        // Avoid conflicts with existing items in the current folder.
        try {
          const existing = new Set((p.items || []).map((it) => safeName(it && it.name)));
          if (existing.has(suggested)) {
            const candidates = _buildRenameCandidates(suggested, 60);
            for (const nm of candidates) {
              if (!existing.has(nm)) { suggested = nm; break; }
            }
          }
        } catch (e) {}

        try { destInp.value = suggested; } catch (e) {}
        try { destInp.setAttribute('spellcheck', 'false'); } catch (e) {}

        // UX: if the user disables "Распаковать в отдельную папку", we extract into current directory.
        // In that mode the destination input is informational only, so we disable it.
        try {
          if (mk) {
            mk.onchange = () => {
              const on = !!mk.checked;
              try { destInp.disabled = !on; } catch (e) {}
              try { const pb = el('fm-extract-dest-pick-btn'); if (pb) pb.disabled = !on; } catch (e) {}
              try {
                if (!on) {
                  if (!destInp.dataset.prevValue) destInp.dataset.prevValue = String(destInp.value || '');
                  destInp.value = '';
                  destInp.placeholder = 'Текущая папка';
                  // Common expectation: if we extract directly into current folder,
                  // we usually don't want an extra single top-level directory from the archive.
                  try { if (strip) strip.checked = true; } catch (e2) {}
                } else {
                  const pv = String(destInp.dataset.prevValue || '');
                  if (pv) destInp.value = pv;
                  destInp.placeholder = '';
                  try { if (strip) strip.checked = false; } catch (e2) {}
                }
              } catch (e) {}
            };
            // Initialize once
            mk.onchange();
          }
        } catch (e) {}
      }

      modalOpen(modal);
      try { setTimeout(() => { try { destInp && destInp.focus(); destInp && destInp.select && destInp.select(); } catch (e) {} }, 0); } catch (e) {}
    }

    function closeExtractModal() {
      modalClose(el('fm-extract-modal'));
      try { if (S.extract) S.extract.items = null; } catch (e) {}
    }
  

    // -------------------------- folder picker modal --------------------------

    function _fpIsDir(it) {
      const type = String((it && it.type) || '');
      const linkDir = !!(it && it.link_dir);
      return type === 'dir' || (type === 'link' && linkDir);
    }

    function _parentLocalPath(path) {
      try {
        let s = String(path || '').replace(/\\/g, '/');
        s = s.replace(/\/+$/, '');
        if (!s || s === '/') return '/';
        const idx = s.lastIndexOf('/');
        if (idx <= 0) return '/';
        return s.slice(0, idx) || '/';
      } catch (e) {
        return '/';
      }
    }

    function _isAllowedLocalPath(pth, roots) {
      try {
        let p = String(pth || '').replace(/\\/g, '/');
        p = p.replace(/\/+$/, '');
        if (!p) p = '/';
        const rs = Array.isArray(roots) ? roots : [];
        for (const r0 of rs) {
          let r = String(r0 || '').replace(/\\/g, '/');
          r = r.replace(/\/+$/, '');
          if (!r) continue;
          if (p === r || p.startsWith(r + '/')) return true;
        }
      } catch (e) {}
      return false;
    }

    function closeFolderPicker() {
      try { modalClose(el('fm-folder-picker-modal')); } catch (e) {}
      try { S.folderPicker = null; } catch (e) {}
    }

    function _folderPickerPick(path) {
      const fp = S.folderPicker;
      if (!fp) return;
      try {
        if (typeof fp.onPick === 'function') fp.onPick(String(path || ''));
      } catch (e) {}
      closeFolderPicker();
    }

    function _folderPickerChosenPath() {
      const fp = S.folderPicker;
      if (!fp) return '';
      let base = String(fp.path || '').trim();
      if (!base) base = (fp.roots && fp.roots[0]) ? String(fp.roots[0]) : '/opt/var';
      const sel = safeName(fp.selected || '');
      if (sel && sel !== '..') {
        try {
          if (fp.target === 'remote') {
            return normRemotePath(base.replace(/\/+$/, '') + '/' + sel);
          }
        } catch (e) {}
        return joinLocal(base, sel);
      }
      return base;
    }

    function renderFolderPicker() {
      const fp = S.folderPicker;
      if (!fp) return;
      const list = el('fm-folder-picker-list');
      const pathInp = el('fm-folder-picker-path');
      const status = el('fm-folder-picker-status');

      try { if (pathInp) pathInp.value = String(fp.path || ''); } catch (e) {}

      if (status) {
        const t = (fp.target === 'remote') ? 'REMOTE' : 'LOCAL';
        status.textContent = `${t} • ${fp.path || ''}`;
      }

      if (!list) return;
      list.innerHTML = '';

      const mkRow = (name, isUp) => {
        const row = document.createElement('div');
        row.className = 'fm-row is-dir';
        row.tabIndex = -1;
        row.dataset.name = name;
        row.dataset.up = isUp ? '1' : '0';
        row.innerHTML = `<div class="fm-cell fm-name"><span class="fm-ico">${isUp ? '↩' : '📁'}</span><span class="fm-name-text"></span></div>`;
        try {
          const t = qs('.fm-name-text', row);
          if (t) t.textContent = name;
        } catch (e) {}
        return row;
      };

      // Up entry (only when it makes sense inside allowed roots)
      try {
        const cur = String(fp.path || '').replace(/\/+$/, '') || '/';
        if (fp.target === 'remote') {
          if (cur && cur !== '/' && cur !== '.') list.appendChild(mkRow('..', true));
        } else {
          const parent = _parentLocalPath(cur);
          if (parent && parent !== cur && _isAllowedLocalPath(parent, fp.roots)) {
            list.appendChild(mkRow('..', true));
          }
        }
      } catch (e) {}

      const frag = document.createDocumentFragment();
      for (const it of (fp.items || [])) {
        const nm = safeName(it && it.name);
        if (!nm) continue;
        frag.appendChild(mkRow(nm, false));
      }
      list.appendChild(frag);

      // Click / double click (event delegation)
      list.onclick = (e) => {
        const row = e && e.target ? e.target.closest('.fm-row') : null;
        if (!row) return;
        const nm = safeName(row.dataset.name || '');
        if (!nm) return;
        try { fp.selected = nm; } catch (e2) {}

        // highlight
        try {
          Array.from(list.querySelectorAll('.fm-row')).forEach((r) => r.classList.remove('is-selected'));
          row.classList.add('is-selected');
        } catch (e3) {}
      };

      list.ondblclick = (e) => {
        const row = e && e.target ? e.target.closest('.fm-row') : null;
        if (!row) return;
        const nm = safeName(row.dataset.name || '');
        if (!nm) return;
        const isUp = row.dataset.up === '1' || nm === '..';
        if (isUp) {
          try {
            if (fp.target === 'remote') {
              // Remote: let backend normalize
              fp.path = '..';
            } else {
              fp.path = _parentLocalPath(String(fp.path || ''));
            }
            fp.selected = '';
          } catch (e2) {}
          loadFolderPicker(false);
          return;
        }

        // Enter directory
        try {
          if (fp.target === 'remote') fp.path = normRemotePath(String(fp.path || '.') + '/' + nm);
          else fp.path = joinLocal(String(fp.path || ''), nm);
          fp.selected = '';
        } catch (e4) {}
        loadFolderPicker(false);
      };
    }

    async function loadFolderPicker(fromInput) {
      const fp = S.folderPicker;
      if (!fp) return;

      const err = el('fm-folder-picker-error');
      if (err) err.textContent = '';

      const pathInp = el('fm-folder-picker-path');
      let desired = String(fp.path || '').trim();

      if (fromInput && pathInp) {
        const v = String(pathInp.value || '').trim();
        if (v) desired = v;
      }

      if (!desired) desired = (fp.roots && fp.roots[0]) ? String(fp.roots[0]) : '/opt/var';

      const url = (fp.target === 'remote' && fp.sid)
        ? `/api/fs/list?target=remote&sid=${encodeURIComponent(fp.sid)}&path=${encodeURIComponent(desired || '.')}`
        : `/api/fs/list?target=local&path=${encodeURIComponent(desired || '')}`;

      const { res, data } = await fetchJson(url, { method: 'GET' });
      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'list_failed';
        if (err) err.textContent = msg;
        toast('FM: ' + msg, 'error');
        return;
      }

      fp.roots = Array.isArray(data.roots) ? data.roots : (fp.roots || []);
      fp.path = String(data.path || desired || '');
      fp.items = (Array.isArray(data.items) ? data.items : []).filter(_fpIsDir);
      fp.items.sort((a, b) => safeName(a && a.name).localeCompare(safeName(b && b.name)));
      fp.selected = '';

      renderFolderPicker();
    }

    function openFolderPicker(opts) {
      const modal = el('fm-folder-picker-modal');
      if (!modal) return;

      const titleEl = el('fm-folder-picker-title');
      if (titleEl) titleEl.textContent = String((opts && opts.title) || 'Выбор папки');

      const target = String((opts && opts.target) || 'local');
      const sid = String((opts && opts.sid) || '');
      const startPath = String((opts && opts.path) || '');

      S.folderPicker = {
        target: (target === 'remote') ? 'remote' : 'local',
        sid,
        path: startPath,
        items: [],
        roots: [],
        selected: '',
        onPick: (opts && opts.onPick) ? opts.onPick : null,
      };

      const err = el('fm-folder-picker-error');
      if (err) err.textContent = '';

      modalOpen(modal);
      loadFolderPicker(false);

      try {
        setTimeout(() => {
          try {
            const pi = el('fm-folder-picker-path');
            if (pi) {
              pi.focus();
              pi.select && pi.select();
            }
          } catch (e) {}
        }, 0);
      } catch (e) {}
    }

  function openExtractModalWithItems(side, name, items) {
      const s0 = String(side || S.activeSide || 'left');
      const p = S.panels && S.panels[s0] ? S.panels[s0] : null;
      const nm = safeName(name || '');
      if (!p || !nm) {
        openExtractModal();
        return;
      }
      try { S.activeSide = s0; } catch (e) {}
      try { p.focusName = nm; p.selected && p.selected.clear && p.selected.clear(); p.selected && p.selected.add && p.selected.add(nm); p.anchorName = nm; } catch (e) {}
      openExtractModal();
      const sel = Array.isArray(items) ? items.filter(Boolean) : [];
      if (sel.length) {
        try { if (S.extract) S.extract.items = sel; } catch (e) {}
        try { const t = el('fm-extract-title'); if (t) t.textContent = `Распаковать выбранное (${sel.length})`; } catch (e) {}
        // Enable extra options when extracting selected items.
        try {
          const flat = el('fm-extract-flatten');
          if (flat) flat.disabled = false;
        } catch (e) {}
      }
    }


    async function doExtractFromModal() {
      const err = el('fm-extract-error');
      if (err) err.textContent = '';

      const side = String((S.extract && S.extract.side) || S.activeSide || 'left');
      const p = S.panels[side];
      const name = safeName((S.extract && S.extract.name) || '');
      if (!p || !name) return;

      if (p.target !== 'local') {
        toast('Распаковка доступна только для local панели', 'info');
        return;
      }
      if (!_isArchiveFileName(name)) {
        if (err) err.textContent = 'Неподдерживаемый архив.';
        return;
      }

      const destInp = el('fm-extract-dest');
      const mk = el('fm-extract-create-dest');
      const strip = el('fm-extract-strip-top');
      const flat = el('fm-extract-flatten');
      const ow = el('fm-extract-overwrite');
      const createDest = !!(mk && mk.checked);
      const stripTopDir = !!(strip && strip.checked);
      const flatten = !!(flat && !flat.disabled && flat.checked);

      // If the user does NOT want to create a destination folder,
      // extraction should happen in the current directory (where the archive is).
      // In that mode we ignore the "dest" input (it's only a folder name hint).
      const destRaw = String((destInp && destInp.value) || '').trim();
      if (createDest && !destRaw) {
        if (err) err.textContent = 'Введите папку назначения.';
        return;
      }

      // allow relative to cwd, or absolute
      const dest = createDest ? destRaw : '';

      const body = {
        op: 'unzip',
        target: 'local',
        cwd: String(p.cwd || ''),
        archive: joinLocal(p.cwd, name),
        dest,
        create_dest: createDest,
        strip_top_dir: stripTopDir,
        flatten,
        overwrite: !!(ow && ow.checked),
      };

      try {
        const items = (S.extract && Array.isArray(S.extract.items)) ? S.extract.items : null;
        if (items && items.length) body.items = items;
      } catch (e) {}

      // Queue as fileops job (FM-20)
      let jobId = '';
      try {
        if (FM.ops && typeof FM.ops.executeJob === 'function') jobId = await FM.ops.executeJob(body);
      } catch (e) { jobId = ''; }

      if (!jobId) {
        let msg = 'extract_job_failed';
        if (err) err.textContent = msg;
        toast('FM: ' + msg, 'error');
        return;
      }

      toast('Распаковка запущена', 'info');
      closeExtractModal();

      // Preselect destination folder (if created). Actual refresh happens on job completion.
      if (createDest) {
        try {
          const leaf = safeName(destRaw.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() || '');
          if (leaf) {
            p.focusName = leaf;
            p.selected.clear();
            p.selected.add(leaf);
            p.anchorName = leaf;
          }
        } catch (e) {}
      }
    }

  

  

    // -------------------------- archive: view contents --------------------------
    function openArchiveListModal() {
      const modal = el('fm-archive-list-modal');
      if (!modal) return;

      const titleEl = el('fm-archive-list-title');
      const pathEl = el('fm-archive-list-path');
      const bodyEl = el('fm-archive-list-body');
      const metaEl = el('fm-archive-list-meta');
      const errEl = el('fm-archive-list-error');

      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      if (p.target !== 'local') {
        toast('Просмотр архивов доступен только для local панели', 'info');
        return;
      }

      const names = getSelectionNames(side);
      if (names.length > 1) {
        toast('Для просмотра выберите один архив', 'info');
        return;
      }

      const name = safeName(names.length === 1 ? names[0] : (p.focusName || ''));
      if (!name) {
        toast('Выберите архив', 'info');
        return;
      }

      if (!_isArchiveFileName(name)) {
        toast('Выбранный файл не похож на архив', 'info');
        return;
      }

      S.archiveList = { side, name };
      S.archiveListItems = [];
      S.archiveListTruncated = false;
      S.archiveListSel = new Set();
      S.archiveListFilter = "";

      if (titleEl) titleEl.textContent = 'Содержимое архива';

      const full = joinLocal(p.cwd, name);
      if (pathEl) pathEl.textContent = `${side.toUpperCase()} • local • ${full}`;
      if (bodyEl) bodyEl.textContent = 'Загрузка…';
      if (metaEl) metaEl.textContent = '';
      if (errEl) errEl.textContent = '';
      const filterInp = el('fm-archive-list-filter');
      if (filterInp) { try { filterInp.value = ''; } catch (e) {} }

      try {
        const f = el('fm-archive-list-filter');
        if (f) f.value = '';
      } catch (e) {}

      modalOpen(modal);
      try { setTimeout(() => { try { modal && modal.focus && modal.focus(); } catch (e) {} }, 0); } catch (e) {}

      loadArchiveListFromModal();
    }

    function closeArchiveListModal() {
      modalClose(el('fm-archive-list-modal'));
    }
    function _archiveItemKey(it) {
      const nm = safeName(it && it.name);
      if (!nm) return '';
      const isDir = !!(it && it.is_dir);
      return nm + (isDir ? '/' : '');
    }

    function _renderArchiveListTable(items, { filter } = {}) {
      const sel = (S.archiveListSel instanceof Set) ? S.archiveListSel : new Set();
      const f = String(filter || '').trim().toLowerCase();

      const table = document.createElement('table');
      table.className = 'fm-mono';
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';

      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      const cols = [
        { w: '36px', text: '' },
        { w: '120px', text: 'Дата' },
        { w: '80px', text: 'Размер' },
        { w: '40px', text: 'Тип' },
        { w: '', text: 'Путь' },
      ];
      for (const c of cols) {
        const th = document.createElement('th');
        th.textContent = c.text;
        th.style.textAlign = 'left';
        th.style.fontWeight = '600';
        th.style.padding = '6px 8px';
        th.style.opacity = '0.8';
        th.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
        if (c.w) th.style.width = c.w;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');

      let shown = 0;
      for (const it of (items || [])) {
        const key = _archiveItemKey(it);
        if (!key) continue;
        if (f && !String(key).toLowerCase().includes(f)) continue;
        shown += 1;

        const isDir = !!(it && it.is_dir);
        const isLink = !!(it && it.is_link);

        const tr = document.createElement('tr');
        tr.dataset.archiveKey = key;
        tr.style.cursor = 'pointer';
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.04)';
        if (sel.has(key)) tr.style.background = 'rgba(255,255,255,0.05)';

        const td0 = document.createElement('td');
        td0.style.padding = '4px 8px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.archiveKey = key;
        cb.checked = sel.has(key);
        cb.addEventListener('click', (e) => { e.stopPropagation(); });
        td0.appendChild(cb);

        const td1 = document.createElement('td');
        td1.style.padding = '4px 8px';
        td1.style.whiteSpace = 'nowrap';
        td1.textContent = fmtTime(it && it.mtime) || '';

        const td2 = document.createElement('td');
        td2.style.padding = '4px 8px';
        td2.style.textAlign = 'right';
        td2.textContent = isDir ? '' : (fmtSize(it && it.size) || '');

        const td3 = document.createElement('td');
        td3.style.padding = '4px 8px';
        td3.textContent = isDir ? 'd' : (isLink ? 'l' : '-');

        const td4 = document.createElement('td');
        td4.style.padding = '4px 8px';
        td4.style.wordBreak = 'break-word';
        td4.textContent = safeName(it && it.name) + (isDir ? '/' : '');

        tr.appendChild(td0);
        tr.appendChild(td1);
        tr.appendChild(td2);
        tr.appendChild(td3);
        tr.appendChild(td4);

        const syncRowStyle = () => {
          try { tr.style.background = cb.checked ? 'rgba(255,255,255,0.05)' : ''; } catch (e) {}
        };

        const applySel = () => {
          try {
            const k = String(cb.dataset.archiveKey || '');
            if (cb.checked) sel.add(k); else sel.delete(k);
          } catch (e2) {}
          try { _updateArchiveListMeta(); } catch (e3) {}
          syncRowStyle();
        };

        cb.addEventListener('change', (e) => {
          e.stopPropagation();
          applySel();
        });

        tr.addEventListener('click', (e) => {
          cb.checked = !cb.checked;
          applySel();
        });

        // UX: double-click an entry to extract it right away into the current folder.
        // This uses "strip_top_dir" by default to avoid creating an extra single top-level directory.
        tr.addEventListener('dblclick', (e) => {
          try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}
          try {
            // Ensure the clicked item is selected.
            cb.checked = true;
            applySel();
          } catch (e3) {}
          try { archiveQuickExtract([key], { stripTopDir: true }); } catch (e4) {}
        });

        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      return { table, shown };
    }

    function _updateArchiveListMeta(extra = {}) {
      const metaEl = el('fm-archive-list-meta');
      if (!metaEl) return;

      const total = (S.archiveListItems && Array.isArray(S.archiveListItems)) ? S.archiveListItems.length : 0;
      const truncated = !!(S.archiveListTruncated);
      const selCount = (S.archiveListSel && S.archiveListSel.size) ? S.archiveListSel.size : 0;
      const shown = (typeof extra.shown === 'number') ? extra.shown : null;

      let s = truncated ? `Показано ${total} элементов (обрезано)` : `Элементов: ${total}`;
      if (shown != null && shown !== total) s += ` • Отфильтровано: ${shown}`;
      s += ` • Выбрано: ${selCount}`;
      metaEl.textContent = s;
    }

    function renderArchiveListBody() {
      const bodyEl = el('fm-archive-list-body');
      if (!bodyEl) return;

      const items = Array.isArray(S.archiveListItems) ? S.archiveListItems : [];
      const filter = String(S.archiveListFilter || '');

      try { bodyEl.innerHTML = ''; } catch (e) {}
      const out = _renderArchiveListTable(items, { filter });
      if (out && out.table) bodyEl.appendChild(out.table);
      try { _updateArchiveListMeta({ shown: out ? out.shown : null }); } catch (e) {}
    }

    function _archiveSelectedKeys() {
      if (!(S.archiveListSel instanceof Set)) return [];
      return Array.from(S.archiveListSel.values()).filter(Boolean);
    }

    async function archiveQuickExtract(keys, { stripTopDir = true } = {}) {
      const ks = Array.isArray(keys) ? keys.filter(Boolean) : [];
      if (!ks.length) {
        toast('Выберите файлы в архиве', 'info');
        return;
      }

      const side = String((S.archiveList && S.archiveList.side) || S.activeSide || 'left');
      const p = S.panels[side];
      const name = safeName((S.archiveList && S.archiveList.name) || '');
      if (!p || !name) return;
      if (p.target !== 'local') {
        toast('Распаковка доступна только для local панели', 'info');
        return;
      }

      const body = {
        target: 'local',
        cwd: String(p.cwd || ''),
        archive: joinLocal(p.cwd, name),
        dest: '',
        create_dest: false,
        strip_top_dir: !!stripTopDir,
        overwrite: false,
        items: ks,
      };

      const { res, data } = await fetchJson('/api/fs/archive/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.details || data.error || data.message) ? String(data.details || data.error || data.message) : 'extract_failed';
        toast('FM: ' + msg, 'error');
        return;
      }

      const nExtracted = (data && typeof data.extracted === 'number') ? data.extracted : null;
      const extra = (nExtracted != null) ? ` (${nExtracted})` : '';
      toast('Извлечено' + extra, 'success');

      // Refresh file list so the user sees extracted items.
      try { await listPanel(side, { fromInput: false }); } catch (e) {}
    }

    function archiveListSelectAllFiltered() {
      const items = Array.isArray(S.archiveListItems) ? S.archiveListItems : [];
      const filter = String(S.archiveListFilter || '').trim().toLowerCase();
      if (!(S.archiveListSel instanceof Set)) S.archiveListSel = new Set();
      for (const it of items) {
        const key = _archiveItemKey(it);
        if (!key) continue;
        if (filter && !String(key).toLowerCase().includes(filter)) continue;
        S.archiveListSel.add(key);
      }
      renderArchiveListBody();
    }

    function archiveListSelectNone() {
      S.archiveListSel = new Set();
      renderArchiveListBody();
    }

    async function loadArchiveListFromModal() {
      const errEl = el('fm-archive-list-error');
      const bodyEl = el('fm-archive-list-body');
      const metaEl = el('fm-archive-list-meta');

      if (errEl) errEl.textContent = '';

      const side = String((S.archiveList && S.archiveList.side) || S.activeSide || 'left');
      const p = S.panels[side];
      const name = safeName((S.archiveList && S.archiveList.name) || '');
      if (!p || !name) return;

      if (p.target !== 'local') {
        if (errEl) errEl.textContent = 'Просмотр архивов доступен только для local панели.';
        return;
      }

      const full = joinLocal(p.cwd, name);
      const url = `/api/fs/archive/list?target=local&path=${encodeURIComponent(full)}&max=5000`;

      const { res, data } = await fetchJson(url);

      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.details || data.error || data.message) ? String(data.details || data.error || data.message) : 'archive_list_failed';
        if (errEl) errEl.textContent = msg;
        if (bodyEl) { try { bodyEl.textContent = ''; } catch (e) {} try { bodyEl.innerHTML = ''; } catch (e2) {} }
        if (metaEl) metaEl.textContent = '';
        toast('FM: ' + msg, 'error');
        return;
      }

      const items = Array.isArray(data.items) ? data.items : [];
      const truncated = !!data.truncated;

      S.archiveListItems = items;
      S.archiveListTruncated = truncated;

      // keep existing selection when possible
      try {
        if (!(S.archiveListSel instanceof Set)) S.archiveListSel = new Set();
        const avail = new Set(items.map(_archiveItemKey));
        for (const k of Array.from(S.archiveListSel.values())) {
          if (!avail.has(k)) S.archiveListSel.delete(k);
        }
      } catch (e) {}

      renderArchiveListBody();
    }

  // -------------------------- chmod / chown --------------------------
    function _fsAdminCaps(panel) {
      try {
        const rf = (S.caps && S.caps.remoteFs) ? S.caps.remoteFs : null;
        const fa = (rf && rf.fs_admin) ? rf.fs_admin : null;
        if (!panel) return null;
        return (panel.target === 'remote') ? (fa && fa.remote) : (fa && fa.local);
      } catch (e) {
        return null;
      }
    }

    function _parsePermStringToMode(permStr) {
      // permStr examples: -rw-r--r--, drwxr-xr-x+, lrwxrwxrwx
      let s = String(permStr || '').trim();
      if (!s) return null;
      // drop ACL markers
      s = s.replace(/[@+\.]$/, '');
      if (s.length < 10) return null;
      const p = s.slice(1, 10);
      const tri = [p.slice(0, 3), p.slice(3, 6), p.slice(6, 9)];

      function digit(t) {
        const r = t[0] === 'r' ? 4 : 0;
        const w = t[1] === 'w' ? 2 : 0;
        const xch = t[2];
        const x = (xch === 'x' || xch === 's' || xch === 't') ? 1 : 0;
        return r + w + x;
      }

      const u = digit(tri[0]);
      const g = digit(tri[1]);
      const o = digit(tri[2]);

      const suid = (tri[0][2] === 's' || tri[0][2] === 'S') ? 4 : 0;
      const sgid = (tri[1][2] === 's' || tri[1][2] === 'S') ? 2 : 0;
      const sticky = (tri[2][2] === 't' || tri[2][2] === 'T') ? 1 : 0;
      const sp = suid + sgid + sticky;

      const modeStr = (sp ? String(sp) : '') + String(u) + String(g) + String(o);
      return modeStr;
    }

    function _parseModeInputToParts(modeStr) {
      const raw = String(modeStr || '').trim().toLowerCase();
      if (!raw) return null;
      let s = raw;
      if (s.startsWith('0o')) s = s.slice(2);
      if (s.startsWith('0') && s.length > 1) {
        // keep leading zero only if it makes 4 digits like 0755
        // in practice, 0755 -> 755 (octal)
        while (s.length > 1 && s[0] === '0') s = s.slice(1);
      }
      if (!/^[0-7]{3,4}$/.test(s)) return null;
      const sp = (s.length === 4) ? s[0] : '0';
      const last3 = (s.length === 4) ? s.slice(1) : s;
      return { sp, last3, norm: (sp !== '0' ? sp : '') + last3 };
    }

    function _chmodSetChecksFromLast3(last3) {
      const d = String(last3 || '000');
      if (!/^[0-7]{3}$/.test(d)) return;
      const u = parseInt(d[0], 8);
      const g = parseInt(d[1], 8);
      const o = parseInt(d[2], 8);

      const set = (id, on) => {
        const x = el(id);
        if (x) x.checked = !!on;
      };

      set('fm-perm-ur', !!(u & 4));
      set('fm-perm-uw', !!(u & 2));
      set('fm-perm-ux', !!(u & 1));

      set('fm-perm-gr', !!(g & 4));
      set('fm-perm-gw', !!(g & 2));
      set('fm-perm-gx', !!(g & 1));

      set('fm-perm-or', !!(o & 4));
      set('fm-perm-ow', !!(o & 2));
      set('fm-perm-ox', !!(o & 1));
    }

    function _chmodGetLast3FromChecks() {
      const get = (id) => {
        const x = el(id);
        return !!(x && x.checked);
      };

      const u = (get('fm-perm-ur') ? 4 : 0) + (get('fm-perm-uw') ? 2 : 0) + (get('fm-perm-ux') ? 1 : 0);
      const g = (get('fm-perm-gr') ? 4 : 0) + (get('fm-perm-gw') ? 2 : 0) + (get('fm-perm-gx') ? 1 : 0);
      const o = (get('fm-perm-or') ? 4 : 0) + (get('fm-perm-ow') ? 2 : 0) + (get('fm-perm-ox') ? 1 : 0);

      return '' + u + g + o;
    }

    function _chmodSyncFromModeInput() {
      const inp = el('fm-chmod-mode');
      if (!inp) return;
      const parts = _parseModeInputToParts(inp.value);
      if (!parts) return;
      try { if (!S.chmod) S.chmod = {}; } catch (e) {}
      try { S.chmod.sp = parts.sp; } catch (e) {}
      _chmodSetChecksFromLast3(parts.last3);
    }

    function _chmodSyncToModeInput() {
      const inp = el('fm-chmod-mode');
      if (!inp) return;
      const last3 = _chmodGetLast3FromChecks();
      let sp = '0';
      try { sp = String((S.chmod && S.chmod.sp) || '0'); } catch (e) { sp = '0'; }
      if (!/^[0-7]$/.test(sp)) sp = '0';
      const val = (sp !== '0' ? (sp + last3) : last3);
      try { inp.value = val; } catch (e) {}
    }

    function _fmtPanelLabel(side) {
      const p = S.panels[side];
      const tgt = String(p.target || 'local');
      const sid = (tgt === 'remote' && p.sid) ? ` (${p.sid})` : '';
      const cwd = (tgt === 'remote') ? (String(p.cwd || '').trim() || '.') : String(p.cwd || '');
      return `${side.toUpperCase()} • ${tgt}${sid} • ${cwd}`;
    }

    function openChmodModal() {
      const modal = el('fm-chmod-modal');
      if (!modal) return;
      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      const caps = _fsAdminCaps(p) || {};
      if (caps && caps.chmod === false) {
        toast('chmod недоступен', 'info');
        return;
      }

      const names = getSelectionNames(side);
      if (!names.length) {
        toast('Выберите файл/папку', 'info');
        return;
      }
      if (p.target === 'remote' && !p.sid) {
        toast('Remote: нет активной сессии (Connect…)', 'info');
        return;
      }

      // store context
      try {
        S.chmod = { side, names: Array.from(names), sp: '0' };
      } catch (e) {
        S.chmod = { side, names: Array.from(names) };
      }

      // title/source
      const src = el('fm-chmod-src');
      if (src) src.textContent = _fmtPanelLabel(side);

      const listEl = el('fm-chmod-list');
      if (listEl) {
        const shown = names.slice(0, 20);
        listEl.textContent = shown.join('\n') + (names.length > 20 ? '\n…' : '');
      }

      const err = el('fm-chmod-error');
      if (err) err.textContent = '';

      // Try prefill mode from permissions if all selected have same perm.
      let preMode = '';
      try {
        const items = Array.from(p.items || []);
        const perms = names.map((n) => {
          const it = items.find((x) => safeName(x && x.name) === n);
          return safeName(it && it.perm);
        }).filter((x) => !!x);
        if (perms.length === names.length) {
          const first = perms[0];
          if (perms.every((x) => x === first)) {
            const parsed = _parsePermStringToMode(first);
            if (parsed) preMode = parsed;
          }
        }
      } catch (e) {}

      const modeInp = el('fm-chmod-mode');
      if (modeInp) {
        try { modeInp.value = preMode || ''; } catch (e) {}
      }

      // sync checkboxes
      try {
        const parts = _parseModeInputToParts(preMode || '');
        if (parts) {
          try { S.chmod.sp = parts.sp; } catch (e) {}
          _chmodSetChecksFromLast3(parts.last3);
        } else {
          try { S.chmod.sp = '0'; } catch (e) {}
          _chmodSetChecksFromLast3('000');
        }
      } catch (e) {}

      modalOpen(modal);
      try { setTimeout(() => { try { modeInp && modeInp.focus(); } catch (e) {} }, 0); } catch (e) {}
    }

    function closeChmodModal() {
      modalClose(el('fm-chmod-modal'));
    }

    async function doChmodFromModal() {
      const modal = el('fm-chmod-modal');
      if (!modal) return;

      const errEl = el('fm-chmod-error');
      if (errEl) errEl.textContent = '';

      const side = String((S.chmod && S.chmod.side) || S.activeSide || 'left');
      const p = S.panels[side];
      if (!p) return;
      const names = Array.isArray(S.chmod && S.chmod.names) ? S.chmod.names : getSelectionNames(side);

      const modeInp = el('fm-chmod-mode');
      const modeRaw = String((modeInp && modeInp.value) || '').trim();
      const parts = _parseModeInputToParts(modeRaw);
      if (!parts) {
        if (errEl) errEl.textContent = 'Введите mode (например 755).';
        return;
      }

      // Optional confirm for big batches
      if (names.length >= 8) {
        const ok = await (C && typeof C.confirm === 'function'
          ? C.confirm({
            title: 'chmod',
            message: `Применить chmod ${parts.norm} к ${names.length} элементам?`,
            okText: 'Применить',
            cancelText: 'Отмена',
            danger: false,
          })
          : Promise.resolve(window.confirm(`chmod ${parts.norm} для ${names.length} элементов?`)));
        if (!ok) return;
      }

      if (p.target === 'remote' && !p.sid) {
        toast('Remote: нет активной сессии (Connect…)', 'info');
        return;
      }

      for (const n of names) {
        const path = (p.target === 'remote') ? joinRemote(p.cwd, n) : joinLocal(p.cwd, n);
        const body = { target: p.target, path, mode: parts.norm };
        if (p.target === 'remote') body.sid = p.sid;
        const { res, data } = await fetchJson('/api/fs/chmod', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res || !res.ok || !data || !data.ok) {
          const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'chmod_failed';
          const details = data && data.details ? String(data.details) : '';
          if (errEl) errEl.textContent = details ? (msg + ': ' + details) : msg;
          toast('FM: ' + msg, 'error');
          return;
        }
      }

      toast('chmod применён', 'success');
      await listPanel(side, { fromInput: false });
      closeChmodModal();
    }

    function openChownModal() {
      const modal = el('fm-chown-modal');
      if (!modal) return;
      const side = S.activeSide;
      const p = S.panels[side];
      if (!p) return;

      const caps = _fsAdminCaps(p) || {};
      if (caps && caps.chown === false) {
        toast('chown недоступен', 'info');
        return;
      }
      // Remote: only SFTP
      if (p.target === 'remote') {
        const protos = Array.isArray(caps.chown_protocols) ? caps.chown_protocols.map((x) => String(x).trim().toLowerCase()) : ['sftp'];
        const rproto = String((p.rproto || '')).toLowerCase();
        if (rproto && !protos.includes(rproto)) {
          toast('chown доступен только для SFTP', 'info');
          return;
        }
      }

      const names = getSelectionNames(side);
      if (!names.length) {
        toast('Выберите файл/папку', 'info');
        return;
      }
      if (p.target === 'remote' && !p.sid) {
        toast('Remote: нет активной сессии (Connect…)', 'info');
        return;
      }

      try { S.chown = { side, names: Array.from(names) }; } catch (e) { S.chown = { side, names: Array.from(names) }; }

      const src = el('fm-chown-src');
      if (src) src.textContent = _fmtPanelLabel(side);

      const listEl = el('fm-chown-list');
      if (listEl) {
        const shown = names.slice(0, 20);
        listEl.textContent = shown.join('\n') + (names.length > 20 ? '\n…' : '');
      }

      const err = el('fm-chown-error');
      if (err) err.textContent = '';

      const uidInp = el('fm-chown-uid');
      const gidInp = el('fm-chown-gid');
      if (uidInp) { try { uidInp.value = ''; } catch (e) {} }
      if (gidInp) { try { gidInp.value = ''; } catch (e) {} }

      modalOpen(modal);
      try { setTimeout(() => { try { uidInp && uidInp.focus(); } catch (e) {} }, 0); } catch (e) {}
    }

    function closeChownModal() {
      modalClose(el('fm-chown-modal'));
    }

    async function doChownFromModal() {
      const modal = el('fm-chown-modal');
      if (!modal) return;

      const errEl = el('fm-chown-error');
      if (errEl) errEl.textContent = '';

      const side = String((S.chown && S.chown.side) || S.activeSide || 'left');
      const p = S.panels[side];
      if (!p) return;

      const names = Array.isArray(S.chown && S.chown.names) ? S.chown.names : getSelectionNames(side);

      const uidRaw = String((el('fm-chown-uid') && el('fm-chown-uid').value) || '').trim();
      const gidRaw = String((el('fm-chown-gid') && el('fm-chown-gid').value) || '').trim();

      if (!uidRaw || !/^\d+$/.test(uidRaw)) {
        if (errEl) errEl.textContent = 'Введите UID (число).';
        return;
      }
      if (gidRaw && !/^\d+$/.test(gidRaw)) {
        if (errEl) errEl.textContent = 'GID должен быть числом или пустым.';
        return;
      }

      // Remote support check
      if (p.target === 'remote') {
        const rproto = String((p.rproto || '')).toLowerCase();
        if (rproto && rproto !== 'sftp') {
          if (errEl) errEl.textContent = 'Remote chown поддерживается только для SFTP.';
          return;
        }
        if (!p.sid) {
          toast('Remote: нет активной сессии (Connect…)', 'info');
          return;
        }
      }

      if (names.length >= 8) {
        const ok = await (C && typeof C.confirm === 'function'
          ? C.confirm({
            title: 'chown',
            message: `Применить chown ${uidRaw}${gidRaw ? ':' + gidRaw : ''} к ${names.length} элементам?`,
            okText: 'Применить',
            cancelText: 'Отмена',
            danger: true,
          })
          : Promise.resolve(window.confirm(`chown ${uidRaw}${gidRaw ? ':' + gidRaw : ''} для ${names.length} элементов?`)));
        if (!ok) return;
      }

      for (const n of names) {
        const path = (p.target === 'remote') ? joinRemote(p.cwd, n) : joinLocal(p.cwd, n);
        const body = { target: p.target, path, uid: parseInt(uidRaw, 10) };
        if (gidRaw) body.gid = parseInt(gidRaw, 10);
        else body.gid = null; // do not change
        if (p.target === 'remote') body.sid = p.sid;

        const { res, data } = await fetchJson('/api/fs/chown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res || !res.ok || !data || !data.ok) {
          const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'chown_failed';
          const details = data && data.details ? String(data.details) : '';
          if (errEl) errEl.textContent = details ? (msg + ': ' + details) : msg;
          toast('FM: ' + msg, 'error');
          return;
        }
      }

      toast('chown применён', 'success');
      await listPanel(side, { fromInput: false });
      closeChownModal();
    }

  async function doCreateFromModal() {
      const modal = el('fm-create-modal');
      if (!modal) return;
      const err = el('fm-create-error');
      if (err) err.textContent = '';

      const kind = String((S.create && S.create.kind) || '');
      const side = String((S.create && S.create.side) || S.activeSide);
      const p = S.panels[side];
      if (!p) return;

      const name = String((el('fm-create-name') && el('fm-create-name').value) || '').trim();
      if (!name || name === '.' || name === '..') {
        if (err) err.textContent = 'Введите корректное имя.';
        return;
      }
      if (kind === 'file' && /\/$/.test(name)) {
        if (err) err.textContent = 'Для файла не используйте завершающий "/".';
        return;
      }

      // Remote requires session.
      if (p.target === 'remote' && !p.sid) {
        toast('Remote: нет активной сессии (Connect…) ', 'info');
        return;
      }

      const parents = !!(el('fm-create-parents') && el('fm-create-parents').checked);
      const createOnly = !!(el('fm-create-createonly') && el('fm-create-createonly').checked);
      const fullPath = _calcCreatePath(p, name);
      if (!fullPath) {
        if (err) err.textContent = 'Не удалось построить путь.';
        return;
      }

      if (kind === 'dir') {
        const body = { target: p.target, path: fullPath, parents };
        if (p.target === 'remote') body.sid = p.sid;
        const { res, data } = await fetchJson('/api/fs/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res || !res.ok || !data || !data.ok) {
          const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'mkdir_failed';
          if (err) err.textContent = msg;
          toast('FM: ' + msg, 'error');
          return;
        }
        toast('Папка создана: ' + _leafName(name), 'success');
        // Refresh and focus
        p.focusName = _leafName(name);
        await listPanel(side, { fromInput: false });
        closeCreateModal();
        return;
      }

      // file
      const body = { target: p.target, path: fullPath, parents, create_only: createOnly };
      if (p.target === 'remote') body.sid = p.sid;
      const { res, data } = await fetchJson('/api/fs/touch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok || !data || !data.ok) {
        const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'touch_failed';
        if (err) err.textContent = msg;
        toast('FM: ' + msg, 'error');
        return;
      }
      if (data && data.skipped) {
        toast('Файл уже существует: ' + _leafName(name), 'info');
      } else {
        toast('Файл создан: ' + _leafName(name), 'success');
      }
      p.focusName = _leafName(name);
      await listPanel(side, { fromInput: false });
      closeCreateModal();
    }

  function wireActionModals() {
    // create modal buttons
    const createOk = el('fm-create-ok-btn');
    const createCancel = el('fm-create-cancel-btn');
    const createClose = el('fm-create-close-btn');
    const createName = el('fm-create-name');
    const closeCreate = () => closeCreateModal();

    if (createOk) createOk.addEventListener('click', (e) => { e.preventDefault(); doCreateFromModal(); });
    if (createCancel) createCancel.addEventListener('click', (e) => { e.preventDefault(); closeCreate(); });
    if (createClose) createClose.addEventListener('click', (e) => { e.preventDefault(); closeCreate(); });
    if (createName) createName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doCreateFromModal();
      }
    });

    const crm = el('fm-create-modal');
    if (crm) crm.addEventListener('click', (e) => { if (e.target === crm) closeCreate(); });

    // rename modal buttons
    const renameOk = el('fm-rename-ok-btn');
    const renameCancel = el('fm-rename-cancel-btn');
    const renameClose = el('fm-rename-close-btn');
    const renameName = el('fm-rename-name');
    const closeRename = () => closeRenameModal();

    if (renameOk) renameOk.addEventListener('click', (e) => { e.preventDefault(); doRenameFromModal(); });
    if (renameCancel) renameCancel.addEventListener('click', (e) => { e.preventDefault(); closeRename(); });
    if (renameClose) renameClose.addEventListener('click', (e) => { e.preventDefault(); closeRename(); });
    if (renameName) renameName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doRenameFromModal();
      }
    });

    const rnm = el('fm-rename-modal');
    if (rnm) rnm.addEventListener('click', (e) => { if (e.target === rnm) closeRename(); });

    // archive create modal buttons
    const archOk = el('fm-archive-ok-btn');
    const archCancel = el('fm-archive-cancel-btn');
    const archClose = el('fm-archive-close-btn');
    const archName = el('fm-archive-name');
    const archFmt = el('fm-archive-format');
    const closeArch = () => closeArchiveModal();
    if (archOk) archOk.addEventListener('click', (e) => { e.preventDefault(); doArchiveFromModal(); });
    if (archCancel) archCancel.addEventListener('click', (e) => { e.preventDefault(); closeArch(); });
    if (archClose) archClose.addEventListener('click', (e) => { e.preventDefault(); closeArch(); });
    if (archName) archName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doArchiveFromModal(); } });
    if (archFmt) archFmt.addEventListener('change', (e) => {
      try {
        const fmt = String(archFmt.value || 'zip').trim().toLowerCase();
        if (archName) {
          const v = String(archName.value || '').trim();
          archName.value = _ensureArchiveExt(v || 'archive', fmt);
        }
        if (S.archive) S.archive.fmt = fmt;
      } catch (e2) {}
    });
    const am = el('fm-archive-modal');
    if (am) am.addEventListener('click', (e) => { if (e.target === am) closeArch(); });

    // archive extract modal buttons
    const exOk = el('fm-extract-ok-btn');
    const exCancel = el('fm-extract-cancel-btn');
    const exClose = el('fm-extract-close-btn');
    const exDest = el('fm-extract-dest');
    const exHereBtn = el('fm-extract-dest-here-btn');
    const exOtherBtn = el('fm-extract-dest-other-btn');
    const exPickBtn = el('fm-extract-dest-pick-btn');
    const closeEx = () => closeExtractModal();
    if (exOk) exOk.addEventListener('click', (e) => { e.preventDefault(); doExtractFromModal(); });
    if (exCancel) exCancel.addEventListener('click', (e) => { e.preventDefault(); closeEx(); });
    if (exClose) exClose.addEventListener('click', (e) => { e.preventDefault(); closeEx(); });
    if (exDest) exDest.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doExtractFromModal(); } });

    // Quick destination helpers
    if (exHereBtn) exHereBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const mk = el('fm-extract-create-dest');
      if (mk) {
        mk.checked = false;
        try { if (typeof mk.onchange === 'function') mk.onchange(); } catch (e2) {}
        try { mk.dispatchEvent(new Event('change')); } catch (e3) {}
      }
    });

    if (exOtherBtn) exOtherBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const side = String((S.extract && S.extract.side) || S.activeSide || 'left');
      const other = (side === 'left') ? 'right' : 'left';
      const p2 = S.panels && S.panels[other] ? S.panels[other] : null;
      if (!p2 || String(p2.target || 'local') !== 'local') {
        toast('Другая панель должна быть local', 'info');
        return;
      }
      const mk = el('fm-extract-create-dest');
      if (mk) {
        mk.checked = true;
        try { if (typeof mk.onchange === 'function') mk.onchange(); } catch (e2) {}
        try { mk.dispatchEvent(new Event('change')); } catch (e3) {}
      }
      if (exDest) {
        try { exDest.value = String(p2.cwd || '') || '/'; } catch (e4) {}
        try { exDest.focus(); exDest.select && exDest.select(); } catch (e5) {}
      }
    });


    if (exPickBtn) exPickBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const side = String((S.extract && S.extract.side) || S.activeSide || 'left');
      const p = S.panels && S.panels[side] ? S.panels[side] : null;
      if (!p || String(p.target || 'local') !== 'local') {
        toast('Панель должна быть local', 'info');
        return;
      }
      const mk = el('fm-extract-create-dest');
      if (mk) {
        mk.checked = true;
        try { if (typeof mk.onchange === 'function') mk.onchange(); } catch (e2) {}
        try { mk.dispatchEvent(new Event('change')); } catch (e3) {}
      }
      const destInp = el('fm-extract-dest');
      let start = '';
      try { start = String((destInp && destInp.value) || '').trim(); } catch (e4) { start = ''; }
      if (!start || !start.startsWith('/')) start = String(p.cwd || '') || '/opt/var';
      openFolderPicker({
        target: 'local',
        path: start,
        title: 'Папка назначения',
        onPick: (path) => {
          try { if (destInp) destInp.value = String(path || ''); } catch (e5) {}
          try { if (destInp) { destInp.focus(); destInp.select && destInp.select(); } } catch (e6) {}
        },
      });
    });
    const xm = el('fm-extract-modal');
    if (xm) xm.addEventListener('click', (e) => { if (e.target === xm) closeEx(); });


    // folder picker modal buttons
    const fpOk = el('fm-folder-picker-select-btn');
    const fpCancel = el('fm-folder-picker-cancel-btn');
    const fpClose = el('fm-folder-picker-close-btn');
    const fpUp = el('fm-folder-picker-up-btn');
    const fpHome = el('fm-folder-picker-home-btn');
    const fpPath = el('fm-folder-picker-path');
    const fpModal = el('fm-folder-picker-modal');

    if (fpOk) fpOk.addEventListener('click', (e) => {
      e.preventDefault();
      _folderPickerPick(_folderPickerChosenPath());
    });
    if (fpCancel) fpCancel.addEventListener('click', (e) => { e.preventDefault(); closeFolderPicker(); });
    if (fpClose) fpClose.addEventListener('click', (e) => { e.preventDefault(); closeFolderPicker(); });
    if (fpModal) fpModal.addEventListener('click', (e) => { if (e.target === fpModal) closeFolderPicker(); });

    if (fpUp) fpUp.addEventListener('click', (e) => {
      e.preventDefault();
      const fp = S.folderPicker;
      if (!fp) return;
      try {
        if (fp.target === 'remote') fp.path = '..';
        else fp.path = _parentLocalPath(String(fp.path || ''));
        fp.selected = '';
      } catch (e2) {}
      loadFolderPicker(false);
    });

    if (fpHome) fpHome.addEventListener('click', (e) => {
      e.preventDefault();
      const fp = S.folderPicker;
      if (!fp) return;
      let root = '';
      try { root = (fp.roots && fp.roots[0]) ? String(fp.roots[0]) : ''; } catch (e2) { root = ''; }
      if (!root) root = '/opt/var';
      try { fp.path = root; fp.selected = ''; } catch (e3) {}
      loadFolderPicker(false);
    });

    if (fpPath) fpPath.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadFolderPicker(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFolderPicker();
      }
    });



    // archive list modal buttons
    const alCancel = el('fm-archive-list-cancel-btn');
    const alClose = el('fm-archive-list-close-btn');
    const alExtract = el('fm-archive-list-extract-btn');
    const alExtractHere = el('fm-archive-list-extract-here-btn');
    const alRefresh = el('fm-archive-list-refresh-btn');
    const closeAl = () => closeArchiveListModal();

    if (alCancel) alCancel.addEventListener('click', (e) => { e.preventDefault(); closeAl(); });
    if (alClose) alClose.addEventListener('click', (e) => { e.preventDefault(); closeAl(); });
    if (alRefresh) alRefresh.addEventListener('click', (e) => { e.preventDefault(); loadArchiveListFromModal(); });

    const alFilter = el('fm-archive-list-filter');
    const alAll = el('fm-archive-list-select-all-btn');
    const alNone = el('fm-archive-list-select-none-btn');
    if (alFilter) alFilter.addEventListener('input', () => {
      try { S.archiveListFilter = String(alFilter.value || ''); } catch (e) { S.archiveListFilter = ''; }
      renderArchiveListBody();
    });
    if (alFilter) alFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        try { alFilter.value = ''; } catch (e2) {}
        S.archiveListFilter = '';
        renderArchiveListBody();
      }
    });
    if (alAll) alAll.addEventListener('click', (e) => { e.preventDefault(); archiveListSelectAllFiltered(); });
    if (alNone) alNone.addEventListener('click', (e) => { e.preventDefault(); archiveListSelectNone(); });
    if (alExtract) alExtract.addEventListener('click', (e) => {
      e.preventDefault();
      const st = S.archiveList || {};
      const side = String(st.side || S.activeSide || 'left');
      const name = safeName(st.name || '');
      const items = _archiveSelectedKeys();
      try { closeAl(); } catch (e2) {}
      if (name) openExtractModalWithItems(side, name, (items && items.length) ? items : null);
      else openExtractModal();
    });

    if (alExtractHere) alExtractHere.addEventListener('click', (e) => {
      e.preventDefault();
      const items = _archiveSelectedKeys();
      if (!items || !items.length) {
        toast('Выберите файлы в архиве', 'info');
        return;
      }
      try { archiveQuickExtract(items, { stripTopDir: true }); } catch (e2) {}
    });

    const alm = el('fm-archive-list-modal');
    if (alm) alm.addEventListener('click', (e) => { if (e.target === alm) closeAl(); });

    // chmod modal
    const chmodOk = el('fm-chmod-ok-btn');
    const chmodCancel = el('fm-chmod-cancel-btn');
    const chmodClose = el('fm-chmod-close-btn');
    const chmodMode = el('fm-chmod-mode');
    const closeChmod = () => closeChmodModal();

    if (chmodOk) chmodOk.addEventListener('click', (e) => { e.preventDefault(); doChmodFromModal(); });
    if (chmodCancel) chmodCancel.addEventListener('click', (e) => { e.preventDefault(); closeChmod(); });
    if (chmodClose) chmodClose.addEventListener('click', (e) => { e.preventDefault(); closeChmod(); });
    if (chmodMode) chmodMode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doChmodFromModal(); }
    });
    if (chmodMode) chmodMode.addEventListener('input', () => { try { _chmodSyncFromModeInput(); } catch (e) {} });

    // checkbox sync
    ['fm-perm-ur','fm-perm-uw','fm-perm-ux','fm-perm-gr','fm-perm-gw','fm-perm-gx','fm-perm-or','fm-perm-ow','fm-perm-ox'].forEach((id) => {
      const cb = el(id);
      if (cb) cb.addEventListener('change', () => { try { _chmodSyncToModeInput(); } catch (e) {} });
    });

    const chm = el('fm-chmod-modal');
    if (chm) chm.addEventListener('click', (e) => { if (e.target === chm) closeChmod(); });

    // chown modal
    const chownOk = el('fm-chown-ok-btn');
    const chownCancel = el('fm-chown-cancel-btn');
    const chownClose = el('fm-chown-close-btn');
    const chownUid = el('fm-chown-uid');
    const chownGid = el('fm-chown-gid');
    const closeChown = () => closeChownModal();

    if (chownOk) chownOk.addEventListener('click', (e) => { e.preventDefault(); doChownFromModal(); });
    if (chownCancel) chownCancel.addEventListener('click', (e) => { e.preventDefault(); closeChown(); });
    if (chownClose) chownClose.addEventListener('click', (e) => { e.preventDefault(); closeChown(); });
    if (chownUid) chownUid.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doChownFromModal(); }
    });
    if (chownGid) chownGid.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doChownFromModal(); }
    });

    const cho = el('fm-chown-modal');
    if (cho) cho.addEventListener('click', (e) => { if (e.target === cho) closeChown(); });


    
  }


// Exports
  AC._wireActionModals = wireActionModals;

  AC.openCreateModal = openCreateModal;
  AC.closeCreateModal = closeCreateModal;

  AC.openRenameModal = openRenameModal;
  AC.closeRenameModal = closeRenameModal;

  AC.openArchiveModal = openArchiveModal;
  AC.closeArchiveModal = closeArchiveModal;

  AC.openExtractModal = openExtractModal;
  AC.openExtractModalWithItems = openExtractModalWithItems;
  AC.closeExtractModal = closeExtractModal;

  AC.openFolderPicker = openFolderPicker;
  AC.closeFolderPicker = closeFolderPicker;

  AC.openArchiveListModal = openArchiveListModal;
  AC.closeArchiveListModal = closeArchiveListModal;

  AC.openChmodModal = openChmodModal;
  AC.closeChmodModal = closeChmodModal;
  AC.openChownModal = openChownModal;
  AC.closeChownModal = closeChownModal;
})();
