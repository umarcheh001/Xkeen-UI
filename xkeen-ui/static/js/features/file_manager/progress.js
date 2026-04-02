import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager: progress modal UI helpers (no ES modules / bundler)
  // attach to the shared file manager namespace.progress

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  FM.progress = FM.progress || {};
  const P = FM.progress;

  const C = FM.common || {};

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qs(sel, root) {
    try { if (C && typeof C.qs === 'function') return C.qs(sel, root); } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    if (!modal) return;
    try { modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e2) {}
  }

  function fmtSize(bytes) {
    try { if (C && typeof C.fmtSize === 'function') return C.fmtSize(bytes); } catch (e) {}
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

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function nowMs() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  // -------------------------- details toggle --------------------------
  P.ensureDetailsToggle = function ensureDetailsToggle() {
    const modal = el('fm-progress-modal');
    if (!modal) return;
    const body = qs('.modal-body', modal);
    const details = el('fm-progress-details');
    if (!body || !details) return;

    // Create toggle UI once (hidden by default).
    if (!el('fm-progress-details-toggle')) {
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
  };

  P.setDetailsAvailable = function setDetailsAvailable(available) {
    P.ensureDetailsToggle();
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
  };

  // -------------------------- main UI setters --------------------------
  P.setUi = function setUi({ titleText, pct, metaText, errorText, detailsText }) {
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
  };

  // -------------------------- auto-close --------------------------
  let _autoCloseTimer = null;

  P.clearAutoClose = function clearAutoClose() {
    try { if (_autoCloseTimer) clearTimeout(_autoCloseTimer); } catch (e) {}
    _autoCloseTimer = null;
  };

  P.scheduleAutoClose = function scheduleAutoClose(delayMs) {
    P.clearAutoClose();
    const d = Math.max(0, Number(delayMs || 0));
    _autoCloseTimer = setTimeout(() => {
      try { modalClose(el('fm-progress-modal')); } catch (e) {}
    }, d);
  };

  // -------------------------- formatting helpers --------------------------
  P.pad2 = function pad2(n) {
    const v = Math.floor(Math.abs(Number(n || 0)));
    return (v < 10 ? '0' : '') + String(v);
  };

  P.fmtTimeFromSec = function fmtTimeFromSec(tsSec) {
    const ts = Number(tsSec || 0);
    if (!isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts * 1000);
    return `${P.pad2(d.getHours())}:${P.pad2(d.getMinutes())}:${P.pad2(d.getSeconds())}`;
  };

  P.fmtDateFromSec = function fmtDateFromSec(tsSec) {
    const ts = Number(tsSec || 0);
    if (!isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${P.pad2(d.getMonth() + 1)}-${P.pad2(d.getDate())}`;
  };

  function _isSameLocalDay(tsA, tsB) {
    try {
      const a = new Date(Number(tsA || 0) * 1000);
      const b = new Date(Number(tsB || 0) * 1000);
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    } catch (e) {
      return false;
    }
  }

  P.fmtWhenFromSec = function fmtWhenFromSec(tsSec) {
    const ts = Number(tsSec || 0);
    if (!isFinite(ts) || ts <= 0) return '';
    const nowSec = nowMs() / 1000;
    const time = P.fmtTimeFromSec(ts);
    if (_isSameLocalDay(ts, nowSec)) return time;
    return `${P.fmtDateFromSec(ts)} ${time}`;
  };

  P.fmtDurationSec = function fmtDurationSec(seconds) {
    const s = Math.max(0, Math.round(Number(seconds || 0)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m ${r}s`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  };

  // -------------------------- copy helper --------------------------
  P.copyText = async function copyText(text) {
    const v = String(text || '');
    if (!v) return;

    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(v);
        toast('Скопировано', 'success');
        return;
      }
    } catch (e) {}

    // Fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = v;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Скопировано', 'success');
    } catch (e) {}
  };

  // -------------------------- "extra" block (job id + timestamps) --------------------------
  P.ensureExtra = function ensureExtra() {
    const modal = el('fm-progress-modal');
    const meta = el('fm-progress-meta');
    if (!modal || !meta) return;
    if (el('fm-progress-extra')) return;

    const wrap = document.createElement('div');
    wrap.id = 'fm-progress-extra';
    wrap.className = 'fm-progress-extra';
    wrap.innerHTML = `
      <div class="fm-progress-extra-left">
        <span style="opacity:.85;">Job:</span>
        <span id="fm-progress-jobid" class="fm-mono" style="margin-left:6px;"></span>
        <button type="button" class="btn-secondary" id="fm-progress-copyid-btn" style="padding:4px 10px;">Копировать</button>
      </div>
      <div class="fm-progress-extra-right" id="fm-progress-times"></div>
    `;

    meta.parentNode.insertBefore(wrap, meta.nextSibling);

    const copyBtn = el('fm-progress-copyid-btn');
    if (copyBtn) {
      copyBtn.onclick = (e) => {
        try { e.preventDefault(); } catch (e2) {}
        const jid = el('fm-progress-jobid') ? String(el('fm-progress-jobid').textContent || '') : '';
        P.copyText(jid);
      };
    }
  };

  P.setExtra = function setExtra(job) {
    P.ensureExtra();
    const jidEl = el('fm-progress-jobid');
    const copyBtn = el('fm-progress-copyid-btn');
    const timesEl = el('fm-progress-times');
    const wrap = el('fm-progress-extra');

    const jobId = String(job && job.job_id || '');
    if (jidEl) jidEl.textContent = jobId;
    if (copyBtn) copyBtn.style.display = jobId ? '' : 'none';
    if (wrap) wrap.style.display = jobId ? 'flex' : 'none';

    const created = Number(job && job.created_ts || 0);
    const started = Number(job && job.started_ts || 0);
    const finished = Number(job && job.finished_ts || 0);
    const now = nowMs() / 1000;

    let dur = 0;
    if (started > 0 && finished > 0) dur = finished - started;
    else if (started > 0 && (!finished || finished <= 0)) dur = now - started;
    else if (created > 0 && finished > 0) dur = finished - created;

    const parts = [];
    if (created) parts.push(`создано ${P.fmtWhenFromSec(created)}`);
    if (started) parts.push(`старт ${P.fmtWhenFromSec(started)}`);
    if (finished) parts.push(`финиш ${P.fmtWhenFromSec(finished)}`);
    if (dur > 0) parts.push(`длительность ${P.fmtDurationSec(dur)}`);

    if (timesEl) timesEl.textContent = parts.join('   ');
  };

  // -------------------------- job speed/eta helpers (best-effort) --------------------------
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

  // -------------------------- progress modal main updater --------------------------
  P._jobStats = P._jobStats || {}; // job_id -> { lastTsMs, lastBytes, speed }

  // opts:
  //   - viewOnly: do not auto-close on success (used when user opens a finished job from the Operations list)
  P.updateProgressModal = function updateProgressModal(job, opts) {
    opts = opts || {};
    const viewOnly = !!opts.viewOnly;

    const title = el('fm-progress-title');
    const bar = el('fm-progress-bar-inner');
    const meta = el('fm-progress-meta');
    const details = el('fm-progress-details');
    const err = el('fm-progress-error');

    P.ensureDetailsToggle();
    if (err) err.textContent = '';

    try {
      const op = String(job && job.op || 'op');
      const st = String(job && job.state || '');
      const stLower = st.toLowerCase();
      const finished = (stLower === 'done' || stLower === 'error' || stLower === 'canceled');

      // Job id + timestamps block
      try { P.setExtra(job || {}); } catch (e) {}

      // Details button:
      // - errors: always
      // - viewOnly: allow inspecting raw JSON even for "done"
      P.setDetailsAvailable(stLower === 'error' || !!viewOnly);

      // Action buttons
      try {
        const cbtn = el('fm-progress-cancel-btn');
        if (cbtn) {
          cbtn.disabled = finished;
          cbtn.style.display = (finished || viewOnly) ? 'none' : '';
        }
        const okBtn = el('fm-progress-ok-btn');
        if (okBtn) okBtn.textContent = (finished || viewOnly) ? 'Закрыть' : 'Скрыть';
      } catch (e) {}

      // Auto-close after successful completion (unless viewOnly)
      if (stLower === 'done' && !viewOnly) {
        P.clearAutoClose();
        P.scheduleAutoClose(650);
      } else {
        P.clearAutoClose();
      }

      const jobId = String(job && job.job_id || '');
      const cur = job && job.progress && job.progress.current ? job.progress.current : null;
      const curName = cur && cur.name ? String(cur.name) : '';
      const curPhase = cur && cur.phase ? String(cur.phase) : '';

      if (title) {
        const t = op.toUpperCase() + ' — ' + st + (curName ? (' — ' + curName) : '');
        title.textContent = t;
      }

      const bytesDone = Number(job && job.progress && job.progress.bytes_done || 0);
      const bytesTotal = Number(job && job.progress && job.progress.bytes_total || 0);
      const filesDone = Number(job && job.progress && job.progress.files_done || 0);
      const filesTotal = Number(job && job.progress && job.progress.files_total || 0);

      const pct = (bytesTotal > 0)
        ? Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100)))
        : (filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0);

      if (bar) bar.style.width = pct + '%';

      if (meta) {
        const parts = [];
        if (curPhase) parts.push('phase: ' + curPhase);
        if (filesTotal > 0) parts.push(`files: ${filesDone}/${filesTotal}`);
        else if (filesDone > 0) parts.push(`files: ${filesDone}`);

        if (bytesTotal > 0) parts.push(`bytes: ${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)} (${pct}%)`);
        else if (bytesDone > 0) parts.push(`bytes: ${fmtSize(bytesDone)}`);

        // Speed + ETA (best-effort)
        try {
          if (jobId && bytesTotal > 0 && (stLower === 'running' || stLower === 'queued')) {
            const now = nowMs();
            const prev = P._jobStats[jobId] || { lastTsMs: 0, lastBytes: 0, speed: 0 };
            const dt = Math.max(1, now - (prev.lastTsMs || now));
            const db = Math.max(0, bytesDone - (prev.lastBytes || 0));
            const inst = (db * 1000) / dt;
            const speed = prev.speed ? (prev.speed * 0.75 + inst * 0.25) : inst;
            P._jobStats[jobId] = { lastTsMs: now, lastBytes: bytesDone, speed };
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
        details.textContent = JSON.stringify(job || {}, null, 2);
      }

      if (stLower === 'error' && err) {
        let msg = String(job && (job.error || (job.last_error && job.last_error.message)) || 'error');
        try {
          if (msg === 'remote_no_space') {
            const chk = job && job.progress && job.progress.check ? job.progress.check : null;
            const need = chk && typeof chk.need_bytes === 'number' ? chk.need_bytes : null;
            const free = chk && typeof chk.free_bytes === 'number' ? chk.free_bytes : null;
            if (need != null && free != null) {
              msg = `Недостаточно места на удалённом диске: нужно ${fmtSize(need)}, свободно ${fmtSize(free)}`;
            } else {
              msg = 'Недостаточно места на удалённом диске';
            }
          }
        } catch (e2) {}
        err.textContent = msg;
      }
    } catch (e) {
      try { if (details) details.textContent = ''; } catch (e2) {}
    }
  };

  // Convenience: allow other modules to open the modal (optional)
  P.open = function open() {
    try { modalOpen(el('fm-progress-modal')); } catch (e) {}
  };

  P.close = function close() {
    try { modalClose(el('fm-progress-modal')); } catch (e) {}
  };
})();
