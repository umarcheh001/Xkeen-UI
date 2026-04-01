import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager XHR transfers (download/upload with progress) + upload conflicts modal
  // No ES modules / bundler: attach to the shared file manager namespace.transfers

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.transfers = FM.transfers || {};
  const T = FM.transfers;

  const C = FM.common || {};
  FM.api = FM.api || {};
  const A = FM.api;
  const P = FM.progress || {};
  const E = FM.errors || {};

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    try { if (modal) modal.classList.add('hidden'); } catch (e2) {}
  }

  function fmtSize(bytes) {
    try { if (C && typeof C.fmtSize === 'function') return C.fmtSize(bytes); } catch (e) {}
    // fallback
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
    // minimal fallback
    const c0 = String(cwd || '').trim() || '.';
    const n0 = String(name || '').trim();
    if (!n0) return c0;
    if (n0.startsWith('/')) return n0.replace(/\/+$|\s+$/g, '') || '/';
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

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function presentProgressError(err, ctx) {
    try {
      if (E && typeof E.present === 'function') {
        return E.present(err, Object.assign({ place: 'progress', toast: false, action: 'transfer' }, ctx || {}));
      }
    } catch (e) {}
  }

  function nowMs() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function parseContentDispositionFilename(headerVal) {
    const v = String(headerVal || '');
    if (!v) return '';
    // RFC5987: filename*=UTF-8''...
    const m5987 = v.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
    if (m5987 && m5987[2]) {
      try { return decodeURIComponent(m5987[2].trim().replace(/^"|"$/g, '')); } catch (e) {}
    }
    const m = v.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (m && m[1]) return String(m[1]).trim();
    return '';
  }

  function resetTransferState() {
    const S = _S();
    if (!S || !S.transfer) return;
    S.transfer.xhr = null;
    S.transfer.kind = '';
    S.transfer.startedAtMs = 0;
    S.transfer.lastAtMs = 0;
    S.transfer.lastLoaded = 0;
    S.transfer.speed = 0;
  }

  function transferSpeedBytesPerSec(loaded) {
    const S = _S();
    if (!S || !S.transfer) return 0;

    const now = nowMs();
    if (!S.transfer.startedAtMs) {
      S.transfer.startedAtMs = now;
      S.transfer.lastAtMs = now;
      S.transfer.lastLoaded = Number(loaded || 0);
      S.transfer.speed = 0;
      return 0;
    }

    const dt = Math.max(1, now - (S.transfer.lastAtMs || now));
    const db = Math.max(0, Number(loaded || 0) - Number(S.transfer.lastLoaded || 0));
    const inst = (db * 1000) / dt;

    // EWMA smoothing
    const prev = Number(S.transfer.speed || 0);
    const next = prev ? (prev * 0.75 + inst * 0.25) : inst;
    S.transfer.speed = next;
    S.transfer.lastAtMs = now;
    S.transfer.lastLoaded = Number(loaded || 0);
    return next;
  }

  function fmtSpeed(bps) {
    const v = Number(bps || 0);
    if (!isFinite(v) || v <= 0) return '';
    return fmtSize(v) + '/s';
  }

  function fmtEta(seconds) {
    const s = Number(seconds || 0);
    if (!isFinite(s) || s <= 0) return '';
    const sec = Math.round(s);
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    if (m <= 0) return `${r}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h <= 0) return `${m}m ${r}s`;
    return `${h}h ${mm}m`;
  }

  function _progressEnsureDetails() {
    try { if (P && typeof P.ensureDetailsToggle === 'function') return P.ensureDetailsToggle(); } catch (e) {}
  }
  function _progressSetDetailsAvailable(on) {
    try { if (P && typeof P.setDetailsAvailable === 'function') return P.setDetailsAvailable(!!on); } catch (e) {}
  }
  function _progressClearAutoClose() {
    try { if (P && typeof P.clearAutoClose === 'function') return P.clearAutoClose(); } catch (e) {}
  }
  function _progressScheduleAutoClose(ms) {
    try { if (P && typeof P.scheduleAutoClose === 'function') return P.scheduleAutoClose(ms); } catch (e) {}
  }
  function _progressSetUi(ui) {
    try { if (P && typeof P.setUi === 'function') return P.setUi(ui || {}); } catch (e) {}
  }

  function openTransferModal(kindLabel, fileLabel) {
    _progressEnsureDetails();
    _progressSetDetailsAvailable(false);
    _progressClearAutoClose();

    // Reset action buttons (in case modal was opened in view-only mode by ops/jobs)
    try {
      const cbtn = el('fm-progress-cancel-btn');
      if (cbtn) cbtn.style.display = '';
      const okBtn = el('fm-progress-ok-btn');
      if (okBtn) okBtn.textContent = 'Скрыть';
    } catch (e) {}

    // Hide job metadata block for transfers.
    try {
      if (P && typeof P.ensureExtra === 'function') P.ensureExtra();
      const wrap = el('fm-progress-extra');
      const jid = el('fm-progress-jobid');
      const times = el('fm-progress-times');
      if (jid) jid.textContent = '';
      if (times) times.textContent = '';
      if (wrap) wrap.style.display = 'none';
    } catch (e) {}

    modalOpen(el('fm-progress-modal'));
    resetTransferState();

    _progressSetUi({
      titleText: `${kindLabel}${fileLabel ? (' — ' + fileLabel) : ''}`,
      pct: 0,
      metaText: '',
      errorText: '',
      detailsText: '',
    });
  }

  function bindProgressCancel(onCancel) {
    const cancelBtn = el('fm-progress-cancel-btn');
    if (!cancelBtn) return;
    cancelBtn.disabled = false;
    cancelBtn.onclick = (e) => {
      try { if (e && e.preventDefault) e.preventDefault(); } catch (e2) {}
      try { onCancel && onCancel(); } catch (e3) {}
    };
  }

  function finishTransferUi({ ok, message, detailsText, showDetails }) {
    _progressEnsureDetails();

    const cancelBtn = el('fm-progress-cancel-btn');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.onclick = null;
    }

    if (ok) {
      // On success we auto-close the modal (toast informs the user).
      _progressSetUi({ errorText: '' });
      _progressSetDetailsAvailable(false);
      _progressClearAutoClose();
      _progressScheduleAutoClose(650);
      return;
    }

    const wantDetails = (showDetails === undefined) ? true : !!showDetails;
    _progressSetDetailsAvailable(wantDetails);
    try {
      presentProgressError({
        code: 'transfer_failed',
        message: message || 'transfer_failed',
        details: (detailsText != null) ? String(detailsText) : '',
        retryable: true,
      }, { action: 'transfer' });
    } catch (e) {}
    if (detailsText != null) {
      _progressSetUi({ detailsText: String(detailsText) });
    }
    _progressSetUi({ errorText: message || 'transfer_failed' });
  }

  function _readXhrText(xhr) {
    return new Promise((resolve) => {
      try {
        const r = xhr && xhr.response;
        if (r && typeof Blob !== 'undefined' && r instanceof Blob) {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ''));
          fr.onerror = () => resolve('');
          try { fr.readAsText(r); } catch (e) { resolve(''); }
          return;
        }
      } catch (e) {}
      try { resolve(String((xhr && xhr.responseText) || '')); } catch (e2) { resolve(''); }
    });
  }

  function _addConfirmParam(u) {
    try {
      const U = new URL(String(u || ''), window.location.origin);
      U.searchParams.set('confirm', '1');
      return U.pathname + U.search;
    } catch (e) {
      // fallback for odd relative URLs
      if (String(u || '').indexOf('?') >= 0) return String(u) + '&confirm=1';
      return String(u) + '?confirm=1';
    }
  }

  async function _confirmDanger(msgText) {
    let ok = true;
    try {
      if (C && typeof C.confirm === 'function') {
        ok = await C.confirm({
          title: 'Подтверждение',
          message: String(msgText || ''),
          okText: 'Продолжить',
          cancelText: 'Отмена',
          danger: true,
        });
      } else {
        ok = window.confirm(String(msgText || 'Продолжить?'));
      }
    } catch (e) { ok = true; }
    return !!ok;
  }

  // -------------------------- download --------------------------
  // Returns a Promise<{ok:boolean, name?:string, cancelled?:boolean, status?:number, error?:string}>.
  // Backward-compatible: callers may ignore the returned promise.
  T.xhrDownloadFile = function xhrDownloadFile({ url, filenameHint, titleLabel, method, body, headers, _confirmRetry }) {
    let _done = null;
    const doneP = new Promise((resolve) => { _done = resolve; });

    function done(payload) {
      const r = _done;
      _done = null;
      if (typeof r === 'function') {
        try { r(payload || { ok: false }); } catch (e) {}
      }
    }

    openTransferModal(titleLabel || 'Download', filenameHint || '');

    const S = _S();
    const xhr = new XMLHttpRequest();
    if (S && S.transfer) {
      S.transfer.xhr = xhr;
      S.transfer.kind = 'download';
    }

    bindProgressCancel(() => {
      try { xhr.abort(); } catch (e) {}
      finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
      done({ ok: false, cancelled: true });
    });

    const m = String(method || 'GET').toUpperCase();
    xhr.open(m, url, true);
    xhr.responseType = 'blob';

    // Headers
    try {
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
          if (v == null) continue;
          xhr.setRequestHeader(String(k), String(v));
        }
      }
    } catch (e) {}

    // CSRF for POST/PUT/DELETE
    if (m !== 'GET' && m !== 'HEAD') {
      try {
        const tok = (A && typeof A.getCsrfToken === 'function') ? A.getCsrfToken() : '';
        if (tok) xhr.setRequestHeader('X-CSRF-Token', tok);
      } catch (e) {}
    }

    // Body normalize (object -> JSON)
    let sendBody = body;
    if (sendBody && typeof sendBody === 'object' && !(sendBody instanceof Blob) && !(sendBody instanceof ArrayBuffer)) {
      try {
        sendBody = JSON.stringify(sendBody);
        try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
      } catch (e) {}
    }

    xhr.onprogress = (ev) => {
      const loaded = Number(ev.loaded || 0);
      const total = Number(ev.total || 0);
      const speed = transferSpeedBytesPerSec(loaded);
      const pct = (ev.lengthComputable && total > 0) ? Math.round((loaded / total) * 100) : 0;
      const eta = (ev.lengthComputable && total > 0 && speed > 1) ? (total - loaded) / speed : 0;
      const metaParts = [];
      if (ev.lengthComputable && total > 0) metaParts.push(`${fmtSize(loaded)} / ${fmtSize(total)} (${pct}%)`);
      else metaParts.push(`${fmtSize(loaded)}`);
      const sp = fmtSpeed(speed);
      if (sp) metaParts.push(sp);
      const et = fmtEta(eta);
      if (et) metaParts.push('ETA ' + et);
      _progressSetUi({ pct, metaText: metaParts.join('   ') });
    };

    xhr.onerror = () => {
      finishTransferUi({ ok: false, message: 'Ошибка сети', detailsText: 'network_error', showDetails: true });
      done({ ok: false, error: 'network_error' });
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const cd = xhr.getResponseHeader('Content-Disposition');
        const name = parseContentDispositionFilename(cd) || filenameHint || 'download';
        try {
          const blob = xhr.response;
          const a = document.createElement('a');
          const u = URL.createObjectURL(blob);
          a.href = u;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            try { URL.revokeObjectURL(u); } catch (e) {}
            try { a.remove(); } catch (e2) {}
          }, 500);
        } catch (e) {}
        _progressSetUi({ pct: 100 });
        finishTransferUi({ ok: true });
        toast('Скачано: ' + name, 'success');
        done({ ok: true, name });
        return;
      }

      const raw = await _readXhrText(xhr);
      let j = null;
      try { j = JSON.parse(String(raw || '')); } catch (e) { j = null; }

      // Confirm-required flow (server-side size estimation is truncated/unknown).
      if (xhr.status === 409 && j && String(j.error || '') === 'confirm_required' && !_confirmRetry) {
        const msgText = String(j.message || 'Размер архива не удалось оценить точно. Продолжить?');
        const ok = await _confirmDanger(msgText);
        if (!ok) {
          finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
          done({ ok: false, cancelled: true });
          return;
        }

        // Retry same request with confirm=1
        try { modalClose(el('fm-progress-modal')); } catch (e) {}
        const newUrl = _addConfirmParam(url);
        try {
          const r = await T.xhrDownloadFile({ url: newUrl, filenameHint, titleLabel, method, body, headers, _confirmRetry: true });
          done(r);
        } catch (e) {
          done({ ok: false, error: 'retry_failed' });
        }
        return;
      }

      let msg = `HTTP ${xhr.status}`;
      if (j) {
        msg = String(j.message || j.error || msg);
        if (String(j.error || '') === 'zip_too_large' && j.estimated_bytes != null && j.max_bytes != null) {
          try { msg = `Архив слишком большой: ${fmtSize(Number(j.estimated_bytes))} > лимит ${fmtSize(Number(j.max_bytes))}`; } catch (e) {}
        } else if (String(j.error || '') === 'tmp_no_space' && j.free_bytes != null && j.required_bytes != null) {
          try { msg = `Недостаточно места в /tmp: нужно ${fmtSize(Number(j.required_bytes))}, доступно ${fmtSize(Number(j.free_bytes))}`; } catch (e) {}
        } else if (String(j.error || '') === 'tmp_limit_exceeded') {
          msg = String(j.message || 'Превышен лимит использования /tmp при создании архива');
        }
      }

      finishTransferUi({ ok: false, message: msg, detailsText: raw || '', showDetails: true });
      done({ ok: false, status: xhr.status, error: msg });
    };

    try {
      xhr.send(sendBody || null);
    } catch (e) {
      try { xhr.send(); } catch (e2) {}
      // If send still fails, resolve as error.
      setTimeout(() => {
        if (_done) {
          done({ ok: false, error: 'send_failed' });
        }
      }, 0);
    }

    return doneP;
  };

  // Keep backward-compatible API export.
  try { A.xhrDownloadFile = T.xhrDownloadFile; } catch (e) {}

  // -------------------------- upload conflicts (same-name) --------------------------
  // Upload refuses to overwrite by default (server returns 409 exists).
  // We resolve the conflict client-side via a small modal.
  let _uploadConflictBound = false;
  let _uploadConflictResolver = null;
  let _uploadConflictEscHandler = null;

  function ensureUploadConflictModal() {
    const modal = el('fm-upload-conflict-modal');
    const title = el('fm-upload-conflict-title');
    const message = el('fm-upload-conflict-message');
    const overwriteBtn = el('fm-upload-conflict-overwrite-btn');
    const renameBtn = el('fm-upload-conflict-rename-btn');
    const skipBtn = el('fm-upload-conflict-skip-btn');
    const closeBtn = el('fm-upload-conflict-close-btn');

    if (!modal || !title || !message || !overwriteBtn || !renameBtn || !skipBtn || !closeBtn) return null;

    function closeWith(choice) {
      try { modalClose(modal); } catch (e) {}
      if (_uploadConflictEscHandler) {
        try { document.removeEventListener('keydown', _uploadConflictEscHandler); } catch (e2) {}
        _uploadConflictEscHandler = null;
      }
      const r = _uploadConflictResolver;
      _uploadConflictResolver = null;
      if (typeof r === 'function') {
        try { r(String(choice || 'skip')); } catch (e3) {}
      }
    }

    if (!_uploadConflictBound) {
      _uploadConflictBound = true;

      overwriteBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeWith('overwrite'); });
      renameBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeWith('rename'); });
      skipBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeWith('skip'); });
      closeBtn.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeWith('skip'); });

      modal.addEventListener('click', (e) => {
        // Click on backdrop closes.
        if (e.target === modal) closeWith('skip');
      });
    }

    // ESC closes as skip.
    _uploadConflictEscHandler = (e) => {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) closeWith('skip');
    };

    return { modal, title, message, overwriteBtn, renameBtn, skipBtn };
  }

  function sanitizeUploadName(name) {
    let s = String(name || '').trim();
    if (!s) s = 'upload.bin';
    // Prevent path traversal / odd separators.
    s = s.replace(/[\\/]+/g, '_');
    s = s.replace(/\s+/g, ' ').trim();
    if (s === '.' || s === '..') s = 'upload.bin';
    if (!s) s = 'upload.bin';
    return s;
  }

  function splitNameExt(name) {
    const s = sanitizeUploadName(name);
    const lastDot = s.lastIndexOf('.');
    // Treat dotfiles like ".env" as "no extension".
    if (lastDot > 0 && lastDot < s.length - 1) {
      return { base: s.slice(0, lastDot), ext: s.slice(lastDot) };
    }
    return { base: s, ext: '' };
  }

  function buildRenameCandidates(name, maxN) {
    const { base, ext } = splitNameExt(name);
    const out = [];
    const nmax = Math.max(1, Math.min(200, Number(maxN || 40)));
    for (let i = 1; i <= nmax; i++) out.push(`${base} (${i})${ext}`);
    return out;
  }

  async function pickFirstFreeName(side, desiredName) {
    const S = _S();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return sanitizeUploadName(desiredName);

    const candidates = buildRenameCandidates(desiredName, 60);
    const fullPaths = candidates.map((nm) => (p.target === 'remote' ? joinRemote(p.cwd, nm) : joinLocal(p.cwd, nm)));

    // Try an accurate check via /api/fs/stat-batch (best effort).
    try {
      const payload = { target: p.target, paths: fullPaths };
      if (p.target === 'remote') payload.sid = p.sid;
      const { res, data } = await (A.fetchJson ? A.fetchJson('/api/fs/stat-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }) : Promise.resolve({ res: null, data: null }));

      if (res && res.ok && data && data.ok && Array.isArray(data.items) && data.items.length === fullPaths.length) {
        for (let i = 0; i < data.items.length; i++) {
          const it = data.items[i];
          if (!it || !it.exists) return candidates[i];
        }
      }
    } catch (e) {}

    // Fallback to current panel listing.
    try {
      const existing = new Set((p.items || []).map((it) => safeName(it && it.name)));
      for (const nm of candidates) {
        if (!existing.has(nm)) return nm;
      }
    } catch (e) {}

    return candidates[candidates.length - 1] || (sanitizeUploadName(desiredName) + ' (1)');
  }

  async function askUploadConflict({ name, cwd, target, existingType }) {
    const ui = ensureUploadConflictModal();
    const nm = sanitizeUploadName(name);

    const dir = (String(target || '').toLowerCase() === 'remote')
      ? (normRemotePath(cwd) || '.')
      : (String(cwd || '').trim() || '/');

    const kind = (existingType === 'dir') ? 'папка' : 'файл';

    if (!ui) {
      // Fallback: simple confirm => overwrite? Cancel => skip.
      const ok = window.confirm(`В папке ${dir} уже есть ${kind} «${nm}». Перезаписать?`);
      return ok ? 'overwrite' : 'skip';
    }

    // Close previous if any.
    if (typeof _uploadConflictResolver === 'function') {
      try { _uploadConflictResolver('skip'); } catch (e) {}
      _uploadConflictResolver = null;
    }

    ui.title.textContent = (existingType === 'dir') ? 'Папка уже существует' : 'Файл уже существует';
    ui.message.textContent = `В папке ${dir} уже есть ${kind} «${nm}». Что сделать с загружаемым файлом?`;
    try { ui.overwriteBtn.disabled = (existingType === 'dir'); } catch (e) {}

    modalOpen(ui.modal);
    try { document.addEventListener('keydown', _uploadConflictEscHandler); } catch (e) {}

    setTimeout(() => {
      try { ui.skipBtn.focus(); } catch (e) {}
    }, 0);

    return new Promise((resolve) => { _uploadConflictResolver = resolve; });
  }

  // -------------------------- upload --------------------------
  T.xhrUploadFiles = async function xhrUploadFiles({ side, files }) {
    const S = _S();
    const p = S && S.panels ? S.panels[side] : null;
    if (!p) return false;

    const list = Array.isArray(files) ? files : (files ? Array.from(files) : []);
    if (!list.length) return false;

    if (p.target === 'remote' && !p.sid) {
      toast('Upload: remote без сессии', 'info');
      return false;
    }

    // Upload sequentially for predictable UI.
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const originalName = sanitizeUploadName(file && file.name);
      if (!originalName) continue;

      const nameToType = new Map();
      try {
        (p.items || []).forEach((it) => {
          if (it && it.name) nameToType.set(safeName(it.name), String(it.type || 'file'));
        });
      } catch (e) {}

      const existingSet = new Set(Array.from(nameToType.keys()));

      let finalName = originalName;
      let overwrite = false;

      // Preflight conflict resolution using current listing.
      while (existingSet.has(finalName) && !overwrite) {
        const choice = await askUploadConflict({ name: finalName, cwd: p.cwd, target: p.target, existingType: nameToType.get(finalName) || 'file' });
        if (choice === 'skip') {
          toast('Пропущено: ' + originalName, 'info');
          finalName = '';
          break;
        }
        if (choice === 'overwrite') {
          overwrite = true;
          break;
        }
        // rename
        finalName = await pickFirstFreeName(side, finalName);
        overwrite = false;
      }

      if (!finalName) continue;

      let attempt = 0;
      let uploadedOk = false;
      let skipped = false;
      let hardFail = false;

      while (attempt < 3) {
        attempt++;
        let cancelled = false;

        const destPath = (p.target === 'remote') ? joinRemote(p.cwd, finalName) : joinLocal(p.cwd, finalName);
        const label = (finalName === originalName)
          ? `${finalName} (${i + 1}/${list.length})`
          : `${originalName} → ${finalName} (${i + 1}/${list.length})`;

        openTransferModal('Upload', label);

        const url = (() => {
          let u = `/api/fs/upload?target=${encodeURIComponent(p.target)}&path=${encodeURIComponent(destPath)}`;
          if (p.target === 'remote') {
            u += `&sid=${encodeURIComponent(p.sid)}`;
            // Create destination directories on demand (remote).
            u += '&parents=1';
          }
          if (overwrite) u += '&overwrite=1';
          return u;
        })();

        const xhr = new XMLHttpRequest();
        if (S && S.transfer) {
          S.transfer.xhr = xhr;
          S.transfer.kind = 'upload';
        }

        bindProgressCancel(() => {
          cancelled = true;
          try { xhr.abort(); } catch (e) {}
          finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
        });

        xhr.open('POST', url, true);

        // CSRF
        try {
          const tok = (A && typeof A.getCsrfToken === 'function') ? A.getCsrfToken() : '';
          if (tok) xhr.setRequestHeader('X-CSRF-Token', tok);
        } catch (e) {}

        xhr.upload.onprogress = (ev) => {
          const loaded = Number(ev.loaded || 0);
          const total = Number(ev.total || 0);
          const speed = transferSpeedBytesPerSec(loaded);
          const pct = (ev.lengthComputable && total > 0) ? Math.round((loaded / total) * 100) : 0;
          const eta = (ev.lengthComputable && total > 0 && speed > 1) ? (total - loaded) / speed : 0;
          const metaParts = [];
          if (ev.lengthComputable && total > 0) metaParts.push(`${fmtSize(loaded)} / ${fmtSize(total)} (${pct}%)`);
          else metaParts.push(`${fmtSize(loaded)}`);
          const sp = fmtSpeed(speed);
          if (sp) metaParts.push(sp);
          const et = fmtEta(eta);
          if (et) metaParts.push('ETA ' + et);
          _progressSetUi({ pct, metaText: metaParts.join('   ') });
        };

        xhr.upload.onloadend = () => {
          if (cancelled) return;
          try { _progressSetUi({ pct: 100, metaText: 'Передано, завершаю на роутере…' }); } catch (e) {}
        };

        const form = new FormData();
        form.append('file', file, finalName);

        const result = await new Promise((resolve) => {
          xhr.onerror = () => resolve({ ok: false, status: xhr.status || 0, text: '' });
          xhr.onabort = () => resolve({ ok: false, cancelled: true, status: xhr.status || 0, text: '' });
          xhr.onload = () => {
            const text = String(xhr.responseText || '');
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const j = JSON.parse(text || '{}');
                if (j && j.ok) return resolve({ ok: true, status: xhr.status, text, json: j });
              } catch (e) {}
              return resolve({ ok: true, status: xhr.status, text });
            }
            let j = null;
            try { j = JSON.parse(text || '{}'); } catch (e) { j = null; }
            return resolve({ ok: false, status: xhr.status, text, json: j });
          };
          xhr.send(form);
        });

        if (result && result.ok) {
          _progressSetUi({ pct: 100, metaText: 'Завершено' });
          finishTransferUi({ ok: true });
          toast('Загружено: ' + finalName, 'success');
          uploadedOk = true;
          break;
        }

        if (result && result.cancelled) {
          return false;
        }

        // Conflict returned by server (race / stale listing): ask and retry.
        const err = String((result && result.json && (result.json.error || result.json.message)) || '');
        if (result && result.status === 409 && (err === 'exists' || err === 'not_a_file')) {
          try { modalClose(el('fm-progress-modal')); } catch (e) {}
          const exType = String((result.json && result.json.type) || (err === 'not_a_file' ? 'dir' : 'file'));
          const choice = await askUploadConflict({ name: finalName, cwd: p.cwd, target: p.target, existingType: exType });
          if (choice === 'skip') {
            toast('Пропущено: ' + originalName, 'info');
            skipped = true;
            break;
          }
          if (choice === 'overwrite') {
            overwrite = true;
            continue;
          }
          // rename
          overwrite = false;
          finalName = await pickFirstFreeName(side, finalName);
          continue;
        }

        // Real error.
        let msg = 'upload_failed';
        try {
          const j = result && result.json;
          msg = String((j && (j.error || j.message)) || msg);
        } catch (e) {}

        finishTransferUi({ ok: false, message: msg, detailsText: (result && result.text) || '' });
        hardFail = true;
        break;
      }

      if (uploadedOk) {
        // Refresh listing on success.
        try {
          if (A && typeof A.listPanel === 'function') {
            // eslint-disable-next-line no-await-in-loop
            await A.listPanel(side, { fromInput: false });
          }
        } catch (e) {}
        continue;
      }

      if (skipped) continue;

      // If we hit a real error OR retried conflicts too many times, stop the batch.
      if (hardFail || attempt >= 3) break;
    }

    return true;
  };

  // Optional API export (handy for other modules).
  try { A.xhrUploadFiles = T.xhrUploadFiles; } catch (e) {}
})();
