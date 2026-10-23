import { shouldKeepXrayLogLineForLevel } from './xray_log_line_class.js';
import {
  collectXrayLogDestinationIpPorts,
  collectXrayLogDomainCandidates,
  extractXrayLogConnectionId,
  normalizeXrayLogDomain,
} from './xray_log_domain_hints.js';
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
import { iconHtml } from '../ui/operator_icons.js';
import { createXrayLogView } from './xray_log_view.js';

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
  const LOG_RENDER_DEBOUNCE_MS = isPerfLite() ? 180 : 80;
  const LOG_WINDOW_MIN_HEIGHT = 420;
  const XRAY_DEVICE_NAMES_API = '/api/xray-logs/devices';
  const XRAY_DEVICE_NAMES_REFRESH_MS = 60000;
  const XRAY_DEVICE_NAMES_STALE_MS = 30000;
  const XRAY_DESTINATION_DOMAIN_HINTS_POLL_MS = 2500;
  const XRAY_DESTINATION_DOMAIN_HINTS_INIT_LINES = isPerfLite() ? 2500 : 5000;
  const XRAY_DESTINATION_DOMAIN_CACHE_MAX = 500;
  const XRAY_DESTINATION_CONN_CACHE_MAX = isPerfLite() ? 1000 : 2000;
  // Кеш IP->домен сохраняется в localStorage, чтобы DNS-записи переживали
  // перезагрузку страницы (иначе при F5 модуль пересоздаётся с пустым кешем).
  const XRAY_DOMAIN_CACHE_STORAGE_KEY = 'xkeen.ui.xrayLogs.domainCache.v1';
  const XRAY_DOMAIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const XRAY_DOMAIN_CACHE_SAVE_DEBOUNCE_MS = 1000;
  // Переключатель отображения доменных имён рядом с IP — чистый display-флаг,
  // независимый от Live и от loglevel. Значение ключа оставлено старым ('domainsWanted')
  // для бесшовной миграции прежнего выбора пользователя.
  const XRAY_DOMAINS_DISPLAY_STORAGE_KEY = 'xkeen.ui.xrayLogs.domainsWanted.v1';
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
  // Table/stream output (xray_log_view.js). Lines are parsed once on arrival;
  // _decorStamp changes when device names, domain hints or node names change.
  let _view = null;
  let _decorStamp = 0;
  let _viewDecorStamp = -1;
  let _outboundNames = Object.create(null);
  let _outboundNamesAt = 0;
  let _outboundNamesInFlight = null;
  const XRAY_VIEW_EXTRAS_STORAGE_KEY = 'xkeen.ui.xrayLogs.viewExtras.v1';
  const OUTBOUND_NAMES_TTL_MS = 60 * 1000;
  let _httpFetchInFlight = false;

  let _ws = null;
  let _useWs = true;
  let _wsEverOpened = false;
  let _wsClosingManually = false;
  let _streaming = false; // live stream (auto-update) state

  const ALLOWED_LOGLEVELS = ['debug', 'info', 'warning', 'error'];

  let _activeLogLevel = 'none'; // last known active loglevel from /api/xray-logs/status
  let _applyLevelTimer = null;

  let _saveTimer = null;

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
  // Xray logs view prefs (file/filter/follow/maxLines/pollMs/height)
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
  let _xrayLogOutputRenderTimer = null;
  let _chromeRenderQueued = false;
  let _xrayLogUiStatusRenderQueued = false;
  let _xrayDeviceNamesLoaded = false;
  let _xrayDeviceNamesLastFetchAt = 0;
  let _xrayDeviceNamesRequest = null;
  let _xrayDeviceNamesRefreshTimer = null;
  let _xrayDeviceNamesByIp = Object.create(null);
  let _xrayDeviceNameEntries = [];
  let _xrayDestinationDomainsByIp = Object.create(null);
  let _xrayDestinationDomainsByConnId = Object.create(null);
  let _xrayDestinationDomainConnOrder = [];
  let _xrayDestinationDomainHintsRequest = null;
  let _xrayDestinationDomainHintsLastFetchAt = 0;
  let _xrayDomainHintsCursor = '';
  let _xrayDomainHintsTimer = null;
  let _xrayDomainCacheSaveTimer = null;
  // Показывать ли DNS-бейджи рядом с IP (persisted). Чистый display-флаг:
  // не трогает loglevel и не зависит от Live. Default false = «только IP»
  // (сохраняем прежнее opt-in поведение для тех, кто домены не включал).
  let _xrayDomainsDisplay = false;
  // Идёт переустановка уровня на info (debounce, чтобы не рестартовать Xray
  // повторно в окне рестарта, пока статус ещё рапортует старый уровень).
  let _xrayResolveEnsurePending = false;
  // Идёт запрос /api/xray-logs/enable (полный рестарт ядра). Пока он в полёте,
  // повторные enable не запускаем параллельно (иначе второй рестарт видит
  // полуубитый xray и оставляет ядро лежать). Отложенный вызов не теряем —
  // ставим _enablePendingRerun, чтобы догнать после завершения текущего
  // (нужно для авто-подъёма уровня warning→info под резолвинг доменов).
  let _enableInFlight = false;
  let _enablePendingRerun = false;
  // Пользователь реально трогал управление логами на этой странице (кнопка
  // «Включить», тумблер Live, смена loglevel, переключатель доменов). Пока
  // взаимодействия не было — авто-подъём loglevel до info (полный рестарт Xray)
  // не выполняем: восстановление состояния при переоткрытии вкладки НЕ должно
  // молча рестартовать ядро. Поток логов при этом восстанавливается как обычно.
  let _logsUserActivated = false;
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

  function _readLogsViewPrefsTs(value) {
    try {
      const ts = parseInt(value && value.ts, 10);
      return isFinite(ts) && ts > 0 ? ts : 0;
    } catch (e) {
      return 0;
    }
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

    // Keep the latest browser-local draft if it is newer than the server copy.
    // This covers quick exits after a manual resize, when the async server save
    // may not have finished yet but the browser already has the right height.
    const localDraft = _extractViewPrefsFromLegacy(readStoredUiState());
    const localDraftTs = _readLogsViewPrefsTs(localDraft);
    const serverViewTs = _readLogsViewPrefsTs(view);
    if (
      !_isViewPrefsEmpty(localDraft) &&
      (_isViewPrefsEmpty(view) || localDraftTs > serverViewTs)
    ) {
      view = Object.assign({}, view || {}, localDraft || {});
      try {
        await settingsApi.patch({ logs: { view: view } });
        _setSeedMarker();
      } catch (e) {
        console.warn('ui-settings: failed to promote local logs view draft', e);
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

  async function requestXrayLogsWsToken(scope) {
    const normalizedScope = String(scope || 'logs').trim().toLowerCase() || 'logs';

    try {
      const res = await fetch('/api/ws-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: normalizedScope })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok && data.token) return String(data.token || '');
    } catch (e) {
      // ignore, caller will fallback to HTTP
    }

    return '';
  }

  function $(id) {
    return document.getElementById(id);
  }

  function syncTooltipText(el, text, ariaLabel) {
    if (!el) return;

    const nextText = String(text || '').trim();
    const nextAria = arguments.length >= 3 ? String(ariaLabel || '').trim() : null;

    if (nextText) {
      if (el.getAttribute('data-tooltip') !== nextText) {
        el.title = nextText;
        try { el.setAttribute('data-tooltip', nextText); } catch (e) {}
      }
    } else if (el.hasAttribute('title') || el.hasAttribute('data-tooltip')) {
      try { el.removeAttribute('title'); } catch (e) {}
      try { el.removeAttribute('data-tooltip'); } catch (e) {}
    }

    if (nextAria == null) return;

    if (nextAria) {
      if (el.getAttribute('aria-label') !== nextAria) {
        try { el.setAttribute('aria-label', nextAria); } catch (e) {}
      }
      return;
    }

    if (el.hasAttribute('aria-label')) {
      try { el.removeAttribute('aria-label'); } catch (e) {}
    }
  }

  function setAttrIfChanged(el, name, value) {
    if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
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
      domainToggle: $('xray-log-toggle-domains'),
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
        // На паузе не перерисовываем буфер логов — только статус/статистику,
        // чтобы заморозка вывода держалась.
        if ($('xray-log-output') && !_paused) applyXrayLogFilterToOutput();
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
    const height = _resolveLogWindowHeight(refs, runtime);

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
    // The view tracks scroll position itself; reading scrollHeight here would
    // force a layout after every update.
    if (_view) return _view.isNearBottom();
    const el = outputEl || $('xray-log-output');
    if (!el) return true;

    try {
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    } catch (e) {
      return true;
    }
  }

  function scrollXrayLogOutputToBottom() {
    if (_view) {
      _view.scrollToEnd();
      return;
    }
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

    try { syncXrayLogDomainsToggle(); } catch (e) {}

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
    let label = 'Вручную';
    let title = 'Ручной просмотр логов без активного онлайн-потока.';

    if (paused) {
      state = 'paused';
      label = pending ? ('Пауза +' + pending) : 'Пауза';
      title = pending
        ? ('Вывод на паузе. В буфере уже ' + pending + ' строк.')
        : 'Вывод на паузе, входящие строки продолжают собираться.';
    } else if (liveActive && followEnabled) {
      state = 'live';
      label = 'Онлайн / В конец';
      title = 'Онлайн-поток активен, вывод закреплен на последних строках.';
    } else if (liveActive) {
      state = 'browse';
      label = 'Онлайн / Просмотр';
      title = 'Онлайн-поток активен, автопрокрутка выключена для просмотра старых строк.';
    } else if (liveWanted) {
      state = 'armed';
      label = 'Онлайн / Готов';
      title = 'Онлайн-режим выбран, но поток сейчас не активен.';
    } else if (followEnabled) {
      state = 'manual-follow';
      label = 'Вручную / В конец';
      title = 'Ручной просмотр логов с автопрокруткой при следующем выводе.';
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
    const state = String(mode.state || 'manual');
    const label = String(mode.label || 'Вручную');
    if (el.dataset.state !== state) el.dataset.state = state;
    if (el.textContent !== label) el.textContent = label;
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

    if (btn.hidden !== !visible) btn.hidden = !visible;
    if (btn.disabled !== !visible) btn.disabled = !visible;
    if (btn.dataset.state !== (visible ? 'visible' : 'hidden')) btn.dataset.state = visible ? 'visible' : 'hidden';

    if (!visible) {
      if (btn.textContent !== 'К последним') btn.textContent = 'К последним';
      syncTooltipText(btn, 'Прокрутить к последним показанным строкам.');
      return;
    }

    const label = mode.liveActive ? 'К последним' : 'Вниз';
    if (btn.textContent !== label) btn.textContent = label;
    syncTooltipText(
      btn,
      mode.liveActive
        ? 'Прокрутить к последним показанным строкам без включения автопрокрутки.'
        : 'Прокрутить вниз текущего вывода логов.'
    );
  }

  function renderXrayLogsChrome(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const mode = readXrayLogsModeState(refs, runtime);

    renderXrayLogModeLayer(refs, runtime, mode);
    renderXrayLogScrollBottomLayer(refs, runtime, mode);
    // After the scroll button: on pause the "new lines" button takes its place.
    renderXrayLogPauseLayer(refs, runtime);
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

    // The header is also rendered before this lazy feature loads.  Normalize
    // its glyph once the feature is ready, so a cached legacy shell cannot
    // leave the retired document/pill artwork beside the core selector.
    const glyph = badge.querySelector('use');
    if (!glyph || !String(glyph.getAttribute('href') || '').endsWith('#xk-terminal')) {
      badge.innerHTML = iconHtml('terminal');
    }

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
      if (nextLive === 'on') title += ' Онлайн-поток активен.';
    }

    syncTooltipText(badge, title, title);
  }

  function renderXrayLogLampLayer(dom, state) {
    const refs = dom || getXrayLogsDom();
    const lamp = refs.lamp;
    if (!lamp) return;

    const nextState = String(state || '');
    lamp.dataset.state = nextState;
    const label = lamp.querySelector('[data-xlog-live-label]');
    if (label) {
      let text = 'Нет данных';
      if (nextState === 'on') text = 'Онлайн' + (readXrayLogTransportLabel() ? ' · ' + readXrayLogTransportLabel() : '');
      else if (nextState === 'armed') text = _paused ? 'Пауза' : 'Ожидание';
      else if (nextState === 'off') text = 'Выключено';
      else if (nextState === 'error') text = 'Ошибка';
      if (label.textContent !== text) label.textContent = text;
    }

    if (nextState === 'on') {
      lamp.title = 'Логи собираются в реальном времени';
    } else if (nextState === 'armed') {
      lamp.title = 'Онлайн включён, но сбор не идёт (логи выключены, пауза или нет новых строк)';
    } else if (nextState === 'off') {
      lamp.title = 'Онлайн выключен';
    } else if (nextState === 'error') {
      lamp.title = 'Ошибка автообновления логов';
    } else {
      lamp.title = 'Статус логов Xray неизвестен';
    }
    syncTooltipText(lamp, lamp.getAttribute('title') || '');
  }

  function readXrayLogTransportLabel(runtimeState) {
    const runtime = runtimeState || readXrayLogsRuntimeState();
    const pollLabel = formatXrayLogPollLabel(runtime.pollMs);

    try {
      if (runtime.ws && typeof WebSocket !== 'undefined') {
        if (runtime.ws.readyState === WebSocket.OPEN) {
          return _isWs2Socket(runtime.ws) ? 'WS2 онлайн' : 'WS онлайн';
        }
        if (runtime.ws.readyState === WebSocket.CONNECTING) {
          return _isWs2Socket(runtime.ws) ? 'WS2 подключение' : 'WS подключение';
        }
      }
    } catch (e) {}

    if (runtime.streaming && runtime.useWs) {
      return _shouldUseWs2() ? 'WS2 повтор' : 'WS повтор';
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
    const wsReadyState = runtime.ws && typeof runtime.ws.readyState === 'number'
      ? runtime.ws.readyState
      : null;
    const wsOpen = typeof WebSocket !== 'undefined' && wsReadyState === WebSocket.OPEN;
    const wsConnecting = typeof WebSocket !== 'undefined' && wsReadyState === WebSocket.CONNECTING;

    let phase = String(uiStatus.phase || 'idle');
    let tone = String(uiStatus.tone || 'muted');
    let message = String(uiStatus.message || '').trim();

    if (!message) {
      if (runtime.paused) {
        phase = 'paused';
        tone = 'muted';
        message = pending
          ? ('Вывод на паузе, в буфере уже +' + pending + ' строк.')
          : 'Вывод на паузе. Новые строки будут показаны после продолжения.';
      } else if (wsConnecting) {
        phase = 'connecting';
        tone = 'muted';
        message = transport
          ? ('Подключаю ' + transport + ' для ' + fileLabel + '...')
          : ('Подключаю онлайн-транспорт для ' + fileLabel + '...');
      } else if (runtime.useWs && wsOpen) {
        phase = 'streaming';
        tone = 'muted';
        message = transport
          ? ('Подключен ' + transport + '. Идёт онлайн-поток для ' + fileLabel + '.')
          : ('Онлайн-транспорт подключен для ' + fileLabel + '.');
      } else if (runtime.streaming && runtime.useWs) {
        phase = 'reconnecting';
        tone = 'muted';
        message = transport
          ? ('Поднимаю ' + transport + ' для ' + fileLabel + '...')
          : ('Поднимаю онлайн-транспорт для ' + fileLabel + '...');
      } else if (runtime.streaming) {
        phase = 'streaming';
        tone = 'muted';
        message = 'Онлайн-поток идет через HTTP-опрос каждые ' + formatXrayLogPollLabel(runtime.pollMs) + '.';
      } else if (_isErrorFileName(runtime.currentFile) && String(runtime.activeLogLevel || 'none') === 'none') {
        phase = 'idle';
        tone = 'muted';
        message = 'Логирование Xray сейчас выключено (loglevel=none), поэтому error.log может быть пустым.';
      } else {
        phase = 'idle';
        tone = 'muted';
        message = 'Нажмите просмотр для снимка или включите онлайн-режим, чтобы ждать новые строки.';
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
    const message = String(model.message || '');
    if (el.textContent !== message) el.textContent = message;
    const data = {
      phase: String(model.phase || 'idle'),
      tone: String(model.tone || 'muted'),
      transport: String(model.transport || ''),
      file: String(model.fileLabel || ''),
    };
    Object.keys(data).forEach((key) => {
      if (el.dataset[key] !== data[key]) el.dataset[key] = data[key];
    });

    try {
      if (el.classList.contains('error') !== (model.tone === 'error')) el.classList.toggle('error', model.tone === 'error');
      if (el.classList.contains('is-warning') !== (model.tone === 'warning')) el.classList.toggle('is-warning', model.tone === 'warning');
    } catch (e) {}
  }

  // Переключатель отображения доменных имён рядом с IP на access.log.
  // Это чистый display-флаг: он не затрагивает loglevel и не перезапускает Xray.
  function syncXrayLogDomainsToggle(dom) {
    const refs = dom || getXrayLogsDom();
    const input = refs.domainToggle;
    if (!input) return;

    const available = _isAccessFileName(_currentFile);
    input.disabled = !available;
    input.checked = !!_xrayDomainsDisplay;
    const item = input.closest ? input.closest('.xk-xlog-menu-item') : null;
    if (item) item.hidden = !available;
  }

  function toggleXrayLogDomainsDisplay() {
    if (!_isAccessFileName(_currentFile)) return;
    _logsUserActivated = true;
    const next = !_xrayDomainsDisplay;
    try { persistXrayDomainsDisplay(next); } catch (e) {}
    markXrayLogDecorationsChanged();
    try { applyXrayLogFilterToOutput(); } catch (e) {}
    try { syncXrayLogDomainsToggle(); } catch (e) {}
    // При включении показа гарантируем резолвинг (info) при Live, чтобы кеш
    // наполнялся свежими доменами; при выключении уровень не меняем.
    if (next) {
      try { ensureXrayResolveLoglevelForLive(); } catch (e) {}
      try { rearmXrayDomainHintsForLive(); } catch (e) {}
    }
  }

  function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function renderXrayLogPauseLayer(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const btn = refs.pause;
    const runtime = runtimeState || readXrayLogsRuntimeState();
    if (!btn) return;

    const paused = !!(runtime.streaming && runtime.paused);
    const pending = paused ? Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0) : 0;
    // Пуск and Пауза share one slot: while lines stream only Пауза is shown,
    // otherwise Пуск (labelled «Продолжить» on pause). Both buttons stay in the
    // DOM and are only hidden, so a click is never lost to a rebuilt element.
    const play = $('xray-log-enable-btn');
    const showPause = !!(runtime.streaming && !paused && String(_activeLogLevel || 'none') !== 'none');
    const focusWasOn = document.activeElement;
    if (btn.disabled !== !runtime.streaming) btn.disabled = !runtime.streaming;
    if (btn.dataset.state !== (paused ? 'on' : 'off')) btn.dataset.state = paused ? 'on' : 'off';
    if (btn.hidden !== !showPause) btn.hidden = !showPause;

    if (play) {
      if (play.hidden !== showPause) play.hidden = showPause;
      if (play.dataset.state !== (paused ? 'resume' : 'start')) play.dataset.state = paused ? 'resume' : 'start';
      const label = play.querySelector('[data-xlog-play-label]');
      const labelText = paused ? 'Продолжить' : 'Пуск';
      if (label && label.textContent !== labelText) label.textContent = labelText;
      const badge = play.querySelector('.xk-xlog-badge');
      if (badge) {
        const badgeText = pending ? `+${pending}` : '';
        if (badge.textContent !== badgeText) badge.textContent = badgeText;
        if (badge.hidden !== !pending) badge.hidden = !pending;
      }
      syncTooltipText(
        play,
        paused
          ? 'Продолжить: показать накопленные строки и вернуться к онлайн-выводу.'
          : 'Пуск: включить запись логов и онлайн-поток',
        labelText,
      );
    }
    // Keep keyboard focus on the slot when the pressed button hides itself.
    if (focusWasOn === btn && btn.hidden && play) play.focus();
    else if (focusWasOn === play && play && play.hidden) btn.focus();

    // Mockup: a floating "N новых строк — показать" over the paused output.
    const newLines = $('xray-log-new-lines');
    if (newLines) {
      const show = paused && pending > 0;
      if (newLines.hidden !== !show) newLines.hidden = !show;
      const label = newLines.querySelector('[data-xlog-new-label]');
      const text = show ? (pending + ' ' + pluralRu(pending, 'новая строка', 'новые строки', 'новых строк') + ' — показать') : '';
      if (label && label.textContent !== text) label.textContent = text;
      if (show && refs.scrollBottom && !refs.scrollBottom.hidden) refs.scrollBottom.hidden = true;
    }
  }

  function renderXrayLogStatsLayer(dom, runtimeState) {
    const refs = dom || getXrayLogsDom();
    const el = refs.stats;
    const runtime = runtimeState || readXrayLogsRuntimeState();
    if (!el) return;

    const lines = Array.isArray(runtime.lastLines) ? runtime.lastLines.length : 0;
    const max = runtime.maxLines || DEFAULT_MAX_LINES;
    const viewStats = _view ? _view.stats() : null;
    renderXrayLogViewNotes(viewStats);
    const transport = readXrayLogTransportLabel(runtime);
    const parts = [
      (viewStats ? ('<span class="xk-log-counter" data-kind="shown">' +
        '<span class="xk-log-counter-label">Показано</span>' +
        '<span class="xk-log-counter-value">' + String(viewStats.shown) + ' из ' + String(viewStats.total) + '</span>' +
      '</span>') : ''),
      '<span class="xk-log-counter" data-kind="lines">' +
        '<span class="xk-log-counter-label">Строки</span>' +
        '<span class="xk-log-counter-value">' + String(lines) + ' / ' + String(max) + '</span>' +
      '</span>',
    ];

    if (transport) {
      parts.push(
        '<span class="xk-log-counter" data-kind="transport">' +
          '<span class="xk-log-counter-label">Транспорт</span>' +
          '<span class="xk-log-counter-value">' + escapeHtml(transport) + '</span>' +
        '</span>'
      );
    }
    if (runtime.paused) {
      const pending = Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0);
      parts.push(
        '<span class="xk-log-counter" data-kind="pending">' +
          '<span class="xk-log-counter-label">Очередь</span>' +
          '<span class="xk-log-counter-value">' + (pending ? ('+' + String(pending)) : 'буфер') + '</span>' +
        '</span>'
      );
    }

    const html = parts.join('');
    if (el._xlogHtml !== html) {
      el._xlogHtml = html;
      el.innerHTML = html;
    }
    setAttrIfChanged(el,
      'aria-label',
      'Строки: ' + String(lines) + ' из ' + String(max) +
        (transport ? ('. Транспорт: ' + transport) : '') +
        (runtime.paused ? ('. Очередь: ' + String(Math.max(0, parseInt(runtime.pendingCount || 0, 10) || 0))) : '')
    );
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
      entries = entries.filter((entry) => shouldKeepXrayLogLineForLevel(entry.line, levelFilter));
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

    if (uiStatus.phase === 'error' || uiStatus.tone === 'error') {
      return {
        tone: 'error',
        title: 'Не удалось получить строки лога',
        detail: String(uiStatus.message || ('Проверьте доступ к ' + fileLabel + ' и повторите просмотр.')),
      };
    }

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
          : 'Экран заморожен. Новые строки появятся после продолжения вывода.',
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
        title: 'Подключаю онлайн-транспорт',
        detail: String(uiStatus.message || ('Жду первые строки из ' + fileLabel + '.')),
      };
    }

    if (_isErrorFileName(runtime.currentFile) && String(runtime.activeLogLevel || 'none') === 'none') {
      return {
        tone: 'warning',
        title: 'Логирование Xray выключено',
        detail: 'Сервер сейчас отвечает с loglevel=none, поэтому error.log может оставаться пустым, пока вы не включите логи.',
      };
    }

    if (runtime.streaming) {
      return {
        tone: 'muted',
        title: fileLabel + ' пока пуст',
        detail: runtime.useWs
          ? 'Онлайн-транспорт уже поднимается, но новых строк в журнале пока нет.'
          : ('HTTP-опрос проверяет ' + fileLabel + ' каждые ' + formatXrayLogPollLabel(runtime.pollMs) + '.'),
      };
    }

    return {
      tone: 'muted',
      title: fileLabel + ' пока пуст',
      detail: 'Нажмите просмотр, чтобы запросить снимок, или включите онлайн-режим для ожидания новых строк.',
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

  function readXrayViewExtras() {
    try {
      const raw = window.localStorage ? localStorage.getItem(XRAY_VIEW_EXTRAS_STORAGE_KEY) : '';
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      return {};
    }
  }

  function writeXrayViewExtras(patch) {
    try {
      const next = Object.assign(readXrayViewExtras(), patch || {});
      if (window.localStorage) localStorage.setItem(XRAY_VIEW_EXTRAS_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  function markXrayLogDecorationsChanged() {
    _decorStamp += 1;
  }

  async function refreshXrayOutboundNames(options) {
    const opts = options || {};
    if (_outboundNamesInFlight) return _outboundNamesInFlight;
    if (!opts.force && _outboundNamesAt && Date.now() - _outboundNamesAt < OUTBOUND_NAMES_TTL_MS) return null;
    _outboundNamesInFlight = (async () => {
      try {
        const res = await fetch('/api/xray-logs/outbound-names', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        const names = data && data.names && typeof data.names === 'object' ? data.names : {};
        _outboundNames = Object.assign(Object.create(null), names);
        markXrayLogDecorationsChanged();
        if (_view) {
          _viewDecorStamp = _decorStamp;
          _view.refreshDecorations();
        }
      } catch (e) {
      } finally {
        _outboundNamesAt = Date.now();
        _outboundNamesInFlight = null;
      }
    })();
    return _outboundNamesInFlight;
  }

  function xrayLogViewMode() {
    return _isErrorFileName(_currentFile) ? 'error' : 'access';
  }

  function ensureXrayLogView() {
    if (_view) return _view;
    const output = $('xray-log-output');
    if (!output) return null;
    const extras = readXrayViewExtras();
    _view = createXrayLogView({
      root: output,
      chips: $('xray-log-chips'),
      summary: $('xray-log-summary'),
      selbar: $('xray-log-selbar'),
      icon: (name) => iconHtml(name),
      deviceName: (ip) => {
        const entry = getXrayDeviceNameEntry(ip);
        const name = entry && entry.name ? normalizeXrayDeviceName(entry.name) : '';
        return name && name !== ip ? name : '';
      },
      domainHint: (ip) => {
        if (!_xrayDomainsDisplay) return '';
        const hint = getXrayDestinationDomainHint(ip);
        return hint && hint.domain ? hint.domain : '';
      },
      nodeName: (tag) => _outboundNames[tag] || null,
      ansi: (html) => (_ansiEnabled ? ansiSgrToHtml(html) : html),
      onCopy: (text, count, asTable) => {
        const msg = asTable
          ? ('Скопировано таблицей строк: ' + count)
          : (count === 1 ? 'Строка скопирована' : ('Скопировано строк: ' + count));
        copyToClipboard(text, msg);
      },
      onContextMenu: (record, x, y) => {
        const fromEnd = _view ? _view.offsetFromEnd(record.seq) : -1;
        const idx = fromEnd < 0 ? -1 : (_lastLines.length - 1 - fromEnd);
        if (idx < 0) return;
        closeLineMenu();
        openLineMenu(x, y, idx);
      },
      onChange: () => {
        try { updateXrayLogStats(); } catch (e) {}
      },
      onSummaryToggle: (open) => writeXrayViewExtras({ summaryOpen: !!open }),
      onRenameDevice: (ip, name) => { void openXrayDeviceNamesModal({ ip, name }); },
    });
    _view.setMaxLines(_maxLines);
    _view.setFollow(_follow);
    _view.setShowRaw(!!extras.showRaw);
    _view.setSummaryOpen(!!extras.summaryOpen);
    _view.setMode(xrayLogViewMode());
    syncXrayLogViewExtrasUi(extras);
    return _view;
  }

  function syncXrayLogViewExtrasUi(extras) {
    const data = extras || readXrayViewExtras();
    const raw = $('xray-log-show-raw');
    if (raw) raw.checked = !!data.showRaw;
    const summaryToggle = $('xray-log-show-summary');
    const showSummary = data.showSummary !== false;
    if (summaryToggle) summaryToggle.checked = showSummary;
    const card = _xrayCardEl();
    if (card) card.classList.toggle('xk-xlog-no-summary', !showSummary);
  }

  function syncXrayLogFileUi() {
    const file = xrayLogViewMode();
    const card = _xrayCardEl();
    if (card) card.dataset.xlogFile = file;
    document.querySelectorAll('[data-xlog-file-btn]').forEach((btn) => {
      const on = btn.getAttribute('data-xlog-file-btn') === file;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const name = document.querySelector('[data-xlog-file-name]');
    if (name) name.textContent = file + '.log';
  }

  function renderXrayLogOutputLayer(dom, runtimeState, viewState) {
    const refs = dom || getXrayLogsDom();
    if (!refs.output) return;
    const xview = ensureXrayLogView();
    if (!xview) return;

    const runtime = runtimeState || readXrayLogsRuntimeState();
    const view = viewState || readXrayLogsViewState(refs, runtime);
    xview.setMode(xrayLogViewMode());
    if (_viewDecorStamp !== _decorStamp) {
      _viewDecorStamp = _decorStamp;
      xview.refreshDecorations();
    }
    xview.setSearch(view.filter);
    const stats = xview.stats();
    xview.setEmptyHtml(stats.shown ? '' : renderXrayLogEmptyStateHtml(buildXrayLogEmptyStateModel(runtime, view, {
      entries: [],
      rawCount: stats.total,
      levelCount: stats.total,
      levelFilter: '',
      hasTextFilter: buildXrayLogFilterGroups(view.filter).length > 0,
      filterText: String(view.filter || '').trim(),
    })));
    if (xrayLogViewMode() === 'access') void refreshXrayOutboundNames();
    try { maybeRefreshXrayDestinationDomainHints({ render: true }); } catch (e) {}
    try { syncXrayLogDomainsToggle(); } catch (e) {}
  }

  function resetXrayLogBuffer(options) {
    const opts = options || {};
    _lastLines = [];
    if (_view) _view.reset([]);
    if (opts.resetDomains !== false) resetXrayDestinationDomainCaches();
    if (opts.resetCursor !== false) _cursor = '';
    if (opts.resetPending !== false) _pendingCount = 0;
    return readXrayLogsRuntimeState();
  }

  function replaceXrayLogBuffer(lines) {
    _lastLines = trimLogBuffer(lines, _maxLines);
    try { ingestXrayLogDestinationDomains(_lastLines, { source: _currentFile || 'log' }); } catch (e) {}
    const xview = ensureXrayLogView();
    if (xview) {
      xview.setMode(xrayLogViewMode());
      xview.reset(_lastLines);
    }
    return _lastLines;
  }

  function appendXrayLogBuffer(lines) {
    const nextLines = Array.isArray(lines) ? lines : [];
    if (!Array.isArray(_lastLines)) _lastLines = [];
    for (let i = 0; i < nextLines.length; i += 1) _lastLines.push(nextLines[i]);
    const limit = clampLogLinesValue(_maxLines, DEFAULT_MAX_LINES);
    if (_lastLines.length > limit) _lastLines.splice(0, _lastLines.length - limit);
    try { ingestXrayLogDestinationDomains(nextLines, { source: _currentFile || 'log' }); } catch (e) {}
    const xview = ensureXrayLogView();
    if (xview) xview.append(nextLines);
    return _lastLines;
  }

  function flushScheduledXrayLogOutputRender() {
    if (_xrayLogOutputRenderTimer) {
      try { clearTimeout(_xrayLogOutputRenderTimer); } catch (e) {}
      _xrayLogOutputRenderTimer = null;
    }
    _pendingCount = 0;
    applyXrayLogFilterToOutput();
  }

  function scheduleXrayLogOutputRender() {
    if (_xrayLogOutputRenderTimer) {
      try { updateXrayLogStats(); } catch (e) {}
      return false;
    }

    _xrayLogOutputRenderTimer = setTimeout(() => {
      _xrayLogOutputRenderTimer = null;
      _pendingCount = 0;
      applyXrayLogFilterToOutput();
    }, LOG_RENDER_DEBOUNCE_MS);
    try { updateXrayLogStats(); } catch (e) {}
    return true;
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
    if (forceRender) {
      flushScheduledXrayLogOutputRender();
      return true;
    }
    return scheduleXrayLogOutputRender();
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

  function mergeStoredUiState(next) {
    const cur = (next && typeof next === 'object' && !Array.isArray(next)) ? next : {};
    const prev = readStoredUiState();
    writeStoredUiState(Object.assign({}, prev || {}, cur || {}));
  }

  function _normalizeLogWindowHeight(value) {
    try {
      let height = parseInt(value, 10);
      if (!isFinite(height) || height <= 0) return null;
      if (height < LOG_WINDOW_MIN_HEIGHT) height = LOG_WINDOW_MIN_HEIGHT;
      return height;
    } catch (e) {
      return null;
    }
  }

  function _resolveLogWindowHeight(refs, runtimeState) {
    const dom = refs || getXrayLogsDom();
    const runtime = runtimeState || readXrayLogsRuntimeState();

    const fullscreenHeight = _normalizeLogWindowHeight(runtime && runtime.heightBeforeFullscreen);
    if (runtime && runtime.isFullscreen && fullscreenHeight != null) return fullscreenHeight;

    try {
      if (dom.output) {
        const measured = _normalizeLogWindowHeight(Math.round(dom.output.getBoundingClientRect().height));
        if (measured != null) return measured;
      }
    } catch (e) {}

    try {
      const inlineHeight = _normalizeLogWindowHeight(dom.output && dom.output.style ? dom.output.style.height : null);
      if (inlineHeight != null) return inlineHeight;
    } catch (e) {}

    try {
      const storedHeight = _normalizeLogWindowHeight(readStoredUiState().height);
      if (storedHeight != null) return storedHeight;
    } catch (e) {}

    return LOG_WINDOW_MIN_HEIGHT;
  }

  function collectUiState() {
    return readXrayLogsViewState(getXrayLogsDom(), readXrayLogsRuntimeState());
  }

  function persistLocalLogsViewDraft() {
    try {
      mergeStoredUiState(collectUiState());
      return true;
    } catch (e) {
      return false;
    }
  }

  function scheduleSaveUiState() {
    // Do not treat programmatic updates (applying server prefs) as "user touches".
    if (_logsViewPrefsApplying) return;

    _logsViewPrefsUserTouched = true;

    // Keep a synchronous browser-local draft so quick tab switches or page exits
    // cannot lose the latest user-resized height before the async server save runs.
    persistLocalLogsViewDraft();

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
        persistLocalLogsViewDraft();
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

    // Follow is a view preference; auto-update is intentionally session-bound
    // and always starts disabled until the user enables Xray logs.
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
      const h = _normalizeLogWindowHeight(prefs.height);
      if (h != null) {
        if (dom.output) dom.output.style.height = String(h) + 'px';
      }
    } catch (e) {}

    try { updateXrayLogStats(); } catch (e) {}
  }

  function applyInitialLogWindowHeightFromStoredState(st) {
    try {
      const prefs = (st && typeof st === 'object') ? st : {};
      const h = _normalizeLogWindowHeight(prefs.height);
      if (h == null) return;
      const dom = getXrayLogsDom();
      if (dom.output) dom.output.style.height = String(h) + 'px';
    } catch (e) {}
  }

  // Initial restore without triggering /api/ui-settings fetch.
  // We always warm-start the log window height from the browser-local draft so
  // cross-page navigation does not flash back to the CSS default size.
  // Full prefs are still restored from /api/ui-settings when the user opens the
  // logs view; before migration we keep the full legacy restore behavior.
  function applyInitialUiStateNoFetch() {
    try {
      const st = readStoredUiState();
      applyInitialLogWindowHeightFromStoredState(st);
      if (_seedMarkerIsSet()) return;
      if (st && typeof st === 'object') applyUiStateFromPrefs(st);
    } catch (e) {}
  }

  function renderXrayLogViewNotes(viewStats) {
    const stats = viewStats || (_view ? _view.stats() : null);
    const note = document.querySelector('[data-xlog-raw-note]');
    if (note) {
      const hidden = stats ? stats.hiddenRaw : 0;
      note.hidden = !hidden;
      note.textContent = hidden ? ('Не разобрано и скрыто: ' + hidden) : '';
      note.title = 'Строки, которые панель не смогла разобрать. Показать их можно в меню «⋯».';
    }
    const visibleCount = document.querySelector('[data-xlog-visible-count]');
    if (visibleCount) visibleCount.textContent = stats && stats.shown ? (stats.shown + ' стр.') : '';
    const fileCount = document.querySelector('[data-xlog-file-count="' + xrayLogViewMode() + '"]');
    document.querySelectorAll('[data-xlog-file-count]').forEach((el) => { if (el !== fileCount) el.textContent = ''; });
    if (fileCount) fileCount.textContent = stats && stats.total ? String(stats.total) : '';
  }

  function _isErrorFileName(name) {
    const f = String(name || '').toLowerCase();
    return f === 'error' || f === 'error.log';
  }

  function _isAccessFileName(name) {
    const f = String(name || '').toLowerCase();
    return !f || f === 'access' || f === 'access.log';
  }

  function updateLoglevelUiForCurrentFile() {
    const lvlSel = $('xray-log-level');
    if (!lvlSel) return;

    const isError = _isErrorFileName(_currentFile);
    lvlSel.disabled = !isError;
    lvlSel.hidden = !isError;
    try { syncXrayLogFileUi(); } catch (e) {}
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
      const raw = window.atob(String(b64 || ''));
      try {
        return decodeURIComponent(escape(raw));
      } catch (e2) {
        return raw;
      }
    } catch (e) {}
    return '';
  }

  function getCsrfToken() {
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      return el ? String(el.getAttribute('content') || '').trim() : '';
    } catch (e) {
      return '';
    }
  }

  function normalizeXrayDeviceIp(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';

    if (value.charAt(0) === '[' && value.indexOf(']') > 0) {
      value = value.slice(1, value.indexOf(']'));
    } else if (/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(value)) {
      value = value.replace(/:\d{1,5}$/, '');
    }

    const v4 = value.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
    if (v4) {
      const parts = value.split('.').map((part) => parseInt(part, 10));
      if (parts.length !== 4 || parts.some((part) => !isFinite(part) || part < 0 || part > 255)) return '';
      if (parts.every((part) => part === 0)) return '';
      return parts.join('.');
    }

    if (/^[0-9a-f:]{2,}$/i.test(value) && value.indexOf(':') >= 0) {
      const normalized = value.toLowerCase();
      if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return '';
      return normalized;
    }
    return '';
  }

  function normalizeXrayDeviceName(raw) {
    const value = String(raw || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
    return value.replace(/\s+/g, ' ').slice(0, 96).trim();
  }

  function xrayDeviceSourceLabel(source) {
    const value = String(source || '').trim().toLowerCase();
    if (value === 'manual') return 'вручную';
    if (value === 'router') return 'роутер';
    return value || 'источник';
  }

  function xrayDeviceSortValue(ip) {
    const text = String(ip || '');
    const parts = text.split('.');
    if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
      return parts.map((part) => String(parseInt(part, 10)).padStart(3, '0')).join('.');
    }
    return '999.' + text;
  }

  function normalizeXrayDeviceEntry(raw) {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const ip = normalizeXrayDeviceIp(entry.ip);
    const name = normalizeXrayDeviceName(entry.name);
    if (!ip || !name) return null;
    return {
      ip,
      name,
      source: String(entry.source || '').trim().toLowerCase() || 'router',
      mac: normalizeXrayDeviceName(entry.mac),
      hostname: normalizeXrayDeviceName(entry.hostname),
      routerName: normalizeXrayDeviceName(entry.router_name || entry.routerName),
    };
  }

  function setXrayDeviceNamesFromPayload(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const rawList = Array.isArray(data.devices)
      ? data.devices
      : (data.device_map && typeof data.device_map === 'object' ? Object.values(data.device_map) : []);

    const nextMap = Object.create(null);
    const nextEntries = [];
    rawList.forEach((raw) => {
      const entry = normalizeXrayDeviceEntry(raw);
      if (!entry) return;
      nextMap[entry.ip] = entry;
    });

    Object.keys(nextMap)
      .sort((a, b) => xrayDeviceSortValue(a).localeCompare(xrayDeviceSortValue(b)))
      .forEach((ip) => nextEntries.push(nextMap[ip]));

    const prevKeys = Object.keys(_xrayDeviceNamesByIp).sort();
    const nextKeys = Object.keys(nextMap).sort();
    let changed = prevKeys.length !== nextKeys.length;
    if (!changed) {
      for (let i = 0; i < nextKeys.length; i++) {
        const ip = nextKeys[i];
        const prev = _xrayDeviceNamesByIp[ip] || {};
        const next = nextMap[ip] || {};
        if (prevKeys[i] !== ip || prev.name !== next.name || prev.source !== next.source || prev.routerName !== next.routerName) {
          changed = true;
          break;
        }
      }
    }

    _xrayDeviceNamesByIp = nextMap;
    _xrayDeviceNameEntries = nextEntries;
    if (changed) markXrayLogDecorationsChanged();
    _xrayDeviceNamesLoaded = true;
    _xrayDeviceNamesLastFetchAt = Date.now();
    return changed;
  }

  async function requestXrayDeviceNamesJson(url, options) {
    const opts = Object.assign({}, options || {});
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = new Headers(opts.headers || {});
    if (method !== 'GET') {
      if (!headers.has('Content-Type') && opts.body != null) headers.set('Content-Type', 'application/json');
      const csrf = getCsrfToken();
      if (csrf && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrf);
    }
    opts.headers = headers;
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error(String((data && (data.error || data.detail)) || ('http ' + res.status)));
      err.data = data;
      throw err;
    }
    return data;
  }

  function getXrayDeviceNameEntry(ip) {
    const normalized = normalizeXrayDeviceIp(ip);
    if (!normalized) return null;
    return _xrayDeviceNamesByIp[normalized] || null;
  }

  function pruneXrayDestinationDomainCache() {
    const keys = Object.keys(_xrayDestinationDomainsByIp || {});
    if (keys.length <= XRAY_DESTINATION_DOMAIN_CACHE_MAX) return;

    keys
      .map((ip) => {
        const item = _xrayDestinationDomainsByIp[ip] || {};
        return { ip, ts: parseInt(item.updatedAt || item.seenAt || 0, 10) || 0 };
      })
      .sort((a, b) => a.ts - b.ts)
      .slice(0, Math.max(0, keys.length - XRAY_DESTINATION_DOMAIN_CACHE_MAX))
      .forEach((item) => {
        try { delete _xrayDestinationDomainsByIp[item.ip]; } catch (e) {}
      });
  }

  function rememberXrayDestinationConnDomain(connIdRaw, domainRaw) {
    const connId = String(connIdRaw || '').trim();
    const domain = normalizeXrayLogDomain(domainRaw);
    if (!connId || !domain) return false;

    const prev = _xrayDestinationDomainsByConnId[connId] || '';
    if (prev) return false;

    _xrayDestinationDomainConnOrder.push(connId);
    _xrayDestinationDomainsByConnId[connId] = domain;

    if (_xrayDestinationDomainConnOrder.length > XRAY_DESTINATION_CONN_CACHE_MAX) {
      const dropCount = Math.max(1, _xrayDestinationDomainConnOrder.length - XRAY_DESTINATION_CONN_CACHE_MAX);
      _xrayDestinationDomainConnOrder.splice(0, dropCount).forEach((oldConnId) => {
        try { delete _xrayDestinationDomainsByConnId[oldConnId]; } catch (e) {}
      });
    }
    return true;
  }

  function resetXrayDestinationDomainCaches() {
    _xrayDestinationDomainsByIp = Object.create(null);
    _xrayDestinationDomainsByConnId = Object.create(null);
    _xrayDestinationDomainConnOrder = [];
    _xrayDestinationDomainHintsLastFetchAt = 0;
    _xrayDomainHintsCursor = '';
    clearPersistedXrayDestinationDomains();
  }

  // ---- Персистентность кеша IP->домен (переживает перезагрузку страницы) ----

  function loadPersistedXrayDestinationDomains() {
    try {
      if (!window.localStorage) return;
      const raw = localStorage.getItem(XRAY_DOMAIN_CACHE_STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const items = (obj && Array.isArray(obj.items)) ? obj.items : [];
      const now = Date.now();
      let restored = 0;
      items.forEach((it) => {
        if (!it || restored >= XRAY_DESTINATION_DOMAIN_CACHE_MAX) return;
        const ip = normalizeXrayDeviceIp(it.ip);
        const domain = normalizeXrayLogDomain(it.domain);
        if (!ip || !domain) return;
        const updatedAt = parseInt(it.updatedAt, 10) || 0;
        if (updatedAt && now - updatedAt > XRAY_DOMAIN_CACHE_TTL_MS) return;
        _xrayDestinationDomainsByIp[ip] = {
          ip,
          domain,
          source: String(it.source || 'storage'),
          updatedAt: updatedAt || now,
        };
        restored += 1;
      });
    } catch (e) {}
  }

  function persistXrayDestinationDomainsNow() {
    try {
      if (!window.localStorage) return;
      const items = [];
      const map = _xrayDestinationDomainsByIp;
      for (const ip in map) {
        const it = map[ip];
        if (!it || !it.domain) continue;
        items.push({
          ip: it.ip || ip,
          domain: it.domain,
          source: it.source || '',
          updatedAt: it.updatedAt || 0,
        });
      }
      localStorage.setItem(
        XRAY_DOMAIN_CACHE_STORAGE_KEY,
        JSON.stringify({ v: 1, items: items.slice(-XRAY_DESTINATION_DOMAIN_CACHE_MAX) })
      );
    } catch (e) {}
  }

  function scheduleSaveXrayDestinationDomains() {
    if (_xrayDomainCacheSaveTimer) return;
    try {
      _xrayDomainCacheSaveTimer = setTimeout(() => {
        _xrayDomainCacheSaveTimer = null;
        persistXrayDestinationDomainsNow();
      }, XRAY_DOMAIN_CACHE_SAVE_DEBOUNCE_MS);
    } catch (e) {
      _xrayDomainCacheSaveTimer = null;
    }
  }

  function clearPersistedXrayDestinationDomains() {
    try {
      if (_xrayDomainCacheSaveTimer) {
        clearTimeout(_xrayDomainCacheSaveTimer);
        _xrayDomainCacheSaveTimer = null;
      }
    } catch (e) {}
    try {
      if (window.localStorage) localStorage.removeItem(XRAY_DOMAIN_CACHE_STORAGE_KEY);
    } catch (e) {}
  }

  function resetXrayDestinationDomainIpCache() {
    _xrayDestinationDomainsByIp = Object.create(null);
    _xrayDestinationDomainHintsLastFetchAt = 0;
    _xrayDomainHintsCursor = '';
  }

  // ---- Персистентность намерения «показывать домены» (баг: баннер после F5) ----

  function loadPersistedXrayDomainsDisplay() {
    try {
      if (!window.localStorage) return;
      const raw = localStorage.getItem(XRAY_DOMAINS_DISPLAY_STORAGE_KEY);
      if (raw === '1') _xrayDomainsDisplay = true;
      else if (raw === '0') _xrayDomainsDisplay = false;
    } catch (e) {}
  }

  function persistXrayDomainsDisplay(display) {
    _xrayDomainsDisplay = !!display;
    try {
      if (window.localStorage) {
        localStorage.setItem(XRAY_DOMAINS_DISPLAY_STORAGE_KEY, display ? '1' : '0');
      }
    } catch (e) {}
  }

  // Резолвинг доменов требует уровня info (sniffed/dialing строки в error.log).
  // Чтобы переключатель показа доменов работал мгновенно (без рестарта Xray на
  // каждое нажатие), info держим постоянно, пока пользователь хочет видеть домены
  // (_xrayDomainsDisplay) и идёт Live на access.log. Один раз поднимаем уровень
  // warning/error -> info; дальше он персистентен и переключение показа — чисто
  // визуальное. Остановленные логи (none) не трогаем — их выключили намеренно.
  function ensureXrayResolveLoglevelForLive() {
    if (!_xrayDomainsDisplay) return;
    // Не рестартуем Xray по факту восстановления состояния/переоткрытия вкладки.
    // Подъём уровня до info (полный рестарт ядра) допустим только после явного
    // действия пользователя с логами в этой сессии страницы. До этого держим
    // текущий уровень: кешированные домены показываются, новые подтянутся, когда
    // пользователь сам включит/переключит логи.
    if (!_logsUserActivated) return;
    if (!_isAccessFileName(_currentFile)) return;
    if (!(_liveWanted || _streaming)) return;
    if (_xrayResolveEnsurePending) return;
    // На паузе не перезапускаем Xray (рестарт сбросил бы _paused и разморозил вывод).
    // Резолвинг подтянется на следующем опросе статуса после возобновления.
    if (_paused) return;

    const lvl = String(_activeLogLevel || 'none').trim().toLowerCase();
    if (lvl === 'none' || lvl === 'info' || lvl === 'debug') return;

    // Логи запущены, но на уровне без доменов — поднимаем info для резолвинга.
    _xrayResolveEnsurePending = true;
    const lvlSel = $('xray-log-level');
    if (lvlSel) lvlSel.value = 'info';
    try { scheduleSaveUiState(); } catch (e) {}
    try { xrayLogsEnable(); } catch (e) {}
  }

  function rememberXrayDestinationDomain(ipRaw, domainRaw, source) {
    const ip = normalizeXrayDeviceIp(ipRaw);
    const domain = normalizeXrayLogDomain(domainRaw);
    if (!ip || !domain) return false;

    const prev = _xrayDestinationDomainsByIp[ip] || null;
    if (prev && prev.domain === domain) {
      prev.updatedAt = Date.now();
      if (source && !prev.source) prev.source = String(source || '');
      return false;
    }

    _xrayDestinationDomainsByIp[ip] = {
      ip,
      domain,
      source: String(source || 'log'),
      updatedAt: Date.now(),
    };
    pruneXrayDestinationDomainCache();
    scheduleSaveXrayDestinationDomains();
    markXrayLogDecorationsChanged();
    return true;
  }

  function ingestXrayLogDestinationDomains(lines, options) {
    const src = Array.isArray(lines) ? lines : [];
    if (!src.length) return false;

    const opts = options || {};
    let changed = false;

    src.forEach((line) => {
      const raw = normalizeLogLine(line);
      if (!raw) return;

      const connId = extractXrayLogConnectionId(raw);
      const candidates = collectXrayLogDomainCandidates(raw);
      const firstDomain = candidates.length ? candidates[0].domain : '';

      if (connId && firstDomain) {
        rememberXrayDestinationConnDomain(connId, firstDomain);
      }

      const destinations = collectXrayLogDestinationIpPorts(raw);
      if (!destinations.length) return;

      const connDomain = connId ? normalizeXrayLogDomain(_xrayDestinationDomainsByConnId[connId]) : '';
      const domain = connDomain || firstDomain;
      if (!domain) return;

      destinations.forEach((dest) => {
        if (rememberXrayDestinationDomain(dest.ip, domain, opts.source || (connDomain ? 'connection' : 'line'))) {
          changed = true;
        }
      });
    });

    return changed;
  }

  function getXrayDestinationDomainHint(ip) {
    const normalized = normalizeXrayDeviceIp(ip);
    if (!normalized) return null;
    const item = _xrayDestinationDomainsByIp[normalized] || null;
    if (!item || !item.domain) return null;
    const domain = normalizeXrayLogDomain(item.domain);
    if (!domain) return null;
    return Object.assign({}, item, { ip: normalized, domain });
  }

  async function refreshXrayDestinationDomainHints(options) {
    const opts = options || {};
    if (_xrayDestinationDomainHintsRequest) return _xrayDestinationDomainHintsRequest;

    _xrayDestinationDomainHintsRequest = (async () => {
      try {
        const params = new URLSearchParams();
        params.set('file', 'error');
        params.set('source', 'domain_hints');

        if (_xrayDomainHintsCursor) {
          params.set('cursor', _xrayDomainHintsCursor);
        } else {
          params.set('max_lines', String(Math.max(50, Math.min(MAX_MAX_LINES, XRAY_DESTINATION_DOMAIN_HINTS_INIT_LINES))));
        }

        const res = await fetch('/api/xray-logs?' + params.toString(), { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error('http ' + res.status);

        if (data.cursor) _xrayDomainHintsCursor = String(data.cursor);

        const lines = Array.isArray(data.lines) ? data.lines : [];
        const changed = lines.length > 0 && ingestXrayLogDestinationDomains(lines, { source: 'error_log' });
        _xrayDestinationDomainHintsLastFetchAt = Date.now();
        // НЕ перерисовываем экран на паузе: кеш доменов обновляем, но вывод заморожен
        // (иначе фоновый опрос каждые 2.5с показывал бы накопленные строки — пауза «не держит»).
        if (opts.render !== false && !_paused) {
          try { applyXrayLogFilterToOutput(); } catch (e) {}
        }
        return changed;
      } catch (e) {
        _xrayDestinationDomainHintsLastFetchAt = Date.now();
        return false;
      } finally {
        _xrayDestinationDomainHintsRequest = null;
      }
    })();

    return _xrayDestinationDomainHintsRequest;
  }

  function stopXrayDomainHintsPolling() {
    if (_xrayDomainHintsTimer) {
      clearInterval(_xrayDomainHintsTimer);
      _xrayDomainHintsTimer = null;
    }
  }

  // Domain hints имеют смысл только когда Xray пишет error.log на уровне info/debug
  // (иначе sniffed/dialing строк нет). При warning и ниже не поллим, чтобы фон не
  // наполнял кеш заново из старых info-строк, оставшихся в файле error.log.
  function _xrayLogLevelGivesDomains() {
    const lvl = String(_activeLogLevel || 'none').trim().toLowerCase();
    return lvl === 'info' || lvl === 'debug';
  }

  function ensureXrayDomainHintsPolling() {
    if (_xrayDomainHintsTimer) return;
    void refreshXrayDestinationDomainHints({ render: true });
    _xrayDomainHintsTimer = setInterval(() => {
      try {
        if (!_isAccessFileName(_currentFile) || !_xrayLogLevelGivesDomains()) {
          stopXrayDomainHintsPolling();
          return;
        }
        void refreshXrayDestinationDomainHints({ render: true });
      } catch (e) {}
    }, XRAY_DESTINATION_DOMAIN_HINTS_POLL_MS);
  }

  function maybeRefreshXrayDestinationDomainHints(options) {
    if (!_isAccessFileName(_currentFile) || !_xrayLogLevelGivesDomains()) {
      stopXrayDomainHintsPolling();
      return;
    }
    ensureXrayDomainHintsPolling();
  }

  // Пере-взвести резолвинг доменов «начисто» — как при stop+start потока.
  // ensureXrayDomainHintsPolling() рано выходит, если таймер уже жив, поэтому при
  // подъёме уровня warning→info (ядро перезапускается, error.log пересоздаётся)
  // без принудительного сброса курсора мы не делаем свежий полный снимок на новом
  // уровне — и накопленные sniffed-домены не подтягиваются, пока пользователь не
  // остановит и снова не запустит логи. Здесь останавливаем таймер, сбрасываем
  // курсор и поднимаем поллинг заново с немедленным полным снимком.
  function rearmXrayDomainHintsForLive() {
    if (!_isAccessFileName(_currentFile)) return;
    if (!(_liveWanted || _streaming)) return;
    if (!_xrayLogLevelGivesDomains()) return;
    try { stopXrayDomainHintsPolling(); } catch (e) {}
    _xrayDomainHintsCursor = '';
    try { ensureXrayDomainHintsPolling(); } catch (e) {}
  }

  async function refreshXrayLogDeviceNames(options) {
    const opts = options || {};
    const force = !!opts.force;
    const staleMs = typeof opts.staleMs === 'number' ? opts.staleMs : XRAY_DEVICE_NAMES_STALE_MS;
    const now = Date.now();
    if (!force && _xrayDeviceNamesLoaded && now - _xrayDeviceNamesLastFetchAt < staleMs) {
      return _xrayDeviceNameEntries.slice();
    }

    if (_xrayDeviceNamesRequest) return _xrayDeviceNamesRequest;

    _xrayDeviceNamesRequest = (async () => {
      try {
        const data = await requestXrayDeviceNamesJson(XRAY_DEVICE_NAMES_API + '?refresh=' + (opts.router === false ? '0' : '1'));
        const changed = setXrayDeviceNamesFromPayload(data);
        // На паузе экран не трогаем — имена применятся при возобновлении.
        if (changed && opts.render !== false && !_paused) {
          try { applyXrayLogFilterToOutput(); } catch (e) {}
        }
        try { renderXrayDeviceNamesModal(data); } catch (e) {}
        return _xrayDeviceNameEntries.slice();
      } catch (e) {
        if (!opts.silent) actionToast('xray-log-devices', 'Не удалось загрузить имена устройств', 'error');
        return _xrayDeviceNameEntries.slice();
      } finally {
        _xrayDeviceNamesRequest = null;
      }
    })();

    return _xrayDeviceNamesRequest;
  }

  function ensureXrayDeviceNamesRefreshTimer() {
    if (_xrayDeviceNamesRefreshTimer) return;
    _xrayDeviceNamesRefreshTimer = setInterval(() => {
      try {
        if (isLogsViewVisible()) {
          void refreshXrayLogDeviceNames({ silent: true, staleMs: XRAY_DEVICE_NAMES_REFRESH_MS, router: true });
        }
      } catch (e) {}
    }, XRAY_DEVICE_NAMES_REFRESH_MS);
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
      btn.innerHTML = iconHtml('fullscreen-exit');
      btn.title = 'Восстановить';
      btn.setAttribute('aria-label', 'Восстановить');
    } else {
      btn.innerHTML = iconHtml('fullscreen');
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

  // Трёхуровневая лампа у заголовка «Логи Xray онлайн»:
  //   off   — тумблер «Онлайн» выключен (серая);
  //   armed — «Онлайн» включён, но сбор не идёт (зелёная ровная):
  //           поток не активен, loglevel=none или пауза;
  //   on    — идёт сбор в реальном времени (зелёная мигает):
  //           поток активен + логи включены + не на паузе.
  function computeXrayLogLampState() {
    if (!_liveWanted) return 'off';
    const logging = String(_activeLogLevel || 'none').toLowerCase() !== 'none';
    const collecting = !!_streaming && !_paused && logging;
    return collecting ? 'on' : 'armed';
  }

  function updateXrayLogLampState() {
    setXrayLogLampState(computeXrayLogLampState());
  }

  function updateXrayLogStats() {
    const dom = getXrayLogsDom();
    const runtime = readXrayLogsRuntimeState();
    renderXrayLogStatsLayer(dom, runtime);
    try { updateXrayLogLampState(); } catch (e) {}
    renderXrayLogsChrome(dom, runtime);
  }

  async function refreshXrayLogStatus() {
    try {
      const res = await fetch('/api/xray-logs/status');
      if (!res.ok) throw new Error('status http error');
      const data = await res.json().catch(() => ({}));
      const level = String(data.loglevel || 'none').toLowerCase();
      const prevLevel = String(_activeLogLevel || 'none').toLowerCase();
      const prevGaveDomains = prevLevel === 'info' || prevLevel === 'debug';
      _activeLogLevel = level;
      const nowGivesDomains = level === 'info' || level === 'debug';
      // Уровень только что поднялся до резолвящего (напр. warning→info после
      // enable/рестарта ядра): делаем свежий полный снимок error.log, иначе
      // накопленные домены не подтянутся до ручного stop+start (см. helper).
      if (nowGivesDomains && !prevGaveDomains) {
        try { rearmXrayDomainHintsForLive(); } catch (e) {}
      }
      // Лампа зависит от loglevel (сбор идёт только при loglevel≠none): при
      // включении/выключении логов (⏹/▶) обновляем её состояние.
      try { updateXrayLogLampState(); } catch (e) {}
      // Кеш доменов НЕ чистим на смене уровня: видимость доменов управляется
      // отдельным display-флагом (_xrayDomainsDisplay), а сам кеш персистентен.
      // Снятие галочки показа просто прячет домены рядом с IP,
      // не теряя накопленные домены.
      if (level === 'info' || level === 'debug') {
        // Уровень поднялся до резолвящего — снимаем debounce переустановки.
        _xrayResolveEnsurePending = false;
      }
      const state = level === 'none' ? 'off' : 'on';
      // ВАЖНО: индикатор в карточке Live логов показывает только автообновление,
      // а глобальный статус логирования отображаем в шапке (badge).
      setXrayHeaderBadgeState(state, level);

      // ВАЖНО: не "подкручиваем" селектор loglevel под текущее состояние.
      // Селектор — это *желательный* уровень для действия "▶ Включить логи".
      // Текущий активный уровень показываем в бейдже в шапке (xray-logs-badge).
      try { syncXrayLogDomainsToggle(); } catch (e) {}

      // Если пользователь хочет видеть домены и идёт Live — держим info,
      // чтобы кеш наполнялся (резолвинг). Переключение показа — отдельно.
      try { ensureXrayResolveLoglevelForLive(); } catch (e) {}
    } catch (e) {
      console.error('xray log status error', e);
      _activeLogLevel = 'none';
      // Уровень неизвестен — снимаем debounce, чтобы переустановка info могла
      // повториться на следующем успешном опросе (если enable не удался).
      _xrayResolveEnsurePending = false;
      // Do not show the badge when status is unknown.
      setXrayHeaderBadgeState('off', 'none');
      try { syncXrayLogDomainsToggle(); } catch (e2) {}
    }
  }

  // ---------- Clickable log level badges + quick filters (frontend-only) ----------

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

  async function xrayLogConnectWs2() {
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
    const wsToken = await requestXrayLogsWsToken('logs');

    if (!_streaming) return;
    if (!_useWs || !('WebSocket' in window)) {
      _useWs = false;
      return;
    }
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (!wsToken) {
      _useWs = false;
      setXrayLogUiStatus({
        phase: 'fallback',
        tone: 'warning',
        transport: 'HTTP/' + formatXrayLogPollLabel(_pollMs),
        message: 'Не удалось получить WS token, переключаюсь на HTTP-опрос.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Не удалось получить WS token, использую HTTP.';
      if (!_timer) {
        await fetchXrayLogsOnce('fallback_ws', { resetCursor: true, forceRender: true });
        _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
      }
      return;
    }

    const debugParams = new URLSearchParams();
    debugParams.set('file', file);
    debugParams.set('max_lines', String(_maxLines || DEFAULT_MAX_LINES));
    if (filter) debugParams.set('filter', filter);

    const params = new URLSearchParams(debugParams);
    params.set('token', wsToken);

    const debugUrl = proto + '//' + host + '/ws/xray-logs2?' + debugParams.toString();
    const url = proto + '//' + host + '/ws/xray-logs2?' + params.toString();

    wsDebug('WS2: connecting', { url: debugUrl, file: file, filter: !!filter });
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
        message: 'WS2 подключен. Идёт live stream.',
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
          message: 'WS2 подключен. Идёт live stream.',
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

  async function xrayLogConnectWs() {
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
    const wsToken = await requestXrayLogsWsToken('logs');

    if (!_streaming) return;
    if (!_useWs || !('WebSocket' in window)) {
      _useWs = false;
      return;
    }
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (!wsToken) {
      _useWs = false;
      setXrayLogUiStatus({
        phase: 'fallback',
        tone: 'warning',
        transport: 'HTTP/' + formatXrayLogPollLabel(_pollMs),
        message: 'Не удалось получить WS token, переключаюсь на HTTP-опрос.',
        file,
      });
      if (statusEl) statusEl.textContent = 'Не удалось получить WS token, использую HTTP.';
      if (!_timer) {
        await fetchXrayLogsOnce('fallback_ws', { resetCursor: true, forceRender: true });
        _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
      }
      return;
    }

    const debugUrl = proto + '//' + host + '/ws/xray-logs?file=' + encodeURIComponent(file) + '&max_lines=' + encodeURIComponent(String(_maxLines || DEFAULT_MAX_LINES));
    const url = debugUrl + '&token=' + encodeURIComponent(wsToken);

    wsDebug('WS: connecting', { url: debugUrl, file: file });
    setXrayLogUiStatus({
      phase: 'connecting',
      tone: 'muted',
      transport: 'WS подключение',
      message: 'Подключаю онлайн-поток WebSocket для ' + formatXrayLogFileLabel(file) + '...',
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
        message: 'Не удалось создать WebSocket, переключаюсь на HTTP-опрос.',
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
          message: 'WebSocket недоступен, переключаюсь на HTTP-опрос.',
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
        transport: 'WS повтор',
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
    try { void refreshXrayLogDeviceNames({ silent: true, staleMs: 0, router: true }); } catch (e) {}

    _liveWanted = true;
    _streaming = true;
    _paused = false;
    if (_view) _view.setFrozen(false);
    _pendingCount = 0;
    // Свежий полный снимок error.log для резолвинга доменов (после того как флаги
    // потока выставлены — rearm их проверяет). Если уровень уже info/debug —
    // домены подтянутся сразу; если пока нет, поллинг взведётся при подъёме уровня
    // (см. rearm в refreshXrayLogStatus и ensureXrayResolveLoglevelForLive ниже).
    try { rearmXrayDomainHintsForLive(); } catch (e) {}
    // Если показ доменов включён — сразу поднимаем info для резолвинга, не дожидаясь
    // фонового опроса статуса (переключение показа потом мгновенное).
    try { ensureXrayResolveLoglevelForLive(); } catch (e) {}
    try { updatePauseButton(); } catch (e) {}

    // Лампа: серая (Онлайн выкл) / ровная зелёная (Онлайн вкл, сбора нет) /
    // мигает (идёт сбор). Состояние вычисляется из _liveWanted/_streaming/уровня.
    updateXrayLogLampState();
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
        ? (_shouldUseWs2() ? 'WS2 подключение' : 'WS подключение')
        : ('HTTP/' + formatXrayLogPollLabel(_pollMs)),
      message: (_useWs && 'WebSocket' in window)
        ? ('Поднимаю онлайн-поток для ' + formatXrayLogFileLabel(_currentFile || 'access') + '...')
        : ('Запускаю HTTP-опрос для ' + formatXrayLogFileLabel(_currentFile || 'access') + '...'),
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
      message: 'Онлайн-поток идет через HTTP-опрос каждые ' + formatXrayLogPollLabel(_pollMs) + '.',
      file: _currentFile || 'access',
    });
    _timer = setInterval(() => fetchXrayLogsOnce('poll'), _pollMs);
  }

  function stopXrayLogAuto() {
    // UI: автообновление остановлено
    _streaming = false;
    _paused = false;
    if (_view) _view.setFrozen(false);
    _pendingCount = 0;
    try { updatePauseButton(); } catch (e) {}
    // Поток остановлен: если тумблер «Онлайн» всё ещё включён (напр. после ⏹
    // «Остановить логи») — лампа станет ровной зелёной (armed), а не погаснет.
    updateXrayLogLampState();
    try { setXrayHeaderBadgeState((_activeLogLevel && _activeLogLevel !== 'none') ? 'on' : 'off', _activeLogLevel || 'none'); } catch (e) {}

    // IMPORTANT: do NOT force-toggle the "Live" checkbox here.
    // The checkbox is treated as a user preference and is persisted via /api/ui-settings
    // (with a legacy localStorage fallback when the settings endpoint is unavailable).
    setXrayLogUiStatus({
      phase: 'idle',
      tone: 'muted',
      transport: '',
      message: 'Онлайн-поток остановлен.',
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

    try { stopXrayDomainHintsPolling(); } catch (e) {}
    try { syncXrayLogDomainsToggle(); } catch (e) {}
  }

  // ---------- Actions (wired from HTML) ----------

  async function xrayLogsView() {
    try { await ensureLogsViewPrefsLoadedForLogs(); } catch (e) {}
    try { void refreshXrayLogDeviceNames({ silent: true, staleMs: 0, router: true }); } catch (e) {}
    _logsUserActivated = true;
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
    const xview = ensureXrayLogView();
    if (xview) xview.setMode(xrayLogViewMode());
    setXrayLogUiStatus({
      phase: 'switching',
      tone: 'muted',
      transport: readXrayLogTransportLabel(),
      message: 'Переключаюсь на ' + formatXrayLogFileLabel(_currentFile || 'access') + '...',
      file: _currentFile || 'access',
    });
    updateLoglevelUiForCurrentFile();
    try { scheduleSaveUiState(); } catch (e) {}

    // clear buffer + redraw; preserve domain cache so hints survive the file switch
    resetXrayLogBuffer({ resetDomains: false });
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
    // In-flight guard: не запускаем второй рестарт ядра поверх текущего.
    // Повторный запрос (в т.ч. авто-подъём warning→info из
    // ensureXrayResolveLoglevelForLive) откладываем и выполняем один раз после
    // завершения текущего enable, чтобы не потерять намерение.
    if (_enableInFlight) {
      _enablePendingRerun = true;
      return;
    }
    _enableInFlight = true;
    _logsUserActivated = true;
    const enableBtn = $('xray-log-enable-btn');
    if (enableBtn) enableBtn.disabled = true;

    const statusEl = $('xray-log-status');
    setXrayLogUiStatus({
      phase: 'loading',
      tone: 'muted',
      transport: '',
      message: 'Включаю логи Xray...',
      file: _currentFile || 'access',
    });
    try {
      // Ensure we use the currently selected file.
      try { syncCurrentFileFromUi(); } catch (e) {}

      // Pick the desired loglevel from the selector (UI preference).
      const lvlSel = $('xray-log-level');
      const selected = String((lvlSel && lvlSel.value) || 'warning').toLowerCase();
      let loglevel = ALLOWED_LOGLEVELS.includes(selected) ? selected : 'warning';

      // Резолвинг доменов требует info. Если показ доменов включён и мы на
      // access.log — включаем СРАЗУ на info одним рестартом. Иначе enable шёл бы
      // на warning, а затем ensureXrayResolveLoglevelForLive делал бы ВТОРОЙ
      // рестарт (warning→info): два быстрых `xkeen -restart` подряд конфликтуют,
      // и xray остаётся на старом уровне — error.log пуст, домены молчат
      // (см. диагностику: fetch error.log size=64/lines=0 при двойном рестарте).
      if (_xrayDomainsDisplay && _isAccessFileName(_currentFile)
          && (loglevel === 'warning' || loglevel === 'error')) {
        loglevel = 'info';
        try { if (lvlSel && lvlSel.value !== 'info') lvlSel.value = 'info'; } catch (e) {}
      }

      const res = await fetch('/api/xray-logs/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loglevel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('http ' + res.status);

      const levelLabel = data.loglevel || 'warning';
      // Не рапортуем «Xray перезапущен» вслепую: бэкенд возвращает
      // xray_restarted=false, если ядро не поднялось. Показываем честный статус,
      // чтобы сбой рестарта был виден, а не маскировался «успехом».
      const coreRestarted = data.xray_restarted !== false;
      const okMessage = 'Логи включены (loglevel=' + levelLabel + '). Xray перезапущен.';
      const warnDetail = String(data.detail || '').trim();
      const warnMessage = 'Логи включены (loglevel=' + levelLabel + '), но перезапустить ядро Xray не удалось'
        + (warnDetail ? (': ' + warnDetail) : '')
        + '. Перезапустите ядро вручную.';

      setXrayLogUiStatus({
        phase: coreRestarted ? 'ready' : 'error',
        tone: coreRestarted ? 'muted' : 'error',
        transport: '',
        message: coreRestarted ? okMessage : warnMessage,
        file: _currentFile || 'access',
      });

      if (statusEl) {
        statusEl.textContent = coreRestarted ? okMessage : warnMessage;
      }
      if (!coreRestarted) {
        try { actionToast('xray-logs-enable-restart', warnMessage, 'error'); } catch (e) {}
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

      setXrayLogsLiveWanted(true, { skipRender: true });
      setXrayLogsFollowEnabled(true, { skipRender: true });
      try { scheduleSaveUiState(); } catch (e) {}
      const wantStream = true;
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
    } finally {
      _enableInFlight = false;
      if (enableBtn) enableBtn.disabled = false;
      // Догоняем отложенный запрос (напр. warning→info для резолвинга доменов),
      // вне текущего стека, чтобы рестарты не наслаивались.
      if (_enablePendingRerun) {
        _enablePendingRerun = false;
        setTimeout(() => { try { void xrayLogsEnable(); } catch (e) {} }, 0);
      }
    }
  }

  async function xrayLogsDisable() {
    // Stop auto updates immediately to keep last snapshot
    setXrayLogsLiveWanted(false, { skipRender: true });
    try { scheduleSaveUiState(); } catch (e) {}
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
      message: 'Очистить все логфайлы Xray (access.log и error.log)?',
      details: [
        'Будут очищены оба файла логов на диске (access.log и error.log), а не только видимый буфер.',
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
      // 'all' не совпадает с access/error -> бэкенд clear_logs() чистит ОБА файла
      // (access.log и error.log вместе с их *.saved снимками).
      const res = await fetch('/api/xray-logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'all' }),
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
    const xview = ensureXrayLogView();
    if (!xview) return;
    if (!xview.stats().shown) {
      actionToast('xray-logs-copy', 'Нет видимых строк', 'error');
      return;
    }
    xview.copyVisible();
  }

function updatePauseButton() {
  const btn = $('xray-log-pause');
  if (!btn) return;

  if (!_streaming) {
    btn.disabled = true;
    btn.innerHTML = `${iconHtml('pause')}<span class="xk-action-label">Пауза</span>`;
    btn.title = 'Пауза доступна только в онлайн-режиме.';
    btn.dataset.state = 'off';
    return;
  }

  btn.disabled = false;

  if (_paused) {
    const n = Math.max(0, parseInt(_pendingCount || 0, 10) || 0);
    btn.innerHTML = `${iconHtml('play')}<span class="xk-action-label">${n ? `Продолжить (+${n})` : 'Продолжить'}</span>`;
    btn.title = 'Возобновить обновление экрана (накопленные строки будут показаны).';
    btn.dataset.state = 'on';
  } else {
    btn.innerHTML = `${iconHtml('pause')}<span class="xk-action-label">Пауза</span>`;
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
  _pendingCount = 0;
  if (_view) _view.setFrozen(_paused);
  if (!_paused) applyXrayLogFilterToOutput();

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

function getXrayDeviceModalRefs() {
  return {
    modal: $('xray-devices-modal'),
    close1: $('xray-devices-close-btn'),
    close2: $('xray-devices-close-btn2'),
    refresh: $('xray-devices-refresh-btn'),
    save: $('xray-devices-save-btn'),
    ip: $('xray-devices-ip'),
    name: $('xray-devices-name'),
    list: $('xray-devices-list'),
    summary: $('xray-devices-summary'),
  };
}

function fillXrayDeviceForm(ip, name) {
  const refs = getXrayDeviceModalRefs();
  if (refs.ip) refs.ip.value = normalizeXrayDeviceIp(ip) || String(ip || '').trim();
  if (refs.name) refs.name.value = normalizeXrayDeviceName(name);
  try { if (refs.name) refs.name.focus(); } catch (e) {}
}

function renderXrayDeviceNamesModal(payload) {
  const refs = getXrayDeviceModalRefs();
  if (!refs.list && !refs.summary) return;

  const entries = _xrayDeviceNameEntries.slice();
  const manualCount = entries.filter((entry) => String(entry.source || '') === 'manual').length;
  const routerCount = entries.length - manualCount;
  const routerError = payload && typeof payload === 'object' ? String(payload.router_error || '').trim() : '';

  if (refs.summary) {
    const parts = [entries.length + ' всего'];
    if (routerCount) parts.push(routerCount + ' из роутера');
    if (manualCount) parts.push(manualCount + ' вручную');
    if (routerError && !routerCount) parts.push('роутер недоступен');
    refs.summary.textContent = parts.join(' • ');
    refs.summary.dataset.tone = routerError && !routerCount ? 'warning' : 'neutral';
  }

  if (!refs.list) return;
  if (!entries.length) {
    refs.list.dataset.state = 'empty';
    refs.list.innerHTML = '<div class="xray-devices-empty">Нет сохранённых имён устройств</div>';
    return;
  }
  refs.list.dataset.state = 'ready';

  refs.list.innerHTML = entries.map((entry) => {
    const source = xrayDeviceSourceLabel(entry.source);
    const sourceClass = String(entry.source || '') === 'manual' ? 'manual' : 'router';
    const details = [];
    if (entry.mac) details.push(entry.mac);
    if (entry.routerName && entry.routerName !== entry.name) details.push('роутер: ' + entry.routerName);
    const ipB64 = b64Encode(entry.ip);
    const nameB64 = b64Encode(entry.name);
    const deleteBtn = String(entry.source || '') === 'manual'
      ? '<button type="button" class="btn-danger xray-device-row-btn" data-action="delete" data-ip-b64="' + ipB64 + '">Удалить</button>'
      : '';
    return [
      '<div class="xray-device-row" role="listitem" data-ip-b64="' + ipB64 + '">',
      '<div class="xray-device-main">',
      '<span class="xray-device-ip">' + escapeHtml(entry.ip) + '</span>',
      '<span class="xray-device-name">' + escapeHtml(entry.name) + '</span>',
      details.length ? '<span class="xray-device-details">' + escapeHtml(details.join(' • ')) + '</span>' : '',
      '</div>',
      '<span class="xray-device-source ' + sourceClass + '">' + escapeHtml(source) + '</span>',
      '<div class="xray-device-actions">',
      '<button type="button" class="btn-secondary xray-device-row-btn" data-action="edit" data-ip-b64="' + ipB64 + '" data-name-b64="' + nameB64 + '">Править</button>',
      deleteBtn,
      '</div>',
      '</div>',
    ].join('');
  }).join('');
}

async function saveXrayDeviceNameFromModal() {
  const refs = getXrayDeviceModalRefs();
  const ip = normalizeXrayDeviceIp(refs.ip && refs.ip.value);
  const name = normalizeXrayDeviceName(refs.name && refs.name.value);
  if (!ip) {
    actionToast('xray-log-devices', 'Укажите корректный IP', 'error');
    try { if (refs.ip) refs.ip.focus(); } catch (e) {}
    return;
  }
  if (!name) {
    actionToast('xray-log-devices', 'Укажите имя устройства', 'error');
    try { if (refs.name) refs.name.focus(); } catch (e) {}
    return;
  }

  try {
    if (refs.save) refs.save.disabled = true;
    const data = await requestXrayDeviceNamesJson(XRAY_DEVICE_NAMES_API, {
      method: 'POST',
      body: JSON.stringify({ ip, name }),
    });
    setXrayDeviceNamesFromPayload(data);
    renderXrayDeviceNamesModal(data);
    applyXrayLogFilterToOutput();
    actionToast('xray-log-devices', 'Имя устройства сохранено', 'success');
  } catch (e) {
    actionToast('xray-log-devices', 'Не удалось сохранить имя устройства', 'error');
  } finally {
    if (refs.save) refs.save.disabled = false;
  }
}

async function deleteXrayDeviceNameFromModal(ip) {
  const normalized = normalizeXrayDeviceIp(ip);
  if (!normalized) return;
  const ok = await confirmAction({
    title: 'Удалить имя устройства',
    message: 'Удалить ручное имя для ' + normalized + '?',
    okText: 'Удалить',
    cancelText: 'Отмена',
    focus: 'cancel',
    danger: true,
  });
  if (!ok) return;

  try {
    const data = await requestXrayDeviceNamesJson(XRAY_DEVICE_NAMES_API + '/' + encodeURIComponent(normalized), {
      method: 'DELETE',
    });
    setXrayDeviceNamesFromPayload(data);
    renderXrayDeviceNamesModal(data);
    applyXrayLogFilterToOutput();
    actionToast('xray-log-devices', 'Имя устройства удалено', 'success');
  } catch (e) {
    actionToast('xray-log-devices', 'Не удалось удалить имя устройства', 'error');
  }
}

async function openXrayDeviceNamesModal(seed) {
  const refs = getXrayDeviceModalRefs();
  if (!refs.modal) return;
  renderXrayDeviceNamesModal();
  try { openXkeenModal(refs.modal, 'xray_log_devices', true); } catch (e) {}
  if (seed && (seed.ip || seed.name)) fillXrayDeviceForm(seed.ip, seed.name);
  void refreshXrayLogDeviceNames({ force: true, silent: true, router: true });
}

function closeXrayDeviceNamesModal() {
  const refs = getXrayDeviceModalRefs();
  if (!refs.modal) return;
  try { closeXkeenModal(refs.modal, 'xray_log_devices', false); } catch (e) {}
}

function bindXrayDeviceNamesUi() {
  const refs = getXrayDeviceModalRefs();
  const devicesBtn = $('xray-log-devices-btn');

  if (devicesBtn && !devicesBtn.dataset.bound) {
    devicesBtn.dataset.bound = '1';
    devicesBtn.addEventListener('click', (e) => {
      e.preventDefault();
      void openXrayDeviceNamesModal();
    });
  }

  [refs.close1, refs.close2].forEach((btn) => {
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      closeXrayDeviceNamesModal();
    });
  });

  if (refs.refresh && !refs.refresh.dataset.bound) {
    refs.refresh.dataset.bound = '1';
    refs.refresh.addEventListener('click', (e) => {
      e.preventDefault();
      void refreshXrayLogDeviceNames({ force: true, silent: false, router: true });
    });
  }

  if (refs.save && !refs.save.dataset.bound) {
    refs.save.dataset.bound = '1';
    refs.save.addEventListener('click', (e) => {
      e.preventDefault();
      void saveXrayDeviceNameFromModal();
    });
  }

  [refs.ip, refs.name].forEach((input) => {
    if (!input || input.dataset.xrayDeviceEnterBound) return;
    input.dataset.xrayDeviceEnterBound = '1';
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void saveXrayDeviceNameFromModal();
    });
  });

  if (refs.list && !refs.list.dataset.bound) {
    refs.list.dataset.bound = '1';
    refs.list.addEventListener('click', (e) => {
      const t = e.target;
      const btn = t && t.closest ? t.closest('[data-action]') : null;
      if (!btn || !refs.list.contains(btn)) return;
      e.preventDefault();
      const ip = b64Decode(String(btn.getAttribute('data-ip-b64') || ''));
      const action = String(btn.getAttribute('data-action') || '');
      if (action === 'edit') {
        const name = b64Decode(String(btn.getAttribute('data-name-b64') || '')) || (getXrayDeviceNameEntry(ip) || {}).name || '';
        fillXrayDeviceForm(ip, name);
      } else if (action === 'delete') {
        void deleteXrayDeviceNameFromModal(ip);
      }
    });
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
    <button type="button" class="btn-secondary dt-log-btn" id="xray-line-menu-copy">Скопировать строку</button>
    <button type="button" class="btn-secondary dt-log-btn" id="xray-line-menu-context">Контекст ±20</button>
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
  const rows = [];
  for (let i = start; i < end; i++) {
    const mark = i === center ? '▶ ' : '  ';
    const line = mark + normalizeLogLine(src[i] || '');
    lines.push(line);
    rows.push(
      '<span class="xray-context-line' + (i === center ? ' is-focus' : '') + '"' +
        (i === center ? ' data-context-focus="1"' : '') + '>' +
        escapeHtml(line) +
      '</span>'
    );
  }

  if (title) {
    const file = _currentFile || 'access';
    title.textContent = `Контекст ${file}.log · ±${r} строк`;
  }

  out.innerHTML = rows.join('');
  out.dataset.copyText = lines.join('\n');
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
  const text = String(out.dataset.copyText || out.textContent || '');
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
	  const domainsToggleBtn = $('xray-log-toggle-domains');

	  const pauseBtn = $('xray-log-pause');
	  const linesInput = $('xray-log-lines');
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
	      _logsUserActivated = true;
	      // «Продолжить» (same button on pause): only unfreeze the running stream.
	      if (_streaming && _paused) {
	        xrayLogsTogglePause();
	        return;
	      }
	      // Пуск: when Xray already writes logs, only the online stream starts;
	      // otherwise logging is enabled first (this restarts the core).
	      if (String(_activeLogLevel || 'none') !== 'none') {
	        if (_paused) xrayLogsTogglePause();
	        setXrayLogsLiveWanted(true, { skipRender: true });
	        try { scheduleSaveUiState(); } catch (e2) {}
	        void startXrayLogAuto();
	        return;
	      }
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

	  if (domainsToggleBtn) {
	    domainsToggleBtn.addEventListener('change', () => {
	      if (!!domainsToggleBtn.checked !== !!_xrayDomainsDisplay) toggleXrayLogDomainsDisplay();
	    });
	  }

	  bindXrayLogViewUi();

	  if (liveEl) {
	    _liveWanted = !!liveEl.checked;
	    liveEl.addEventListener('change', () => {
      _logsUserActivated = true;
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
	      _logsUserActivated = true;
	      try { scheduleSaveUiState(); } catch (e) {}
	      // Re-apply view filters immediately when the threshold changes.
	      try { flushXrayLogFilterApply('loglevel_change', { skipSave: true, skipWs2: true }); } catch (e) {}

      // If Xray logging is already enabled, changing loglevel should apply immediately
      // (restart only Xray core) so the user doesn't have to press ▶ manually.
      // NOTE: applies on BOTH access.log and error.log — domain hints on access.log
      // require loglevel=info in error.log, so the user must be able to raise the
      // level without first switching to the error tab.
      try {
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
      if (_view) _view.setFollow(!!followEl.checked);
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
        if (_view) _view.setMaxLines(v);
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
        try { scheduleSaveUiState(); } catch (e6) {}
      } catch (e) {}
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

  // Persist log window height once the user has dragged its resize grip.
  // A ResizeObserver also fired when the screen was merely shown, and that
  // save wrote the template defaults over the menu choices kept on the server.
  if (outputEl && !outputEl.dataset.resizeBound) {
    outputEl.dataset.resizeBound = '1';
    outputEl.addEventListener('pointerdown', () => {
      const before = outputEl.style.height;
      window.addEventListener('pointerup', () => {
        if (outputEl.style.height === before) return;
        try { scheduleSaveUiState(); } catch (e) {}
      }, { once: true });
    });
  }

  if (outputEl) {
    if (!outputEl.dataset.scrollBound) {
      outputEl.dataset.scrollBound = '1';
      outputEl.addEventListener('scroll', () => {
        scheduleXrayLogsChromeRender();
      }, { passive: true });
    }

  }

	  // Initial stats
	  try { syncXrayLogDomainsToggle(); } catch (e) {}
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

function bindXrayLogViewUi() {
  document.querySelectorAll('[data-xlog-file-btn]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const file = btn.getAttribute('data-xlog-file-btn') || 'access';
      const fileSel = $('xray-log-file');
      if (!fileSel || fileSel.value === file) return;
      fileSel.value = file;
      fileSel.dispatchEvent(new Event('change'));
    });
  });

  // Menu actions close the menu; switches and fields inside it do not.
  const morePanel = document.querySelector('#xray-log-more .xk-xlog-menu-panel');
  if (morePanel && !morePanel.dataset.bound) {
    morePanel.dataset.bound = '1';
    morePanel.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('button.xk-xlog-menu-item') : null;
      if (item) setTimeout(closeXrayMoreMenu, 0);
    });
  }

  const newLinesBtn = $('xray-log-new-lines');
  if (newLinesBtn && !newLinesBtn.dataset.bound) {
    newLinesBtn.dataset.bound = '1';
    newLinesBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (_paused) xrayLogsTogglePause();
      scrollXrayLogOutputToBottom();
      try { updateXrayLogStats(); } catch (e2) {}
    });
  }

  const rawToggle = $('xray-log-show-raw');
  if (rawToggle && !rawToggle.dataset.bound) {
    rawToggle.dataset.bound = '1';
    rawToggle.addEventListener('change', () => {
      writeXrayViewExtras({ showRaw: !!rawToggle.checked });
      const xview = ensureXrayLogView();
      if (xview) xview.setShowRaw(!!rawToggle.checked);
      try { updateXrayLogStats(); } catch (e) {}
    });
  }

  const summaryToggle = $('xray-log-show-summary');
  if (summaryToggle && !summaryToggle.dataset.bound) {
    summaryToggle.dataset.bound = '1';
    summaryToggle.addEventListener('change', () => {
      writeXrayViewExtras({ showSummary: !!summaryToggle.checked });
      syncXrayLogViewExtrasUi();
      if (_view) _view.relayout();
    });
  }

  // "/" focuses the search, as on the mockups.
  if (!document.body.dataset.xlogSlashBound) {
    document.body.dataset.xlogSlashBound = '1';
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!isLogsViewVisible()) return;
      const t = e.target;
      const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
      const filterEl = $('xray-log-filter');
      if (!filterEl) return;
      e.preventDefault();
      filterEl.focus();
      filterEl.select();
    });
  }
}

function bindFilterUi() {
    const filterEl = $('xray-log-filter');
    const clearBtn = $('xray-log-filter-clear');

    if (filterEl) {
      const syncClear = () => { if (clearBtn) clearBtn.hidden = !String(filterEl.value || '').trim(); };
      syncClear();
      filterEl.addEventListener('input', () => {
        syncClear();
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
        clearBtn.hidden = true;
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
    // Восстанавливаем кеш IP->домен из localStorage, чтобы DNS-записи
    // переживали перезагрузку страницы (баг №2).
    try { loadPersistedXrayDestinationDomains(); } catch (e) {}
    // Восстанавливаем display-флаг показа доменов (независим от Live/loglevel).
    try { loadPersistedXrayDomainsDisplay(); } catch (e) {}
    try { updateXrayLogLampState(); } catch (e) {}
    try { setXrayHeaderBadgeState((_activeLogLevel && _activeLogLevel !== 'none') ? 'on' : 'off', _activeLogLevel || 'none'); } catch (e) {}

    // Restore UI preferences for this page (file/follow/interval/lines/filter/height)
    // BEFORE wiring listeners, so we don't accidentally trigger actions.
    try { applyInitialUiStateNoFetch(); } catch (e) {}

    // Sync current file from UI (after restore)
    try { syncCurrentFileFromUi(); } catch (e) {}

    try { bindControlsUi(); } catch (e) {}
    try { bindFilterUi(); } catch (e) {}
    try { bindXrayDeviceNamesUi(); } catch (e) {}
    try { ensureXrayDeviceNamesRefreshTimer(); } catch (e) {}
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

    // Clean up polling/WS on page lifecycle transitions without blocking BFCache.
    try {
      window.addEventListener('pagehide', () => {
        // Avoid promoting untouched template defaults over synced server prefs.
        if (_logsViewPrefsUserTouched) persistLocalLogsViewDraft();
        try { stopXrayLogAuto(); } catch (e) {}
        try { if (_statusTimer) clearInterval(_statusTimer); } catch (e2) {}
        _statusTimer = null;
      });
    } catch (e) {}

    // initial status refresh (safe on pages without logs)
    try { refreshXrayLogStatus(); } catch (e) {}

    // Also poll status in background to keep the header badge up to date
    // even when the user does not open the "Логи Xray онлайн" tab.
    try {
      if (!_statusTimer) _statusTimer = setInterval(() => {
        try { void refreshXrayLogStatus(); } catch (e) {}
      }, 10000);
    } catch (e) {}

    // Refresh once when tab becomes active again
    try {
      document.addEventListener('visibilitychange', () => {
        try {
          if (document.hidden) {
            if (_logsViewPrefsUserTouched) persistLocalLogsViewDraft();
            return;
          }
          void refreshXrayLogStatus();
          if (isLogsViewVisible()) void refreshXrayLogDeviceNames({ silent: true, staleMs: XRAY_DEVICE_NAMES_STALE_MS, router: true });
        } catch (e) {}
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
