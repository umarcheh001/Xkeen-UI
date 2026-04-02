import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager: Properties (Props modal)
  // No ES modules / bundler: attach to the shared file manager namespace.props
  //
  // Exports:
  //   FM.props.recalcDirSize(side, pathAbs)
  //   FM.props.openPropsModal(side)
  //   FM.actions.openPropsModal(side)  (compat)

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.props = FM.props || {};
  const PR = FM.props;

  FM.actions = FM.actions || {};
  const AC = FM.actions;

  const C = FM.common || {};
  FM.api = FM.api || {};
  const A = FM.api;
  const SEL = FM.selection || {};

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

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
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

  function isLiteMode() {
    try { if (C && typeof C.isLiteMode === 'function') return !!C.isLiteMode(); } catch (e) {}
    try { return !!(S && typeof S.liteMode === 'boolean' && S.liteMode); } catch (e2) {}
    return false;
  }

  async function fetchJson(url, init) {
    if (A && typeof A.fetchJson === 'function') return await A.fetchJson(url, init);
    throw new Error('FM.api.fetchJson missing');
  }

  // -------------------------- properties (Props modal) --------------------------
  let propsReqId = 0;
  let propsDeepReqId = 0;
  const _dirSizeCache = new Map();
  const _DIRSIZE_CACHE_TTL_MS = 5 * 60 * 1000;

  function _dirSizeCacheGet(pathAbs) {
    try {
      const k = String(pathAbs || '');
      if (!k) return null;
      const v = _dirSizeCache.get(k);
      if (!v) return null;
      const age = Date.now() - (v.ts || 0);
      if (age > _DIRSIZE_CACHE_TTL_MS) {
        _dirSizeCache.delete(k);
        return null;
      }
      return v;
    } catch (e) {
      return null;
    }
  }

  function _dirSizeCacheSet(pathAbs, bytes, err) {
    try {
      const k = String(pathAbs || '');
      if (!k) return;
      _dirSizeCache.set(k, { ts: Date.now(), bytes: (typeof bytes === 'number' ? bytes : null), err: err ? String(err) : '' });
    } catch (e) {}
  }

  async function recalcDirSize(side, pathAbs) {
    const s = String(side || S.activeSide || 'left');
    const p = S && S.panels ? S.panels[s] : null;
    if (!p) return;

    if (isLiteMode()) {
      toast('Глубокий расчёт размера отключён в lite-режиме', 'info');
      return;
    }

    if (p.target !== 'local') {
      toast('Размер содержимого доступен только для local', 'info');
      return;
    }

    const full = String(pathAbs || '').trim();
    if (!full) return;

    const valEl = el('fm-props-dirsize-val');
    const noteEl = el('fm-props-dirsize-note');
    const btnEl = el('fm-props-dirsize-recalc-btn');
    if (!valEl || !btnEl) return;

    btnEl.disabled = true;
    try { btnEl.textContent = 'Считаю…'; } catch (e) {}
    if (noteEl) noteEl.textContent = '';
    valEl.textContent = '…';

    const reqId = ++propsDeepReqId;

    // Queue deep-size as fileops job (FM-20)
    let jobId = '';
    try {
      if (FM.ops && typeof FM.ops.executeJob === 'function') {
        const payload = { op: 'dirsize', src: { target: 'local', path: full } };
        jobId = await FM.ops.executeJob(payload);
      }
    } catch (e) { jobId = ''; }

    if (reqId !== propsDeepReqId) return;
    if (!jobId) {
      _dirSizeCacheSet(full, null, 'job_failed');
      valEl.textContent = 'Не удалось рассчитать';
      if (noteEl) noteEl.textContent = '• не удалось запустить job';
      btnEl.disabled = false;
      try { btnEl.textContent = 'Пересчитать'; } catch (e) {}
      return;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const started = Date.now();
      while (true) {
        if (reqId !== propsDeepReqId) return;
        if ((Date.now() - started) > 30 * 60 * 1000) throw new Error('timeout');
        const { res, data } = await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
        if (reqId !== propsDeepReqId) return;
        if (!res || !res.ok || !data || !data.ok || !data.job) { await sleep(500); continue; }
        const job = data.job;
        const st = String(job.state || '').toLowerCase();
        if (st === 'done') {
          const pr = job.progress || {};
          const r = pr.result || pr.dirsize || null;
          const bytes = r && (r.bytes !== undefined) ? Number(r.bytes) : NaN;
          const truncated = !!(r && r.truncated);
          const note = truncated ? 'truncated' : '';
          if (isFinite(bytes) && bytes >= 0) {
            _dirSizeCacheSet(full, bytes, note);
            valEl.textContent = `${fmtSize(bytes)} (${Math.max(0, Math.trunc(bytes))} B)`;
            if (noteEl) noteEl.textContent = note ? (`• ${note}`) : '';
          } else {
            _dirSizeCacheSet(full, null, 'не удалось');
            valEl.textContent = 'Не удалось рассчитать';
            if (noteEl) noteEl.textContent = '• не удалось';
          }
          break;
        }
        if (st === 'error') {
          const emsg = String(job.error || 'ошибка');
          _dirSizeCacheSet(full, null, emsg);
          valEl.textContent = 'Не удалось рассчитать';
          if (noteEl) noteEl.textContent = '• ' + emsg;
          break;
        }
        if (st === 'canceled') {
          _dirSizeCacheSet(full, null, 'canceled');
          valEl.textContent = 'Не удалось рассчитать';
          if (noteEl) noteEl.textContent = '• отменено';
          break;
        }
        await sleep(450);
      }
    } catch (e) {
      if (reqId !== propsDeepReqId) return;
      _dirSizeCacheSet(full, null, 'ошибка');
      valEl.textContent = 'Не удалось рассчитать';
      if (noteEl) noteEl.textContent = '• ошибка';
    } finally {
      if (reqId === propsDeepReqId) {
        btnEl.disabled = false;
        try { btnEl.textContent = 'Пересчитать'; } catch (e) {}
      }
    }
  }

  function _htmlEscape(s) {
    const str = String(s == null ? '' : s);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _kvRow(k, v) {
    const key = _htmlEscape(k);
    const val = (v === null || v === undefined || v === '') ? '—' : _htmlEscape(v);
    return `<div class="fm-props-k">${key}</div><div class="fm-props-v">${val}</div>`;
  }

  function _kvRowHtml(k, vHtml) {
    const key = _htmlEscape(k);
    const val = (vHtml === null || vHtml === undefined || vHtml === '') ? '—' : String(vHtml);
    return `<div class="fm-props-k">${key}</div><div class="fm-props-v">${val}</div>`;
  }

  async function buildPropsHtml(side, reqId) {
    const p = (S && S.panels) ? S.panels[side] : null;
    if (!p) return { metaText: '', html: '<div class="fm-props-empty">Нет данных.</div>' };

    const names = getSelectionNames(side);
    const selCount = (p.selected && p.selected.size) ? p.selected.size : 0;

    const metaText = `${side === 'left' ? 'левая' : 'правая'} панель • ${selCount ? ('выделено: ' + selCount) : (names.length ? 'фокус' : 'нет выбора')}`;

    if (!names.length) {
      return { metaText, html: '<div class="fm-props-empty">Ничего не выбрано.</div>' };
    }

    // Remote target requires an active session.
    if (p.target === 'remote' && !p.sid) {
      return { metaText, html: '<div class="fm-props-empty">Remote: нет соединения.</div>' };
    }

    // NOTE: /api/fs/stat-batch expects full paths. Build them from the panel cwd.
    const fullPaths = names.map((nm) => (p.target === 'remote' ? joinRemote(p.cwd, nm) : joinLocal(p.cwd, nm)));
    const payload = { target: p.target, paths: fullPaths };
    if (p.target === 'remote') payload.sid = p.sid;

    let j = null;
    try {
      const { res, data } = await fetchJson('/api/fs/stat-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (reqId !== propsReqId) return null; // outdated
      if (!res || !res.ok || !data || !data.ok) {
        return { metaText, html: '<div class="fm-props-empty">Не удалось получить свойства.</div>' };
      }
      j = data;
    } catch (e) {
      if (reqId !== propsReqId) return null;
      return { metaText, html: '<div class="fm-props-empty">Ошибка запроса свойств.</div>' };
    }

    const items = Array.from((j && j.items) || []).filter((x) => x && x.exists);
    if (!items.length) {
      return { metaText, html: '<div class="fm-props-empty">Файлы не найдены.</div>' };
    }

    // Aggregation: total size for files/links; directories use deep size if provided.
    let totalBytes = 0;
    let hasUnknownDir = false;
    let countFile = 0, countDir = 0, countLink = 0;
    items.forEach((it) => {
      const t = String(it.type || '');
      if (t === 'dir') {
        countDir++;
        const dn = Number((it && it.size_deep !== null && it.size_deep !== undefined) ? it.size_deep : NaN);
        if (isFinite(dn) && dn >= 0) totalBytes += dn;
        else hasUnknownDir = true;
        return;
      }
      if (t === 'link') countLink++; else countFile++;
      const n = Number(it.size);
      if (isFinite(n) && n >= 0) totalBytes += n;
    });

    const totalLine = (() => {
      const base = fmtSize(totalBytes);
      if (hasUnknownDir) return `${base || '0 B'} + папки (неизвестно)`;
      return base || '0 B';
    })();

    if (items.length === 1) {
      const it = items[0];
      const name = safeName(names[0]);
      const path = safeName(it.path || '');
      const t = safeName(it.type || '');
      const perm = safeName(it.perm || '');
      const mtime = fmtTime(it.mtime);
      const uid = (it.uid === undefined || it.uid === null) ? '' : String(it.uid);
      const gid = (it.gid === undefined || it.gid === null) ? '' : String(it.gid);
      const linkTarget = safeName(it.link_target || '');

      const rows = [
        _kvRow('Имя', name),
        _kvRow('Путь', path),
        _kvRow('Тип', t),
      ];

      if (t === 'dir') {
        const entryBytes = Number(it.size);
        const cache = _dirSizeCacheGet(path);
        const cachedBytes = cache && typeof cache.bytes === 'number' ? Number(cache.bytes) : NaN;
        const cachedErr = cache ? String(cache.err || '') : '';
        const isLocal = (p.target === 'local');
        const lite = isLiteMode();
        const sizeText = (!isLocal) ? 'недоступно' : (lite ? 'недоступно в lite-режиме' : ((isFinite(cachedBytes) && cachedBytes >= 0)
          ? `${fmtSize(cachedBytes)} (${Math.max(0, Math.trunc(cachedBytes))} B)`
          : 'не рассчитан'));
        const noteHtml = (isLocal && cachedErr) ? _htmlEscape(`• ${cachedErr}`) : '';
        const canRecalc = isLocal && !lite;
        const btnHtml = canRecalc
          ? `<button type="button" class="btn-secondary fm-props-recalc-btn" id="fm-props-dirsize-recalc-btn" data-side="${_htmlEscape(side)}" data-path="${_htmlEscape(path)}">Пересчитать</button>`
          : '';
        const valHtml = `<div class="fm-props-actions"><span id="fm-props-dirsize-val">${_htmlEscape(sizeText)}</span>${btnHtml}<span id="fm-props-dirsize-note" class="fm-props-dirsize-note">${noteHtml}</span></div>`;
        rows.push(_kvRowHtml('Размер содержимого', valHtml));
        rows.push(_kvRow('Размер записи', `${fmtSize(entryBytes)} (${isFinite(entryBytes) ? Math.max(0, Math.trunc(entryBytes)) : 0} B)`));
      } else {
        const sizeBytes = Number(it.size);
        rows.push(_kvRow('Размер', `${fmtSize(sizeBytes)} (${isFinite(sizeBytes) ? Math.max(0, Math.trunc(sizeBytes)) : 0} B)`));
      }

      rows.push(_kvRow('Изменён', mtime));
      rows.push(_kvRow('Права', perm));
      if (uid || gid) rows.push(_kvRow('UID/GID', `${uid || '—'}:${gid || '—'}`));
      if (t === 'link') rows.push(_kvRow('Symlink →', linkTarget || '—'));

      return { metaText, html: `<div class="fm-props-grid">${rows.join('')}</div>` };
    }

    const rows = [
      _kvRow('Выделено', String(items.length)),
      _kvRow('Файлы/Папки/Ссылки', `${countFile}/${countDir}/${countLink}`),
      _kvRow('Сумма размеров', totalLine),
    ];

    return { metaText, html: `<div class="fm-props-grid">${rows.join('')}</div>` };
  }

  async function openPropsModal(side) {
    const s = String(side || S.activeSide || 'left');
    const modal = el('fm-props-modal');
    const metaEl = el('fm-props-modal-meta');
    const bodyEl = el('fm-props-modal-body');

    if (!modal || !metaEl || !bodyEl) {
      toast('FM: модалка "Свойства" не найдена', 'error');
      return;
    }

    const p = (S && S.panels) ? S.panels[s] : null;
    if (!p) return;

    const reqId = ++propsReqId;

    // Show early so it feels instant.
    metaEl.textContent = `${s === 'left' ? 'левая' : 'правая'} панель`;
    bodyEl.innerHTML = '<div class="fm-props-empty">Загрузка…</div>';
    modalOpen(modal);

    const out = await buildPropsHtml(s, reqId);
    if (!out || reqId !== propsReqId) return;

    metaEl.textContent = String(out.metaText || '');
    bodyEl.innerHTML = String(out.html || '');
  }

  // Exports
  PR.recalcDirSize = recalcDirSize;
  PR.openPropsModal = openPropsModal;
  // compat for existing dispatchers
  AC.openPropsModal = openPropsModal;

})();
