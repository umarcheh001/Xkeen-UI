(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.core = XK.core || {};
  const http = (XK.core.http = XK.core.http || {});

  let _csrf = null;

  const DEFAULT_GET_RETRY = 2;
  const DEFAULT_RETRY_DELAY_MS = 250;
  const DEFAULT_RETRY_BACKOFF = 1.8;
  const MAX_RETRY_DELAY_MS = 5000;
  const MAX_ERROR_TEXT = 200;

  const RETRYABLE_STATUS = {
    408: true,
    425: true,
    429: true,
    500: true,
    502: true,
    503: true,
    504: true,
  };

  function csrfToken() {
    if (_csrf !== null) return _csrf;
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      _csrf = (el && el.getAttribute('content')) ? String(el.getAttribute('content') || '') : '';
    } catch (e) {
      _csrf = '';
    }
    return _csrf;
  }

  function normalizeMethod(method) {
    return String(method || 'GET').toUpperCase();
  }

  function isMutatingMethod(method) {
    return ['POST', 'PUT', 'DELETE', 'PATCH'].includes(normalizeMethod(method));
  }

  function withCSRF(init, methodHint) {
    const opts = init ? Object.assign({}, init) : {};

    try {
      if (typeof opts.credentials === 'undefined') opts.credentials = 'same-origin';
    } catch (e) {}

    try {
      const method = normalizeMethod(methodHint || opts.method);
      if (!isMutatingMethod(method)) return opts;

      const tok = csrfToken();
      if (!tok) return opts;

      const headers = new Headers(opts.headers || {});
      if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', tok);
      opts.headers = headers;
    } catch (e) {}

    return opts;
  }

  function _mergeInit(base, extra) {
    const a = base ? Object.assign({}, base) : {};
    const b = extra ? Object.assign({}, extra) : {};

    try {
      const ha = a.headers ? new Headers(a.headers) : new Headers();
      const hb = b.headers ? new Headers(b.headers) : null;
      if (hb) hb.forEach((v, k) => ha.set(k, v));
      a.headers = ha;
    } catch (e) {
      a.headers = Object.assign({}, (a.headers || {}), (b.headers || {}));
    }

    for (const k in b) {
      if (k === 'headers') continue;
      a[k] = b[k];
    }

    return a;
  }

  function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function timeoutMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function sleep(ms) {
    const wait = Math.max(0, asNumber(ms, 0));
    return new Promise((resolve) => setTimeout(resolve, wait));
  }

  function splitRequestOptions(init) {
    const opts = init ? Object.assign({}, init) : {};
    const policy = {
      timeoutMs: timeoutMs(opts.timeoutMs),
      retry: (typeof opts.retry === 'undefined' || opts.retry === null) ? null : Math.max(0, asNumber(opts.retry, 0)),
      retryDelayMs: Math.max(0, asNumber(opts.retryDelayMs, DEFAULT_RETRY_DELAY_MS)),
      retryBackoff: Math.max(1, asNumber(opts.retryBackoff, DEFAULT_RETRY_BACKOFF)),
      noStore: (typeof opts.noStore === 'boolean') ? opts.noStore : true,
    };

    delete opts.timeoutMs;
    delete opts.retry;
    delete opts.retryDelayMs;
    delete opts.retryBackoff;
    delete opts.noStore;

    return { fetchInit: opts, policy };
  }

  function applyNoStore(init, policy) {
    const opts = _mergeInit({}, init);
    try {
      if (policy && policy.noStore !== false && typeof opts.cache === 'undefined') {
        opts.cache = 'no-store';
      }
    } catch (e) {}
    return opts;
  }

  function buildAbortRuntime(sourceSignal, waitMs) {
    const out = {
      signal: sourceSignal || undefined,
      cleanup() {},
      didTimeout: false,
    };

    const hasTimeout = Number(waitMs) > 0;
    const hasSource = !!sourceSignal;
    if ((!hasTimeout && !hasSource) || typeof AbortController !== 'function') return out;

    const controller = new AbortController();
    let timerId = null;
    let abortHandler = null;

    if (hasSource) {
      if (sourceSignal.aborted) {
        try { controller.abort(sourceSignal.reason); } catch (e) { try { controller.abort(); } catch (e2) {} }
      } else {
        abortHandler = () => {
          try { controller.abort(sourceSignal.reason); } catch (e) { try { controller.abort(); } catch (e2) {} }
        };
        try { sourceSignal.addEventListener('abort', abortHandler, { once: true }); } catch (e) {}
      }
    }

    if (hasTimeout) {
      timerId = setTimeout(() => {
        out.didTimeout = true;
        try {
          controller.abort(new DOMException('Timeout', 'AbortError'));
        } catch (e) {
          try { controller.abort(); } catch (e2) {}
        }
      }, waitMs);
    }

    out.signal = controller.signal;
    out.cleanup = () => {
      try {
        if (timerId !== null) clearTimeout(timerId);
      } catch (e) {}
      try {
        if (hasSource && abortHandler) sourceSignal.removeEventListener('abort', abortHandler);
      } catch (e2) {}
    };
    return out;
  }

  function trimErrorText(text) {
    const src = String(text || '').trim();
    if (!src) return '';
    return src.slice(0, MAX_ERROR_TEXT);
  }

  function extractErrorMessage(data, text, status) {
    try {
      if (data && typeof data === 'object') {
        if (data.error) return String(data.error);
        if (data.message) return String(data.message);
        if (data.detail) return String(data.detail);
      }
    } catch (e) {}

    const short = trimErrorText(text);
    if (short) return short;
    if (status) return 'HTTP ' + status;
    return 'Request failed';
  }

  function makeHttpError(meta) {
    const err = new Error(String(meta && meta.message ? meta.message : 'Request failed'));
    err.name = 'XKeenHttpError';
    err.url = meta && meta.url ? String(meta.url) : '';
    err.method = normalizeMethod(meta && meta.method);
    err.status = Number(meta && meta.status ? meta.status : 0) || 0;
    err.data = (meta && Object.prototype.hasOwnProperty.call(meta, 'data')) ? meta.data : null;
    err.text = (meta && typeof meta.text === 'string') ? meta.text : '';
    err.response = meta && meta.response ? meta.response : null;
    err.isTimeout = !!(meta && meta.isTimeout);
    err.isAborted = !!(meta && meta.isAborted);
    err.isNetworkError = !!(meta && meta.isNetworkError);
    err.attempt = Number(meta && meta.attempt ? meta.attempt : 0) || 0;
    err.retryable = false;
    return err;
  }

  function normalizeError(err, meta) {
    if (err && err.name === 'XKeenHttpError') return err;

    const info = meta || {};
    const isTimeout = !!info.isTimeout || !!info.didTimeout;
    const isAborted = !isTimeout && !!(err && err.name === 'AbortError');
    let message = '';

    if (isTimeout) {
      message = 'Превышено время ожидания ответа';
    } else if (isAborted) {
      message = 'Запрос был прерван';
    } else {
      try {
        if (err && err.message) message = String(err.message);
      } catch (e) {}
    }

    if (!message) {
      message = extractErrorMessage(info.data, info.text, info.status);
    }

    return makeHttpError({
      message,
      url: info.url,
      method: info.method,
      status: info.status,
      data: info.data,
      text: info.text,
      response: info.response,
      isTimeout,
      isAborted,
      isNetworkError: !isAborted && !info.response && !info.status,
      attempt: info.attempt,
    });
  }

  function defaultRetryCount(method, explicitRetry) {
    if (explicitRetry !== null && typeof explicitRetry !== 'undefined') {
      return Math.max(0, asNumber(explicitRetry, 0));
    }
    const m = normalizeMethod(method);
    return (m === 'GET' || m === 'HEAD') ? DEFAULT_GET_RETRY : 0;
  }

  function parseRetryAfterMs(response) {
    try {
      if (!response || !response.headers || typeof response.headers.get !== 'function') return 0;
      const raw = String(response.headers.get('Retry-After') || '').trim();
      if (!raw) return 0;

      if (/^\d+$/.test(raw)) {
        return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Number(raw) * 1000));
      }

      const when = Date.parse(raw);
      if (!Number.isFinite(when)) return 0;
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, when - Date.now()));
    } catch (e) {
      return 0;
    }
  }

  function shouldRetry(method, err, attempt, maxRetries) {
    if (attempt >= maxRetries) return false;

    const m = normalizeMethod(method);
    if (m !== 'GET' && m !== 'HEAD') return false;
    if (!err) return false;
    if (err.isAborted && !err.isTimeout) return false;
    if (err.isTimeout || err.isNetworkError) return true;

    const status = Number(err.status || 0);
    return !!RETRYABLE_STATUS[status];
  }

  function retryDelayMs(err, attempt, policy) {
    const fromHeader = parseRetryAfterMs(err && err.response);
    if (fromHeader > 0) return fromHeader;

    const base = Math.max(0, asNumber(policy && policy.retryDelayMs, DEFAULT_RETRY_DELAY_MS));
    const backoff = Math.max(1, asNumber(policy && policy.retryBackoff, DEFAULT_RETRY_BACKOFF));
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(base * Math.pow(backoff, attempt)));
  }

  async function readAsText(response) {
    try {
      return await response.text();
    } catch (e) {
      return '';
    }
  }

  function parseJsonText(text) {
    const src = String(text || '');
    if (!src.trim()) return null;
    try {
      return JSON.parse(src);
    } catch (e) {
      return null;
    }
  }

  async function requestBody(url, init, parseAs) {
    const split = splitRequestOptions(init);
    const fetchInit = split.fetchInit;
    const policy = split.policy;
    const method = normalizeMethod(fetchInit.method);
    const maxRetries = defaultRetryCount(method, policy.retry);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const baseInit = applyNoStore(fetchInit, policy);
      const runtime = buildAbortRuntime(baseInit.signal, policy.timeoutMs);
      const requestInit = withCSRF(_mergeInit(baseInit, runtime.signal ? { signal: runtime.signal } : null), method);

      try {
        const response = await fetch(url, requestInit);
        const text = await readAsText(response);
        const data = (parseAs === 'json') ? parseJsonText(text) : null;

        if (!response.ok) {
          const err = makeHttpError({
            message: extractErrorMessage(data, text, response.status),
            url,
            method,
            status: response.status,
            data,
            text,
            response,
            attempt,
          });
          err.retryable = shouldRetry(method, err, attempt, maxRetries);

          if (err.retryable) {
            await sleep(retryDelayMs(err, attempt, policy));
            continue;
          }
          throw err;
        }

        return (parseAs === 'text') ? text : data;
      } catch (err) {
        const normalized = normalizeError(err, {
          url,
          method,
          didTimeout: runtime.didTimeout,
          isTimeout: runtime.didTimeout,
          attempt,
        });
        normalized.retryable = shouldRetry(method, normalized, attempt, maxRetries);

        if (normalized.retryable) {
          await sleep(retryDelayMs(normalized, attempt, policy));
          continue;
        }
        throw normalized;
      } finally {
        runtime.cleanup();
      }
    }

    throw makeHttpError({
      message: 'Request failed',
      url,
      method,
      isNetworkError: true,
    });
  }

  async function fetchJSON(url, init) {
    return requestBody(url, init, 'json');
  }

  async function fetchText(url, init) {
    return requestBody(url, init, 'text');
  }

  function sendJSON(method, url, body, init) {
    const extra = Object.assign({}, init || {}, {
      method: normalizeMethod(method),
      headers: Object.assign({ 'Content-Type': 'application/json' }, (init && init.headers ? init.headers : {})),
      body: JSON.stringify((typeof body === 'undefined') ? {} : body),
    });
    return fetchJSON(url, extra);
  }

  function postJSON(url, body, init) {
    return sendJSON('POST', url, body, init);
  }

  function patchJSON(url, body, init) {
    return sendJSON('PATCH', url, body, init);
  }

  function putJSON(url, body, init) {
    return sendJSON('PUT', url, body, init);
  }

  http.csrfToken = http.csrfToken || csrfToken;
  http.withCSRF = http.withCSRF || withCSRF;
  http.mergeInit = http.mergeInit || _mergeInit;
  http.normalizeError = http.normalizeError || normalizeError;
  http.isMutatingMethod = http.isMutatingMethod || isMutatingMethod;
  http.fetchJSON = http.fetchJSON || fetchJSON;
  http.fetchText = http.fetchText || fetchText;
  http.sendJSON = http.sendJSON || sendJSON;
  http.postJSON = http.postJSON || postJSON;
  http.patchJSON = http.patchJSON || patchJSON;
  http.putJSON = http.putJSON || putJSON;
})();
