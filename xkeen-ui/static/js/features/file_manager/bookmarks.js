(() => {
  'use strict';

  // Bookmarks / Quick Paths for File Manager.
  // No ES modules / bundler: attach to window.XKeen.features.fileManager.bookmarks.

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;
  const C = FM.common || {};
  const ST = FM.state || {};

  function _prefs() {
    try { return (FM && FM.prefs) ? FM.prefs : {}; } catch (e) { return {}; }
  }

  function getS() {
    try { return (ST && ST.S) ? ST.S : {}; } catch (e) { return {}; }
  }

  function _toast(msg, kind) {
    try { if (typeof window.toast === 'function') return window.toast(msg, kind); } catch (e) {}
    try {
      if (window.XKeen && XKeen.ui && typeof XKeen.ui.toast === 'function') return XKeen.ui.toast(msg, kind);
    } catch (e2) {}
  }

  // -------------------------- trash root --------------------------
  let FM_TRASH_PATH = '/opt/var/trash';

  function setTrashRoot(path) {
    try {
      if (path) FM_TRASH_PATH = String(path || FM_TRASH_PATH).replace(/\/+$/, '');
    } catch (e) {}
    // keep state helper wired (other modules expect FM.state.isTrashPanel)
    try { if (FM && FM.state) FM.state.isTrashPanel = isTrashPanel; } catch (e2) {}
  }

  function getTrashRoot() {
    try { return String(FM_TRASH_PATH || '/opt/var/trash').replace(/\/+$/, ''); } catch (e) { return '/opt/var/trash'; }
  }

  function _defaultLocalBookmarks() {
    const tr = getTrashRoot();
    return [
      { label: '/opt/var', value: '/opt/var' },
      { label: `🗑 Корзина (${tr})`, value: tr },
      { label: '/opt/etc', value: '/opt/etc' },
      { label: '/tmp/mnt (диски)', value: '/tmp/mnt' },
      { label: '/opt/etc/xray', value: '/opt/etc/xray' },
      { label: '/opt/etc/mihomo', value: '/opt/etc/mihomo' },
    ];
  }

  function _localBookmarks() {
    const defs = _defaultLocalBookmarks();
    try {
      const P = _prefs();
      if (typeof P.loadBookmarksLocal === 'function') return P.loadBookmarksLocal(defs);
    } catch (e) {}
    return defs;
  }

  const FM_BOOKMARKS_REMOTE = [
    { label: '~ (home)', value: '.' },
    { label: '/', value: '/' },
    { label: '/opt', value: '/opt' },
    { label: '/etc', value: '/etc' },
    { label: '/etc/init.d', value: '/etc/init.d' },
    { label: '/var', value: '/var' },
    { label: '/var/log', value: '/var/log' },
    { label: '/tmp', value: '/tmp' },
    { label: '/home', value: '/home' },
    { label: '/root', value: '/root' },
    { label: '/usr', value: '/usr' },
    { label: '/bin', value: '/bin' },
    { label: '/sbin', value: '/sbin' },
    { label: '/proc', value: '/proc' },
    { label: '/sys', value: '/sys' },
  ];

  function isTrashPanel(p) {
    try {
      const cwd = String((p && p.cwd) || '').replace(/\/+$/, '');
      const tr = getTrashRoot();
      // Show trash UI not only for the root folder itself, but also for any
      // nested folder inside it.
      return !!p
        && String(p.target || 'local') === 'local'
        && (cwd === tr || cwd.startsWith(tr + '/'));
    } catch (e) {
      return false;
    }
  }

  // expose trash detector for shared state helpers (footer buttons, etc.)
  try { if (FM && FM.state) FM.state.isTrashPanel = isTrashPanel; } catch (e) {}

  // -------------------------- quick paths select --------------------------
  function _bookmarksForPanel(p) {
    const target = String((p && p.target) || 'local');
    if (target === 'remote') return FM_BOOKMARKS_REMOTE;

    // Local: filter/disable based on sandbox roots returned by backend.
    const roots = Array.isArray(p && p.roots) ? p.roots : [];
    const isAllowed = (typeof C.isAllowedLocalPath === 'function') ? C.isAllowedLocalPath : (() => true);

    return _localBookmarks().map((b) => {
      const val = String((b && b.value) || '');
      const allowed = !roots.length || isAllowed(val, roots);
      return Object.assign({}, b, { _allowed: allowed });
    });
  }

  async function _listFromInput(side) {
    try {
      const fn =
        (ST && typeof ST.listPanel === 'function') ? ST.listPanel
        : (FM && FM.listing && typeof FM.listing.listPanel === 'function') ? FM.listing.listPanel
        : null;
      if (fn) return await fn(side, { fromInput: true });
    } catch (e) {}
  }

  function ensureSelect(side) {
    const pd = (ST && typeof ST.panelDom === 'function') ? ST.panelDom(side) : null;
    const S = getS();
    const p = S && S.panels ? S.panels[side] : null;
    if (!pd || !p) return;

    const qs = (typeof C.qs === 'function') ? C.qs : ((sel, root) => (root || document).querySelector(sel));
    const bar = qs('.fm-panel-bar', pd.root);
    if (!bar) return;

    let sel = qs('.fm-bookmarks-select', bar);
    if (!sel) {
      sel = document.createElement('select');
      sel.className = 'fm-bookmarks-select';
      sel.title = 'Быстрые пути';
      sel.setAttribute('aria-label', 'Быстрые пути');
      sel.addEventListener('change', async () => {
        const v = String(sel.value || '').trim();
        sel.value = '';
        if (!v) return;
        try { if (ST && typeof ST.setActiveSide === 'function') ST.setActiveSide(side); } catch (e) {}
        try { pd.pathInput && (pd.pathInput.value = (p.target === 'remote' && v === '.') ? '~' : v); } catch (e) {}
        await _listFromInput(side);
      });

      // Place it after the target selector to avoid stealing width from the path input.
      try {
        if (pd.targetSelect && pd.targetSelect.parentElement === bar) {
          bar.insertBefore(sel, pd.targetSelect.nextSibling);
        } else {
          bar.insertBefore(sel, bar.firstChild);
        }
      } catch (e) {
        try { bar.appendChild(sel); } catch (e2) {}
      }
    }

    // Extra: user bookmarks for local target (quick add + manage)
    let addBtn = qs('.fm-bookmarks-add', bar);
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'fm-bookmarks-btn fm-bookmarks-add';
      addBtn.textContent = '⭐';
      addBtn.title = 'Добавить текущую папку в избранное';
      addBtn.setAttribute('aria-label', 'Добавить в избранное');
      addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        addCurrent(side);
      });
      try {
        const ref = sel.nextSibling;
        bar.insertBefore(addBtn, ref);
      } catch (e) {
        try { bar.appendChild(addBtn); } catch (e2) {}
      }
    }

    let editBtn = qs('.fm-bookmarks-edit', bar);
    if (!editBtn) {
      editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'fm-bookmarks-btn fm-bookmarks-edit';
      editBtn.textContent = '⚙';
      editBtn.title = 'Управление избранным';
      editBtn.setAttribute('aria-label', 'Управление избранным');
      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openManager(side);
      });
      try {
        const ref = sel.nextSibling;
        bar.insertBefore(editBtn, ref);
      } catch (e) {
        try { bar.appendChild(editBtn); } catch (e2) {}
      }
    }

    const isLocalTarget = String(p.target) === 'local';
    try { addBtn.disabled = !isLocalTarget; } catch (e) {}
    try { editBtn.disabled = !isLocalTarget; } catch (e) {}

    // Update options depending on target.
    const opts = _bookmarksForPanel(p);
    let bmSig = '';
    try {
      const P = _prefs();
      if (String(p.target) !== 'remote' && P && P.keys && P.keys.bookmarksLocal && typeof P.lsGet === 'function') {
        bmSig = String(P.lsGet(P.keys.bookmarksLocal) || '');
      }
    } catch (e) { bmSig = ''; }

    const sig = String(p.target) + ':' + String(opts.length) + ':' + String((p.roots || []).join('|')) + ':' + bmSig;
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '📌';
      sel.appendChild(ph);

      // Remote: plain list. Local: show unavailable in a separate group (disabled).
      if (String(p.target) === 'remote') {
        (opts || []).forEach((o) => {
          const opt = document.createElement('option');
          opt.value = String(o.value || '');
          opt.textContent = String(o.label || o.value || '');
          sel.appendChild(opt);
        });
      } else {
        const allowed = (opts || []).filter((o) => o && o._allowed);
        const denied = (opts || []).filter((o) => o && !o._allowed);

        const g1 = document.createElement('optgroup');
        g1.label = 'Доступно';
        allowed.forEach((o) => {
          const opt = document.createElement('option');
          opt.value = String(o.value || '');
          opt.textContent = String(o.label || o.value || '');
          g1.appendChild(opt);
        });
        sel.appendChild(g1);

        if (denied.length) {
          const g2 = document.createElement('optgroup');
          g2.label = 'Недоступно (sandbox)';
          denied.forEach((o) => {
            const opt = document.createElement('option');
            opt.value = String(o.value || '');
            opt.textContent = '⛔ ' + String(o.label || o.value || '');
            opt.disabled = true;
            g2.appendChild(opt);
          });
          sel.appendChild(g2);
        }
      }
    }
  }

  // -------------------------- user bookmarks (local) --------------------------
  let _bmModalBound = false;
  let _bmEditingSide = 'left';
  let _bmDraft = [];

  function _loadLocalBookmarksForEdit() {
    const defs = _defaultLocalBookmarks();
    try {
      const P = _prefs();
      if (typeof P.loadBookmarksLocal === 'function') return P.loadBookmarksLocal(defs);
    } catch (e) {}
    return defs;
  }

  function _saveLocalBookmarksFromEdit(list) {
    try {
      const P = _prefs();
      if (typeof P.saveBookmarksLocal === 'function') P.saveBookmarksLocal(list);
    } catch (e) {}
  }

  function _refreshBookmarksUi() {
    const qs = (typeof C.qs === 'function') ? C.qs : ((sel, root) => (root || document).querySelector(sel));
    try {
      ['left', 'right'].forEach((s) => {
        const pd = (ST && typeof ST.panelDom === 'function') ? ST.panelDom(s) : null;
        const bar = pd && pd.root ? qs('.fm-panel-bar', pd.root) : null;
        const sel = bar ? qs('.fm-bookmarks-select', bar) : null;
        if (sel) sel.dataset.sig = '';
      });
    } catch (e) {}
    try { ensureSelect('left'); } catch (e) {}
    try { ensureSelect('right'); } catch (e) {}
  }

  function addCurrent(side) {
    const S = getS();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;
    if (String(p.target) !== 'local') {
      _toast('Избранное доступно только для local', 'info');
      return;
    }
    const path = String(p.cwd || '').trim() || '/';
    const list = _loadLocalBookmarksForEdit();
    if (list.some((b) => String((b && b.value) || '') === path)) {
      _toast('Уже в избранном: ' + path, 'info');
      return;
    }
    list.push({ label: path, value: path });
    _saveLocalBookmarksFromEdit(list);
    _refreshBookmarksUi();
    _toast('Добавлено в избранное: ' + path, 'success');
  }

  function _ensureBookmarksModal() {
    const el = (typeof C.el === 'function') ? C.el : ((id) => document.getElementById(id));
    const qs = (typeof C.qs === 'function') ? C.qs : ((sel, root) => (root || document).querySelector(sel));
    const qsa = (typeof C.qsa === 'function') ? C.qsa : ((sel, root) => Array.from((root || document).querySelectorAll(sel)));
    const modalOpen = (typeof C.modalOpen === 'function') ? C.modalOpen : ((m) => { try { m && m.classList && m.classList.add('open'); } catch (e) {} });
    const modalClose = (typeof C.modalClose === 'function') ? C.modalClose : ((m) => { try { m && m.classList && m.classList.remove('open'); } catch (e) {} });

    const modal = el('fm-bookmarks-modal');
    const title = el('fm-bookmarks-title');
    const listBox = el('fm-bookmarks-list');
    const addRowBtn = el('fm-bookmarks-add-row-btn');
    const addCurBtn = el('fm-bookmarks-add-current-btn');
    const resetBtn = el('fm-bookmarks-reset-btn');
    const cancelBtn = el('fm-bookmarks-cancel-btn');
    const saveBtn = el('fm-bookmarks-save-btn');
    const closeBtn = el('fm-bookmarks-close-btn');
    const err = el('fm-bookmarks-error');

    if (!modal || !title || !listBox || !addRowBtn || !addCurBtn || !resetBtn || !cancelBtn || !saveBtn || !closeBtn) return null;

    function close() {
      try { modalClose(modal); } catch (e) {}
    }

    function readDraftFromDom() {
      const rows = qsa('.fm-bm-row', listBox);
      const out = [];
      rows.forEach((r) => {
        const label = String((qs('input.fm-bm-label', r) || {}).value || '').trim();
        const value = String((qs('input.fm-bm-path', r) || {}).value || '').trim();
        if (!value) return;
        out.push({ label: label || value, value });
      });
      return out;
    }

    function setError(msg) {
      if (!err) return;
      err.textContent = msg ? String(msg) : '';
      try { err.style.display = msg ? '' : 'none'; } catch (e) {}
    }

    function render() {
      listBox.innerHTML = '';
      const rows = Array.isArray(_bmDraft) ? _bmDraft : [];
      rows.forEach((it, idx) => {
        const row = document.createElement('div');
        row.className = 'fm-bm-row';

        const inLabel = document.createElement('input');
        inLabel.className = 'terminal-input fm-bm-label';
        inLabel.placeholder = 'Имя';
        inLabel.value = String((it && it.label) || '');

        const inPath = document.createElement('input');
        inPath.className = 'terminal-input fm-bm-path';
        inPath.placeholder = '/opt/var';
        inPath.spellcheck = false;
        inPath.value = String((it && it.value) || '');

        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'btn-secondary fm-bm-mini';
        up.textContent = '↑';
        up.title = 'Вверх';
        up.disabled = idx === 0;
        up.addEventListener('click', (e) => {
          e.preventDefault();
          _bmDraft = readDraftFromDom();
          if (idx <= 0) return;
          const tmp = _bmDraft[idx - 1];
          _bmDraft[idx - 1] = _bmDraft[idx];
          _bmDraft[idx] = tmp;
          render();
        });

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'btn-secondary fm-bm-mini';
        down.textContent = '↓';
        down.title = 'Вниз';
        down.disabled = idx >= rows.length - 1;
        down.addEventListener('click', (e) => {
          e.preventDefault();
          _bmDraft = readDraftFromDom();
          if (idx >= _bmDraft.length - 1) return;
          const tmp = _bmDraft[idx + 1];
          _bmDraft[idx + 1] = _bmDraft[idx];
          _bmDraft[idx] = tmp;
          render();
        });

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn-secondary fm-bm-mini';
        del.textContent = '✖';
        del.title = 'Удалить';
        del.addEventListener('click', (e) => {
          e.preventDefault();
          _bmDraft = readDraftFromDom();
          _bmDraft.splice(idx, 1);
          render();
        });

        row.appendChild(inLabel);
        row.appendChild(inPath);
        row.appendChild(up);
        row.appendChild(down);
        row.appendChild(del);
        listBox.appendChild(row);
      });

      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'status';
        empty.style.margin = '8px 0 0 0';
        empty.style.opacity = '0.85';
        empty.textContent = 'Список пуст. Добавь закладку кнопкой «+» или «Добавить текущую».';
        listBox.appendChild(empty);
      }
    }

    function addCurrentToDraft() {
      const S = getS();
      const p = S && S.panels ? S.panels[_bmEditingSide] : null;
      const path = (p && String(p.cwd || '').trim()) || '/';
      _bmDraft = readDraftFromDom();
      if (_bmDraft.some((b) => String((b && b.value) || '') === path)) {
        _toast('Уже есть: ' + path, 'info');
        return;
      }
      _bmDraft.push({ label: path, value: path });
      render();
    }

    if (!_bmModalBound) {
      _bmModalBound = true;

      closeBtn.addEventListener('click', (e) => { e.preventDefault(); close(); });
      cancelBtn.addEventListener('click', (e) => { e.preventDefault(); close(); });
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

      addRowBtn.addEventListener('click', (e) => {
        e.preventDefault();
        _bmDraft = readDraftFromDom();
        _bmDraft.push({ label: '', value: '' });
        render();
      });

      addCurBtn.addEventListener('click', (e) => { e.preventDefault(); addCurrentToDraft(); });

      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        _bmDraft = _defaultLocalBookmarks();
        setError('');
        render();
      });

      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const list = readDraftFromDom();
        const seen = new Set();
        const out = [];
        for (const it of list) {
          const value = String(it.value || '').trim();
          if (!value) continue;
          if (seen.has(value)) continue;
          seen.add(value);
          out.push({ label: String(it.label || value).trim() || value, value });
        }
        if (!out.length) {
          setError('Нужно добавить хотя бы один путь.');
          return;
        }
        setError('');
        _saveLocalBookmarksFromEdit(out);
        close();
        _refreshBookmarksUi();
        _toast('Избранное сохранено', 'success');
      });
    }

    // eslint-disable-next-line no-unused-vars
    return { modal, title, listBox, err, render, setError, modalOpen };
  }

  function openManager(side) {
    const S = getS();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;
    if (String(p.target) !== 'local') {
      _toast('Избранное доступно только для local', 'info');
      return;
    }
    const ui = _ensureBookmarksModal();
    if (!ui) {
      _toast('Окно "Избранное" не найдено в шаблоне', 'error');
      return;
    }
    _bmEditingSide = side;
    _bmDraft = _loadLocalBookmarksForEdit();
    try { ui.title.textContent = 'Избранное (local)'; } catch (e) {}
    try { ui.setError(''); } catch (e) {}
    try { ui.render(); } catch (e) {}
    try {
      const modalOpen = (typeof C.modalOpen === 'function') ? C.modalOpen : (ui.modalOpen || null);
      if (modalOpen) modalOpen(ui.modal);
    } catch (e2) {}
  }

  FM.bookmarks = FM.bookmarks || {};
  FM.bookmarks.ensureSelect = ensureSelect;
  FM.bookmarks.openManager = openManager;
  FM.bookmarks.addCurrent = addCurrent;
  FM.bookmarks.isTrashPanel = isTrashPanel;
  FM.bookmarks.getTrashRoot = getTrashRoot;
  FM.bookmarks.setTrashRoot = setTrashRoot;

  // keep exports stable even if loaded twice
  try { if (FM && FM.state) FM.state.isTrashPanel = isTrashPanel; } catch (e) {}
})();