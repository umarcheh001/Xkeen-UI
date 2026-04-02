import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager: Checksum modal (md5/sha256)
  // No ES modules / bundler: attach to the shared file manager namespace.hash
  //
  // Exports:
  //   FM.hash.openHashModal(side)
  //   FM.actions.openHashModal(side)  (compat)

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.hash = FM.hash || {};
  const H = FM.hash;

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

  function getSelectionNames(side) {
    try { if (SEL && typeof SEL.getSelectionNames === 'function') return SEL.getSelectionNames(side); } catch (e) {}
    return [];
  }

  async function fetchJson(url, init) {
    if (A && typeof A.fetchJson === 'function') return await A.fetchJson(url, init);
    throw new Error('FM.api.fetchJson missing');
  }

  // -------------------------- checksum modal (md5/sha256) --------------------------
  let hashReqId = 0;

  async function _pollChecksumJob(jobId, reqId, ui) {
    const { errEl, md5El, shaEl, sizeEl } = ui || {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    while (true) {
      if (reqId !== hashReqId) return;
      if (!jobId) return;
      if ((Date.now() - started) > 10 * 60 * 1000) { // 10 min
        try { if (errEl) errEl.textContent = 'Timeout ожидания job.'; } catch (e) {}
        return;
      }
      try {
        const { res, data } = await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
        if (reqId !== hashReqId) return;
        if (!res || !res.ok || !data || !data.ok || !data.job) {
          await sleep(500);
          continue;
        }
        const job = data.job;
        const st = String(job.state || '').toLowerCase();
        if (st === 'done') {
          const pr = job.progress || {};
          const r = pr.result || pr.checksum || null;
          if (r) {
            try { md5El.value = String(r.md5 || ''); } catch (e) {}
            try { shaEl.value = String(r.sha256 || ''); } catch (e) {}
            try {
              const sz = Number(r.size);
              sizeEl.value = isFinite(sz) && sz >= 0 ? `${fmtSize(sz)} (${sz} B)` : '';
            } catch (e) { try { sizeEl.value = ''; } catch (e2) {} }
            try { if (errEl) errEl.textContent = ''; } catch (e) {}
          } else {
            try { if (errEl) errEl.textContent = 'Checksum готов, но результат отсутствует.'; } catch (e) {}
          }
          return;
        }
        if (st === 'error') {
          try { if (errEl) errEl.textContent = String(job.error || 'checksum_failed'); } catch (e) {}
          try { md5El.value = ''; shaEl.value = ''; sizeEl.value = ''; } catch (e2) {}
          return;
        }
        if (st === 'canceled') {
          try { if (errEl) errEl.textContent = 'Отменено.'; } catch (e) {}
          try { md5El.value = ''; shaEl.value = ''; sizeEl.value = ''; } catch (e2) {}
          return;
        }
      } catch (e) {
        // ignore and retry
      }
      await sleep(400);
    }
  }

  async function openHashModal(side) {
    const s = String(side || S.activeSide || 'left');
    const modal = el('fm-hash-modal');
    const metaEl = el('fm-hash-meta');
    const md5El = el('fm-hash-md5');
    const shaEl = el('fm-hash-sha256');
    const sizeEl = el('fm-hash-size');
    const errEl = el('fm-hash-error');

    if (!modal || !metaEl || !md5El || !shaEl || !sizeEl) {
      toast('FM: модалка "Checksum" не найдена', 'error');
      return;
    }

    const p = (S && S.panels) ? S.panels[s] : null;
    if (!p) return;

    const names = getSelectionNames(s);
    if (!names.length) {
      toast('Выберите файл', 'info');
      return;
    }
    if (names.length > 1) {
      toast('Выберите один файл', 'info');
      return;
    }

    const name = safeName(names[0]);
    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, name) : joinLocal(p.cwd, name);

    const reqId = ++hashReqId;

    // Reset UI and open early.
    try { if (errEl) errEl.textContent = ''; } catch (e) {}
    metaEl.textContent = `${p.target === 'remote' ? 'remote' : 'local'} • ${fullPath}`;
    md5El.value = '...';
    shaEl.value = '...';
    sizeEl.value = '...';
    modalOpen(modal);

    const qs = new URLSearchParams();
    qs.set('target', String(p.target || 'local'));
    qs.set('path', String(fullPath || ''));
    if (p.target === 'remote') qs.set('sid', String(p.sid || ''));

    // Queue checksum as a fileops job (FM-20)
    let jobId = '';
    try {
      if (FM.ops && typeof FM.ops.executeJob === 'function') {
        const payload = { op: 'checksum', src: { target: String(p.target || 'local'), path: String(fullPath || ''), sid: (p.target === 'remote' ? String(p.sid || '') : undefined) } };
        jobId = await FM.ops.executeJob(payload);
      }
    } catch (e) { jobId = ''; }

    if (reqId !== hashReqId) return;
    if (!jobId) {
      if (errEl) errEl.textContent = 'Не удалось запустить job checksum.';
      md5El.value = '';
      shaEl.value = '';
      sizeEl.value = '';
      return;
    }

    // Poll final result to fill the modal.
    _pollChecksumJob(jobId, reqId, { errEl, md5El, shaEl, sizeEl });
  }

  // Exports
  H.openHashModal = openHashModal;
  // compat for existing dispatchers
  AC.openHashModal = openHashModal;

})();