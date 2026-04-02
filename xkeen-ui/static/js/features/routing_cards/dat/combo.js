import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/dat/combo.js
  One control: input + ▼ popover with detected .dat files.

  RC-06b
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.state = RC.state || {};

  RC.dat = RC.dat || {};
  const DAT = RC.dat;

  const C = RC.common || {};

  function fmtSize(n) {
    const b = Number(n || 0);
    if (!isFinite(b) || b <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = b;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    const prec = i === 0 ? 0 : (v >= 10 ? 1 : 2);
    return `${v.toFixed(prec)} ${units[i]}`;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts * 1000);
      return d.toLocaleString();
    } catch (e) {
      return '';
    }
  }

  function ensureState() {
    RC.state.datCombo = RC.state.datCombo || {
      geosite: { open: false, entries: [], openValue: '' },
      geoip: { open: false, entries: [], openValue: '' },
    };
    return RC.state.datCombo;
  }

  function getComboRoot(nameEl) {
    try {
      if (!nameEl) return null;
      if (typeof nameEl.closest === 'function') return nameEl.closest('.routing-dat-combo');
      return null;
    } catch (e) {
      return null;
    }
  }

  function setComboOpen(kind, root, open) {
    try {
      const k = String(kind || '').toLowerCase();
      const st = ensureState();
      if (st[k]) st[k].open = !!open;
      if (!root) return;
      if (open) root.classList.add('is-open');
      else root.classList.remove('is-open');
    } catch (e) {}
  }

  function closeAllCombos(exceptKind) {
    const ex = String(exceptKind || '').toLowerCase();
    try {
      document.querySelectorAll('.routing-dat-combo.is-open').forEach((root) => {
        const k = String((root && (root.getAttribute('data-kind') || (root.dataset && root.dataset.kind))) || '').toLowerCase();
        if (ex && k === ex) return;
        root.classList.remove('is-open');
      });
    } catch (e) {}

    try {
      const st = ensureState();
      Object.keys(st).forEach((k) => {
        if (ex && k === ex) return;
        st[k].open = false;
      });
    } catch (e) {}
  }

  function renderFoundList(containerEl, entries, currentName, onPick) {
    if (!containerEl) return;
    try {
      const list = Array.isArray(entries) ? entries : [];
      const current = String(currentName || '').trim().toLowerCase();

      containerEl.innerHTML = '';

      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'routing-dat-found-empty';
        e.textContent = '— нет .dat';
        containerEl.appendChild(e);
        return;
      }

      const frag = document.createDocumentFragment();
      list.forEach((it) => {
        const name = String((it && it.name) || '');
        if (!name) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'routing-dat-found-item' + (name.toLowerCase() === current ? ' is-current' : '');
        btn.dataset.name = name;

        const n = document.createElement('span');
        n.className = 'routing-dat-found-name';
        n.textContent = name;

        const meta = document.createElement('span');
        meta.className = 'routing-dat-found-meta';
        const sz = (it && it.size !== undefined && it.size !== null) ? fmtSize(it.size) : '';
        const mt = (it && it.mtime) ? fmtTime(it.mtime) : '';
        meta.textContent = (sz ? sz : '') + (mt ? (' • ' + mt) : '');

        btn.appendChild(n);
        btn.appendChild(meta);

        if (typeof onPick === 'function') {
          btn.addEventListener('click', () => {
            try { onPick(name); } catch (e) {}
          });
        }

        frag.appendChild(btn);
      });

      containerEl.appendChild(frag);
    } catch (e) {
      try { containerEl.textContent = '—'; } catch (err) {}
    }
  }

  function renderCombo(kind, m) {
    const k = String(kind || '').toLowerCase();
    const st = ensureState();
    const s = st[k] || { entries: [], open: false, openValue: '' };
    const entries = Array.isArray(s.entries) ? s.entries : [];

    let q = (m && m.name) ? String(m.name.value || '').trim().toLowerCase() : '';

    // If the value hasn't changed since opening, don't auto-filter.
    try {
      const opened = String((s && s.openValue) || '').trim().toLowerCase();
      if (opened && q === opened) q = '';
    } catch (e) {}

    if (!m || !m.found) return;

    let list = entries;
    if (q) {
      list = entries.filter((e) => String((e && e.name) || '').toLowerCase().includes(q));
      if (entries.length && !list.length) {
        try {
          m.found.innerHTML = '';
          const e = document.createElement('div');
          e.className = 'routing-dat-found-empty';
          e.textContent = '— нет совпадений';
          m.found.appendChild(e);
        } catch (err) {}
        return;
      }
    }

    renderFoundList(m.found, list, (m && m.name) ? m.name.value : '', (picked) => {
      try {
        if (m && m.name) {
          m.name.value = String(picked || '');
          m.name.dispatchEvent(new Event('input', { bubbles: true }));
          m.name.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
      try {
        const root = getComboRoot(m && m.name);
        setComboOpen(k, root, false);
      } catch (e) {}
      try {
        if (typeof m.refreshLater === 'function') m.refreshLater();
      } catch (e) {}
    });
  }

  function ensureGlobalListeners() {
    if (RC.state.datComboGlobalBound) return;
    RC.state.datComboGlobalBound = true;

    // Close on click outside
    document.addEventListener('click', (e) => {
      try {
        const t = e && e.target ? e.target : null;
        if (!t) return;
        const inside = (typeof t.closest === 'function') ? t.closest('.routing-dat-combo') : null;
        if (!inside) closeAllCombos();
      } catch (err) {}
    }, true);

    // Close on Esc
    document.addEventListener('keydown', (e) => {
      try {
        if (e && e.key === 'Escape') closeAllCombos();
      } catch (err) {}
    }, true);
  }

  function bind(kind, m, refreshLater) {
    const k = String(kind || '').toLowerCase();
    if (!m) return;
    ensureGlobalListeners();

    try { m.refreshLater = refreshLater; } catch (e) {}

    const nameEl = m.name;
    const browseEl = m.browse;

    if (browseEl) {
      browseEl.addEventListener('click', (ev) => {
        try { ev.preventDefault(); } catch (e) {}
        try { ev.stopPropagation(); } catch (e) {}

        const root = getComboRoot(nameEl) || (browseEl.closest ? browseEl.closest('.routing-dat-combo') : null);
        const isOpen = !!(root && root.classList.contains('is-open'));
        if (!isOpen) closeAllCombos(k);

        // Remember value at open
        try {
          const st = ensureState();
          if (!isOpen && st[k]) st[k].openValue = String((nameEl && nameEl.value) || '');
        } catch (e) {}

        setComboOpen(k, root, !isOpen);
        if (!isOpen) renderCombo(k, m);
      });
    }

    if (nameEl) {
      nameEl.addEventListener('input', () => {
        try {
          const st = ensureState();
          if (st[k] && st[k].open) renderCombo(k, m);
        } catch (e) {}
      });

      nameEl.addEventListener('keydown', (ev) => {
        try {
          if (!ev) return;
          if (ev.key === 'ArrowDown') {
            const root = getComboRoot(nameEl);
            closeAllCombos(k);
            try {
              const st = ensureState();
              if (st[k]) st[k].openValue = String((nameEl && nameEl.value) || '');
            } catch (e) {}
            setComboOpen(k, root, true);
            renderCombo(k, m);
          } else if (ev.key === 'Escape') {
            const root = getComboRoot(nameEl);
            setComboOpen(k, root, false);
          }
        } catch (e) {}
      });
    }
  }

  function setEntries(kind, entries) {
    const k = String(kind || '').toLowerCase();
    try {
      const st = ensureState();
      if (st[k]) st[k].entries = Array.isArray(entries) ? entries : [];
    } catch (e) {}
  }

  function rerenderIfOpen(kind, m) {
    const k = String(kind || '').toLowerCase();
    try {
      const st = ensureState();
      if (st[k] && st[k].open) renderCombo(k, m);
    } catch (e) {}
  }

  DAT.combo = DAT.combo || {};
  DAT.combo.fmtSize = fmtSize;
  DAT.combo.fmtTime = fmtTime;
  DAT.combo.ensureGlobalListeners = ensureGlobalListeners;
  DAT.combo.closeAll = closeAllCombos;
  DAT.combo.bind = bind;
  DAT.combo.setEntries = setEntries;
  DAT.combo.renderFoundList = renderFoundList;
  DAT.combo.rerenderIfOpen = rerenderIfOpen;
})();
