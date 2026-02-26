(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.core = XK.core || {};
  const http = (XK.core.http = XK.core.http || {});

  let _csrf = null;

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

  function withCSRF(init, methodHint) {
    const opts = init ? Object.assign({}, init) : {};

    // Keep cookies for same-origin (Flask session)
    try {
      if (typeof opts.credentials === 'undefined') opts.credentials = 'same-origin';
    } catch (e) {}

    // Add CSRF token for mutating methods
    try {
      const method = String(methodHint || opts.method || 'GET').toUpperCase();
      if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return opts;

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

    // Merge headers
    try {
      const ha = a.headers ? new Headers(a.headers) : new Headers();
      const hb = b.headers ? new Headers(b.headers) : null;
      if (hb) hb.forEach((v, k) => ha.set(k, v));
      a.headers = ha;
    } catch (e) {
      // If Headers ctor fails for some reason, fallback to plain merge
      a.headers = Object.assign({}, (a.headers || {}), (b.headers || {}));
    }

    // Merge other props (b wins)
    for (const k in b) {
      if (k === 'headers') continue;
      a[k] = b[k];
    }

    return a;
  }

  async function fetchJSON(url, init) {
    const base = { cache: 'no-store' };
    const merged = _mergeInit(base, init);
    const opts = withCSRF(merged);

    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}

    if (!res.ok) {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + res.status);
      throw new Error(err);
    }
    return data;
  }

  async function fetchText(url, init) {
    const base = { cache: 'no-store' };
    const merged = _mergeInit(base, init);
    const opts = withCSRF(merged);

    const res = await fetch(url, opts);
    const text = await res.text().catch(() => '');

    if (!res.ok) {
      // Prefer JSON-ish error but do not attempt to parse again (may be huge)
      const err = text ? String(text).slice(0, 200) : ('HTTP ' + res.status);
      throw new Error(err);
    }
    return text;
  }

  async function postJSON(url, body, init) {
    const extra = Object.assign({}, init || {}, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, (init && init.headers ? init.headers : {})),
      body: JSON.stringify(body || {}),
    });
    return fetchJSON(url, extra);
  }

  http.csrfToken = http.csrfToken || csrfToken;
  http.withCSRF = http.withCSRF || withCSRF;
  http.fetchJSON = http.fetchJSON || fetchJSON;
  http.fetchText = http.fetchText || fetchText;
  // Convenience (not required by plan, but helps de-duplicate)
  http.postJSON = http.postJSON || postJSON;
})();
