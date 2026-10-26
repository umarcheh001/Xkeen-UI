const BASE = '/api/modules';

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
}

function normalizedError(code, message, status = 0) {
  return { code: String(code || 'module_request_failed'), message: String(message || 'Не удалось выполнить запрос.'), status };
}

// The questions the window asks again and again — how an operation or a
// preparation goes. One sent while the panel restarts may get neither an
// answer nor an error over a tunnel; after this long it counts as a lost
// connection, and the window asks again instead of waiting for ever.
export const POLL_TIMEOUT_MS = 10000;

export function createModuleLifecycleClient(fetchImpl = fetch) {
  async function request(path, method = 'GET', body, { timeoutMs = 0 } = {}) {
    const headers = { 'Cache-Control': 'no-store' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken()) headers['X-CSRF-Token'] = csrfToken();
    const abort = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), timeoutMs) : null;
    let response;
    let payload;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(abort ? { signal: abort.signal } : {}),
      });
      payload = await response.json();
    } catch (error) {
      if (!response || abort?.signal.aborted) throw normalizedError('network_error', 'Не удалось связаться с сервером.');
      throw normalizedError('invalid_response', 'Сервер вернул некорректный ответ.', response.status);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw normalizedError('invalid_response', 'Сервер вернул некорректный ответ.', response.status);
    }
    if (!response.ok || payload.ok === false) {
      throw normalizedError(payload.code, payload.message || payload.error, response.status);
    }
    return payload;
  }

  return {
    loadInstalled: () => request('/installed'),
    loadUpdateChannel: () => request('/update-channel'),
    setUpdateChannel: (channel) => request('/update-channel', 'POST', { channel }),
    loadStatus: () => request('/operations/status', 'GET', undefined, { timeoutMs: POLL_TIMEOUT_MS }),
    loadAvailable: () => request('/available'),
    checkPanelUpdate: (forceRefresh = false) => request(
      '/panel/update-check',
      'POST',
      { force_refresh: Boolean(forceRefresh) },
    ),
    plan: (operation, moduleId) => request('/operations/plan', 'POST', { operation, ...(moduleId ? { module_id: moduleId } : {}) }),
    // A panel update is prepared in the background; its plan comes with the end.
    startPanelPrepare: () => request('/panel/prepare', 'POST', {}),
    loadPanelPrepare: (prepareId) => request(`/panel/prepare/${encodeURIComponent(prepareId)}`, 'GET', undefined, { timeoutMs: POLL_TIMEOUT_MS }),
    cancelPanelPrepare: (prepareId) => request(`/panel/prepare/${encodeURIComponent(prepareId)}/cancel`, 'POST', {}),
    apply: (operation, moduleId, planId) => request('/operations/apply', 'POST', { operation, ...(moduleId ? { module_id: moduleId } : {}), plan_id: planId }),
    cancel: (operationId) => request(`/operations/${encodeURIComponent(operationId)}/cancel`, 'POST'),
    recover: () => request('/recovery', 'POST'),
    restart: () => request('/restart', 'POST'),
    setModuleEnabled: (moduleId, enabled) => request(`/${encodeURIComponent(moduleId)}`, 'PATCH', { enabled }),
    setEditorVariant: (variant) => request('/editor', 'PATCH', { variant }),
  };
}
