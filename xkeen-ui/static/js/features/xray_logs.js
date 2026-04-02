import { getXrayLogLineClass } from './xray_log_line_class.js';
import {
  closeXkeenModal,
  confirmXkeenAction,
  escapeXkeenHtml,
  getXkeenSettingsApi,
  isXkeenMipsRuntime,
  openXkeenModal,
  syncXkeenBodyScrollLock,
  toastXkeen,
} from './xkeen_runtime.js';

let xrayLogsModuleApi = null;

(() => {
  // Xray live logs: subscribe/poll, filters, start/stop, UI rendering.
  //
  // Public API:
  //   xrayLogsApi.init()
  //   xrayLogsApi.start() / stop()
  //   xrayLogsApi.viewOnce()
  //   xrayLogsApi.changeFile(file)
  //   xrayLogsApi.refreshStatus()
  //
  function isPerfLite() {
    try {
      if (document.body && document.body.classList && document.body.classList.contains('xk-perf-lite')) return true;
    } catch (e) {}
    if (isXkeenMipsRuntime()) return true;
    return false;
  }

  const DEFAULT_MAX_LINES = isPerfLite() ? 400 : 800;
  const DEFAULT_POLL_MS = isPerfLite() ? 3000 : 2000;
  const LOAD_MORE_STEP = isPerfLite() ? 200 : 400;
  const MAX_MAX_LINES = 5000;

  function toast(message, kindOrOptions) {
    return toastXkeen(message, kindOrOptions);
  }

  function actionToast(id, message, kindOrOptions) {
    const options = (kindOrOptions && typeof kindOrOptions === 'object' && !Array.isArray(kindOrOptions))
      ? Object.assign({}, kindOrOptions, { id: String(id || ''), message: String(message || '') })
      : { id: String(id || ''), message: String(message || ''), kind: kindOrOptions };

    return toast(options);
  }

  function buildConfirmText(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const message = String(opts.message || opts.text || opts.body || 'Continue?').trim() || 'Continue?';
    const details = Array.isArray(opts.details)
      ? opts.details.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
      : String(opts.details || '').trim();
    return details ? (message + '\n\n' + details) : message;
  }

  async function confirmAction(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const ok = await confirmXkeenAction(opts, buildConfirmText(opts));
    if (!ok && opts.cancelMessage) {
      actionToast('xray-logs-confirm-cancel', String(opts.cancelMessage || ''), String(opts.cancelKind || 'info'));
    }
    return !!ok;
  }

  // Legacy localStorage prefs (file/interval/follow/live/lines/filter + log window height).
  // Commit 14 migrates these prefs to /api/ui-settings so they can sync across devices.
  // We keep STORAGE_KEY only for one-time seeding.
  const STORAGE_KEY = 'xkeen.ui.xrayLogs.v1';
  const SEED_KEY = 'xkeen.seed.logsPrefs.v1';
  const FILTER_APPLY_DEBOUNCE_MS = 180;

  let _maxLines = DEFAULT_MAX_LINES;
  let _pollMs = DEFAULT_POLL_MS;
  let _follow = true;
  let _liveWanted = false;

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
  let _httpFetchInFlight = false;

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

  // Fullscreen for the Xray logs card is implemented as a CSS class on the card.
  // (Same UX approach as File Manager / Terminal).
  let _isFullscreen = false;
  let _heightBeforeFullscreen = null;

  // UI settings (server): loaded on demand.
  // IMPORTANT: do NOT auto-fetch on page load. We only load settings when the
  // user actually opens/starts the logs view (needed for upcoming Monaco/ANSI features).
  let _uiSettingsLoaded = false;
  let _uiSettingsLoadPromise = null;
  let _uiSettingsUnsubscribe = null;
  let _ansiEnabled = false;
  let _ws2Enabled = false;
  // Xray logs view prefs (file/filter/follow/live/maxLines/pollMs/height)
  // are stored in /api/ui-settings (Commit 14). We apply them lazily when the
  // user actually uses the logs view (view/enable/live).
  let _logsViewPrefsReady = false;
  let _logsViewPrefsUserTouched = false;
  let _logsViewPrefsApplying = false;
  let _ws2FailedSession = false;
  let _ws2PendingCmd = null;
  let _ws2SwitchTimer = null;
  let _filterApplyTimer = null;
  let _ws2FailStreak = 0;
  let _ws2LastOpenAt = 0;
  let _chromeRenderQueued = false;
  let _xrayLogUiStatusRenderQueued = false;
  const _xrayLogUiStatus = {
    phase: 'idle',
    tone: 'muted',
    transport: '',
    message: '',
    file: '',
  };

  function getSettingsApi() {
    return getXkeenSettingsApi();
  }

  function readSharedUiSettingsSnapshot() {
    try {
      const api = getSettingsApi();
      if (!api || typeof api.get !== 'function') return null;
      return api.get();
    } catch (e) {
      return null;
    }
  }

  function sharedUiSettingsLoadedFromServer() {
    try {
      const api = getSettingsApi();
      if (!api || typeof api.isLoadedFromServer !== 'function') return false;
      return !!api.isLoadedFromServer();
    } catch (e) {
      return false;
    }
  }

  function ensureUiSettingsBinding() {
    if (_uiSettingsUnsubscribe) return _uiSettingsUnsubscribe;

    const api = getSettingsApi();
    if (!api || typeof api.subscribe !== 'function') return null;

    _uiSettingsUnsubscribe = api.subscribe((nextSnapshot, prevSnapshot, meta) => {
      _applyUiSettingsSnapshot(
        nextSnapshot,
        meta && meta.source ? meta.source : 'settings',
        meta && typeof meta.loadedFromServer === 'boolean'
          ? !!meta.loadedFromServer
          : sharedUiSettingsLoadedFromServer()
      );
    }, { immediate: true });

    return _uiSettingsUnsubscribe;
  }

  function _applyUiSettingsSnapshot(s, reason = '', loadedFromServerOverride) {
    try {
      const prevAnsi = _ansiEnabled;
      const prevWs2 = _ws2Enabled;

      _ansiEnabled = !!(s && s.logs && s.logs.ansi);
      _ws2Enabled = !!(s && s.logs && s.logs.ws2);

      // ANSI toggle: can be applied immediately by re-rendering current buffer.
      if (prevAnsi !== _ansiEnabled) {
        try { _pendingCount = 0; applyXrayLogFilterToOutput(); } catch (e) {}
      }

      // WS2 toggle: apply immediately for live streaming if possible.
      if (prevWs2 !== _ws2Enabled && _streaming) {
        // If WS2 has been marked as failed for this session, do not force-switch.
        if (_ws2FailedSession && _ws2Enabled) return;

        const wantWs2 = _shouldUseWs2();
        const isWs2 = _isWs2Socket(_ws);

        // Switch transport by closing the active socket and reconnecting.
        if (wantWs2 && !isWs2) {
          try { _wsClosingManually = true; if (_ws) _ws.close(); } catch (e) {}
          _ws = null;
          setTimeout(() => { try { xrayLogConnectWsSmart(); } catch (e) {} }, 0);
        }

        if (!wantWs2 && isWs2) {
          try { _wsClosingManually = true; if (_ws) _ws.close(); } catch (e) {}
          _ws = null;
          setTimeout(() => { try { xrayLogConnectWs(); } catch (e) {} }, 0);
        }
      }

      // If we got a snapshot from the settings module, consider it "loaded".
      if (typeof loadedFromServerOverride === 'boolean') {
        _uiSettingsLoaded = !!loadedFromServerOverride;
      } else if (reason) {
        _uiSettingsLoaded = sharedUiSettingsLoadedFromServer();
      }
    } catch (e) {}
  }

  // Live updates: react to changes made from the "UI настройки" modal.
  try { ensureUiSettingsBinding(); } catch (e) {}

  async function ensureUiSettingsLoadedForLogs() {
    try { ensureUiSettingsBinding(); } catch (e) {}

    if (_uiSettingsLoaded && sharedUiSettingsLoadedFromServer()) return true;
    if (sharedUiSettingsLoadedFromServer()) {
      const snapshot = readSharedUiSettingsSnapshot();
      _applyUiSettingsSnapshot(snapshot, 'shared', true);
      return true;
    }
    if (_uiSettingsLoadPromise) return _uiSettingsLoadPromise;

    _uiSettingsLoadPromise = (async () => {
      try {
        const settingsApi = getSettingsApi();
        if (settingsApi && typeof settingsApi.fetchOnce === 'function') {
          const s = await settingsApi.fetchOnce();
          _applyUiSettingsSnapshot(s, 'fetchOnce', true);
        }
        _uiSettingsLoaded = sharedUiSettingsLoadedFromServer();
        return true;
      } catch (e) {
        // Keep logs working even if settings endpoint is unavailable.
        console.warn('ui-settings: failed to load', e);
        _uiSettingsLoadPromise = null;
        return false;
      }
    })();

    return _uiSettingsLoadPromise;
  }

  function _seedMarkerIsSet() {
    try {
      if (!window.localStorage) return false;
      const v = localStorage.getItem(SEED_KEY);
      return v === '1' || v === 'true' || v === 'yes';
    } catch (e) {
      return false;
    }
  }

  function _setSeedMarker() {
    try {
      if (!window.localStorage) return;
      localStorage.setItem(SEED_KEY, '1');
    } catch (e) {}
  }

  function _isViewPrefsEmpty(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return true;
    try {
      return Object.keys(v).length === 0;
    } catch (e) {
      return true;
    }
  }

  function _getServerLogsViewPrefs(settingsObj) {
    try {
      const s = (settingsObj && typeof settingsObj === 'object') ? settingsObj : null;
      const v = s && s.logs && s.logs.view;
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
      return {};
    }
  }

  function _extractViewPrefsFromLegacy(legacy) {
    const st = (legacy && typeof legacy === 'object') ? legacy : {};
    const out = {};

    // keep only known fields (future-proof: unknown fields are ignored)
    if (st.file != null) out.file = String(st.file);
    if (st.filter != null) out.filter = String(st.filter);
    if (typeof st.live === 'boolean') out.live = !!st.live;
    if (typeof st.follow === 'boolean') out.follow = !!st.follow;
    if (st.maxLines != null) out.maxLines = st.maxLines;
    if (st.pollMs != null) out.pollMs = st.pollMs;
    if (st.height != null) out.height = st.height;
    if (st.loglevel != null) out.loglevel = String(st.loglevel);

    // keep last update timestamp if present
    if (st.ts != null) out.ts = st.ts;
    return out;
  }

  async function _saveLogsViewPrefsToServerBestEffort(reason) {
    try {
      const settingsApi = getSettingsApi();
      if (!settingsApi || typeof settingsApi.patch !== 'function') return false;
      // We only write view prefs; feature flags (ansi/ws2) live alongside.
      const cur = collectUiState();
      await settingsApi.patch({ logs: { view: cur } });
      // Once we successfully persist view prefs to the server, consider migration complete.
      // This prevents legacy localStorage prefs from becoming the "parallel truth" again.
      try { _setSeedMarker(); } catch (e2) {}
      return true;
    } catch (e) {
      console.warn('ui-settings: failed to save logs view prefs' + (reason ? ' (' + reason + ')' : ''), e);
      return false;
    }
  }

  async function ensureLogsViewPrefsLoadedForLogs() {
    if (_logsViewPrefsReady) return true;

    // Ensure /api/ui-settings is fetched (or at least attempted) before we decide on seeding.
    try { await ensureUiSettingsLoadedForLogs(); } catch (e) {}

    // If the settings helper is missing or the endpoint is not reachable, keep legacy behavior.
    const settingsApi = getSettingsApi();
    if (!settingsApi || typeof settingsApi.get !== 'function') {
      _logsViewPrefsReady = true;
      return false;
    }

    // If we failed to load settings from server, don't try to seed/apply.
    if (!sharedUiSettingsLoadedFromServer()) {
      _logsViewPrefsReady = true;
      return false;
    }

    let settings = readSharedUiSettingsSnapshot();
    let view = _getServerLogsViewPrefs(settings);

    // One-time migration: seed server prefs from legacy localStorage.
    if (!_seedMarkerIsSet() && _isViewPrefsEmpty(view)) {
      const legacy = readStoredUiState();
      const hasLegacy = legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0;
      if (hasLegacy) {
        try {
          const seed = _extractViewPrefsFromLegacy(legacy);
          await settingsApi.patch({ logs: { view: seed } });
          _setSeedMarker();
          // Stop using legacy storage after successful seed.
          try { localStorage.removeItem(STORAGE_KEY); } catch (e2) {}
          settings = readSharedUiSettingsSnapshot();
          view = _getServerLogsViewPrefs(settings);
        } catch (e) {
          console.warn('ui-settings: seed from localStorage failed', e);
        }
      }
    }

    // If the user already changed something on this page before we had a chance to apply
    // server prefs, prefer the current UI state and push it to the server (best-effort).
    if (_logsViewPrefsUserTouched) {
      try { await _saveLogsViewPrefsToServerBestEffort('user_touched'); } catch (e) {}
      _logsViewPrefsReady = true;
      return true;
    }

    // Apply server prefs to UI (one-shot) so the view matches other devices.
    if (!_isViewPrefsEmpty(view)) {
      _logsViewPrefsApplying = true;
      try {
        applyUiStateFromPrefs(view);
      } catch (e) {
        console.warn('ui-settings: failed to apply logs view prefs', e);
      }
      _logsViewPrefsApplying = false;
      try { syncCurrentFileFromUi(); } catch (e) {}
    }

    _logsViewPrefsReady = true;
    return true;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function syncTooltipText(el, text, ariaLabel) {
    if (!el) return;

    const nextText = String(text || '').trim();
    const nextAria = arguments.length >= 3 ? String(ariaLabel || '').trim() : null;

    if (nextText) {
      el.title = nextText;
      try { el.setAttribute('data-tooltip', nextText); } catch (e) {}
    } else {
      try { el.removeAttribute('title'); } catch (e) {}
      try { el.removeAttribute('data-tooltip'); } catch (e) {}
    }

    if (nextAria == null) return;

    if (nextAria) {
      try { el.setAttribute('aria-label', nextAria); } catch (e) {}
      return;
    }

    try { el.removeAttribute('aria-label'); } catch (e) {}
  }

  function clampLogLinesValue(value, fallbackValue) {
    let next = parseInt(value, 10);
    if (!isFinite(next)) next = parseInt(fallbackValue, 10);
    if (!isFinite(next)) next = DEFAULT_MAX_LINES;
    if (next < 50) next = 50;
    if (next > MAX_MAX_LINES) next = MAX_MAX_LINES;
    return next;
  }

  function trimLogBuffer(lines, maxLines) {
    const src = Array.isArray(lines) ? lines : [];
    const limit = clampLogLinesValue(maxLines, DEFAULT_MAX_LINES);
    return src.length > limit ? src.slice(-limit) : src.slice();
  }

  function getXrayLogsDom() {
    return {
      headerBadge: $('xray-logs-badge'),
      lamp: $('xray-log-lamp'),
      file: $('xray-log-file'),
      level: $('xray-log-level'),
      live: $('xray-log-live'),
      interval: $('xray-log-interval'),
      follow: $('xray-log-follow'),
      lines: $('xray-log-lines'),
      filter: $('xray-log-filter'),
      output: $('xray-log-output'),
      status: $('xray-log-status'),
      mode: $('xray-log-mode'),
      stats: $('xray-log-stats'),
      pause: $('xray-log-pause'),
      scrollBottom: $('xray-log-scroll-bottom'),
      fullscreen: $('xray-log-fullscreen'),
    };
  }

  function formatXrayLogFileLabel(file) {
    const value = String(file || '').trim().toLowerCase();
    if (!value || value === 'access') return 'access.log';
    if (value === 'error') return 'error.log';
    return value.endsWith('.log') ? value : (value + '.log');
  }

  function formatXrayLogPollLabel(ms) {
    const value = Math.max(500, parseInt(ms, 10) || DEFAULT_POLL_MS);
    if (value % 1000 === 0) return (value / 1000) + 's';
    return value + 'ms';
  }

  function readXrayLogUiStatus() {
    return {
      phase: String(_xrayLogUiStatus.phase || 'idle'),
      tone: String(_xrayLogUiStatus.tone || 'muted'),
      transport: String(_xrayLogUiStatus.transport || ''),
      message: String(_xrayLogUiStatus.message || ''),
      file: String(_xrayLogUiStatus.file || ''),
    };
  }

  function setXrayLogUiStatus(patch) {
    const next = (patch && typeof patch === 'object') ? patch : {};
    if (next.reset) {
      _xrayLogUiStatus.phase = 'idle';
      _xrayLogUiStatus.tone = 'muted';
      _xrayLogUiStatus.transport = '';
      _xrayLogUiStatus.message = '';
      _xrayLogUiStatus.file = '';
    }

    if (Object.prototype.hasOwnProperty.call(next, 'phase')) {
      _xrayLogUiStatus.phase = String(next.phase || 'idle');
    }
    if (Object.prototype.hasOwnProperty.call(next, 'tone')) {
      _xrayLogUiStatus.tone = String(next.tone || 'muted');
    }
    if (Object.prototype.hasOwnProperty.call(next, 'transport')) {
      _xrayLogUiStatus.transport = String(next.transport || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(next, 'message')) {
      _xrayLogUiStatus.message = String(next.message || '');
    }
    if (Object.prototype.hasOwnProperty.call(next, 'file')) {
      _xrayLogUiStatus.file = String(next.file || '');
    }

    queueXrayLogUiStatusRender();
    return readXrayLogUiStatus();
  }

  function queueXrayLogUiStatusRender() {
    if (_xrayLogUiStatusRenderQueued) return;
    _xrayLogUiStatusRenderQueued = true;

    const flush = () => {
      _xrayLogUiStatusRenderQueued = false;
      try {
        if ($('xray-log-output')) applyXrayLogFilterToOutput();
        else updateXrayLogStats();
      } catch (e) {
        try { updateXrayLogStats(); } catch (e2) {}
      }
    };

    try {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(flush);
        return;
      }
    } catch (e) {}

    setTimeout(flush, 0);
  }

  function readXrayLogsRuntimeState() {
    return {
      maxLines: clampLogLinesValue(_maxLines, DEFAULT_MAX_LINES),
      pollMs: parseInt(_pollMs, 10) || DEFAULT_POLL_MS,
      follow: !!_follow,
      cursor: String(_cursor || ''),
      paused: !!_paused,
      pendingCount: Math.max(0, parseInt(_pendingCount || 0, 10) || 0),
      inited: !!_inited,
      currentFile: String(_currentFile || 'access'),
      lastLines: Array.isArray(_lastLines) ? _lastLines : [],
      ws: _ws,
      useWs: !!_useWs,
      liveWanted: !!_liveWanted,
      streaming: !!_streaming,
      activeLogLevel: String(_activeLogLevel || 'none'),
      isFullscreen: !!_isFullscreen,
      heightBeforeFullscreen: _heightBeforeFullscreen,
      ansiEnabled: !!_ansiEnabled,
      ws2Enabled: !!_ws2Enabled,
    };
  }

  function readXrayLogsViewState(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const runtime = runtimeState || readXrayLogsRuntimeState();

    let height = null;
    try {
      if (refs.output) height = Math.round(refs.output.getBoundingClientRect().height);
    } catch (e) {}

    if (runtime.isFullscreen && runtime.heightBeforeFullscreen != null) {
      height = runtime.heightBeforeFullscreen;
    }

    return {
      file: String((refs.file && refs.file.value) || runtime.currentFile || 'access'),
      loglevel: String((refs.level && refs.level.value) || ''),
      live: !!(refs.live && refs.live.checked),
      follow: !!(refs.follow && refs.follow.checked),
      pollMs: (() => {
        const value = parseInt((refs.interval && refs.interval.value) || '', 10);
        return isFinite(value) && value >= 500 ? value : runtime.pollMs;
      })(),
      maxLines: clampLogLinesValue((refs.lines && refs.lines.value) || runtime.maxLines, runtime.maxLines),
      filter: String((refs.filter && refs.filter.value) || ''),
      height: height,
      ts: Date.now(),
    };
  }

  function isXrayLogOutputNearBottom(outputEl) {
    const el = outputEl || $('xray-log-output');
    if (!el) return true;

    try {
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    } catch (e) {
      return true;
    }
  }

  function scrollXrayLogOutputToBottom() {
    try {
      const out = $('xray-log-output');
      if (out) out.scrollTop = out.scrollHeight;
    } catch (e) {}
  }

  function setXrayLogsLiveWanted(enabled, options) {
    const opts = options || {};
    _liveWanted = !!enabled;

    try {
      const liveEl = $('xray-log-live');
      if (liveEl && liveEl.checked !== _liveWanted) liveEl.checked = _liveWanted;
    } catch (e) {}

    if (!opts.skipRender) {
      try { updateXrayLogStats(); } catch (e) {}
    }

    return _liveWanted;
  }

  function setXrayLogsFollowEnabled(enabled, options) {
    const opts = options || {};
    _follow = !!enabled;

    try {
      const followEl = $('xray-log-follow');
      if (followEl && followEl.checked !== _follow) followEl.checked = _follow;
    } catch (e) {}

    if (_follow && !opts.skipScroll) scrollXrayLogOutputToBottom();

    if (!opts.skipRender) {
      try { updateXrayLogStats(); } catch (e) {}
    }

    return _follow;
  }

  function readXrayLogsModeState(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const isNearBottom = isXrayLogOutputNearBottom(refs.output);
    const followEnabled = !!runtime.follow;
    const liveActive = !!runtime.streaming;
    const liveWanted = !!runtime.liveWanted;
    const paused = !!runtime.paused;
    const pending = Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0);

    let state = 'manual';
    let label = 'Manual';
    let title = 'Manual log view without active live streaming.';

    if (paused) {
      state = 'paused';
      label = pending ? ('Paused +' + pending) : 'Paused';
      title = pending
        ? ('Rendering is paused. ' + pending + ' line(s) are buffered.')
        : 'Rendering is paused while incoming lines continue buffering.';
    } else if (liveActive && followEnabled) {
      state = 'live';
      label = 'Live / Follow';
      title = 'Live stream is active and the view stays pinned to the latest lines.';
    } else if (liveActive) {
      state = 'browse';
      label = 'Live / Browse';
      title = 'Live stream is active while Follow is disabled, so you can inspect older lines.';
    } else if (liveWanted) {
      state = 'armed';
      label = 'Live / Ready';
      title = 'Live mode is selected, but the stream is currently idle.';
    } else if (followEnabled) {
      state = 'manual-follow';
      label = 'Manual / Follow';
      title = 'Manual log view with Follow enabled for the next render.';
    }

    return {
      state,
      label,
      title,
      paused,
      pending,
      liveActive,
      liveWanted,
      followEnabled,
      isNearBottom,
    };
  }

  function renderXrayLogModeLayer(dom, runtimeState, modeState) {
    const refs = dom || getXrayLogsDom();
    const el = refs.mode;
    if (!el) return;

    const mode = modeState || readXrayLogsModeState(refs, runtimeState);
    el.dataset.state = String(mode.state || 'manual');
    el.textContent = String(mode.label || 'Manual');
    syncTooltipText(el, String(mode.title || ''));
  }

  function renderXrayLogScrollBottomLayer(dom, runtimeState, modeState) {
    const refs = dom || getXrayLogsDom();
    const btn = refs.scrollBottom;
    if (!btn) return;

    const runtime = runtimeState || readXrayLogsRuntimeState();
    const mode = modeState || readXrayLogsModeState(refs, runtime);
    const hasLines = Array.isArray(runtime.lastLines) && runtime.lastLines.length > 0;
    const visible = !!(hasLines && !mode.followEnabled && !mode.isNearBottom);

    btn.hidden = !visible;
    btn.disabled = !visible;
    btn.dataset.state = visible ? 'visible' : 'hidden';

    if (!visible) {
      btn.textContent = 'Latest';
      syncTooltipText(btn, 'Scroll to the latest rendered lines.');
      return;
    }

    btn.textContent = mode.liveActive ? 'Latest' : 'Bottom';
    syncTooltipText(
      btn,
      mode.liveActive
        ? 'Scroll to the latest rendered lines without enabling Follow.'
        : 'Scroll to the bottom of the current log output.'
    );
  }

  function renderXrayLogsChrome(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const mode = readXrayLogsModeState(refs, runtime);

    renderXrayLogPauseLayer(refs, runtime);
    renderXrayLogModeLayer(refs, runtime, mode);
    renderXrayLogScrollBottomLayer(refs, runtime, mode);
    renderXrayLogStatusLayer(refs, runtime);
  }

  function scheduleXrayLogsChromeRender() {
    if (_chromeRenderQueued) return;
    _chromeRenderQueued = true;

    const flush = () => {
      _chromeRenderQueued = false;
      try { updateXrayLogStats(); } catch (e) {}
    };

    try {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(flush);
        return;
      }
    } catch (e) {}

    setTimeout(flush, 16);
  }

  function renderXrayHeaderBadgeLayer(dom, state, level) {
    const refs = dom || getXrayLogsDom();
    const badge = refs.headerBadge;
    if (!badge) return;

    const nextState = state === 'on' ? 'on' : 'off';
    const nextLevel = String(level || '').trim().toLowerCase();
    const nextLive = (_streaming && nextState === 'on') ? 'on' : 'off';
    let title = 'Логи Xray выключены.';

    badge.dataset.state = nextState;
    badge.dataset.level = nextLevel || 'none';
    badge.dataset.live = nextLive;

    if (nextState === 'on') {
      title = nextLevel && nextLevel !== 'none'
        ? ('Логи Xray включены (loglevel=' + nextLevel + ').')
        : 'Логи Xray включены.';
      if (nextLive === 'on') title += ' Live stream активен.';
    }

    syncTooltipText(badge, title, title);
  }

  function renderXrayLogLampLayer(dom, state) {
    const refs = dom || getXrayLogsDom();
    const lamp = refs.lamp;
    if (!lamp) return;

    const nextState = String(state || '');
    lamp.dataset.state = nextState;

    if (nextState === 'on') {
      lamp.title = 'Автообновление логов включено';
    } else if (nextState === 'off') {
      lamp.title = 'Автообновление логов выключено';
    } else if (nextState === 'error') {
      lamp.title = 'Ошибка автообновления логов';
    } else {
      lamp.title = 'Автообновление логов: неизвестно';
    }
    syncTooltipText(lamp, lamp.getAttribute('title') || '');
  }

  function readXrayLogTransportLabel(runtimeState) {
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const pollLabel = formatXrayLogPollLabel(runtime.pollMs);

    try {
      if (runtime.ws && typeof WebSocket !== 'undefined') {
        if (runtime.ws.readyState === WebSocket.OPEN) {
          return _isWs2Socket(runtime.ws) ? 'WS2 live' : 'WS live';
        }
        if (runtime.ws.readyState === WebSocket.CONNECTING) {
          return _isWs2Socket(runtime.ws) ? 'WS2 connect' : 'WS connect';
        }
      }
    } catch (e) {}

    if (runtime.streaming && runtime.useWs) {
      return _shouldUseWs2() ? 'WS2 retry' : 'WS retry';
    }
    if (runtime.streaming) return 'HTTP/' + pollLabel;
    return '';
  }

  function buildXrayLogStatusModel(runtimeState) {
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const uiStatus = readXrayLogUiStatus();
    const fileLabel = formatXrayLogFileLabel(uiStatus.file || runtime.currentFile);
    const transport = String(uiStatus.transport || readXrayLogTransportLabel(runtime) || '').trim();
    const pending = Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0);

    let phase = String(uiStatus.phase || 'idle');
    let tone = String(uiStatus.tone || 'muted');
    let message = String(uiStatus.message || '').trim();

    if (!message) {
      if (runtime.paused) {
        phase = 'paused';
        tone = 'muted';
        message = pending
          ? ('Вывод на паузе, в буфере уже +' + pending + ' строк.')
          : 'Вывод на паузе. Новые строки будут показаны после Resume.';
      } else if (runtime.ws && typeof WebSocket !== 'undefined' && runtime.ws.readyState === WebSocket.CONNECTING) {
        phase = 'connecting';
        tone = 'muted';
        message = transport
          ? ('Подключаю ' + transport + ' для ' + fileLabel + '...')
          : ('Подключаю live transport для ' + fileLabel + '...');
      } else if (runtime.streaming && runtime.useWs) {
        phase = 'reconnecting';
        tone = 'muted';
        message = transport
          ? ('Поднимаю ' + transport + ' для ' + fileLabel + '...')
          : ('Поднимаю live transport для ' + fileLabel + '...');
      } else if (runtime.streaming) {
        phase = 'streaming';
        tone = 'muted';
        message = 'Live stream идет через HTTP polling каждые ' + formatXrayLogPollLabel(runtime.pollMs) + '.';
      } else if (_isErrorFileName(runtime.currentFile) && String(runtime.activeLogLevel || 'none') === 'none') {
        phase = 'idle';
        tone = 'muted';
        message = 'Логирование Xray сейчас выключено (loglevel=none), поэтому error.log может быть пустым.';
      } else {
        phase = 'idle';
        tone = 'muted';
        message = 'Нажмите View для снимка или включите Live, чтобы ждать новые строки.';
      }
    }

    return {
      phase,
      tone,
      message,
      transport,
      fileLabel,
    };
  }

  function renderXrayLogStatusLayer(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const el = refs.status;
    if (!el) return;

    const model = buildXrayLogStatusModel(runtimeState);
    el.textContent = String(model.message || '');
    el.dataset.phase = String(model.phase || 'idle');
    el.dataset.transport = String(model.transport || '');
    el.dataset.file = String(model.fileLabel || '');

    try {
      el.classList.toggle('error', model.tone === 'error');
    } catch (e) {}
  }

  function renderXrayLogPauseLayer(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const btn = refs.pause;
    const runtime = runtimeState || readXrayLogsRuntimeState();
    if (!btn) return;

    if (!runtime.streaming) {
      btn.disabled = true;
      btn.textContent = '⏸ Pause';
      btn.title = 'Пауза доступна только в Live режиме.';
      btn.dataset.state = 'off';
      syncTooltipText(btn, btn.getAttribute('title') || '');
      return;
    }

    btn.disabled = false;

    if (runtime.paused) {
      const pending = Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0);
      btn.textContent = pending ? `▶ Resume (+${pending})` : '▶ Resume';
      btn.title = 'Возобновить обновление экрана (накопленные строки будут показаны).';
      btn.dataset.state = 'on';
      syncTooltipText(btn, btn.getAttribute('title') || '');
      return;
    }

    btn.textContent = '⏸ Pause';
    btn.title = 'Пауза: заморозить вывод (строки продолжают собираться).';
    btn.dataset.state = 'off';
    syncTooltipText(btn, btn.getAttribute('title') || '');
  }

  function renderXrayLogStatsLayer(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const el = refs.stats;
    const runtime = runtimeState || readXrayLogsRuntimeState();
    if (!el) return;

    const lines = Array.isArray(runtime.lastLines) ? runtime.lastLines.length : 0;
    const max = runtime.maxLines || DEFAULT_MAX_LINES;
    const transport = readXrayLogTransportLabel(runtime);
    const parts = [lines + '/' + max];

    if (transport) parts.push(transport);
    if (runtime.paused) {
      const pending = Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0);
      parts.push(pending ? ('+' + pending + ' queued') : 'buffering');
    }

    el.textContent = parts.join(' • ');
  }

  function buildXrayLogFilterGroups(rawFilter) {
    return String(rawFilter || '')
      .trim()
      .toLowerCase()
      .split('|')
      .map((group) => group.trim())
      .filter(Boolean)
      .map((group) => group.split(/\s+/).map((term) => term.trim()).filter(Boolean));
  }

  function buildFilteredXrayLogEntries(runtimeState, viewState) {
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const view = viewState || readXrayLogsViewState(getXrayLogsDom(), runtime);
    const groups = buildXrayLogFilterGroups(view.filter);
    const selectedLevel = String(view.loglevel || '').trim().toLowerCase();
    const isErrorFile = _isErrorFileName(runtime.currentFile);
    const levelFilter = (isErrorFile && ALLOWED_LOGLEVELS.includes(selectedLevel)) ? selectedLevel : '';

    const rawEntries = (Array.isArray(runtime.lastLines) ? runtime.lastLines : [])
      .map((line, idx) => ({ idx, line: normalizeLogLine(line) }));
    const rawCount = rawEntries.length;

    let entries = rawEntries.slice();

    if (levelFilter) {
      entries = entries.filter((entry) => shouldKeepLineForLevel(entry.line, levelFilter));
    }
    const levelCount = entries.length;

    if (groups.length) {
      entries = entries.filter((entry) => {
        const lower = String(entry.line || '').toLowerCase();
        return groups.some((terms) => terms.every((term) => lower.includes(term)));
      });
    }

    return {
      entries,
      rawCount,
      levelCount,
      levelFilter,
      hasTextFilter: groups.length > 0,
      filterText: String(view.filter || '').trim(),
    };
  }

  function buildXrayLogEmptyStateModel(runtimeState, viewState, filteredSnapshot) {
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const view = viewState || readXrayLogsViewState(getXrayLogsDom(), runtime);
    const snapshot = filteredSnapshot || buildFilteredXrayLogEntries(runtime, view);
    const uiStatus = readXrayLogUiStatus();
    const fileLabel = formatXrayLogFileLabel(runtime.currentFile);
    const pending = Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0);
    const filterText = String(snapshot.filterText || '').trim();

    if (snapshot.entries.length) return null;

    if (snapshot.rawCount > 0 && snapshot.levelCount === 0 && snapshot.levelFilter) {
      return {
        tone: 'warning',
        title: 'Фильтр loglevel скрывает все строки',
        detail: 'В буфере есть ' + snapshot.rawCount + ' строк, но порог ' + snapshot.levelFilter + ' для ' + fileLabel + ' ничего не пропускает.',
      };
    }

    if (snapshot.levelCount > 0 && snapshot.hasTextFilter) {
      return {
        tone: 'muted',
        title: 'Нет совпадений по текстовому фильтру',
        detail: filterText
          ? ('Фильтр "' + filterText + '" не нашел совпадений в ' + snapshot.levelCount + ' строках.')
          : 'Текстовый фильтр не нашел совпадений.',
      };
    }

    if (runtime.paused) {
      return {
        tone: 'info',
        title: 'Вывод на паузе',
        detail: pending
          ? ('Поток продолжает читать ' + fileLabel + ', в буфере уже +' + pending + ' строк.')
          : 'Экран заморожен до Resume. Новые строки появятся после продолжения вывода.',
      };
    }

    if (uiStatus.phase === 'switching') {
      return {
        tone: 'info',
        title: 'Переключаю источник логов',
        detail: String(uiStatus.message || ('Подключаю ' + fileLabel + ' и жду первый снимок.')),
      };
    }

    if (uiStatus.phase === 'connecting' || uiStatus.phase === 'reconnecting' || uiStatus.phase === 'fallback') {
      return {
        tone: uiStatus.tone === 'error' ? 'warning' : 'info',
        title: 'Подключаю live transport',
        detail: String(uiStatus.message || ('Жду первые строки из ' + fileLabel + '.')),
      };
    }

    if (_isErrorFileName(runtime.currentFile) && String(runtime.activeLogLevel || 'none') === 'none') {
      return {
        tone: 'warning',
        title: 'Логирование Xray выключено',
        detail: 'Backend сейчас отвечает с loglevel=none, поэтому error.log может оставаться пустым, пока вы не включите логи.',
      };
    }

    if (runtime.streaming) {
      return {
        tone: 'muted',
        title: fileLabel + ' пока пуст',
        detail: runtime.useWs
          ? 'Live transport уже поднимается, но новых строк в журнале пока нет.'
          : ('HTTP polling проверяет ' + fileLabel + ' каждые ' + formatXrayLogPollLabel(runtime.pollMs) + '.'),
      };
    }

    return {
      tone: 'muted',
      title: fileLabel + ' пока пуст',
      detail: 'Нажмите View, чтобы запросить снимок, или включите Live для ожидания новых строк.',
    };
  }

  function renderXrayLogEmptyStateHtml(model) {
    if (!model) return '';

    const tone = String(model.tone || 'muted');
    const titleClass = tone === 'error'
      ? 'log-line log-line-error'
      : (tone === 'warning'
        ? 'log-line log-line-warning'
        : (tone === 'info' ? 'log-line log-line-info' : 'log-line'));

    const title = escapeHtml(String(model.title || 'Пока нет строк'));
    const detail = escapeHtml(String(model.detail || ''));

    return [
      '<span class="' + titleClass + '" data-empty-state="title">' + title + '</span>',
      detail ? '<span class="log-line" data-empty-state="detail">' + detail + '</span>' : '',
    ].join('');
  }

  function renderXrayLogOutputLayer(dom, runtimeState, viewState) {
    const refs = dom || getXrayLogsDom();
    const outputEl = refs.output;
    if (!outputEl) return;

    const runtime = runtimeState || readXrayLogsRuntimeState();
    const view = viewState || readXrayLogsViewState(refs, runtime);
    const filtered = buildFilteredXrayLogEntries(runtime, view);
    const entries = Array.isArray(filtered.entries) ? filtered.entries : [];

    const wasAtBottom = outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 5;
    const shouldScroll = view.follow ? true : wasAtBottom;

    if (entries.length) {
      outputEl.innerHTML = entries.map((entry) => parseXrayLogLine(entry.line, entry.idx)).join('');
    } else {
      outputEl.innerHTML = renderXrayLogEmptyStateHtml(buildXrayLogEmptyStateModel(runtime, view, filtered));
    }
    if (shouldScroll) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function resetXrayLogBuffer(options) {
    const opts = options || {};
    _lastLines = [];
    if (opts.resetCursor !== false) _cursor = '';
    if (opts.resetPending !== false) _pendingCount = 0;
    return readXrayLogsRuntimeState();
  }

  function replaceXrayLogBuffer(lines) {
    _lastLines = trimLogBuffer(lines, _maxLines);
    return _lastLines;
  }

  function appendXrayLogBuffer(lines) {
    const nextLines = Array.isArray(lines) ? lines : [];
    _lastLines = trimLogBuffer([].concat(Array.isArray(_lastLines) ? _lastLines : [], nextLines), _maxLines);
    return _lastLines;
  }

  function reconcileXrayLogBufferRender(options) {
    const opts = options || {};
    const added = Math.max(0, parseInt(opts.added || 0, 10) || 0);
    const deferWhilePaused = !!opts.deferWhilePaused;
    const forceRender = !!opts.forceRender;
    const skipRender = !!opts.skipRender;

    if (_paused && !forceRender && deferWhilePaused) {
      if (added > 0) _pendingCount += added;
      else _pendingCount = Math.max(0, _pendingCount);
      updateXrayLogStats();
      return false;
    }

    if (skipRender) {
      updateXrayLogStats();
      return false;
    }

    _pendingCount = 0;
    applyXrayLogFilterToOutput();
    return true;
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
    return readXrayLogsViewState(getXrayLogsDom(), readXrayLogsRuntimeState());
  }

  function scheduleSaveUiState() {
    // Do not treat programmatic updates (applying server prefs) as "user touches".
    if (_logsViewPrefsApplying) return;

    _logsViewPrefsUserTouched = true;

    try {
      if (_saveTimer) clearTimeout(_saveTimer);
    } catch (e) {}

    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      (async () => {
        // Primary: server-side settings (sync across devices)
        const saved = await _saveLogsViewPrefsToServerBestEffort('debounced');
        if (saved) return;

        // Fallback: legacy localStorage (keeps UX working if /api/ui-settings is unavailable)
        const prev = readStoredUiState();
        const cur = collectUiState();
        // merge (keep any unknown future fields)
        writeStoredUiState(Object.assign({}, prev || {}, cur || {}));
      })();
    }, 250);
  }

  function applyUiStateFromPrefs(st) {
    const prefs = (st && typeof st === 'object') ? st : {};
    if (!prefs || typeof prefs !== 'object') return;
    const dom = getXrayLogsDom();

    // file (default: access)
    const file = String(prefs.file || '').toLowerCase();
    const fileNorm = (file === 'access' || file === 'access.log') ? 'access' : (file === 'error' || file === 'error.log') ? 'error' : '';
    if (dom.file && fileNorm) dom.file.value = fileNorm;
    if (fileNorm) _currentFile = fileNorm;

    // loglevel selector (UI preference)
    const lvl = String(prefs.loglevel || '').toLowerCase();
    if (dom.level && ALLOWED_LOGLEVELS.includes(lvl)) dom.level.value = lvl;

    // live/follow toggles
    if (typeof prefs.live === 'boolean') {
      setXrayLogsLiveWanted(!!prefs.live, { skipRender: true });
    }

    if (typeof prefs.follow === 'boolean') {
      setXrayLogsFollowEnabled(!!prefs.follow, { skipRender: true, skipScroll: true });
    }

    // interval + internal poll
    try {
      const v = parseInt(prefs.pollMs, 10);
      if (isFinite(v) && v >= 500) {
        _pollMs = v;
        if (dom.interval) dom.interval.value = String(v);
      }
    } catch (e) {}

    // max lines + internal window
    try {
      const v = clampLogLinesValue(prefs.maxLines, DEFAULT_MAX_LINES);
      _maxLines = v;
      if (dom.lines) dom.lines.value = String(v);
    } catch (e) {}

    // filter
    if (dom.filter && typeof prefs.filter === 'string') dom.filter.value = prefs.filter;

    // log window height
    try {
      let h = parseInt(prefs.height, 10);
      if (isFinite(h)) {
        // Keep consistent with CSS min-height.
        if (h < 420) h = 420;
        if (dom.output) dom.output.style.height = String(h) + 'px';
      }
    } catch (e) {}

    try { updateXrayLogStats(); } catch (e) {}
  }

  // Initial restore without triggering /api/ui-settings fetch.
  // - Before migration happens, we keep the old behavior (restore from localStorage).
  // - After migration (seed marker is set), we intentionally avoid using legacy storage
  //   so the source of truth stays on the server (prefs will be applied when the user
  //   opens/starts the logs view).
  function applyInitialUiStateNoFetch() {
    try {
      if (_seedMarkerIsSet()) return;
      const st = readStoredUiState();
      if (st && typeof st === 'object') applyUiStateFromPrefs(st);
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
    syncTooltipText(lvlSel, lvlSel.getAttribute('title') || '');
  }

  function syncCurrentFileFromUi() {
    const selectEl = $('xray-log-file');
    if (selectEl) _currentFile = selectEl.value || _currentFile || 'access';
    updateLoglevelUiForCurrentFile();
  }


  function escapeHtml(str) {
    return escapeXkeenHtml(str);
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



  // ---------- ANSI rendering (optional; enabled via /api/ui-settings -> logs.ansi) ----------

  const ANSI_FG_MAP = {
    30: 'black',
    31: 'red',
    32: 'green',
    33: 'yellow',
    34: 'blue',
    35: 'magenta',
    36: 'cyan',
    37: 'white',
    90: 'bright-black',
    91: 'bright-red',
    92: 'bright-green',
    93: 'bright-yellow',
    94: 'bright-blue',
    95: 'bright-magenta',
    96: 'bright-cyan',
    97: 'bright-white',
  };

  const ANSI_BG_MAP = {
    40: 'black',
    41: 'red',
    42: 'green',
    43: 'yellow',
    44: 'blue',
    45: 'magenta',
    46: 'cyan',
    47: 'white',
    100: 'bright-black',
    101: 'bright-red',
    102: 'bright-green',
    103: 'bright-yellow',
    104: 'bright-blue',
    105: 'bright-magenta',
    106: 'bright-cyan',
    107: 'bright-white',
  };

  function _ansiResetState(st) {
    st.fg = null;
    st.bg = null;
    st.bold = false;
    st.underline = false;
  }

  function _ansiApplySgrParams(params, st) {
    // params is an array of integers (SGR codes)
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (!isFinite(code)) continue;

      if (code === 0) {
        _ansiResetState(st);
        continue;
      }

      // font styles
      if (code === 1) { st.bold = true; continue; }
      if (code === 22) { st.bold = false; continue; }
      if (code === 4) { st.underline = true; continue; }
      if (code === 24) { st.underline = false; continue; }

      // default colors
      if (code === 39) { st.fg = null; continue; }
      if (code === 49) { st.bg = null; continue; }

      // basic 16-color palette
      if (code in ANSI_FG_MAP) { st.fg = ANSI_FG_MAP[code]; continue; }
      if (code in ANSI_BG_MAP) { st.bg = ANSI_BG_MAP[code]; continue; }

      // Extended color: 38;5;<n> or 38;2;<r>;<g>;<b> and same for 48
      // We intentionally do not map 256/truecolor here (keeps CSS simple).
      if (code == 38 || code == 48) {
        const mode = params[i + 1];
        if (mode == 5) {
          // 256 color: skip 2 params
          i += 2;
          continue;
        }
        if (mode == 2) {
          // truecolor: skip 4 params
          i += 4;
          continue;
        }
      }
    }
  }

  function ansiSgrToHtml(html) {
    // Converts SGR codes (ESC[...m) to <span class="ansi ..."> wrappers.
    // Input may already contain other HTML tags (timestamp/levels/links).
    if (!html) return '';
    const s = String(html);
    if (s.indexOf('[') === -1) return s;

    let out = '';
    let pos = 0;

    const st = { fg: null, bg: null, bold: false, underline: false };
    let open = false;

    function closeSpan() {
      if (open) {
        out += '</span>';
        open = false;
      }
    }

    function openSpanIfNeeded() {
      const classes = [];
      if (st.bold) classes.push('ansi-bold');
      if (st.underline) classes.push('ansi-underline');
      if (st.fg) classes.push('ansi-fg-' + st.fg);
      if (st.bg) {
        classes.push('ansi-bg-' + st.bg);
        classes.push('ansi-has-bg');
      }
      if (!classes.length) return;
      out += '<span class="ansi ' + classes.join(' ') + '">';
      open = true;
    }

    while (pos < s.length) {
      const esc = s.indexOf('[', pos);
      if (esc === -1) {
        if (!open) openSpanIfNeeded();
        out += s.slice(pos);
        break;
      }

      // text chunk before escape
      if (esc > pos) {
        if (!open) openSpanIfNeeded();
        out += s.slice(pos, esc);
      }

      // Find end of sequence (we only support SGR: 'm')
      const mEnd = s.indexOf('m', esc + 2);
      if (mEnd === -1) {
        // broken escape sequence: drop the ESC and continue
        pos = esc + 2;
        continue;
      }

      const seq = s.slice(esc + 2, mEnd);
      const parts = seq.length ? seq.split(';') : ['0'];
      const params = parts.map((x) => parseInt(x, 10)).filter((n) => isFinite(n));

      // Update state (close previous styling span)
      closeSpan();
      _ansiApplySgrParams(params.length ? params : [0], st);

      // Open span for new state if needed
      openSpanIfNeeded();

      pos = mEnd + 1;
    }

    closeSpan();
    // Remove any remaining ESC chars (safety)
    out = out.replace(//g, '');
    return out;
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
      actionToast('xray-logs-copy', okMsg || 'Логи Xray скопированы в буфер обмена', 'success');
    } catch (e) {
      actionToast('xray-logs-copy', 'Не удалось скопировать логи', 'error');
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

  // ---------- UI: fullscreen (card-level) ----------

  function _xrayCardEl() {
    try {
      const view = $('view-xray-logs');
      if (!view) return null;
      return view.querySelector ? view.querySelector('.log-card') : null;
    } catch (e) {
      return null;
    }
  }

  function _syncBodyScrollLock() {
    try { syncXkeenBodyScrollLock(!!_isFullscreen); } catch (e) {}
  }

  function _updateFullscreenBtn() {
    const btn = $('xray-log-fullscreen');
    if (!btn) return;
    if (_isFullscreen) {
      btn.textContent = '🗗';
      btn.title = 'Восстановить';
      btn.setAttribute('aria-label', 'Восстановить');
    } else {
      btn.textContent = '⛶';
      btn.title = 'Полный экран';
      btn.setAttribute('aria-label', 'Полный экран');
    }
  }

  function _setFullscreen(on) {
    const card = _xrayCardEl();
    if (!card) return;

    const next = !!on;
    if (next === _isFullscreen) return;

    // Snapshot current (persisted) height so we don't overwrite it in fullscreen.
    if (next) {
      try {
        const st = readStoredUiState();
        const h = parseInt(st && st.height, 10);
        if (isFinite(h)) _heightBeforeFullscreen = h;
      } catch (e) {}

      if (_heightBeforeFullscreen == null) {
        try {
          const out = $('xray-log-output');
          if (out) _heightBeforeFullscreen = Math.round(out.getBoundingClientRect().height);
        } catch (e2) {}
      }
    }

    _isFullscreen = next;
    try { card.classList.toggle('is-fullscreen', _isFullscreen); } catch (e3) {}
    _updateFullscreenBtn();
    _syncBodyScrollLock();
  }

  function _toggleFullscreen() {
    _setFullscreen(!_isFullscreen);
  }

  function _bindFullscreenUi() {
    try {
      const btn = $('xray-log-fullscreen');
      if (btn && !btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          _toggleFullscreen();
        });
      }
      _updateFullscreenBtn();
    } catch (e) {}
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
      if (_ws.readyState === WebSocket.OPEN) transport = _isWs2Socket(_ws) ? 'WS2' : 'WS';
      else if (_ws.readyState === WebSocket.CONNECTING) transport = _isWs2Socket(_ws) ? 'WS2…' : 'WS…';
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

  function setXrayHeaderBadgeState(state, level) {
    renderXrayHeaderBadgeLayer(getXrayLogsDom(), state, level);
  }

  function setXrayLogLampState(state) {
    renderXrayLogLampLayer(getXrayLogsDom(), state);
  }

  function updateXrayLogStats() {
    const dom = getXrayLogsDom();
    const runtime = readXrayLogsRuntimeState();
    renderXrayLogStatsLayer(dom, runtime);
    renderXrayLogsChrome(dom, runtime);
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

  // ---------- Clickable log level badges + quick filters (frontend-only) ----------

  const CLICKABLE_LEVELS_RE = /(^|[^A-Za-z0-9_])((?:DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL))(?![A-Za-z0-9_])/gi;

  function normalizeClickableLevel(levelRaw) {
    const u = String(levelRaw || '').trim().toUpperCase();
    if (!u) return '';
    if (u === 'WARNING') return 'WARN';
    return u;
  }

  function levelToFilterTerm(levelCanonical) {
    const u = String(levelCanonical || '').trim().toUpperCase();
    if (!u) return '';
    if (u === 'WARN') return 'warn';
    return u.toLowerCase();
  }

  function wrapClickableLevelBadges(htmlEscaped) {
    // Input must be HTML-escaped and contain no tags yet.
    // We wrap raw level tokens so resulting filter terms remain
    // compatible with server-side substring matching (services/log_filter.py).
    if (!htmlEscaped) return '';
    const s = String(htmlEscaped);
    if (s.search(CLICKABLE_LEVELS_RE) === -1) return s;
    CLICKABLE_LEVELS_RE.lastIndex = 0;

    return s.replace(CLICKABLE_LEVELS_RE, (m, pfx, lvl) => {
      const canon = normalizeClickableLevel(lvl);
      if (!canon) return m;

      const cls =
        canon === 'INFO'
          ? 'log-lvl log-lvl-info'
          : canon === 'DEBUG'
          ? 'log-lvl log-lvl-debug'
          : canon === 'WARN'
          ? 'log-lvl log-lvl-warning'
          : canon === 'ERROR'
          ? 'log-lvl log-lvl-error'
          : canon === 'FATAL'
          ? 'log-lvl log-lvl-error'
          : 'log-lvl';

      const title = 'Клик: фильтр по уровню (повторный клик — убрать уровень из фильтра)';
      return (
        String(pfx || '') +
        '<span class="xk-log-level ' +
        cls +
        '" data-level="' +
        canon +
        '" title="' +
        title +
        '">' +
        String(lvl || '').toUpperCase() +
        '</span>'
      );
    });
  }

  function buildFilterWithLevel(rawFilter, levelCanonical) {
    const clicked = levelToFilterTerm(levelCanonical);
    if (!clicked) return String(rawFilter || '').trim();

    const raw = String(rawFilter || '').trim();
    if (!raw) return clicked;

    const isLevelTerm = (t) => {
      const x = String(t || '').trim().toLowerCase();
      return x === 'debug' || x === 'info' || x === 'warn' || x === 'warning' || x === 'error' || x === 'fatal';
    };
    const isClickedTerm = (t) => {
      const x = String(t || '').trim().toLowerCase();
      if (!x) return false;
      if (clicked === 'warn') return x === 'warn' || x === 'warning';
      return x === clicked;
    };

    // Preserve OR groups ("|") if user already uses them.
    const hadPipe = raw.includes('|');
    const groups = raw.split('|').map((g) => g.trim());
    const nextGroups = [];

    for (const g of groups) {
      if (!g) continue;
      const terms = g.split(/\s+/).map((t) => t.trim()).filter(Boolean);
      const hasClicked = terms.some(isClickedTerm);
      const hasAnyLevel = terms.some(isLevelTerm);

      let out = terms.filter((t) => !isLevelTerm(t));

      if (hasClicked) {
        // Toggle off: remove any level terms from this group.
      } else {
        // Replace existing level term(s) with clicked, or add clicked in front.
        out.unshift(clicked);
      }

      // De-dupe repeated clicked tokens inside a group.
      const dedup = [];
      for (const t of out) {
        if (
          dedup.length &&
          String(dedup[dedup.length - 1]).toLowerCase() === String(t).toLowerCase() &&
          isClickedTerm(t)
        ) {
          continue;
        }
        dedup.push(t);
      }

      if (dedup.length) nextGroups.push(dedup.join(' '));
    }

    if (!nextGroups.length) return '';
    return hadPipe ? nextGroups.join(' | ') : nextGroups[0];
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

    // Clickable level badges (INFO/WARN/ERROR/etc.)
    processed = wrapClickableLevelBadges(processed);

    // Timestamp highlight (common Xray format: YYYY/MM/DD HH:MM:SS(.ms) or YYYY-MM-DD ...)
    processed = processed.replace(/^(\d{4}[\/-]\d{2}[\/-]\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)/, '<span class="log-ts">$1</span>');

    

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



    // Optional: render ANSI colors from logs (SGR) into HTML spans.
    // Feature is disabled by default (see /api/ui-settings -> logs.ansi).
    if (_ansiEnabled) {
      try { processed = ansiSgrToHtml(processed); } catch (e) {}
    }

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

  // Filter syntax is server-compatible (services/log_filter.py):
  //   - whitespace = AND
  //   - '|' = OR between groups
  const groups = rawFilter
    .split('|')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) =>
      g
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );

  const src = Array.isArray(_lastLines) ? _lastLines : [];
  let entries = src.map((line, idx) => ({ idx, line: normalizeLogLine(line) }));

  if (levelFilter) {
    entries = entries.filter((e) => shouldKeepLineForLevel(e.line, levelFilter));
  }

  const filtered = groups.length
    ? entries.filter((e) => {
        const lower = String(e.line || '').toLowerCase();
        return groups.some((terms) => terms.every((t) => lower.includes(t)));
      })
    : entries;

  const wasAtBottom = outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 5;
  const shouldScroll = _follow ? true : wasAtBottom;

  // Each line is rendered as a block-level <span>. Extra line breaks create empty rows in <pre>.
  outputEl.innerHTML = filtered.map((e) => parseXrayLogLine(e.line, e.idx)).join('');
  if (shouldScroll) outputEl.scrollTop = outputEl.scrollHeight;
  updateXrayLogStats();
}

  function applyXrayLogFilterToOutput() {
    const dom = getXrayLogsDom();
    if (!dom.output) return;

    const runtime = readXrayLogsRuntimeState();
    const view = readXrayLogsViewState(dom, runtime);
    renderXrayLogOutputLayer(dom, runtime, view);
    updateXrayLogStats();
  }

  // ---------- Data sources: HTTP + WebSocket ----------

  function _isWs2Socket(ws) {
    try {
      return !!(ws && ws.__xkProto === 'ws2');
    } catch (e) {
      return false;
    }
  }

  function _shouldUseWs2() {
    return !!(_ws2Enabled && !_ws2FailedSession);
  }

  function _ws2SendOrQueue(payload) {
    // Best-effort send. If WS2 is still CONNECTING, keep only the last pending cmd.
    try {
      if (!_ws || !_isWs2Socket(_ws) || typeof WebSocket === 'undefined') {
        _ws2PendingCmd = payload || null;
        return false;
      }
      if (_ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify(payload));
        return true;
      }
      // CONNECTING / CLOSING: queue
      _ws2PendingCmd = payload || null;
      return false;
    } catch (e) {
      _ws2PendingCmd = payload || null;
      return false;
    }
  }

  async function fetchXrayLogsOnce(source = 'manual', opts = {}) {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    if (String(source || '').toLowerCase() === 'poll' && _httpFetchInFlight) return;
    _httpFetchInFlight = true;

    const statusEl = $('xray-log-status');
    const file = _currentFile || 'access';
    const fileLabel = formatXrayLogFileLabel(file);

    const resetCursor = !!(opts && opts.resetCursor);
    const forceRender = !!(opts && opts.forceRender);

    const cur = resetCursor ? '' : (_cursor || '');

    if (source === 'manual' || source === 'enable' || source === 'load_more' || source === 'fallback_ws') {
      setXrayLogUiStatus({
        phase: source === 'fallback_ws' ? 'fallback' : 'loading',
        tone: source === 'fallback_ws' ? 'warning' : 'muted',
        transport: source === 'fallback_ws' ? ('HTTP/' + formatXrayLogPollLabel(_pollMs)) : readXrayLogTransportLabel(),
        message: source === 'enable'
          ? ('Запрашиваю первый снимок ' + fileLabel + ' после включения логов...')
          : (source === 'load_more'
            ? ('Подгружаю более ранние строки из ' + fileLabel + '...')
            : (source === 'fallback_ws'
              ? 'WebSocket недоступен, переключаюсь на HTTP snapshot и polling.'
              : ('Запрашиваю снимок ' + fileLabel + '...'))),
        file,
      });
    }

    try {
      const params = new URLSearchParams();
      params.set('file', file);
      params.set('max_lines', String(_maxLines || DEFAULT_MAX_LINES));
      params.set('source', String(source || 'manual'));
      if (cur) params.set('cursor', cur);

      const res = await fetch('/api/xray-logs?' + params.toString());
      if (!res.ok) {
        setXrayLogUiStatus({
          phase: 'error',
          tone: 'error',
          transport: readXrayLogTransportLabel(),
          message: 'Не удалось загрузить логи Xray.',
          file,
        });
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
          appendXrayLogBuffer(lines);
          reconcileXrayLogBufferRender({
            added: lines.length,
            deferWhilePaused: source === 'poll',
            forceRender,
          });
        } else {
          reconcileXrayLogBufferRender({ skipRender: true });
        }
      } else {
        replaceXrayLogBuffer(lines);
        reconcileXrayLogBufferRender({
          added: 0,
          deferWhilePaused: source === 'poll',
          forceRender,
        });
      }

      if (statusEl) statusEl.textContent = '';
      setXrayLogUiStatus({
        phase: _streaming ? 'streaming' : 'ready',
        tone: 'muted',
        transport: readXrayLogTransportLabel(),
        message: source === 'manual'
          ? (lines.length ? ('Снимок ' + fileLabel + ' загружен.') : (fileLabel + ' пока пуст.'))
          : '',
        file,
      });
      refreshXrayLogStatus();
    } catch (e) {
      console.error(e);
      if (statusEl) statusEl.textContent = 'Ошибка чтения логов Xray.';
      setXrayLogUiStatus({
        phase: 'error',
        tone: 'error',
        transport: readXrayLogTransportLabel(),
        message: 'Ошибка чтения логов Xray.',
        file,
      });
    } finally {
      _httpFetchInFlight = false;
    }
  }

  function xrayLogConnectWs2() {
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
    const filterEl = $('xray-log-filter');
    const filter = String((filterEl && filterEl.value) || '').trim();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    const params = new URLSearchParams();
    params.set('file', file);
    params.set('max_lines', String(_maxLines || DEFAULT_MAX_LINES));
    if (filter) params.set('filter', filter);

    const url = proto + '//' + host + '/ws/xray-logs2?' + params.toString();

    wsDebug('WS2: connecting', { url: url, file: file, filter: !!filter });
    setXrayLogUiStatus({
      phase: 'connecting',
      tone: 'muted',
      transport: 'WS2 connect',
      message: 'Подключаю WS2 live stream для ' + formatXrayLogFileLabel(file) + '...',
      file,
    });

    let ws = null;
    try {
      _wsClosingManually = false;
      _wsEverOpened = false;
      ws = new WebSocket(url);
      ws.__xkProto = 'ws2';
      _ws = ws;
    } catch (e) {
      console.error('Failed to create WebSocket2 for logs', e);
      _ws2FailedSession = true;
      setXrayLogUiStatus({
        phase: 'fallback',
        tone: 'warning',
        transport: 'WS fallback',
        message: 'Не удалось создать WS2, переключаюсь на legacy transport.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Не удалось создать WebSocket2, использую старый режим.';
      // fallback to legacy connect (or HTTP in legacy handler)
      try { xrayLogConnectWs(); } catch (e2) {}
      return;
    }

    ws.onopen = function () {
      if (ws !== _ws) return;
      wsDebug('WS2: open', { file: file });
      _wsEverOpened = true;
      _ws2FailStreak = 0;
      _ws2LastOpenAt = Date.now();
      setXrayLogUiStatus({
        phase: 'streaming',
        tone: 'muted',
        transport: 'WS2 live',
        message: 'WS2 подключен. Жду новые строки...',
        file,
      });

      // Disable HTTP polling while WS is active
      if (_timer) {
        try { clearInterval(_timer); } catch (e) {}
        _timer = null;
      }

      if (statusEl) statusEl.textContent = 'WebSocket2 для логов подключён.';
      try { updateXrayLogStats(); } catch (e) {}

      // Flush pending command (switch/clear) if any
      if (_ws2PendingCmd) {
        try { ws.send(JSON.stringify(_ws2PendingCmd)); } catch (e2) {}
        _ws2PendingCmd = null;
      }
    };

    ws.onmessage = function (event) {
      if (ws !== _ws) return;
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('Invalid WebSocket2 payload for xray logs', e);
        return;
      }

      let added = 0;

      if (data && data.type === 'init' && Array.isArray(data.lines)) {
        replaceXrayLogBuffer(data.lines);
      } else if (data && data.type === 'append' && Array.isArray(data.lines)) {
        appendXrayLogBuffer(data.lines);
        added = data.lines.length;
      } else if (data && data.type === 'status') {
        // status/meta update only
        setXrayLogUiStatus({
          phase: 'streaming',
          tone: 'muted',
          transport: 'WS2 live',
          message: '',
          file,
        });
        try { updateXrayLogStats(); } catch (e) {}
        return;
      } else if (data && data.type === 'error') {
        const err = String(data.error || '').trim();
        setXrayLogUiStatus({
          phase: 'error',
          tone: 'error',
          transport: 'WS2 live',
          message: err ? ('WS2: ' + err) : 'WS2: ошибка.',
          file,
        });
        if (statusEl) statusEl.textContent = err ? ('WS2: ' + err) : 'WS2: ошибка.';
        try { updateXrayLogStats(); } catch (e) {}
        return;
      } else if (Array.isArray(data.lines)) {
        replaceXrayLogBuffer(data.lines);
      } else if (data && typeof data.line === 'string') {
        appendXrayLogBuffer([data.line]);
        added = 1;
      }

      reconcileXrayLogBufferRender({
        added,
        deferWhilePaused: true,
      });
    };

    ws.onclose = function (ev) {
      if (ws !== _ws) return;
      const visible = isLogsViewVisible();

      const code = (ev && typeof ev.code === 'number') ? ev.code : 0;
      const reason = (ev && typeof ev.reason === 'string') ? ev.reason : '';
      const dt = _ws2LastOpenAt ? (Date.now() - _ws2LastOpenAt) : 99999;
      if (_wsEverOpened && dt < 1200) _ws2FailStreak = (_ws2FailStreak || 0) + 1;
      else if (dt >= 1200) _ws2FailStreak = 0;

      wsDebug('WS2: close', { file: file, manual: _wsClosingManually, everOpened: _wsEverOpened, code: code, reason: reason, dt: dt, streak: _ws2FailStreak });

      _ws = null;
      try { updateXrayLogStats(); } catch (e) {}

      if (_wsClosingManually || !visible) {
        setXrayLogUiStatus({
          phase: 'idle',
          tone: 'muted',
          transport: '',
          message: 'WS2 live stream остановлен.',
          file,
        });
        if (statusEl) statusEl.textContent = 'WebSocket2 для логов закрыт.';
        return;
      }

      // never opened -> WS2 not supported / not available
      if (!_wsEverOpened) {
        _ws2FailedSession = true;
        setXrayLogUiStatus({
          phase: 'fallback',
          tone: 'warning',
          transport: 'WS fallback',
          message: 'WS2 недоступен, переключаюсь на legacy transport.',
          file,
        });
        if (statusEl) statusEl.textContent = 'WebSocket2 недоступен, использую старый режим.';
        // fallback to legacy connect (or HTTP inside legacy handler)
        setTimeout(() => {
          const stillVisible = isLogsViewVisible();
          if (!_ws && _useWs && stillVisible && _streaming) {
            try { xrayLogConnectWs(); } catch (e2) {}
          }
        }, 0);
        return;
      }

      if (_ws2FailStreak >= 3) {
        _ws2FailedSession = true;
        setXrayLogUiStatus({
          phase: 'fallback',
          tone: 'warning',
          transport: 'WS fallback',
          message: 'WS2 нестабилен (code ' + String(code || '?') + '), переключаюсь на legacy transport.',
          file,
        });
        if (statusEl) statusEl.textContent = 'WebSocket2 нестабилен (code ' + String(code || '?') + '), использую старый режим.';
        setTimeout(() => {
          const stillVisible = isLogsViewVisible();
          if (!_ws && _useWs && stillVisible && _streaming) {
            try { xrayLogConnectWs(); } catch (e2) {}
          }
        }, 0);
        return;
      }

      if (statusEl) statusEl.textContent = 'WebSocket2 разорван (code ' + String(code || '?') + '), пытаюсь переподключиться...';

      setTimeout(() => {
        const stillVisible = isLogsViewVisible();
        setXrayLogUiStatus({
          phase: 'reconnecting',
          tone: 'warning',
          transport: 'WS2 retry',
          message: 'WS2 разорван (code ' + String(code || '?') + '), пытаюсь переподключиться...',
          file,
        });
        if (!_ws && _useWs && stillVisible && _streaming && _shouldUseWs2()) xrayLogConnectWs2();
        // If WS2 is disabled mid-session or failed, legacy will be used by start().
      }, 1000);
    };

    ws.onerror = function () {
      if (ws !== _ws) return;
      wsDebug('WS2: error', { file: file });
      console.warn('WebSocket2 error in xray logs');
    };
  }

  function xrayLogConnectWsSmart() {
    if (_shouldUseWs2()) return xrayLogConnectWs2();
    return xrayLogConnectWs();
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
    setXrayLogUiStatus({
      phase: 'connecting',
      tone: 'muted',
      transport: 'WS connect',
      message: 'Подключаю WebSocket live stream для ' + formatXrayLogFileLabel(file) + '...',
      file,
    });

    let ws = null;

    try {
      _wsClosingManually = false;
      _wsEverOpened = false;
      ws = new WebSocket(url);
      _ws = ws;
    } catch (e) {
      console.error('Failed to create WebSocket for logs', e);
      _useWs = false;
      setXrayLogUiStatus({
        phase: 'fallback',
        tone: 'warning',
        transport: 'HTTP/' + formatXrayLogPollLabel(_pollMs),
        message: 'Не удалось создать WebSocket, переключаюсь на HTTP polling.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Не удалось создать WebSocket, использую HTTP.';
      return;
    }

    ws.onopen = function () {
      if (ws !== _ws) return;
      wsDebug('WS: open', { file: file });
      _wsEverOpened = true;
      setXrayLogUiStatus({
        phase: 'streaming',
        tone: 'muted',
        transport: 'WS live',
        message: 'WebSocket подключен. Жду новые строки...',
        file,
      });

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
        replaceXrayLogBuffer(data.lines);
      } else if (data && data.type === 'append' && Array.isArray(data.lines)) {
        // Future-proof: batch append
        appendXrayLogBuffer(data.lines);
        added = data.lines.length;
      } else if (data && data.type === 'line' && typeof data.line === 'string') {
        appendXrayLogBuffer([data.line]);
        added = 1;
      } else if (Array.isArray(data.lines)) {
        // Unknown payload shape: assume full snapshot
        replaceXrayLogBuffer(data.lines);
      } else if (data && typeof data.line === 'string') {
        // Unknown payload shape: single line
        appendXrayLogBuffer([data.line]);
        added = 1;
      }

      reconcileXrayLogBufferRender({
        added,
        deferWhilePaused: true,
      });
    };

    ws.onclose = function () {
      if (ws !== _ws) return;
      const visible = isLogsViewVisible();

      wsDebug('WS: close', { file: file, manual: _wsClosingManually, everOpened: _wsEverOpened });

      _ws = null;
      try { updateXrayLogStats(); } catch (e) {}

      // closed by us (tab switch/file change/stop) or view hidden
      if (_wsClosingManually || !visible) {
        setXrayLogUiStatus({
          phase: 'idle',
          tone: 'muted',
          transport: '',
          message: 'WebSocket live stream остановлен.',
          file,
        });
        if (statusEl) statusEl.textContent = 'WebSocket для логов закрыт.';
        return;
      }

      // never opened -> WS not supported
      if (!_wsEverOpened) {
        _useWs = false;
        setXrayLogUiStatus({
          phase: 'fallback',
          tone: 'warning',
          transport: 'HTTP/' + formatXrayLogPollLabel(_pollMs),
          message: 'WebSocket недоступен, переключаюсь на HTTP polling.',
          file,
        });
        if (statusEl) statusEl.textContent = 'WebSocket недоступен, использую HTTP.';
        if (!_timer) {
          fetchXrayLogsOnce('fallback_ws', { resetCursor: true, forceRender: true });
          _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
        }
        return;
      }

      // was working -> reconnect, without enabling HTTP (avoid dupes)
      setXrayLogUiStatus({
        phase: 'reconnecting',
        tone: 'warning',
        transport: 'WS retry',
        message: 'WebSocket разорван, пытаюсь переподключиться...',
        file,
      });
      if (statusEl) statusEl.textContent = 'WebSocket для логов разорван, пытаюсь переподключиться...';

      setTimeout(() => {
        const stillVisible = isLogsViewVisible();
        if (!_ws && _useWs && stillVisible && _streaming) xrayLogConnectWsSmart();
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

  async function startXrayLogAuto() {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    // Load + apply server-side UI prefs only when the user enables the logs stream.
    // (includes one-time migration from legacy localStorage)
    try { await ensureLogsViewPrefsLoadedForLogs(); } catch (e) {}

    _liveWanted = true;
    _streaming = true;
    _paused = false;
    _pendingCount = 0;
    try { updatePauseButton(); } catch (e) {}

    // UI: этот индикатор показывает только автообновление (stream), а не loglevel.
    setXrayLogLampState('on');
    try { setXrayHeaderBadgeState((_activeLogLevel && _activeLogLevel !== 'none') ? 'on' : 'off', _activeLogLevel || 'none'); } catch (e) {}

    // Sync UI toggle
    try {
      const liveEl = $('xray-log-live');
      if (liveEl) liveEl.checked = true;
    } catch (e) {}
    setXrayLogUiStatus({
      phase: 'connecting',
      tone: 'muted',
      transport: (_useWs && 'WebSocket' in window)
        ? (_shouldUseWs2() ? 'WS2 connect' : 'WS connect')
        : ('HTTP/' + formatXrayLogPollLabel(_pollMs)),
      message: (_useWs && 'WebSocket' in window)
        ? ('Поднимаю live stream для ' + formatXrayLogFileLabel(_currentFile || 'access') + '...')
        : ('Запускаю HTTP polling для ' + formatXrayLogFileLabel(_currentFile || 'access') + '...'),
      file: _currentFile || 'access',
    });
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
      xrayLogConnectWsSmart();
      return;
    }

    if (_timer) return;
    await fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
    setXrayLogUiStatus({
      phase: 'streaming',
      tone: 'muted',
      transport: 'HTTP/' + formatXrayLogPollLabel(_pollMs),
      message: 'Live stream идет через HTTP polling каждые ' + formatXrayLogPollLabel(_pollMs) + '.',
      file: _currentFile || 'access',
    });
    _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
  }

  function stopXrayLogAuto() {
    // UI: автообновление остановлено
    _streaming = false;
    _paused = false;
    _pendingCount = 0;
    try { updatePauseButton(); } catch (e) {}
    setXrayLogLampState('off');
    try { setXrayHeaderBadgeState((_activeLogLevel && _activeLogLevel !== 'none') ? 'on' : 'off', _activeLogLevel || 'none'); } catch (e) {}

    // IMPORTANT: do NOT force-toggle the "Live" checkbox here.
    // The checkbox is treated as a user preference and is persisted via /api/ui-settings
    // (with a legacy localStorage fallback when the settings endpoint is unavailable).
    setXrayLogUiStatus({
      phase: 'idle',
      tone: 'muted',
      transport: '',
      message: 'Live stream остановлен.',
      file: _currentFile || 'access',
    });
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

  async function xrayLogsView() {
    try { await ensureLogsViewPrefsLoadedForLogs(); } catch (e) {}
    setXrayLogUiStatus({
      phase: 'loading',
      tone: 'muted',
      transport: '',
      message: 'Запрашиваю снимок ' + formatXrayLogFileLabel(_currentFile || 'access') + '...',
      file: _currentFile || 'access',
    });
    await fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
  }

  function xrayLogsClearScreen() {
    const outputEl = $('xray-log-output');
    if (outputEl) outputEl.innerHTML = '';
    resetXrayLogBuffer();

    // WS2: also reset server-side cursor (so it doesn't re-send buffered tail on resume).
    try {
      if (_streaming && _shouldUseWs2()) {
        _ws2SendOrQueue({ cmd: 'clear' });
        if (!_ws) xrayLogConnectWs2();
      }
    } catch (e) {}
  }

  async function xrayLogChangeFile() {
    const selectEl = $('xray-log-file');
    if (selectEl) _currentFile = selectEl.value || 'access';
    setXrayLogUiStatus({
      phase: 'switching',
      tone: 'muted',
      transport: readXrayLogTransportLabel(),
      message: 'Переключаюсь на ' + formatXrayLogFileLabel(_currentFile || 'access') + '...',
      file: _currentFile || 'access',
    });
    updateLoglevelUiForCurrentFile();
    try { scheduleSaveUiState(); } catch (e) {}

    // clear buffer + redraw
    resetXrayLogBuffer();
    applyXrayLogFilterToOutput();

    // Load server-side UI prefs only when the logs view is actively used.
    try { await ensureUiSettingsLoadedForLogs(); } catch (e) {}
    // If streaming is enabled and WS in use:
    // - WS2: switch file without reconnect
    // - legacy: reconnect for the new file (avoid HTTP dupes)
    if (_streaming && _useWs && 'WebSocket' in window) {
      if (_shouldUseWs2()) {
        const filterEl = $('xray-log-filter');
        const filter = String((filterEl && filterEl.value) || '').trim();
        const cmd = { cmd: 'switch', file: String(_currentFile || 'access'), filter: filter, max_lines: (_maxLines || DEFAULT_MAX_LINES) };

        // Stop HTTP polling while WS2 is expected to be used.
        if (_timer) {
          try { clearInterval(_timer); } catch (e) {}
          _timer = null;
        }

        // If WS2 is already connected/connecting -> just send or queue the command.
        if (_ws && _isWs2Socket(_ws)) {
          _ws2SendOrQueue(cmd);
          return;
        }

        // If no WS or we are not on WS2 yet, queue the desired state and connect WS2.
        _ws2PendingCmd = cmd;
        xrayLogConnectWs2();
        return;
      }

      // legacy WS: reconnect to apply new file
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
      xrayLogConnectWsSmart();
      return;
    }

    await fetchXrayLogsOnce('manual', { resetCursor: true, forceRender: true });
  }

  async function xrayLogsEnable() {
    const statusEl = $('xray-log-status');
    setXrayLogUiStatus({
      phase: 'loading',
      tone: 'muted',
      transport: '',
      message: 'Включаю логи Xray...',
      file: _currentFile || 'access',
    });
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
      setXrayLogUiStatus({
        phase: 'ready',
        tone: 'muted',
        transport: '',
        message: 'Логи включены (loglevel=' + (data.loglevel || 'warning') + '). Xray перезапущен.',
        file: _currentFile || 'access',
      });

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

      const wantStream = !!_liveWanted;
      const visible = isLogsViewVisible();

      if (visible) {
        // Show current file content once.
        // When WS2 + Live is enabled, avoid the extra HTTP snapshot request:
        // WS2 will send an init snapshot immediately after reconnect/switch.
        if (!(wantStream && _useWs && 'WebSocket' in window && _shouldUseWs2())) {
          fetchXrayLogsOnce('enable', { resetCursor: true, forceRender: true });
        }
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
    setXrayLogUiStatus({
      phase: 'loading',
      tone: 'muted',
      transport: '',
      message: 'Останавливаю логи Xray...',
      file: _currentFile || 'access',
    });
    try {
      const res = await fetch('/api/xray-logs/disable', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);
      setXrayLogUiStatus({
        phase: 'ready',
        tone: 'muted',
        transport: '',
        message: 'Логи остановлены (loglevel=none). Xray перезапущен.',
        file: _currentFile || 'access',
      });

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
    const file = _currentFile || 'access';
    const ok = await confirmAction({
      title: 'Очистить логфайлы',
      message: 'Очистить ' + formatXrayLogFileLabel(file) + '?',
      details: [
        'Будет очищен файл логов на диске, а не только видимый буфер.',
        'Это действие необратимо.',
      ],
      okText: 'Очистить',
      cancelText: 'Отменить',
      focus: 'cancel',
      danger: true,
      cancelMessage: 'Очистка логфайлов отменена.',
      cancelKind: 'info',
    });
    if (!ok) {
      setXrayLogUiStatus({
        phase: 'idle',
        tone: 'muted',
        transport: readXrayLogTransportLabel(),
        message: 'Очистка логфайлов отменена.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Очистка логфайлов отменена.';
      return false;
    }

    setXrayLogUiStatus({
      phase: 'loading',
      tone: 'muted',
      transport: '',
      message: 'Очищаю log files...',
      file,
    });
    try {
      const res = await fetch('/api/xray-logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) throw new Error('http ' + res.status);

      resetXrayLogBuffer();
      applyXrayLogFilterToOutput();
      setXrayLogUiStatus({
        phase: 'ready',
        tone: 'muted',
        transport: '',
        message: 'Логфайлы очищены.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Логфайлы очищены.';
      actionToast('xray-logs-clear', 'Логфайлы очищены.', 'success');
      return true;
    } catch (e) {
      console.error(e);
      setXrayLogUiStatus({
        phase: 'error',
        tone: 'error',
        transport: readXrayLogTransportLabel(),
        message: 'Не удалось очистить логфайлы.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Не удалось очистить логфайлы.';
      actionToast('xray-logs-clear', 'Не удалось очистить логфайлы.', 'error');
      return false;
    }
  }

  function xrayLogsCopy() {
    const outputEl = $('xray-log-output');
    if (!outputEl) return;

    const text = outputEl.textContent || '';
    if (!text) return;

    copyToClipboard(text, 'Логи Xray скопированы в буфер обмена');
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

function updatePauseButton() {
  const dom = getXrayLogsDom();
  const runtime = readXrayLogsRuntimeState();
  renderXrayLogsChrome(dom, runtime);
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
      () => actionToast('xray-logs-copy', msg, 'success'),
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
        try { flushXrayLogFilterApply('token_shift_click'); } catch (e2) {}
        actionToast('xray-logs-filter', kindLabel + ' добавлен в фильтр', 'success');
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
      actionToast('xray-logs-copy', 'Нет выделенного текста', 'error');
      return;
    }
    copyToClipboard(text, 'Выделение скопировано');
  } catch (e) {
    actionToast('xray-logs-copy', 'Не удалось скопировать выделение', 'error');
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
    actionToast('xray-logs-download', 'Не удалось скачать лог', 'error');
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
  try {
    openXkeenModal(modal, 'xray_logs_context', true);
  } catch (e) {}
}

function closeXrayContextModal() {
  const modal = $('xray-context-modal');
  if (!modal) return;
  try {
    closeXkeenModal(modal, 'xray_logs_context', false);
  } catch (e) {}
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
	  const viewBtn = $('xray-log-view-btn');
	  const enableBtn = $('xray-log-enable-btn');
	  const disableBtn = $('xray-log-disable-btn');
	  const clearScreenBtn = $('xray-log-clear-screen-btn');
	  const clearFilesBtn = $('xray-log-clear-files-btn');
	  const copyBtn = $('xray-log-copy-btn');

	  const pauseBtn = $('xray-log-pause');
	  const linesInput = $('xray-log-lines');
	  const copySelBtn = $('xray-log-copy-selection');
	  const dlBtn = $('xray-log-download');
	  const outputEl = $('xray-log-output');
	  const scrollBottomBtn = $('xray-log-scroll-bottom');

	  if (viewBtn) {
	    viewBtn.addEventListener('click', (e) => {
	      e.preventDefault();
	      void xrayLogsView();
	    });
	  }

	  if (enableBtn) {
	    enableBtn.addEventListener('click', (e) => {
	      e.preventDefault();
	      void xrayLogsEnable();
	    });
	  }

	  if (disableBtn) {
	    disableBtn.addEventListener('click', (e) => {
	      e.preventDefault();
	      void xrayLogsDisable();
	    });
	  }

	  if (clearScreenBtn) {
	    clearScreenBtn.addEventListener('click', (e) => {
	      e.preventDefault();
	      xrayLogsClearScreen();
	    });
	  }

	  if (clearFilesBtn) {
	    clearFilesBtn.addEventListener('click', (e) => {
	      e.preventDefault();
	      void xrayLogsClear();
	    });
	  }

	  if (copyBtn) {
	    copyBtn.addEventListener('click', (e) => {
	      e.preventDefault();
	      xrayLogsCopy();
	    });
	  }

	  if (liveEl) {
	    _liveWanted = !!liveEl.checked;
	    liveEl.addEventListener('change', () => {
	      setXrayLogsLiveWanted(!!liveEl.checked, { skipRender: true });
	      if (liveEl.checked) startXrayLogAuto();
	      else stopXrayLogAuto();
      try { updateXrayLogStats(); } catch (e) {}
      try { scheduleSaveUiState(); } catch (e) {}
    });
	  }

	  if (fileSel) {
	    fileSel.addEventListener('change', () => {
	      void xrayLogChangeFile();
	    });
	  }
	  if (lvlSel) {
	    lvlSel.addEventListener('change', () => {
	      try { scheduleSaveUiState(); } catch (e) {}
	      // Re-apply view filters immediately when the threshold changes.
	      try { flushXrayLogFilterApply('loglevel_change', { skipSave: true, skipWs2: true }); } catch (e) {}

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
          setXrayLogUiStatus({
            phase: 'switching',
            tone: 'muted',
            transport: '',
            message: 'Применяю loglevel=' + desired + '...',
            file: _currentFile || 'access',
          });
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
    setXrayLogsFollowEnabled(!!followEl.checked, { skipRender: true, skipScroll: true });
    followEl.addEventListener('change', () => {
      setXrayLogsFollowEnabled(!!followEl.checked, { skipRender: true });
      try { updateXrayLogStats(); } catch (e) {}
      try { scheduleSaveUiState(); } catch (e) {}
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      xrayLogsTogglePause();
    });
  }

  if (scrollBottomBtn) {
    scrollBottomBtn.addEventListener('click', (e) => {
      e.preventDefault();
      scrollXrayLogOutputToBottom();
      try { updateXrayLogStats(); } catch (e2) {}
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

        // If WS is active — legacy: reconnect; WS2: switch max_lines without reconnect.
        const wsActive =
          _ws && typeof WebSocket !== 'undefined' &&
          (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING);

        if (_streaming && wsActive && _isWs2Socket(_ws) && _shouldUseWs2()) {
          _ws2SendOrQueue({ cmd: 'switch', file: String(_currentFile || 'access'), filter: String(($('xray-log-filter') && $('xray-log-filter').value) || '').trim(), max_lines: (_maxLines || DEFAULT_MAX_LINES) });
        } else if (_streaming && wsActive) {
          try {
            _wsClosingManually = true;
            _ws.close();
          } catch (e3) {}
          _ws = null;
          try { updateXrayLogStats(); } catch (e4) {}
          xrayLogConnectWsSmart();
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

      // If WS is active — legacy: reconnect; WS2: switch max_lines without reconnect.
      const wsActive =
        _ws && typeof WebSocket !== 'undefined' &&
        (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING);

      if (_streaming && wsActive && _isWs2Socket(_ws) && _shouldUseWs2()) {
        _ws2SendOrQueue({ cmd: 'switch', file: String(_currentFile || 'access'), filter: String(($('xray-log-filter') && $('xray-log-filter').value) || '').trim(), max_lines: (_maxLines || DEFAULT_MAX_LINES) });
      } else if (_streaming && wsActive) {
        try {
          _wsClosingManually = true;
          _ws.close();
        } catch (e2) {}
        _ws = null;
        try { updateXrayLogStats(); } catch (e) {}
        xrayLogConnectWsSmart();
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
    if (!outputEl.dataset.scrollBound) {
      outputEl.dataset.scrollBound = '1';
      outputEl.addEventListener('scroll', () => {
        scheduleXrayLogsChromeRender();
      }, { passive: true });
    }

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

      // Clickable log levels: click -> add/replace level term in filter; click again -> toggle off
      const lvlEl = t && t.closest ? t.closest('.xk-log-level') : null;
      if (lvlEl && outputEl.contains(lvlEl) && !e.altKey) {
        // Don't break selection/copy: ignore clicks when user is selecting text.
        try {
          const sel = window.getSelection ? window.getSelection() : null;
          if (sel && !sel.isCollapsed) return;
        } catch (eSel) {}

        const lvl = String(lvlEl.getAttribute('data-level') || lvlEl.textContent || '').trim().toUpperCase();
        if (lvl) {
          const filterEl = $('xray-log-filter');
          if (filterEl) {
            const next = buildFilterWithLevel(filterEl.value || '', lvl);
            if (next !== String(filterEl.value || '')) filterEl.value = next;
            flushXrayLogFilterApply('level_click');
            return;
          }
        }
      }

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

    function scheduleWs2SwitchFromUi(reason) {
    if (!_streaming) return;
    if (!_shouldUseWs2()) return;
    if (!_useWs || !('WebSocket' in window)) return;

    // Only when WS2 is the active transport (or not connected yet).
    if (_ws && !_isWs2Socket(_ws)) return;

    if (_ws2SwitchTimer) {
      try { clearTimeout(_ws2SwitchTimer); } catch (e) {}
      _ws2SwitchTimer = null;
    }

    _ws2SwitchTimer = setTimeout(() => {
      _ws2SwitchTimer = null;
      const filterEl = $('xray-log-filter');
      const filter = String((filterEl && filterEl.value) || '').trim();
      const cmd = { cmd: 'switch', file: String(_currentFile || 'access'), filter: filter, max_lines: (_maxLines || DEFAULT_MAX_LINES) };
      _ws2SendOrQueue(cmd);
      // Ensure WS2 is connected (if it was closed).
      if (!_ws) {
        _ws2PendingCmd = cmd;
        xrayLogConnectWs2();
      }
    }, 180);
  }

  function flushXrayLogFilterApply(reason, options) {
    const opts = options || {};

    if (_filterApplyTimer) {
      try { clearTimeout(_filterApplyTimer); } catch (e) {}
      _filterApplyTimer = null;
    }

    applyXrayLogFilterToOutput();
    if (!opts.skipSave) {
      try { scheduleSaveUiState(); } catch (e) {}
    }
    if (!opts.skipWs2) {
      try { scheduleWs2SwitchFromUi(reason || 'filter'); } catch (e) {}
    }
  }

  function scheduleXrayLogFilterApply(reason, options) {
    const opts = options || {};

    if (opts.immediate) {
      flushXrayLogFilterApply(reason, opts);
      return;
    }

    if (_filterApplyTimer) {
      try { clearTimeout(_filterApplyTimer); } catch (e) {}
      _filterApplyTimer = null;
    }

    _filterApplyTimer = setTimeout(() => {
      _filterApplyTimer = null;
      flushXrayLogFilterApply(reason, opts);
    }, FILTER_APPLY_DEBOUNCE_MS);
  }

function bindFilterUi() {
    const filterEl = $('xray-log-filter');
    const clearBtn = $('xray-log-filter-clear');

    if (filterEl) {
      filterEl.addEventListener('input', () => {
        scheduleXrayLogFilterApply('filter');
      });
      filterEl.addEventListener('blur', () => {
        if (_filterApplyTimer) flushXrayLogFilterApply('filter_blur');
      });
      filterEl.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            flushXrayLogFilterApply('filter_enter');
            filterEl.blur();
          }
        },
        { passive: false }
      );
    }

    if (clearBtn && filterEl) {
      clearBtn.addEventListener('click', () => {
        filterEl.value = '';
        flushXrayLogFilterApply('filter_clear');
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
    try { setXrayHeaderBadgeState((_activeLogLevel && _activeLogLevel !== 'none') ? 'on' : 'off', _activeLogLevel || 'none'); } catch (e) {}

    // Restore UI preferences for this page (file/live/follow/interval/lines/filter/height)
    // BEFORE wiring listeners, so we don't accidentally trigger actions.
    try { applyInitialUiStateNoFetch(); } catch (e) {}

    // Sync current file from UI (after restore)
    try { syncCurrentFileFromUi(); } catch (e) {}

    try { bindControlsUi(); } catch (e) {}
    try { bindFilterUi(); } catch (e) {}
    try { _bindFullscreenUi(); } catch (e) {}

    // Context modal buttons
    try {
      const close1 = $('xray-context-close-btn');
      const close2 = $('xray-context-close-btn2');
      const copyBtn = $('xray-context-copy-btn');
      if (close1) close1.addEventListener('click', (e) => { e.preventDefault(); closeXrayContextModal(); });
      if (close2) close2.addEventListener('click', (e) => { e.preventDefault(); closeXrayContextModal(); });
      if (copyBtn) copyBtn.addEventListener('click', (e) => { e.preventDefault(); copyXrayContextModal(); });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        try { closeXrayContextModal(); } catch (e2) {}
        // If the Xray logs card is fullscreen — ESC also restores it.
        try { if (_isFullscreen) _setFullscreen(false); } catch (e3) {}
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

  xrayLogsModuleApi = api;

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
export function getXrayLogsApi() {
  try {
    return xrayLogsModuleApi && typeof xrayLogsModuleApi.init === 'function' ? xrayLogsModuleApi : null;
  } catch (error) {
    return null;
  }
}

function callXrayLogsApi(method, ...args) {
  const api = getXrayLogsApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initXrayLogs(...args) {
  return callXrayLogsApi('init', ...args);
}

export function startXrayLogsAuto(...args) {
  return callXrayLogsApi('start', ...args);
}

export function stopXrayLogsAuto(...args) {
  return callXrayLogsApi('stop', ...args);
}

export function viewXrayLogsOnce(...args) {
  return callXrayLogsApi('viewOnce', ...args);
}

export function clearXrayLogsScreen(...args) {
  return callXrayLogsApi('clearScreen', ...args);
}

export function changeXrayLogsFile(...args) {
  return callXrayLogsApi('changeFile', ...args);
}

export function enableXrayLogs(...args) {
  return callXrayLogsApi('enable', ...args);
}

export function disableXrayLogs(...args) {
  return callXrayLogsApi('disable', ...args);
}

export function clearXrayLogsFiles(...args) {
  return callXrayLogsApi('clearFiles', ...args);
}

export function copyXrayLogs(...args) {
  return callXrayLogsApi('copy', ...args);
}

export function refreshXrayLogsStatus(...args) {
  return callXrayLogsApi('refreshStatus', ...args);
}

export function applyXrayLogsFilter(...args) {
  return callXrayLogsApi('applyFilter', ...args);
}

export const xrayLogsApi = Object.freeze({
  get: getXrayLogsApi,
  init: initXrayLogs,
  start: startXrayLogsAuto,
  stop: stopXrayLogsAuto,
  viewOnce: viewXrayLogsOnce,
  clearScreen: clearXrayLogsScreen,
  changeFile: changeXrayLogsFile,
  enable: enableXrayLogs,
  disable: disableXrayLogs,
  clearFiles: clearXrayLogsFiles,
  copy: copyXrayLogs,
  refreshStatus: refreshXrayLogsStatus,
  applyFilter: applyXrayLogsFilter,
});
