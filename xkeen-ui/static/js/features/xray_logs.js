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

  const MAX_LINES = 800;
  const POLL_MS = 2000;

  let _inited = false;

  let _timer = null;
  let _currentFile = 'error';
  let _lastLines = [];

  let _ws = null;
  let _useWs = true;
  let _wsEverOpened = false;
  let _wsClosingManually = false;

  function $(id) {
    return document.getElementById(id);
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

  function fallbackCopyText(text) {
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
      toast('Логи Xray скопированы в буфер обмена', false);
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

  // ---------- UI: lamp + rendering ----------

  function setXrayLogLampState(state, level) {
    const lamp = $('xray-log-lamp');
    if (!lamp) return;

    lamp.dataset.state = String(state || '');
    const lvl = level ? String(level) : '';

    if (state === 'on') {
      lamp.title = lvl ? `Логи включены (loglevel=${lvl})` : 'Логи включены';
      lamp.classList.add('pulse');
      setTimeout(() => lamp.classList.remove('pulse'), 300);
    } else if (state === 'off') {
      lamp.title = 'Логи отключены (loglevel=none)';
      lamp.classList.remove('pulse');
    } else if (state === 'error') {
      lamp.title = 'Не удалось получить статус логов Xray';
      lamp.classList.remove('pulse');
    } else {
      lamp.title = 'Статус логов Xray неизвестен';
      lamp.classList.remove('pulse');
    }
  }

  async function refreshXrayLogStatus() {
    try {
      const res = await fetch('/api/xray-logs/status');
      if (!res.ok) throw new Error('status http error');
      const data = await res.json().catch(() => ({}));
      const level = String(data.loglevel || 'none').toLowerCase();
      const state = level === 'none' ? 'off' : 'on';
      setXrayLogLampState(state, level);
    } catch (e) {
      console.error('xray log status error', e);
      setXrayLogLampState('error');
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

    return 'log-line';
  }

  function parseXrayLogLine(line) {
    const clean = normalizeLogLine(line);
    if (!clean || !String(clean).trim()) return '';

    const cls = getXrayLogLineClass(clean);
    let processed = escapeHtml(clean);

    // Typical Xray levels
    processed = processed
      .replace(/\[Info\]/g, '<span style="color:#3b82f6;">[Info]</span>')
      .replace(/\[Warning\]/g, '<span style="color:#f59e0b;">[Warning]</span>')
      .replace(/\[Error\]/g, '<span style="color:#ef4444;">[Error]</span>')
      .replace(/level=(info)/gi, 'level=<span style="color:#3b82f6;">$1</span>')
      .replace(/level=(warning)/gi, 'level=<span style="color:#f59e0b;">$1</span>')
      .replace(/level=(error)/gi, 'level=<span style="color:#ef4444;">$1</span>');

    // Route highlights (in brackets)
    processed = processed
      .replace(/\[(?:tproxy)[^\]]*vless-reality[^\]]*\]/gi, '<span class="log-route log-route-tproxy-vless">$&</span>')
      .replace(/\[(?:redirect)[^\]]*vless-reality[^\]]*\]/gi, '<span class="log-route log-route-redirect-vless">$&</span>')
      .replace(/\[(?:redirect)[^\]]*direct[^\]]*\]/gi, '<span class="log-route log-route-redirect-direct">$&</span>')
      .replace(/\[(?:reject)[^\]]*\]/gi, '<span class="log-route log-route-reject">$&</span>')
      .replace(/\breject(ed)?\b/gi, '<span class="log-route log-route-reject">$&</span>');

    // IPv4 (+ optional port)
    processed = processed.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<span class="log-ip">$&</span>');

    // Domains (avoid hitting inside already injected tags)
    processed = processed.replace(/(^|[^">])((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})/g, '$1<span class="log-domain">$2</span>');

    return '<span class="' + cls + '">' + processed + '</span>';
  }

  function applyXrayLogFilterToOutput() {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    const filterEl = $('xray-log-filter');
    const rawFilter = ((filterEl && filterEl.value) || '').trim().toLowerCase();

    const terms = rawFilter
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const sourceLines = (_lastLines || []).map(normalizeLogLine);
    const filtered = terms.length
      ? sourceLines.filter((line) => {
          const lower = String(line || '').toLowerCase();
          return terms.every((t) => lower.includes(t));
        })
      : sourceLines;

    const wasAtBottom = outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 5;
    // Each line is rendered as a block-level <span>. Adding extra '\n' creates empty rows in <pre>.
    outputEl.innerHTML = filtered.map((line) => parseXrayLogLine(line)).join('');
    if (wasAtBottom) outputEl.scrollTop = outputEl.scrollHeight;
  }

  // ---------- Data sources: HTTP + WebSocket ----------

  async function fetchXrayLogsOnce(source = 'manual') {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    const statusEl = $('xray-log-status');
    const file = _currentFile || 'error';

    try {
      const res = await fetch(
        `/api/xray-logs?file=${encodeURIComponent(file)}&max_lines=${MAX_LINES}&source=${encodeURIComponent(source)}`
      );
      if (!res.ok) {
        if (statusEl) statusEl.textContent = 'Не удалось загрузить логи Xray.';
        return;
      }
      const data = await res.json().catch(() => ({}));
      _lastLines = data.lines || [];
      applyXrayLogFilterToOutput();
      if (statusEl) statusEl.textContent = '';
      refreshXrayLogStatus();
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Ошибка чтения логов Xray.';
    }
  }

  function xrayLogConnectWs() {
    if (!_useWs || !('WebSocket' in window)) {
      _useWs = false;
      return;
    }

    // Already open/connecting
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const statusEl = $('xray-log-status');
    const file = _currentFile || 'error';

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = proto + '//' + host + '/ws/xray-logs?file=' + encodeURIComponent(file);

    wsDebug('WS: connecting', { url: url, file: file });

    try {
      _wsClosingManually = false;
      _wsEverOpened = false;
      _ws = new WebSocket(url);
    } catch (e) {
      console.error('Failed to create WebSocket for logs', e);
      _useWs = false;
      if (statusEl) statusEl.textContent = 'Не удалось создать WebSocket, использую HTTP.';
      return;
    }

    _ws.onopen = function () {
      wsDebug('WS: open', { file: file });
      _wsEverOpened = true;

      // Disable HTTP polling while WS is active
      if (_timer) {
        try { clearInterval(_timer); } catch (e) {}
        _timer = null;
      }

      if (statusEl) statusEl.textContent = 'WebSocket для логов подключён.';
    };

    _ws.onmessage = function (event) {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('Invalid WebSocket payload for xray logs', e);
        return;
      }

      if (data && data.type === 'init' && Array.isArray(data.lines)) {
        _lastLines = data.lines;
      } else if (data && data.type === 'line' && typeof data.line === 'string') {
        _lastLines.push(data.line);
        if (_lastLines.length > MAX_LINES) _lastLines = _lastLines.slice(-MAX_LINES);
      } else if (Array.isArray(data.lines)) {
        _lastLines = data.lines;
      } else if (data && typeof data.line === 'string') {
        _lastLines.push(data.line);
        if (_lastLines.length > MAX_LINES) _lastLines = _lastLines.slice(-MAX_LINES);
      }

      applyXrayLogFilterToOutput();
    };

    _ws.onclose = function () {
      const visible = isLogsViewVisible();

      wsDebug('WS: close', { file: file, manual: _wsClosingManually, everOpened: _wsEverOpened });

      _ws = null;

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
          fetchXrayLogsOnce('fallback_ws');
          _timer = setInterval(() => fetchXrayLogsOnce('poll'), POLL_MS);
        }
        return;
      }

      // was working -> reconnect, without enabling HTTP (avoid dupes)
      if (statusEl) statusEl.textContent = 'WebSocket для логов разорван, пытаюсь переподключиться...';

      setTimeout(() => {
        const stillVisible = isLogsViewVisible();
        if (!_ws && _useWs && stillVisible) xrayLogConnectWs();
      }, 1000);
    };

    _ws.onerror = function () {
      wsDebug('WS: error', { file: file });
      console.warn('WebSocket error in xray logs');
      // Do not switch to HTTP here; onclose decides.
    };
  }

  // ---------- Lifecycle (start/stop) ----------

  function startXrayLogAuto() {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

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
    fetchXrayLogsOnce('manual');
    _timer = setInterval(() => fetchXrayLogsOnce('poll'), POLL_MS);
  }

  function stopXrayLogAuto() {
    if (_timer) {
      try { clearInterval(_timer); } catch (e) {}
      _timer = null;
    }

    if (_ws) {
      _wsClosingManually = true;
      try { _ws.close(); } catch (e) {}
      _ws = null;
    }
  }

  // ---------- Actions (wired from HTML) ----------

  function xrayLogsView() {
    fetchXrayLogsOnce('manual');
  }

  function xrayLogsClearScreen() {
    const outputEl = $('xray-log-output');
    if (outputEl) outputEl.innerHTML = '';
    _lastLines = [];
  }

  function xrayLogChangeFile() {
    const selectEl = $('xray-log-file');
    if (selectEl) _currentFile = selectEl.value || 'error';

    // clear buffer + redraw
    _lastLines = [];
    applyXrayLogFilterToOutput();

    // If WS in use, reconnect for the new file (avoid HTTP dupes)
    if (_useWs && 'WebSocket' in window) {
      if (_timer) {
        try { clearInterval(_timer); } catch (e) {}
        _timer = null;
      }

      if (_ws) {
        _wsClosingManually = true;
        try { _ws.close(); } catch (e) {}
        _ws = null;
      }
      xrayLogConnectWs();
      return;
    }

    fetchXrayLogsOnce('manual');
  }

  async function xrayLogsEnable() {
    const statusEl = $('xray-log-status');
    try {
      const res = await fetch('/api/xray-logs/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loglevel: 'warning' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);

      if (statusEl) {
        statusEl.textContent =
          'Логи включены (loglevel=' + (data.loglevel || 'warning') + '). Xray перезапущен.';
      }
      setXrayLogLampState('on', data.loglevel || 'warning');
      // Resume stream if the tab is visible
      if (isLogsViewVisible()) startXrayLogAuto();
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
      setXrayLogLampState('off', 'none');
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Не удалось остановить логи.';
    }
  }

  async function xrayLogsClear() {
    const statusEl = $('xray-log-status');
    try {
      const file = _currentFile || 'error';
      const res = await fetch('/api/xray-logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) throw new Error('http ' + res.status);

      _lastLines = [];
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

  // ---------- Init / wiring ----------

  function bindFilterUi() {
    const filterEl = $('xray-log-filter');
    const clearBtn = $('xray-log-filter-clear');

    if (filterEl) {
      filterEl.addEventListener('input', () => applyXrayLogFilterToOutput());
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
        try { filterEl.focus(); } catch (e) {}
      });
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;

    // sync current file from UI
    const selectEl = $('xray-log-file');
    if (selectEl) _currentFile = selectEl.value || _currentFile;

    try { bindFilterUi(); } catch (e) {}

    // Clean up WS on page unload
    try {
      window.addEventListener('beforeunload', () => {
        try { stopXrayLogAuto(); } catch (e) {}
      });
    } catch (e) {}

    // initial status refresh (safe on pages without logs)
    try { refreshXrayLogStatus(); } catch (e) {}
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