import { getXkeenUiShellApi, toastXkeen } from './xkeen_runtime.js';

let updateNotifierModuleApi = null;

(() => {
  'use strict';

  // Global self-update notifier.
  // Shows an in-app indicator when a newer version is available on GitHub.
  // Works only while the web UI is open (no background push when the tab is closed).

  const api = updateNotifierModuleApi || {};
  updateNotifierModuleApi = api;

  let _inited = false;
  let _timer = null;
  let _shellUnsubscribe = null;
  let _versionSyncPromise = null;

  const LS_LAST_CHECK = 'xk_update_notify_last_check_ts';
  const LS_LAST_RESULT = 'xk_update_notify_last_result';
  const LS_LAST_TOAST = 'xk_update_notify_last_toast_latest';

  // User-configurable settings (stored in localStorage).
  // These are configured from DevTools → "Обновление панели".
  const LS_ENABLED = 'xk_update_notify_enabled';          // '1' | '0'
  const LS_INTERVAL_HOURS = 'xk_update_notify_interval_h'; // '1' | '6' | '24'

  // Defaults: enabled + check at most once per 6 hours per browser.
  const DEFAULT_INTERVAL_HOURS = 6;
  const DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000;
  const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // show cached badge up to 24h

  // Local-only build info (no GitHub network). Used to invalidate cached "update available"
  // after the panel has been updated/rolled back.
  const BUILD_INFO_URL = '/api/devtools/update/info';

  // Cross-tab soft reload signal (set by DevTools after a successful update).
  // Other open tabs will refresh and pick up new JS/CSS without requiring Ctrl+F5.
  const LS_FORCE_RELOAD = 'xk_ui_force_reload_ts';

  function _normVer(v) {
    let s = String(v || '').trim();
    if (s.toLowerCase().startsWith('v')) s = s.slice(1).trim();
    return s;
  }

  // Best-effort semver-ish compare.
  // Returns: 1 if a>b, -1 if a<b, 0 if equal/unknown.
  function _cmpSemver(a, b) {
    try {
      const pa = String(a || '').trim();
      const pb = String(b || '').trim();
      if (!pa || !pb) return 0;

      const sa = pa.split('-', 2);
      const sb = pb.split('-', 2);
      const na = sa[0].split('.').map((x) => parseInt(x, 10));
      const nb = sb[0].split('.').map((x) => parseInt(x, 10));
      const len = Math.max(na.length, nb.length, 3);
      for (let i = 0; i < len; i++) {
        const va = (i < na.length && isFinite(na[i])) ? na[i] : 0;
        const vb = (i < nb.length && isFinite(nb[i])) ? nb[i] : 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
      }

      // Numeric equal; handle prerelease: 1.0.0 > 1.0.0-rc1
      const ra = (sa.length > 1) ? String(sa[1] || '') : '';
      const rb = (sb.length > 1) ? String(sb[1] || '') : '';
      if (!ra && rb) return 1;
      if (ra && !rb) return -1;
      if (ra && rb) {
        if (ra > rb) return 1;
        if (ra < rb) return -1;
      }
      return 0;
    } catch (e) {
      return 0;
    }
  }

  function _reloadWithCacheBust() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('_', String(Date.now()));
      // replace() avoids growing history on repeated reload requests
      window.location.replace(u.toString());
    } catch (e) {
      try { window.location.reload(); } catch (e2) {}
    }
  }

  function _clampIntervalHours(v) {
    const n = Number(v);
    if (n === 1 || n === 6 || n === 24) return n;
    return DEFAULT_INTERVAL_HOURS;
  }

  function _readSettings() {
    let enabled = true;
    let hours = DEFAULT_INTERVAL_HOURS;
    try {
      const rawE = String(window.localStorage.getItem(LS_ENABLED) || '').trim();
      if (rawE === '0') enabled = false;
      if (rawE === '1') enabled = true;
    } catch (e) {}
    try {
      const rawH = String(window.localStorage.getItem(LS_INTERVAL_HOURS) || '').trim();
      if (rawH) hours = _clampIntervalHours(rawH);
    } catch (e) {}
    const intervalMs = Math.max(60 * 1000, hours * 60 * 60 * 1000);
    return { enabled, intervalHours: hours, intervalMs };
  }

  function _writeSettings(s) {
    if (!s || typeof s !== 'object') return;
    try {
      if (typeof s.enabled === 'boolean') window.localStorage.setItem(LS_ENABLED, s.enabled ? '1' : '0');
    } catch (e) {}
    try {
      if (s.intervalHours != null) window.localStorage.setItem(LS_INTERVAL_HOURS, String(_clampIntervalHours(s.intervalHours)));
    } catch (e) {}
  }

  function _now() {
    return Date.now();
  }

  function _safeJsonParse(s) {
    try {
      return JSON.parse(String(s || ''));
    } catch (e) {
      return null;
    }
  }

  function _getUpdateLinkEl() {
    try {
      return document.getElementById('xk-update-link');
    } catch (e) {
      return null;
    }
  }

  function _getUiShellApi() {
    return getXkeenUiShellApi();
  }

  function _readUpdateState() {
    const api = _getUiShellApi();
    if (!api) return { visible: false, hasUpdate: false, label: '', title: '' };
    const shell = api.getState();
    const update = shell && shell.update && typeof shell.update === 'object' ? shell.update : {};
    return {
      visible: !!update.visible,
      hasUpdate: !!update.hasUpdate,
      label: String(update.label || ''),
      title: String(update.title || ''),
    };
  }

  function _readVersionState() {
    const api = _getUiShellApi();
    if (!api) {
      return {
        currentLabel: '',
        currentCommit: '',
        currentBuiltAt: '',
        latestLabel: '',
        latestPublishedAt: '',
        channel: '',
      };
    }
    const shell = api.getState();
    const version = shell && shell.version && typeof shell.version === 'object' ? shell.version : {};
    return {
      currentLabel: String(version.currentLabel || ''),
      currentCommit: String(version.currentCommit || ''),
      currentBuiltAt: String(version.currentBuiltAt || ''),
      latestLabel: String(version.latestLabel || ''),
      latestPublishedAt: String(version.latestPublishedAt || ''),
      channel: String(version.channel || ''),
    };
  }

  function _setUpdateLoadingState(isLoading) {
    const api = _getUiShellApi();
    if (!api) return;
    try {
      api.patchState({
        loading: {
          update: !!isLoading,
        },
      }, {
        source: 'update_notifier_loading',
      });
    } catch (e) {}
  }

  function _renderLinkState({ visible, hasUpdate, label, title }) {
    const el = _getUpdateLinkEl();
    if (!el) return;

    try {
      if (!visible) {
        el.classList.add('hidden');
      } else {
        el.classList.remove('hidden');
      }
    } catch (e) {}

    try {
      if (hasUpdate) el.classList.add('xk-update-available');
      else el.classList.remove('xk-update-available');
    } catch (e) {}

    try {
      if (title) el.title = String(title);
      else if (label) el.title = 'Доступно обновление: ' + String(label);
      else el.title = 'Обновление';
    } catch (e) {}

    try {
      const lbl = el.querySelector('[data-xk-update-label]');
      if (lbl) {
        lbl.textContent = label ? ('Обновление ' + String(label)) : 'Обновление';
      }
    } catch (e) {}
  }

  function _ensureShellBinding() {
    if (_shellUnsubscribe) return;

    const api = _getUiShellApi();
    if (!api || typeof api.subscribe !== 'function') {
      _renderLinkState(_readUpdateState());
      return;
    }

    _shellUnsubscribe = api.subscribe((next) => {
      const update = next && next.update && typeof next.update === 'object' ? next.update : {};
      _renderLinkState({
        visible: !!update.visible,
        hasUpdate: !!update.hasUpdate,
        label: String(update.label || ''),
        title: String(update.title || ''),
      });
    }, { immediate: true });
  }

  function _setShellState(patch, source) {
    const api = _getUiShellApi();
    if (api) {
      api.patchState(patch || {}, {
        source: source || 'update_notifier',
      });
      return;
    }

    if (patch && patch.update) {
      const update = patch.update;
      _renderLinkState({
        visible: !!update.visible,
        hasUpdate: !!update.hasUpdate,
        label: String(update.label || ''),
        title: String(update.title || ''),
      });
    }
  }

  function _setVersionState(versionPatch, source) {
    if (!versionPatch || typeof versionPatch !== 'object') return;
    _setShellState({ version: versionPatch }, source || 'update_notifier_version');
  }

  function _setLinkState({ visible, hasUpdate, label, versionPatch }) {
    const title = label ? ('Доступно обновление: ' + String(label)) : 'Обновление';
    const patch = {
      update: {
        visible: !!visible,
        hasUpdate: !!hasUpdate,
        label: String(label || ''),
        title,
      },
    };
    if (versionPatch && typeof versionPatch === 'object') {
      patch.version = versionPatch;
    }
    _setShellState(patch, 'update_notifier');
  }

  function _toastOncePerLatest(latestLabel) {
    if (!latestLabel) return;

    try {
      const last = String(window.localStorage.getItem(LS_LAST_TOAST) || '');
      if (last === String(latestLabel)) return;
    } catch (e) {}

    try {
      toastXkeen('Доступно обновление: ' + String(latestLabel) + ' — откройте DevTools → Обновление', 'info');
    } catch (e) {}

    try {
      window.localStorage.setItem(LS_LAST_TOAST, String(latestLabel));
    } catch (e) {}
  }

  function _extractLatestLabel(data) {
    try {
      const ch = String((data && data.channel) || '').toLowerCase();
      const latest = data && data.latest && typeof data.latest === 'object' ? data.latest : null;
      if (!latest) return '';
      if (ch === 'main') {
        return String(latest.short_sha || latest.sha || '').trim();
      }
      return String(latest.tag || '').trim();
    } catch (e) {
      return '';
    }
  }

  function _extractLatestPublishedAt(data) {
    try {
      const latest = data && data.latest && typeof data.latest === 'object' ? data.latest : null;
      if (!latest) return '';
      return String(latest.published_at || latest.created_at || latest.date || '').trim();
    } catch (e) {
      return '';
    }
  }

  function _syncVersionFromPayload(data, extra) {
    const current = _readVersionState();
    const o = extra && typeof extra === 'object' ? extra : {};
    let curVer = current.currentLabel;
    let curCommit = current.currentCommit;
    let curBuiltAt = current.currentBuiltAt;

    try {
      const payloadCurrent = data && data.current && typeof data.current === 'object' ? data.current : {};
      curVer = String(payloadCurrent.version || curVer || '').trim();
      curCommit = String(payloadCurrent.commit || curCommit || '').trim();
      curBuiltAt = String(payloadCurrent.built_utc || curBuiltAt || '').trim();
    } catch (e) {}

    const latestLabel = Object.prototype.hasOwnProperty.call(o, 'latestLabel')
      ? String(o.latestLabel || '').trim()
      : (_extractLatestLabel(data) || current.latestLabel);
    const latestPublishedAt = Object.prototype.hasOwnProperty.call(o, 'latestPublishedAt')
      ? String(o.latestPublishedAt || '').trim()
      : (_extractLatestPublishedAt(data) || current.latestPublishedAt);
    const channel = Object.prototype.hasOwnProperty.call(o, 'channel')
      ? String(o.channel || '').trim()
      : String((data && data.channel) || current.channel || '').trim();

    _setVersionState({
      currentLabel: curVer,
      currentCommit: curCommit,
      currentBuiltAt: curBuiltAt,
      latestLabel,
      latestPublishedAt,
      channel,
    }, 'update_notifier_payload');

    return {
      currentLabel: curVer,
      currentCommit: curCommit,
      currentBuiltAt: curBuiltAt,
      latestLabel,
      latestPublishedAt,
      channel,
    };
  }

  function _syncVersionFromBuildInfo(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (_versionSyncPromise && !o.force) return _versionSyncPromise;

    _versionSyncPromise = (async () => {
      try {
        const { ok, data } = await _getJSON(BUILD_INFO_URL, 1200);
        if (!ok || !data || !data.ok) return _readVersionState();

        const build = data && data.build && typeof data.build === 'object' ? data.build : {};
        const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {};
        const current = _readVersionState();
        const next = {
          currentLabel: String(build.version || current.currentLabel || '').trim(),
          currentCommit: String(build.commit || current.currentCommit || '').trim(),
          currentBuiltAt: String(build.built_utc || current.currentBuiltAt || '').trim(),
          latestLabel: Object.prototype.hasOwnProperty.call(o, 'latestLabel')
            ? String(o.latestLabel || '').trim()
            : current.latestLabel,
          latestPublishedAt: Object.prototype.hasOwnProperty.call(o, 'latestPublishedAt')
            ? String(o.latestPublishedAt || '').trim()
            : current.latestPublishedAt,
          channel: String(build.channel || settings.channel || current.channel || '').trim(),
        };

        _setVersionState(next, 'update_notifier_build_info');
        return next;
      } catch (e) {
        return _readVersionState();
      } finally {
        _versionSyncPromise = null;
      }
    })();

    return _versionSyncPromise;
  }

  function _getCsrfToken() {
    try {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (!meta) return '';
      return String(meta.getAttribute('content') || '').trim();
    } catch (e) {
      return '';
    }
  }

  async function _postJSON(url, body, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs || 3500)));
    try {
      const headers = { 'Content-Type': 'application/json' };
      const csrf = _getCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(url, {
        cache: 'no-store',
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = {};
      }
      return { ok: res.ok, data };
    } finally {
      clearTimeout(t);
    }
  }

  async function _getJSON(url, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs || 1200)));
    try {
      const res = await fetch(url, { cache: 'no-store', method: 'GET', signal: controller.signal });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = {};
      }
      return { ok: res.ok, data };
    } finally {
      clearTimeout(t);
    }
  }

  function _loadCachedResult() {
    try {
      const raw = window.localStorage.getItem(LS_LAST_RESULT);
      const d = _safeJsonParse(raw);
      if (!d || typeof d !== 'object') return null;
      const ts = Number(d.ts || 0);
      if (!ts || (_now() - ts) > DEFAULT_CACHE_MAX_AGE_MS) return null;
      return d;
    } catch (e) {
      return null;
    }
  }

  function _saveCachedResult(obj) {
    try {
      window.localStorage.setItem(LS_LAST_RESULT, JSON.stringify(obj || {}));
    } catch (e) {}
  }

  function _shouldCheckNow(intervalMs) {
    const ms = Math.max(30 * 1000, Number(intervalMs || DEFAULT_INTERVAL_MS));
    try {
      const last = Number(window.localStorage.getItem(LS_LAST_CHECK) || 0);
      if (!last) return true;
      return (_now() - last) >= ms;
    } catch (e) {
      return true;
    }
  }

  function _markCheckedNow() {
    try {
      window.localStorage.setItem(LS_LAST_CHECK, String(_now()));
    } catch (e) {}
  }

  async function _checkOnce({ silent }) {
    const linkEl = _getUpdateLinkEl();
    if (!linkEl) return;

    // Mark the attempt early so we don't hammer the API on flaky networks.
    _markCheckedNow();

    try {
      const { ok, data } = await _postJSON(
        '/api/devtools/update/check',
        { force_refresh: false, wait_seconds: 0.8 },
        4500
      );

      const has = !!(ok && data && data.ok && data.update_available);
      const latestLabel = _extractLatestLabel(data);
      const latestPublishedAt = _extractLatestPublishedAt(data);

      // Cache also the *current* build fingerprint so we can invalidate stale badges
      // after an update/rollback even if GitHub is unreachable.
      let curVer = '';
      let curCommit = '';
      let curBuiltAt = '';
      try {
        const cur = (data && data.current && typeof data.current === 'object') ? data.current : {};
        curVer = String(cur.version || '').trim();
        curCommit = String(cur.commit || '').trim();
        curBuiltAt = String(cur.built_utc || '').trim();
      } catch (e) {}

      _saveCachedResult({ ts: _now(), has_update: has, latest: latestLabel || '', channel: String((data && data.channel) || ''), cur_ver: curVer, cur_commit: curCommit });
      _syncVersionFromPayload(data, {
        latestLabel,
        latestPublishedAt,
        channel: String((data && data.channel) || '').trim(),
      });

      if (has) {
        _setLinkState({
          visible: true,
          hasUpdate: true,
          label: latestLabel || '',
          versionPatch: {
            currentLabel: curVer,
            currentCommit: curCommit,
            currentBuiltAt: curBuiltAt,
            latestLabel: latestLabel || '',
            latestPublishedAt,
            channel: String((data && data.channel) || '').trim(),
          },
        });
        if (!silent) _toastOncePerLatest(latestLabel || '');
      } else {
        // No update: hide the pill.
        _setLinkState({
          visible: false,
          hasUpdate: false,
          label: '',
          versionPatch: {
            currentLabel: curVer,
            currentCommit: curCommit,
            currentBuiltAt: curBuiltAt,
            latestLabel: latestLabel || '',
            latestPublishedAt,
            channel: String((data && data.channel) || '').trim(),
          },
        });
      }
    } catch (e) {
      // Network errors are expected on some networks; do not annoy the user.
      // Keep any cached state (badge) intact.
    } finally {
      _setUpdateLoadingState(false);
    }
  }

  function _schedule(intervalMs) {
    const ms = Math.max(60 * 1000, Number(intervalMs || DEFAULT_INTERVAL_MS));
    try {
      if (_timer) clearInterval(_timer);
    } catch (e) {}
    _timer = setInterval(() => {
      // Do not show toast for background checks; just update badge.
      _checkOnce({ silent: true }).catch(() => {});
    }, ms);
  }

  function _stopSchedule() {
    try {
      if (_timer) clearInterval(_timer);
    } catch (e) {}
    _timer = null;
  }

  function _applySettings() {
    const s = _readSettings();
    let hasResolvedVisualState = false;
    _setUpdateLoadingState(true);
    void _syncVersionFromBuildInfo();

    // If disabled: hide indicator and stop polling.
    if (!s.enabled) {
      _stopSchedule();
      _setLinkState({ visible: false, hasUpdate: false, label: '' });
      _setUpdateLoadingState(false);
      return s;
    }

    // Show cached badge ASAP.
    const cached = _loadCachedResult();
    if (cached && cached.has_update) {
      hasResolvedVisualState = true;
      _setLinkState({
        visible: true,
        hasUpdate: true,
        label: cached.latest || '',
        versionPatch: {
          latestLabel: String(cached.latest || '').trim(),
          channel: String(cached.channel || '').trim(),
        },
      });
      void _syncVersionFromBuildInfo({
        latestLabel: String(cached.latest || '').trim(),
        channel: String(cached.channel || '').trim(),
      });
      _setUpdateLoadingState(false);

      // Common complaint: after updating the panel, the cached badge may stay visible
      // until the next scheduled check (default 6h) or if GitHub is unreachable.
      // Try to clear it using *local* build info (no GitHub network).
      try {
        (async () => {
          const { ok, data } = await _getJSON(BUILD_INFO_URL, 1200);
          if (!ok || !data || !data.ok) return;
          const build = (data && data.build && typeof data.build === 'object') ? data.build : {};
          const localVer = String(build.version || '').trim();
          const localCommit = String(build.commit || '').trim();
          const ch = String(cached.channel || '').toLowerCase();
          const latest = String(cached.latest || '').trim();

          // If user updated to a *newer* build than the cached "latest" (e.g. manual install,
          // switching channels, or hotfix builds), don't keep a stale badge around.
          // For stable we can do a semver-ish compare; for main we can't reliably order commits.
          let localIsNewerOrEqual = false;
          if (ch !== 'main') {
            const lv = _normVer(localVer);
            const lt = _normVer(latest);
            if (lv && lt) {
              const c = _cmpSemver(lv, lt);
              localIsNewerOrEqual = (c >= 0);
            }
          }

          let upToDate = false;
          if (ch === 'main') {
            // cached.latest is usually short sha; compare prefix.
            if (latest && localCommit) {
              upToDate = String(localCommit).startsWith(String(latest));
            }
          } else {
            // stable: cached.latest is a tag like v1.4.6
            if (latest && localVer) {
              upToDate = _normVer(localVer) === _normVer(latest);
              if (!upToDate && localIsNewerOrEqual) upToDate = true;
            }
          }

          if (upToDate) {
            _saveCachedResult({ ts: _now(), has_update: false, latest: '', channel: ch, cur_ver: localVer, cur_commit: localCommit });
            _setLinkState({
              visible: false,
              hasUpdate: false,
              label: '',
              versionPatch: {
                currentLabel: localVer,
                currentCommit: localCommit,
                latestLabel: '',
                latestPublishedAt: '',
                channel: ch,
              },
            });
            // Also allow an immediate re-check later (e.g. if a newer release appears soon).
            try { window.localStorage.removeItem(LS_LAST_CHECK); } catch (e) {}
            return;
          }

          // If still flagged, verify quickly even if interval hasn't elapsed.
          _checkOnce({ silent: true }).catch(() => {});
        })().catch(() => {});
      } catch (e) {}
    } else {
      _setLinkState({ visible: false, hasUpdate: false, label: '' });
      hasResolvedVisualState = !!cached;
      _setUpdateLoadingState(false);
    }

    // Immediate check if needed.
    if (_shouldCheckNow(s.intervalMs)) {
      if (!hasResolvedVisualState) _setUpdateLoadingState(true);
      _checkOnce({ silent: false }).catch(() => {});
    } else {
      _setUpdateLoadingState(false);
    }

    // Background polling while UI is open.
    _schedule(s.intervalMs);
    return s;
  }

  // Public helper for other modules (e.g. DevTools update runner UI).
  api.resetCache = function resetCache() {
    try { window.localStorage.removeItem(LS_LAST_RESULT); } catch (e) {}
    try { window.localStorage.removeItem(LS_LAST_CHECK); } catch (e) {}
    try { window.localStorage.removeItem(LS_LAST_TOAST); } catch (e) {}
    try {
      _setLinkState({
        visible: false,
        hasUpdate: false,
        label: '',
        versionPatch: {
          latestLabel: '',
          latestPublishedAt: '',
        },
      });
    } catch (e) {}
    _setUpdateLoadingState(false);
  };

  api.init = function init(opts) {
    if (_inited) return;
    _inited = true;

    const linkEl = _getUpdateLinkEl();
    if (!linkEl) return; // page doesn't have the indicator

    _ensureShellBinding();

    // Allow one-off override, but prefer stored settings.
    const s = _readSettings();
    if (opts && typeof opts.enabled === 'boolean') s.enabled = !!opts.enabled;
    if (opts && (opts.intervalHours != null)) s.intervalHours = _clampIntervalHours(opts.intervalHours);
    if (opts && (opts.intervalMs != null)) s.intervalMs = Math.max(60 * 1000, Number(opts.intervalMs));

    // Persist overrides (if provided), then apply.
    if (opts && (Object.prototype.hasOwnProperty.call(opts, 'enabled') || Object.prototype.hasOwnProperty.call(opts, 'intervalHours') || Object.prototype.hasOwnProperty.call(opts, 'intervalMs'))) {
      _writeSettings({ enabled: s.enabled, intervalHours: s.intervalHours });
    }

    _applySettings();
  };

  api.getSettings = function getSettings() {
    return _readSettings();
  };

  api.setSettings = function setSettings(s) {
    _writeSettings(s);
    return _applySettings();
  };

  api.applySettings = function applySettings() {
    return _applySettings();
  };

  api.getVersionState = function getVersionState() {
    return _readVersionState();
  };

  api.refreshVersionInfo = function refreshVersionInfo(opts) {
    return _syncVersionFromBuildInfo(Object.assign({ force: true }, opts || {}));
  };

  api.checkNow = async function checkNow(opts) {
    try { await _syncVersionFromBuildInfo(); } catch (e) {}
    await _checkOnce({
      silent: !!(opts && opts.silent),
    });
    return {
      update: _readUpdateState(),
      version: _readVersionState(),
    };
  };

  // Sync settings across multiple open tabs.
  try {
    window.addEventListener('storage', (ev) => {
      const k = ev && ev.key ? String(ev.key) : '';
      // DevTools broadcasts this after a successful update so other open tabs
      // will refresh and pick up new assets.
      if (k === LS_FORCE_RELOAD) {
        _reloadWithCacheBust();
        return;
      }
      if (k === LS_ENABLED || k === LS_INTERVAL_HOURS) {
        if (_inited) _applySettings();
      }
    });
  } catch (e) {}

  // Auto-init when included (safe on pages without the header pill).
  function _autoInit() {
    try {
      api.init({});
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }
})();
export function getUpdateNotifierApi() {
  try {
    return updateNotifierModuleApi;
  } catch (error) {
    return null;
  }
}

function callUpdateNotifierApi(method, ...args) {
  const api = getUpdateNotifierApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initUpdateNotifier(...args) {
  return callUpdateNotifierApi('init', ...args);
}

export function getUpdateNotifierSettings(...args) {
  return callUpdateNotifierApi('getSettings', ...args);
}

export function setUpdateNotifierSettings(...args) {
  return callUpdateNotifierApi('setSettings', ...args);
}

export function applyUpdateNotifierSettings(...args) {
  return callUpdateNotifierApi('applySettings', ...args);
}

export function getUpdateNotifierVersionState(...args) {
  return callUpdateNotifierApi('getVersionState', ...args);
}

export function refreshUpdateNotifierVersionInfo(...args) {
  return callUpdateNotifierApi('refreshVersionInfo', ...args);
}

export function checkForUpdateNow(...args) {
  return callUpdateNotifierApi('checkNow', ...args);
}

export function resetUpdateNotifierCache(...args) {
  return callUpdateNotifierApi('resetCache', ...args);
}

export const updateNotifierApi = Object.freeze({
  get: getUpdateNotifierApi,
  init: initUpdateNotifier,
  getSettings: getUpdateNotifierSettings,
  setSettings: setUpdateNotifierSettings,
  applySettings: applyUpdateNotifierSettings,
  getVersionState: getUpdateNotifierVersionState,
  refreshVersionInfo: refreshUpdateNotifierVersionInfo,
  checkNow: checkForUpdateNow,
  resetCache: resetUpdateNotifierCache,
});
