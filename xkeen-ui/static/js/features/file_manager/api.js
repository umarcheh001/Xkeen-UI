(() => {
  'use strict';

  // File Manager API helpers (no ES modules / bundler):
  // attach to window.XKeen.features.fileManager.api.

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  const CORE_HTTP = (window.XKeen && window.XKeen.core && window.XKeen.core.http) ? window.XKeen.core.http : null;

  FM.api = FM.api || {};
  const A = FM.api;

  // -------------------------- unified error shape --------------------------
  class ApiError extends Error {
    constructor(opts) {
      const o = opts || {};
      super(String(o.message || o.code || 'error'));
      this.name = 'ApiError';
      this.code = String(o.code || 'unknown');
      this.message = String(o.message || this.message || 'Ошибка');
      this.hint = o.hint ? String(o.hint) : '';
      this.retryable = !!o.retryable;
      this.status = (o.status == null) ? null : Number(o.status);
      this.details = o.details ? String(o.details) : '';
      this.ctx = o.ctx || {};
      this.cause = o.cause;
    }
  }

  A.ApiError = A.ApiError || ApiError;

  function _codeFromStatus(status) {
    const s = Number(status || 0);
    if (!isFinite(s) || s <= 0) return 'network';
    if (s === 401) return 'unauthorized';
    if (s === 403) return 'forbidden';
    if (s === 404) return 'not_found';
    if (s === 408) return 'timeout';
    if (s === 409) return 'conflict';
    if (s === 429) return 'rate_limited';
    if (s >= 500) return 'server_error';
    return 'http_error';
  }

  function _retryableFromCode(code) {
    const c = String(code || '');
    return (c === 'network' || c === 'timeout' || c === 'server_error' || c === 'rate_limited' || c === 'remote_unavailable');
  }

  function _defaultHint(code) {
    const c = String(code || '');
    if (c === 'network') return 'Проверьте соединение и доступ к панели.';
    if (c === 'timeout') return 'Операция выполняется слишком долго. Попробуйте ещё раз.';
    if (c === 'forbidden') return 'Недостаточно прав для этой операции.';
    if (c === 'unauthorized') return 'Сессия истекла. Перезайдите в панель.';
    if (c === 'server_error') return 'Ошибка на устройстве. Проверьте логи и повторите.';
    if (c === 'remote_unavailable') return 'Проверьте доступность удалённого хоста и параметры подключения.';
    return '';
  }

  A.errorFromResponse = A.errorFromResponse || function errorFromResponse(res, data, ctx) {
    const status = (() => { try { return res ? Number(res.status || 0) : 0; } catch (e) { return 0; } })();
    const code = (() => {
      try {
        const d = data || {};
        if (d && typeof d.code === 'string' && d.code) return d.code;
        if (d && typeof d.error === 'string' && d.error) return d.error;
      } catch (e) {}
      return _codeFromStatus(status);
    })();

    const msg = (() => {
      try {
        const d = data || {};
        const m = d.message || d.error || d.detail;
        if (m) return String(m);
      } catch (e) {}
      if (status) return `HTTP ${status}`;
      return 'Ошибка сети';
    })();

    const hint = (() => {
      try {
        const d = data || {};
        const h = d.hint || d.details;
        if (h) return String(h);
      } catch (e) {}
      return _defaultHint(code);
    })();

    const retryable = (() => {
      try {
        const d = data || {};
        if (d && typeof d.retryable === 'boolean') return !!d.retryable;
      } catch (e) {}
      return _retryableFromCode(code);
    })();

    const details = (() => {
      try {
        const d = data || {};
        if (d && d.details && typeof d.details === 'string') return d.details;
      } catch (e) {}
      try {
        if (res && !res.ok) return `HTTP ${res.status}${res.statusText ? (' ' + res.statusText) : ''}`;
      } catch (e) {}
      return '';
    })();

    return new A.ApiError({ code, message: msg, hint, retryable, status, details, ctx: ctx || {} });
  };

  A.assertOk = A.assertOk || function assertOk(out, ctx) {
    const res = out ? out.res : null;
    const data = out ? out.data : null;
    if (res && res.ok && data && data.ok) return data;
    throw A.errorFromResponse(res, data, ctx);
  };

  A.fetchJsonOk = A.fetchJsonOk || async function fetchJsonOk(url, init, ctx) {
    const out = await A.fetchJson(url, init);
    return A.assertOk(out, ctx);
  };


  A.getCsrfToken = A.getCsrfToken || function getCsrfToken() {
    try {
      if (CORE_HTTP && typeof CORE_HTTP.csrfToken === 'function') return String(CORE_HTTP.csrfToken() || '');
    } catch (e) {}
    try {
      const m = document.querySelector('meta[name="csrf-token"]');
      const v = m ? (m.getAttribute('content') || '') : '';
      return String(v || '');
    } catch (e) {
      return '';
    }
  };

  A.fetchJson = A.fetchJson || async function fetchJson(url, init) {
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

    opts.headers = headers;

    // CSRF for mutating API calls (prefer core/http)
    try {
      if (CORE_HTTP && typeof CORE_HTTP.withCSRF === 'function') {
        const wrapped = CORE_HTTP.withCSRF(opts, method);
        if (wrapped) Object.assign(opts, wrapped);
      } else if (method !== 'GET' && method !== 'HEAD') {
        const tok = A.getCsrfToken();
        if (tok && !headers.get('X-CSRF-Token')) headers.set('X-CSRF-Token', tok);
      }
    } catch (e) {}

    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { res, data };
  };
})();
