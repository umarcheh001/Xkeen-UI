(() => {
  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};

  // ---------- Global XKeen overlay spinner (moved out of main.js, step 3) ----------
  // Uses #global-xkeen-spinner and #global-xkeen-spinner-text if present.

  const state = (XKeen.state = XKeen.state || {});
  if (typeof state.spinnerDepth !== 'number') state.spinnerDepth = 0;

  function showGlobalXkeenSpinner(message) {
    const overlay = document.getElementById('global-xkeen-spinner');
    if (!overlay) return;

    const textEl = document.getElementById('global-xkeen-spinner-text');
    if (textEl && message) {
      textEl.textContent = message;
    }

    state.spinnerDepth += 1;
    overlay.classList.add('is-active');
  }

  function hideGlobalXkeenSpinner() {
    const overlay = document.getElementById('global-xkeen-spinner');
    if (!overlay) return;

    state.spinnerDepth = Math.max(0, state.spinnerDepth - 1);
    if (state.spinnerDepth === 0) {
      overlay.classList.remove('is-active');
    }
  }

  XKeen.ui.showGlobalXkeenSpinner = XKeen.ui.showGlobalXkeenSpinner || showGlobalXkeenSpinner;
  XKeen.ui.hideGlobalXkeenSpinner = XKeen.ui.hideGlobalXkeenSpinner || hideGlobalXkeenSpinner;

  // ---------- fetch() wrapper: CSRF + spinner for restart-ish actions (moved out of main.js) ----------
  if (window.__xkeen_fetch_spinner_patched) return;
  window.__xkeen_fetch_spinner_patched = true;

  // Read token once (meta is in <head> so OK even before DOMContentLoaded)
  const CSRF_TOKEN = (() => {
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      return (el && el.getAttribute('content')) ? el.getAttribute('content') : '';
    } catch (e) {
      return '';
    }
  })();

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;

  function parseUrl(url) {
    try {
      return new URL(url, window.location.origin);
    } catch (e) {
      return null;
    }
  }

  function bodyHasRestartFlag(body) {
    if (!body) return false;
    try {
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        return !!parsed.restart;
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  function shouldShowSpinner(url, init) {
    if (!url) return null;

    const method = (init && init.method ? String(init.method).toUpperCase() : 'GET');
    const loc = parseUrl(url);
    const path = loc ? loc.pathname : url;
    const searchParams = loc ? loc.searchParams : null;
    const body = init && init.body;

    // Explicit start / restart endpoints
    if (path === '/api/xkeen/start' && method === 'POST') {
      return { message: 'Запуск xkeen...' };
    }
    if ((path === '/api/restart' || path === '/api/restart-xkeen') && method === 'POST') {
      return { message: 'Перезапуск xkeen...' };
    }

    // Routing save with optional restart arg (?restart=1/0/true/false)
    if (path === '/api/routing' && method === 'POST') {
      let restart = true;
      if (searchParams && searchParams.has('restart')) {
        const v = String(searchParams.get('restart') || '').trim().toLowerCase();
        restart = ['1', 'true', 'yes', 'on', 'y'].includes(v);
      }
      if (restart) {
        return { message: 'Применение routing и перезапуск xkeen...' };
      }
      return null;
    }

    // Mihomo config / inbounds / outbounds with JSON body { ..., restart: true }
    if (
      (path === '/api/mihomo-config' ||
       path === '/api/inbounds' ||
       path === '/api/outbounds') &&
      method === 'POST'
    ) {
      if (bodyHasRestartFlag(body)) {
        return { message: 'Применение настроек и перезапуск xkeen...' };
      }
      return null;
    }

    // Generator apply endpoint
    if (path === '/api/mihomo/generate_apply' && method === 'POST') {
      return { message: 'Применение профиля и перезапуск xkeen...' };
    }

    // Xray logs enable/disable restarts ONLY Xray core (no xkeen-ui restart)
    if ((path === '/api/xray-logs/enable' || path === '/api/xray-logs/disable') && method === 'POST') {
      return { message: 'Применение настроек логов и перезапуск Xray...' };
    }

    // xkeen *.lst endpoints (restart controlled by JSON body.restart; backend defaults restart=true)
    if (
      (path === '/api/xkeen/port-proxying' ||
       path === '/api/xkeen/port-exclude' ||
       path === '/api/xkeen/ip-exclude') &&
      method === 'POST'
    ) {
      let restart = true;
      try {
        if (typeof body === 'string' && body.trim()) {
          const parsed = JSON.parse(body);
          if (Object.prototype.hasOwnProperty.call(parsed, 'restart')) restart = !!parsed.restart;
        }
      } catch (e) {}
      if (restart) return { message: 'Применение настроек и перезапуск xkeen...' };
      return null;
    }

    // Mihomo profile activate always restarts
    if (method === 'POST' && typeof path === 'string' &&
        path.startsWith('/api/mihomo/profiles/') && path.endsWith('/activate')) {
      return { message: 'Активация профиля и перезапуск xkeen...' };
    }

    // Mihomo backup restore always restarts
    if (method === 'POST' && typeof path === 'string' &&
        path.startsWith('/api/mihomo/backups/') && path.endsWith('/restore')) {
      return { message: 'Восстановление бэкапа и перезапуск xkeen...' };
    }

    // Core switch implies restart
    if (path === '/api/xkeen/core' && method === 'POST') {
      return { message: 'Смена ядра и перезапуск xkeen...' };
    }

    return null;
  }

    function restartToastMessageForUrl(url) {
    const loc = parseUrl(url);
    const path = loc ? loc.pathname : String(url || '');
    try {
      // Fixed endpoints
      if (path === '/api/routing') return 'Routing сохранён и xkeen перезапущен.';
      if (path === '/api/inbounds') return 'Inbounds сохранены и xkeen перезапущен.';
      if (path === '/api/outbounds') return 'Outbounds сохранены и xkeen перезапущен.';
      if (path === '/api/mihomo-config') return 'config.yaml сохранён и xkeen перезапущен.';
      if (path === '/api/mihomo/generate_apply') return 'Конфиг применён и xkeen перезапущен.';

      if (path === '/api/xkeen/port-proxying') return 'port_proxying.lst сохранён и xkeen перезапущен.';
      if (path === '/api/xkeen/port-exclude') return 'port_exclude.lst сохранён и xkeen перезапущен.';
      if (path === '/api/xkeen/ip-exclude') return 'ip_exclude.lst сохранён и xkeen перезапущен.';

      if (path === '/api/xray-logs/enable') return 'Логи Xray включены и Xray перезапущен.';
      if (path === '/api/xray-logs/disable') return 'Логи Xray выключены и Xray перезапущен.';

      if (path === '/api/xkeen/core') return 'Ядро переключено и xkeen перезапущен.';

      // Pattern endpoints
      if (typeof path === 'string' && path.startsWith('/api/mihomo/profiles/') && path.endsWith('/activate')) {
        const parts = path.split('/').filter(Boolean);
        const nameEnc = parts.length >= 4 ? parts[3] : '';
        let name = nameEnc;
        try { name = decodeURIComponent(nameEnc); } catch (e) {}
        if (name) return 'Профиль ' + name + ' активирован и xkeen перезапущен.';
        return 'Профиль активирован и xkeen перезапущен.';
      }

      if (typeof path === 'string' && path.startsWith('/api/mihomo/backups/') && path.endsWith('/restore')) {
        return 'Бэкап восстановлен и xkeen перезапущен.';
      }

      if (path === '/api/restart' || path === '/api/restart-xkeen') return 'xkeen перезапущен.';
    } catch (e) {}

    return 'xkeen перезапущен.';
  }

  function handleXkeenRestartFromResponse(url, response) {
    if (!response || !response.headers || typeof response.clone !== 'function') return;

    const ct = response.headers.get && response.headers.get('Content-Type')
      ? String(response.headers.get('Content-Type') || '')
      : '';
    if (!ct || ct.indexOf('application/json') === -1) {
      return;
    }

    try {
      response.clone().json().then(function (data) {
        if (!data || !data.restarted) return;

        // Unified "restart + context" toast to avoid duplicates across modules.
        const msg = restartToastMessageForUrl(url);

        if (typeof window.showToast === 'function') {
          window.showToast(msg, false);
        } else if (XKeen.ui && typeof XKeen.ui.showToast === 'function') {
          XKeen.ui.showToast(msg, false);
        }
      }).catch(function () {
        // ignore JSON parse errors
      });
    } catch (e) {
      // ignore runtime errors
    }
  }

  // Show a toast when ONLY Xray core has been restarted (no xkeen-ui restart).
  function handleXrayRestartFromResponse(url, response) {
    if (!response || !response.headers || typeof response.clone !== 'function') return;

    const ct = response.headers.get && response.headers.get('Content-Type')
      ? String(response.headers.get('Content-Type') || '')
      : '';
    if (!ct || ct.indexOf('application/json') === -1) return;

    try {
      response.clone().json().then(function (data) {
        if (!data || !data.xray_restarted) return;

        const msg = restartToastMessageForUrl(url) || 'Xray перезапущен.';
        if (typeof window.showToast === 'function') {
          window.showToast(msg, false);
        } else if (XKeen.ui && typeof XKeen.ui.showToast === 'function') {
          XKeen.ui.showToast(msg, false);
        }
      }).catch(function () {});
    } catch (e) {
      // ignore
    }
  }

  function injectCsrfAndCredentials(input, init) {
    const opts = init ? Object.assign({}, init) : {};

    try {
      const method = String(opts.method || (input && input.method) || 'GET').toUpperCase();

      // Ensure cookies are sent to same-origin endpoints
      if (typeof opts.credentials === 'undefined') {
        opts.credentials = 'same-origin';
      }

      // Add CSRF token for mutating requests
      if (CSRF_TOKEN && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        // Merge headers from init + (Request input) if present
        const baseHeaders = opts.headers || (input && input.headers ? input.headers : undefined);
        const headers = new Headers(baseHeaders || {});
        if (!headers.has('X-CSRF-Token')) {
          headers.set('X-CSRF-Token', CSRF_TOKEN);
        }
        opts.headers = headers;
      }
    } catch (e) {
      // ignore
    }

    return opts;
  }

  window.fetch = function (input, init) {
    const url = (typeof input === 'string')
      ? input
      : (input && input.url ? input.url : '');

    const spinnerConfig = shouldShowSpinner(url, init);
    const opts = injectCsrfAndCredentials(input, init);

    if (!spinnerConfig) {
      return origFetch(input, opts).then(function (res) {
        try { handleXkeenRestartFromResponse(url, res); } catch (e) {}
        try { handleXrayRestartFromResponse(url, res); } catch (e) {}
        return res;
      });
    }

    showGlobalXkeenSpinner(spinnerConfig.message);

    return origFetch(input, opts)
      .then(function (res) {
        hideGlobalXkeenSpinner();
        try { handleXkeenRestartFromResponse(url, res); } catch (e) {}
        try { handleXrayRestartFromResponse(url, res); } catch (e) {}
        return res;
      })
      .catch(function (err) {
        hideGlobalXkeenSpinner();
        throw err;
      });
  };
})();
