(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  // -------------------------- fullscreen --------------------------
  // File manager fullscreen is implemented the same way as the terminal chrome:
  // we just toggle a CSS class on the card (no browser Fullscreen API).
  let fmIsFullscreen = false;

  function fmCardEl() {
    try {
      const view = el('view-files');
      if (!view) return null;
      return qs('.fm-card', view);
    } catch (e) {
      return null;
    }
  }

  function syncScrollLock() {
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.toggle('modal-open', !!fmIsFullscreen);
      }
    } catch (e) {}
  }

  function updateFmFullscreenBtn() {
    const btn = el('fm-fullscreen-btn');
    if (!btn) return;
    if (fmIsFullscreen) {
      btn.textContent = '🗗';
      btn.title = 'Восстановить';
      btn.setAttribute('aria-label', 'Восстановить');
    } else {
      btn.textContent = '⛶';
      btn.title = 'Полный экран';
      btn.setAttribute('aria-label', 'Полный экран');
    }
  }

  function fmSetFullscreen(on) {
    const card = fmCardEl();
    if (!card) return;
    fmIsFullscreen = !!on;
    try { card.classList.toggle('is-fullscreen', fmIsFullscreen); } catch (e) {}
    updateFmFullscreenBtn();
    syncScrollLock();
  }

  function fmToggleFullscreen() {
    fmSetFullscreen(!fmIsFullscreen);
  }

  // -------------------------- small helpers --------------------------
  function el(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function qs(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function qsa(sel, root) {
    try { return Array.from((root || document).querySelectorAll(sel) || []); } catch (e) { return []; }
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
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e) {}
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}
  }

  function modalClose(modal) {
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    try {
      if (XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}
  }

  function isTextInputActive() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = (a.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (a.isContentEditable) return true;
    return false;
  }

  function isFilesViewVisible() {
    const view = el('view-files');
    if (!view) return false;
    const cs = window.getComputedStyle(view);
    return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function fmtSize(bytes) {
    const n = Number(bytes || 0);
    if (!isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    const s = (u === 0) ? String(Math.round(v)) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
    return s.replace(/\.0+$/, '').replace(/(\.[1-9])0$/, '$1') + ' ' + units[u];
  }

  function fmtTime(ts) {
    const t = Number(ts || 0);
    if (!isFinite(t) || t <= 0) return '';
    try {
      const d = new Date(t * 1000);
      // Keep compact: YYYY-MM-DD HH:MM
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch (e) {
      return '';
    }
  }

  function safeName(s) {
    return String(s == null ? '' : s);
  }

  function joinLocal(cwd, name) {
    const c = String(cwd || '');
    const n = String(name || '');
    if (!c) return n;
    if (!n) return c;
    const sep = c.endsWith('/') ? '' : '/';
    return c + sep + n;
  }

  function parentLocal(cwd) {
    const p = String(cwd || '').replace(/\/+$/, '');
    if (!p || p === '/') return '/';
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx) || '/';
  }

  
function normRemotePath(p) {
  let s = String(p || '').trim();
  if (!s || s === '~') return '.';
  if (s === '.') return '.';
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '.';
}

function joinRemote(cwd, name) {
  const c0 = normRemotePath(cwd);
  let n = String(name || '').trim();
  if (!n) return c0 || '.';
  n = n.replace(/\/+$/, '');
  if (n === '') n = '/';
  if (n.startsWith('/')) return normRemotePath(n);
  if (!c0 || c0 === '.') return normRemotePath(n);
  const sep = c0.endsWith('/') ? '' : '/';
  return normRemotePath(c0 + sep + n);
}

function parentRemote(cwd) {
  const p0 = normRemotePath(cwd);
  if (!p0 || p0 === '.') return '.';
  if (p0 === '/') return '/';
  const p = String(p0).replace(/\/+$/, '');
  const idx = p.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  const up = p.slice(0, idx);
  return up ? up : '/';
}

  function _trimSlashes(p) {
    return String(p || '').replace(/\/+$/, '') || '/';
  }

  function _isUnderRoot(path, root) {
    const pp = _trimSlashes(path);
    const rr = _trimSlashes(root);
    if (rr === '/') return true;
    return pp === rr || pp.startsWith(rr + '/');
  }

  function isAllowedLocalPath(path, roots) {
    const rr = Array.isArray(roots) ? roots : [];
    if (!rr.length) return true;
    for (const r of rr) {
      if (_isUnderRoot(path, r)) return true;
    }
    return false;
  }


  function getCsrfToken() {
    try {
      const m = document.querySelector('meta[name="csrf-token"]');
      const v = m ? (m.getAttribute('content') || '') : '';
      return String(v || '');
    } catch (e) {
      return '';
    }
  }

  async function fetchJson(url, init) {
    const opts = init ? Object.assign({}, init) : {};
    const method = String(opts.method || 'GET').toUpperCase();

    // Normalize headers
    let headers = opts.headers || {};
    try {
      if (headers instanceof Headers) {
        // ok
      } else if (Array.isArray(headers)) {
        headers = new Headers(headers);
      } else {
        headers = new Headers(headers || {});
      }
    } catch (e) {
      headers = new Headers();
    }

    // CSRF for mutating API calls
    if (method !== 'GET' && method !== 'HEAD') {
      const tok = getCsrfToken();
      if (tok && !headers.get('X-CSRF-Token')) headers.set('X-CSRF-Token', tok);
    }

    opts.headers = headers;

    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { res, data };
  }

  // -------------------------- XHR transfers (upload/download with progress) --------------------------
  function _nowMs() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function _parseContentDispositionFilename(headerVal) {
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
  // Progress modal: show details only on failure, and auto-close on success
  let _progressAutoCloseTimer = null;

  function _clearProgressAutoClose() {
    try { if (_progressAutoCloseTimer) clearTimeout(_progressAutoCloseTimer); } catch (e) {}
    _progressAutoCloseTimer = null;
  }

  function _scheduleProgressAutoClose(delayMs) {
    _clearProgressAutoClose();
    const d = Math.max(0, Number(delayMs || 0));
    _progressAutoCloseTimer = setTimeout(() => {
      try { modalClose(el('fm-progress-modal')); } catch (e) {}
    }, d);
  }

  function _ensureProgressDetailsToggle() {
    const modal = el('fm-progress-modal');
    if (!modal) return;
    const body = qs('.modal-body', modal);
    const details = el('fm-progress-details');
    if (!body || !details) return;

    // Create toggle UI once (hidden by default).
    if (!el('fm-progress-details-toggle')) {
      // Hide raw JSON by default (can be opened for debugging).
      details.style.display = 'none';
      const wrap = document.createElement('div');
      wrap.id = 'fm-progress-details-wrap';
      wrap.style.display = 'none';
      wrap.style.justifyContent = 'flex-end';
      wrap.style.marginTop = '10px';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.id = 'fm-progress-details-toggle';
      btn.textContent = 'Детали';
      btn.onclick = () => {
        const shown = details.style.display !== 'none';
        details.style.display = shown ? 'none' : 'block';
        btn.textContent = shown ? 'Детали' : 'Скрыть детали';
      };
      wrap.appendChild(btn);
      body.insertBefore(wrap, details);
    }
  }

  function _setProgressDetailsAvailable(available) {
    _ensureProgressDetailsToggle();
    const wrap = el('fm-progress-details-wrap');
    const btn = el('fm-progress-details-toggle');
    const details = el('fm-progress-details');
    if (!wrap || !btn || !details) return;

    if (available) {
      wrap.style.display = 'flex';
    } else {
      wrap.style.display = 'none';
      details.style.display = 'none';
      btn.textContent = 'Детали';
    }
  }

  function _setProgressUi({ titleText, pct, metaText, errorText, detailsText }) {
    const title = el('fm-progress-title');
    const bar = el('fm-progress-bar-inner');
    const meta = el('fm-progress-meta');
    const details = el('fm-progress-details');
    const err = el('fm-progress-error');

    if (title && titleText != null) title.textContent = String(titleText);
    if (bar && pct != null && isFinite(Number(pct))) {
      const p = Math.max(0, Math.min(100, Number(pct)));
      bar.style.width = p + '%';
    }
    if (meta && metaText != null) meta.textContent = String(metaText);
    if (err) err.textContent = errorText ? String(errorText) : '';
    if (details && detailsText != null) details.textContent = String(detailsText);
  }

  function _resetTransferState() {
    S.transfer.xhr = null;
    S.transfer.kind = '';
    S.transfer.startedAtMs = 0;
    S.transfer.lastAtMs = 0;
    S.transfer.lastLoaded = 0;
    S.transfer.speed = 0;
  }

  function _transferSpeedBytesPerSec(loaded) {
    const now = _nowMs();
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

  function _fmtSpeed(bps) {
    const v = Number(bps || 0);
    if (!isFinite(v) || v <= 0) return '';
    return fmtSize(v) + '/s';
  }

  function _fmtEta(seconds) {
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

  function _openTransferModal(kindLabel, fileLabel) {
    _ensureProgressDetailsToggle();
    _setProgressDetailsAvailable(false);
    _clearProgressAutoClose();
    modalOpen(el('fm-progress-modal'));
    _resetTransferState();
    _setProgressUi({
      titleText: `${kindLabel}${fileLabel ? (' — ' + fileLabel) : ''}`,
      pct: 0,
      metaText: '',
      errorText: '',
      detailsText: '',
    });
  }

  function _bindProgressCancel(onCancel) {
    const cancelBtn = el('fm-progress-cancel-btn');
    if (!cancelBtn) return;
    cancelBtn.disabled = false;
    cancelBtn.onclick = (e) => {
      e && e.preventDefault && e.preventDefault();
      try { onCancel && onCancel(); } catch (e2) {}
    };
  }
  function _finishTransferUi({ ok, message, detailsText, showDetails }) {
    _ensureProgressDetailsToggle();
    const cancelBtn = el('fm-progress-cancel-btn');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.onclick = null;
    }

    if (ok) {
      // On success we auto-close the modal (toast already informs the user).
      _setProgressUi({ errorText: '' });
      _setProgressDetailsAvailable(false);
      _clearProgressAutoClose();
      _scheduleProgressAutoClose(650);
      return;
    }

    const wantDetails = (showDetails === undefined) ? true : !!showDetails;
    _setProgressDetailsAvailable(wantDetails);
    if (detailsText != null) {
      _setProgressUi({ detailsText: String(detailsText) });
    }
    _setProgressUi({ errorText: message || 'transfer_failed' });
  }

  function xhrDownloadFile({ url, filenameHint, titleLabel, method, body, headers }) {
  _openTransferModal(titleLabel || 'Download', filenameHint || '');

  const xhr = new XMLHttpRequest();
  S.transfer.xhr = xhr;
  S.transfer.kind = 'download';

  _bindProgressCancel(() => {
    try { xhr.abort(); } catch (e) {}
    _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
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
      const tok = getCsrfToken();
      if (tok) xhr.setRequestHeader('X-CSRF-Token', tok);
    } catch (e) {}
  }

  // Body normalize (object -> JSON)
  let sendBody = body;
  if (sendBody && typeof sendBody === 'object' && !(sendBody instanceof Blob) && !(sendBody instanceof ArrayBuffer)) {
    try {
      sendBody = JSON.stringify(sendBody);
      // Set content type if not already set by headers.
      try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
    } catch (e) {}
  }

  xhr.onprogress = (ev) => {
    const loaded = Number(ev.loaded || 0);
    const total = Number(ev.total || 0);
    const speed = _transferSpeedBytesPerSec(loaded);
    const pct = (ev.lengthComputable && total > 0) ? Math.round((loaded / total) * 100) : 0;
    const eta = (ev.lengthComputable && total > 0 && speed > 1) ? (total - loaded) / speed : 0;
    const metaParts = [];
    if (ev.lengthComputable && total > 0) metaParts.push(`${fmtSize(loaded)} / ${fmtSize(total)} (${pct}%)`);
    else metaParts.push(`${fmtSize(loaded)}`);
    const sp = _fmtSpeed(speed);
    if (sp) metaParts.push(sp);
    const et = _fmtEta(eta);
    if (et) metaParts.push('ETA ' + et);
    _setProgressUi({ pct, metaText: metaParts.join('   ') });
  };

  xhr.onerror = () => {
    _finishTransferUi({ ok: false, message: 'Ошибка сети', detailsText: 'network_error', showDetails: true });
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      const cd = xhr.getResponseHeader('Content-Disposition');
      const name = _parseContentDispositionFilename(cd) || filenameHint || 'download';
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
          try { a.remove(); } catch (e) {}
        }, 500);
      } catch (e) {}
      _setProgressUi({ pct: 100 });
      _finishTransferUi({ ok: true });
      try { toast('Скачано: ' + name, 'success'); } catch (e) {}
      return;
    }

    let msg = `HTTP ${xhr.status}`;
    try {
      const txt = String(xhr.responseText || '');
      const j = JSON.parse(txt);
      msg = String(j.error || j.message || msg);
    } catch (e) {}
    _finishTransferUi({ ok: false, message: msg, detailsText: (xhr && (xhr.responseText || '')) || '' });
  };

  try {
    xhr.send(sendBody || null);
  } catch (e) {
    try { xhr.send(); } catch (e2) {}
  }
}

async function xhrUploadFiles({ side, files }) {
    const p = S.panels[side];
    if (!p) return;
    if (!files || !files.length) return;
    if (p.target === 'remote' && !p.sid) {
      toast('Upload: remote без сессии', 'info');
      return false;
    }

    // Upload sequentially for predictable UI.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = `${file.name} (${i + 1}/${files.length})`;
      _openTransferModal('Upload', label);

      const dir = (() => {
        if (p.target === 'remote') {
          const c = normRemotePath(p.cwd);
          if (!c || c === '.') return './';
          return c.endsWith('/') ? c : (c + '/');
        }
        const c = String(p.cwd || '');
        return c.endsWith('/') ? c : (c + '/');
      })();

      const url = (() => {
        const base = `/api/fs/upload?target=${encodeURIComponent(p.target)}&path=${encodeURIComponent(dir)}`;
        if (p.target === 'remote') return base + `&sid=${encodeURIComponent(p.sid)}`;
        return base;
      })();

      const xhr = new XMLHttpRequest();
      S.transfer.xhr = xhr;
      S.transfer.kind = 'upload';

      _bindProgressCancel(() => {
        try { xhr.abort(); } catch (e) {}
        _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' });
      });

      xhr.open('POST', url, true);
      // CSRF
      try {
        const tok = getCsrfToken();
        if (tok) xhr.setRequestHeader('X-CSRF-Token', tok);
      } catch (e) {}

      xhr.upload.onprogress = (ev) => {
        const loaded = Number(ev.loaded || 0);
        const total = Number(ev.total || 0);
        const speed = _transferSpeedBytesPerSec(loaded);
        const pct = (ev.lengthComputable && total > 0) ? Math.round((loaded / total) * 100) : 0;
        const eta = (ev.lengthComputable && total > 0 && speed > 1) ? (total - loaded) / speed : 0;
        const metaParts = [];
        if (ev.lengthComputable && total > 0) metaParts.push(`${fmtSize(loaded)} / ${fmtSize(total)} (${pct}%)`);
        else metaParts.push(`${fmtSize(loaded)}`);
        const sp = _fmtSpeed(speed);
        if (sp) metaParts.push(sp);
        const et = _fmtEta(eta);
        if (et) metaParts.push('ETA ' + et);
        _setProgressUi({ pct, metaText: metaParts.join('   ') });
      };

      xhr.upload.onloadend = () => {
        try {
          // Request body sent; server may still be processing.
          _setProgressUi({ pct: 100, metaText: 'Передано, завершаю на роутере…' });
        } catch (e) {}
      };

      const form = new FormData();
      form.append('file', file, file.name);

      const ok = await new Promise((resolve) => {
        xhr.onerror = () => resolve(false);
        xhr.onabort = () => resolve(false);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const j = JSON.parse(String(xhr.responseText || '{}'));
              if (j && j.ok) return resolve(true);
              return resolve(false);
            } catch (e) {
              return resolve(true);
            }
          }
          resolve(false);
        };
        xhr.send(form);
      });

      if (!ok) {
        let msg = 'upload_failed';
        try {
          const j = JSON.parse(String(xhr.responseText || '{}'));
          msg = String(j.error || j.message || msg);
        } catch (e) {}
        _finishTransferUi({ ok: false, message: msg, detailsText: (xhr && (xhr.responseText || '')) || '' });
        // stop batch if one failed
        break;
      }

      // Server may still be processing remote put; show a small hint.
      _setProgressUi({ pct: 100, metaText: 'Завершено' });
      _finishTransferUi({ ok: true });
      try { toast('Загружено: ' + file.name, 'success'); } catch (e) {}
      await listPanel(side, { fromInput: false });
    }
  }

  // -------------------------- state --------------------------
  const S = {
    enabled: false,
    caps: null,
    remoteCaps: null,
    activeSide: 'left',
    create: { kind: '', side: 'left' },
    rename: { side: 'left', oldName: '' },
    ctxMenu: { shown: false, side: 'left', name: '', isDir: false },
    dropOp: { resolve: null }, // drag&drop move/copy choice modal
    panels: {
      left: { target: 'local', sid: '', cwd: '/opt/var', roots: [], items: [], selected: new Set(), focusName: '', anchorName: '' },
      // Keenetic-friendly default: right panel opens at disk list (/tmp/mnt)
      right: { target: 'local', sid: '', cwd: '/tmp/mnt', roots: [], items: [], selected: new Set(), focusName: '', anchorName: '' },
    },
    connectForSide: 'left',
    pending: null, // { op, payload, conflicts }
    ws: { socket: null, jobId: '', token: '', pollTimer: null },
    jobStats: {}, // job_id -> { lastTsMs, lastBytes, speed }
    transfer: { xhr: null, kind: '', startedAtMs: 0, lastAtMs: 0, lastLoaded: 0, speed: 0 },
    autoDiskDone: false,
  };

  function panelEl(side) {
    return qs(`.fm-panel[data-side="${side}"]`, el('fm-root'));
  }

  function panelDom(side) {
    const root = panelEl(side);
    if (!root) return null;
    return {
      root,
      targetSelect: qs('.fm-target-select', root),
      connectBtn: qs('.fm-connect-btn', root),
      disconnectBtn: qs('.fm-disconnect-btn', root),
      pathInput: qs('.fm-path-input', root),
      upBtn: qs('.fm-up-btn', root),
      refreshBtn: qs('.fm-refresh-btn', root),
      list: qs('.fm-list', root),
    };
  }

  function setActiveSide(side) {
    if (side !== 'left' && side !== 'right') return;
    S.activeSide = side;
    ['left', 'right'].forEach((s) => {
      const d = panelDom(s);
      if (!d) return;
      try { d.root.classList.toggle('fm-panel-active', s === side); } catch (e) {}
    });
  }

  function otherSide(side) {
    return side === 'left' ? 'right' : 'left';
  }

  function sortItems(items) {
    const arr = Array.from(items || []);
    arr.sort((a, b) => {
      const ad = ((a && a.type) === 'dir') || (((a && a.type) === 'link') && !!(a && a.link_dir));
      const bd = ((b && b.type) === 'dir') || (((b && b.type) === 'link') && !!(b && b.link_dir));
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      const an = String((a && a.name) || '').toLowerCase();
      const bn = String((b && b.name) || '').toLowerCase();
      return an.localeCompare(bn);
    });
    return arr;
  }

  // Keenetic mounts: /tmp/mnt contains UUID-like mount folders + user-friendly label symlinks.
  // We want to show only labels in the root list (like firmware UI).
  function isTmpMntRoot(panel) {
    try {
      return !!panel && panel.target === 'local' && String(panel.cwd || '').replace(/\/+$/, '') === '/tmp/mnt';
    } catch (e) {
      return false;
    }
  }

  function looksLikeUuidName(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    // 8-4-4-4-12 canonical UUID
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(n)) return true;
    // long hex-only ids
    if (/^[0-9a-fA-F]{24,}$/.test(n)) return true;
    return false;
  }

  function beautifyTmpMntRootItems(items) {
    const arr = Array.from(items || []);
    const diskLabels = arr.filter((it) => String(it && it.type) === 'link' && !!(it && it.link_dir));
    if (diskLabels.length) {
      // Hide raw mount folders (UUID-like dirs). Keep only disk labels + any non-UUID extras.
      const extras = arr.filter((it) => {
        const t = String(it && it.type);
        const nm = safeName(it && it.name);
        if (t === 'dir' && looksLikeUuidName(nm)) return false;
        // If there are label symlinks, root list should primarily be labels.
        // Keep any non-UUID entries (dirs, files, other links) as "extras".
        return true;
      });
      // Prefer labels. Extras (e.g. unexpected files) appended.
      return diskLabels.concat(extras.filter((x) => diskLabels.indexOf(x) < 0));
    }
    // If no labels exist, don't hide anything (otherwise user may see an empty list).
    return arr;
  }

  function renderPanel(side) {
    const pd = panelDom(side);
    const p = S.panels[side];
    if (!pd || !p) return;

    if (pd.targetSelect && String(pd.targetSelect.value) !== String(p.target)) {
      try { pd.targetSelect.value = p.target; } catch (e) {}
    }

    if (pd.pathInput) {
      // Local: show resolved path. Remote: display '/' for home ('.').
      if (p.target === 'remote') {
        const v = String(p.cwd || '').trim();
        pd.pathInput.value = (!v || v === '.') ? '~' : v;
      } else {
        pd.pathInput.value = String(p.cwd || '');
      }
    }

    // Buttons visibility
    const isRemote = p.target === 'remote';
    if (isRemote) {
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

    // List
    const list = pd.list;
    if (!list) return;

    // Preserve focus if possible
    const focusName = p.focusName;

    const frag = document.createDocumentFragment();

    // header row
    const header = document.createElement('div');
    header.className = 'fm-row fm-row-header';
    header.innerHTML = '<div class="fm-cell fm-check"></div><div class="fm-cell fm-name">Имя</div><div class="fm-cell fm-size">Размер</div><div class="fm-cell fm-perm">Права</div><div class="fm-cell fm-mtime">Изм.</div>';
    frag.appendChild(header);

    const tmpMntRoot = isTmpMntRoot(p);
    const items = sortItems(p.items);
    items.forEach((it) => {
      const row = document.createElement('div');
      const name = safeName(it && it.name);
      const type = String((it && it.type) || '');
      const linkDir = !!(it && it.link_dir);
      const isDir = type === 'dir' || (type === 'link' && linkDir);
      row.className = 'fm-row' + (isDir ? ' is-dir' : '');
      row.setAttribute('role', 'option');
      row.tabIndex = -1;
      row.dataset.name = name;
      row.dataset.type = type;
      // enable drag from row (DnD between panels)
      row.setAttribute('draggable', 'true');

      const selected = p.selected.has(name);
      if (selected) row.classList.add('is-selected');
      if (focusName && focusName === name) row.classList.add('is-focused');

      const size = isDir ? 'DIR' : fmtSize(it && it.size);
      const perm = safeName(it && it.perm);
      const mtime = fmtTime(it && it.mtime);
      const isDiskLabel = tmpMntRoot && type === 'link' && linkDir;
      // Keenetic-like visuals:
      // - disk labels in /tmp/mnt root -> "disk" icon
      // - symlink to directory -> show as normal folder (avoid name shift from 🔗📁)
      const ico = (type === 'dir') ? '📁'
        : (type === 'link'
          ? (linkDir ? (isDiskLabel ? '💽' : '📁') : '🔗')
          : '📄');
      row.innerHTML = `
        <div class="fm-cell fm-check"><input type="checkbox" class="fm-check-input" aria-label="Выбрать" /></div>
        <div class="fm-cell fm-name"><span class="fm-ico">${ico}</span><span class="fm-name-text"></span></div>
        <div class="fm-cell fm-size">${size}</div>
        <div class="fm-cell fm-perm">${perm ? perm : ''}</div>
        <div class="fm-cell fm-mtime">${mtime}</div>
      `;
      try {
        const t = qs('.fm-name-text', row);
        if (t) t.textContent = name;
      } catch (e) {}
      try { const cb = qs('.fm-check-input', row); if (cb) cb.checked = !!selected; } catch (e) {}
      frag.appendChild(row);
    });

    list.innerHTML = '';
    list.appendChild(frag);

    // Ensure focus row visible
    try {
      const f = qs('.fm-row.is-focused', list);
      if (f && typeof f.scrollIntoView === 'function') f.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
  }

  // listPanel(side, { fromInput: boolean })
  // fromInput=true means we trust the path input value as user intent.
  // fromInput=false means we use p.cwd (used by navigation like Enter/Backspace).
  async function listPanel(side, opts) {
    const p = S.panels[side];
    if (!p) return;
    const pd = panelDom(side);
    if (!pd) return;

    const fromInput = !!(opts && opts.fromInput);

    // Normalize desired cwd
    // - during navigation we MUST trust p.cwd (input might still show old path)
    // - when user hits Enter in input or clicks Refresh, we take input value
    let desired = p.cwd;
    if (fromInput) {
      try {
        if (pd.pathInput) {
          const v = String(pd.pathInput.value || '').trim();
          if (v) {
            if (p.target === 'remote' && (v === '~' || v === '.')) desired = '.';
            else desired = v;
          }
        }
      } catch (e) {}
    }

    // Normalize remote paths (avoid duplicated segments like /etc/etc/..)
    if (p.target === 'remote') {
      desired = normRemotePath(desired);
    }

    // Remote requires session
    if (p.target === 'remote' && !p.sid) {
      p.items = [];
      p.selected.clear();
      p.focusName = '';
      renderPanel(side);
      return false;
    }

    const url = (() => {
      if (p.target === 'local') {
        return `/api/fs/list?target=local&path=${encodeURIComponent(desired || '')}`;
      }
      // For remote, use '.' for home; do not force '/' which may be invalid on chrooted SFTP.
      return `/api/fs/list?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(desired || '.')}`;
    })();

    // Loading state
    try {
      pd.list && pd.list.classList.add('is-loading');
    } catch (e) {}

    const { res, data } = await fetchJson(url, { method: 'GET' });

    try {
      pd.list && pd.list.classList.remove('is-loading');
    } catch (e) {}

    if (!res || !res.ok || !data || !data.ok) {
      const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : 'list_failed';
      const details = data && (data.details || data.hint) ? String(data.details || data.hint) : '';
      if (msg === 'path_not_allowed') {
        // Local sandbox boundary — not an actual error for UX.
        toast('FM: достигнут предел sandbox', 'info');
      } else {
        toast('FM: ' + msg + (details ? (' — ' + details) : ''), 'error');
      }
      return false;
    }

    p.roots = Array.isArray(data.roots) ? data.roots : (p.roots || []);
    if (p.target === 'local') {
      p.cwd = String(data.path || desired || '');
    } else {
      p.cwd = normRemotePath(String(data.path || desired || '.'));

    }

    let nextItems = Array.isArray(data.items) ? data.items : [];

    // Keenetic-like view for /tmp/mnt root: show only disk labels (symlink dirs), hide UUID mount folders.
    if (isTmpMntRoot(p)) {
      nextItems = beautifyTmpMntRootItems(nextItems);
    }

    // If user has exactly one disk label, auto-enter it on first load of the right panel.
    // (Keeps dual-pane UX: left stays /opt/var; right opens the only disk.)
    if (!S.autoDiskDone && side === 'right' && isTmpMntRoot(p)) {
      const disks = nextItems.filter((it) => {
        const t = String(it && it.type);
        return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
      });
      if (disks.length === 1) {
        S.autoDiskDone = true;
        p.cwd = joinLocal(p.cwd, safeName(disks[0] && disks[0].name));
        p.selected.clear();
        p.focusName = '';
        // Use navigation mode (fromInput=false) so input doesn't override.
        await listPanel(side, { fromInput: false });
        return true;
      }
    }

    p.items = nextItems;

    // keep selection only for existing names
    const existing = new Set(p.items.map((it) => safeName(it && it.name)));
    const nextSel = new Set();
    for (const n of p.selected) {
      if (existing.has(n)) nextSel.add(n);
    }
    p.selected = nextSel;
    if (p.focusName && !existing.has(p.focusName)) p.focusName = '';
    if (p.anchorName && !existing.has(p.anchorName)) p.anchorName = '';
    if (!p.focusName && p.items.length) p.focusName = safeName(p.items[0] && p.items[0].name);

    renderPanel(side);
    return true;
  }

  async function refreshAll() {
    await Promise.all([listPanel('left', { fromInput: true }), listPanel('right', { fromInput: true })]);
  }

  function getFocusedItem(side) {
    const p = S.panels[side];
    if (!p) return null;
    const name = p.focusName;
    if (!name) return null;
    return (p.items || []).find((it) => safeName(it && it.name) === name) || null;
  }

  function getSelectionNames(side) {
    const p = S.panels[side];
    if (!p) return [];
    const arr = Array.from(p.selected || []);
    if (arr.length) return arr;
    const f = getFocusedItem(side);
    if (f && f.name) return [safeName(f.name)];
    return [];
  }

  function clearSelectionExcept(side, keepName) {
    const p = S.panels[side];
    if (!p) return;
    p.selected.clear();
    if (keepName) p.selected.add(keepName);
    p.anchorName = keepName ? safeName(keepName) : '';
  }


  function selectRange(side, fromName, toName, addToExisting) {
    const p = S.panels[side];
    if (!p) return;
    const from = safeName(fromName || '');
    const to = safeName(toName || '');
    if (!from || !to) return;

    const items = sortItems(p.items || []);
    const names = items.map((it) => safeName(it && it.name));
    const a = names.indexOf(from);
    const b = names.indexOf(to);

    if (a < 0 || b < 0) {
      // Fallback: behave as a normal single selection.
      if (!addToExisting) p.selected.clear();
      p.selected.add(to);
      return;
    }

    const i1 = Math.min(a, b);
    const i2 = Math.max(a, b);

    if (!addToExisting) p.selected.clear();
    for (let i = i1; i <= i2; i++) {
      const nm = names[i];
      if (nm) p.selected.add(nm);
    }
  }

  function setFocus(side, name) {
    const p = S.panels[side];
    if (!p) return;
    p.focusName = safeName(name || '');
  }

  function focusNext(side, delta) {
    const p = S.panels[side];
    if (!p || !p.items || !p.items.length) return;
    const items = sortItems(p.items);
    let idx = items.findIndex((it) => safeName(it && it.name) === p.focusName);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(items.length - 1, idx + delta));
    p.focusName = safeName(items[idx] && items[idx].name);
    renderPanel(side);
  }


  // -------------------------- text file viewer/editor (CodeMirror modal) --------------------------
  const FM_EDITOR = {
    wired: false,
    cm: null,
    ctx: null,          // { target, sid, path, name, side, truncated, readOnly }
    dirty: false,
    lastSaved: '',
  };

  function fmEditorEls() {
    const modal = el('fm-editor-modal');
    if (!modal) return null;
    return {
      modal,
      title: el('fm-editor-title'),
      subtitle: el('fm-editor-subtitle'),
      textarea: el('fm-editor-textarea'),
      saveBtn: el('fm-editor-save-btn'),
      cancelBtn: el('fm-editor-cancel-btn'),
      closeBtn: el('fm-editor-close-btn'),
      downloadBtn: el('fm-editor-download-btn'),
      warn: el('fm-editor-warning'),
      err: el('fm-editor-error'),
    };
  }

  
  function fmSampleText(text, maxLen = 4000) {
    const s = String(text == null ? '' : text);
    if (!s) return '';
    // Keep only the head; enough for heuristics, safe for big logs.
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function fmLooksLikeJson(text) {
    const s = fmSampleText(text, 5000).trimStart();
    if (!s) return false;
    const c = s[0];
    if (c !== '{' && c !== '[') return false;
    // Avoid obvious non-JSON (nginx blocks etc.)
    if (/\b(server|location|upstream)\b\s*\{/i.test(s.slice(0, 2000))) return false;
    return true;
  }

  function fmLooksLikeYaml(text) {
    const s = fmSampleText(text, 3000);
    if (!s) return false;
    // YAML doc start or "key: value" patterns near top.
    if (/^\s*---\s*(\r?\n|$)/.test(s)) return true;
    return /^\s*[A-Za-z0-9_\-\."']+\s*:\s*[^\n]*$/m.test(s.slice(0, 1200));
  }

  function fmLooksLikeShell(text) {
    const s = fmSampleText(text, 3000);
    if (!s) return false;
    if (/^\s*#!.*\b(sh|bash|ash|zsh)\b/i.test(s)) return true;
    // Common shell-ish patterns in logs/scripts.
    return /^\s*(export\s+\w+|set\s+-[a-zA-Z]+|\w+=.+|\$(\{|\w))/m.test(s.slice(0, 1200));
  }

  function fmLooksLikeXml(text) {
    const s = fmSampleText(text, 4000).trimStart();
    if (!s) return false;
    if (s.startsWith('<?xml')) return true;
    return /^<\w[\w\-:.]*[\s>]/.test(s);
  }

  function fmLooksLikeNginx(text) {
    const s = fmSampleText(text, 6000);
    if (!s) return false;
    // Nginx conf typically has blocks with braces + directives.
    if (!/[{}]/.test(s)) return false;
    return /\b(http|events|server|location|upstream|map)\b\s*\{/i.test(s) ||
           /\b(listen|server_name|proxy_pass|root|include)\b/i.test(s);
  }

  function fmGuessCmMode(name, text) {
    const n = String(name || '').toLowerCase();
    const ext = n.includes('.') ? n.split('.').pop() : '';

    // Extension-first mapping.
    if (ext === 'json' || ext === 'jsonc') return { name: 'javascript', json: true };
    if (ext === 'js' || ext === 'ts') return 'javascript';
    if (ext === 'yaml' || ext === 'yml') return 'yaml';
    if (ext === 'sh' || ext === 'bash') return 'shell';
    if (ext === 'toml') return 'toml';
    if (ext === 'ini' || ext === 'cfg') return 'properties';
    if (ext === 'xml') return 'xml';
    if (ext === 'nginx') return 'nginx';

    // .conf is ambiguous: try detect nginx, otherwise treat as ini/properties.
    if (ext === 'conf') {
      if (fmLooksLikeNginx(text)) return 'nginx';
      return 'properties';
    }

    // Logs / plain text: try quick heuristics so even *.txt can be highlighted.
    if (ext === 'log' || ext === 'txt' || ext === '') {
      if (fmLooksLikeJson(text)) return { name: 'javascript', json: true };
      if (fmLooksLikeYaml(text)) return 'yaml';
      if (fmLooksLikeShell(text)) return 'shell';
      if (fmLooksLikeXml(text)) return 'xml';
      if (fmLooksLikeNginx(text)) return 'nginx';
      return 'text/plain';
    }

    // Keep compatibility for other extensions (modes may or may not be present).
    if (ext === 'py') return 'python';
    if (ext === 'css') return 'css';
    if (ext === 'html' || ext === 'htm') return 'htmlmixed';
    if (ext === 'md' || ext === 'markdown') return 'markdown';

    return 'text/plain';
  }

  function fmCurrentCmTheme() {
    try {
      const t = document.documentElement.getAttribute('data-theme');
      return (t === 'light') ? 'default' : 'material-darker';
    } catch (e) {
      return 'material-darker';
    }
  }

  function fmEnsureEditorCm() {
    if (FM_EDITOR.cm) return FM_EDITOR.cm;
    const ui = fmEditorEls();
    if (!ui || !ui.textarea) return null;
    if (!window.CodeMirror || typeof window.CodeMirror.fromTextArea !== 'function') return null;

    
    const cm = window.CodeMirror.fromTextArea(ui.textarea, {
      lineNumbers: true,
      lineWrapping: true,
      theme: fmCurrentCmTheme(),
      mode: 'text/plain',

      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,

      // Addons (loaded globally in panel.html)
      showIndentGuides: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      showTrailingSpace: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers'],
      lint: false,
      highlightSelectionMatches: { showToken: /\w/, minChars: 2 },

      // Keep reasonable performance on big logs, but show a bit more context.
      viewportMargin: 50,

      extraKeys: {
        'Ctrl-S': () => { fmEditorSave(); },
        'Cmd-S': () => { fmEditorSave(); },

        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-H': 'replace',
        'Cmd-Alt-F': 'replace',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',

        'Esc': () => { fmEditorRequestClose(); },
      },
    });

    // Register for theme sync (theme.js reads window.__xkeenEditors)
    try {
      window.__xkeenEditors = window.__xkeenEditors || [];
      window.__xkeenEditors.push(cm);
    } catch (e) {}

    // Attach toolbar if available
    try {
      if (window.xkeenAttachCmToolbar && window.XKEEN_CM_TOOLBAR_DEFAULT) {
        window.xkeenAttachCmToolbar(cm, window.XKEEN_CM_TOOLBAR_DEFAULT);
      }
    } catch (e) {}

    cm.on('change', () => {
      try {
        const v = cm.getValue();
        FM_EDITOR.dirty = (FM_EDITOR.ctx && !FM_EDITOR.ctx.readOnly) ? (v !== FM_EDITOR.lastSaved) : false;
        const ui2 = fmEditorEls();
        if (ui2 && ui2.saveBtn) ui2.saveBtn.disabled = !FM_EDITOR.dirty || !!(FM_EDITOR.ctx && FM_EDITOR.ctx.readOnly);
      } catch (e) {}
    });

    FM_EDITOR.cm = cm;
    return cm;
  }

  function fmEditorSetInfo({ subtitle, warn, err } = {}) {
    const ui = fmEditorEls();
    if (!ui) return;
    try {
      if (ui.subtitle) ui.subtitle.textContent = String(subtitle || '');
    } catch (e) {}
    try {
      if (ui.warn) {
        if (warn) { ui.warn.style.display = ''; ui.warn.textContent = String(warn); }
        else { ui.warn.style.display = 'none'; ui.warn.textContent = ''; }
      }
    } catch (e) {}
    try {
      if (ui.err) {
        if (err) { ui.err.style.display = ''; ui.err.textContent = String(err); }
        else { ui.err.style.display = 'none'; ui.err.textContent = ''; }
      }
    } catch (e) {}
  }


  function fmEditorKickRefresh(cm, focus = true) {
    if (!cm) return;

    const doRefresh = () => { try { cm.refresh(); } catch (e) {} };

    // Ensure initial position at the top (useful for logs).
    try { cm.scrollTo(0, 0); } catch (e) {}
    try { cm.setCursor({ line: 0, ch: 0 }); } catch (e) {}

    // CodeMirror часто инициализируется в скрытой модалке (display:none),
    // поэтому делаем несколько refresh после открытия (в т.ч. после загрузки шрифтов).
    doRefresh();
    try { requestAnimationFrame(doRefresh); } catch (e) { setTimeout(doRefresh, 0); }
    setTimeout(doRefresh, 0);
    setTimeout(doRefresh, 50);
    setTimeout(doRefresh, 150);
    setTimeout(doRefresh, 300);

    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(doRefresh).catch(() => {});
      }
    } catch (e) {}

    if (focus) setTimeout(() => { try { cm.focus(); } catch (e) {} }, 0);
  }

  
  function fmEditorOpen(ctx, text) {
    const ui = fmEditorEls();
    if (!ui) return false;

    FM_EDITOR.ctx = ctx || null;
    FM_EDITOR.lastSaved = String(text || '');
    FM_EDITOR.dirty = false;

    try { if (ui.title) ui.title.textContent = String((ctx && ctx.name) || 'Файл'); } catch (e) {}

    const subtitle = [];
    try {
      if (ctx && ctx.path) subtitle.push(String(ctx.path));
      if (ctx && ctx.target === 'remote' && ctx.sid) subtitle.push('remote');
      if (ctx && ctx.target === 'local') subtitle.push('local');
      if (ctx && ctx.truncated) subtitle.push('частично');
    } catch (e) {}
    fmEditorSetInfo({
      subtitle: subtitle.join(' • '),
      warn: (ctx && ctx.truncated) ? 'Файл открыт частично (ограничение размера). Сохранение отключено.' : '',
      err: '',
    });

    // ВАЖНО: сначала открываем модалку, иначе CodeMirror измерит нулевые размеры и визуально будет "пустым" до клика.
    modalOpen(ui.modal);

    const cm = fmEnsureEditorCm();
    const ro = !!(ctx && ctx.readOnly);

    if (cm) {
      try {
        const mode = fmGuessCmMode(ctx && ctx.name, text);
        const isJson = !!(mode && typeof mode === 'object' && mode.json);
        const canLintJson = isJson && !!window.jsonlint;

        cm.setOption('mode', mode);
        cm.setOption('lint', canLintJson);
        cm.setOption('readOnly', ro ? 'nocursor' : false);

        cm.setValue(String(text || ''));
        cm.clearHistory();

        fmEditorKickRefresh(cm, true);
      } catch (e) {}
    } else if (ui.textarea) {
      ui.textarea.value = String(text || '');
      setTimeout(() => { try { ui.textarea.focus(); } catch (e) {} }, 0);
    }

    // Save button starts disabled; it becomes enabled only after edits (handled in cm.on('change')).
    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

    return true;
  }

  async function fmEditorRequestClose() {
    const ui = fmEditorEls();
    if (!ui) return;
    const has = !!FM_EDITOR.ctx;

    if (has && FM_EDITOR.dirty) {
      let ok = true;
      try {
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Несохранённые изменения',
            message: 'Закрыть файл без сохранения?',
            okText: 'Закрыть',
            cancelText: 'Отмена',
            danger: true,
          });
        } else {
          ok = window.confirm('Закрыть файл без сохранения?');
        }
      } catch (e) {
        ok = true;
      }
      if (!ok) return;
    }

    // Reset editor state
    try { FM_EDITOR.ctx = null; } catch (e) {}
    try { FM_EDITOR.dirty = false; } catch (e) {}
    try { FM_EDITOR.lastSaved = ''; } catch (e) {}

    modalClose(ui.modal);
  }

  function fmEditorDownload() {
    const ctx = FM_EDITOR.ctx;
    if (!ctx) return;

    const target = String(ctx.target || 'local');
    const path = String(ctx.path || '');
    const sid = String(ctx.sid || '');
    const name = String(ctx.name || 'download');

    const url = `/api/fs/download?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;
    xhrDownloadFile({ url, filenameHint: name, titleLabel: 'Download' });
  }

  async function fmEditorSave() {
    const ctx = FM_EDITOR.ctx;
    const ui = fmEditorEls();
    if (!ctx || !ui) return;
    if (ctx.readOnly) return;

    const cm = FM_EDITOR.cm;
    const text = cm ? String(cm.getValue() || '') : String((ui.textarea && ui.textarea.value) || '');
    try { if (ui.saveBtn) ui.saveBtn.disabled = true; } catch (e) {}

    const payload = { target: ctx.target, path: ctx.path, sid: ctx.sid || '', text };
    let out = null;
    try {
      const { res, data } = await fetchJson('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      out = { res, data };
    } catch (e) {
      out = null;
    }

    if (!out || !out.res || out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
      const errMsg = (out && out.data && out.data.error) ? String(out.data.error) : 'save_failed';
      fmEditorSetInfo({ err: 'Не удалось сохранить: ' + errMsg });
      try { toast('FM: не удалось сохранить файл', 'error'); } catch (e) {}
      try { if (ui.saveBtn) ui.saveBtn.disabled = false; } catch (e2) {}
      return;
    }

    // Update dirty state + refresh panels
    FM_EDITOR.lastSaved = text;
    FM_EDITOR.dirty = false;
    fmEditorSetInfo({ err: '' });
    try { toast('Сохранено: ' + (ctx.name || 'файл'), 'success'); } catch (e) {}

    try {
      if (ui.saveBtn) ui.saveBtn.disabled = true;
    } catch (e) {}

    try {
      if (ctx.side) await listPanel(ctx.side, { fromInput: true });
    } catch (e) {}
  }

  function wireEditorModal() {
    if (FM_EDITOR.wired) return;
    const ui = fmEditorEls();
    if (!ui) return;
    FM_EDITOR.wired = true;

    if (ui.cancelBtn) ui.cancelBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorRequestClose(); });
    if (ui.closeBtn) ui.closeBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorRequestClose(); });
    if (ui.downloadBtn) ui.downloadBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorDownload(); });
    if (ui.saveBtn) ui.saveBtn.addEventListener('click', (e) => { e.preventDefault(); fmEditorSave(); });

    // Backdrop click: НЕ закрываем редактор по клику вне окна.
    // Закрытие доступно через Esc или кнопки "Закрыть".
  }

  async function tryOpenItemInEditor(side, it, fullPath) {
    const name = safeName(it && it.name);
    if (!name) return false;
    const p = S.panels[side];
    if (!p) return false;
    const target = String(p.target || 'local');
    const sid = String(p.sid || '');

    // Quick extension heuristic (avoid calling read API for obvious binary blobs)
    const lower = name.toLowerCase();
    const ext = lower.includes('.') ? lower.split('.').pop() : '';
    const likelyText = ['txt','log','conf','cfg','ini','json','jsonc','yml','yaml','md','sh','bash','rules','list','lst','csv','tsv','xml','html','htm','js','ts','css','py','go','rs','java','c','h','cpp','hpp','sql','toml'].includes(ext);

    if (!likelyText) {
      // Still allow opening unknown extensions if they look small & harmless (best-effort).
      // We'll attempt read and fall back to download if backend says "not_text".
    }

    const url = `/api/fs/read?target=${encodeURIComponent(target)}&path=${encodeURIComponent(fullPath)}${target === 'remote' ? `&sid=${encodeURIComponent(sid)}` : ''}`;

    let out = null;
    try {
      out = await fetchJson(url, { method: 'GET' });
    } catch (e) {
      out = null;
    }

    if (!out || !out.res) return false;
    if (out.res.status === 415 && out.data && out.data.error === 'not_text') {
      return false;
    }
    if (out.res.status < 200 || out.res.status >= 300 || !(out.data && out.data.ok)) {
      const errMsg = (out.data && out.data.error) ? String(out.data.error) : `HTTP ${out.res.status}`;
      try { toast('FM: не удалось открыть файл: ' + errMsg, 'error'); } catch (e) {}
      return false;
    }

    const text = String(out.data.text || '');
    const truncated = !!out.data.truncated;
    const ctx = {
      target,
      sid: target === 'remote' ? sid : '',
      path: fullPath,
      name,
      side,
      truncated,
      readOnly: truncated, // avoid accidental overwrite of partial content
    };

    wireEditorModal();
    return fmEditorOpen(ctx, text);
  }

  async function openFocused(side) {
    const p = S.panels[side];
    if (!p) return;
    const it = getFocusedItem(side);
    if (!it) return;
    const type = String((it && it.type) || '');
    const linkDir = !!(it && it.link_dir);
    const isDir = type === 'dir' || (type === 'link' && linkDir);

    if (isDir) {
      if (p.target === 'local') {
        p.cwd = joinLocal(p.cwd, it.name);
      } else {
        p.cwd = joinRemote(p.cwd, it.name);
      }
      p.selected.clear();
      p.focusName = '';
      await listPanel(side, { fromInput: false });
      return;
    }

    // Symlink to directory? Some backends don't expose link_dir.
    // Try to open links as directories first; if it fails, fallback to file download.
    if (type === 'link') {
      const prevCwd = p.cwd;
      const prevFocus = p.focusName;
      const prevSel = new Set(p.selected || []);
      const nextCwd = (p.target === 'remote') ? joinRemote(prevCwd, it.name) : joinLocal(prevCwd, it.name);
      p.cwd = nextCwd;
      p.selected.clear();
      p.focusName = '';
      const ok = await listPanel(side, { fromInput: false });
      if (ok) return;
      // restore and continue as file
      p.cwd = prevCwd;
      p.focusName = prevFocus;
      p.selected = prevSel;
    }    // Files: open in built-in CodeMirror editor (for text) or download (binary/unknown).
    if (p.target === 'remote' && !p.sid) {
      toast('Открыть/скачать: remote без сессии', 'info');
      return;
    }

    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);

    // Try opening as text first (backend will refuse binary with 415 not_text).
    try {
      const opened = await tryOpenItemInEditor(side, it, fullPath);
      if (opened) return;
    } catch (e) {}

    const url = (p.target === 'remote')
      ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
      : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;
    xhrDownloadFile({ url, filenameHint: safeName(it.name), titleLabel: 'Download' });
  }

  async function downloadSelection(side) {
  const p = S.panels[side];
  if (!p) return;
  if (p.target === 'remote' && !p.sid) {
    toast('Download: remote без сессии', 'info');
    return;
  }
  const names = getSelectionNames(side);
  if (!names.length) return;

  // Multiple selection -> ZIP archive of selected files/folders.
  if (names.length > 1) {
    const items = [];
    for (const nm of names) {
      const it = (p.items || []).find(x => safeName(x && x.name) === safeName(nm));
      if (!it) continue;
      const type = String((it && it.type) || '');
      const linkDir = !!(it && it.link_dir);
      const isDir = (type === 'dir') || (type === 'link' && linkDir);
      const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
      items.push({ path: fullPath, name: safeName(it.name), is_dir: !!isDir });
    }
    if (!items.length) return;

    // Name archive based on current directory (nice UX), fallback to "selection".
    const cwd = String(p.cwd || '').trim();
    const base = (() => {
      if (p.target === 'remote') {
        const c = normRemotePath(cwd);
        if (!c || c === '.' || c === '/') return 'selection';
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

  // Directory: download as ZIP archive
  if (isDir) {
    const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
    const url = (p.target === 'remote')
      ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}&archive=zip`
      : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}&archive=zip`;
    xhrDownloadFile({ url, filenameHint: safeName(it.name) + '.zip', titleLabel: 'ZIP' });
    return;
  }

  const fullPath = (p.target === 'remote') ? joinRemote(p.cwd, it.name) : joinLocal(p.cwd, it.name);
  const url = (p.target === 'remote')
    ? `/api/fs/download?target=remote&sid=${encodeURIComponent(p.sid)}&path=${encodeURIComponent(fullPath)}`
    : `/api/fs/download?target=local&path=${encodeURIComponent(fullPath)}`;
  xhrDownloadFile({ url, filenameHint: safeName(it.name), titleLabel: 'Download' });
}

async function goUp(side) {
    const p = S.panels[side];
    if (!p) return;
    const cur = String(p.cwd || '');
    const cand = (p.target === 'local') ? parentLocal(cur) : parentRemote(cur);
    // Local FS is sandboxed by roots; don't navigate above allowed roots.
    if (p.target === 'local' && !isAllowedLocalPath(cand, p.roots)) {
      // At sandbox boundary. If multiple roots exist, cycle to the next root (handy on routers).
      const roots = Array.isArray(p.roots) ? p.roots.slice() : [];
      if (roots.length > 1) {
        // Pick the most specific root we are currently under.
        let curRoot = roots[0];
        for (const r of roots) {
          if (_isUnderRoot(cur, r) && String(r).length >= String(curRoot).length) curRoot = r;
        }
        const idx = roots.indexOf(curRoot);
        const next = roots[(idx + 1) % roots.length];
        if (next && next !== curRoot) {
          p.cwd = next;
          p.selected.clear();
          p.focusName = '';
          await listPanel(side, { fromInput: false });
        }
      }
      return;
    }
    p.cwd = cand;
    p.selected.clear();
    p.focusName = '';
    await listPanel(side, { fromInput: false });
  }

  // -------------------------- connect / disconnect --------------------------
  async function loadRemoteCaps() {
    try {
      const { res, data } = await fetchJson('/api/remotefs/capabilities', { method: 'GET' });
      if (res && res.ok && data && data.ok) {
        S.remoteCaps = data;
      }
    } catch (e) {}
  }

  function applyCapsToConnectModal() {
    const caps = S.remoteCaps;
    if (!caps || !caps.security) return;

    const hk = el('fm-hostkey-policy');
    const tls = el('fm-tls-verify');

    try {
      const sftp = caps.security.sftp || {};
      if (hk && Array.isArray(sftp.hostkey_policies)) {
        hk.innerHTML = '';
        sftp.hostkey_policies.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = String(p);
          opt.textContent = String(p);
          hk.appendChild(opt);
        });
        hk.value = String(sftp.default_policy || 'accept_new');
      }
    } catch (e) {}

    try {
      const ftps = caps.security.ftps || {};
      if (tls && Array.isArray(ftps.tls_verify_modes)) {
        tls.innerHTML = '';
        ftps.tls_verify_modes.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = String(m);
          opt.textContent = String(m);
          tls.appendChild(opt);
        });
        tls.value = String(ftps.default_mode || 'none');
      }
    } catch (e) {}
  }

  async function connectRemoteToSide(side) {
    S.connectForSide = side;

    // reset UI
    const errEl = el('fm-connect-error');
    const warnEl = el('fm-connect-warn');
    if (errEl) errEl.textContent = '';
    if (warnEl) { warnEl.textContent = ''; hide(warnEl); }

    applyCapsToConnectModal();
    modalOpen(el('fm-connect-modal'));

    // focus host
    setTimeout(() => {
      try { const h = el('fm-host'); h && h.focus(); } catch (e) {}
    }, 0);
  }

  async function doConnect() {
    const side = S.connectForSide;
    const p = S.panels[side];
    if (!p) return;

    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    const user = String((el('fm-user') && el('fm-user').value) || '').trim();
    const pass = String((el('fm-pass') && el('fm-pass').value) || '');

    const hkPolicy = String((el('fm-hostkey-policy') && el('fm-hostkey-policy').value) || 'accept_new');
    const tlsVerify = String((el('fm-tls-verify') && el('fm-tls-verify').value) || 'none');

    const errEl = el('fm-connect-error');
    const warnEl = el('fm-connect-warn');
    if (errEl) errEl.textContent = '';
    if (warnEl) { warnEl.textContent = ''; hide(warnEl); }

    if (!host) {
      if (errEl) errEl.textContent = 'Host обязателен';
      return;
    }
    if (!user) {
      if (errEl) errEl.textContent = 'User обязателен';
      return;
    }
    if (!pass) {
      if (errEl) errEl.textContent = 'Password обязателен';
      return;
    }

    let port = null;
    try {
      if (portRaw) port = parseInt(portRaw, 10);
    } catch (e) { port = null; }

    const options = {};
    if (proto === 'sftp') {
      options.hostkey_policy = hkPolicy;
      // server also accepts legacy sftp:auto-confirm, but we are using new model.
    }
    if (proto === 'ftps') {
      // Backend expects tls_verify_mode
      options.tls_verify_mode = tlsVerify;
    }

    const payload = {
      protocol: proto,
      host,
      port: port || undefined,
      username: user,
      auth: { type: 'password', password: pass },
      options,
    };

    const { res, data } = await fetchJson('/api/remotefs/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res || !res.ok || !data) {
      if (errEl) errEl.textContent = 'connect_failed';
      return;
    }

    if (!data.ok) {
      const msg = String(data.error || data.message || 'connect_failed');
      if (errEl) errEl.textContent = msg;
      if (data && data.hint && warnEl) {
        warnEl.textContent = String(data.hint);
        show(warnEl);
      }
      return;
    }

    // Warnings (security policy etc.)
    if (Array.isArray(data.warnings) && data.warnings.length && warnEl) {
      warnEl.textContent = data.warnings.map(String).join('\n');
      show(warnEl);
    }

    p.target = 'remote';
    p.sid = String(data.session_id || '');
    // Use '.' as home for maximum compatibility (some SFTP servers/chroots do not expose '/').
    p.cwd = '.';
    p.items = [];
    p.selected.clear();
    p.focusName = '';

    modalClose(el('fm-connect-modal'));

    toast('Подключено: ' + user + '@' + host, 'success');
    renderPanel(side);
    await listPanel(side, { fromInput: false });
  }

  async function disconnectSide(side) {
    const p = S.panels[side];
    if (!p || !p.sid) return;

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({ title: 'Disconnect', message: 'Отключиться от текущего удалённого сервера?', okText: 'Disconnect', cancelText: 'Отмена', danger: false })
      : Promise.resolve(window.confirm('Disconnect?')));

    if (!ok) return;

    const sid = p.sid;
    await fetchJson(`/api/remotefs/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    p.sid = '';
    p.items = [];
    p.selected.clear();
    p.focusName = '';
    renderPanel(side);
    toast('Отключено', 'info');
  }

  // -------------------------- fileops --------------------------
  function buildCopyMovePayload(op, srcSide, dstSide, opts) {
    const src = S.panels[srcSide];
    const dst = S.panels[dstSide];

    const names = getSelectionNames(srcSide);
    const sources = names.map((n) => ({
      path: (src.target === 'remote') ? joinRemote(src.cwd, n) : joinLocal(src.cwd, n),
      name: n,
      is_dir: !!(src.items || []).find((it) => safeName(it && it.name) === n && String(it.type) === 'dir'),
    }));

    const payload = {
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
      sources, // optional, but backend will normalize anyway
      options: Object.assign({ overwrite: 'ask' }, opts || {}),
    };

    return payload;
  }

  function buildDeletePayload(side, opts) {
    const p = S.panels[side];
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
    try {
      if (S.ws.socket) {
        S.ws.socket.close();
      }
    } catch (e) {}
    try { if (S.ws.pollTimer) clearInterval(S.ws.pollTimer); } catch (e) {}
    S.ws.pollTimer = null;
    S.ws.socket = null;
    S.ws.jobId = '';
    S.ws.token = '';
  }

  function updateProgressModal(job) {
    const title = el('fm-progress-title');
    const bar = el('fm-progress-bar-inner');
    const meta = el('fm-progress-meta');
    const details = el('fm-progress-details');
    const err = el('fm-progress-error');

    _ensureProgressDetailsToggle();
    if (err) err.textContent = '';

    try {
      const op = String(job.op || 'op');
      const st = String(job.state || '');
      const stLower = st.toLowerCase();
      // Details button should appear only on failure.
      _setProgressDetailsAvailable(stLower === 'error');
      // Disable cancel once finished.
      try {
        const cbtn = el('fm-progress-cancel-btn');
        if (cbtn) cbtn.disabled = (stLower === 'done' || stLower === 'error' || stLower === 'canceled');
      } catch (e) {}
      // Auto-close modal after successful completion.
      if (stLower === 'done') {
        _clearProgressAutoClose();
        _scheduleProgressAutoClose(650);
      } else {
        _clearProgressAutoClose();
      }

      const jobId = String(job.job_id || '');
      const cur = job.progress && job.progress.current ? job.progress.current : null;
      const curName = cur && cur.name ? String(cur.name) : '';
      const curPhase = cur && cur.phase ? String(cur.phase) : '';

      if (title) {
        const t = op.toUpperCase() + ' — ' + st + (curName ? (' — ' + curName) : '');
        title.textContent = t;
      }

      const bytesDone = Number(job.progress && job.progress.bytes_done || 0);
      const bytesTotal = Number(job.progress && job.progress.bytes_total || 0);
      const filesDone = Number(job.progress && job.progress.files_done || 0);
      const filesTotal = Number(job.progress && job.progress.files_total || 0);

      const pct = (bytesTotal > 0) ? Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100))) : (filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0);
      if (bar) bar.style.width = pct + '%';

      if (meta) {
        const parts = [];
        if (curPhase) parts.push('phase: ' + curPhase);
        if (filesTotal > 0) parts.push(`files: ${filesDone}/${filesTotal}`);
        if (bytesTotal > 0) parts.push(`bytes: ${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)} (${pct}%)`);

        // Speed + ETA (best-effort, based on client-side delta between WS updates)
        try {
          if (jobId && bytesTotal > 0 && (st === 'running' || st === 'queued')) {
            const now = _nowMs();
            const prev = S.jobStats[jobId] || { lastTsMs: 0, lastBytes: 0, speed: 0 };
            const dt = Math.max(1, now - (prev.lastTsMs || now));
            const db = Math.max(0, bytesDone - (prev.lastBytes || 0));
            const inst = (db * 1000) / dt;
            const speed = prev.speed ? (prev.speed * 0.75 + inst * 0.25) : inst;
            S.jobStats[jobId] = { lastTsMs: now, lastBytes: bytesDone, speed };
            const sp = _fmtSpeed(speed);
            if (sp) parts.push(sp);
            if (speed > 1 && bytesDone <= bytesTotal) {
              const eta = (bytesTotal - bytesDone) / speed;
              const et = _fmtEta(eta);
              if (et) parts.push('ETA ' + et);
            }
          }
        } catch (e) {}
        meta.textContent = parts.join('   ');
      }

      if (details) {
        // Keep raw JSON available behind the Details toggle.
        details.textContent = JSON.stringify(job, null, 2);
      }

      if (job.state === 'error' && err) {
        err.textContent = String(job.error || (job.last_error && job.last_error.message) || 'error');
      }
    } catch (e) {
      if (details) details.textContent = '';
    }
  }

  async function startJobPolling(jobId) {
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
              const label = (op === 'copy') ? 'Копирование' : (op === 'move' ? 'Перемещение' : (op === 'delete' ? 'Удаление' : 'Операция'));
              if (st === 'done') toast(label + ': завершено', 'success');
              else if (st === 'canceled') toast(label + ': отменено', 'info');
              else if (st === 'error') toast(label + ': ошибка', 'error');
            } catch (e3) {}

            setTimeout(() => {
              refreshAll();
            }, 300);
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
            // Toast job result
            try {
              const job = msg.job || {};
              const op = String(job.op || '').toLowerCase();
              const st = String(job.state || '').toLowerCase();
              const label = (op === 'copy') ? 'Копирование' : (op === 'move' ? 'Перемещение' : (op === 'delete' ? 'Удаление' : 'Операция'));
              if (st === 'done') toast(label + ': завершено', 'success');
              else if (st === 'canceled') toast(label + ': отменено', 'info');
              else if (st === 'error') toast(label + ': ошибка', 'error');
            } catch (e) {}
            // refresh panels on finish
            setTimeout(() => {
              refreshAll();
            }, 300);
          }
        }
      } catch (e) {}
    };

    ws.onerror = () => {
      // Keep it quiet.
    };

    ws.onclose = () => {
      try { clearTimeout(fallbackTimer); } catch (e) {}
      if (!finished) {
        // If WS is unavailable (no gevent) or connection dropped, fall back to HTTP polling.
        startFallback();
      }
    };
  }

  async function cancelJob(jobId) {
    if (!jobId) return;
    await fetchJson(`/api/fileops/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  }


function _deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
}

async function runCopyMoveWithPayload(op, basePayload) {
  if (!basePayload) return;

  // Dry-run first to collect conflicts (same UX as F5/F6).
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

  // Conflicts via legacy 409 path
  if (res && res.status === 409 && data && data.error === 'conflicts') {
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    S.pending = { op, basePayload: _deepClone(basePayload), conflicts };
    try { S.pending.basePayload.options = Object.assign({}, S.pending.basePayload.options || {}, { overwrite: 'ask' }); } catch (e) {}
    renderConflicts(conflicts);
    modalOpen(el('fm-conflicts-modal'));
    return;
  }

  // Server may not support dry_run -> just execute.
  const execPayload = _deepClone(basePayload);
  execPayload.op = op;
  execPayload.options = Object.assign({}, execPayload.options || {}, { overwrite: 'replace' });
  try { delete execPayload.options.dry_run; } catch (e) {}
  await executeJob(execPayload);
}

  async function runCopyMove(op) {
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
    // Old behavior could attempt overwrite of the same path and lead to data loss on replace.
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

        // Propose "name (2).ext", "name (3).ext"…
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
        payload.dst = Object.assign({}, payload.dst || {}, {
          path: (dst.target === 'remote') ? joinRemote(dst.cwd, newName) : joinLocal(dst.cwd, newName),
          is_dir: false,
        });

        await runCopyMoveWithPayload('copy', payload);
        return;
      }
    } catch (e) {}

    const payload = buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask', dry_run: true });

    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res && res.ok && data && data.ok && data.dry_run) {
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      if (conflicts.length) {
        // Show conflicts modal
        S.pending = {
          op,
          basePayload: buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'ask' }),
          conflicts,
        };
        renderConflicts(conflicts);
        modalOpen(el('fm-conflicts-modal'));
        return;
      }
      // No conflicts -> execute directly
      await executeJob(buildCopyMovePayload(op, srcSide, dstSide, { overwrite: 'replace' }));
      return;
    }

    // If server doesn't support dry_run or returns 409 conflicts
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

    toast('copy/move failed', 'error');
  }

  async function executeJob(payload) {
    const { res, data } = await fetchJson('/api/fileops/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res || !data) {
      toast('job_failed', 'error');
      return;
    }

    if (!res.ok || !data.ok) {
      const msg = String(data.error || data.message || 'job_failed');
      toast(msg, 'error');
      return;
    }

    const jobId = String(data.job_id || '');
    if (!jobId) {
      toast('job_id missing', 'error');
      return;
    }

    // Show progress modal
    _ensureProgressDetailsToggle();
    _setProgressDetailsAvailable(false);
    _clearProgressAutoClose();
    modalOpen(el('fm-progress-modal'));
    updateProgressModal(data.job || { op: payload.op, state: 'queued', progress: {} });

    await watchJob(jobId);
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

    conflicts.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'fm-conflicts-row';
      const src = safeName(c.src_path || c.src_name || '');
      const dst = safeName(c.dst_path || '');
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

  async function runDelete() {
    const side = S.activeSide;
    const p = S.panels[side];
    if (!p) return;
    if (p.target === 'remote' && !p.sid) {
      toast('Удаление: remote без сессии', 'info');
      return;
    }

    const names = getSelectionNames(side);
    if (!names.length) return;

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({ title: 'Delete', message: `Удалить (${names.length})?\n${names.slice(0, 6).join('\n')}${names.length > 6 ? '\n…' : ''}`, okText: 'Delete', cancelText: 'Отмена', danger: true })
      : Promise.resolve(window.confirm('Delete?')));

    if (!ok) return;

    const payload = buildDeletePayload(side, {});
    await executeJob(payload);

    // Optimistic UI: clear selection
    p.selected.clear();
  }

  // -------------------------- ops list modal --------------------------
  function renderOpsList(jobs) {
    const box = el('fm-ops-list');
    if (!box) return;

    box.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'fm-ops-table';

    const head = document.createElement('div');
    head.className = 'fm-ops-row fm-ops-head';
    head.innerHTML = '<div>Job</div><div>Op</div><div>State</div><div>Progress</div><div></div>';
    list.appendChild(head);

    (jobs || []).forEach((j) => {
      const row = document.createElement('div');
      row.className = 'fm-ops-row';

      const jobId = safeName(j.job_id || '');
      const op = safeName(j.op || '');
      const st = safeName(j.state || '');
      const pr = j.progress || {};
      const filesDone = Number(pr.files_done || 0);
      const filesTotal = Number(pr.files_total || 0);
      const bytesDone = Number(pr.bytes_done || 0);
      const bytesTotal = Number(pr.bytes_total || 0);
      const pct = (bytesTotal > 0) ? Math.round((bytesDone / bytesTotal) * 100) : (filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0);
      const progText = `${pct}%`;

      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '8px';
      btns.style.justifyContent = 'flex-end';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-secondary';
      openBtn.textContent = 'Open';
      openBtn.onclick = async () => {
        modalClose(el('fm-ops-modal'));
        modalOpen(el('fm-progress-modal'));
        updateProgressModal(j);
        await watchJob(jobId);
      };
      btns.appendChild(openBtn);

      if (st === 'running' || st === 'queued') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => cancelJob(jobId);
        btns.appendChild(cancelBtn);
      }

      row.appendChild((() => { const d = document.createElement('div'); d.textContent = jobId.slice(0, 8) + (jobId.length > 8 ? '…' : ''); d.title = jobId; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = op; return d; })());
      row.appendChild((() => { const d = document.createElement('div'); d.textContent = st; return d; })());
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

  // -------------------------- init wiring --------------------------
  function wirePanel(side) {
    const pd = panelDom(side);
    const p = S.panels[side];
    if (!pd || !p) return;

    pd.root.addEventListener('click', () => setActiveSide(side));

    if (pd.targetSelect) {
      pd.targetSelect.addEventListener('change', async () => {
        const v = String(pd.targetSelect.value || 'local');
        if (v === 'remote') {
          p.target = 'remote';
          // no session => show connect
          renderPanel(side);
          if (!p.sid) {
            await connectRemoteToSide(side);
          } else {
            await listPanel(side, { fromInput: true });
          }
          return;
        }
        p.target = 'local';
        // keep cwd sane
        p.sid = '';
        if (!p.cwd) p.cwd = '/opt/var';
        await listPanel(side, { fromInput: true });
      });
    }

    if (pd.connectBtn) {
      pd.connectBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await connectRemoteToSide(side);
      });
    }

    if (pd.disconnectBtn) {
      pd.disconnectBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await disconnectSide(side);
      });
    }

    if (pd.upBtn) {
      pd.upBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await goUp(side);
      });
    }

    if (pd.refreshBtn) {
      pd.refreshBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await listPanel(side, { fromInput: true });
      });
    }

    if (pd.pathInput) {
      pd.pathInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          await listPanel(side, { fromInput: true });
        }
      });
    }

    if (pd.list) {
      pd.list.addEventListener('click', async (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        if (!row) return;
        const name = String(row.dataset.name || '');
        setActiveSide(side);

        const p = S.panels[side];
        if (!p) return;

        const clickCheckbox = !!(e.target && e.target.closest && (e.target.closest('input.fm-check-input') || e.target.closest('.fm-cell.fm-check')));
        const isMulti = !!(e.ctrlKey || e.metaKey || clickCheckbox);
        const isShift = !!e.shiftKey;

        if (isShift) {
          if (!p.anchorName) p.anchorName = p.focusName || name;
          const anchor = p.anchorName || name;
          selectRange(side, anchor, name, isMulti);
        } else {
          if (!isMulti) {
            clearSelectionExcept(side, name);
          } else {
            if (p.selected.has(name)) p.selected.delete(name); else p.selected.add(name);
          }
          // Anchor is updated only on non-shift actions
          p.anchorName = name;
        }

        p.focusName = name;
        renderPanel(side);
        try { pd.list && pd.list.focus(); } catch (e2) {}

        // Double-click: open only on a plain row click (no Ctrl/Meta/Shift and not on checkbox).
        if (!isMulti && !isShift && !clickCheckbox && Number(e.detail || 0) >= 2) {
          await openFocused(side);
        }
      });


      // ПКМ (context menu)
      pd.list.addEventListener('contextmenu', (e) => {
        if (!e) return;
        if (!isFilesViewVisible()) return;

        try { wireCtxMenuGlobal(); } catch (e0) {}

        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        const isHeader = !!(row && row.classList && row.classList.contains('fm-row-header'));
        const name = (!row || isHeader) ? '' : String(row.dataset.name || '');
        const isDir = !!(row && row.classList && row.classList.contains('is-dir'));

        setActiveSide(side);

        // When right-clicking an item: focus it; if it's not selected, make it the only selection.
        try {
          if (name) {
            if (!p.selected.has(name)) {
              clearSelectionExcept(side, name);
              p.selected.add(name);
            }
            p.focusName = name;
            p.anchorName = name;
            renderPanel(side);
          }
        } catch (e2) {}

        try { e.preventDefault(); e.stopPropagation(); } catch (e3) {}

        showCtxMenu({
          side,
          hasRow: !!name,
          name,
          isDir,
          x: e.clientX,
          y: e.clientY,
        });
      }, true);

      // NOTE: no native dblclick handler here — see click handler above.

      pd.list.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusNext(side, +1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusNext(side, -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          await openFocused(side);
        }
      });

      // Drag & Drop:
      // - OS file drop -> upload into this panel (XHR progress).
      // - FM row drag between panels -> move (Ctrl -> copy).
      const hasFiles = (dt) => {
        try {
          const types = Array.from((dt && dt.types) || []);
          if (types.includes('Files')) return true;
        } catch (e) {}
        try { return !!(dt && dt.files && dt.files.length); } catch (e) { return false; }
      };

      const hasInternalFm = (dt) => {
        try {
          const types = Array.from((dt && dt.types) || []);
          return types.includes('application/x-xkeen-fm') || types.includes('text/x-xkeen-fm');
        } catch (e) {
          return false;
        }
      };

      const getInternalFm = (dt) => {
        let raw = '';
        try { raw = dt.getData('application/x-xkeen-fm') || ''; } catch (e) {}
        if (!raw) { try { raw = dt.getData('text/x-xkeen-fm') || ''; } catch (e) {} }
        if (!raw) { try { raw = dt.getData('text/plain') || ''; } catch (e) {} }
        raw = String(raw || '');
        if (raw.startsWith('xkeen-fm:')) raw = raw.slice('xkeen-fm:'.length);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      };

      const clearDropUi = () => {
        try { qsa('.fm-list.is-drop-target', el('fm-root')).forEach((n) => n.classList.remove('is-drop-target')); } catch (e) {}
        try { qsa('.fm-row.is-drop-target', el('fm-root')).forEach((n) => n.classList.remove('is-drop-target')); } catch (e) {}
      };

      const setDropUi = (overRow) => {
        clearDropUi();
        try { pd.list.classList.add('is-drop-target'); } catch (e) {}
        if (overRow && overRow.classList && overRow.classList.contains('is-dir')) {
          try { overRow.classList.add('is-drop-target'); } catch (e) {}
        }
      };

      // Start drag from file rows
      pd.list.addEventListener('dragstart', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        if (!row || row.classList.contains('fm-row-header')) return;
        const name = String(row.dataset.name || '');
        if (!name) return;
        const p = S.panels[side];
        if (!p) return;

        // Drag selection if dragging a selected item, otherwise drag only the hovered row.
        const sel = Array.from(p.selected || []);
        const names = (sel.length && sel.indexOf(name) >= 0) ? sel : [name];

        const payload = {
          kind: 'xkeen-fm',
          v: 1,
          srcSide: side,
          src: {
            target: p.target,
            sid: (p.target === 'remote') ? (p.sid || '') : '',
            cwd: p.cwd,
          },
          names,
        };

        try { e.dataTransfer.effectAllowed = 'copyMove'; } catch (e2) {}
        try { e.dataTransfer.setData('application/x-xkeen-fm', JSON.stringify(payload)); } catch (e2) {}
        try { e.dataTransfer.setData('text/x-xkeen-fm', JSON.stringify(payload)); } catch (e2) {}
        try { e.dataTransfer.setData('text/plain', 'xkeen-fm:' + JSON.stringify(payload)); } catch (e2) {}
        try { setActiveSide(side); } catch (e2) {}
      });

      pd.list.addEventListener('dragend', () => {
        clearDropUi();
      });

      pd.list.addEventListener('dragover', (e) => {
        if (!e || !e.dataTransfer) return;

        // OS file upload drop
        if (hasFiles(e.dataTransfer)) {
          e.preventDefault();
          return;
        }

        // Internal FM DnD
        if (!hasInternalFm(e.dataTransfer)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch (e2) {}

        const overRow = e.target && e.target.closest ? e.target.closest('.fm-row.is-dir[data-name]') : null;
        setDropUi(overRow);
      });

      pd.list.addEventListener('dragleave', (e) => {
        // Clear highlight when leaving list area
        try {
          const rt = e.relatedTarget;
          if (!rt || (rt !== pd.list && !pd.list.contains(rt))) clearDropUi();
        } catch (e2) {
          clearDropUi();
        }
      });

      pd.list.addEventListener('drop', async (e) => {
        if (!e || !e.dataTransfer) return;

        // Internal FM DnD
        if (hasInternalFm(e.dataTransfer) && !hasFiles(e.dataTransfer)) {
          e.preventDefault();
          clearDropUi();

          const drag = getInternalFm(e.dataTransfer);
          if (!drag || !Array.isArray(drag.names) || !drag.names.length) return;

          const srcSide = String(drag.srcSide || '');
          const dstSide = side;
          if (srcSide !== 'left' && srcSide !== 'right') return;

          const srcPanel = S.panels[srcSide];
          const dstPanel = S.panels[dstSide];
          if (!srcPanel || !dstPanel) return;

          const srcInfo = drag.src || {};
          const srcTarget = String(srcInfo.target || srcPanel.target || '');
          const srcSid = String(srcInfo.sid || (srcPanel.target === 'remote' ? srcPanel.sid : '') || '');
          const srcCwd = (srcInfo.cwd != null) ? String(srcInfo.cwd) : String(srcPanel.cwd || '');

          // Validate remote sessions
          if (srcTarget === 'remote' && !srcSid) {
            toast('Источник: remote без сессии', 'info');
            return;
          }
          if (dstPanel.target === 'remote' && !dstPanel.sid) {
            toast('Назначение: remote без сессии', 'info');
            return;
          }

          // Destination dir: panel cwd; if dropped onto a directory row -> that directory.
          let dstPath = String(dstPanel.cwd || '');
          const dropRow = e.target && e.target.closest ? e.target.closest('.fm-row.is-dir[data-name]') : null;
          if (dropRow) {
            const dn = String(dropRow.dataset.name || '');
            if (dn) {
              dstPath = (dstPanel.target === 'remote') ? joinRemote(dstPanel.cwd, dn) : joinLocal(dstPanel.cwd, dn);
            }
          }

          const names = Array.from(drag.names || []).map((x) => safeName(x)).filter((x) => !!x);

          const srcItems = Array.from((srcPanel.items || []));
          const sources = names.map((n) => {
            const it = srcItems.find((x) => safeName(x && x.name) === n) || null;
            const t = String((it && it.type) || '');
            const isDir = (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
            const abs = (srcTarget === 'remote') ? joinRemote(srcCwd, n) : joinLocal(srcCwd, n);
            return { path: abs, name: n, is_dir: !!isDir };
          });

          const defaultOp = e.ctrlKey ? 'copy' : 'move';

          // Ask user what to do (Move or Copy) — this is more reliable than Ctrl on some browsers/devices.
          const srcLabel = _panelLabel(srcSide, srcTarget, srcSid, srcCwd);
          const dstLabel = _panelLabel(dstSide, dstPanel.target, (dstPanel.target === 'remote') ? dstPanel.sid : '', dstPath);
          const chosenOp = await openDropOpModal({ defaultOp, names, srcLabel, dstLabel });
          if (!chosenOp) return;
          const op = chosenOp;

          // Safety: prevent pointless move/copy into the same folder when dropping onto panel background.
          try {
            const sameLocalDir = (srcTarget === 'local' && dstPanel.target === 'local'
              && _trimSlashes(String(srcCwd || '')) === _trimSlashes(String(dstPath || '')));
            const sameRemoteDir = (srcTarget === 'remote' && dstPanel.target === 'remote'
              && String(srcSid || '') === String(dstPanel.sid || '')
              && normRemotePath(String(srcCwd || '')) === normRemotePath(String(dstPath || '')));
            if (sameLocalDir || sameRemoteDir) {
              if (op === 'move') toast('Источник и назначение совпадают (move — нечего делать)', 'info');
              else toast('Копирование в тот же каталог через Drag&Drop не поддерживается. Выберите другой каталог назначения или используйте F5.', 'info');
              return;
            }
          } catch (e2) {}

          const payload = {
            op,
            src: {
              target: srcTarget,
              sid: (srcTarget === 'remote') ? srcSid : undefined,
              cwd: srcCwd,
              paths: names,
            },
            dst: {
              target: dstPanel.target,
              sid: (dstPanel.target === 'remote') ? dstPanel.sid : undefined,
              path: dstPath,
              is_dir: true,
            },
            sources,
            options: { overwrite: 'ask' },
          };

          await runCopyMoveWithPayload(op, payload);
          return;
        }

        // OS file drop -> upload into this panel (XHR progress).
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (!files.length) return;
        xhrUploadFiles({ side, files });
      });

    }
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

  // -------------------------- Drag&Drop: choose Move or Copy --------------------------
  function _panelLabel(side, target, sid, path) {
    const s = String(side || '').toUpperCase();
    const t = String(target || 'local');
    const r = (t === 'remote' && sid) ? ` (${sid})` : '';
    const p = String(path || '');
    return `${s} • ${t}${r} • ${p}`;
  }

  function _setDropOpButtonsDefault(defaultOp) {
    const copyBtn = el('fm-dropop-copy-btn');
    const moveBtn = el('fm-dropop-move-btn');
    if (!copyBtn || !moveBtn) return;
    const op = String(defaultOp || 'move').toLowerCase();
    if (op === 'copy') {
      try { copyBtn.classList.add('btn-primary'); copyBtn.classList.remove('btn-secondary'); } catch (e) {}
      try { moveBtn.classList.add('btn-secondary'); moveBtn.classList.remove('btn-primary'); } catch (e) {}
    } else {
      try { moveBtn.classList.add('btn-primary'); moveBtn.classList.remove('btn-secondary'); } catch (e) {}
      try { copyBtn.classList.add('btn-secondary'); copyBtn.classList.remove('btn-primary'); } catch (e) {}
    }
  }

  function closeDropOpModal(result) {
    const modal = el('fm-dropop-modal');
    try { modalClose(modal); } catch (e) {}
    const r = S.dropOp && S.dropOp.resolve;
    try { if (S.dropOp) S.dropOp.resolve = null; } catch (e) {}
    if (typeof r === 'function') {
      try { r(result); } catch (e) {}
    }
  }

  function openDropOpModal(opts) {
    const o = opts || {};
    const modal = el('fm-dropop-modal');
    const defaultOp = String(o.defaultOp || 'move').toLowerCase() === 'copy' ? 'copy' : 'move';
    if (!modal) return Promise.resolve(defaultOp);

    // Cancel previous pending choice (if any)
    try { if (S.dropOp && typeof S.dropOp.resolve === 'function') S.dropOp.resolve(null); } catch (e) {}

    const names = Array.isArray(o.names) ? o.names : [];
    const srcLabel = String(o.srcLabel || '');
    const dstLabel = String(o.dstLabel || '');

    const textEl = el('fm-dropop-text');
    const listEl = el('fm-dropop-list');

    if (textEl) {
      try { textEl.style.whiteSpace = 'pre-wrap'; } catch (e) {}
      const n = names.length;
      const head = n === 1 ? '1 элемент' : `${n} элементов`;
      textEl.textContent = `Источник: ${srcLabel}
Назначение: ${dstLabel}
Действие для ${head}?`;
    }

    if (listEl) {
      const showN = 12;
      const shown = names.slice(0, showN);
      listEl.textContent = shown.join('\n') + (names.length > showN ? '\n…' : '');
    }

    _setDropOpButtonsDefault(defaultOp);

    return new Promise((resolve) => {
      try { if (S.dropOp) S.dropOp.resolve = resolve; } catch (e) {}
      modalOpen(modal);
      // Focus default button
      try {
        setTimeout(() => {
          const b = (defaultOp === 'copy') ? el('fm-dropop-copy-btn') : el('fm-dropop-move-btn');
          b && b.focus && b.focus();
        }, 0);
      } catch (e) {}
    });
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

  function wireModals() {
    // editor modal buttons
    wireEditorModal();

    // connect modal buttons
    const connectOk = el('fm-connect-ok-btn');
    const connectCancel = el('fm-connect-cancel-btn');
    const connectClose = el('fm-connect-close-btn');

    const closeConnect = () => modalClose(el('fm-connect-modal'));

    if (connectOk) connectOk.addEventListener('click', (e) => { e.preventDefault(); doConnect(); });
    if (connectCancel) connectCancel.addEventListener('click', (e) => { e.preventDefault(); closeConnect(); });
    if (connectClose) connectClose.addEventListener('click', (e) => { e.preventDefault(); closeConnect(); });

    const modal = el('fm-connect-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeConnect();
      });
    }

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

    // drag&drop move/copy modal
    const dropMove = el('fm-dropop-move-btn');
    const dropCopy = el('fm-dropop-copy-btn');
    const dropCancel = el('fm-dropop-cancel-btn');
    const dropClose = el('fm-dropop-close-btn');

    if (dropMove) dropMove.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal('move'); });
    if (dropCopy) dropCopy.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal('copy'); });
    if (dropCancel) dropCancel.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal(null); });
    if (dropClose) dropClose.addEventListener('click', (e) => { e.preventDefault(); closeDropOpModal(null); });

    const dom = el('fm-dropop-modal');
    if (dom) dom.addEventListener('click', (e) => { if (e.target === dom) closeDropOpModal(null); });

    // conflicts modal
    const cOk = el('fm-conflicts-ok-btn');
    const cCancel = el('fm-conflicts-cancel-btn');
    const cClose = el('fm-conflicts-close-btn');
    const closeConflicts = () => { S.pending = null; modalClose(el('fm-conflicts-modal')); };

    if (cOk) cOk.addEventListener('click', (e) => { e.preventDefault(); applyConflictsAndContinue(); });
    if (cCancel) cCancel.addEventListener('click', (e) => { e.preventDefault(); closeConflicts(); });
    if (cClose) cClose.addEventListener('click', (e) => { e.preventDefault(); closeConflicts(); });

    const cm = el('fm-conflicts-modal');
    if (cm) cm.addEventListener('click', (e) => { if (e.target === cm) closeConflicts(); });

    // progress modal
    const pOk = el('fm-progress-ok-btn');
    const pCancel = el('fm-progress-cancel-btn');
    const pClose = el('fm-progress-close-btn');
    const closeProgress = () => { _clearProgressAutoClose(); modalClose(el('fm-progress-modal')); };

    if (pOk) pOk.addEventListener('click', (e) => { e.preventDefault(); closeProgress(); });
    if (pClose) pClose.addEventListener('click', (e) => { e.preventDefault(); closeProgress(); });
    if (pCancel) pCancel.addEventListener('click', async (e) => {
      e.preventDefault();
      // If an XHR transfer is active, abort it first.
      try {
        if (S.transfer && S.transfer.xhr) {
          S.transfer.xhr.abort();
          try { _finishTransferUi({ ok: false, message: 'Отменено', showDetails: false, detailsText: 'Отменено пользователем' }); } catch (e3) {}
          return;
        }
      } catch (e2) {}
      const jobId = S.ws.jobId;
      if (jobId) await cancelJob(jobId);
    });

    const pm = el('fm-progress-modal');
    if (pm) pm.addEventListener('click', (e) => { if (e.target === pm) closeProgress(); });

    // ops modal
    const opsBtn = el('fm-ops-btn');
    const opsClose = el('fm-ops-close-btn');
    const opsRefresh = el('fm-ops-refresh-btn');

    if (opsBtn) opsBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await refreshOpsList();
      modalOpen(el('fm-ops-modal'));
    });
    if (opsClose) opsClose.addEventListener('click', (e) => { e.preventDefault(); modalClose(el('fm-ops-modal')); });
    if (opsRefresh) opsRefresh.addEventListener('click', (e) => { e.preventDefault(); refreshOpsList(); });

    const om = el('fm-ops-modal');
    if (om) om.addEventListener('click', (e) => { if (e.target === om) modalClose(om); });

    // refresh all
    const refreshAllBtn = el('fm-refresh-all-btn');
    if (refreshAllBtn) refreshAllBtn.addEventListener('click', (e) => { e.preventDefault(); refreshAll(); });



    // help
    const helpBtn = el('fm-help-btn');
    const helpClose = el('fm-help-close-btn');
    const helpOk = el('fm-help-ok-btn');
    if (helpBtn) helpBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (e2) {}
      modalOpen(el('fm-help-modal'));
    });
    if (helpClose) helpClose.addEventListener('click', (e) => { e.preventDefault(); modalClose(el('fm-help-modal')); });
    if (helpOk) helpOk.addEventListener('click', (e) => { e.preventDefault(); modalClose(el('fm-help-modal')); });

    const hm = el('fm-help-modal');
    if (hm) hm.addEventListener('click', (e) => { if (e.target === hm) modalClose(hm); });
    // ESC closes our modals (best-effort)
    document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape') return;
      // Close top-most opened FM modal
      let closedAny = false;

      // Editor modal has its own unsaved-changes logic.
      const em = el('fm-editor-modal');
      if (em && !em.classList.contains('hidden')) {
        try { fmEditorRequestClose(); } catch (e0) {}
        closedAny = true;
      }

      // Drop operation modal must resolve the pending promise.
      const dm = el('fm-dropop-modal');
      if (dm && !dm.classList.contains('hidden')) {
        closeDropOpModal(null);
        closedAny = true;
      }

      ['fm-help-modal', 'fm-ops-modal', 'fm-progress-modal', 'fm-conflicts-modal', 'fm-rename-modal', 'fm-create-modal', 'fm-connect-modal'].forEach((id) => {
        const m = el(id);
        if (m && !m.classList.contains('hidden')) {
          modalClose(m);
          closedAny = true;
        }
      });

      // If no modal was closed, treat ESC as "exit fullscreen".
      try {
        if (!closedAny && fmIsFullscreen && isFilesViewVisible() && !isTextInputActive() && !document.querySelector('.modal:not(.hidden)')) {
          fmSetFullscreen(false);
        }
      } catch (e2) {}
    });
  }

  function wireHeaderActions() {
    const view = el('view-files');
    const actions = view ? qs('.fm-header-actions', view) : null;
    if (!actions) return;

    // Fullscreen toggle (similar UX to terminal)
    if (!el('fm-fullscreen-btn')) {
      const fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'btn-secondary';
      fsBtn.id = 'fm-fullscreen-btn';
      fsBtn.textContent = '⛶';
      fsBtn.title = 'Полный экран';
      fsBtn.setAttribute('aria-label', 'Полный экран');
      fsBtn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        fmToggleFullscreen();
      });
      try {
        actions.insertBefore(fsBtn, actions.firstChild);
      } catch (e) {
        try { actions.appendChild(fsBtn); } catch (e2) {}
      }
    }

    // Ensure button state matches current DOM state.
    try {
      const card = fmCardEl();
      fmIsFullscreen = !!(card && card.classList && card.classList.contains('is-fullscreen'));
      updateFmFullscreenBtn();
    } catch (e) {}

    // Create folder / file buttons
    if (!el('fm-mkdir-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-mkdir-btn';
      b.textContent = '➕ Папка';
      b.title = 'Создать папку в активной панели';
      b.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        openCreateModal('dir');
      });
      try { actions.appendChild(b); } catch (e2) {}
    }

    if (!el('fm-touch-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-touch-btn';
      b.textContent = '➕ Файл';
      b.title = 'Создать пустой файл в активной панели';
      b.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        openCreateModal('file');
      });
      try { actions.appendChild(b); } catch (e2) {}
    }

    // Upload / download buttons are injected at runtime.
    if (el('fm-upload-btn')) return; // already wired

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn-secondary';
    upBtn.id = 'fm-upload-btn';
    upBtn.textContent = '⬆ Upload';

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn-secondary';
    downBtn.id = 'fm-download-btn';
    downBtn.textContent = '⬇ Download';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.id = 'fm-upload-input';

    upBtn.onclick = () => {
      try { fileInput.value = ''; } catch (e) {}
      fileInput.click();
    };
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      xhrUploadFiles({ side: S.activeSide, files });
    };

    downBtn.onclick = () => {
      downloadSelection(S.activeSide);
    };

    actions.appendChild(downBtn);
    actions.appendChild(upBtn);
    actions.appendChild(fileInput);
  }


  // -------------------------- context menu (ПКМ) --------------------------
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

  function hideCtxMenu() {
    const m = ensureCtxMenuEl();
    if (!m) return;
    try { m.classList.add('hidden'); } catch (e) {}
    try { m.innerHTML = ''; } catch (e) {}
    try { S.ctxMenu.shown = false; } catch (e) {}
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

  function buildCtxMenu(menu, opts) {
    if (!menu) return;
    const o = opts || {};
    const hasRow = !!o.hasRow;
    const isDir = !!o.isDir;

    menu.innerHTML = '';

    if (hasRow) {
      menu.appendChild(_ctxBtn(isDir ? 'Открыть папку' : 'Открыть', 'open', 'Enter'));
      menu.appendChild(_ctxBtn('Скачать', 'download', ''));
      menu.appendChild(_ctxSep());
      menu.appendChild(_ctxBtn('Копировать', 'copy', 'F5'));
      menu.appendChild(_ctxBtn('Переместить', 'move', 'F6'));
      menu.appendChild(_ctxBtn('Переименовать', 'rename', 'F2'));
      menu.appendChild(_ctxBtn('Удалить', 'delete', 'F8'));
      menu.appendChild(_ctxSep());
    }

    menu.appendChild(_ctxBtn('Создать папку', 'mkdir', 'F7'));
    menu.appendChild(_ctxBtn('Создать файл', 'touch', 'Shift+F7'));
    menu.appendChild(_ctxSep());
    menu.appendChild(_ctxBtn('Загрузить (Upload)…', 'upload', ''));
    menu.appendChild(_ctxBtn('Вверх', 'up', 'Backspace'));
    menu.appendChild(_ctxBtn('Обновить', 'refresh', '⟳'));
  }

  function showCtxMenu(opts) {
    const m = ensureCtxMenuEl();
    if (!m) return;

    const side = String((opts && opts.side) || S.activeSide || 'left');
    const name = safeName((opts && opts.name) || '');
    const isDir = !!(opts && opts.isDir);
    const hasRow = !!(opts && opts.hasRow);

    // store context for actions
    try { S.ctxMenu = { shown: true, side, name, isDir, hasRow }; } catch (e) {}

    buildCtxMenu(m, { hasRow, isDir });

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

  function wireCtxMenuGlobal() {
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

      const ctx = S.ctxMenu || {};
      const side = String(ctx.side || S.activeSide || 'left');

      // Close menu first (so UI feels snappy)
      hideCtxMenu();

      // Ensure side active for actions relying on S.activeSide
      try { setActiveSide(side); } catch (e3) {}

      // If menu was opened on a row, ensure focus is on that row
      try {
        const p = S.panels[side];
        if (p && ctx.name) {
          p.focusName = safeName(ctx.name);
        }
      } catch (e4) {}

      try {
        if (act === 'open') {
          await openFocused(side);
        } else if (act === 'download') {
          downloadSelection(side);
        } else if (act === 'copy') {
          await runCopyMove('copy');
        } else if (act === 'move') {
          await runCopyMove('move');
        } else if (act === 'rename') {
          openRenameModal();
        } else if (act === 'delete') {
          await runDelete();
        } else if (act === 'mkdir') {
          openCreateModal('dir');
        } else if (act === 'touch') {
          openCreateModal('file');
        } else if (act === 'upload') {
          const inp = el('fm-upload-input');
          if (inp) {
            try { inp.value = ''; } catch (e5) {}
            inp.click();
          }
        } else if (act === 'up') {
          await goUp(side);
        } else if (act === 'refresh') {
          await listPanel(side, { fromInput: true });
        }
      } catch (err) {
        try { toast('FM: действие не выполнено', 'error'); } catch (e6) {}
      }
    }, true);

    // Close on outside click / scroll / resize / Escape
    document.addEventListener('mousedown', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      if (e && e.target && mm.contains(e.target)) return;
      hideCtxMenu();
    }, true);

    document.addEventListener('wheel', () => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      hideCtxMenu();
    }, { capture: true, passive: true });

    document.addEventListener('scroll', () => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      hideCtxMenu();
    }, true);

    window.addEventListener('resize', () => hideCtxMenu(), true);

    document.addEventListener('keydown', (e) => {
      const mm = el('fm-context-menu');
      if (!mm || mm.classList.contains('hidden')) return;
      if (e && e.key === 'Escape') {
        try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}
        hideCtxMenu();
      }
    }, true);
  }

  function wireHotkeys() {
    document.addEventListener('keydown', async (e) => {
      // Hotkeys should work even if remote backend is disabled (local manager is still useful).
      if (!isFilesViewVisible()) return;
      if (!e) return;

      // Avoid interfering when typing in inputs and when modals are open
      if (isTextInputActive()) return;
      if (document.querySelector('.modal:not(.hidden)')) return;

      const k = e.key;

      // Exit FM fullscreen quickly
      if (k === 'Escape' && fmIsFullscreen) {
        e.preventDefault();
        fmSetFullscreen(false);
        return;
      }

      if (k === 'F1') {
        e.preventDefault();
        modalOpen(el('fm-help-modal'));
        return;
      }

      if (k === 'Tab') {
        e.preventDefault();
        setActiveSide(otherSide(S.activeSide));
        const d = panelDom(S.activeSide);
        if (d && d.list) {
          try { d.list.focus(); } catch (e2) {}
        }
        return;
      }

      if (k === 'Enter') {
        e.preventDefault();
        await openFocused(S.activeSide);
        return;
      }

      if (k === 'Backspace') {
        e.preventDefault();
        await goUp(S.activeSide);
        return;
      }

      if (k === 'F2') {
        e.preventDefault();
        openRenameModal();
        return;
      }

      if (k === 'F5') {
        e.preventDefault();
        await runCopyMove('copy');
        return;
      }

      if (k === 'F6') {
        e.preventDefault();
        await runCopyMove('move');
        return;
      }

      if (k === 'F7') {
        e.preventDefault();
        openCreateModal(e.shiftKey ? 'file' : 'dir');
        return;
      }

      if (k === 'F8') {
        e.preventDefault();
        await runDelete();
        return;
      }
    }, true);
  }

  async function detectCapabilities() {
    const tabBtn = el('top-tab-files');
    const note = el('fm-disabled-note');

    // Default: keep server-side visibility (panel.html hides the tab on MIPS).

    try {
      const { res, data } = await fetchJson('/api/capabilities', { method: 'GET' });
      if (!res || !res.ok || !data) return;
      S.caps = data;

      const rf = data.remoteFs || {};
      const arch = String(rf.arch || '').toLowerCase();
      const isMips = arch.startsWith('mips') || String(rf.reason || '') === 'arch_mips_disabled';

      // Show the "Files" tab on non-MIPS even if remote is disabled (local manager is still useful).
      if (!isMips) {
        if (tabBtn) show(tabBtn);
      } else {
        if (tabBtn) hide(tabBtn);
      }

      const enabled = !!rf.enabled;
      const supported = !!rf.supported;
      S.enabled = enabled;

      // Disable remote target option if remote backend isn't supported.
      try {
        const allowRemote = !!supported && !isMips;
        ['left', 'right'].forEach((side) => {
          const pd = panelDom(side);
          const p = S.panels[side];
          if (!pd || !pd.targetSelect) return;
          const opt = Array.from(pd.targetSelect.options || []).find(o => String(o.value) === 'remote');
          if (opt) opt.disabled = !allowRemote;
          if (!allowRemote && p && p.target === 'remote') {
            p.target = 'local';
            p.sid = '';
          }
        });
      } catch (e) {}

      // Fill modal selects from server capabilities (optional).
      try {
        await loadRemoteCaps();
        applyCapsToConnectModal();
      } catch (e) {}

      // If remote isn't enabled, show a hint inside the view.
      if (note) {
        if (isMips) {
          note.textContent = 'Файловый менеджер недоступен на MIPS-архитектуре.';
          show(note);
        } else if (!enabled) {
          const reason = rf.reason ? String(rf.reason) : 'disabled';
          let msg = 'Remote файловый менеджер недоступен: ' + reason + '.';
          if (reason === 'lftp_missing') {
            msg += ' Установите lftp через Entware: opkg install lftp.';
          } else if (reason === 'disabled') {
            msg += ' Включите XKEEN_REMOTEFM_ENABLE=1.';
          }
          note.textContent = msg;
          show(note);
        } else {
          hide(note);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  FM.onShow = function onShow() {
    // lazy refresh when tab is opened
    try {
      // Render and refresh if empty.
      ['left', 'right'].forEach((s) => renderPanel(s));
      if (!S.panels.left.items.length && !S.panels.right.items.length) {
        refreshAll();
      }
    } catch (e) {}
  };

  FM.init = function init() {
    const root = el('fm-root');
    if (!root) return;

    // avoid double init
    if (root.dataset && root.dataset.fmInit === '1') return;
    if (root.dataset) root.dataset.fmInit = '1';

    // init default paths
    ['left', 'right'].forEach((side) => {
      const p = S.panels[side];
      if (!p.cwd) p.cwd = '/opt/var';
    });

    setActiveSide('left');

    wirePanel('left');
    wirePanel('right');
    wireHeaderActions();
    wireModals();
    wireHotkeys();

    detectCapabilities().then(() => {
      // Render initial local panels immediately
      renderPanel('left');
      renderPanel('right');
      // Preload local lists even before switching tab (fast and avoids empty view).
      refreshAll();
    });
  };
})();
