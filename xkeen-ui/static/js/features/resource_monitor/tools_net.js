// Requests of the tool tabs. One request per tab at a time is the tab's own business;
// here only the transport: a timeout, the window's abort signal, the CSRF header.

export const REQUEST_TIMEOUT_MS = 12000;

function withCsrf(init) {
  let requestInit = init;
  try {
    const coreHttp = window.XKeen?.core?.http;
    if (typeof coreHttp?.withCSRF === "function") {
      requestInit = coreHttp.withCSRF(requestInit, requestInit.method || "GET");
    } else if (String(requestInit.method || "GET").toUpperCase() !== "GET") {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
      const headers = new Headers(requestInit.headers || {});
      if (token && !headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", token);
      requestInit.headers = headers;
    }
  } catch (error) {
    // the server answers if it needs the token
  }
  return requestInit;
}

// Resolves with { ok, status, data }; rejects on a network error, an abort or a timeout
// (error.timedOut is set for the last one).
export async function requestJson(url, { method = "GET", signal = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const init = withCsrf({ method, cache: "no-store", credentials: "same-origin", signal: controller.signal });
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("timeout");
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function isAborted(signal) {
  return Boolean(signal?.aborted);
}
