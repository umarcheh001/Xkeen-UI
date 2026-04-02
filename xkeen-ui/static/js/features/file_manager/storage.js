import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // USB storage UI (list + mount/unmount) for File Manager.
  // Attaches to the shared file manager namespace.storage.

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = FM.common || {};
  const API = FM.api || {};

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qs(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function qsa(sel, root) {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  }

  function toast(msg, lvl) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, lvl); } catch (e) {}
    return undefined;
  }

  async function confirmModal(opts) {
    try {
      if (C && typeof C.confirm === 'function') return await C.confirm(opts || {});
    } catch (e) {}
    try {
      const text = String((opts && (opts.message || opts.text)) || 'Продолжить?');
      return !!window.confirm(text);
    } catch (e2) {
      return false;
    }
  }

  function modalOpen(m) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(m); } catch (e) {}
    try { if (m) m.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(m) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(m); } catch (e) {}
    try { if (m) m.classList.add('hidden'); } catch (e2) {}
  }

  function fmtSize(n) {
    try { if (C && typeof C.fmtSize === 'function') return C.fmtSize(n); } catch (e) {}
    const v = Number(n);
    if (!isFinite(v) || v < 0) return '';
    if (v === 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let x = v;
    let i = 0;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    const p = (x >= 10 || i === 0) ? 0 : 1;
    return x.toFixed(p) + ' ' + u[i];
  }

  async function fetchOk(url, init, ctx) {
    if (API && typeof API.fetchJsonOk === 'function') return await API.fetchJsonOk(url, init, ctx);
    const res = await fetch(url, init || {});
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error('api error');
    return data;
  }

  // ---------------------------------------------------------------------------
  // Modal + rendering
  // ---------------------------------------------------------------------------
  let _wired = false;
  let _busy = false;

  function _setBusy(on) {
    _busy = !!on;
    const sp = el('fm-volumes-spinner');
    const btn = el('fm-volumes-refresh-btn');
    try {
      if (sp) sp.classList.toggle('hidden', !_busy);
      if (btn) btn.disabled = _busy;
    } catch (e) {}
    try {
      qsa('#fm-volumes-list button[data-act]').forEach((b) => { b.disabled = _busy; });
    } catch (e2) {}
  }

  function _render(items) {
    const box = el('fm-volumes-list');
    if (!box) return;

    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      box.innerHTML = '<div class="status" style="opacity:.85;">USB-разделы не найдены.</div>';
      return;
    }

    const escape = (s) => {
      const x = String(s == null ? '' : s);
      return x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    };

    const html = [
      '<table class="fm-volumes-table">',
      '<thead><tr>',
      '<th>Label</th>',
      '<th>FS</th>',
      '<th>Тип</th>',
      '<th>Куда</th>',
      '<th>Свободно / Всего</th>',
      '<th>Статус</th>',
      '<th></th>',
      '</tr></thead>',
      '<tbody>',
    ];

    rows.forEach((it) => {
      const name = String((it && it.name) || '');
      const label = String((it && it.label) || '');
      const fstype = String((it && it.fstype) || '');
      const mp = String((it && it.mountpoint) || '');
      const state = String((it && it.state) || '');
      const mounted = state === 'mounted';
      const total = (it && typeof it.total === 'number') ? it.total : null;
      const free = (it && typeof it.free === 'number') ? it.free : null;

      const sizeTxt = (total != null && free != null) ? (fmtSize(free) + ' / ' + fmtSize(total)) : '';

      html.push('<tr>');
      html.push(`<td class="fm-volumes-td-label">${escape(label || '—')}</td>`);
      html.push(`<td class="fm-volumes-td-name"><code>${escape(name)}</code></td>`);
      html.push(`<td>${escape(fstype || '—')}</td>`);
      html.push(`<td>${mp ? ('<code>' + escape(mp) + '</code>') : '—'}</td>`);
      html.push(`<td>${escape(sizeTxt || '—')}</td>`);
      html.push(`<td><span class="fm-volumes-state ${mounted ? 'is-mounted' : 'is-unmounted'}">${mounted ? 'mounted' : 'unmounted'}</span></td>`);
      if (mounted) {
        html.push(`<td><button type="button" class="btn-secondary" data-act="unmount" data-name="${escape(name)}">Unmount</button></td>`);
      } else {
        html.push(`<td><button type="button" class="btn-secondary" data-act="mount" data-name="${escape(name)}">Mount</button></td>`);
      }
      html.push('</tr>');
    });

    html.push('</tbody></table>');
    box.innerHTML = html.join('');
  }

  async function refresh(opts) {
    const allowBusy = !!(opts && opts.allowBusy);
    const keepBusy = !!(opts && opts.keepBusy);

    if (_busy && !allowBusy) return [];

    const wasBusy = _busy;
    if (!wasBusy) _setBusy(true);
    const sum = el('fm-volumes-summary');
    try {
      if (sum) sum.textContent = 'Обновляю…';
    } catch (e) {}

    let items = [];

    try {
      const data = await fetchOk('/api/storage/usb', { method: 'GET' }, { feature: 'storageUsb', op: 'list' });
      items = Array.isArray(data.items) ? data.items : [];
      _render(items);
      try {
        const ts = data.ts ? new Date(Number(data.ts) * 1000) : null;
        const t = ts ? ts.toLocaleString() : '';
        if (sum) sum.textContent = `Найдено: ${items.length}${t ? (' • ' + t) : ''}`;
      } catch (e2) {
        if (sum) sum.textContent = `Найдено: ${items.length}`;
      }
    } catch (e) {
      if (sum) sum.textContent = 'Не удалось загрузить список.';
      toast('Не удалось получить список USB-разделов', 'error');
      const box = el('fm-volumes-list');
      if (box) box.innerHTML = '<div class="error">Ошибка загрузки</div>';
    } finally {
      // If refresh() started the busy state, it is responsible for stopping it.
      if (!wasBusy && !keepBusy) _setBusy(false);
    }

    return items;
  }

  function _activeSide() {
    try {
      const S = (FM.state && FM.state.S) ? FM.state.S : null;
      const s = S ? String(S.activeSide || '') : '';
      return (s === 'right' || s === 'left') ? s : 'left';
    } catch (e) {
      return 'left';
    }
  }

  async function _openInActivePanel(path) {
    const pth = String(path || '').trim();
    if (!pth) return false;

    const side = _activeSide();
    let S = null;
    try { S = (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { S = null; }
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return false;

    // Path is local by definition.
    try { p.target = 'local'; } catch (e) {}
    try { p.cwd = pth; } catch (e2) {}
    try {
      if (FM.state && typeof FM.state.panelDom === 'function') {
        const pd = FM.state.panelDom(side);
        if (pd && pd.pathInput) pd.pathInput.value = pth;
      }
    } catch (e3) {}

    try {
      if (FM.listing && typeof FM.listing.listPanel === 'function') {
        await FM.listing.listPanel(side, { fromInput: true });
        return true;
      }
    } catch (e4) {}
    return false;
  }

  async function _resolveMountpointAfterMount(fsName, attempts) {
    const nm = String(fsName || '').trim();
    const tries = Math.max(1, Number(attempts || 1));
    for (let i = 0; i < tries; i++) {
      const items = await refresh({ allowBusy: true, keepBusy: true });
      try {
        const it = (items || []).find(x => String((x && x.name) || '') === nm);
        const mp = it ? String(it.mountpoint || '').trim() : '';
        if (mp) return mp;
      } catch (e) {}
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return '';
  }

  async function _doAct(act, name) {
    if (_busy) return;
    const nm = String(name || '').trim();
    if (!nm) return;

    const url = (act === 'mount') ? '/api/storage/usb/mount' : '/api/storage/usb/unmount';
    const verb = (act === 'mount') ? 'Mount' : 'Unmount';

    _setBusy(true);
    try {
      await fetchOk(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nm }),
        },
        { feature: 'storageUsb', op: act, name: nm }
      );

      toast(`${verb}: OK`, 'success');

      // Update file manager panels so /tmp/mnt changes are visible.
      try { if (FM.listing && typeof FM.listing.refreshAll === 'function') FM.listing.refreshAll(); } catch (e2) {}

      // After mount: offer to navigate to the new mountpoint in the active panel.
      if (act === 'mount') {
        const mp = await _resolveMountpointAfterMount(nm, 3);
        if (mp) {
          const ok = await confirmModal({
            title: 'Том смонтирован',
            message: `Смонтировано в: ${mp}\n\nПерейти в эту папку в активной панели?`,
            okText: 'Перейти',
            cancelText: 'Нет',
            danger: false,
          });
          if (ok) {
            try {
              const m = el('fm-volumes-modal');
              if (m) modalClose(m);
            } catch (e3) {}
            const moved = await _openInActivePanel(mp);
            if (!moved) toast('Не удалось открыть путь в активной панели', 'error');
          }
        } else {
          // No mountpoint detected (firmware variance / delayed mount).
          // Still keep the list updated.
          await refresh({ allowBusy: true, keepBusy: true });
        }
      } else {
        await refresh({ allowBusy: true, keepBusy: true });
      }
    } catch (e) {
      toast(`${verb}: ошибка`, 'error');
    } finally {
      _setBusy(false);
    }
  }

  function openModal() {
    const m = el('fm-volumes-modal');
    if (!m) return;
    modalOpen(m);
    refresh();
  }

  function init() {
    if (_wired) return;
    _wired = true;

    const btn = el('fm-volumes-btn');
    const m = el('fm-volumes-modal');
    const closeBtn = el('fm-volumes-close-btn');
    const refreshBtn = el('fm-volumes-refresh-btn');
    const listBox = el('fm-volumes-list');

    try {
      if (btn) {
        btn.addEventListener('click', () => openModal());
      }
    } catch (e) {}

    try {
      if (closeBtn && m) closeBtn.addEventListener('click', () => modalClose(m));
    } catch (e2) {}

    try {
      if (m) {
        // click outside content to close
        m.addEventListener('click', (ev) => {
          const c = qs('.modal-content', m);
          if (!c) return;
          if (ev && ev.target === m) modalClose(m);
        });
      }
    } catch (e3) {}

    try {
      if (refreshBtn) refreshBtn.addEventListener('click', () => refresh());
    } catch (e4) {}

    try {
      if (listBox) {
        listBox.addEventListener('click', (ev) => {
          const t = ev && ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
          if (!t) return;
          const act = String(t.getAttribute('data-act') || '');
          const name = String(t.getAttribute('data-name') || '');
          if (act === 'mount' || act === 'unmount') {
            ev.preventDefault();
            _doAct(act, name);
          }
        });
      }
    } catch (e5) {}
  }

  // Public API
  FM.storage = FM.storage || {};
  FM.storage.init = init;
  FM.storage.open = openModal;
  FM.storage.refresh = refresh;
})();
