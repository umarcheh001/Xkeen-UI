import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager unified error UX (normalize + present)
  // attach to the shared file manager namespace.errors

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();
  const C = FM.common || {};
  const A = FM.api || {};
  const P = FM.progress || {};

  FM.errors = FM.errors || {};
  const E = FM.errors;

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function _toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
    return undefined;
  }

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
      this.cause = o.cause;
    }
  }

  // Prefer api.js-exported ApiError if available, but keep this as a fallback.
  try { if (A && A.ApiError && typeof A.ApiError === 'function') E.ApiError = A.ApiError; } catch (e) {}
  E.ApiError = E.ApiError || ApiError;

  function _codeFromStatus(status) {
    const s = Number(status);
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

  // Build ApiError from fetchJson {res,data}
  E.fromResponse = function fromResponse(res, data, ctx) {
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

    const Err = E.ApiError;
    const ae = new Err({ code, message: msg, hint, retryable, status, details, ctx });
    try { ae.ctx = ctx || {}; } catch (e) {}
    return ae;
  };

  E.normalize = function normalize(err, ctx) {
    if (!err) return new E.ApiError({ code: 'unknown', message: 'Неизвестная ошибка', hint: _defaultHint('unknown'), retryable: false, ctx });

    // Already normalized
    try {
      if (err instanceof E.ApiError) {
        try { if (!err.hint) err.hint = _defaultHint(err.code); } catch (e) {}
        try { if (err.retryable == null) err.retryable = _retryableFromCode(err.code); } catch (e) {}
        try { err.ctx = err.ctx || ctx || {}; } catch (e) {}
        return err;
      }
    } catch (e) {}

    // fetchJson-like object
    try {
      if (err && typeof err === 'object' && ('res' in err) && ('data' in err)) {
        return E.fromResponse(err.res, err.data, ctx);
      }
    } catch (e) {}

    // Plain Error
    try {
      if (err && typeof err === 'object' && (err.message || err.name)) {
        const msg = String(err.message || 'Ошибка');
        const code = (String(err.code || '') || (msg.includes('Failed to fetch') ? 'network' : 'unknown'));
        const retryable = (err.retryable != null) ? !!err.retryable : _retryableFromCode(code);
        const hint = String(err.hint || _defaultHint(code) || '');
        const details = String(err.details || '');
        const Err = E.ApiError;
        const ae = new Err({ code, message: msg, hint, retryable, status: (err.status == null ? null : err.status), details, cause: err, ctx });
        try { ae.ctx = ctx || {}; } catch (e) {}
        return ae;
      }
    } catch (e) {}

    // String
    const Err = E.ApiError;
    return new Err({ code: 'unknown', message: String(err), hint: _defaultHint('unknown'), retryable: false, ctx });
  };

  function _setPanelError(side, errObj) {
    const S = _S();
    if (!S || !S.panels) return;
    const p = S.panels[side];
    if (!p) return;
    try { p.error = errObj || null; } catch (e) {}
  }

  E.clearPanelError = function clearPanelError(side) {
    _setPanelError(side, null);
  };

  // opts:
  //  - place: 'toast' | 'panel' | 'progress'
  //  - side: 'left'|'right' for panel
  //  - action: string
  //  - retry: function
  E.present = function present(err, opts) {
    const o = opts || {};
    const place = String(o.place || 'toast');
    const side = (o.side === 'right') ? 'right' : ((o.side === 'left') ? 'left' : null);
    const action = String(o.action || '');

    const ae = E.normalize(err, Object.assign({}, o.ctx || {}, action ? { action } : {}));

    if (place === 'panel' && side) {
      _setPanelError(side, {
        code: ae.code,
        message: ae.message,
        hint: ae.hint,
        retryable: !!ae.retryable,
        details: ae.details,
      });

      // Best-effort rerender.
      try { if (FM.render && typeof FM.render.renderPanel === 'function') FM.render.renderPanel(side); } catch (e) {}
      return;
    }

    if (place === 'progress') {
      // Put error into existing progress modal.
      try {
        if (P && typeof P.setUi === 'function') {
          P.setUi({
            errorText: ae.message,
            detailsText: ae.details || ae.hint || '',
          });
        }
      } catch (e) {}
      // Also toast small hint if it helps.
      if (o.toast !== false) {
        const msg = ae.hint ? (ae.message + ' — ' + ae.hint) : ae.message;
        _toast(msg, 'error');
      }
      return;
    }

    // default: toast
    const msg = (() => {
      const m = ae.message || 'Ошибка';
      if (ae.hint) return m + ' — ' + ae.hint;
      return m;
    })();
    _toast(msg, 'error');
  };

})();
