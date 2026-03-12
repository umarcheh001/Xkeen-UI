/*
  routing_cards/common.js
  Shared helpers for routing_cards modules.

  RC-03
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.state = RC.state || {};
  RC.common = RC.common || {};

  const C = RC.common;

  C.$ = function (id) {
    return document.getElementById(id);
  };

  C.toast = function (msg, isErr) {
    try {
      if (XK.ui && typeof XK.ui.toast === 'function') {
        XK.ui.toast(String(msg || ''), isErr ? 'error' : 'info');
        return;
      }
    } catch (e) {}
    try {
      // Fallback
      // eslint-disable-next-line no-alert
      alert(String(msg || ''));
    } catch (e) {}
  };

  C.confirmModal = async function (opts) {
    try {
      if (XK.ui && typeof XK.ui.confirm === 'function') {
        return await XK.ui.confirm(opts || {});
      }
    } catch (e) {}
    const msg = String((opts && (opts.message || opts.text)) || 'Confirm?');
    // eslint-disable-next-line no-restricted-globals
    return confirm(msg);
  };

  C.safeJsonParse = function (text) {
    try {
      // Prefer shared helper (handles JSONC)
      if (XK.util && typeof XK.util.stripJsonComments === 'function') {
        return JSON.parse(XK.util.stripJsonComments(text));
      }
    } catch (e) {}

    // Best-effort JSONC stripping (simple)
    try {
      const cleaned = String(text || '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return JSON.parse(cleaned);
    } catch (e) {
      return { __error: e };
    }
  };

  C.editorInstance = function () {
    try {
      if (XK.state && XK.state.routingEditor) return XK.state.routingEditor;
    } catch (e) {}
    return null;
  };

  C.getEditorText = function () {
    const cm = C.editorInstance();
    if (cm && typeof cm.getValue === 'function') return cm.getValue();
    const ta = C.$('routing-editor');
    return ta ? ta.value : '';
  };

  C.setEditorText = function (text) {
    const cm = C.editorInstance();
    if (cm && typeof cm.setValue === 'function') {
      cm.setValue(String(text || ''));
      return;
    }
    const ta = C.$('routing-editor');
    if (ta) ta.value = String(text || '');
  };

  C.isViewVisible = function () {
    const v = document.getElementById('view-routing');
    if (!v) return false;
    const st = window.getComputedStyle(v);
    return st && st.display !== 'none' && st.visibility !== 'hidden';
  };

  C.debounce = function (fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait || 0);
    };
  };

  C.getActiveOutboundsFragment = function () {
    try {
      const sel = document.getElementById('outbounds-fragment-select');
      if (sel && sel.value) return String(sel.value);
    } catch (e) {}
    try {
      if (XK.state && XK.state.fragments && XK.state.fragments.outbounds) {
        return String(XK.state.fragments.outbounds);
      }
    } catch (e) {}
    try {
      const v = localStorage.getItem('xkeen.outbounds.fragment');
      if (v) return String(v);
    } catch (e) {}
    return '';
  };

  C.buildOutboundTagsUrl = function () {
    let url = '/api/xray/outbound-tags';
    try {
      const file = C.getActiveOutboundsFragment();
      if (file) url += '?file=' + encodeURIComponent(String(file));
    } catch (e) {}
    return url;
  };

  function formatApplyCounts(label, stats) {
    const s = stats || {};
    const added = Number(s.added || 0);
    const changed = Number(s.changed || 0);
    const removed = Number(s.removed || 0);
    const inserted = !!s.inserted;
    if (!inserted && added === 0 && changed === 0 && removed === 0) return null;
    return `${label} +${added} ~${changed} -${removed}${inserted ? ' (вставлен ключ)' : ''}`;
  }

  function formatDomainStrategyAction(action) {
    const a = String(action || '');
    if (a === 'replaced') return 'изменён';
    if (a === 'inserted') return 'добавлен';
    if (a === 'removed') return 'удалён';
    return '';
  }

  C.buildApplyPreviewLine = function (preview) {
    const p = preview || {};
    const parts = [];
    const r = formatApplyCounts('rules', p.rules);
    if (r) parts.push(r);
    const b = formatApplyCounts('balancers', p.balancers);
    if (b) parts.push(b);
    const ds = formatDomainStrategyAction(p.domainStrategy);
    if (ds) parts.push(`domainStrategy ${ds}`);
    if (!parts.length) return '';
    return `Изменения: ${parts.join('; ')}`;
  };


// --- Unified debug flag (query ?debug=1 + localStorage) ---
function _queryFlag(name) {
  try {
    const qs = new URLSearchParams(String(window.location && window.location.search ? window.location.search : ''));
    if (!qs.has(name)) return null;
    const v = String(qs.get(name) || '').toLowerCase();
    if (v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return true;
  } catch (e) {
    return null;
  }
}

C.isDebugEnabled = function () {
  const q = _queryFlag('debug');
  if (q !== null) return !!q;
  try {
    const k = (RC.LS_KEYS && RC.LS_KEYS.jsoncDebug) ? RC.LS_KEYS.jsoncDebug : 'xk.routing.jsonc.debug';
    return String((localStorage && localStorage.getItem && localStorage.getItem(k)) || '') === '1';
  } catch (e) {
    return false;
  }
};

// Optional helper: persist debug flag into localStorage (same key as JSONC debug).
C.setDebugEnabled = function (enabled) {
  try {
    const k = (RC.LS_KEYS && RC.LS_KEYS.jsoncDebug) ? RC.LS_KEYS.jsoncDebug : 'xk.routing.jsonc.debug';
    if (!localStorage || !localStorage.setItem) return;
    localStorage.setItem(k, enabled ? '1' : '0');
  } catch (e) {}
};

// --- Unified error UX (normalize + render) ---
C.escapeHtml = function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

function _codeFromStatus(status) {
  const st = Number(status);
  if (!isFinite(st) || st <= 0) return 'network';
  if (st === 401) return 'unauthorized';
  if (st === 403) return 'forbidden';
  if (st === 404) return 'not_found';
  if (st === 408) return 'timeout';
  if (st === 409) return 'conflict';
  if (st === 429) return 'rate_limited';
  if (st >= 500) return 'server_error';
  return 'http_error';
}

function _retryableFromCode(code) {
  const c = String(code || '');
  return (c === 'network' || c === 'timeout' || c === 'server_error' || c === 'rate_limited');
}

function _defaultHint(code) {
  const c = String(code || '');
  if (c === 'json_parse') return 'Проверьте синтаксис JSON в редакторе.';
  if (c === 'network') return 'Проверьте соединение и доступ к панели.';
  if (c === 'timeout') return 'Операция выполняется слишком долго. Попробуйте ещё раз.';
  if (c === 'unauthorized') return 'Сессия истекла. Перезайдите в панель.';
  if (c === 'forbidden') return 'Недостаточно прав для этой операции.';
  if (c === 'server_error') return 'Ошибка на устройстве. Проверьте логи и повторите.';
  return '';
}

// Normalize various error shapes to {code,message,hint,retryable,details,status}
C.normalizeError = function (err, ctx) {
  if (!err) return { code: 'unknown', message: 'Неизвестная ошибка', hint: _defaultHint('unknown'), retryable: false, details: '', ctx: ctx || {} };

  // Already normalized-ish
  try {
    if (err && typeof err === 'object' && (err.code || err.message || err.hint || err.retryable != null)) {
      const code = String(err.code || 'unknown');
      const msg = String(err.message || err.error || 'Ошибка');
      const hint = String(err.hint || _defaultHint(code) || '');
      const retryable = (err.retryable != null) ? !!err.retryable : _retryableFromCode(code);
      const details = String(err.details || '');
      const status = (err.status == null) ? null : Number(err.status);
      return { code, message: msg, hint, retryable, details, status, ctx: (err.ctx || ctx || {}) };
    }
  } catch (e) {}

  // fetchJson-like {res,data}
  try {
    if (err && typeof err === 'object' && ('res' in err) && ('data' in err)) {
      const res = err.res;
      const data = err.data || {};
      const status = (() => { try { return res ? Number(res.status || 0) : 0; } catch (e) { return 0; } })();
      const code = (() => {
        try {
          if (data && typeof data.code === 'string' && data.code) return data.code;
          if (data && typeof data.error === 'string' && data.error) return data.error;
        } catch (e) {}
        return _codeFromStatus(status);
      })();
      const msg = (() => {
        try {
          const m = data.message || data.error || data.detail;
          if (m) return String(m);
        } catch (e) {}
        return status ? `HTTP ${status}` : 'Ошибка сети';
      })();
      const hint = (() => {
        try {
          const h = data.hint || data.details;
          if (h) return String(h);
        } catch (e) {}
        return _defaultHint(code);
      })();
      const retryable = (() => {
        try { if (typeof data.retryable === 'boolean') return !!data.retryable; } catch (e) {}
        return _retryableFromCode(code);
      })();
      const details = (() => {
        try { if (data && typeof data.details === 'string') return data.details; } catch (e) {}
        try { if (res && !res.ok) return `HTTP ${res.status}${res.statusText ? (' ' + res.statusText) : ''}`; } catch (e) {}
        return '';
      })();
      return { code, message: msg, hint, retryable, details, status: status || null, ctx: ctx || {} };
    }
  } catch (e) {}

  // Plain Error
  try {
    if (err && typeof err === 'object' && (err.message || err.name)) {
      const msg = String(err.message || 'Ошибка');
      const isJson = (err instanceof SyntaxError) || /Unexpected token|JSON/.test(msg);
      const code = String(err.code || (msg.includes('Failed to fetch') ? 'network' : (isJson ? 'json_parse' : 'unknown')));
      const hint = String(err.hint || _defaultHint(code) || '');
      const retryable = (err.retryable != null) ? !!err.retryable : _retryableFromCode(code);
      const details = String(err.details || '');
      const status = (err.status == null) ? null : Number(err.status);
      return { code, message: (isJson && !String(err.code || '') ? ('Ошибка JSON: ' + msg) : msg), hint, retryable, details, status, ctx: ctx || {} };
    }
  } catch (e) {}

  // String
  return { code: 'unknown', message: String(err), hint: _defaultHint('unknown'), retryable: false, details: '', ctx: ctx || {} };
};

// Render a compact error block. opts:
//  - title: string
//  - onRetry: function
//  - retryText: string
//  - showCode: boolean (default true)
//  - compact: boolean
C.renderError = function (err, opts) {
  const o = opts || {};
  const ae = C.normalizeError(err, o.ctx);

  const box = document.createElement('div');
  box.className = 'xk-error-box' + (o.compact ? ' is-compact' : '');
  const title = String(o.title || 'Ошибка');
  const msg = C.escapeHtml(ae.message || 'Ошибка');
  const hint = ae.hint ? C.escapeHtml(ae.hint) : '';
  const details = ae.details ? C.escapeHtml(ae.details) : '';
  const code = C.escapeHtml(ae.code || 'unknown');

  const parts = [];
  parts.push(`<div class="xk-error-title">${C.escapeHtml(title)}</div>`);
  parts.push(`<div class="xk-error-msg">${msg}</div>`);
  if (hint) parts.push(`<div class="xk-error-hint">${hint}</div>`);
  if (details) parts.push(`<div class="xk-error-details"><code>${details}</code></div>`);
  if (o.showCode !== false) parts.push(`<div class="xk-error-code">code: <code>${code}</code></div>`);
  parts.push('<div class="xk-error-actions"></div>');
  box.innerHTML = parts.join('');

  const actions = box.querySelector('.xk-error-actions');
  const retryable = !!ae.retryable;
  const onRetry = (typeof o.onRetry === 'function') ? o.onRetry : null;
  if (actions && retryable && onRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary xk-error-retry';
    btn.textContent = String(o.retryText || 'Повторить');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      try { onRetry(ae); } catch (e2) {}
    });
    actions.appendChild(btn);
  }

  return box;
};
})();
