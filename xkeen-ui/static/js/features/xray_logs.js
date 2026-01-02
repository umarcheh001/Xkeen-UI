(() => {
  // Xray live logs: subscribe/poll, filters, start/stop, UI rendering.
  //
  // Public API:
  //   XKeen.features.xrayLogs.init()
  //   XKeen.features.xrayLogs.start() / stop()
  //   XKeen.features.xrayLogs.viewOnce()
  //   XKeen.features.xrayLogs.changeFile(file)
  //   XKeen.features.xrayLogs.refreshStatus()
  //
  // Backwards-compat (used by inline HTML onclick/onchange + main.js):
  //   window.startXrayLogAuto / stopXrayLogAuto / refreshXrayLogStatus / setXrayLogLampState
  //   window.fetchXrayLogsOnce / applyXrayLogFilterToOutput / xrayLogsView / xrayLogsEnable / ...

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.ui = XKeen.ui || {};
  XKeen.util = XKeen.util || {};

  const DEFAULT_MAX_LINES = 800;
  const DEFAULT_POLL_MS = 2000;
  const LOAD_MORE_STEP = 400;
  const MAX_MAX_LINES = 5000;

  // Persist per-page UI state (file/interval/follow/live/lines/filter + log window height)
  // so the user doesn't have to reconfigure the Live logs view every time.
  const STORAGE_KEY = 'xkeen.ui.xrayLogs.v1';

  let _maxLines = DEFAULT_MAX_LINES;
  let _pollMs = DEFAULT_POLL_MS;
  let _follow = true;

  // HTTP incremental tail cursor (DevTools-like)
  let _cursor = '';

  // UI pause: freeze rendering while keeping buffer updated
  let _paused = false;
  let _pendingCount = 0;

  let _inited = false;

  let _timer = null;
  let _statusTimer = null;
  let _currentFile = 'access';
  let _lastLines = [];

  let _ws = null;
  let _useWs = true;
  let _wsEverOpened = false;
  let _wsClosingManually = false;
  let _streaming = false; // live stream (auto-update) state

  const ALLOWED_LOGLEVELS = ['warning', 'info', 'debug', 'error'];

  let _activeLogLevel = 'none'; // last known active loglevel from /api/xray-logs/status
  let _applyLevelTimer = null;

  let _saveTimer = null;
  let _resizeObserver = null;

  function $(id) {
    return document.getElementById(id);
  }

  function readStoredUiState() {
    try {
      if (!window.localStorage) return {};
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function writeStoredUiState(next) {
    try {
      if (!window.localStorage) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next || {}));
    } catch (e) {}
  }

  function collectUiState() {
    const fileSel = $('xray-log-file');
    const lvlSel = $('xray-log-level');
    const liveEl = $('xray-log-live');
    const intervalEl = $('xray-log-interval');
    const followEl = $('xray-log-follow');
    const linesInput = $('xray-log-lines');
    const filterEl = $('xray-log-filter');
    const outputEl = $('xray-log-output');

    let height = null;
    try {
      if (outputEl) height = Math.round(outputEl.getBoundingClientRect().height);
    } catch (e) {}

    let maxLines = _maxLines;
    try {
      const v = parseInt((linesInput && linesInput.value) || '', 10);
      if (isFinite(v)) maxLines = v;
    } catch (e) {}

    let pollMs = _pollMs;
    try {
      const v = parseInt((intervalEl && intervalEl.value) || '', 10);
      if (isFinite(v)) pollMs = v;
    } catch (e) {}

    return {
      file: String((fileSel && fileSel.value) || _currentFile || 'access'),
      loglevel: String((lvlSel && lvlSel.value) || ''),
      live: !!(liveEl && liveEl.checked),
      follow: !!(followEl && followEl.checked),
      pollMs: pollMs,
      maxLines: maxLines,
      filter: String((filterEl && filterEl.value) || ''),
      height: height,
      ts: Date.now(),
    };
  }

  function scheduleSaveUiState() {
    try {
      if (_saveTimer) clearTimeout(_saveTimer);
    } catch (e) {}

    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      const prev = readStoredUiState();
      const cur = collectUiState();
      // merge (keep any unknown future fields)
      writeStoredUiState(Object.assign({}, prev || {}, cur || {}));
    }, 120);
  }

  function applyStoredUiState() {
    const st = readStoredUiState();
    if (!st || typeof st !== 'object') return;

    // file (default: access)
    const file = String(st.file || '').toLowerCase();
    const fileNorm = (file === 'access' || file === 'access.log') ? 'access' : (file === 'error' || file === 'error.log') ? 'error' : '';
    const fileSel = $('xray-log-file');
    if (fileSel && fileNorm) fileSel.value = fileNorm;
    if (fileNorm) _currentFile = fileNorm;

    // loglevel selector (UI preference)
    const lvlSel = $('xray-log-level');
    const lvl = String(st.loglevel || '').toLowerCase();
    if (lvlSel && ALLOWED_LOGLEVELS.includes(lvl)) lvlSel.value = lvl;

    // live/follow toggles
    const liveEl = $('xray-log-live');
    if (liveEl && typeof st.live === 'boolean') liveEl.checked = !!st.live;

    const followEl = $('xray-log-follow');
    if (followEl && typeof st.follow === 'boolean') followEl.checked = !!st.follow;

    // interval + internal poll
    const intervalEl = $('xray-log-interval');
    try {
      const v = parseInt(st.pollMs, 10);
      if (isFinite(v) && v >= 500) {
        _pollMs = v;
        if (intervalEl) intervalEl.value = String(v);
      }
    } catch (e) {}

    // max lines + internal window
    try {
      let v = parseInt(st.maxLines, 10);
      if (!isFinite(v)) v = DEFAULT_MAX_LINES;
      if (v < 50) v = 50;
      if (v > MAX_MAX_LINES) v = MAX_MAX_LINES;
      _maxLines = v;
      const linesInput = $('xray-log-lines');
      if (linesInput) linesInput.value = String(v);
    } catch (e) {}

    // filter
    const filterEl = $('xray-log-filter');
    if (filterEl && typeof st.filter === 'string') filterEl.value = st.filter;

    // log window height
    const outputEl = $('xray-log-output');
    try {
      let h = parseInt(st.height, 10);
      if (isFinite(h)) {
        // Keep consistent with CSS min-height.
        if (h < 420) h = 420;
        if (outputEl) outputEl.style.height = String(h) + 'px';
      }
    } catch (e) {}
  }

  function _isErrorFileName(name) {
    const f = String(name || '').toLowerCase();
    return f === 'error' || f === 'error.log';
  }

  function updateLoglevelUiForCurrentFile() {
    const lvlSel = $('xray-log-level');
    if (!lvlSel) return;

    const isError = _isErrorFileName(_currentFile);
    lvlSel.disabled = !isError;
    lvlSel.title = isError ? 'Уровень логирования применим к error.log' : 'Уровни доступны только для error.log';
  }

  function syncCurrentFileFromUi() {
    const selectEl = $('xray-log-file');
    if (selectEl) _currentFile = selectEl.value || _currentFile || 'access';
    updateLoglevelUiForCurrentFile();
  }


  function escapeHtml(str) {
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.escapeHtml === 'function') {
        return XKeen.util.escapeHtml(str);
      }
    } catch (e) {}
    try {
      if (typeof window.escapeHtml === 'function') return window.escapeHtml(str);
    } catch (e) {}
    // ultra-fallback
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Normalize log lines coming from backend (tail/WS) so that:
  // - trailing \r/\n don't create extra blank lines in <pre>
  // - terminal control sequences don't show as "мусор" (\x1b[H, \x1b[J, etc.)
  function normalizeLogLine(input) {
    if (input == null) return '';
    let s = String(input);
    // common file reading artifact: \n at the end of each line
    s = s.replace(/\r/g, '').replace(/\n$/, '');
    // OSC: ESC ] ... BEL or ST
    s = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\\\)/g, '');
    // CSI: ESC [ ... <final>. Keep only SGR (*m)
    s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (m) => (m.endsWith('m') ? m : ''));
    // Other stray ESC
    s = s.replace(/\x1b(?!\[)/g, '');
    // Remaining C0 controls (except \t)
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return s;
  }

  // Base64 helpers (avoid putting raw IP/hosts into HTML attributes)
  function b64Encode(str) {
    try {
      // Most log tokens are ASCII (ip/domain/port)
      return window.btoa(String(str || ''));
    } catch (e) {
      try {
        return window.btoa(unescape(encodeURIComponent(String(str || ''))));
      } catch (e2) {}
    }
    return '';
  }

  function b64Decode(b64) {
    try {
      return window.atob(String(b64 || ''));
    } catch (e) {
      try {
        return decodeURIComponent(escape(window.atob(String(b64 || ''))));
      } catch (e2) {}
    }
    return '';
  }

  function fallbackCopyText(text, okMsg) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast(okMsg || 'Логи Xray скопированы в буфер обмена', false);
    } catch (e) {
      toast('Не удалось скопировать логи', true);
    }
  }

  function wsDebug(msg, extra) {
    // Optional server-side debug hook. Ignore all errors.
    try {
      fetch('/api/ws-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: msg, extra: extra || {} }),
        keepalive: true,
      });
    } catch (e) {}
  }

  function isLogsViewVisible() {
    const viewEl = $('view-xray-logs');
    return !!(viewEl && viewEl.style.display !== 'none');
  }

  // ---------- UI: header badge (global loglevel reminder) ----------

  function setXrayHeaderBadgeState(state, level) {
    const badge = $('xray-logs-badge');
    if (!badge) return;

    const st = (state === 'on') ? 'on' : 'off';
    badge.dataset.state = st;

    const lvl = level ? String(level) : '';
    if (st === 'on') {
      badge.title = lvl ? `Логи Xray включены (loglevel=${lvl}).` : 'Логи Xray включены.';
    } else {
      badge.title = 'Логи Xray выключены.';
    }
  }

  // ---------- UI: lamp + rendering ----------

  function setXrayLogLampState(state) {
    const lamp = $('xray-log-lamp');
    if (!lamp) return;

    lamp.dataset.state = String(state || '');

    if (state === 'on') {
      lamp.title = 'Автообновление логов включено';
    } else if (state === 'off') {
      lamp.title = 'Автообновление логов выключено';
    } else if (state === 'error') {
      lamp.title = 'Ошибка автообновления логов';
    } else {
      lamp.title = 'Автообновление логов: неизвестно';
    }
  }


  function updateXrayLogStats() {
  const el = $('xray-log-stats');
  if (!el) return;

  const lines = Array.isArray(_lastLines) ? _lastLines.length : 0;
  const max = _maxLines || DEFAULT_MAX_LINES;

  let transport = '';
  try {
    if (_ws && typeof WebSocket !== 'undefined') {
      if (_ws.readyState === WebSocket.OPEN) transport = 'WS';
      else if (_ws.readyState === WebSocket.CONNECTING) transport = 'WS…';
    }
  } catch (e) {}

  // When streaming without WS, we're polling over HTTP.
  if (!transport && _streaming) transport = 'HTTP';

  const parts = [];
  parts.push(lines + '/' + max);
  if (transport) parts.push(transport);

  if (_paused) {
    const n = Math.max(0, parseInt(_pendingCount || 0, 10) || 0);
    parts.push(n ? ('PAUSED +' + n) : 'PAUSED');
  }

  el.textContent = parts.join(' • ');
    try { updatePauseButton(); } catch (e) {}
}

  async function refreshXrayLogStatus() {
    try {
      const res = await fetch('/api/xray-logs/status');
      if (!res.ok) throw new Error('status http error');
      const data = await res.json().catch(() => ({}));
      const level = String(data.loglevel || 'none').toLowerCase();
      _activeLogLevel = level;
      const state = level === 'none' ? 'off' : 'on';
      // ВАЖНО: индикатор в карточке Live логов показывает только автообновление,
      // а глобальный статус логирования отображаем в шапке (badge).
      setXrayHeaderBadgeState(state, level);

      // ВАЖНО: не "подкручиваем" селектор loglevel под текущее состояние.
      // Селектор — это *желательный* уровень для действия "▶ Включить логи".
      // Текущий активный уровень показываем в бейдже в шапке (xray-logs-badge).
    } catch (e) {
      console.error('xray log status error', e);
      _activeLogLevel = 'none';
      // Do not show the badge when status is unknown.
      setXrayHeaderBadgeState('off', 'none');
    }
  }

  function getXrayLogLineClass(line) {
    const lower = (line || '').toLowerCase();

    if (
      lower.includes('error') ||
      lower.includes('fail') ||
      lower.includes('failed') ||
      lower.includes('fatal')
    ) {
      return 'log-line log-line-error';
    }

    if (lower.includes('warning') || lower.includes('warn')) {
      return 'log-line log-line-warning';
    }

    if (lower.includes('info')) {
      return 'log-line log-line-info';
    }

    if (lower.includes('debug')) {
      return 'log-line log-line-debug';
    }

    return 'log-line';
  }


  // Detect Xray log level for view-side filtering.
  // We prefer exact markers like [Info]/[Debug]/[Warning]/[Error].
  function detectXrayLogLevel(line) {
    const s = String(line || '');
    let m = s.match(/\[(debug|info|warning|error)\]/i);
    if (m && m[1]) return String(m[1]).toLowerCase();
    m = s.match(/\blevel=(debug|info|warning|error)\b/i);
    if (m && m[1]) return String(m[1]).toLowerCase();
    return '';
  }

  const LOGLEVEL_ORDER = { debug: 0, info: 1, warning: 2, error: 3 };

  function shouldIncludeLineByLevel(line, threshold) {
    const th = String(threshold || '').toLowerCase();
    if (!(th in LOGLEVEL_ORDER)) return true;
    const lvl = detectXrayLogLevel(line);
    if (!lvl || !(lvl in LOGLEVEL_ORDER)) return true; // unknown lines: keep
    return LOGLEVEL_ORDER[lvl] >= LOGLEVEL_ORDER[th];
  }

  function parseXrayLogLine(line, idx) {
    const clean = normalizeLogLine(line);
    if (!clean || !String(clean).trim()) return '';

    const cls = getXrayLogLineClass(clean);
    let processed = escapeHtml(clean);

    // Timestamp highlight (common Xray format: YYYY/MM/DD HH:MM:SS(.ms) or YYYY-MM-DD ...)
    processed = processed.replace(/^(\d{4}[\/-]\d{2}[\/-]\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)/, '<span class="log-ts">$1</span>');

    // Typical Xray levels
    processed = processed
      .replace(/\[Info\]/g, '<span class="log-lvl log-lvl-info">[Info]</span>')
      .replace(/\[Warning\]/g, '<span class="log-lvl log-lvl-warning">[Warning]</span>')
      .replace(/\[Error\]/g, '<span class="log-lvl log-lvl-error">[Error]</span>')
      .replace(/\[Debug\]/g, '<span class="log-lvl log-lvl-debug">[Debug]</span>')
      .replace(/level=(info)/gi, 'level=<span class="log-lvl log-lvl-info">$1</span>')
      .replace(/level=(warning)/gi, 'level=<span class="log-lvl log-lvl-warning">$1</span>')
      .replace(/level=(error)/gi, 'level=<span class="log-lvl log-lvl-error">$1</span>')
      .replace(/level=(debug)/gi, 'level=<span class="log-lvl log-lvl-debug">$1</span>');

    // Route highlights (in brackets)
    processed = processed
      .replace(/\[(?:tproxy)[^\]]*vless-reality[^\]]*\]/gi, '<span class="log-route log-route-tproxy-vless">$&</span>')
      .replace(/\[(?:redirect)[^\]]*vless-reality[^\]]*\]/gi, '<span class="log-route log-route-redirect-vless">$&</span>')
      .replace(/\[(?:redirect)[^\]]*direct[^\]]*\]/gi, '<span class="log-route log-route-redirect-direct">$&</span>')
      .replace(/\[(?:reject)[^\]]*\]/gi, '<span class="log-route log-route-reject">$&</span>')
      .replace(/\breject(ed)?\b/gi, '<span class="log-route log-route-reject">$&</span>');

    const linkTitle = 'Клик: копировать • Shift+клик: добавить в фильтр';

    // Extra token highlights (protocols/ports/tags/uuid/email/sni/alpn/path)
    // NOTE: This is best-effort string processing; we avoid matching inside existing HTML tags
    // by keeping replacements ordered (we inject <a>/<span> before the generic domain/IP matchers).

    // UUID
    processed = processed.replace(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, (m, uuid) => {
      const raw = String(uuid || '').trim();
      const b64 = b64Encode(raw);
      if (!b64) return '<span class="log-uuid">' + m + '</span>';
      return '<a href="#" class="log-link log-uuid" data-kind="uuid" data-b64="' + b64 + '" title="' + linkTitle + '">' + m + '</a>';
    });

    // Email (user@domain) — keep whole email as a single clickable token
    processed = processed.replace(/\b([A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g, (m, email) => {
      const raw = String(email || '').trim();
      const b64 = b64Encode(raw);
      if (!b64) return '<span class="log-email">' + m + '</span>';
      return '<a href="#" class="log-link log-email" data-kind="email" data-b64="' + b64 + '" title="' + linkTitle + '">' + m + '</a>';
    });

    // inbound/outbound tags (inbound: xxx | inboundTag=xxx)
    processed = processed.replace(/\b(inbound(?:Tag)?)(\s*[:=]\s*)([A-Za-z0-9_.-]{1,64})/gi, (m, k, sep, tag) => {
      const raw = String(tag || '').trim();
      const b64 = b64Encode(raw);
      const cls = 'log-link log-inbound';
      if (!b64) return String(k || '') + String(sep || '') + '<span class="log-inbound">' + String(tag || '') + '</span>';
      return String(k || '') + String(sep || '') + '<a href="#" class="' + cls + '" data-kind="inbound" data-b64="' + b64 + '" title="' + linkTitle + '">' + String(tag || '') + '</a>';
    });
    processed = processed.replace(/\b(outbound(?:Tag)?)(\s*[:=]\s*)([A-Za-z0-9_.-]{1,64})/gi, (m, k, sep, tag) => {
      const raw = String(tag || '').trim();
      const b64 = b64Encode(raw);
      const cls = 'log-link log-outbound';
      if (!b64) return String(k || '') + String(sep || '') + '<span class="log-outbound">' + String(tag || '') + '</span>';
      return String(k || '') + String(sep || '') + '<a href="#" class="' + cls + '" data-kind="outbound" data-b64="' + b64 + '" title="' + linkTitle + '">' + String(tag || '') + '</a>';
    });

    // SNI/serverName (domain[:port])
    processed = processed.replace(/\b(sni|serverName|servername)(\s*[:=]\s*)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::(\d{1,5}))?/gi, (m, k, sep, host, port) => {
      const raw = String(host || '') + (port ? (':' + String(port)) : '');
      const b64 = b64Encode(raw);
      const portHtml = port ? (':<span class="log-port">' + String(port) + '</span>') : '';
      const vis = String(host || '') + portHtml;
      if (!b64) return String(k || '') + String(sep || '') + '<span class="log-sni">' + vis + '</span>';
      return String(k || '') + String(sep || '') + '<a href="#" class="log-link log-domain log-sni" data-kind="sni" data-b64="' + b64 + '" title="' + linkTitle + '">' + vis + '</a>';
    });

    // ALPN value
    processed = processed.replace(/\b(alpn)(\s*[:=]\s*)([A-Za-z0-9_./-]{1,32})/gi, (m, k, sep, val) => {
      return String(k || '') + String(sep || '') + '<span class="log-alpn">' + String(val || '') + '</span>';
    });

    // Path / URI / URL (value starts with '/')
    processed = processed.replace(/\b(path|uri|url|requestURI)(\s*[:=]\s*)(\/[\w\-._~%!$&'()*+,;=:@\/?#[\]]{1,2000})/gi, (m, k, sep, pth) => {
      const raw = String(pth || '').trim();
      const b64 = b64Encode(raw);
      if (!b64) return String(k || '') + String(sep || '') + '<span class="log-path">' + String(pth || '') + '</span>';
      return String(k || '') + String(sep || '') + '<a href="#" class="log-link log-path" data-kind="path" data-b64="' + b64 + '" title="' + linkTitle + '">' + String(pth || '') + '</a>';
    });

    // HTTP methods (avoid matching inside injected tags by excluding '>' prefix)
    processed = processed.replace(/(^|[^>])\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|CONNECT|TRACE)\b/g, '$1<span class="log-method">$2</span>');

    // Protocol / transport keywords (avoid matching inside injected tags by excluding '>' prefix)
    processed = processed.replace(/(^|[^>])\b(tcp|udp|ws|grpc|http|https|tls|quic|h2|h3|http\/1\.1|http\/2)\b/gi, '$1<span class="log-proto">$2</span>');

    // IPv4 (+ optional port) -> clickable token
    processed = processed.replace(/\b((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?\b/g, (m, ip, port) => {
      const raw = String(ip || '') + (port ? (':' + String(port)) : '');
      const b64 = b64Encode(raw);
      const vis = String(ip || '') + (port ? (':<span class="log-port">' + String(port) + '</span>') : '');
      if (!b64) return '<span class="log-ip">' + vis + '</span>';
      return '<a href="#" class="log-link log-ip" data-kind="ip" data-b64="' + b64 + '" title="' + linkTitle + '">' + vis + '</a>';
    });

    // Domains (avoid hitting inside already injected tags) -> clickable token
    processed = processed.replace(/(^|[^">@])((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::(\d{1,5}))?/g, (m, pfx, host, port) => {
      const raw = String(host || '') + (port ? (':' + String(port)) : '');
      const b64 = b64Encode(raw);
      const vis = String(host || '') + (port ? (':<span class="log-port">' + String(port) + '</span>') : '');
      if (!b64) return String(pfx || '') + '<span class="log-domain">' + vis + '</span>';
      return String(pfx || '') + '<a href="#" class="log-link log-domain" data-kind="domain" data-b64="' + b64 + '" title="' + linkTitle + '">' + vis + '</a>';
    });

    const dataIdx = (idx === undefined || idx === null) ? '' : (' data-idx="' + String(idx) + '"');
    return '<span class="' + cls + '"' + dataIdx + '>' + processed + '</span>';
  }
  // ---------- View filtering by Xray log level ----------

  const XRAY_LEVEL_ORDER = { debug: 0, info: 1, warning: 2, error: 3 };

  function detectXrayLevel(line) {
    const s = String(line || '');
    // Primary: Xray format uses [Info]/[Warning]/[Error]/[Debug]
    let m = s.match(/\[(debug|info|warning|error)\]/i);
    if (m && m[1]) return String(m[1]).toLowerCase();
    // Secondary: sometimes logs contain level=info etc
    m = s.match(/\blevel=(debug|info|warning|error)\b/i);
    if (m && m[1]) return String(m[1]).toLowerCase();
    return '';
  }

  function shouldKeepLineForLevel(line, threshold) {
    const thr = String(threshold || '').toLowerCase();
    if (!thr || !(thr in XRAY_LEVEL_ORDER)) return true;
    const lvl = detectXrayLevel(line);
    if (!lvl || !(lvl in XRAY_LEVEL_ORDER)) return true; // unknown -> keep
    return XRAY_LEVEL_ORDER[lvl] >= XRAY_LEVEL_ORDER[thr];
  }

  function applyXrayLogFilterToOutput() {
  const outputEl = $('xray-log-output');
  if (!outputEl) return;

  const filterEl = $('xray-log-filter');
  const rawFilter = ((filterEl && filterEl.value) || '').trim().toLowerCase();

  // The loglevel selector also acts as a *view filter* (threshold) so that
  // switching warning/info/error immediately hides lower-level lines, even if
  // they are still present in the file buffer.
  const lvlSel = $('xray-log-level');
  const selectedLevel = String((lvlSel && lvlSel.value) || '').trim().toLowerCase();
  const isErrorFile = _isErrorFileName(_currentFile);
  const levelFilter = (isErrorFile && ALLOWED_LOGLEVELS.includes(selectedLevel)) ? selectedLevel : '';

  const terms = rawFilter
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const src = Array.isArray(_lastLines) ? _lastLines : [];
  let entries = src.map((line, idx) => ({ idx, line: normalizeLogLine(line) }));

  if (levelFilter) {
    entries = entries.filter((e) => shouldKeepLineForLevel(e.line, levelFilter));
  }

  const filtered = terms.length
    ? entries.filter((e) => {
        const lower = String(e.line || '').toLowerCase();
        return terms.every((t) => lower.includes(t));
      })
    : entries;

  const wasAtBottom = outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 5;
  const shouldScroll = _follow ? true : wasAtBottom;

  // Each line is rendered as a block-level <span>. Extra line breaks create empty rows in <pre>.
  outputEl.innerHTML = filtered.map((e) => parseXrayLogLine(e.line, e.idx)).join('');
  if (shouldScroll) outputEl.scrollTop = outputEl.scrollHeight;
  updateXrayLogStats();
}

  // ---------- Data sources: HTTP + WebSocket ----------

  async function fetchXrayLogsOnce(source = 'manual', opts = {}) {
  const outputEl = $('xray-log-output');
  if (!outputEl) return;

  const statusEl = $('xray-log-status');
  const file = _currentFile || 'access';

  const resetCursor = !!(opts && opts.resetCursor);
  const forceRender = !!(opts && opts.forceRender);

  const cur = resetCursor ? '' : (_cursor || '');

  try {
    const params = new URLSearchParams();
    params.set('file', file);
    params.set('max_lines', String(_maxLines || DEFAULT_MAX_LINES));
    params.set('source', String(source || 'manual'));
    if (cur) params.set('cursor', cur);

    const res = await fetch('/api/xray-logs?' + params.toString());
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить логи Xray.';
      return;
    }

    const data = await res.json().catch(() => ({}));
    const mode = String((data && data.mode) || 'full').toLowerCase();
    const lines = Array.isArray(data && data.lines) ? data.lines : [];
    const newCur = String((data && data.cursor) || '');

    if (newCur) _cursor = newCur;

    if (mode === 'append') {
      if (lines.length) {
        for (const ln of lines) _lastLines.push(ln);
        if (_lastLines.length > _maxLines) _lastLines = _lastLines.slice(-_maxLines);

        if (_paused && !forceRender && source === 'poll') {
          _pendingCount += lines.length;
          updateXrayLogStats();
        } else {
          _pendingCount = 0;
          applyXrayLogFilterToOutput();
        }
      } else {
        // still update meta/stats (cursor/transport)
        updateXrayLogStats();
      }
    } else {
      _lastLines = lines;
      if (_lastLines.length > _maxLines) _lastLines = _lastLines.slice(-_maxLines);

      if (_paused && !forceRender && source === 'poll') {
        // keep buffer updated but don't repaint
        _pendingCount = Math.max(0, _pendingCount);
        updateXrayLogStats();
      } else {
        _pendingCount = 0;
        applyXrayLogFilterToOutput();
      }
    }

    if (statusEl) statusEl.textContent = '';
    refreshXrayLogStatus();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка чтения логов Xray.';
  }
}

  function xrayLogConnectWs() {
    // Don't connect if streaming is not enabled.
    if (!_streaming) return;
    if (!_useWs || !('WebSocket' in window)) {
      _useWs = false;
      return;
    }

    // Already open/connecting
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const statusEl = $('xray-log-status');
    const file = _currentFile || 'access';

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = proto + '//' + host + '/ws/xray-logs?file=' + encodeURIComponent(file) + '&max_lines=' + encodeURIComponent(String(_maxLines || DEFAULT_MAX_LINES));

    wsDebug('WS: connecting', { url: url, file: file });

    let ws = null;

    try {
      _wsClosingManually = false;
      _wsEverOpened = false;
      ws = new WebSocket(url);
      _ws = ws;
    } catch (e) {
      console.error('Failed to create WebSocket for logs', e);
      _useWs = false;
      if (statusEl) statusEl.textContent = 'Не удалось создать WebSocket, использую HTTP.';
      return;
    }

    ws.onopen = function () {
      if (ws !== _ws) return;
      wsDebug('WS: open', { file: file });
      _wsEverOpened = true;

      // Disable HTTP polling while WS is active
      if (_timer) {
        try { clearInterval(_timer); } catch (e) {}
        _timer = null;
      }

      if (statusEl) statusEl.textContent = 'WebSocket для логов подключён.';
      try { updateXrayLogStats(); } catch (e) {}
    };
    ws.onmessage = function (event) {
      if (ws !== _ws) return;
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('Invalid WebSocket payload for xray logs', e);
        return;
      }

      let added = 0;

      if (data && data.type === 'init' && Array.isArray(data.lines)) {
        // Initial snapshot (tail window). Treat as a full replace, not "new lines".
        _lastLines = data.lines;
      } else if (data && data.type === 'append' && Array.isArray(data.lines)) {
        // Future-proof: batch append
        for (const ln of data.lines) _lastLines.push(ln);
        added = data.lines.length;
      } else if (data && data.type === 'line' && typeof data.line === 'string') {
        _lastLines.push(data.line);
        added = 1;
      } else if (Array.isArray(data.lines)) {
        // Unknown payload shape: assume full snapshot
        _lastLines = data.lines;
      } else if (data && typeof data.line === 'string') {
        // Unknown payload shape: single line
        _lastLines.push(data.line);
        added = 1;
      }

      if (_lastLines.length > _maxLines) _lastLines = _lastLines.slice(-_maxLines);

      // PAUSE must work in WS mode too: keep buffering but don't repaint.
      if (_paused) {
        if (added) _pendingCount += added;
        updateXrayLogStats();
        return;
      }

      _pendingCount = 0;
      applyXrayLogFilterToOutput();
    };

    ws.onclose = function () {
      if (ws !== _ws) return;
      const visible = isLogsViewVisible();

      wsDebug('WS: close', { file: file, manual: _wsClosingManually, everOpened: _wsEverOpened });

      _ws = null;
      try { updateXrayLogStats(); } catch (e) {}

      // closed by us (tab switch/file change/stop) or view hidden
      if (_wsClosingManually || !visible) {
        if (statusEl) statusEl.textContent = 'WebSocket для логов закрыт.';
        return;
      }

      // never opened -> WS not supported
      if (!_wsEverOpened) {
        _useWs = false;
        if (statusEl) statusEl.textContent = 'WebSocket недоступен, использую HTTP.';
        if (!_timer) {
          fetchXrayLogsOnce('fallback_ws', { resetCursor: true, forceRender: true });
          _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
        }
        return;
      }

      // was working -> reconnect, without enabling HTTP (avoid dupes)
      if (statusEl) statusEl.textContent = 'WebSocket для логов разорван, пытаюсь переподключиться...';

      setTimeout(() => {
        const stillVisible = isLogsViewVisible();
        if (!_ws && _useWs && stillVisible && _streaming) xrayLogConnectWs();
      }, 1000);
    };

    ws.onerror = function () {
      if (ws !== _ws) return;
      wsDebug('WS: error', { file: file });
      console.warn('WebSocket error in xray logs');
      // Do not switch to HTTP here; onclose decides.
    };
  }

  // ---------- Lifecycle (start/stop) ----------

  function startXrayLogAuto() {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    _streaming = true;
    _paused = false;
    _pendingCount = 0;
    try { updatePauseButton(); } catch (e) {}

    // UI: этот индикатор показывает только автообновление (stream), а не loglevel.
    setXrayLogLampState('on');

    // Sync UI toggle
    try {
      const liveEl = $('xray-log-live');
      if (liveEl) liveEl.checked = true;
    } catch (e) {}
    try { updateXrayLogStats(); } catch (e) {}

    // If WS already open/connecting - nothing to do
    if (_useWs && _ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Prefer WS; fallback to HTTP polling.
    if (_useWs && 'WebSocket' in window) {
      if (_timer) {
        try { clearInterval(_timer); } catch (e) {}
        _timer = null;
      }
      xrayLogConnectWs();
      return;
    }

    if (_timer) return;
    fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
    _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
  }

  function stopXrayLogAuto() {
    // UI: автообновление остановлено
    _streaming = false;
    _paused = false;
    _pendingCount = 0;
    try { updatePauseButton(); } catch (e) {}
    setXrayLogLampState('off');

    // IMPORTANT: do NOT force-toggle the "Live" checkbox here.
    // The checkbox is treated as a user preference and is persisted via localStorage.
    try { updateXrayLogStats(); } catch (e) {}
    if (_timer) {
      try { clearInterval(_timer); } catch (e) {}
      _timer = null;
    }

    if (_ws) {
      _wsClosingManually = true;
      try { _ws.close(); } catch (e) {}
      _ws = null;
      try { updateXrayLogStats(); } catch (e) {}
    }
  }

  // ---------- Actions (wired from HTML) ----------

  function xrayLogsView() {
    fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
  }

  function xrayLogsClearScreen() {
    const outputEl = $('xray-log-output');
    if (outputEl) outputEl.innerHTML = '';
    _lastLines = [];
    _cursor = '';
    _pendingCount = 0;
  }

  function xrayLogChangeFile() {
    const selectEl = $('xray-log-file');
    if (selectEl) _currentFile = selectEl.value || 'access';
    updateLoglevelUiForCurrentFile();
    try { scheduleSaveUiState(); } catch (e) {}

    // clear buffer + redraw
    _lastLines = [];
    _cursor = '';
    _pendingCount = 0;
    applyXrayLogFilterToOutput();

    // If streaming is enabled and WS in use, reconnect for the new file (avoid HTTP dupes)
    if (_streaming && _useWs && 'WebSocket' in window) {
      if (_timer) {
        try { clearInterval(_timer); } catch (e) {}
        _timer = null;
      }

      if (_ws) {
        _wsClosingManually = true;
        try { _ws.close(); } catch (e) {}
        _ws = null;
      try { updateXrayLogStats(); } catch (e) {}
      }
      xrayLogConnectWs();
      return;
    }

    fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
  }

  async function xrayLogsEnable() {
    const statusEl = $('xray-log-status');
    try {
      // Pick the desired loglevel from the selector (UI preference).
      const lvlSel = $('xray-log-level');
      const selected = String((lvlSel && lvlSel.value) || 'warning').toLowerCase();
      const loglevel = ALLOWED_LOGLEVELS.includes(selected) ? selected : 'warning';

      // Ensure we use the currently selected file.
      try { syncCurrentFileFromUi(); } catch (e) {}

      const res = await fetch('/api/xray-logs/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loglevel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);

      if (statusEl) {
        statusEl.textContent =
          'Логи включены (loglevel=' + (data.loglevel || 'warning') + '). Xray перезапущен.';
      }

      // Persist current selectors (file/loglevel/...) right away.
      try { scheduleSaveUiState(); } catch (e) {}

      try { await refreshXrayLogStatus(); } catch (e) {}
      setXrayHeaderBadgeState('on', data.loglevel || 'warning');

      // After enabling, the backend may switch from *.saved to live files.
      // Force a fresh snapshot / reconnect so the stream starts immediately
      // (without requiring manual toggling between access/error).
      _cursor = '';
      _pendingCount = 0;

      const liveEl = $('xray-log-live');
      const wantStream = !!(liveEl && liveEl.checked);
      const visible = isLogsViewVisible();

      if (visible) {
        // Always show current file content once.
        fetchXrayLogsOnce('enable', { resetCursor: true, forceRender: true });
      }

      if (visible && wantStream) {
        // Force-restart any active transport (WS/HTTP) so startXrayLogAuto won't early-return.
        if (_timer) {
          try { clearInterval(_timer); } catch (e) {}
          _timer = null;
        }
        if (_ws) {
          _wsClosingManually = true;
          try { _ws.close(); } catch (e) {}
          _ws = null;
        }
        startXrayLogAuto();
      }

      try { updateXrayLogStats(); } catch (e) {}
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Не удалось включить логи.';
    }
  }

  async function xrayLogsDisable() {
    // Stop auto updates immediately to keep last snapshot
    stopXrayLogAuto();
    const statusEl = $('xray-log-status');
    try {
      const res = await fetch('/api/xray-logs/disable', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);

      if (statusEl) statusEl.textContent = 'Логи остановлены (loglevel=none). Xray перезапущен.';
      try { await refreshXrayLogStatus(); } catch (e) {}
      setXrayHeaderBadgeState('off', 'none');
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Не удалось остановить логи.';
    }
  }

  async function xrayLogsClear() {
    const statusEl = $('xray-log-status');
    try {
      const file = _currentFile || 'access';
      const res = await fetch('/api/xray-logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) throw new Error('http ' + res.status);

      _lastLines = [];
      _cursor = '';
      _pendingCount = 0;
      applyXrayLogFilterToOutput();
      if (statusEl) statusEl.textContent = 'Логфайлы очищены.';
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Не удалось очистить логфайлы.';
    }
  }

  function xrayLogsCopy() {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    const text = outputEl.textContent || '';
    if (!text) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('Логи Xray скопированы в буфер обмена', false),
        () => fallbackCopyText(text)
      );
    } else {
      fallbackCopyText(text);
    }
  }

function updatePauseButton() {
  const btn = $('xray-log-pause');
  if (!btn) return;

  if (!_streaming) {
    btn.disabled = true;
    btn.textContent = '⏸ Pause';
    btn.title = 'Пауза доступна только в Live режиме.';
    btn.dataset.state = 'off';
    return;
  }

  btn.disabled = false;

  if (_paused) {
    const n = Math.max(0, parseInt(_pendingCount || 0, 10) || 0);
    btn.textContent = n ? `▶ Resume (+${n})` : '▶ Resume';
    btn.title = 'Возобновить обновление экрана (накопленные строки будут показаны).';
    btn.dataset.state = 'on';
  } else {
    btn.textContent = '⏸ Pause';
    btn.title = 'Пауза: заморозить вывод (строки продолжают собираться).';
    btn.dataset.state = 'off';
  }
}

function xrayLogsTogglePause() {
  if (!_streaming) return;

  _paused = !_paused;
  if (_paused) {
    _pendingCount = 0;
  } else {
    _pendingCount = 0;
    applyXrayLogFilterToOutput();
  }

  updatePauseButton();
  updateXrayLogStats();
}

function copyToClipboard(text, okMsg) {
  if (!text) return;
  const msg = okMsg || 'Скопировано в буфер обмена';

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast(msg, false),
      () => fallbackCopyText(text, msg)
    );
  } else {
    fallbackCopyText(text, msg);
  }

}

function handleLogTokenClick(linkEl, e) {
  try {
    if (!linkEl) return;

    const kind = String(linkEl.getAttribute('data-kind') || '').toLowerCase();
    const b64 = String(linkEl.getAttribute('data-b64') || '');
    const token = String((b64 ? b64Decode(b64) : (linkEl.textContent || '')) || '').trim();
    if (!token) return;

    const kindLabel = (() => {
      switch (kind) {
        case 'ip': return 'IP';
        case 'domain': return 'Домен';
        case 'email': return 'Email';
        case 'uuid': return 'UUID';
        case 'inbound': return 'Inbound tag';
        case 'outbound': return 'Outbound tag';
        case 'sni': return 'SNI';
        case 'path': return 'Path';
        default: return 'Токен';
      }
    })();

    // Shift+Click -> add token to filter (AND semantics: space-separated terms)
    if (e && e.shiftKey) {
      const filterEl = $('xray-log-filter');
      if (filterEl) {
        const cur = String(filterEl.value || '').trim();
        const parts = cur ? cur.split(/\s+/).filter(Boolean) : [];
        if (!parts.includes(token)) parts.push(token);
        filterEl.value = parts.join(' ');
        try { applyXrayLogFilterToOutput(); } catch (e2) {}
        toast(kindLabel + ' добавлен в фильтр', false);
        try { filterEl.focus(); } catch (e3) {}
        return;
      }
      // If filter UI is missing — fallback to copy
    }

    copyToClipboard(token, kindLabel + ' скопирован');
  } catch (err) {
    // Safe fallback
    try { copyToClipboard(String(linkEl && linkEl.textContent || '').trim(), 'Скопировано'); } catch (e2) {}
  }
}

function xrayLogsCopySelection() {
  try {
    const sel = window.getSelection && window.getSelection();
    const text = sel ? String(sel.toString() || '') : '';
    if (!text.trim()) {
      toast('Нет выделенного текста', true);
      return;
    }
    copyToClipboard(text, 'Выделение скопировано');
  } catch (e) {
    toast('Не удалось скопировать выделение', true);
  }
}

async function xrayLogsDownload() {
  const file = _currentFile || 'access';
  try {
    const res = await fetch('/api/xray-logs/download?file=' + encodeURIComponent(file));
    if (!res.ok) throw new Error('http ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = 'xray-' + file + '.log';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    toast('Не удалось скачать лог', true);
  }
}

// ------- Line actions (context menu + context modal) -------

let _lineMenuEl = null;
let _lineMenuIdx = null;

function ensureLineMenu() {
  if (_lineMenuEl && _lineMenuEl.isConnected) return _lineMenuEl;

  const menu = document.createElement('div');
  menu.id = 'xray-line-menu';
  menu.className = 'dt-log-menu-panel xray-line-menu hidden';
  menu.innerHTML = `
    <button type="button" class="btn-secondary dt-log-btn" id="xray-line-menu-copy">Copy line</button>
    <button type="button" class="btn-secondary dt-log-btn" id="xray-line-menu-context">Context ±20</button>
  `;
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    e.preventDefault();
    const t = e.target;
    if (!t || !t.id) return;

    if (t.id === 'xray-line-menu-copy') {
      if (_lineMenuIdx != null) {
        const line = normalizeLogLine((_lastLines || [])[_lineMenuIdx] || '');
        copyToClipboard(line, 'Строка скопирована');
      }
      closeLineMenu();
      return;
    }

    if (t.id === 'xray-line-menu-context') {
      if (_lineMenuIdx != null) {
        openXrayContextModal(_lineMenuIdx, 20);
      }
      closeLineMenu();
      return;
    }
  });

  // close on outside click
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden')) {
      if (e.target && menu.contains(e.target)) return;
      closeLineMenu();
    }
  });

  // close on scroll/resize
  window.addEventListener('scroll', () => closeLineMenu(), { passive: true });
  window.addEventListener('resize', () => closeLineMenu(), { passive: true });

  _lineMenuEl = menu;
  return menu;
}

function closeLineMenu() {
  try {
    if (_lineMenuEl) _lineMenuEl.classList.add('hidden');
    _lineMenuIdx = null;
  } catch (e) {}
}

function openLineMenu(pageX, pageY, idx) {
  const menu = ensureLineMenu();
  _lineMenuIdx = idx;

  // fit into viewport
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.classList.remove('hidden');

  // measure
  const rect = menu.getBoundingClientRect();
  const w = rect.width || 220;
  const h = rect.height || 120;

  let x = pageX;
  let y = pageY;

  // pageX/pageY are page coords; for fixed positioning we need client coords.
  // We'll prefer client coords when available.
  try {
    x = Math.min(Math.max(8, pageX), vw - w - 8);
    y = Math.min(Math.max(8, pageY), vh - h - 8);
  } catch (e) {}

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function openXrayContextModal(idx, radius) {
  const modal = $('xray-context-modal');
  const out = $('xray-context-output');
  const title = $('xray-context-title');
  if (!modal || !out) return;

  const r = Math.max(1, Math.min(200, parseInt(radius || 20, 10) || 20));
  const src = Array.isArray(_lastLines) ? _lastLines : [];

  const center = Math.max(0, Math.min(src.length - 1, parseInt(idx || 0, 10) || 0));
  const start = Math.max(0, center - r);
  const end = Math.min(src.length, center + r + 1);

  const lines = [];
  for (let i = start; i < end; i++) {
    const mark = i === center ? '▶ ' : '  ';
    lines.push(mark + normalizeLogLine(src[i] || ''));
  }

  if (title) {
    const file = _currentFile || 'access';
    title.textContent = `Xray ${file}.log — context (±${r})`;
  }

  out.textContent = lines.join('\n');
  modal.classList.remove('hidden');
  try { XKeen.ui.modal && XKeen.ui.modal.syncBodyScrollLock && XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
}

function closeXrayContextModal() {
  const modal = $('xray-context-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  try { XKeen.ui.modal && XKeen.ui.modal.syncBodyScrollLock && XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
}

function copyXrayContextModal() {
  const out = $('xray-context-output');
  if (!out) return;
  const text = out.textContent || '';
  if (!text.trim()) return;
  copyToClipboard(text, 'Контекст скопирован');
}

  // ---------- Init / wiring ----------


  function closeXrayMoreMenu() {
    const more = $('xray-log-more');
    if (more && more.open) more.open = false;
  }

  function restartXrayHttpPollingTimer() {
    // Only relevant for HTTP polling mode (when WS is not active)
    if (!_streaming) return;

    const wsActive =
      _ws && typeof WebSocket !== 'undefined' &&
      (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING);

    if (wsActive) return;

    if (_timer) {
      try { clearInterval(_timer); } catch (e) {}
      _timer = null;
    }
    // Fetch immediately and then poll
    fetchXrayLogsOnce('poll');
    _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
  }

  function bindControlsUi() {
  const fileSel = $('xray-log-file');
  const lvlSel = $('xray-log-level');
  const liveEl = $('xray-log-live');
  const intervalEl = $('xray-log-interval');
  const followEl = $('xray-log-follow');
  const loadMoreBtn = $('xray-log-load-more');

  const pauseBtn = $('xray-log-pause');
  const linesInput = $('xray-log-lines');
  const copySelBtn = $('xray-log-copy-selection');
  const dlBtn = $('xray-log-download');
  const outputEl = $('xray-log-output');

  if (liveEl) {
    liveEl.addEventListener('change', () => {
      if (liveEl.checked) startXrayLogAuto();
      else stopXrayLogAuto();
      try { updateXrayLogStats(); } catch (e) {}
      try { scheduleSaveUiState(); } catch (e) {}
    });
  }

  if (fileSel) {
    fileSel.addEventListener('change', () => {
      try { scheduleSaveUiState(); } catch (e) {}
    });
  }  if (lvlSel) {
    lvlSel.addEventListener('change', () => {
      try { scheduleSaveUiState(); } catch (e) {}
      // Re-apply view filters immediately when the threshold changes.
      try { applyXrayLogFilterToOutput(); } catch (e) {}

      // If Xray logging is already enabled, changing loglevel should apply immediately
      // (restart only Xray core) so the user doesn't have to press ▶ manually.
      try {
        const isErrorFile = _isErrorFileName(_currentFile);
        if (!isErrorFile) return;
        const desired = String(lvlSel.value || '').trim().toLowerCase();
        const active = String(_activeLogLevel || 'none').trim().toLowerCase();
        if (ALLOWED_LOGLEVELS.includes(desired) && active && active !== 'none' && desired !== active) {
          if (_applyLevelTimer) {
            try { clearTimeout(_applyLevelTimer); } catch (e) {}
            _applyLevelTimer = null;
          }
          const statusEl = $('xray-log-status');
          if (statusEl) statusEl.textContent = 'Применяю loglevel=' + desired + '...';
          _applyLevelTimer = setTimeout(() => {
            _applyLevelTimer = null;
            xrayLogsEnable();
          }, 250);
        }
      } catch (e) {}
    });
  }

  if (intervalEl) {
    // init from UI (keep default if empty)
    try {
      const v = parseInt(intervalEl.value, 10);
      if (isFinite(v) && v >= 500) _pollMs = v;
    } catch (e) {}

    intervalEl.addEventListener('change', () => {
      try {
        const v = parseInt(intervalEl.value, 10);
        if (isFinite(v) && v >= 500) _pollMs = v;
      } catch (e) {}
      // If we're in HTTP polling mode and streaming is on — restart timer with the new interval.
      try { restartXrayHttpPollingTimer(); } catch (e) {}
      try { updateXrayLogStats(); } catch (e) {}
      try { scheduleSaveUiState(); } catch (e) {}
    });
  }

  if (followEl) {
    // init from UI (default checked in HTML)
    _follow = !!followEl.checked;
    followEl.addEventListener('change', () => {
      _follow = !!followEl.checked;
      if (_follow) {
        try {
          const out = $('xray-log-output');
          if (out) out.scrollTop = out.scrollHeight;
        } catch (e) {}
      }
      try { scheduleSaveUiState(); } catch (e) {}
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      xrayLogsTogglePause();
    });
  }

  if (linesInput) {
    // init
    try { linesInput.value = String(_maxLines || DEFAULT_MAX_LINES); } catch (e) {}
    linesInput.addEventListener('change', () => {
      try {
        let v = parseInt(linesInput.value, 10);
        if (!isFinite(v)) v = DEFAULT_MAX_LINES;
        if (v < 50) v = 50;
        if (v > MAX_MAX_LINES) v = MAX_MAX_LINES;
        _maxLines = v;
        try { linesInput.value = String(v); } catch (e2) {}

        // Reset cursor to avoid missing older tail window.
        _cursor = '';
        _pendingCount = 0;

        // If WS is active — reconnect to get a new snapshot.
        const wsActive =
          _ws && typeof WebSocket !== 'undefined' &&
          (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING);

        if (_streaming && wsActive) {
          try {
            _wsClosingManually = true;
            _ws.close();
          } catch (e3) {}
          _ws = null;
          try { updateXrayLogStats(); } catch (e4) {}
          xrayLogConnectWs();
        } else {
          fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
        }

        try { updateXrayLogStats(); } catch (e5) {}
        closeXrayMoreMenu();
        try { scheduleSaveUiState(); } catch (e6) {}
      } catch (e) {}
    });
  }

  if (copySelBtn) {
    copySelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      xrayLogsCopySelection();
      closeXrayMoreMenu();
    });
  }

  if (dlBtn) {
    dlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      xrayLogsDownload();
      closeXrayMoreMenu();
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', (e) => {
      e.preventDefault();

      _maxLines = Math.min((_maxLines || DEFAULT_MAX_LINES) + LOAD_MORE_STEP, MAX_MAX_LINES);
      // Reset cursor because the "window back" changed.
      _cursor = '';
      _pendingCount = 0;

      // If WS is active — reconnect to get a bigger initial snapshot.
      const wsActive =
        _ws && typeof WebSocket !== 'undefined' &&
        (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING);

      if (_streaming && wsActive) {
        try {
          _wsClosingManually = true;
          _ws.close();
        } catch (e2) {}
        _ws = null;
        try { updateXrayLogStats(); } catch (e) {}
        xrayLogConnectWs();
      } else {
        fetchXrayLogsOnce('load_more', { resetCursor: true, forceRender: true });
      }

      try { updateXrayLogStats(); } catch (e3) {}
      closeXrayMoreMenu();
      try { scheduleSaveUiState(); } catch (e4) {}
    });
  }

  // Persist log window height (user-resizable via CSS resize:vertical)
  if (outputEl && !_resizeObserver && typeof ResizeObserver !== 'undefined') {
    try {
      _resizeObserver = new ResizeObserver(() => {
        try { scheduleSaveUiState(); } catch (e) {}
      });
      _resizeObserver.observe(outputEl);
    } catch (e) {}
  }

  if (outputEl) {
    outputEl.addEventListener('contextmenu', (e) => {
      const t = e.target;
      const lineEl = t && t.closest ? t.closest('.log-line') : null;
      if (!lineEl) return;
      const idxStr = lineEl.getAttribute('data-idx');
      const idx = parseInt(idxStr || '', 10);
      if (!isFinite(idx)) return;

      e.preventDefault();
      closeLineMenu();
      openLineMenu(e.clientX || 0, e.clientY || 0, idx);
    });

    // Clickable tokens (IP/domains): click -> copy, Shift+Click -> add to filter
    // Alt+Click (on line) opens context immediately
    outputEl.addEventListener('click', (e) => {
      const t = e.target;
      const linkEl = t && t.closest ? t.closest('.log-link') : null;
      if (linkEl && outputEl.contains(linkEl)) {
        e.preventDefault();
        e.stopPropagation();
        closeLineMenu();
        handleLogTokenClick(linkEl, e);
        return;
      }

      if (!e.altKey) return;

      const lineEl = t && t.closest ? t.closest('.log-line') : null;
      if (!lineEl) return;
      const idxStr = lineEl.getAttribute('data-idx');
      const idx = parseInt(idxStr || '', 10);
      if (!isFinite(idx)) return;

      e.preventDefault();
      closeLineMenu();
      openXrayContextModal(idx, 20);
    });
  }

  // Initial stats
  try { updatePauseButton(); } catch (e) {}
  try { updateXrayLogStats(); } catch (e) {}
}

  function bindFilterUi() {
    const filterEl = $('xray-log-filter');
    const clearBtn = $('xray-log-filter-clear');

    if (filterEl) {
      filterEl.addEventListener('input', () => {
        applyXrayLogFilterToOutput();
        try { scheduleSaveUiState(); } catch (e) {}
      });
      filterEl.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            filterEl.blur();
          }
        },
        { passive: false }
      );
    }

    if (clearBtn && filterEl) {
      clearBtn.addEventListener('click', () => {
        filterEl.value = '';
        applyXrayLogFilterToOutput();
        try { scheduleSaveUiState(); } catch (e) {}
        try { filterEl.focus(); } catch (e) {}
      });
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;

    // По умолчанию автообновление выключено
    _streaming = false;
    try { setXrayLogLampState('off'); } catch (e) {}

    // Restore UI preferences for this page (file/live/follow/interval/lines/filter/height)
    // BEFORE wiring listeners, so we don't accidentally trigger actions.
    try { applyStoredUiState(); } catch (e) {}

    // Sync current file from UI (after restore)
    try { syncCurrentFileFromUi(); } catch (e) {}

    try { bindControlsUi(); } catch (e) {}
    try { bindFilterUi(); } catch (e) {}

    // Context modal buttons
    try {
      const close1 = $('xray-context-close-btn');
      const close2 = $('xray-context-close-btn2');
      const copyBtn = $('xray-context-copy-btn');
      if (close1) close1.addEventListener('click', (e) => { e.preventDefault(); closeXrayContextModal(); });
      if (close2) close2.addEventListener('click', (e) => { e.preventDefault(); closeXrayContextModal(); });
      if (copyBtn) copyBtn.addEventListener('click', (e) => { e.preventDefault(); copyXrayContextModal(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeXrayContextModal();
      });
    } catch (e) {}

    // Clean up WS on page unload
    try {
      window.addEventListener('beforeunload', () => {
        try { stopXrayLogAuto(); } catch (e) {}
        try { if (_statusTimer) clearInterval(_statusTimer); } catch (e2) {}
        _statusTimer = null;
      });
    } catch (e) {}

    // initial status refresh (safe on pages without logs)
    try { refreshXrayLogStatus(); } catch (e) {}

    // Also poll status in background to keep the header badge up to date
    // even when the user does not open the "Live логи Xray" tab.
    try {
      if (!_statusTimer) _statusTimer = setInterval(() => {
        try { void refreshXrayLogStatus(); } catch (e) {}
      }, 10000);
    } catch (e) {}

    // Refresh once when tab becomes active again
    try {
      document.addEventListener('visibilitychange', () => {
        try { if (!document.hidden) void refreshXrayLogStatus(); } catch (e) {}
      });
    } catch (e) {}
  }

  const api = {
    init,
    start: startXrayLogAuto,
    stop: stopXrayLogAuto,
    viewOnce: xrayLogsView,
    clearScreen: xrayLogsClearScreen,
    changeFile: xrayLogChangeFile,
    enable: xrayLogsEnable,
    disable: xrayLogsDisable,
    clearFiles: xrayLogsClear,
    copy: xrayLogsCopy,
    refreshStatus: refreshXrayLogStatus,
    applyFilter: applyXrayLogFilterToOutput,
  };

  XKeen.features.xrayLogs = api;

  // Backwards-compat globals
  window.setXrayLogLampState = setXrayLogLampState;
  window.refreshXrayLogStatus = refreshXrayLogStatus;

  // Backwards-compat helper used by main.js restart-log renderer
  // (main.js calls getXrayLogLineClass(line) to colorize log lines)
  window.getXrayLogLineClass = getXrayLogLineClass;

  window.fetchXrayLogsOnce = fetchXrayLogsOnce;
  window.applyXrayLogFilterToOutput = applyXrayLogFilterToOutput;

  window.startXrayLogAuto = startXrayLogAuto;
  window.stopXrayLogAuto = stopXrayLogAuto;

  window.xrayLogsView = xrayLogsView;
  window.xrayLogsClearScreen = xrayLogsClearScreen;
  window.xrayLogChangeFile = xrayLogChangeFile;

  window.xrayLogsEnable = xrayLogsEnable;
  window.xrayLogsDisable = xrayLogsDisable;
  window.xrayLogsClear = xrayLogsClear;
  window.xrayLogsCopy = xrayLogsCopy;

  // Optional alias used in some older code
  window.xrayLogApplyFilter = applyXrayLogFilterToOutput;

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
