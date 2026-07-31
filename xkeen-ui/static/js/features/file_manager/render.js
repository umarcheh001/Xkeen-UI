import { getFileManagerNamespace } from '../file_manager_namespace.js';
import { iconHtml } from '../../ui/operator_icons.js';

(() => {
  'use strict';

  // File Manager panel renderer (renderPanel)
  // attach to the shared file manager namespace.render

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.render = FM.render || {};
  const R = FM.render;

  const C = FM.common || {};

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function panelDom(side) {
    try { return (FM.state && typeof FM.state.panelDom === 'function') ? FM.state.panelDom(side) : null; } catch (e) { return null; }
  }

  function updateFmFooterNavButtons() {
    try {
      if (FM.state && typeof FM.state.updateFmFooterNavButtons === 'function') FM.state.updateFmFooterNavButtons();
    } catch (e) {}
  }

  function qs(sel, root) {
    try { if (C && typeof C.qs === 'function') return C.qs(sel, root); } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  }

  function qsa(sel, root) {
    try { if (C && typeof C.qsa === 'function') return C.qsa(sel, root); } catch (e) {}
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e2) { return []; }
  }

  function isLiteMode() {
    try { if (C && typeof C.isLiteMode === 'function') return !!C.isLiteMode(); } catch (e) {}
    try {
      const S = _S();
      if (S && typeof S.liteMode === 'boolean') return !!S.liteMode;
    } catch (e2) {}
    return false;
  }

  function safeName(v) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(v); } catch (e) {}
    return String(v == null ? '' : v);
  }

  function fmtSize(bytes) {
    try { if (C && typeof C.fmtSize === 'function') return C.fmtSize(bytes); } catch (e) {}
    // fallback (should not happen when common.js is loaded)
    if (bytes === null || bytes === undefined || bytes === '') return '';
    const n = Number(bytes);
    if (!isFinite(n) || n < 0) return '';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    const s = (u === 0) ? String(Math.round(v)) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
    return s.replace(/\.0+$/, '').replace(/(\.[1-9])0$/, '$1') + ' ' + units[u];
  }

  function fmtTime(ts) {
    try { if (C && typeof C.fmtTime === 'function') return C.fmtTime(ts); } catch (e) {}
    const t = Number(ts || 0);
    if (!isFinite(t) || t <= 0) return '';
    try {
      const d = new Date(t * 1000);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch (e2) {
      return '';
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

  function saveSortPref(v) {
    try {
      if (FM.prefs && typeof FM.prefs.saveSortPref === 'function') FM.prefs.saveSortPref(v);
    } catch (e) {}
  }

  function setPanelState(pd, state) {
    const next = String(state || 'ready');
    try { if (pd && pd.root && pd.root.dataset) pd.root.dataset.state = next; } catch (e) {}
    try {
      if (pd && pd.list) {
        pd.list.dataset.state = next;
        pd.list.setAttribute('aria-busy', next === 'loading' ? 'true' : 'false');
      }
    } catch (e) {}
  }

  // Trash root is provided by backend (trash_root). Keep a sane default for older builds.
  // Keenetic mounts: /tmp/mnt may contain both UUID-like mount folders and
  // user-friendly label symlinks. The *backend* is responsible for returning
  // a "pretty" list (labels first, UUID folders hidden when labels exist).
  // Frontend only uses this check for UI details (icons, auto-enter).
  function isTmpMntRoot(panel) {
    try {
      return !!panel && panel.target === 'local' && String(panel.cwd || '').replace(/\/+$/, '') === '/tmp/mnt';
    } catch (e) {
      return false;
    }
  }

  function visibleSortedItems(side) {
    try {
      if (FM.listModel && typeof FM.listModel.visibleSortedItems === 'function') return FM.listModel.visibleSortedItems(side);
    } catch (e) {}
    return [];
  }

  R.renderPanel = function renderPanel(side) {
    const S = _S();
    if (!S) return;

    const pd = panelDom(side);
    const p = S.panels ? S.panels[side] : null;
    if (!pd || !p) return;

    // Ensure quick paths dropdown exists and is synced with current target.
    try { if (FM.bookmarks && typeof FM.bookmarks.ensureSelect === 'function') FM.bookmarks.ensureSelect(side); } catch (e) {}

    if (pd.targetSelect && String(pd.targetSelect.value) !== String(p.target)) {
      try { pd.targetSelect.value = p.target; } catch (e) {}
    }

    if (pd.pathInput) {
      // Local: show resolved path. Remote: display '~' for home ('.').
      if (p.target === 'remote') {
        const v = String(p.cwd || '').trim();
        pd.pathInput.value = (!v || v === '.') ? '~' : v;
      } else {
        pd.pathInput.value = String(p.cwd || '');
      }
    }

    // Filter input (client-side filter for current folder)
    try { if (pd.filterInput) pd.filterInput.value = String(p.filter || ''); } catch (e) {}
    try { if (pd.filterClearBtn) pd.filterClearBtn.classList.toggle('hidden', !String(p.filter || '').trim()); } catch (e) {}

    // Trash UI (extra column + "clear" button)
    const isTrash = (FM.bookmarks && typeof FM.bookmarks.isTrashPanel === 'function' ? !!FM.bookmarks.isTrashPanel(p) : false);
    try { pd.root.classList.toggle('is-trash', !!isTrash); } catch (e) {}
    try { if (pd.clearTrashBtn) pd.clearTrashBtn.classList.toggle('hidden', !isTrash); } catch (e) {}
    // Footer navigation buttons depend on the active panel + current cwd.
    try { updateFmFooterNavButtons(); } catch (e) {}

    // Buttons visibility
    const isRemote = p.target === 'remote';
    if (isLiteMode()) {
      hide(pd.connectBtn);
      hide(pd.disconnectBtn);
    } else if (isRemote) {
      if (p.sid) {
        hide(pd.connectBtn);
        show(pd.disconnectBtn);
      } else {
        show(pd.connectBtn);
        hide(pd.disconnectBtn);
      }
    } else {
      hide(pd.connectBtn);
      hide(pd.disconnectBtn);
    }

    // Remote quick jump (home/root) button.
    if (pd.rootBtn) {
      if (isRemote && p.sid) {
        show(pd.rootBtn);
        const rp = String(p.rproto || '').toLowerCase();
        const isFtp = (rp === 'ftp' || rp === 'ftps');
        const label = isFtp ? '/' : iconHtml('home');
        const title = isFtp ? 'В корень (/)' : 'В домашнюю (~)';
        try { pd.rootBtn.innerHTML = label; } catch (e) {}
        try { pd.rootBtn.title = title; } catch (e) {}
        try { pd.rootBtn.setAttribute('aria-label', title); } catch (e) {}
      } else {
        hide(pd.rootBtn);
      }
    }

    // List
    const list = pd.list;
    if (!list) return;

    if (p.loading) {
      list.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'fm-panel-state fm-loading';
      loading.setAttribute('role', 'status');
      loading.dataset.state = 'loading';
      loading.innerHTML = [
        '<div class="fm-panel-state-title">Загрузка папки…</div>',
        '<div class="fm-panel-state-detail">Получаем список файлов.</div>',
      ].join('');
      list.appendChild(loading);
      list.removeAttribute('aria-activedescendant');
      setPanelState(pd, 'loading');
      return;
    }

    // Panel-level error (unified UX): show a compact inline block with Retry.
    const pErr = (() => { try { return p && p.error ? p.error : null; } catch (e) { return null; } })();
    if (pErr && (pErr.message || pErr.hint)) {
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      try { list.innerHTML = ''; } catch (e) {}

      const box = document.createElement('div');
      box.className = 'fm-panel-state fm-panel-error';
      box.setAttribute('role', 'alert');
      box.dataset.state = 'error';
      const msg = esc(pErr.message || 'Ошибка');
      const hint = pErr.hint ? esc(pErr.hint) : '';
      const retryable = !!pErr.retryable;
      box.innerHTML = [
        '<div class="fm-panel-error-title">Ошибка</div>',
        `<div class="fm-panel-error-msg">${msg}</div>`,
        hint ? `<div class="fm-panel-error-hint">${hint}</div>` : '',
        retryable ? `<button type="button" class="btn-secondary fm-panel-error-retry">${iconHtml('refresh')}<span class="xk-action-label">Повторить</span></button>` : '',
      ].join('');

      list.appendChild(box);
      setPanelState(pd, 'error');

      if (retryable) {
        const btn = qs('.fm-panel-error-retry', box);
        if (btn) {
          btn.onclick = () => {
            try {
              if (FM.listing && typeof FM.listing.listPanel === 'function') {
                FM.listing.listPanel(side, { fromInput: true });
              }
            } catch (e) {}
          };
        }
      }

      // Still update footer buttons/status.
      try { updateFmFooterNavButtons(); } catch (e) {}
      try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
      return;
    }

    // Preserve focus if possible
    const focusName = p.focusName;

    // Cancel any in-flight incremental render for this side
    try { S.renderToken[side] = (Number(S.renderToken[side] || 0) + 1); } catch (e) {}
    const myToken = Number(S.renderToken[side] || 0);

    // header row (sortable columns)
    const header = document.createElement('div');
    header.className = 'fm-row fm-row-header';
    header.setAttribute('role', 'row');
    const showTrashFrom = (FM.bookmarks && typeof FM.bookmarks.isTrashPanel === 'function' ? !!FM.bookmarks.isTrashPanel(p) : false);
    header.innerHTML = [
      '<div class="fm-cell fm-check" role="columnheader"></div>',
      '<div class="fm-cell fm-name fm-sort-cell" role="columnheader" data-sort="name">Имя <span class="fm-sort-ind" aria-hidden="true"></span></div>',
      ...(showTrashFrom ? ['<div class="fm-cell fm-from" role="columnheader" title="Откуда удалено">Откуда удалено</div>'] : []),
      '<div class="fm-cell fm-size fm-sort-cell" role="columnheader" data-sort="size">Размер <span class="fm-sort-ind" aria-hidden="true"></span></div>',
      '<div class="fm-cell fm-perm fm-sort-cell" role="columnheader" data-sort="perm">Права <span class="fm-sort-ind" aria-hidden="true"></span></div>',
      '<div class="fm-cell fm-mtime fm-sort-cell" role="columnheader" data-sort="mtime">Изм. <span class="fm-sort-ind" aria-hidden="true"></span></div>',
    ].join('');

    const updateHeaderSortUi = () => {
      try {
        const pref = S.prefs.sort || { key: 'name', dir: 'asc' };
        const key = String(pref.key || 'name');
        const dir = String(pref.dir || 'asc');
        const ind = (dir === 'desc') ? '▼' : '▲';
        qsa('.fm-sort-cell', header).forEach((c) => {
          const k = String(c.dataset.sort || '');
          const active = (k === key);
          c.classList.toggle('is-sort-active', active);
          c.setAttribute('aria-sort', active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none');
          const sp = qs('.fm-sort-ind', c);
          if (sp) sp.textContent = active ? ind : '';
        });
      } catch (e) {}
    };

    header.addEventListener('click', (e) => {
      const cell = e && e.target && e.target.closest ? e.target.closest('.fm-sort-cell') : null;
      if (!cell) return;
      const k = String(cell.dataset.sort || '');
      if (!k) return;
      const cur = S.prefs.sort || { key: 'name', dir: 'asc', dirsFirst: true };
      const next = Object.assign({}, cur);
      if (String(cur.key) === k) {
        next.dir = (String(cur.dir) === 'asc') ? 'desc' : 'asc';
      } else {
        next.key = k;
        next.dir = 'asc';
      }
      S.prefs.sort = next;
      saveSortPref(next);
      updateHeaderSortUi();
      // Re-render both panels to reflect the new global sort.
      try { R.renderPanel('left'); } catch (e2) {}
      try { R.renderPanel('right'); } catch (e2) {}
    });
    header.addEventListener('keydown', (e) => {
      if (!e || (e.key !== 'Enter' && e.key !== ' ')) return;
      const cell = e.target && e.target.closest ? e.target.closest('.fm-sort-cell') : null;
      if (!cell) return;
      e.preventDefault();
      cell.click();
    });
    qsa('.fm-sort-cell', header).forEach((cell) => {
      cell.tabIndex = 0;
      cell.setAttribute('aria-label', `Сортировать: ${String(cell.textContent || '').trim()}`);
    });

    const tmpMntRoot = isTmpMntRoot(p);
    const items = visibleSortedItems(side);
    updateHeaderSortUi();

    const buildRow = (it, itemIndex) => {
      const row = document.createElement('div');
      const name = safeName(it && it.name);
      const type = String((it && it.type) || '');
      const linkDir = !!(it && it.link_dir);
      const isDir = type === 'dir' || (type === 'link' && linkDir);
      row.className = 'fm-row' + (isDir ? ' is-dir' : '');
      row.setAttribute('role', 'row');
      row.tabIndex = -1;
      row.id = `fm-${side}-option-${Number(itemIndex || 0)}`;
      row.dataset.name = name;
      row.dataset.type = type;
      row.setAttribute('draggable', isLiteMode() ? 'false' : 'true');

      const selected = !!(p.selected && typeof p.selected.has === 'function' ? p.selected.has(name) : false);
      if (selected) row.classList.add('is-selected');
      if (focusName && focusName === name) row.classList.add('is-focused');
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
      row.setAttribute('aria-posinset', String(Number(itemIndex || 0) + 1));
      row.setAttribute('aria-setsize', String(items.length));

      const size = isDir ? 'DIR' : fmtSize(it && it.size);
      const perm = safeName(it && it.perm);
      const mtime = fmtTime(it && it.mtime);
      const trashFrom = safeName(it && it.trash_from);
      const fromCell = showTrashFrom
        ? '<div class="fm-cell fm-from"><span class="fm-from-text"></span></div>'
        : '';
      const isDiskLabel = tmpMntRoot && type === 'link' && linkDir;
      // Content-type marks are documented I3 exceptions: they distinguish
      // folders, devices, links and files inside the data grid, not actions.
      const ico = (type === 'dir') ? '📁'
        : (type === 'link'
          ? (linkDir ? (isDiskLabel ? '💽' : '📁') : '🔗')
          : '📄');
      row.innerHTML = `
        <div class="fm-cell fm-check" role="gridcell"><input type="checkbox" class="fm-check-input" aria-label="Выбрать" /></div>
        <div class="fm-cell fm-name" role="gridcell"><span class="fm-ico">${ico}</span><span class="fm-name-text"></span></div>
        ${fromCell}
        <div class="fm-cell fm-size" role="gridcell">${size}</div>
        <div class="fm-cell fm-perm" role="gridcell">${perm ? perm : ''}</div>
        <div class="fm-cell fm-mtime" role="gridcell">${mtime}</div>
      `;
      try {
        const t = qs('.fm-name-text', row);
        if (t) t.textContent = name;
      } catch (e) {}
      if (showTrashFrom) {
        try {
          const ft = qs('.fm-from-text', row);
          if (ft) ft.textContent = trashFrom || '';
          const fc = qs('.fm-cell.fm-from', row);
          if (fc) fc.title = trashFrom || '';
          if (fc) fc.setAttribute('role', 'gridcell');
        } catch (e) {}
      }
      try {
        const cb = qs('.fm-check-input', row);
        if (cb) {
          cb.checked = !!selected;
          cb.setAttribute('aria-label', `Выбрать ${name}`);
        }
      } catch (e) {}
      return row;
    };

    list.innerHTML = '';
    list.appendChild(header);

    if (!items.length) {
      const empty = document.createElement('div');
      const hasFilter = !!String(p.filter || '').trim();
      const remoteDisconnected = p.target === 'remote' && !p.sid;
      empty.className = 'fm-panel-state fm-empty';
      empty.setAttribute('role', 'status');
      empty.dataset.state = hasFilter ? 'filtered-empty' : (remoteDisconnected ? 'disconnected' : 'empty');

      const title = hasFilter
        ? 'Ничего не найдено'
        : (remoteDisconnected ? 'Удалённый источник не подключён' : 'Папка пуста');
      const detail = hasFilter
        ? `Нет файлов по фильтру «${String(p.filter || '').trim()}».`
        : (remoteDisconnected ? 'Выберите подключение, чтобы показать файлы.' : 'Здесь пока нет файлов и папок.');

      const titleEl = document.createElement('div');
      titleEl.className = 'fm-panel-state-title';
      titleEl.textContent = title;
      const detailEl = document.createElement('div');
      detailEl.className = 'fm-panel-state-detail';
      detailEl.textContent = detail;
      empty.appendChild(titleEl);
      empty.appendChild(detailEl);

      if (hasFilter) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn-secondary fm-empty-action';
        clear.innerHTML = `${iconHtml('close')}<span class="xk-action-label">Сбросить фильтр</span>`;
        clear.addEventListener('click', () => {
          p.filter = '';
          try { if (pd.filterInput) pd.filterInput.value = ''; } catch (e) {}
          R.renderPanel(side);
          try { if (pd.filterInput) pd.filterInput.focus(); } catch (e) {}
        });
        empty.appendChild(clear);
      }

      list.appendChild(empty);
      list.removeAttribute('aria-activedescendant');
      setPanelState(pd, remoteDisconnected ? 'disconnected' : 'empty');
      try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
      return;
    }

    setPanelState(pd, 'ready');

    // Large directories: incremental/batched render to avoid freezing the UI.
    const BIG = 1000;
    const BATCH = 250;
    if (!items || items.length <= BIG) {
      const frag = document.createDocumentFragment();
      (items || []).forEach((it, index) => frag.appendChild(buildRow(it, index)));
      list.appendChild(frag);
    } else {
      let idx = 0;
      const pump = () => {
        if (Number(S.renderToken[side] || 0) !== myToken) return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < BATCH && idx < items.length; i += 1, idx += 1) {
          frag.appendChild(buildRow(items[idx], idx));
        }
        list.appendChild(frag);
        if (idx < items.length) {
          requestAnimationFrame(pump);
        } else {
          // Ensure focus row visible
          try {
            const f = qs('.fm-row.is-focused', list);
            if (f) {
              list.setAttribute('aria-activedescendant', f.id);
              if (typeof f.scrollIntoView === 'function') f.scrollIntoView({ block: 'nearest' });
            } else {
              list.removeAttribute('aria-activedescendant');
            }
          } catch (e) {}
        }
      };
      try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
      requestAnimationFrame(pump);
      return; // focus handling moved into pump()
    }

    // Ensure focus row visible
    try {
      const f = qs('.fm-row.is-focused', list);
      if (f) {
        list.setAttribute('aria-activedescendant', f.id);
        if (typeof f.scrollIntoView === 'function') f.scrollIntoView({ block: 'nearest' });
      } else {
        list.removeAttribute('aria-activedescendant');
      }
    } catch (e) {}

    // Footer status: selected count/size + free space (best-effort)
    try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
  };

  // Lightweight UI sync: apply current selection/focus state to already rendered rows.
  // Useful for bulk selection actions (Ctrl+A / context menu) without full re-render.
  R.applySelectionUi = function applySelectionUi(side) {
    const S = _S();
    if (!S || !S.panels) return;

    const pd = panelDom(side);
    const p = S.panels[side] || null;
    if (!pd || !pd.list || !p) return;

    const list = pd.list;
    const focusName = String(p.focusName || '');
    const selected = (p.selected && typeof p.selected.has === 'function') ? p.selected : null;

    // Only touch item rows (skip header).
    const rows = qsa('.fm-row[data-name]', list);
    for (const row of rows) {
      const name = String((row && row.dataset && row.dataset.name) || '');
      if (!name) continue;
      const isSel = !!(selected && selected.has(name));
      try { row.classList.toggle('is-selected', isSel); } catch (e) {}
      try { row.classList.toggle('is-focused', !!focusName && focusName === name); } catch (e) {}
      try { row.setAttribute('aria-selected', isSel ? 'true' : 'false'); } catch (e) {}
      try {
        const cb = qs('.fm-check-input', row);
        if (cb) cb.checked = isSel;
      } catch (e) {}
    }

    try {
      const focused = qs('.fm-row.is-focused', list);
      if (focused && focused.id) list.setAttribute('aria-activedescendant', focused.id);
      else list.removeAttribute('aria-activedescendant');
    } catch (e) {}

    try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
  };
})();
