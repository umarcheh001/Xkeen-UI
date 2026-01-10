(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};
  const toast = SH.toast || function (m) { try { console.log(m); } catch (e) {} };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, { cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });
  const escapeHtml = SH.escapeHtml || ((s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const ansiToHtml = SH.ansiToHtml || ((t) => escapeHtml(t || ''));
  const fallbackCopyText = SH.fallbackCopyText || ((t) => {
    const ta = document.createElement('textarea');
    ta.value = String(t || '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать', true); }
    try { ta.remove(); } catch (e) {}
  });

  // ------------------------- Logs -------------------------

  let _logList = [];
  let _logMetaByName = {};
  let _logHasNew = {};
  let _logListTimer = null;
  let _logRelTimer = null;
  let _logRawLines = [];
  let _logFilteredLines = [];
  let _logFilteredRawIdx = [];
  let _logCursor = null;
  let _logSelectedName = '';
  let _logTimer = null;
  let _logLoading = false;
  let _activeTab = 'tools';
  let _lastTailResetToastAt = 0;

  // Stage 9: WS stream for logs (with polling fallback)
  let _capWebsocket = null; // from /api/capabilities
  let _logWs = null;
  let _logWsName = '';
  let _logWsEverOpened = false;
  let _logWsReconnectAttempt = 0;
  let _logWsReconnectTimer = null;
  let _logWsDisabled = false;


  // ------------------------- Logs: tail -f (Stage 3 scaffold: state/UI only) -------------------------

  // Contract (Stage 3): Live/Pause/Follow + append-only updates.
  // NOTE: Behaviour (append/pending buffer) will be implemented in Stage 3.
  const TAIL_LIMITS = {
    bufferLimitLines: 2000, // keep last N lines in memory/DOM
    bufferLimitBytes: 0,    // optional (0 = disabled)
    pendingLimitLines: 2000,
  };

  // Shared state container (so later modules can reuse it without rewriting everything).
  XK.state.devtoolsLogs = XK.state.devtoolsLogs || {};
  const _tail = XK.state.devtoolsLogs;
  if (typeof _tail.isLive === 'undefined') _tail.isLive = false;
  if (typeof _tail.isPaused === 'undefined') _tail.isPaused = false;
  if (typeof _tail.isFollow === 'undefined') _tail.isFollow = true;
  if (typeof _tail.pendingCount === 'undefined') _tail.pendingCount = 0;
  if (typeof _tail.limits === 'undefined') _tail.limits = Object.assign({}, TAIL_LIMITS);
if (!Array.isArray(_tail.pendingLines)) _tail.pendingLines = [];
if (typeof _tail.pendingSnapshot === 'undefined') _tail.pendingSnapshot = null; // full window snapshot while paused
if (typeof _tail.pendingForName === 'undefined') _tail.pendingForName = '';

  // ------------------------- Logs: Stage 4 ("human" filters) -------------------------

  XK.state.devtoolsLogsUi = XK.state.devtoolsLogsUi || {};
  const _logUi = XK.state.devtoolsLogsUi;
  if (typeof _logUi.profile === 'undefined') _logUi.profile = 'all'; // errors | info | warnings | all
  if (typeof _logUi.showTimestamps === 'undefined') _logUi.showTimestamps = true;
  if (typeof _logUi.regexEnabled === 'undefined') _logUi.regexEnabled = false;
  // Stage 5: tokens (chips) for include/exclude
  if (!Array.isArray(_logUi.includeTokens)) _logUi.includeTokens = [];
  if (!Array.isArray(_logUi.excludeTokens)) _logUi.excludeTokens = [];
  // Backward-compat: migrate previous string fields once.
  try {
    if (_logUi.search && (!_logUi.includeTokens || !_logUi.includeTokens.length)) {
      _logUi.includeTokens = String(_logUi.search || '').trim().split(/\s+/).filter(Boolean);
    }
  } catch (e) {}
  try {
    if (_logUi.exclude && (!_logUi.excludeTokens || !_logUi.excludeTokens.length)) {
      _logUi.excludeTokens = String(_logUi.exclude || '').trim().split(/\s+/).filter(Boolean);
    }
  } catch (e) {}
  // Keep legacy fields present (other code may read them), but they are no longer the source of truth.
  if (typeof _logUi.search === 'undefined') _logUi.search = '';
  if (typeof _logUi.exclude === 'undefined') _logUi.exclude = '';
  if (!Array.isArray(_logUi.presets)) _logUi.presets = [];

  // Stage 6: level parsing + min-level filter
  if (typeof _logUi.minLevel === 'undefined') _logUi.minLevel = 'debug'; // debug | info | warning | error
  if (typeof _logUi.levelUiSupported === 'undefined') _logUi.levelUiSupported = false;

  const LOG_PRESET_KEYS = ['auth', 'dhcp', 'wireless', 'vpn', 'dns', 'kernel'];

  function _updateTailControlsUi() {
    const pauseBtn = byId('dt-log-pause');
    const badgeBtn = byId('dt-log-pending-badge');
    const liveEl = byId('dt-log-live');
    const followEl = byId('dt-log-follow');

    try {
      if (liveEl) liveEl.checked = !!_tail.isLive;
    } catch (e) {}
    try {
      if (followEl) followEl.checked = !!_tail.isFollow;
    } catch (e) {}

    if (pauseBtn) {
      pauseBtn.textContent = _tail.isPaused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('is-paused', !!_tail.isPaused);
    }

    if (badgeBtn) {
      const n = Math.max(0, Number(_tail.pendingCount || 0));
      badgeBtn.textContent = '+' + n + ' new lines';
      badgeBtn.style.display = (_tail.isPaused && n > 0) ? '' : 'none';
    }
  }

function _getBufferLimitLines() {
  try {
    const v = Number((_tail && _tail.limits && _tail.limits.bufferLimitLines) || 2000);
    return Math.max(50, v || 2000);
  } catch (e) {
    return 2000;
  }
}

function _getPendingLimitLines() {
  try {
    const v = Number((_tail && _tail.limits && _tail.limits.pendingLimitLines) || _getBufferLimitLines());
    return Math.max(50, v || _getBufferLimitLines());
  } catch (e) {
    return _getBufferLimitLines();
  }
}

function _resetPendingFor(name) {
  try { _tail.pendingForName = String(name || ''); } catch (e) { _tail.pendingForName = ''; }
  try { _tail.pendingLines = []; } catch (e) { _tail.pendingLines = []; }
  try { _tail.pendingSnapshot = null; } catch (e) { _tail.pendingSnapshot = null; }
  _tail.pendingCount = 0;
  _updateTailControlsUi();
}

function _capPendingCount(n) {
  const lim = _getPendingLimitLines();
  return Math.max(0, Math.min(lim, Number(n || 0) || 0));
}

function _bumpPendingCount(delta) {
  _tail.pendingCount = _capPendingCount(Number(_tail.pendingCount || 0) + Number(delta || 0));
}

function _applyLimitToArrayTail(arr, limit) {
  if (!Array.isArray(arr)) return 0;
  const lim = Math.max(1, Number(limit || 0) || 0);
  if (!lim) return 0;
  if (arr.length <= lim) return 0;
  const cut = arr.length - lim;
  arr.splice(0, cut);
  return cut;
}

function _estimateNewLinesFromFull(baseLines, fullLines) {
  const base = Array.isArray(baseLines) ? baseLines : [];
  const full = Array.isArray(fullLines) ? fullLines : [];
  if (!full.length) return { newCount: 0, anchorIndex: -1 };
  if (!base.length) return { newCount: full.length, anchorIndex: -1 };

  const baseLast = String(base[base.length - 1] || '');
  let bestOverlap = 0;
  let bestI = -1;

  // Scan matches of baseLast in full from end; choose the one with max backward overlap.
  for (let i = full.length - 1; i >= 0; i--) {
    if (String(full[i] || '') !== baseLast) continue;
    let overlap = 1;
    while (
      overlap < 200 &&
      overlap < base.length &&
      (i - overlap) >= 0 &&
      String(full[i - overlap] || '') === String(base[base.length - 1 - overlap] || '')
    ) {
      overlap += 1;
    }
    if (overlap > bestOverlap || (overlap === bestOverlap && i > bestI)) {
      bestOverlap = overlap;
      bestI = i;
    }
    if (bestOverlap >= 200) break;
  }

  if (bestI < 0) return { newCount: full.length, anchorIndex: -1 };
  return { newCount: Math.max(0, full.length - (bestI + 1)), anchorIndex: bestI };
}

function _applyPendingToView() {
  const view = byId('dt-log-view');
  if (!view) return;

  const sel = byId('dt-log-select');
  const name = sel ? String(sel.value || '') : '';
  if (!name) return;

  const followEl = byId('dt-log-follow');

  const cfg = _getLogFilterConfig();
  const hasFilter = _hasContentFilters(cfg);
    const isFollow = !!(followEl && followEl.checked);

  // If we have a full snapshot (e.g., cursor invalid / rotation while paused) -> replace buffer and rerender.
  if (Array.isArray(_tail.pendingSnapshot) && _tail.pendingSnapshot) {
    _logRawLines = _tail.pendingSnapshot.slice(0);
    const limit = _getBufferLimitLines();
    if (_logRawLines.length > limit) _logRawLines = _logRawLines.slice(_logRawLines.length - limit);
    _tail.pendingSnapshot = null;
    _tail.pendingLines = [];
    _tail.pendingCount = 0;
    _updateTailControlsUi();
    applyLogFilterToView();
    return;
  }

  const pending = Array.isArray(_tail.pendingLines) ? _tail.pendingLines : [];
  if (!pending.length) {
    _tail.pendingCount = 0;
    _updateTailControlsUi();
    if (isFollow) {
      try { view.scrollTop = view.scrollHeight; } catch (e) {}
    }
    return;
  }

  // Apply pending lines to current buffer.
  const beforeLen = Array.isArray(_logRawLines) ? _logRawLines.length : 0;
  if (!Array.isArray(_logRawLines)) _logRawLines = [];
  for (const x of pending) _logRawLines.push(x);

  // Enforce buffer limit and compute how many lines trimmed from top.
  const limit = _getBufferLimitLines();
  let trimmedTop = 0;
  if (_logRawLines.length > limit) {
    trimmedTop = _logRawLines.length - limit;
    _logRawLines = _logRawLines.slice(trimmedTop);
  }

  // Clear pending before rendering.
  _tail.pendingLines = [];
  _tail.pendingCount = 0;
  _updateTailControlsUi();

  // If filtered view is active, we must full rerender.
  if (hasFilter || !_canAppendToView(name, cfg, view)) {
    applyLogFilterToView();
    return;
  }

  // Append in DOM without full rerender.
  _appendLogViewLines(view, name, pending, {
    trimTop: trimmedTop,
    follow: isFollow,
  });

  _logFilteredLines = Array.isArray(_logRawLines) ? _logRawLines : [];

  try { view.dataset.rawText = ''; } catch (e) {}
  try { view.dataset.visibleText = ''; } catch (e) {}

  const statsEl = byId('dt-log-stats');
  if (statsEl) statsEl.textContent = `Lines: ${_logFilteredLines.length}`;
}

function _enterPauseForCurrentLog() {
  const sel = byId('dt-log-select');
  const name = sel ? String(sel.value || '') : '';
  _tail.isPaused = true;
  _resetPendingFor(name);
  _updateTailControlsUi();
}

function _resumeFromPause() {
  if (!_tail.isPaused) return;
  _tail.isPaused = false;
  _updateTailControlsUi();
  _applyPendingToView();
}

function _exitPauseAndClearPending() {
  _tail.isPaused = false;
  _resetPendingFor('');
  _updateTailControlsUi();
}



  function _splitTerms(s) {
    try {
      return String(s || '')
        .trim()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // Stage 5: split a token input into a list of tokens.
  // Supports quotes ("foo bar") and separators: whitespace / comma.
  function _splitTokenInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    const out = [];
    let buf = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === q) {
          q = null;
        } else {
          buf += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        continue;
      }
      if (ch === ',' || /\s/.test(ch)) {
        const t = buf.trim();
        if (t) out.push(t);
        buf = '';
        continue;
      }
      buf += ch;
    }
    const t = buf.trim();
    if (t) out.push(t);
    return out;
  }

  function _normalizeTokensList(arr) {
    const out = [];
    try {
      const set = new Set();
      for (const x of (arr || [])) {
        const t = String(x || '').trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (set.has(key)) continue;
        set.add(key);
        out.push(t);
      }
    } catch (e) {}
    return out;
  }

  function _syncLegacySearchExcludeStrings() {
    // Keep legacy string fields in sync (debugging / backward callers).
    try { _logUi.search = (_logUi.includeTokens || []).join(' '); } catch (e) { _logUi.search = ''; }
    try { _logUi.exclude = (_logUi.excludeTokens || []).join(' '); } catch (e) { _logUi.exclude = ''; }
  }

  function _renderTokenField(kind) {
    const fieldId = (kind === 'include') ? 'dt-log-include-field' : 'dt-log-exclude-field';
    const inputId = (kind === 'include') ? 'dt-log-search' : 'dt-log-exclude';
    const field = byId(fieldId);
    const input = byId(inputId);
    if (!field || !input) return;

    const list = (kind === 'include') ? (_logUi.includeTokens || []) : (_logUi.excludeTokens || []);
    const norm = _normalizeTokensList(list);
    if (kind === 'include') _logUi.includeTokens = norm; else _logUi.excludeTokens = norm;
    _syncLegacySearchExcludeStrings();

    // Remove all chip nodes, keep the input.
    try {
      const toRemove = [];
      for (const node of Array.from(field.childNodes || [])) {
        if (node !== input) toRemove.push(node);
      }
      for (const n of toRemove) field.removeChild(n);
    } catch (e) {}

    // Insert chips before input.
    try {
      for (const tok of norm) {
        const chip = document.createElement('span');
        chip.className = 'dt-token-chip';
        chip.dataset.kind = kind;
        chip.dataset.token = tok;
        const label = document.createElement('span');
        label.textContent = tok;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'dt-token-x';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Remove');
        x.dataset.kind = kind;
        x.dataset.token = tok;
        chip.appendChild(label);
        chip.appendChild(x);
        field.insertBefore(chip, input);
      }
    } catch (e) {}

    try { input.placeholder = norm.length ? '' : (kind === 'include' ? 'Include' : 'Exclude'); } catch (e) {}
  }

  function _addTokens(kind, raw) {
    const toks = _splitTokenInput(raw);
    if (!toks.length) return false;
    const key = (kind === 'include') ? 'includeTokens' : 'excludeTokens';
    const current = Array.isArray(_logUi[key]) ? _logUi[key] : [];
    const next = _normalizeTokensList(current.concat(toks));
    _logUi[key] = next;
    _syncLegacySearchExcludeStrings();
    _renderTokenField(kind);
    return true;
  }

  function _removeToken(kind, token) {
    const t = String(token || '').trim();
    if (!t) return;
    const key = (kind === 'include') ? 'includeTokens' : 'excludeTokens';
    const cur = Array.isArray(_logUi[key]) ? _logUi[key] : [];
    const next = cur.filter((x) => String(x || '').trim().toLowerCase() !== t.toLowerCase());
    _logUi[key] = _normalizeTokensList(next);
    _syncLegacySearchExcludeStrings();
    _renderTokenField(kind);
  }

  function _stripAnsiForMatch(text) {
    // Keep the logic consistent with util/ansi.js, but much simpler (we only need it for filtering).
    try {
      let s = String(text || '');
      s = s.replace(/\r/g, '');
      // OSC: ESC ] ... BEL or ST
      s = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\\\)/g, '');
      // CSI: ESC [ ... <final>
      s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      // Other stray ESC
      s = s.replace(/\x1b(?!\[)/g, '');
      // Remaining C0 controls (except \t)
      s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      return s;
    } catch (e) {
      return String(text || '');
    }
  }

  function _extractTimestampPrefix(rawLine) {
    // Returns { ts: string, rest: string, parsed: boolean }
    // We try a few common formats at the beginning of the line.
    const s = _stripAnsiForMatch(_stripLineEnding(rawLine));
    const original = _stripLineEnding(rawLine);

    // ISO 8601: 2025-12-28T12:34:56.789Z / 2025-12-28 12:34:56,123
    const reIso = /^\s*(\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[\.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\]?)(\s+)([\s\S]*)$/;
    const mIso = s.match(reIso);
    if (mIso) {
      const ts = mIso[1];
      const sep = mIso[2] || ' ';
      // Use the original string to keep ANSI coloring inside the rest (if any).
      // We approximate by trimming the same prefix length.
      const cut = (mIso[1] + sep).length;
      return { ts: original.slice(0, cut), rest: original.slice(cut), parsed: true };
    }

    // Syslog-ish: Dec 28 12:34:56
    const reSyslog = /^\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})(\s+)([\s\S]*)$/;
    const mSys = s.match(reSyslog);
    if (mSys) {
      const cut = (mSys[1] + (mSys[2] || ' ')).length;
      return { ts: original.slice(0, cut), rest: original.slice(cut), parsed: true };
    }

    // Fallback: something that looks like a timestamp, but we don't "parse" it.
    const reLike = /^\s*(\[?(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})[^\s\]]{0,32}\]?)(\s+)([\s\S]*)$/;
    const mLike = s.match(reLike);
    if (mLike) {
      const cut = (mLike[1] + (mLike[2] || ' ')).length;
      return { ts: original.slice(0, cut), rest: original.slice(cut), parsed: false };
    }

    return { ts: '', rest: original, parsed: false };
  }

  // Stage 6: log level parsing (structured formats first, then fallback heuristics).
  const _LEVEL_ORDER = { unknown: 0, debug: 10, info: 20, warning: 30, error: 40 };

  function _mapLevelToken(tok) {
    const t = String(tok || '').trim().toLowerCase();
    if (!t) return 'unknown';
    if (t === 'warn') return 'warning';
    if (t === 'warning') return 'warning';
    if (t === 'err') return 'error';
    if (t === 'fatal' || t === 'panic') return 'error';
    if (t === 'crit' || t === 'alert' || t === 'emerg') return 'error';
    if (t === 'notice') return 'info';
    if (t === 'trace') return 'debug';
    if (t === 'debug' || t === 'info' || t === 'error') return t;
    return 'unknown';
  }

  function _parseLogLevelInfo(rawLine) {
    const clean = _stripAnsiForMatch(_stripLineEnding(rawLine));
    const s = String(clean || '');
    const lower = s.toLowerCase();

    // 1) Syslog PRI: <34>Dec 28 12:34:56 ...
    const mPri = lower.match(/^\s*<(\d{1,3})>/);
    if (mPri) {
      const pri = Math.max(0, Math.min(191, parseInt(mPri[1], 10) || 0));
      const sev = pri % 8;
      // 0-3 error, 4 warning, 5-6 info (notice/info), 7 debug
      const level = (sev <= 3) ? 'error' : (sev === 4) ? 'warning' : (sev <= 6) ? 'info' : 'debug';
      return { level, confidence: 1, source: 'syslog_pri' };
    }

    // 2) Nginx error log: 2025/12/28 12:34:56 [error] ...
    const mNginx = lower.match(/\[(emerg|alert|crit|error|warn|notice|info|debug)\]/);
    if (mNginx && typeof mNginx.index === 'number' && mNginx.index < 60) {
      return { level: _mapLevelToken(mNginx[1]), confidence: 1, source: 'nginx' };
    }

    // 3) Structured level fields: level=info, "level":"warn", severity=ERROR
    const mField = lower.match(/\b(level|severity)\s*[:=]\s*"?(trace|debug|info|warn|warning|error|fatal|panic)"?\b/);
    if (mField) {
      return { level: _mapLevelToken(mField[2]), confidence: 1, source: 'field' };
    }

    // 4) Bracketed / prefix token near the beginning (after timestamp): [INFO] ... | INFO: ... | INFO ...
    const ts = _extractTimestampPrefix(s);
    const rest = (ts && ts.ts) ? String(ts.rest || '') : s;
    const head = rest.trim().slice(0, 80);
    const headLower = head.toLowerCase();

    const mBracket = headLower.match(/^\s*[\[\(]\s*(trace|debug|info|warn|warning|error|fatal|panic)\s*[\]\)]\b/);
    if (mBracket) {
      return { level: _mapLevelToken(mBracket[1]), confidence: 0.9, source: 'bracket' };
    }

    const mPrefix = headLower.match(/^\s*(trace|debug|info|warn|warning|error|fatal|panic)\b\s*[:\- ]/);
    if (mPrefix) {
      return { level: _mapLevelToken(mPrefix[1]), confidence: 0.9, source: 'prefix' };
    }

    const mLoose = headLower.match(/\b(trace|debug|info|warn|warning|error|fatal|panic)\b/);
    if (mLoose && typeof mLoose.index === 'number' && mLoose.index < 30) {
      return { level: _mapLevelToken(mLoose[1]), confidence: 0.7, source: 'head_token' };
    }

    // 5) Fallback heuristics (low confidence): keywords anywhere.
    if (/\b(fatal|panic)\b/.test(lower)) return { level: 'error', confidence: 0.35, source: 'heur' };
    if (/\b(error|err|failed|failure|exception|traceback)\b/.test(lower)) return { level: 'error', confidence: 0.3, source: 'heur' };
    if (/\b(warn|warning|deprecated)\b/.test(lower)) return { level: 'warning', confidence: 0.3, source: 'heur' };
    if (/\b(info|started|listening|connected)\b/.test(lower)) return { level: 'info', confidence: 0.25, source: 'heur' };
    if (/\b(debug|trace)\b/.test(lower)) return { level: 'debug', confidence: 0.25, source: 'heur' };

    // Legacy helper (very last resort).
    try {
      if (typeof window.getXrayLogLineClass === 'function') {
        const cls = window.getXrayLogLineClass(lower);
        if (cls && String(cls).includes('log-line-error')) return { level: 'error', confidence: 0.2, source: 'legacy' };
        if (cls && String(cls).includes('log-line-warning')) return { level: 'warning', confidence: 0.2, source: 'legacy' };
        if (cls && String(cls).includes('log-line-info')) return { level: 'info', confidence: 0.2, source: 'legacy' };
      }
    } catch (e) {}

    return { level: 'unknown', confidence: 0, source: 'none' };
  }

  function _parseLogLevel(rawLine) {
    try { return _parseLogLevelInfo(rawLine).level; } catch (e) { return 'unknown'; }
  }

  function _levelPassesMin(level, minLevel) {
    const lvl = String(level || 'unknown');
    const min = String(minLevel || 'debug');
    const minV = (_LEVEL_ORDER[min] || 10);
    const lvlV = (_LEVEL_ORDER[lvl] || 0);
    if (minV <= (_LEVEL_ORDER.debug || 10)) return true; // DEBUG+ means "all"
    if (lvl === 'unknown') return false; // honest: don't keep unknowns when filtering by level
    return lvlV >= minV;
  }

  function _evaluateLevelUiSupport(lines) {
    const src = Array.isArray(lines) ? lines : [];
    const sampleSize = 250;
    const sample = (src.length > sampleSize) ? src.slice(src.length - sampleSize) : src;
    let total = 0;
    let strong = 0;
    const levels = new Set();
    try {
      for (const raw of (sample || [])) {
        const s = String(raw || '');
        if (!s.trim()) continue;
        total += 1;
        const info = _parseLogLevelInfo(s);
        if (info && info.level && info.level !== 'unknown' && Number(info.confidence || 0) >= 0.85) {
          strong += 1;
          levels.add(String(info.level));
        }
      }
    } catch (e) {}
    const ratio = total ? (strong / total) : 0;
    // "Honest" heuristic: we only show Level UI when we see consistent structured markers on a meaningful portion of lines.
    const supported = (total >= 25 && strong >= 6 && ratio >= 0.12 && levels.size >= 1) || (strong >= 18 && total >= 20);
    return { supported: !!supported, total, strong, ratio, levels: Array.from(levels) };
  }

  function _applyLevelUiSupportFromLines(lines) {
    const wrap = byId('dt-log-level-wrap');
    const profileWrap = byId('dt-log-profile');
    const stats = _evaluateLevelUiSupport(lines);
    const supported = !!(stats && stats.supported);
    const prev = !!_logUi.levelUiSupported;
    _logUi.levelUiSupported = supported;

    try { if (wrap) wrap.style.display = supported ? '' : 'none'; } catch (e) {}
    try { if (profileWrap) profileWrap.style.display = supported ? '' : 'none'; } catch (e) {}

    // If support dropped, reset to a safe state.
    if (!supported && prev) {
      _logUi.minLevel = 'debug';
      _logUi.profile = 'all';
      try {
        const levelEl = byId('dt-log-level');
        if (levelEl) levelEl.value = 'debug';
      } catch (e) {}
      try { _setLogProfile('all'); } catch (e) {}
    }
  }

  function _normalizePresetList(arr) {
    const out = [];
    try {
      const set = new Set();
      for (const x of (arr || [])) {
        const k = String(x || '').trim().toLowerCase();
        if (!k) continue;
        if (set.has(k)) continue;
        set.add(k);
        out.push(k);
      }
    } catch (e) {}
    return out;
  }

  function _getLogFilterConfig() {
    // Stage 5: the inputs are token entries (chips are stored in _logUi.*Tokens).
    const searchEl = byId('dt-log-search');
    const exclEl = byId('dt-log-exclude');
    const regexEl = byId('dt-log-regex');
    const tsEl = byId('dt-log-show-ts');
    const levelEl = byId('dt-log-level');

    const regexEnabled = (regexEl && typeof regexEl.checked !== 'undefined') ? !!regexEl.checked : !!_logUi.regexEnabled;
    const showTimestamps = (tsEl && typeof tsEl.checked !== 'undefined') ? !!tsEl.checked : !!_logUi.showTimestamps;
    const profile = String(_logUi.profile || 'all');
    const minLevel = (levelEl && typeof levelEl.value !== 'undefined') ? String(levelEl.value || 'debug') : String(_logUi.minLevel || 'debug');
    const presets = _normalizePresetList(_logUi.presets || []);
    const includeTokens = _normalizeTokensList(_logUi.includeTokens || []);
    const excludeTokens = _normalizeTokensList(_logUi.excludeTokens || []);
    const levelUiSupported = !!_logUi.levelUiSupported;

    // Keep drafts in the input from affecting filtering until Enter is pressed.
    // (We still allow users to see their draft; it just doesn't change filtering yet.)
    try { if (searchEl) void searchEl.value; } catch (e) {}
    try { if (exclEl) void exclEl.value; } catch (e) {}

    return { profile, showTimestamps, regexEnabled, presets, includeTokens, excludeTokens, minLevel, levelUiSupported };
  }

  function _setRegexErrorUi(msg) {
    const includeField = byId('dt-log-include-field');
    const errEl = byId('dt-log-regex-error');
    const m = msg ? String(msg) : '';
    const invalid = !!m;

    try {
      if (includeField) includeField.classList.toggle('is-invalid', invalid);
    } catch (e) {}

    try {
      if (errEl) {
        errEl.textContent = m;
        errEl.style.display = invalid ? '' : 'none';
      }
    } catch (e) {}
  }

  function _compileSearchRegex(cfg) {
    const enabled = !!(cfg && cfg.regexEnabled);
    const patterns = enabled ? (cfg && Array.isArray(cfg.includeTokens) ? cfg.includeTokens : []) : [];
    const cleaned = (patterns || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!enabled || !cleaned.length) {
      _setRegexErrorUi('');
      return null;
    }
    try {
      const res = [];
      for (const p of cleaned) {
        res.push(new RegExp(p, 'i'));
      }
      _setRegexErrorUi('');
      return res;
    } catch (e) {
      const msg = 'Regex invalid: ' + (e && e.message ? e.message : String(e));
      _setRegexErrorUi(msg);
      return null;
    }
  }

  function _hasContentFilters(cfg) {
    if (!cfg) return false;
    // Level/profile filters only count when the parser is supported for this log.
    if (cfg.levelUiSupported) {
      if (String(cfg.minLevel || 'debug') !== 'debug') return true;
      if (String(cfg.profile || 'all') !== 'all') return true;
    }
    if (cfg.regexEnabled && Array.isArray(cfg.includeTokens) && cfg.includeTokens.length) return true;
    if (Array.isArray(cfg.includeTokens) && cfg.includeTokens.length) return true;
    if (Array.isArray(cfg.excludeTokens) && cfg.excludeTokens.length) return true;
    if (Array.isArray(cfg.presets) && cfg.presets.length) return true;
    return false;
  }

  function _setLogProfile(profile) {
    const p = (profile === 'errors' || profile === 'warnings' || profile === 'info' || profile === 'all') ? profile : 'all';
    _logUi.profile = p;
    // Keep Stage 6 min-level in sync with presets.
    try {
      if (p === 'errors') _logUi.minLevel = 'error';
      else if (p === 'warnings') _logUi.minLevel = 'warning';
      else if (p === 'info') _logUi.minLevel = 'info';
      else _logUi.minLevel = 'debug';
    } catch (e) { _logUi.minLevel = 'debug'; }
    try {
      const levelEl = byId('dt-log-level');
      if (levelEl) levelEl.value = String(_logUi.minLevel || 'debug');
    } catch (e) {}
    try {
      const btns = document.querySelectorAll('.dt-log-profile-btn');
      for (const b of (btns || [])) {
        const bp = String(b.dataset && b.dataset.profile ? b.dataset.profile : '');
        b.classList.toggle('active', bp === p);
      }
    } catch (e) {}
  }

  function _setPresetActive(key, isActive) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return;
    const set = new Set(_normalizePresetList(_logUi.presets || []));
    if (isActive) set.add(k); else set.delete(k);
    _logUi.presets = Array.from(set);
    try {
      const btns = document.querySelectorAll('.dt-chip-btn');
      for (const b of (btns || [])) {
        const bp = String(b.dataset && b.dataset.preset ? b.dataset.preset : '').toLowerCase();
        if (!bp) continue;
        b.classList.toggle('active', set.has(bp));
      }
    } catch (e) {}
  }

  function _syncLogUiToControls() {
    // Called on init to reflect state in UI.
    try { _setLogProfile(_logUi.profile || 'all'); } catch (e) {}
    try {
      const searchEl = byId('dt-log-search');
      const exclEl = byId('dt-log-exclude');
      const regexEl = byId('dt-log-regex');
      const tsEl = byId('dt-log-show-ts');
      const simpleMode = !byId('dt-log-include-field');
      if (simpleMode) {
        // In simplified UI, the filter input is the source of truth.
        try { if (searchEl) searchEl.value = String((_logUi.includeTokens || []).join(' ') || ''); } catch (e) { if (searchEl) searchEl.value = ''; }
      } else {
        // Token entry inputs are drafts only.
        if (searchEl) searchEl.value = '';
        if (exclEl) exclEl.value = '';
      }
      if (regexEl) regexEl.checked = !!_logUi.regexEnabled;
      if (tsEl) tsEl.checked = !!_logUi.showTimestamps;
    } catch (e) {}
    try {
      const levelEl = byId('dt-log-level');
      if (levelEl) levelEl.value = String(_logUi.minLevel || 'debug');
    } catch (e) {}
    try {
      for (const k of LOG_PRESET_KEYS) _setPresetActive(k, (_logUi.presets || []).includes(k));
    } catch (e) {}
    try {
      _renderTokenField('include');
      _renderTokenField('exclude');
    } catch (e) {}
  }

function _isLogsTabActive() {
  return _activeTab === 'logs';
}

function _formatBytes(n) {
  try {
    const v = Math.max(0, Number(n || 0));
    if (v < 1024) return v.toFixed(0) + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
    return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  } catch (e) {
    return '0 B';
  }
}

function _formatAgeRu(mtime) {
  try {
    const t = Number(mtime || 0);
    if (!t || t <= 0) return 'обновлён —';
    const now = Date.now() / 1000;
    let d = Math.max(0, now - t);
    if (d < 60) return 'обновлён ' + Math.floor(d) + 'с назад';
    d = d / 60;
    if (d < 60) return 'обновлён ' + Math.floor(d) + 'м назад';
    d = d / 60;
    if (d < 48) return 'обновлён ' + Math.floor(d) + 'ч назад';
    d = d / 24;
    return 'обновлён ' + Math.floor(d) + 'д назад';
  } catch (e) {
    return 'обновлён —';
  }
}

function _buildMetaMap(list) {
  const m = {};
  try {
    for (const it of (list || [])) {
      const name = String(it && it.name ? it.name : '');
      if (!name) continue;
      m[name] = it;
    }
  } catch (e) {}
  return m;
}

function _renderLogSidebar() {
  const box = byId('dt-log-list');
  if (!box) return;
  box.innerHTML = '';
  if (!_logList || !_logList.length) {
    box.innerHTML = '<div class="small" style="opacity:0.85;">(нет логов)</div>';
    return;
  }
  const sel = byId('dt-log-select');
  const current = sel ? String(sel.value || '') : '';

  for (const it of _logList) {
    const name = String(it && it.name ? it.name : '');
    const exists = !!(it && it.exists);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dt-log-item' +
      (name && name === current ? ' active' : '') +
      (!exists ? ' is-missing' : '') +
      (_logHasNew[name] ? ' has-new' : '');
    btn.dataset.name = name;

    const sizeTxt = _formatBytes(it && it.size ? it.size : 0);
    const ageTxt = _formatAgeRu(it && it.mtime ? it.mtime : 0);

    btn.innerHTML =
      '<div class="dt-log-left">' +
        '<div class="dt-log-name">' + escapeHtml(name) + '</div>' +
      '</div>' +
      '<div class="dt-log-right">' +
        '<span class="dt-log-dot" aria-hidden="true"></span>' +
        '<div class="dt-log-meta">' +
          '<span class="dt-log-size" data-role="size">' + escapeHtml(sizeTxt) + '</span>' +
          '<span class="dt-log-age" data-role="age">' + escapeHtml(ageTxt) + '</span>' +
        '</div>' +
      '</div>';

    btn.addEventListener('click', () => {
      if (!exists) return;
      try {
        if (sel) sel.value = name;
      } catch (e) {}
      _logHasNew[name] = false;
      _renderLogSidebar();
      loadLogTail(false);
    });

    box.appendChild(btn);
  }
}

function _updateSidebarAgesOnly() {
  const box = byId('dt-log-list');
  if (!box) return;
  try {
    const items = box.querySelectorAll('.dt-log-item');
    items.forEach((el) => {
      const name = el && el.dataset ? String(el.dataset.name || '') : '';
      const meta = _logMetaByName ? _logMetaByName[name] : null;
      if (!meta) return;
      const age = el.querySelector('[data-role="age"]');
      if (age) age.textContent = _formatAgeRu(meta.mtime);
      const sz = el.querySelector('[data-role="size"]');
      if (sz) sz.textContent = _formatBytes(meta.size);
    });
  } catch (e) {}
}

function stopLogListPolling() {
  if (_logListTimer) {
    try { clearInterval(_logListTimer); } catch (e) {}
    _logListTimer = null;
  }
  if (_logRelTimer) {
    try { clearInterval(_logRelTimer); } catch (e) {}
    _logRelTimer = null;
  }
}

function startLogListPolling() {
  stopLogListPolling();
  // Poll sidebar metadata every 5s while Logs tab is open
  _logListTimer = setInterval(() => {
    if (!_isLogsTabActive()) return;
    loadLogList(true);
  }, 5000);

  // Update "обновлён N сек назад" without extra requests
  _logRelTimer = setInterval(() => {
    if (!_isLogsTabActive()) return;
    _updateSidebarAgesOnly();
  }, 1000);
}

  

// ------------------------- Logs: rendering helpers (Stage 3 step 3) -------------------------

let _logViewRenderedName = '';
let _logViewRenderedUnfiltered = true;
let _logViewRenderedCount = 0;

function _stripLineEnding(s) {
  try {
    return String(s || '').replace(/[\r\n]+$/g, '');
  } catch (e) {
    return '';
  }
}

// DevTools Logs: we want *no* ANSI garbage (\x1b[...m etc.) in the viewer.
// We also don't want to color whole lines — only the level token ([Info]/ERROR/etc.).
function _stripAnsiForRender(text) {
  // Reuse the same stripping rules as filtering.
  return _stripAnsiForMatch(text);
}

function _highlightLogLevelTokenHtml(text) {
  // Returns HTML (already escaped) where only the level token is wrapped.
  try {
    const s = String(text || '');

    // Prefer bracketed tokens: [Info], [ERROR], etc.
    const reBracket = /\[(trace|debug|info|warn|warning|error|fatal|panic)\]/i;
    const mB = s.match(reBracket);
    if (mB && typeof mB.index === 'number' && mB.index >= 0 && mB.index < 120) {
      const level = _mapLevelToken(mB[1]);
      const tok = mB[0];
      const before = s.slice(0, mB.index);
      const after = s.slice(mB.index + tok.length);
      return (
        escapeHtml(before) +
        '<span class="log-lvl log-lvl-' + escapeHtml(level) + '">' + escapeHtml(tok) + '</span>' +
        escapeHtml(after)
      );
    }

    // Fallback: prefix token near start (after optional whitespace): INFO:, ERROR -, warn ...
    const rePrefix = /^(\s*)(trace|debug|info|warn|warning|error|fatal|panic)\b/i;
    const mP = s.match(rePrefix);
    if (mP) {
      const lead = mP[1] || '';
      const tok = mP[2] || '';
      const level = _mapLevelToken(tok);
      const before = lead;
      const after = s.slice(lead.length + tok.length);
      return (
        escapeHtml(before) +
        '<span class="log-lvl log-lvl-' + escapeHtml(level) + '">' + escapeHtml(tok) + '</span>' +
        escapeHtml(after)
      );
    }

    return escapeHtml(s);
  } catch (e) {
    return escapeHtml(text || '');
  }
}

function _makeLogLineSpan(lineChunk, showTimestamps) {
  const original = _stripLineEnding(lineChunk);
  // Strip ANSI/control sequences for the viewer (prevents \u001b showing up as "\u001b[33m").
  const cleanOriginal = _stripAnsiForRender(original);

  const info = _parseLogLevelInfo(cleanOriginal);
  const lvl = info && info.level ? String(info.level) : _parseLogLevel(cleanOriginal);
  const cls = (lvl === 'error') ? 'log-line log-line-error'
    : (lvl === 'warning') ? 'log-line log-line-warning'
    : (lvl === 'info') ? 'log-line log-line-info'
    : (lvl === 'debug') ? 'log-line log-line-debug'
    : (typeof window.getXrayLogLineClass === 'function') ? window.getXrayLogLineClass(original)
    : 'log-line';

  const span = document.createElement('span');
  span.className = cls;
  try { span.dataset.level = lvl; } catch (e) {}

  const ts = _extractTimestampPrefix(cleanOriginal);
  const wantTs = !!showTimestamps;

  // Show timestamps: try to render it as a separate chunk (nicer readability), but fall back to full line.
  if (wantTs && ts.ts) {
    span.innerHTML = '<span class="log-ts">' + escapeHtml(ts.ts) + '</span>' + _highlightLogLevelTokenHtml(ts.rest || '');
    return span;
  }

  if (wantTs || !ts.ts) {
    span.innerHTML = _highlightLogLevelTokenHtml(cleanOriginal || '');
    return span;
  }

  // Hide timestamps: if we parsed -> drop it; if not parsed -> drop "timestamp-like" prefix (fallback).
  span.innerHTML = _highlightLogLevelTokenHtml(ts.rest || '');
  return span;
}

function _renderLogLinesFragment(lineChunks, showTimestamps, idxMeta) {
  const frag = document.createDocumentFragment();
  try {
    let i = 0;
    for (const ch of (lineChunks || [])) {
      const span = _makeLogLineSpan(ch, showTimestamps);
      // Stage 8: tag DOM line nodes with the raw buffer index so click handlers can
      // resolve a line quickly without expensive DOM scans.
      try {
        let rawIdx = null;
        if (Array.isArray(idxMeta)) {
          rawIdx = (typeof idxMeta[i] !== 'undefined') ? idxMeta[i] : null;
        } else if (typeof idxMeta === 'number' && isFinite(idxMeta)) {
          rawIdx = idxMeta + i;
        }
        if (rawIdx !== null && typeof rawIdx !== 'undefined' && span && span.dataset) {
          span.dataset.rawIdx = String(rawIdx);
        }
      } catch (e) {}
      frag.appendChild(span);
      i += 1;
    }
  } catch (e) {}
  return frag;
}

function _trimLogViewTop(view, n) {
  if (!view || !n || n <= 0) return 0;
  let removed = 0;
  try {
    while (removed < n && view.firstChild) {
      view.removeChild(view.firstChild);
      removed += 1;
    }
  } catch (e) {}
  return removed;
}

function _isViewAtBottom(view) {
  try {
    return view.scrollTop + view.clientHeight >= view.scrollHeight - 5;
  } catch (e) {
    return true;
  }
}

function _maybeToastTailReset() {
  const now = Date.now();
  if (now - _lastTailResetToastAt < 8000) return;
  _lastTailResetToastAt = now;
  toast('Log reset/rotated — reloading window');
}

function _renderLogViewFull(view, name, lineChunks, opts) {
  if (!view) return;
  const follow = !!(opts && opts.follow);
  const isUnfiltered = !!(opts && opts.unfiltered);

  // Clear + render
  try { view.innerHTML = ''; } catch (e) {}
  const wantTs = !!(opts && typeof opts.showTimestamps !== 'undefined' ? opts.showTimestamps : true);
  const idxMeta = (() => {
    try {
      if (opts && Array.isArray(opts.rawIdx)) return opts.rawIdx;
      if (opts && typeof opts.rawIdx === 'number' && isFinite(opts.rawIdx)) return opts.rawIdx;
      // Unfiltered full render: view order == raw buffer order.
      if (isUnfiltered) return 0;
    } catch (e) {}
    return null;
  })();
  view.appendChild(_renderLogLinesFragment(lineChunks, wantTs, idxMeta));

  // Update render state
  _logViewRenderedName = String(name || '');
  _logViewRenderedUnfiltered = isUnfiltered;
  _logViewRenderedCount = Array.isArray(lineChunks) ? lineChunks.length : 0;
  try { _logViewRenderedShowTimestamps = !!(opts && typeof opts.showTimestamps !== 'undefined' ? opts.showTimestamps : true); } catch (e) { _logViewRenderedShowTimestamps = true; }

  if (follow) {
    try { view.scrollTop = view.scrollHeight; } catch (e) {}
  }
}

function _appendLogViewLines(view, name, lineChunks, opts) {
  if (!view) return;
  const follow = !!(opts && opts.follow);
  const trimTop = Number(opts && opts.trimTop ? opts.trimTop : 0) || 0;

  // If view is out-of-sync, caller should fallback to full render.
  if (_logViewRenderedName !== String(name || '')) return;

  if (trimTop > 0) {
    const removed = _trimLogViewTop(view, trimTop);
    _logViewRenderedCount = Math.max(0, _logViewRenderedCount - removed);
  }

  if (Array.isArray(lineChunks) && lineChunks.length) {
    const wantTs = !!(_logViewRenderedShowTimestamps);
    // In unfiltered mode, view order matches raw buffer order.
    const startIdx = (typeof opts.startIdx === 'number' && isFinite(opts.startIdx)) ? opts.startIdx : _logViewRenderedCount;
    view.appendChild(_renderLogLinesFragment(lineChunks, wantTs, startIdx));
    _logViewRenderedCount += lineChunks.length;
  }

  if (follow) {
    try { view.scrollTop = view.scrollHeight; } catch (e) {}
  }
}

let _logViewRenderedShowTimestamps = true;

function _canAppendToView(name, cfg, view) {
  if (!view) return false;
  if (!name) return false;
  if (_hasContentFilters(cfg)) return false;
  if (_logViewRenderedName !== String(name || '')) return false;
  if (!_logViewRenderedUnfiltered) return false;
  try {
    const wantTs = !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true);
    if (wantTs !== _logViewRenderedShowTimestamps) return false;
  } catch (e) {}
  try {
    const domCount = view.childNodes ? view.childNodes.length : 0;
    if (domCount !== _logViewRenderedCount) return false;
  } catch (e) {
    return false;
  }
  return true;
}

function applyLogFilterToView(opts) {
  const view = byId('dt-log-view');
  if (!view) return;

  const pathEl = byId('dt-log-path');
  const statsEl = byId('dt-log-stats');
  const followEl = byId('dt-log-follow');

  const preserveScroll = !!(opts && opts.preserveScroll);
  const prevScrollTop = preserveScroll ? (Number(view.scrollTop || 0) || 0) : 0;
  const prevScrollHeight = preserveScroll ? (Number(view.scrollHeight || 0) || 0) : 0;

  const cfg = _getLogFilterConfig();
  const hasFilter = _hasContentFilters(cfg);

  // Build predicates
  const presetTerms = Array.isArray(cfg.presets) ? cfg.presets : [];
  const includeTokens = Array.isArray(cfg.includeTokens) ? cfg.includeTokens : [];
  const includeTerms = presetTerms.concat(includeTokens);
  const excludeTerms = Array.isArray(cfg.excludeTokens) ? cfg.excludeTokens : [];

  const searchRes = _compileSearchRegex(cfg); // RegExp[] or null

  const src = Array.isArray(_logRawLines) ? _logRawLines : [];
  let filtered = src;
  let filteredIdx = [];
  if (!hasFilter) {
    // Unfiltered: view order == raw order.
    filteredIdx = [];
  } else {
    filtered = [];
    filteredIdx = [];
    for (let i = 0; i < src.length; i++) {
      const line = src[i];
      const original = _stripLineEnding(line);
      const info = _parseLogLevelInfo(original);
      const lvl = info && info.level ? String(info.level) : _parseLogLevel(original);

      if (cfg.levelUiSupported) {
        if (!_levelPassesMin(lvl, cfg.minLevel)) continue;
      }

      // For matching, use a normalized view with timestamp prefix removed (regardless of the toggle),
      // so "vpn" doesn't get lost among timestamps.
      const norm = (() => {
        try {
          const ts = _extractTimestampPrefix(original);
          return _stripAnsiForMatch(ts && ts.ts ? (ts.rest || '') : original);
        } catch (e) {
          return _stripAnsiForMatch(original);
        }
      })();
      const lower = String(norm || '').toLowerCase();

      // Exclude always works as plain substring.
      if (excludeTerms.length && excludeTerms.some((t) => lower.includes(String(t).toLowerCase()))) continue;

      // Regex mode: require ALL regex chips to match (if provided) + presets as plain substrings.
      if (cfg.regexEnabled && searchRes && Array.isArray(searchRes) && searchRes.length) {
        if (!searchRes.every((re) => re && re.test(norm || ''))) continue;
        if (presetTerms.length) {
          if (!presetTerms.every((p) => lower.includes(String(p).toLowerCase()))) continue;
        }
        filtered.push(line);
        filteredIdx.push(i);
        continue;
      }

      // Plain search: AND across terms (include + presets).
      if (includeTerms.length && !includeTerms.every((t) => lower.includes(String(t).toLowerCase()))) continue;
      filtered.push(line);
      filteredIdx.push(i);
    }
  }

  _logFilteredLines = filtered;
  _logFilteredRawIdx = filteredIdx;

  const isFollow = !!(followEl && followEl.checked);
  // Avoid expensive joins on every update; Copy builds text from arrays on demand.
  try { view.dataset.rawText = ''; } catch (e) {}
  try { view.dataset.visibleText = ''; } catch (e) {}

  // Fast path: no filters and DOM already matches current buffer → avoid full rerender.
  const domCount = (() => {
    try { return view.childNodes ? view.childNodes.length : 0; } catch (e) { return 0; }
  })();

  const sameUnfiltered =
    !hasFilter &&
    _logViewRenderedName === String(_logSelectedName || '') &&
    _logViewRenderedUnfiltered &&
    _logViewRenderedCount === src.length &&
    domCount === _logViewRenderedCount &&
    _logViewRenderedShowTimestamps === !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true);

  if (!sameUnfiltered) {
    _renderLogViewFull(view, _logSelectedName, filtered, {
      unfiltered: !hasFilter,
      follow: isFollow,
      showTimestamps: !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true),
      rawIdx: hasFilter ? filteredIdx : null,
    });
  } else if (isFollow) {
    try { view.scrollTop = view.scrollHeight; } catch (e) {}
  }

  // Preserve viewport when loading more at the top (Follow must be off).
  if (preserveScroll && !isFollow) {
    try {
      const newH = Number(view.scrollHeight || 0) || 0;
      const delta = newH - prevScrollHeight;
      if (delta) view.scrollTop = prevScrollTop + delta;
    } catch (e) {}
  }

  if (statsEl) {
    const parts = [];
    if (hasFilter) parts.push(`Showing ${filtered.length} / ${src.length}`);
    else parts.push(`Lines: ${src.length}`);
    if (cfg.levelUiSupported && String(cfg.minLevel || 'debug') !== 'debug') parts.push('level>=' + String(cfg.minLevel).toUpperCase());
    if (cfg.regexEnabled) parts.push('regex');
    if ((cfg.presets || []).length) parts.push('presets=' + (cfg.presets || []).join(','));
    if ((cfg.includeTokens || []).length) parts.push('include=' + (cfg.includeTokens || []).join(','));
    if ((cfg.excludeTokens || []).length) parts.push('exclude=' + (cfg.excludeTokens || []).join(','));
    statsEl.textContent = parts.join(' · ');
  }
  if (pathEl && !pathEl.textContent) {
    // noop
  }
}



// ------------------------- Logs: Stage 9 WS stream -------------------------

function _logWsClearReconnectTimer() {
  if (_logWsReconnectTimer) {
    try { clearTimeout(_logWsReconnectTimer); } catch (e) {}
    _logWsReconnectTimer = null;
  }
}

function _logWsDesired() {
  // Live stream only when Logs tab is visible and Live is enabled.
  const liveEl = byId('dt-log-live') || byId('dt-log-auto');
  const live = !!(liveEl && liveEl.checked);
  if (!live) return false;
  if (!_isLogsTabActive()) return false;
  if (_logWsDisabled) return false;
  if (_capWebsocket === false) return false;
  return (typeof WebSocket !== 'undefined');
}

function _logWsBuildUrl(name) {
  const lines = _getLogLinesWindowSize();
  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  const host = location.host;
  let url = proto + '//' + host + '/ws/devtools-logs?name=' + encodeURIComponent(String(name || ''));
  url += '&lines=' + encodeURIComponent(String(lines || 400));
  // Cursor makes reconnect seamless (no duplicates / no gaps).
  if (_logCursor) url += '&cursor=' + encodeURIComponent(String(_logCursor));
  return url;
}

function _logWsStop(manual) {
  _logWsClearReconnectTimer();
  _logWsReconnectAttempt = 0;
  if (_logWs) {
    // Mark this socket as intentionally closed to avoid reconnect/polling fallback.
    try { _logWs.__xkManualClose = !!manual; } catch (e) {}
    try { _logWs.close(); } catch (e) {}
  }
  _logWs = null;
  _logWsName = '';
  _logWsEverOpened = false;
}

function _logWsScheduleReconnect() {
  _logWsClearReconnectTimer();
  if (!_logWsDesired()) return;
  _logWsReconnectAttempt = Math.min(12, (_logWsReconnectAttempt || 0) + 1);
  const base = 600; // ms
  const delay = Math.min(30000, base * Math.pow(2, Math.min(8, _logWsReconnectAttempt - 1)));
  const jitter = Math.floor(delay * (0.20 * Math.random()));
  const wait = delay + jitter;
  _logWsReconnectTimer = setTimeout(() => {
    _logWsReconnectTimer = null;
    _logWsConnect(true);
  }, wait);
}

function _applyLogTailUpdateAndRenderStream(name, update, isAuto, usedCursor, opts) {
  const view = byId('dt-log-view');
  const pathEl = byId('dt-log-path');
  if (!view) return;

  const info = applyLogTailUpdate(name, update, {
    isAuto: !!isAuto,
    usedCursor: usedCursor,
    requestedLines: _getLogLinesWindowSize(),
  });

  // While paused in Live mode: keep view frozen, only update pending badge.
  if (isAuto && info && info.paused) return;

  const exists = (update && typeof update.exists !== 'undefined') ? !!update.exists : true;
  const path = update && update.path ? String(update.path) : '';
  if (pathEl && path) pathEl.textContent = path;

  const followEl = byId('dt-log-follow');
  const cfg = _getLogFilterConfig();
  const hasFilter = _hasContentFilters(cfg);
  const isFollow = !!(followEl && followEl.checked);

  if (!exists) {
    const msg = 'Log not found: ' + String(name || '') + '\n';
    _logRawLines = [msg];
    _logFilteredLines = [msg];
    _logFilteredRawIdx = [0];
    _renderLogViewFull(view, name, _logFilteredLines, {
      unfiltered: true,
      follow: isFollow,
      showTimestamps: !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true),
    });
    return;
  }

  // If we expected append-only but got full – likely rotation/truncate.
  if (isAuto && usedCursor && update && update.mode === 'full') {
    _maybeToastTailReset();
  }

  try { _applyLevelUiSupportFromLines(_logRawLines); } catch (e) {}

  const canAppend = !!(
    isAuto &&
    usedCursor &&
    update &&
    update.mode === 'append' &&
    Array.isArray(_logRawLines) &&
    _logRawLines.length
  );

  // Fast path: no filters and append update → append to DOM only.
  if (canAppend && !hasFilter) {
    try { _appendLogLinesToView(view, info.appendedLines || []); } catch (e) {}
  } else {
    applyLogFilterToView(opts || {});
  }
}

function _logWsConnect(isReconnect) {
  if (!_logWsDesired()) return;

  const sel = byId('dt-log-select');
  const name = sel ? String(sel.value || '') : String(_logSelectedName || '');
  if (!name) return;

  // If already connected/connecting to the same log – keep it.
  if (_logWs && _logWsName === name && (_logWs.readyState === 0 || _logWs.readyState === 1)) {
    return;
  }

  // Close previous socket (if any).
  if (_logWs) {
    // Mark old socket as intentionally closed so its onclose won't trigger reconnect/polling.
    try { _logWs.__xkManualClose = true; } catch (e) {}
    try { _logWs.close(); } catch (e) {}
  }
  _logWs = null;
  _logWsName = name;
  _logWsEverOpened = false;

  const url = _logWsBuildUrl(name);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    // Browser/env does not allow WS.
    _logWsDisabled = true;
    return;
  }

  _logWs = ws;

  ws.onopen = () => {
    if (_logWs !== ws) return;
    _logWsEverOpened = true;
    _logWsReconnectAttempt = 0;
    // WS заменяет polling – убираем интервальный fetch.
    stopLogAutoRefresh();
  };

  ws.onmessage = (ev) => {
    if (_logWs !== ws) return;
    let data;
    try { data = JSON.parse(ev && ev.data ? ev.data : '{}'); } catch (e) { return; }
    if (!data) return;

    // Ignore stray messages for an old log.
    try {
      if (_logWsName && String(data.name || '') && String(data.name) !== String(_logWsName)) return;
      const current = sel ? String(sel.value || '') : String(_logSelectedName || '');
      if (current && _logWsName && current !== _logWsName) return;
    } catch (e) {}

    // Server-side errors: disable WS for this session.
    if (data.type === 'error') {
      _logWsDisabled = true;
      try { _logWsStop(true); } catch (e) {}
      _startLogPollingInternal();
      return;
    }

    const prevCursor = _logCursor;

    let mode = String(data.mode || '').toLowerCase();
    if (!mode) {
      if (data.type === 'append' || data.type === 'line') mode = 'append';
      else mode = 'full';
    }

    let lines = [];
    if (Array.isArray(data.lines)) lines = data.lines;
    else if (typeof data.line === 'string') lines = [data.line];

    const update = {
      ok: true,
      name: String(data.name || name),
      path: String(data.path || ''),
      lines: lines,
      cursor: (typeof data.cursor === 'string') ? data.cursor : null,
      mode: (mode === 'append') ? 'append' : 'full',
      exists: (typeof data.exists !== 'undefined') ? !!data.exists : true,
      size: (typeof data.size !== 'undefined') ? Number(data.size || 0) : 0,
      mtime: (typeof data.mtime !== 'undefined') ? Number(data.mtime || 0) : 0,
      ino: (typeof data.ino !== 'undefined') ? Number(data.ino || 0) : 0,
    };

    // Always treat WS stream as "auto" updates (Live).
    _applyLogTailUpdateAndRenderStream(update.name, update, true, (update.mode === 'append' ? prevCursor : null), {});
  };

  ws.onclose = () => {
    if (_logWs !== ws) return;
    const wasManual = !!ws.__xkManualClose;
    const ever = !!_logWsEverOpened;
    _logWs = null;
    _logWsEverOpened = false;

    if (wasManual) return;
    if (!_logWsDesired()) return;

    // If WS never opened – keep UI alive via polling and retry with backoff.
    if (!ever) {
      _startLogPollingInternal();
      _logWsScheduleReconnect();
      return;
    }

    // WS dropped after working: keep UI alive via polling + try to reconnect with backoff.
    _startLogPollingInternal();
    _logWsScheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will handle fallback
  };
}

function _startLogPollingInternal() {
  const autoEl = byId('dt-log-live') || byId('dt-log-auto');
  const intervalEl = byId('dt-log-interval');
  if (!autoEl || !autoEl.checked) return;
  if (!_isLogsTabActive()) return;

  // Don't start polling when WS is active.
  if (_logWs && _logWs.readyState === 1) return;

  if (_logTimer) return;

  let ms = 5000;
  try { ms = parseInt(String(intervalEl && intervalEl.value ? intervalEl.value : '5000'), 10); } catch (e) {}
  if (!ms || ms < 500) ms = 5000;

  _logTimer = setInterval(() => {
    if (!_isLogsTabActive()) return;
    const liveEl = byId('dt-log-live') || byId('dt-log-auto');
    if (!liveEl || !liveEl.checked) return;
    loadLogTail(true);
  }, ms);
}

function _stopLogStreamingAll() {
  stopLogAutoRefresh();
  _logWsStop(true);
}

function stopLogAutoRefresh() {
    if (_logTimer) {
      try { clearInterval(_logTimer); } catch (e) {}
      _logTimer = null;
    }
  }

  function startLogAutoRefresh() {
    const autoEl = byId('dt-log-live') || byId('dt-log-auto');
    try { _tail.isLive = !!(autoEl && autoEl.checked); } catch (e) {}

    // If Live is off or Logs tab is hidden – stop everything.
    if (!autoEl || !autoEl.checked || !_isLogsTabActive()) {
      _stopLogStreamingAll();
      return;
    }

    // Prefer WebSocket for perfect smoothness and minimal load.
    // But: on some runtimes the WS handshake can hang (no open/close events),
    // which would otherwise stall live updates. So we keep a lightweight polling
    // fallback running until WS is confirmed open.
    if (_logWsDesired()) {
      stopLogAutoRefresh();

      // Safety net: polling in parallel until WS is open (ws.onopen will stop it).
      _startLogPollingInternal();

      // Quick first refresh while handshake is pending (prevents "looks stuck" feeling).
      try {
        setTimeout(() => {
          try {
            if (!_isLogsTabActive()) return;
            const liveEl = byId('dt-log-live') || byId('dt-log-auto');
            if (!liveEl || !liveEl.checked) return;
            if (_logWs && _logWs.readyState === 1) return;
            loadLogTail(true);
          } catch (e) {}
        }, 900);
      } catch (e) {}

      _logWsConnect(false);
      return;
    }

    // WS not available → polling.
    _logWsStop(true);
    stopLogAutoRefresh();
    _startLogPollingInternal();
  }

  function setActiveTab(tabName) {
    const btnTools = byId('dt-tab-btn-tools');
    const btnLogs = byId('dt-tab-btn-logs');
    const tabTools = byId('dt-tab-tools');
    const tabLogs = byId('dt-tab-logs');

    function isForceHidden(el) {
      try { return !!(el && el.dataset && el.dataset.xkForceHidden === '1'); } catch (e) { return false; }
    }

    const toolsForced = isForceHidden(btnTools) || isForceHidden(tabTools) || (btnTools && btnTools.style.display === 'none');
    const logsForced = isForceHidden(btnLogs) || isForceHidden(tabLogs) || (btnLogs && btnLogs.style.display === 'none');

    let next = (tabName === 'logs') ? 'logs' : 'tools';
    if (next === 'tools' && toolsForced && !logsForced) next = 'logs';
    if (next === 'logs' && logsForced && !toolsForced) next = 'tools';
    if ((next === 'tools' && toolsForced) || (next === 'logs' && logsForced)) {
      // Both are hidden or requested one is hidden and the other is also hidden.
      // Hide panels and stop any streaming.
      try { if (tabTools) tabTools.style.display = 'none'; } catch (e) {}
      try { if (tabLogs) tabLogs.style.display = 'none'; } catch (e) {}
      try { _stopLogStreamingAll(); } catch (e) {}
      try { stopLogListPolling(); } catch (e) {}
      return;
    }

    _activeTab = next;

    if (btnTools) {
      const active = (_activeTab === 'tools') && !toolsForced;
      btnTools.classList.toggle('active', active);
      btnTools.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (btnLogs) {
      const active = (_activeTab === 'logs') && !logsForced;
      btnLogs.classList.toggle('active', active);
      btnLogs.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    if (tabTools) tabTools.style.display = ((_activeTab === 'tools') && !toolsForced) ? '' : 'none';
    if (tabLogs) tabLogs.style.display = ((_activeTab === 'logs') && !logsForced) ? '' : 'none';

    // Pause auto-refresh when Logs tab is hidden.
    if (_activeTab === 'logs') {
      startLogAutoRefresh();
      startLogListPolling();
      // Fetch immediately on tab open.
      // If WS is available and Live is enabled, let WS deliver the snapshot (one less HTTP request).
      try {
        const autoEl = byId('dt-log-live') || byId('dt-log-auto');
        const wantAuto = !!(autoEl && autoEl.checked);
        const wsWanted = !!(wantAuto && _logWsDesired());
        if (!wsWanted) loadLogTail(wantAuto);
      } catch (e) {
        loadLogTail(false);
      }
    } else {
      _stopLogStreamingAll();
      stopLogListPolling();
    }
  }

  function _manualReloadLogAndResumeLive() {
    const autoEl = byId('dt-log-live') || byId('dt-log-auto');
    const wasLive = !!(autoEl && autoEl.checked);
    // Stop streaming while doing a manual reload to avoid mixed cursors / duplicates.
    try { _logWsStop(true); } catch (e) {}
    stopLogAutoRefresh();
    return Promise.resolve(loadLogTail(false)).finally(() => {
      if (wasLive) startLogAutoRefresh();
    });
  }

  
async function loadLogList(silent) {
  const sel = byId('dt-log-select');
  const statusEl = byId('dt-log-list-status');

  try {
    const data = await getJSON('/api/devtools/logs');
    let list = (data && data.logs) ? data.logs : [];
    // UI simplification: hide access.log (it's usually duplicated in Xray live logs / terminal)
    try {
      list = (list || []).filter((it) => {
        const name = String(it && it.name ? it.name : '');
        return !/^access(\.|$)/i.test(name);
      });
    } catch (e) {}

    const prevMap = _logMetaByName || {};
    const nextMap = _buildMetaMap(list);

    // Track "new lines" indicator: any growth in size/mtime since last seen.
    const current = sel ? String(sel.value || '') : '';
    try {
      for (const it of list) {
        const name = String(it && it.name ? it.name : '');
        if (!name) continue;
        const prev = prevMap[name];
        if (prev && it && prev && it.exists && prev.exists) {
          const grew = (Number(it.size || 0) > Number(prev.size || 0)) || (Number(it.mtime || 0) > Number(prev.mtime || 0) + 0.001);
          if (grew && name !== current) _logHasNew[name] = true;
        }
      }
    } catch (e) {}

    _logList = list;
    _logMetaByName = nextMap;

    // Sync hidden select (kept for existing logic)
    if (sel) {
      const oldVal = String(sel.value || '');
      sel.innerHTML = '';
      for (const it of list) {
        const opt = document.createElement('option');
        opt.value = it.name;
        opt.textContent = it.name;
        if (it && it.exists === false) opt.disabled = true;
        sel.appendChild(opt);
      }

      // Ensure a valid selection
      let nextVal = oldVal;
      const meta = nextMap[nextVal];
      if (!nextVal || !meta || meta.exists === false) {
        const firstExisting = (list || []).find((x) => x && x.exists);
        nextVal = firstExisting ? String(firstExisting.name || '') : (list[0] ? String(list[0].name || '') : '');
      }
      if (nextVal) {
        try { sel.value = nextVal; } catch (e) {}
      }
    }

    if (statusEl) {
      statusEl.textContent = 'Обновлено: ' + new Date().toLocaleTimeString();
    }

    _renderLogSidebar();
    _updateSidebarAgesOnly();

    // Update current log label
    const currentNameEl = byId('dt-log-current-name');
    if (currentNameEl && sel) {
      currentNameEl.textContent = sel.value ? String(sel.value) : '—';
    }

    // If selection changed and we're on Logs tab, refresh view
    if (!silent && _isLogsTabActive()) {
      // no-op; caller will load tail
    }
  } catch (e) {
    if (!silent) {
      if (statusEl) statusEl.textContent = 'Ошибка списка логов: ' + (e && e.message ? e.message : String(e));
    }
    // Keep previous UI; don't wipe sidebar on transient errors.
  }
}

// ------------------------- Logs: data fetch/apply split (Stage 3 step 2) -------------------------

function _getLogLinesWindowSize() {
  const linesEl = byId('dt-log-lines');
  let lines = 400;
  try { lines = parseInt(String(linesEl && linesEl.value ? linesEl.value : '400'), 10); } catch (e) {}
  if (!lines || lines < 50) lines = 50;
  const hardMax = Math.min(5000, _getBufferLimitLines());
  if (lines > hardMax) lines = hardMax;
  return lines;
}

function _buildLogTailUrl(name, lines, cursor) {
  let url = '/api/devtools/logs/' + encodeURIComponent(name) + '?lines=' + encodeURIComponent(String(lines));
  if (cursor) url += '&cursor=' + encodeURIComponent(String(cursor));
  return url;
}

function _normalizeLogTailResponse(data) {
  const mode = (data && data.mode) ? String(data.mode) : 'full';
  const lns = (data && data.lines) ? data.lines : [];
  return {
    mode: (mode === 'append') ? 'append' : 'full',
    lines: Array.isArray(lns) ? lns : [],
    cursor: (data && data.cursor) ? String(data.cursor) : null,
    path: (data && data.path) ? String(data.path) : '',
    exists: (data && typeof data.exists !== 'undefined') ? !!data.exists : true,
    size: (data && typeof data.size !== 'undefined') ? Number(data.size || 0) : null,
    mtime: (data && typeof data.mtime !== 'undefined') ? Number(data.mtime || 0) : null,
    ino: (data && typeof data.ino !== 'undefined') ? Number(data.ino || 0) : null,
  };
}

async function fetchLogTail(name, lines, cursor) {
  const url = _buildLogTailUrl(name, lines, cursor);
  const data = await getJSON(url);
  return _normalizeLogTailResponse(data);
}


function applyLogTailUpdate(name, update, opts) {
  const isAuto = !!(opts && opts.isAuto);
  const usedCursor = (opts && opts.usedCursor) ? String(opts.usedCursor) : null;
  const exists = (update && typeof update.exists !== 'undefined') ? !!update.exists : true;

  // Update cursor first (so next fetch can continue even if rendering is delayed).
  _logCursor = (update && update.cursor) ? String(update.cursor) : null;
  if (!exists) _logCursor = null;

  const updLines = (update && Array.isArray(update.lines)) ? update.lines : [];
  const appliedMode = (update && update.mode === 'append') ? 'append' : 'full';

  // Clear "new lines" indicator for the currently opened log.
  try { _logHasNew[name] = false; } catch (e) {}

  // Refresh meta snapshot if backend provided it.
  try {
    if (update && update.size !== null && update.mtime !== null) {
      _logMetaByName[name] = Object.assign({}, (_logMetaByName[name] || {}), {
        size: Number(update.size || 0),
        mtime: Number(update.mtime || 0),
        ino: (update.ino === null) ? Number((_logMetaByName[name] || {}).ino || 0) : Number(update.ino || 0),
        exists: (typeof update.exists !== 'undefined') ? !!update.exists : true,
      });
    }
  } catch (e) {}

  // Update path label early (even when paused we can show correct path).
  const pathEl = byId('dt-log-path');
  if (pathEl) pathEl.textContent = update && update.path ? ('Файл: ' + update.path) : '';

  // Always keep sidebar fresh.
  _renderLogSidebar();
  _updateSidebarAgesOnly();

  // Pause mode: keep fetching, but do NOT touch the current view/buffer. Store pending.
  const pausedActive = !!(_tail && _tail.isPaused && isAuto);

  if (pausedActive) {
    const curName = String(name || '');
    if (String(_tail.pendingForName || '') !== curName) {
      _resetPendingFor(curName);
    }

    if (appliedMode === 'append' && usedCursor) {
      // Apply to snapshot if we have it; otherwise accumulate appended lines.
      if (Array.isArray(_tail.pendingSnapshot) && _tail.pendingSnapshot) {
        try {
          for (const x of updLines) _tail.pendingSnapshot.push(x);
          const limit = _getBufferLimitLines();
          if (_tail.pendingSnapshot.length > limit) {
            _tail.pendingSnapshot = _tail.pendingSnapshot.slice(_tail.pendingSnapshot.length - limit);
          }
        } catch (e) {}
      } else {
        if (!Array.isArray(_tail.pendingLines)) _tail.pendingLines = [];
        try {
          for (const x of updLines) _tail.pendingLines.push(x);
          _applyLimitToArrayTail(_tail.pendingLines, _getPendingLimitLines());
        } catch (e) {}
      }

      _bumpPendingCount(updLines.length);
      _updateTailControlsUi();
      return { mode: appliedMode, appendedLines: [], trimmedTop: 0, paused: true, pendingAdded: updLines.length };
    }

    // Full update while paused: store the latest window snapshot.
    try {
      const snap = Array.isArray(updLines) ? updLines.slice(0) : [];
      // Keep snapshot bounded by the same buffer limit (so resume is fast).
      if (snap.length > _getBufferLimitLines()) snap.splice(0, snap.length - _getBufferLimitLines());
      _tail.pendingSnapshot = snap;
      _tail.pendingLines = [];

      const est = _estimateNewLinesFromFull(_logRawLines, snap);
      _tail.pendingCount = _capPendingCount(est && typeof est.newCount !== 'undefined' ? est.newCount : snap.length);
    } catch (e) {
      _tail.pendingSnapshot = Array.isArray(updLines) ? updLines.slice(0) : [];
      _tail.pendingLines = [];
      _tail.pendingCount = _capPendingCount(Array.isArray(_tail.pendingSnapshot) ? _tail.pendingSnapshot.length : 0);
    }

    _updateTailControlsUi();
    return { mode: appliedMode, appendedLines: [], trimmedTop: 0, paused: true, pendingAdded: Number(_tail.pendingCount || 0), hasSnapshot: true };
  }

  // Normal (not paused): apply update to the current buffer.
  let appendedLines = [];
  let trimmedTop = 0;

  if (appliedMode === 'append' && isAuto && usedCursor && Array.isArray(_logRawLines)) {
    appendedLines = updLines;
    for (const x of appendedLines) _logRawLines.push(x);
  } else {
    _logRawLines = updLines;
    appendedLines = [];
  }

  // Keep memory bounded (Stage 3: buffer limit).
  const limit = _getBufferLimitLines();
  if (Array.isArray(_logRawLines) && _logRawLines.length > limit) {
    trimmedTop = _logRawLines.length - limit;
    _logRawLines = _logRawLines.slice(trimmedTop);
  }

  return { mode: appliedMode, appendedLines: appendedLines, trimmedTop: trimmedTop, paused: false };
}




async function loadLogTail(isAuto, opts) {
  const sel = byId('dt-log-select');
  const view = byId('dt-log-view');
  const pathEl = byId('dt-log-path');
  const statsEl = byId('dt-log-stats');
  if (!sel || !view) return;

  const name = String(sel.value || '');
  const currentNameEl = byId('dt-log-current-name');
  if (currentNameEl) currentNameEl.textContent = name || '—';

  if (!name) {
    _logRawLines = [];
    _logFilteredLines = [];
    _logCursor = null;
    _logSelectedName = '';
    _logViewRenderedName = '';
    _logViewRenderedCount = 0;
    _logViewRenderedUnfiltered = true;
    try { view.dataset.rawText = ''; view.dataset.visibleText = ''; } catch (e) {}
    try { view.innerHTML = ''; } catch (e) {}
    if (pathEl) pathEl.textContent = '';
    if (statsEl) statsEl.textContent = '';
    return;
  }

  // If user explicitly refreshes or switches log while paused, unpause and clear pending.
  try {
    if (_tail && _tail.isPaused && (!isAuto || _logSelectedName !== name)) {
      _exitPauseAndClearPending();
    }
  } catch (e) {}

  // Reset incremental cursor on manual refresh or when switching log.
  if (!isAuto || _logSelectedName !== name) {
    _logCursor = null;
    _logSelectedName = name;
  }

  const lines = _getLogLinesWindowSize();

  if (!_logLoading && !isAuto) view.innerHTML = '<span class="log-line">Загрузка…</span>';

  try {
    if (_logLoading) return;
    _logLoading = true;

    // For append mode we must send the *previous* cursor; if cursor is null -> full.
    const usedCursor = (isAuto && _logCursor) ? String(_logCursor) : null;

    const update = await fetchLogTail(name, lines, usedCursor);
    const info = applyLogTailUpdate(name, update, { isAuto: !!isAuto, usedCursor: usedCursor, requestedLines: lines });

    if (isAuto && info && info.paused) {
      // Pause mode: keep view frozen; pending is tracked separately.
      return;
    }

    // Missing log file: clear view/buffer and show a friendly placeholder.
    const exists = (update && typeof update.exists !== 'undefined') ? !!update.exists : true;
    if (!exists) {
      _logRawLines = [];
      _logFilteredLines = [];
      _logCursor = null;
      _logViewRenderedName = '';
      _logViewRenderedCount = 0;
      _logViewRenderedUnfiltered = true;
      try { view.innerHTML = '<span class="log-line">(файл лога не найден)</span>'; } catch (e) {}
      if (statsEl) statsEl.textContent = '';
      // keep path label (it shows resolved path), sidebar already updated
      return;
    }

    // Tail cursor became invalid (rotation/truncate): backend returns full window even with cursor.
    if (isAuto && usedCursor && update && update.mode === 'full') {
      _maybeToastTailReset();
    }

    // Stage 6: decide whether Level UI is supported for this log window.
    try { _applyLevelUiSupportFromLines(_logRawLines); } catch (e) {}

    // Decide whether we can do true tail-style append without full rerender.
    const followEl = byId('dt-log-follow');
    const cfg = _getLogFilterConfig();
    const hasFilter = _hasContentFilters(cfg);
    const isFollow = !!(followEl && followEl.checked);


const canAppend =
  info &&
  info.mode === 'append' &&
  !!usedCursor &&
  !hasFilter &&
  Array.isArray(info.appendedLines) &&
  info.appendedLines.length > 0 &&
  _canAppendToView(name, cfg, view);

const canNoopAppend =
  info &&
  info.mode === 'append' &&
  !!usedCursor &&
  !hasFilter &&
  _canAppendToView(name, cfg, view) &&
  (!Array.isArray(info.appendedLines) || info.appendedLines.length === 0) &&
  !(Number(info.trimmedTop || 0) > 0);

if (canNoopAppend) {
  _logFilteredLines = Array.isArray(_logRawLines) ? _logRawLines : [];
  // Follow: auto-scroll to bottom.
  if (isFollow) {
    try { view.scrollTop = view.scrollHeight; } catch (e) {}
  }
  if (statsEl) statsEl.textContent = `Lines: ${_logFilteredLines.length}`;
} else if (canAppend) {
  _appendLogViewLines(view, name, info.appendedLines, {
    trimTop: Number(info.trimmedTop || 0),
    follow: isFollow,
  });

  // Unfiltered: filtered view equals raw buffer.
  _logFilteredLines = Array.isArray(_logRawLines) ? _logRawLines : [];

  // Update datasets used by Copy/Download helpers (bounded by buffer limit).
  try { view.dataset.rawText = ''; } catch (e) {}
  try { view.dataset.visibleText = ''; } catch (e) {}

  if (statsEl) statsEl.textContent = `Lines: ${_logFilteredLines.length}`;
} else {
  applyLogFilterToView(opts);
}
  } catch (e) {
    const msg = 'Ошибка: ' + (e && e.message ? e.message : String(e));
    _logRawLines = [msg + '\n'];
    _logFilteredLines = _logRawLines;
    _logCursor = null;
    if (pathEl) pathEl.textContent = '';
    applyLogFilterToView();
  } finally {
    _logLoading = false;
  }
}

function _copyToClipboard(text, okMsg, errMsg) {
  const s = String(text || '');
  if (!s) return false;
  if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(s).then(
      () => toast(okMsg || 'Скопировано'),
      () => fallbackCopyText(s, okMsg || 'Скопировано', errMsg || 'Не удалось скопировать')
    );
    return true;
  }
  fallbackCopyText(s, okMsg || 'Скопировано', errMsg || 'Не удалось скопировать');
  return true;
}

function _formatLineForCopy(rawLine, showTimestamps) {
  // Copy should match what's shown in the viewer: no ANSI sequences / control garbage.
  const original = _stripAnsiForRender(_stripLineEnding(rawLine));
  const wantTs = !!showTimestamps;
  if (wantTs) return original;
  const ts = _extractTimestampPrefix(original);
  return ts && ts.ts ? (ts.rest || '') : original;
}

function copySelectedLogText() {
  const view = byId('dt-log-view');
  if (!view) return;
  let text = '';
  try {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount <= 0 || sel.isCollapsed) {
      toast('Сначала выделите текст в окне логов');
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range && range.commonAncestorContainer ? range.commonAncestorContainer : null;
    if (node && !view.contains(node)) {
      toast('Выделение вне окна логов');
      return;
    }
    text = String(sel.toString() || '');
  } catch (e) {
    text = '';
  }
  if (!text || !String(text).trim()) {
    toast('Ничего не выделено');
    return;
  }
  _copyToClipboard(text, 'Скопировано выделенное');
}

function copyAllVisibleLog() {
  const cfg = _getLogFilterConfig();
  const wantTs = !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true);
  const text = (_logFilteredLines || []).map((ch) => _formatLineForCopy(ch, wantTs)).join('\n');
  if (!text) {
    toast('Нечего копировать');
    return;
  }
  _copyToClipboard(text, 'Скопированы все видимые строки');
}

  function downloadCurrentLog() {
    const sel = byId('dt-log-select');
    const name = sel ? String(sel.value || '') : '';
    if (!name) return;
    const url = '/api/devtools/logs/' + encodeURIComponent(name) + '/download';
    try {
      const a = document.createElement('a');
      a.href = url;
      // Hint filename; backend also sets Content-Disposition.
      try { a.download = name + '.log'; } catch (e) {}
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      try { a.remove(); } catch (e) {}
    } catch (e) {
      window.location.href = url;
    }
  }

let _logClearInFlight = false;

function _resetLogBufferAndCursorUi() {
  // Reset buffer/cursor so we never keep stale lines after destructive actions.
  try { _logRawLines = []; } catch (e) { _logRawLines = []; }
  try { _logFilteredLines = []; } catch (e) { _logFilteredLines = []; }
  try { _logFilteredRawIdx = []; } catch (e) { _logFilteredRawIdx = []; }
  _logCursor = null;

  // Reset rendered state: next paint should be a full render.
  _logViewRenderedName = '';
  _logViewRenderedCount = 0;
  _logViewRenderedUnfiltered = true;

  // Clear pause pending too.
  try { _exitPauseAndClearPending(); } catch (e) {}

  const view = byId('dt-log-view');
  if (view) {
    try { view.innerHTML = ''; } catch (e) {}
    try { view.dataset.rawText = ''; view.dataset.visibleText = ''; } catch (e) {}
  }
  const statsEl = byId('dt-log-stats');
  if (statsEl) statsEl.textContent = 'Lines: 0';
}

async function clearLog() {
  const sel = byId('dt-log-select');
  if (!sel) return;
  const name = String(sel.value || '');
  if (!name) return;
  if (_logClearInFlight) return;

  // Confirm: destructive and must never be accidental.
  const ok = await (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function'
    ? XKeen.ui.confirm({
        title: 'Очистить лог?',
        message: `Очистить лог \"${name}\"? Это действие необратимо.`,
        okText: 'Очистить',
        cancelText: 'Отменить',
        danger: true,
      })
    : Promise.resolve(window.confirm(`Очистить лог "${name}"?`)));

  if (!ok) return;

  const autoEl = byId('dt-log-live') || byId('dt-log-auto');
  const wasLive = !!(autoEl && autoEl.checked);
  // Stop streaming during truncate/reload to keep cursor consistent.
  try { _logWsStop(true); } catch (e) {}
  stopLogAutoRefresh();

  try {
    _logClearInFlight = true;
    await postJSON('/api/devtools/logs/' + encodeURIComponent(name) + '/truncate', {});
    toast('Лог очищен: ' + name);
    _resetLogBufferAndCursorUi();
    // Force a full reload (cursor is null, buffer empty).
    await loadLogTail(false);
  } catch (e) {
    toast('Не удалось очистить лог: ' + (e && e.message ? e.message : String(e)), true);
  } finally {
    _logClearInFlight = false;
    if (wasLive) startLogAutoRefresh();
  }
}

// ------------------------- Logs: Stage 8 line actions (optional) -------------------------

let _logLineActionsWired = false;
let _logLineMenuEl = null;
let _logLineMenuState = { rawIdx: null };
let _logContextWired = false;

function _ensureLogLineMenu() {
  if (_logLineMenuEl && _logLineMenuEl.isConnected) return _logLineMenuEl;
  const el = document.createElement('div');
  el.id = 'dt-log-line-menu';
  el.className = 'dt-log-line-menu hidden';
  el.innerHTML =
    '<button type="button" data-act="copy" class="btn-secondary">Copy line</button>' +
    '<button type="button" data-act="context" class="btn-secondary">Show context ±20</button>';
  document.body.appendChild(el);
  _logLineMenuEl = el;

  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
    const act = btn && btn.dataset ? String(btn.dataset.act || '') : '';
    const rawIdx = (typeof _logLineMenuState.rawIdx === 'number') ? _logLineMenuState.rawIdx : null;
    _hideLogLineMenu();
    if (rawIdx === null) return;
    if (act === 'copy') {
      _copyLogLine(rawIdx);
    } else if (act === 'context') {
      _openLogContextModal(rawIdx);
    }
  });

  return el;
}

function _hideLogLineMenu() {
  const el = _logLineMenuEl;
  if (!el) return;
  try { el.classList.add('hidden'); } catch (e) {}
  try { el.style.left = '-9999px'; el.style.top = '-9999px'; } catch (e) {}
  _logLineMenuState.rawIdx = null;
}

function _showLogLineMenu(clientX, clientY, rawIdx) {
  const el = _ensureLogLineMenu();
  _logLineMenuState.rawIdx = rawIdx;

  // Position near click, keep inside viewport.
  const pad = 10;
  const vw = Math.max(0, window.innerWidth || 0);
  const vh = Math.max(0, window.innerHeight || 0);
  let x = Number(clientX || 0);
  let y = Number(clientY || 0);
  try {
    el.classList.remove('hidden');
    // Measure
    const rect = el.getBoundingClientRect();
    if (x + rect.width + pad > vw) x = Math.max(pad, vw - rect.width - pad);
    if (y + rect.height + pad > vh) y = Math.max(pad, vh - rect.height - pad);
    el.style.left = String(Math.max(pad, x)) + 'px';
    el.style.top = String(Math.max(pad, y)) + 'px';
  } catch (e) {
    // If positioning failed, just hide.
    _hideLogLineMenu();
  }
}

function _getRawIdxFromLineEl(lineEl) {
  if (!lineEl) return null;
  try {
    const v = parseInt(String(lineEl.dataset && lineEl.dataset.rawIdx ? lineEl.dataset.rawIdx : ''), 10);
    if (!isNaN(v) && isFinite(v)) return v;
  } catch (e) {}
  // Fallback: find index in the current view (O(n), but only used if dataset is missing).
  try {
    const view = byId('dt-log-view');
    if (!view) return null;
    const kids = view.children;
    if (!kids || typeof kids.length === 'undefined') return null;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === lineEl) return i;
    }
  } catch (e) {}
  return null;
}

function _copyLogLine(rawIdx) {
  const cfg = _getLogFilterConfig();
  const wantTs = !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true);
  const src = Array.isArray(_logRawLines) ? _logRawLines : [];
  if (typeof rawIdx !== 'number' || rawIdx < 0 || rawIdx >= src.length) {
    toast('Строка вне диапазона', true);
    return;
  }
  const text = _formatLineForCopy(src[rawIdx], wantTs);
  if (!text) {
    toast('Нечего копировать');
    return;
  }
  _copyToClipboard(text, 'Скопирована строка');
}

function _wireLogContextModal() {
  if (_logContextWired) return;
  _logContextWired = true;

  const modal = byId('dt-log-context-modal');
  const closeBtn = byId('dt-log-context-close-btn');
  const okBtn = byId('dt-log-context-ok-btn');
  const copyBtn = byId('dt-log-context-copy-btn');
  if (!modal) return;

  function close() {
    try { modal.classList.add('hidden'); } catch (e) {}
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
    } else {
      try { document.body.classList.remove('modal-open'); } catch (e) {}
    }
  }

  if (closeBtn) closeBtn.addEventListener('click', (e) => { e.preventDefault(); close(); });
  if (okBtn) okBtn.addEventListener('click', (e) => { e.preventDefault(); close(); });
  if (copyBtn) copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const body = byId('dt-log-context-body');
    const src = Array.isArray(_logRawLines) ? _logRawLines : [];
    if (!body || !body.dataset) {
      toast('Ошибка копирования', true);
      return;
    }
    let start = 0;
    let end = -1;
    try { start = parseInt(String(body.dataset.ctxStart || '0'), 10) || 0; } catch (e2) { start = 0; }
    try { end = parseInt(String(body.dataset.ctxEnd || '-1'), 10); } catch (e2) { end = -1; }
    if (end < start || start < 0 || end >= src.length) {
      toast('Нечего копировать');
      return;
    }

    const cfg = _getLogFilterConfig();
    const wantTs = !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true);
    const text = src.slice(start, end + 1).map((ch) => _formatLineForCopy(ch, wantTs)).join('\n');
    if (!text || !text.trim()) {
      toast('Нечего копировать');
      return;
    }
    _copyToClipboard(text, 'Скопирован контекст');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e && (e.key === 'Escape' || e.key === 'Esc')) {
      try {
        const isOpen = !modal.classList.contains('hidden');
        if (isOpen) close();
      } catch (e2) {}
    }
  });
}

function _openLogContextModal(rawIdx) {
  _wireLogContextModal();
  const modal = byId('dt-log-context-modal');
  const titleEl = byId('dt-log-context-title');
  const subEl = byId('dt-log-context-subtitle');
  const bodyEl = byId('dt-log-context-body');
  if (!modal || !bodyEl) return;

  const src = Array.isArray(_logRawLines) ? _logRawLines : [];
  if (typeof rawIdx !== 'number' || rawIdx < 0 || rawIdx >= src.length) {
    toast('Строка вне диапазона', true);
    return;
  }

  const cfg = _getLogFilterConfig();
  const wantTs = !!(cfg && typeof cfg.showTimestamps !== 'undefined' ? cfg.showTimestamps : true);
  const ctx = 20;
  const start = Math.max(0, rawIdx - ctx);
  const end = Math.min(src.length - 1, rawIdx + ctx);

  const sel = byId('dt-log-select');
  const name = sel ? String(sel.value || '') : '';

  if (titleEl) titleEl.textContent = 'Context ±20';
  if (subEl) {
    subEl.textContent = (name ? (name + ' · ') : '') + `buffer lines ${start + 1}-${end + 1} of ${src.length}`;
  }

  try { bodyEl.innerHTML = ''; } catch (e) {}
  try {
    if (bodyEl && bodyEl.dataset) {
      bodyEl.dataset.ctxStart = String(start);
      bodyEl.dataset.ctxEnd = String(end);
      bodyEl.dataset.ctxCenter = String(rawIdx);
    }
  } catch (e) {}
  try {
    for (let i = start; i <= end; i++) {
      const span = _makeLogLineSpan(src[i], wantTs);
      if (span && span.classList) {
        if (i === rawIdx) span.classList.add('dt-log-context-focus');
      }
      bodyEl.appendChild(span);
    }
  } catch (e) {
    try { bodyEl.textContent = String(src.slice(start, end + 1).join('')); } catch (e2) {}
  }

  try { modal.classList.remove('hidden'); } catch (e) {}
  if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
    try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
  } else {
    try { document.body.classList.add('modal-open'); } catch (e) {}
  }
}

function _wireLogLineActions() {
  if (_logLineActionsWired) return;
  _logLineActionsWired = true;
  const view = byId('dt-log-view');
  if (!view) return;

  _ensureLogLineMenu();

  // Hide on outside click / scroll.
  document.addEventListener('click', () => _hideLogLineMenu());
  view.addEventListener('scroll', () => _hideLogLineMenu());
  window.addEventListener('resize', () => _hideLogLineMenu());
  document.addEventListener('keydown', (e) => {
    if (e && (e.key === 'Escape' || e.key === 'Esc')) _hideLogLineMenu();
  });

  view.addEventListener('click', (e) => {
    // Don't fight text selection.
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && String(sel.toString() || '').trim()) return;
    } catch (e2) {}

    const t = e && e.target && e.target.closest ? e.target.closest('.log-line') : null;
    if (!t || !view.contains(t)) return;
    // Ignore clicks on links inside logs (just in case).
    if (e && e.target && e.target.closest && e.target.closest('a')) return;

    const rawIdx = _getRawIdxFromLineEl(t);
    if (rawIdx === null) return;
    // Avoid opening the menu on right-click; native context menu is fine.
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _showLogLineMenu(e.clientX, e.clientY, rawIdx);
  });
}


  function init() {
    // Capabilities: detect WS support on backend (optional)
    try {
      getJSON('/api/capabilities').then((cap) => {
        try { _capWebsocket = (cap && typeof cap.websocket !== 'undefined') ? !!cap.websocket : null; } catch (e) { _capWebsocket = null; }
      }).catch(() => {});
    } catch (e) {}

    // Tabs
    const tabTools = byId('dt-tab-btn-tools');
    const tabLogs = byId('dt-tab-btn-logs');
    if (tabTools) tabTools.addEventListener('click', () => setActiveTab('tools'));
    if (tabLogs) tabLogs.addEventListener('click', () => setActiveTab('logs'));

    // Logs
    const logSel = byId('dt-log-select');
    const logRef = byId('dt-log-refresh');
    const logClear = byId('dt-log-clear');
    const logCopySelected = byId('dt-log-copy-selected');
    const logCopy = byId('dt-log-copy');
    const logDl = byId('dt-log-download');
    if (logSel) logSel.addEventListener('change', () => _manualReloadLogAndResumeLive());
    if (logRef) logRef.addEventListener('click', () => _manualReloadLogAndResumeLive());
    if (logClear) logClear.addEventListener('click', clearLog);
    if (logCopySelected) logCopySelected.addEventListener('click', copySelectedLogText);
    if (logCopy) logCopy.addEventListener('click', copyAllVisibleLog);
    if (logDl) logDl.addEventListener('click', downloadCurrentLog);

    // Logs: Stage 8 line actions (copy line / context)
    try { _wireLogLineActions(); } catch (e) {}

    // Logs: sidebar
    const logListRefresh = byId('dt-log-list-refresh');
    if (logListRefresh) logListRefresh.addEventListener('click', () => loadLogList(false));

    // Logs: Stage 4 "human" filters + auto refresh
    const searchEl = byId('dt-log-search');
    const excludeEl = byId('dt-log-exclude');
    const regexEl = byId('dt-log-regex');
    const tsEl = byId('dt-log-show-ts');
    const filterClear = byId('dt-log-filter-clear');
    const liveEl = byId('dt-log-live');
    const autoEl = liveEl || byId('dt-log-auto');
    const legacyAutoEl = byId('dt-log-auto');
    const pauseBtn = byId('dt-log-pause');
    const badgeBtn = byId('dt-log-pending-badge');
    const loadMoreBtn = byId('dt-log-load-more');
    const intervalEl = byId('dt-log-interval');
    const followEl = byId('dt-log-follow');

    // Logs: compact "⋯" menu behaviour (short panel)
    const moreMenu = byId('dt-log-more');
    if (moreMenu && String(moreMenu.tagName || '').toUpperCase() === 'DETAILS') {
      // Close after clicking any action button inside the dropdown.
      moreMenu.addEventListener('click', (ev) => {
        const panel = ev && ev.target && ev.target.closest ? ev.target.closest('.dt-log-menu-panel') : null;
        if (!panel) return;
        const btn = ev && ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (!btn) return;
        try {
          window.setTimeout(() => {
            try { moreMenu.open = false; } catch (e) { try { moreMenu.removeAttribute('open'); } catch (e2) {} }
          }, 0);
        } catch (e) {
          try { moreMenu.open = false; } catch (e2) {}
        }
      });

      // Close on outside click.
      document.addEventListener('click', (ev) => {
        try {
          if (moreMenu.open && ev && ev.target && !moreMenu.contains(ev.target)) moreMenu.open = false;
        } catch (e) {}
      }, true);
    }

    // Sync persisted state -> controls
    _syncLogUiToControls();
    // Validate persisted regex (show inline error if needed)
    try { _compileSearchRegex(_getLogFilterConfig()); } catch (e) {}


    // Stage 5: token fields (Enter adds a chip, × removes).
    const includeField = byId('dt-log-include-field');
    const excludeField = byId('dt-log-exclude-field');

    function _onTokenEnter(kind, el) {
      const raw = String(el && typeof el.value !== 'undefined' ? (el.value || '') : '').trim();
      if (!raw) return false;
      const ok = _addTokens(kind, raw);
      try { if (el) el.value = ''; } catch (e) {}
      if (ok) applyLogFilterToView();
      return ok;
    }

    const simpleFilterMode = !byId('dt-log-include-field');

    if (searchEl) {
      if (simpleFilterMode) {
    const applySimpleFilter = () => {
      const raw = String(searchEl.value || '').trim().toLowerCase();
      const terms = raw ? raw.split(/\s+/).map((s) => s.trim()).filter(Boolean) : [];
      // AND across terms (same behaviour as Xray live logs filter)
      _logUi.includeTokens = terms;
      _syncLegacySearchExcludeStrings();
      applyLogFilterToView();
    };

    searchEl.addEventListener('input', () => applySimpleFilter());
    searchEl.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          try { searchEl.blur(); } catch (e) {}
        }
      },
      { passive: false }
    );

    // Apply once on init (when switching tabs the view may already have lines).
    try { applySimpleFilter(); } catch (e) {}
      } else {
    // Legacy chips mode (Include tokens)
    searchEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        _onTokenEnter('include', searchEl);
      } else if (ev.key === 'Backspace') {
        const v = String(searchEl.value || '');
        if (!v && Array.isArray(_logUi.includeTokens) && _logUi.includeTokens.length) {
          const last = _logUi.includeTokens[_logUi.includeTokens.length - 1];
          _removeToken('include', last);
          applyLogFilterToView();
        }
      }
    });
      }
    }
    if (excludeEl) {
      excludeEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          _onTokenEnter('exclude', excludeEl);
        } else if (ev.key === 'Backspace') {
          const v = String(excludeEl.value || '');
          if (!v && Array.isArray(_logUi.excludeTokens) && _logUi.excludeTokens.length) {
            const last = _logUi.excludeTokens[_logUi.excludeTokens.length - 1];
            _removeToken('exclude', last);
            applyLogFilterToView();
          }
        }
      });
    }
    if (includeField) {
      includeField.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button.dt-token-x') : null;
        if (btn) {
          _removeToken('include', btn.dataset && btn.dataset.token ? btn.dataset.token : '');
          applyLogFilterToView();
          return;
        }
        try { if (searchEl) searchEl.focus(); } catch (e) {}
      });
    }
    if (excludeField) {
      excludeField.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button.dt-token-x') : null;
        if (btn) {
          _removeToken('exclude', btn.dataset && btn.dataset.token ? btn.dataset.token : '');
          applyLogFilterToView();
          return;
        }
        try { if (excludeEl) excludeEl.focus(); } catch (e) {}
      });
    }
    if (regexEl) {
      regexEl.addEventListener('change', () => {
        _logUi.regexEnabled = !!regexEl.checked;
        applyLogFilterToView();
        try { if (searchEl) searchEl.focus(); } catch (e) {}
      });
    }
    if (tsEl) {
      tsEl.addEventListener('change', () => {
        _logUi.showTimestamps = !!tsEl.checked;
        applyLogFilterToView();
        try { if (searchEl) searchEl.focus(); } catch (e) {}
      });
    }

    // Stage 6: Level filter (min-level)
    const levelEl = byId('dt-log-level');
    if (levelEl) {
      levelEl.addEventListener('change', () => {
        const v = String(levelEl.value || 'debug');
        _logUi.minLevel = v;
        // Sync profile chips for convenience.
        if (v === 'error') _logUi.profile = 'errors';
        else if (v === 'warning') _logUi.profile = 'warnings';
        else if (v === 'info') _logUi.profile = 'info';
        else _logUi.profile = 'all';
        try { _setLogProfile(_logUi.profile); } catch (e) {}
        applyLogFilterToView();
        try { if (searchEl) searchEl.focus(); } catch (e) {}
      });
    }

    // Profile buttons
    try {
      const profileBtns = document.querySelectorAll('.dt-log-profile-btn');
      for (const b of (profileBtns || [])) {
        b.addEventListener('click', () => {
          const p = String(b.dataset && b.dataset.profile ? b.dataset.profile : 'all');
          _setLogProfile(p);
          applyLogFilterToView();
        });
      }
    } catch (e) {}

    // Preset chips
    try {
      const presetBtns = document.querySelectorAll('.dt-chip-btn');
      for (const b of (presetBtns || [])) {
        b.addEventListener('click', () => {
          const k = String(b.dataset && b.dataset.preset ? b.dataset.preset : '').toLowerCase();
          if (!k) return;
          const isActive = !!b.classList.contains('active');
          _setPresetActive(k, !isActive);
          applyLogFilterToView();
        });
      }
    } catch (e) {}
    if (followEl) followEl.addEventListener('change', () => {
      try { _tail.isFollow = !!followEl.checked; } catch (e) {}
      _updateTailControlsUi();
      if (!_tail.isPaused && followEl.checked) {
        const view = byId('dt-log-view');
        if (view) {
          try { view.scrollTop = view.scrollHeight; } catch (e) {}
        }
      }
    });
    if (filterClear) {
      filterClear.addEventListener('click', () => {
        try { if (searchEl) searchEl.value = ''; } catch (e) {}
        try { if (excludeEl) excludeEl.value = ''; } catch (e) {}
        try { if (regexEl) regexEl.checked = false; } catch (e) {}
        try { if (tsEl) tsEl.checked = true; } catch (e) {}
        // Stage 5: clear token lists
        try { _logUi.includeTokens = []; } catch (e) { _logUi.includeTokens = []; }
        try { _logUi.excludeTokens = []; } catch (e) { _logUi.excludeTokens = []; }
        _syncLegacySearchExcludeStrings();
        try { _renderTokenField('include'); } catch (e) {}
        try { _renderTokenField('exclude'); } catch (e) {}
        _logUi.regexEnabled = false;
        _logUi.showTimestamps = true;
        try { _setRegexErrorUi(''); } catch (e) {}
        // Stage 6: clear level
        _logUi.minLevel = 'debug';
        try { const levelEl = byId('dt-log-level'); if (levelEl) levelEl.value = 'debug'; } catch (e) {}
        _setLogProfile('all');
        try {
          for (const k of LOG_PRESET_KEYS) _setPresetActive(k, false);
        } catch (e) {}
        applyLogFilterToView();
        try { if (searchEl) searchEl.focus(); } catch (e) {}
      });
    }
    // Live toggle (new) + legacy Auto (hidden): default OFF + persist in localStorage
    // Goal: if user never touched the toggle, Live is OFF by default.
    // If user changes it, remember across reloads.
    const LIVE_LS_KEY = 'xkeen.devtools.logs.live';
    const LIVE_TOUCHED_KEY = 'xkeen.devtools.logs.live.touched';
    let wantLive = false;
    let stored = null;
    let touched = null;
    try { stored = localStorage.getItem(LIVE_LS_KEY); } catch (e) { stored = null; }
    try { touched = localStorage.getItem(LIVE_TOUCHED_KEY); } catch (e) { touched = null; }

    const touchedYes = (() => {
      try {
        const t = String(touched || '').trim().toLowerCase();
        return (t === '1' || t === 'true' || t === 'yes' || t === 'on');
      } catch (e) { return false; }
    })();

    if (!touchedYes) {
      // Migration/default: previous versions auto-saved "Live=ON" even if user never touched the toggle.
      // Treat "not touched" as "use default OFF" and make storage deterministic.
      wantLive = false;
      try { localStorage.setItem(LIVE_LS_KEY, '0'); } catch (e) {}
    } else if (stored !== null && typeof stored !== 'undefined') {
      const s = String(stored).trim().toLowerCase();
      wantLive = (s === '1' || s === 'true' || s === 'yes' || s === 'on');
    } else {
      // Preference says "touched", but value is missing: fall back to current DOM state.
      try {
        if (liveEl) wantLive = !!liveEl.checked;
        else if (legacyAutoEl) wantLive = !!legacyAutoEl.checked;
      } catch (e) {}
      try { localStorage.setItem(LIVE_LS_KEY, wantLive ? '1' : '0'); } catch (e) {}
    }

    // Keep new/legacy checkboxes in sync.
    try { if (liveEl) liveEl.checked = wantLive; } catch (e) {}
    try { if (legacyAutoEl) legacyAutoEl.checked = wantLive; } catch (e) {}
    try { if (autoEl && autoEl !== liveEl && autoEl !== legacyAutoEl) autoEl.checked = wantLive; } catch (e) {}
    try { _tail.isLive = wantLive; } catch (e) {}
    if (liveEl) {
      liveEl.addEventListener('change', () => {
        try { _tail.isLive = !!liveEl.checked; } catch (e) {}
        try { if (legacyAutoEl && legacyAutoEl !== liveEl) legacyAutoEl.checked = !!liveEl.checked; } catch (e) {}
        try { localStorage.setItem(LIVE_LS_KEY, liveEl.checked ? '1' : '0'); } catch (e) {}
        try { localStorage.setItem(LIVE_TOUCHED_KEY, '1'); } catch (e) {}
        // Turning Live off while paused: Pause becomes meaningless → exit + clear pending.
        try { if (!liveEl.checked && _tail && _tail.isPaused) _exitPauseAndClearPending(); } catch (e) {}
        _updateTailControlsUi();
        startLogAutoRefresh();
      });
    }
    if (legacyAutoEl && legacyAutoEl !== liveEl) {
      legacyAutoEl.addEventListener('change', () => {
        try { if (liveEl) liveEl.checked = !!legacyAutoEl.checked; } catch (e) {}
        try { _tail.isLive = !!legacyAutoEl.checked; } catch (e) {}
        try { localStorage.setItem(LIVE_LS_KEY, legacyAutoEl.checked ? '1' : '0'); } catch (e) {}
        try { localStorage.setItem(LIVE_TOUCHED_KEY, '1'); } catch (e) {}
        _updateTailControlsUi();
        startLogAutoRefresh();
      });
    }
    if (autoEl && autoEl !== liveEl && autoEl !== legacyAutoEl) {
      autoEl.addEventListener('change', () => {
        try { _tail.isLive = !!autoEl.checked; } catch (e) {}
        try { localStorage.setItem(LIVE_LS_KEY, autoEl.checked ? '1' : '0'); } catch (e) {}
        try { localStorage.setItem(LIVE_TOUCHED_KEY, '1'); } catch (e) {}
        _updateTailControlsUi();
        startLogAutoRefresh();
      });
    }

    if (intervalEl) intervalEl.addEventListener('change', startLogAutoRefresh);

    // Stage 3: Pause/Resume + pending badge + Load more
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        if (_tail.isPaused) {
          _resumeFromPause();
        } else {
          _enterPauseForCurrentLog();
        }
      });
    }
    if (badgeBtn) {
      badgeBtn.addEventListener('click', () => {
        if (_tail.isPaused) _resumeFromPause();
      });
    }
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        const linesEl = byId('dt-log-lines');
        const followEl = byId('dt-log-follow');

        // Load more is a "browse older lines" action → disable Follow to avoid jumping to the end.
        try {
          if (followEl && followEl.checked) {
            followEl.checked = false;
            _tail.isFollow = false;
            _updateTailControlsUi();
          }
        } catch (e) {}

        // If user loads more while paused, treat it as a manual view action (unpause + drop pending).
        try {
          if (_tail && _tail.isPaused) _exitPauseAndClearPending();
        } catch (e) {}

        const cur = _getLogLinesWindowSize();
        const step = 200;
        const maxLines = Math.min(5000, _getBufferLimitLines());
        const next = Math.min(maxLines, cur + step);

        if (!linesEl) {
          toast('Load more: lines input not found', true);
          return;
        }
        if (next <= cur) {
          toast('Load more: already at max window');
          return;
        }

        try { linesEl.value = String(next); } catch (e) {}
        loadLogTail(false, { preserveScroll: true });
      });
    }

    // Ensure tab state is consistent with the initial HTML
    try { _updateTailControlsUi(); } catch (e) {}

    // Preload list/tail so the Logs tab opens instantly.
    try { loadLogList().then(() => loadLogTail()); } catch (e) {}

    // Default tab
    try { setActiveTab('tools'); } catch (e) {}

    // If section whitelist hid one of the tabs, switch to the first visible one.
    try {
      const bTools = byId('dt-tab-btn-tools');
      const bLogs = byId('dt-tab-btn-logs');
      const toolsHidden = !!(bTools && (bTools.style.display === 'none' || (bTools.dataset && bTools.dataset.xkForceHidden === '1')));
      const logsHidden = !!(bLogs && (bLogs.style.display === 'none' || (bLogs.dataset && bLogs.dataset.xkForceHidden === '1')));
      if (toolsHidden && !logsHidden) setActiveTab('logs');
      else if (logsHidden && !toolsHidden) setActiveTab('tools');
    } catch (e) {}
  }

  XK.features.devtoolsLogs = {
    init,
    setActiveTab,
    loadLogList,
    loadLogTail,
  };
})();
