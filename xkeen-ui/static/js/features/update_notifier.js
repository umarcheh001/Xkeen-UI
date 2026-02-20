(() => {
  'use strict';

  // Global self-update notifier.
  // Shows an in-app indicator when a newer version is available on GitHub.
  // Works only while the web UI is open (no background push when the tab is closed).

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const api = (XK.features.updateNotifier = XK.features.updateNotifier || {});

  let _inited = false;
  let _timer = null;

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

  function _setLinkState({ visible, hasUpdate, label }) {
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
      if (label) el.title = 'Доступно обновление: ' + String(label);
      else el.title = 'Обновление';
    } catch (e) {}

    try {
      const lbl = el.querySelector('[data-xk-update-label]');
      if (lbl) {
        lbl.textContent = label ? ('Обновление ' + String(label)) : 'Обновление';
      }
    } catch (e) {}
  }

  function _toastOncePerLatest(latestLabel) {
    if (!latestLabel) return;

    try {
      const last = String(window.localStorage.getItem(LS_LAST_TOAST) || '');
      if (last === String(latestLabel)) return;
    } catch (e) {}

    try {
      if (typeof window.showToast === 'function') {
        window.showToast('Доступно обновление: ' + String(latestLabel) + ' — откройте DevTools → Обновление', 'info');
      } else if (XK && XK.ui && typeof XK.ui.showToast === 'function') {
        XK.ui.showToast('Доступно обновление: ' + String(latestLabel) + ' — откройте DevTools → Обновление', 'info');
      }
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

  async function _postJSON(url, body, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs || 3500)));
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      _saveCachedResult({ ts: _now(), has_update: has, latest: latestLabel || '', channel: String((data && data.channel) || '') });

      if (has) {
        _setLinkState({ visible: true, hasUpdate: true, label: latestLabel || '' });
        if (!silent) _toastOncePerLatest(latestLabel || '');
      } else {
        // No update: hide the pill.
        _setLinkState({ visible: false, hasUpdate: false, label: '' });
      }
    } catch (e) {
      // Network errors are expected on some networks; do not annoy the user.
      // Keep any cached state (badge) intact.
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

    // If disabled: hide indicator and stop polling.
    if (!s.enabled) {
      _stopSchedule();
      _setLinkState({ visible: false, hasUpdate: false, label: '' });
      return s;
    }

    // Show cached badge ASAP.
    const cached = _loadCachedResult();
    if (cached && cached.has_update) {
      _setLinkState({ visible: true, hasUpdate: true, label: cached.latest || '' });
    } else {
      _setLinkState({ visible: false, hasUpdate: false, label: '' });
    }

    // Immediate check if needed.
    if (_shouldCheckNow(s.intervalMs)) {
      _checkOnce({ silent: false }).catch(() => {});
    }

    // Background polling while UI is open.
    _schedule(s.intervalMs);
    return s;
  }

  api.init = function init(opts) {
    if (_inited) return;
    _inited = true;

    const linkEl = _getUpdateLinkEl();
    if (!linkEl) return; // page doesn't have the indicator

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

  // Sync settings across multiple open tabs.
  try {
    window.addEventListener('storage', (ev) => {
      const k = ev && ev.key ? String(ev.key) : '';
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
