import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager fileops jobs (ws/poll/watch/cancel) + Operations list modal
  // No ES modules / bundler: attach to the shared file manager namespace.ops

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.ops = FM.ops || {};
  const O = FM.ops;

  const C = FM.common || {};
  FM.api = FM.api || {};
  const A = FM.api;
  const P = FM.progress || {};
  const SEL = FM.selection || {};
  const E = FM.errors || {};

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qsa(sel, root) {
    try { if (C && typeof C.qsa === 'function') return C.qsa(sel, root); } catch (e) {}
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e2) { return []; }
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    try { if (modal) modal.classList.add('hidden'); } catch (e2) {}
  }

  function storageGet(key) {
    try { if (C && typeof C.storageGet === 'function') return C.storageGet(key); } catch (e) {}
    try { return window.localStorage ? window.localStorage.getItem(String(key)) : null; } catch (e2) { return null; }
  }

  function storageSet(key, val) {
    try { if (C && typeof C.storageSet === 'function') return C.storageSet(key, val); } catch (e) {}
    try { if (window.localStorage) window.localStorage.setItem(String(key), String(val)); } catch (e2) {}
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function _errFromResponse(res, data, ctx) {
    try { if (E && typeof E.fromResponse === 'function') return E.fromResponse(res, data, ctx); } catch (e) {}
    try { if (A && typeof A.errorFromResponse === 'function') return A.errorFromResponse(res, data, ctx); } catch (e) {}
    const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : 'request_failed';
    return new Error(msg);
  }

  function presentError(err, opts) {
    try { if (E && typeof E.present === 'function') return E.present(err, Object.assign({ place: 'toast', action: 'ops' }, opts || {})); } catch (e) {}
    const m = (err && (err.message || err.toString)) ? String(err.message || err) : 'Ошибка';
    toast(m, 'error');
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

  function _trimSlashes(p) {
    try { if (C && typeof C._trimSlashes === 'function') return C._trimSlashes(p); } catch (e) {}
    return String(p || '').replace(/\/+$/, '') || '/';
  }

  function otherSide(side) {
    try { if (FM.state && typeof FM.state.otherSide === 'function') return FM.state.otherSide(side); } catch (e) {}
    return side === 'left' ? 'right' : 'left';
  }

  function getSelectionNames(side) {
    try { if (SEL && typeof SEL.getSelectionNames === 'function') return SEL.getSelectionNames(side); } catch (e) {}
    return [];
  }

  async function fetchJson(url, init) {
    if (A && typeof A.fetchJson === 'function') return await A.fetchJson(url, init);
    throw new Error('FM.api.fetchJson missing');
  }

  function updateProgressModal(job, opts) {
    try { if (P && typeof P.updateProgressModal === 'function') return P.updateProgressModal(job, opts || {}); } catch (e) {}
  }

  function _ensureProgressDetailsToggle() {
    try { if (P && typeof P.ensureDetailsToggle === 'function') return P.ensureDetailsToggle(); } catch (e) {}
  }

  function _setProgressDetailsAvailable(available) {
    try { if (P && typeof P.setDetailsAvailable === 'function') return P.setDetailsAvailable(available); } catch (e) {}
  }

  function _clearProgressAutoClose() {
    try { if (P && typeof P.clearAutoClose === 'function') return P.clearAutoClose(); } catch (e) {}
  }

  function _fmtWhenFromSec(tsSec) {
    try { if (P && typeof P.fmtWhenFromSec === 'function') return P.fmtWhenFromSec(tsSec); } catch (e) {}
    return '';
  }

  async function refreshAll() {
    try {
      if (FM.api && typeof FM.api.listPanel === 'function') {
        await Promise.all([
          FM.api.listPanel('left', { fromInput: false }),
          FM.api.listPanel('right', { fromInput: false }),
        ]);
      }
    } catch (e) {}
  }

  // -------------------------- fileops jobs --------------------------

  function buildCopyMovePayload(op, srcSide, dstSide, opts) {
    const S = _S();
    if (!S || !S.panels) return null;

    const src = S.panels[srcSide];
    const dst = S.panels[dstSide];
    if (!src || !dst) return null;

    const names = getSelectionNames(srcSide);
    const sources = names.map((n) => ({
      path: (src.target === 'remote') ? joinRemote(src.cwd, n) : joinLocal(src.cwd, n),
      name: n,
      is_dir: !!(src.items || []).find((it) => {
        if (safeName(it && it.name) !== n) return false;
        const t = String((it && it.type) || '');
        return t === 'dir' || (t === 'link' && !!(it && it.link_dir));
      }),
    }));

    return {
      op,
      src: {
        target: src.target,
        sid: src.target === 'remote' ? src.sid : undefined,
        cwd: src.cwd,
        paths: names,
      },
      dst: {
        target: dst.target,
        sid: dst.target === 'remote' ? dst.sid : undefined,
        path: dst.cwd,
        is_dir: true,
      },
      sources,
      options: Object.assign({ overwrite: 'ask' }, opts || {}),
    };
  }

  function buildDeletePayload(side, opts) {
    const S = _S();
    if (!S || !S.panels) return null;
    const p = S.panels[side];
    if (!p) return null;
    const names = getSelectionNames(side);
    return {
      op: 'delete',
      src: {
        target: p.target,
        sid: p.target === 'remote' ? p.sid : undefined,
        cwd: p.cwd,
        paths: names,
      },
      options: Object.assign({}, opts || {}),
    };
  }

  async function requestWsToken() {
    const { res, data } = await fetchJson('/api/fileops/ws-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 120 }),
    });
    if (!res || !res.ok || !data || !data.ok) return '';
    return String(data.token || '');
  }

  function closeJobWs() {
    const S = _S();
    if (!S || !S.ws) return;

    try {
      if (S.ws.socket) S.ws.socket.close();
    } catch (e) {}
    try { if (S.ws.pollTimer) clearInterval(S.ws.pollTimer); } catch (e) {}

    S.ws.pollTimer = null;
    S.ws.socket = null;
    S.ws.jobId = '';
    S.ws.token = '';
  }

  function _maybeTrashToast(job) {
    try {
      const S = _S();
      if (!S) return;
      if (!job) return;
      const op = String(job.op || '').toLowerCase();
      if (op !== 'delete') return;
      const pr = job.progress || {};
      const t = pr.trash || null;
      const notice = t && t.notice ? String(t.notice) : '';
      if (!notice) return;

      const now = Date.now();
      if (!S.trashUi) S.trashUi = { lastLevel: '', lastTsMs: 0, lastNotice: '' };
      if (S.trashUi.lastNotice === notice && (now - (S.trashUi.lastTsMs || 0)) < 60 * 1000) return;

      S.trashUi.lastNotice = notice;
      S.trashUi.lastTsMs = now;

      let level = 'info';
      try {
        const sum = t && t.summary ? t.summary : {};
        if ((sum.trash_full || 0) > 0 || (t.stats && t.stats.is_full)) level = 'error';
      } catch (e) {}

      toast(notice, level);
    } catch (e) {}
  }

  async function startJobPolling(jobId) {
    const S = _S();
    if (!S || !S.ws) return;
    if (!jobId) return;

    try { if (S.ws.pollTimer) clearInterval(S.ws.pollTimer); } catch (e) {}

    let busy = false;
    S.ws.pollTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const { res, data } = await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
        if (res && res.ok && data && data.ok && data.job) {
          const job = data.job;
          updateProgressModal(job);
          const st = String(job.state || '').toLowerCase();
          if (st === 'done' || st === 'error' || st === 'canceled') {
            try { clearInterval(S.ws.pollTimer); } catch (e2) {}
            S.ws.pollTimer = null;

            try {
              const op = String(job.op || '').toLowerCase();
              const label = (op === 'copy') ? 'Копирование'
                : (op === 'move' ? 'Перемещение'
                  : (op === 'delete' ? 'Удаление'
                    : (op === 'zip' ? 'Архивация'
                      : (op === 'unzip' ? 'Распаковка'
                        : (op === 'checksum' ? 'Checksum'
                          : (op === 'dirsize' ? 'Размер папки' : 'Операция'))))));
              if (st === 'done') toast(label + ': завершено', 'success');
              else if (st === 'canceled') toast(label + ': отменено', 'info');
              else if (st === 'error') toast(label + ': ошибка', 'error');
              try { _maybeTrashToast(job); } catch (e) {}
            } catch (e3) {}

            setTimeout(() => { refreshAll(); }, 300);
          }
        }
      } catch (e) {
        // ignore polling errors
      } finally {
        busy = false;
      }
    }, 500);
  }

  async function watchJob(jobId) {
    const S = _S();
    if (!S || !S.ws) return;

    closeJobWs();

    const token = await requestWsToken();
    if (!token) {
      toast('WebSocket недоступен — использую HTTP-пулинг', 'info');
      S.ws.jobId = jobId;
      startJobPolling(jobId);
      return;
    }

    const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/fileops?token=${encodeURIComponent(token)}&job_id=${encodeURIComponent(jobId)}`;

    S.ws.jobId = jobId;
    S.ws.token = token;

    let opened = false;
    let finished = false;
    let fallbackStarted = false;
    const startFallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      try { if (S.ws.socket) S.ws.socket.close(); } catch (e) {}
      S.ws.socket = null;
      startJobPolling(jobId);
    };

    const ws = new WebSocket(wsUrl);
    S.ws.socket = ws;

    const fallbackTimer = setTimeout(() => {
      try {
        if (!opened && ws.readyState !== WebSocket.OPEN) startFallback();
      } catch (e) {
        startFallback();
      }
    }, 700);

    ws.onopen = () => { opened = true; try { clearTimeout(fallbackTimer); } catch (e) {} };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || '{}'));
        if (msg && msg.job) {
          updateProgressModal(msg.job);
          if (msg.type === 'done') {
            finished = true;
            try {
              const job = msg.job || {};
              const op = String(job.op || '').toLowerCase();
              const st = String(job.state || '').toLowerCase();
              const label = (op === 'copy') ? 'Копирование' : (op === 'move' ? 'Перемещение' : (op === 'delete' ? 'Удаление' : 'Операция'));
              if (st === 'done') toast(label + ': завершено', 'success');
              else if (st === 'canceled') toast(label + ': отменено', 'info');
              else if (st === 'error') toast(label + ': ошибка', 'error');
              try { _maybeTrashToast(job); } catch (e) {}
            } catch (e) {}

            setTimeout(() => { refreshAll(); }, 300);
          }
        }
      } catch (e) {}
    };

    ws.onerror = () => {
      // keep quiet
    };

    ws.onclose = () => {
      try { clearTimeout(fallbackTimer); } catch (e) {}
      if (!finished) startFallback();
    };
  }

  async function cancelJob(jobId) {
    if (!jobId) return;
    await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  }

  function _deepClone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function renderConflicts(conflicts) {
    const box = el('fm-conflicts-list');
    if (!box) return;

    box.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'fm-conflicts-table';

    const head = document.createElement('div');
    head.className = 'fm-conflicts-row fm-conflicts-head';
    head.innerHTML = '<div>Источник</div><div>Назначение</div><div>Действие</div>';
    list.appendChild(head);

    (conflicts || []).forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'fm-conflicts-row';
      const src = safeName(c && (c.src_path || c.src_name) || '');
      const dst = safeName(c && c.dst_path || '');

      const sel = document.createElement('select');
      sel.className = 'terminal-input';
      sel.style.maxWidth = '120px';
      sel.innerHTML = '<option value="replace">replace</option><option value="skip">skip</option>';
      sel.value = 'replace';
      sel.dataset.idx = String(idx);

      row.appendChild((() => { const d = document.createElement('div'); d.textContent = src; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = dst; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.appendChild(sel); return d; })());
      list.appendChild(row);
    });

    box.appendChild(list);

    const def = el('fm-conflicts-default');
    if (def) {
      def.value = 'replace';
      def.onchange = () => {
        const v = String(def.value || 'replace');
        qsa('#fm-conflicts-list select', document).forEach((s) => {
          try { s.value = v; } catch (e) {}
        });
      };
    }
  }

  async function applyConflictsAndContinue() {
    const S = _S();
    if (!S) return;

    const errEl = el('fm-conflicts-error');
    if (errEl) errEl.textContent = '';

    const pending = S.pending;
    if (!pending || !pending.basePayload) {
      modalClose(el('fm-conflicts-modal'));
      return;
    }

    const decisions = {};
    const sels = qsa('#fm-conflicts-list select', document);
    sels.forEach((s) => {
      const idx = parseInt(String(s.dataset.idx || '0'), 10);
      const c = pending.conflicts && pending.conflicts[idx] ? pending.conflicts[idx] : null;
      if (!c) return;
      const act = String(s.value || '').trim();
      const k1 = safeName(c.dst_path || '');
      const k2 = safeName(c.src_path || '');
      if (k1) decisions[k1] = act;
      if (k2) decisions[k2] = act;
    });

    const payload = Object.assign({}, pending.basePayload);
    payload.options = Object.assign({}, pending.basePayload.options || {}, {
      overwrite: 'ask',
      decisions,
      default_action: String((el('fm-conflicts-default') && el('fm-conflicts-default').value) || 'replace'),
    });

    S.pending = null;
    modalClose(el('fm-conflicts-modal'));

    await executeJob(payload);
  }

  async function runCopyMoveWithPayload(op, basePayload) {
    const S = _S();
    if (!S) return;
    if (!basePayload) return;

    const dryPayload = _deepClone(basePayload);
    dryPayload.op = op;
    dryPayload.options = Object.assign({}, dryPayload.options || {}, { overwrite: 'ask', dry_run: true });

    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dryPayload),
    });

    if (res && res.ok && data && data.ok && data.dry_run) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      if (conflicts.length) {
        S.pending = { op, basePayload: _deepClone(basePayload), conflicts };
        try { S.pending.basePayload.options = Object.assign({}, S.pending.basePayload.options || {}, { overwrite: 'ask' }); } catch (e) {}
        renderConflicts(conflicts);
        modalOpen(el('fm-conflicts-modal'));
        return;
      }
      const execPayload = _deepClone(basePayload);
      execPayload.op = op;
      execPayload.options = Object.assign({}, execPayload.options || {}, { overwrite: 'replace' });
      try { delete execPayload.options.dry_run; } catch (e) {}
      await executeJob(execPayload);
      return;
    }

    if (res && res.status === 409 && data && data.error === 'conflicts') {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      S.pending = { op, basePayload: _deepClone(basePayload), conflicts };
      try { S.pending.basePayload.options = Object.assign({}, S.pending.basePayload.options || {}, { overwrite: 'ask' }); } catch (e) {}
      renderConflicts(conflicts);
      modalOpen(el('fm-conflicts-modal'));
      return;
    }

    const execPayload = _deepClone(basePayload);
    execPayload.op = op;
    execPayload.options = Object.assign({}, execPayload.options || {}, { overwrite: 'replace' });
    try { delete execPayload.options.dry_run; } catch (e) {}
    await executeJob(execPayload);
  }

  async function runCopyMove(op) {
    const S = _S();
    if (!S) return;

    const srcSide = S.activeSide;
    const dstSide = otherSide(srcSide);

    const src = S.panels[srcSide];
    const dst = S.panels[dstSide];

    if (!src || !dst) return;

    if (src.target === 'remote' && !src.sid) {
      toast('Источник: remote без сессии', 'info');
      return;
    }
    if (dst.target === 'remote' && !dst.sid) {
      toast('Назначение: remote без сессии', 'info');
      return;
    }

    const names = getSelectionNames(srcSide);
    if (!names.length) return;

    // If both panels point to the same folder, "copy" should mean "duplicate".
    try {
      const sameLocalDir = (src.target === 'local' && dst.target === 'local'
        && _trimSlashes(String(src.cwd || '')) === _trimSlashes(String(dst.cwd || '')));
      const sameRemoteDir = (src.target === 'remote' && dst.target === 'remote'
        && String(src.sid || '') === String(dst.sid || '')
        && normRemotePath(String(src.cwd || '')) === normRemotePath(String(dst.cwd || '')));

      if ((sameLocalDir || sameRemoteDir) && op === 'move') {
        toast('Источник и назначение совпадают (move — нечего делать)', 'info');
        return;
      }

      if ((sameLocalDir || sameRemoteDir) && op === 'copy') {
        if (names.length !== 1) {
          toast('Обе панели в одном каталоге: для копирования нескольких элементов выберите другой каталог назначения', 'info');
          return;
        }

        const srcName = names[0];
        const existing = new Set((src.items || []).map((it) => safeName(it && it.name)));
        const isDir = !!(src.items || []).find((it) => safeName(it && it.name) === srcName && String(it.type) === 'dir');

        const dot = (isDir ? -1 : String(srcName).lastIndexOf('.'));
        const stem = (dot > 0) ? String(srcName).slice(0, dot) : String(srcName);
        const ext = (dot > 0) ? String(srcName).slice(dot) : '';
        let newName = '';
        for (let i = 2; i < 10000; i++) {
          const cand = `${stem} (${i})${ext}`;
          if (!existing.has(cand)) { newName = cand; break; }
        }
        if (!newName) newName = `${stem} (copy)${ext}`;

        const payload = buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' });
        if (!payload) return;

        payload.dst = Object.assign({}, payload.dst || {}, {
          path: (dst.target === 'remote') ? joinRemote(dst.cwd, newName) : joinLocal(dst.cwd, newName),
          is_dir: false,
        });

        await runCopyMoveWithPayload('copy', payload);
        return;
      }
    } catch (e) {}

    const payload = buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask', dry_run: true });
    if (!payload) return;

    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res && res.ok && data && data.ok && data.dry_run) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      if (conflicts.length) {
        S.pending = {
          op,
          basePayload: buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' }),
          conflicts,
        };
        renderConflicts(conflicts);
        modalOpen(el('fm-conflicts-modal'));
        return;
      }
      await executeJob(buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'replace' }));
      return;
    }

    if (res && res.status === 409 && data && data.error === 'conflicts') {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      S.pending = {
        op,
        basePayload: buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' }),
        conflicts,
      };
      renderConflicts(conflicts);
      modalOpen(el('fm-conflicts-modal'));
      return;
    }

    presentError(_errFromResponse(res, data, { action: 'copy/move' }), { place: 'toast', action: 'copy/move' });
  }

  async function executeJob(payload) {
    if (!payload) return '';

    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res || !data) {
      presentError(_errFromResponse(res, data, { action: 'job' }), { place: 'toast', action: 'job' });
      return '';
    }

    if (!res.ok || !data.ok) {
      presentError(_errFromResponse(res, data, { action: 'job' }), { place: 'toast', action: 'job' });
      return '';
    }

    const jobId = String(data.job_id || '');
    if (!jobId) {
      presentError(new Error('job_id missing'), { place: 'toast', action: 'job' });
      return '';
    }

    _ensureProgressDetailsToggle();
    _setProgressDetailsAvailable(false);
    _clearProgressAutoClose();
    modalOpen(el('fm-progress-modal'));
    updateProgressModal(data.job || { op: payload.op, state: 'queued', progress: {} });

    await watchJob(jobId);
    return jobId;
  }

  async function runDelete() {
    const S = _S();
    if (!S) return;

    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;

    if (p.target === 'remote' && !p.sid) {
      toast('Удаление: remote без сессии', 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) return;

    const isTrash = (() => {
      try {
        if (FM.state && typeof FM.state.isTrashPanel === 'function') return !!FM.state.isTrashPanel(p);
      } catch (e) {}
      // fallback (best-effort)
      try {
        const cwd = String((p && p.cwd) || '').replace(/\/+$/, '');
        return !!p && String(p.target || 'local') === 'local' && (cwd === '/opt/var/trash' || cwd.startsWith('/opt/var/trash/'));
      } catch (e2) { return false; }
    })();

    const title = isTrash ? 'Удалить навсегда' : 'В корзину';
    const okText = isTrash ? 'Удалить' : 'В корзину';
    const msg = isTrash
      ? `Удалить навсегда (${names.length})?\n${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`
      : `Переместить в корзину (${names.length})?\n${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`;

    const ok = await (C && typeof C.confirm === 'function'
      ? C.confirm({ title, message: msg, okText, cancelText: 'Отмена', danger: true })
      : Promise.resolve(window.confirm('Delete?')));

    if (!ok) return;

    const payload = buildDeletePayload(side, {});
    await executeJob(payload);

    try { p.selected.clear(); } catch (e) {}
  }

  // -------------------------- ops list modal --------------------------

  function _opsHiddenStorageKey() {
    return 'xkeen_fm_ops_hidden_jobs_v1';
  }

  function _opsEnsureHidden() {
    const S = _S();
    if (!S) return new Set();

    if (S.opsUi && S.opsUi.hiddenIds && typeof S.opsUi.hiddenIds.has === 'function') return S.opsUi.hiddenIds;

    const set = new Set();
    try {
      const raw = storageGet(_opsHiddenStorageKey()) || '';
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((x) => { if (x) set.add(String(x)); });
      }
    } catch (e) {}

    if (!S.opsUi) S.opsUi = { filter: 'all', hiddenIds: set, lastJobs: [] };
    else S.opsUi.hiddenIds = set;

    return set;
  }

  function _opsSaveHidden() {
    try {
      const set = _opsEnsureHidden();
      storageSet(_opsHiddenStorageKey(), JSON.stringify(Array.from(set).slice(0, 500)));
    } catch (e) {}
  }

  function _opsIsHidden(jobId) {
    try { return _opsEnsureHidden().has(String(jobId || '')); } catch (e) { return false; }
  }

  function _opsHideMany(jobIds) {
    const set = _opsEnsureHidden();
    let n = 0;
    (jobIds || []).forEach((jid) => {
      const k = String(jid || '');
      if (k && !set.has(k)) { set.add(k); n += 1; }
    });
    if (n) _opsSaveHidden();
    return n;
  }

  function _opsApplyUiFilter(jobs) {
    const S = _S();
    const filter = String((S && S.opsUi && S.opsUi.filter) || 'all');
    const out = [];

    (jobs || []).forEach((j) => {
      const jid = String(j && (j.job_id || '') || '');
      if (!jid) return;
      if (_opsIsHidden(jid)) return;

      const st = String(j && (j.state || '') || '').toLowerCase();
      const isActive = (st === 'running' || st === 'queued');
      const isErr = (st === 'error');
      const isFinished = (st === 'done' || st === 'canceled');

      if (filter === 'active' && !isActive) return;
      if (filter === 'errors' && !isErr) return;
      if (filter === 'finished' && !isFinished) return;
      out.push(j);
    });

    return out;
  }

  async function clearOpsHistory(scope) {
    scope = String(scope || 'history');
    try {
      const { res, data } = await fetchJson('/api/fileops/jobs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      if (res && res.ok && data && data.ok) {
        const n = Number(data.deleted || 0);
        toast(n ? `История очищена: ${n}` : 'История очищена', 'success');
        await refreshOpsList();
        return true;
      }
    } catch (e) {}
        presentError(new Error('clear_ops_history_failed'), { place: 'toast', action: 'ops_history' });
return false;
  }

  function renderOpsList(jobs) {
    const S = _S();
    if (!S) return;

    const box = el('fm-ops-list');
    if (!box) return;

    box.innerHTML = '';

    try { S.opsUi.lastJobs = Array.from(jobs || []); } catch (e) { if (S.opsUi) S.opsUi.lastJobs = jobs || []; }

    const total = (jobs || []).length;
    const hiddenCount = (() => {
      try {
        const set = _opsEnsureHidden();
        let n = 0;
        (jobs || []).forEach((j) => {
          const jid = String(j && (j.job_id || '') || '');
          if (jid && set.has(jid)) n += 1;
        });
        return n;
      } catch (e) { return 0; }
    })();

    const filtered = _opsApplyUiFilter(jobs || []);

    const summary = el('fm-ops-summary');
    if (summary) {
      const shown = filtered.length;
      summary.textContent = hiddenCount
        ? `Показано: ${shown} из ${total}. Скрыто: ${hiddenCount}.`
        : `Показано: ${shown} из ${total}.`;
    }

    const list = document.createElement('div');
    list.className = 'fm-ops-table';

    const head = document.createElement('div');
    head.className = 'fm-ops-row fm-ops-head';
    head.innerHTML = '<div>Job</div><div>Операция</div><div>Статус</div><div>Когда</div><div>Прогресс</div><div></div>';
    list.appendChild(head);

    (filtered || []).forEach((j) => {
      const row = document.createElement('div');
      row.className = 'fm-ops-row';

      const jobId = safeName(j && j.job_id || '');
      const op = safeName(j && j.op || '');
      const st = safeName(j && j.state || '');
      const whenTs = Number(j && (j.started_ts || j.created_ts) || 0);
      const whenText = whenTs ? _fmtWhenFromSec(whenTs) : '';
      const pr = j && j.progress ? j.progress : {};
      const filesDone = Number(pr && pr.files_done || 0);
      const filesTotal = Number(pr && pr.files_total || 0);
      const bytesDone = Number(pr && pr.bytes_done || 0);
      const bytesTotal = Number(pr && pr.bytes_total || 0);
      const pct = (bytesTotal > 0) ? Math.round((bytesDone / bytesTotal) * 100) : (filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0);
      const progText = `${pct}%`;

      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '8px';
      btns.style.justifyContent = 'flex-end';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-secondary';
      openBtn.textContent = 'Открыть';
      openBtn.onclick = async () => {
        modalClose(el('fm-ops-modal'));
        modalOpen(el('fm-progress-modal'));

        const stLower = String(j && j.state || '').toLowerCase();
        const finished = (stLower === 'done' || stLower === 'error' || stLower === 'canceled');

        if (finished) {
          try { closeJobWs(); } catch (e) {}
          try { _clearProgressAutoClose(); } catch (e) {}

          let snapshot = j;
          try {
            const { res, data } = await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
            if (res && res.ok && data && data.ok && data.job) snapshot = data.job;
          } catch (e) {}

          updateProgressModal(snapshot, { viewOnly: true });
          return;
        }

        updateProgressModal(j);
        await watchJob(jobId);
      };
      btns.appendChild(openBtn);

      if (st === 'running' || st === 'queued') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.textContent = 'Отменить';
        cancelBtn.onclick = () => cancelJob(jobId);
        btns.appendChild(cancelBtn);
      }

      row.appendChild((() => { const d = document.createElement('div'); d.textContent = jobId.slice(0, 8) + (jobId.length > 8 ? '…' : ''); d.title = jobId; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = op; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = st; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = whenText; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = progText; return d; })());
      row.appendChild(btns);

      list.appendChild(row);
    });

    box.appendChild(list);
  }

  async function refreshOpsList() {
    const { res, data } = await fetchJson('/api/fileops/jobs?limit=30', { method: 'GET' });
    if (res && res.ok && data && data.ok) {
      renderOpsList(data.jobs || []);
    }
  }



  // -------------------------- local ops (download/restore/trash) --------------------------

  function getSelectionNames(side) {
    try { if (SEL && typeof SEL.getSelectionNames === 'function') return SEL.getSelectionNames(side) || []; } catch (e) {}
    try {
      const S = _S();
      const p = (S && S.panels) ? S.panels[side] : null;
      return p ? Array.from(p.selected || []) : [];
    } catch (e2) {
      return [];
    }
  }

  function otherSide(side) {
    try {
      if (FM.state && typeof FM.state.otherSide === 'function') return FM.state.otherSide(side);
    } catch (e) {}
    return (side === 'left') ? 'right' : 'left';
  }

  function isTrashPanel(panel) {
    try { if (FM.bookmarks && typeof FM.bookmarks.isTrashPanel === 'function') return !!FM.bookmarks.isTrashPanel(panel); } catch (e) {}
    return false;
  }

  function getTrashRoot() {
    try { if (FM.bookmarks && typeof FM.bookmarks.getTrashRoot === 'function') return String(FM.bookmarks.getTrashRoot() || ''); } catch (e) {}
    return '/opt/var/trash';
  }

  function xhrDownloadFile(args) {
    try { if (A && typeof A.xhrDownloadFile === 'function') return A.xhrDownloadFile(args || {}); } catch (e) {}
    return null;
  }

  // -------------------------- multi-download (queue vs zip) --------------------------

  const DL_MULTI_MODE_KEY = 'xkeen.fm.download.multi_mode_v1'; // 'zip'|'queue'
  let _dlMultiBound = false;
  let _dlMultiResolver = null;
  let _dlMultiEscHandler = null;

  function _dlMultiUi() {
    const modal = el('fm-download-multi-modal');
    const desc = el('fm-download-multi-desc');
    const zipRadio = el('fm-download-multi-mode-zip');
    const queueRadio = el('fm-download-multi-mode-queue');
    const queueHint = el('fm-download-multi-queue-hint');
    const remember = el('fm-download-multi-remember');
    const okBtn = el('fm-download-multi-ok-btn');
    const cancelBtn = el('fm-download-multi-cancel-btn');
    const closeBtn = el('fm-download-multi-close-btn');
    if (!modal || !desc || !zipRadio || !queueRadio || !remember || !okBtn || !cancelBtn || !closeBtn) return null;

    function closeWith(value) {
      try { modalClose(modal); } catch (e) {}
      if (_dlMultiEscHandler) {
        try { document.removeEventListener('keydown', _dlMultiEscHandler); } catch (e2) {}
        _dlMultiEscHandler = null;
      }
      const r = _dlMultiResolver;
      _dlMultiResolver = null;
      if (typeof r === 'function') {
        try { r(value); } catch (e3) {}
      }
    }

    if (!_dlMultiBound) {
      _dlMultiBound = true;
      okBtn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        const mode = (queueRadio.checked ? 'queue' : 'zip');
        const rem = !!remember.checked;
        closeWith({ ok: true, mode, remember: rem });
      });
      cancelBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeWith({ ok: false }); });
      closeBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeWith({ ok: false }); });
      modal.addEventListener('click', (e) => {
        if (e && e.target === modal) closeWith({ ok: false });
      });
    }

    return { modal, desc, zipRadio, queueRadio, queueHint, remember, okBtn, cancelBtn, closeBtn, closeWith };
  }

  function _loadDlMultiModePref() {
    const raw = storageGet(DL_MULTI_MODE_KEY);
    const v = String(raw || '').trim();
    return (v === 'queue' || v === 'zip') ? v : '';
  }

  function _saveDlMultiModePref(mode) {
    if (mode !== 'zip' && mode !== 'queue') return;
    storageSet(DL_MULTI_MODE_KEY, mode);
  }

  function _promptDlMultiMode({ count, queueAllowed, defaultMode }) {
    const ui = _dlMultiUi();
    if (!ui) return Promise.resolve({ ok: true, mode: (defaultMode === 'queue' ? 'queue' : 'zip'), remember: false, noUi: true });

    // Configure text
    const c = Number(count || 0);
    ui.desc.textContent = `Выбрано: ${c} элемент(ов). Как скачать?`;

    // Enable/disable queue option
    ui.queueRadio.disabled = !queueAllowed;
    try {
      ui.queueHint.textContent = queueAllowed
        ? 'Браузер может запросить разрешение на несколько загрузок.'
        : 'Недоступно: в выделении есть папки (их нужно архивировать).';
      ui.queueHint.style.opacity = queueAllowed ? '.8' : '.75';
    } catch (e) {}

    const mode = (defaultMode === 'queue' && queueAllowed) ? 'queue' : 'zip';
    ui.zipRadio.checked = (mode === 'zip');
    ui.queueRadio.checked = (mode === 'queue');
    ui.remember.checked = false;

    // ESC closes.
    _dlMultiEscHandler = (e) => {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) {
        ui.closeWith({ ok: false });
      }
    };
    try { document.addEventListener('keydown', _dlMultiEscHandler); } catch (e) {}

    modalOpen(ui.modal);
    return new Promise((resolve) => { _dlMultiResolver = resolve; });
  }

  async function _downloadQueue(p, files) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return;
    try { toast('Скачивание по очереди… если браузер блокирует несколько загрузок — разрешите их для панели.', 'info'); } catch (e) {}

    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const fullPath = String(f && f.path || '');
      const name = safeName(f && f.name || 'download');
      if (!fullPath) continue;

      const url = (p.target === 'remote')
        ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
        : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;

      const label = `Download ${i + 1}/${list.length}`;
      const r = await xhrDownloadFile({ url, filenameHint: name, titleLabel: label });
      if (!r || !r.ok) {
        if (r && r.cancelled) {
          toast('Очередь скачивания остановлена', 'info');
        } else {
          toast('Очередь скачивания остановлена из-за ошибки', 'error');
        }
        break;
      }
    }
  }

  O.downloadSelection = O.downloadSelection || async function downloadSelection(side) {
    const S = _S();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;

    if (p.target === 'remote' && !p.sid) {
      toast('Download: remote без сессии', 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) return;

    // Multiple selection -> choose ZIP (old) or queue-download (new).
    if (names.length > 1) {
      const items = [];
      const files = [];
      let hasDirs = false;

      for (const nm of names) {
        const it = (p.items || []).find(x => safeName(x && x.name) === safeName(nm));
        if (!it) continue;
        const type = String((it && it.type) || '');
        const linkDir = !!(it && it.link_dir);
        const isDir = (type === 'dir') || (type === 'link' && linkDir);
        const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
        items.push({ path: fullPath, name: safeName(it.name), is_dir: !!isDir });
        if (isDir) hasDirs = true;
        else files.push({ path: fullPath, name: safeName(it.name) });
      }
      if (!items.length) return;

      const queueAllowed = !hasDirs && files.length === items.length;
      const saved = _loadDlMultiModePref();

      let mode = '';
      if (saved) {
        mode = (saved === 'queue' && queueAllowed) ? 'queue' : 'zip';
      } else if (queueAllowed) {
        const ans = await _promptDlMultiMode({ count: items.length, queueAllowed, defaultMode: 'zip' });
        if (!ans || !ans.ok) return;
        mode = (ans.mode === 'queue') ? 'queue' : 'zip';
        if (ans.remember) _saveDlMultiModePref(mode);
      } else {
        // With folders we keep the old behavior (ZIP) without extra clicks.
        mode = 'zip';
      }

      if (mode === 'queue' && queueAllowed) {
        await _downloadQueue(p, files);
        return;
      }

      try { toast('ZIP создаётся во временной папке /tmp и может занять много места', 'info'); } catch (e) {}

      // Name archive based on current directory (nice UX), fallback to "selection".
      const cwd = String(p.cwd || '').trim();
      const base = (() => {
        if (p.target === 'remote') {
          const c = normRemotePath(cwd);
          if (!c || c == '.' || c === '/') return 'selection';
          const parts = c.split('/').filter(Boolean);
          return parts.length ? parts[parts.length - 1] : 'selection';
        }
        const c = cwd.replace(/\/+$/, '');
        if (!c || c === '/') return 'selection';
        const idx = c.lastIndexOf('/');
        return (idx >= 0) ? (c.slice(idx + 1) || 'selection') : (c || 'selection');
      })();

      const zipName = `${base}_selection.zip`;
      const rootName = zipName.replace(/\.zip$/i, '') || 'selection';

      const url = (p.target === 'remote')
        ? `/api/fs/archive?target=remote&sid=${encodeURIComponent(p.sid)}`
        : `/api/fs/archive?target=local`;

      xhrDownloadFile({
        url,
        method: 'POST',
        body: { items, zip_name: zipName, root_name: rootName },
        filenameHint: zipName,
        titleLabel: 'ZIP',
      });
      return;
    }

    // Single selection: directory -> ZIP, file -> direct download.
    const name = names[0];
    const it = (p.items || []).find(x => safeName(x && x.name) === safeName(name));
    if (!it) return;
    const type = String((it && it.type) || '');
    const linkDir = !!(it && it.link_dir);
    const isDir = (type === 'dir') || (type === 'link' && linkDir);

    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);

    // Directory: download as ZIP archive
    if (isDir) {
      try { toast('ZIP создаётся во временной папке /tmp и может занять много места', 'info'); } catch (e) {}
      const url = (p.target === 'remote')
        ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}&archive=zip`
        : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}&archive=zip`;
      xhrDownloadFile({ url, filenameHint: safeName(it.name) + '.zip', titleLabel: 'ZIP' });
      return;
    }

    const url = (p.target === 'remote')
      ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
      : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;

    xhrDownloadFile({ url, filenameHint: safeName(it.name), titleLabel: 'Download' });
  };

  O.runRestore = O.runRestore || async function runRestore() {
    const S = _S();
    const side = (S && S.activeSide) ? S.activeSide : 'left';
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return;

    if (String(p.target || 'local') !== 'local') {
      toast('Восстановление работает только для local (корзина)', 'info');
      return;
    }

    if (!isTrashPanel(p)) {
      toast(`Восстановление доступно только из ${getTrashRoot()}`, 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) return;

    const ok = await (C && typeof C.confirm === 'function'
      ? C.confirm({
        title: 'Восстановить',
        message: `Восстановить (${names.length})?\n${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`,
        okText: 'Восстановить',
        cancelText: 'Отмена',
      })
      : Promise.resolve(window.confirm('Restore?')));

    if (!ok) return;

    const paths = names.map((nm) => joinLocal(p.cwd, nm));
    try {
      const { res, data } = await (A && typeof A.fetchJson === 'function'
        ? A.fetchJson('/api/fs/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'local', paths }),
        })
        : fetch('/api/fs/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'local', paths }),
        }).then(async (res) => ({ res, data: await res.json().catch(() => null) })));

      if (!res || !res.ok || !data || !data.ok) {
        presentError(_errFromResponse(res, data, { action: 'restore' }), { place: 'toast', action: 'restore' });
        return;
      }

      const nOk = Array.isArray(data.restored) ? data.restored.length : 0;
      const nErr = Array.isArray(data.errors) ? data.errors.length : 0;
      if (nOk) toast(`Восстановлено: ${nOk}${nErr ? `, ошибок: ${nErr}` : ''}`, nErr ? 'info' : 'success');
      else toast(nErr ? `Не восстановлено, ошибок: ${nErr}` : 'Нечего восстанавливать', nErr ? 'error' : 'info');

      // Refresh current trash view (items should disappear from here)
      try {
        if (FM.listing && typeof FM.listing.listPanel === 'function') {
          await FM.listing.listPanel(side, { fromInput: false });
        } else if (A && typeof A.listPanel === 'function') {
          await A.listPanel(side, { fromInput: false });
        }
      } catch (e) {}

      // Optimistic UI: clear selection
      try { p.selected && p.selected.clear && p.selected.clear(); } catch (e) {}
    } catch (e) {
      presentError(e, { place: 'toast', action: 'restore' });
    }
  };

  O.runClearTrash = O.runClearTrash || async function runClearTrash(side) {
    const S = _S();
    const s = (side === 'left' || side === 'right') ? side : ((S && S.activeSide) ? S.activeSide : 'left');
    const p = S && S.panels ? S.panels[s] : null;
    if (!p) return;

    if (String(p.target || 'local') !== 'local') {
      toast('Очистка корзины работает только для local', 'info');
      return;
    }

    if (!isTrashPanel(p)) {
      toast(`Очистка корзины доступна только из ${getTrashRoot()}`, 'info');
      return;
    }

    const ok = await (C && typeof C.confirm === 'function'
      ? C.confirm({
        title: 'Очистить корзину',
        message: 'Удалить ВСЕ содержимое корзины без возможности восстановления?',
        okText: 'Очистить',
        cancelText: 'Отмена',
        danger: true,
      })
      : Promise.resolve(window.confirm('Clear trash?')));

    if (!ok) return;

    try {
      const { res, data } = await (A && typeof A.fetchJson === 'function'
        ? A.fetchJson('/api/fs/trash/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'local' }),
        })
        : fetch('/api/fs/trash/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'local' }),
        }).then(async (res) => ({ res, data: await res.json().catch(() => null) })));

      if (!res || !res.ok || !data || !data.ok) {
        presentError(_errFromResponse(res, data, { action: 'clear_trash' }), { place: 'toast', action: 'clear_trash' });
        return;
      }

      const n = Number(data.deleted || 0);
      toast(n ? `Корзина очищена: ${n}` : 'Корзина очищена', 'success');

      // Refresh trash view(s)
      try {
        if (FM.listing && typeof FM.listing.listPanel === 'function') {
          await FM.listing.listPanel(s, { fromInput: false });
        } else if (A && typeof A.listPanel === 'function') {
          await A.listPanel(s, { fromInput: false });
        }
      } catch (e) {}

      try { p.selected && p.selected.clear && p.selected.clear(); } catch (e) {}

      // If other panel also shows trash - refresh it too
      try {
        const o = otherSide(s);
        const po = S && S.panels ? S.panels[o] : null;
        if (po && isTrashPanel(po)) {
          if (FM.listing && typeof FM.listing.listPanel === 'function') {
            await FM.listing.listPanel(o, { fromInput: false });
          } else if (A && typeof A.listPanel === 'function') {
            await A.listPanel(o, { fromInput: false });
          }
        }
      } catch (e) {}
    } catch (e) {
      presentError(e, { place: 'toast', action: 'clear_trash' });
    }
  };
  // exports
  O.buildCopyMovePayload = buildCopyMovePayload;
  O.buildDeletePayload = buildDeletePayload;
  O.requestWsToken = requestWsToken;
  O.closeJobWs = closeJobWs;
  O.watchJob = watchJob;
  O.cancelJob = cancelJob;
  O.executeJob = executeJob;
  O.runCopyMove = runCopyMove;
  O.runCopyMoveWithPayload = runCopyMoveWithPayload;
  O.renderConflicts = renderConflicts;
  O.applyConflictsAndContinue = applyConflictsAndContinue;
  O.runDelete = runDelete;

  O.renderOpsList = renderOpsList;
  O.refreshOpsList = refreshOpsList;
  O.clearOpsHistory = clearOpsHistory;
  O.hideMany = _opsHideMany;
})();
