/**
 * Same-origin adapters used by the Mihomo import workbench.
 *
 * The adapter keeps endpoint transport and error normalization out of the
 * parser/controller module. It does not decide when a request is allowed or
 * mutate UI state.
 */

function normalizeError(data, fallback) {
  const raw = data && data.error;
  const message = raw && typeof raw === 'object' ? raw.message : raw;
  return String(message || fallback || 'Request failed');
}

export function createMihomoImportApi({ getCoreHttp, fetchImpl } = {}) {
  const getFetch = () => {
    if (typeof fetchImpl === 'function') return fetchImpl();
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window);
    if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
  };

  async function postJSON(path, body, options = {}) {
    const http = typeof getCoreHttp === 'function' ? getCoreHttp() : null;
    if (!http || typeof http.postJSON !== 'function') throw new Error('core http.postJSON недоступен');
    const data = await http.postJSON(path, body || {}, options || {});
    if (!data || data.ok === false) {
      const error = new Error(normalizeError(data, `${path} failed`));
      error.data = data;
      throw error;
    }
    return data;
  }

  async function requestJSON(url, options = {}) {
    const request = getFetch();
    if (!request) throw new Error('fetch недоступен');
    const init = {
      method: options.method || 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      signal: options.signal,
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body || {});
    const response = await request(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data && data.ok === false)) {
      const error = new Error(normalizeError(data, `HTTP ${response.status}`));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  return Object.freeze({ postJSON, requestJSON });
}
