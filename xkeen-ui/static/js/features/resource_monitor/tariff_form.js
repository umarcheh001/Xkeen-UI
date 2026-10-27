// The tariff form of one internet connection (inside the diagnostics window).
//
// Two fields (upload, download, Mbit/s), a hint from the connection's own history,
// and the save through the existing ui-settings patch `diagnostics.tariffs[<id>]`.
// The server decides what a valid speed is: this form rejects only what is not an
// integer, and shows the server's message under the field it is about.

const SETTINGS_ENDPOINT = "/api/ui-settings";
const NOT_INTEGER = "Введите целое число: скорость тарифа в Мбит/с";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// "" -> { value: null } (no tariff in that direction), "100" -> { value: 100 }, else an error.
export function parseSpeed(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { value: null };
  if (!/^\d+$/.test(raw)) return { error: NOT_INTEGER };
  return { value: Number(raw) };
}

function withCsrf(init) {
  let requestInit = init;
  try {
    const coreHttp = window.XKeen?.core?.http;
    if (typeof coreHttp?.withCSRF === "function") {
      requestInit = coreHttp.withCSRF(requestInit, requestInit.method || "GET");
    } else {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
      const headers = new Headers(requestInit.headers || {});
      if (token && !headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", token);
      requestInit.headers = headers;
    }
  } catch (error) {
    // the request goes without the helper; the server answers if it needs the token
  }
  return requestInit;
}

// -> { ok: true } or { ok: false, errors: { up, down, form } } with ready messages.
export async function saveTariff(connectionId, up, down) {
  const body = { diagnostics: { tariffs: { [connectionId]: { up_mbps: up, down_mbps: down } } } };
  let response;
  let payload = {};
  try {
    response = await fetch(SETTINGS_ENDPOINT, withCsrf({
      method: "PATCH",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, errors: { form: "Не удалось связаться с роутером. Попробуйте ещё раз." } };
  }
  if (response.ok && payload?.ok !== false) return { ok: true };
  const errors = {};
  for (const item of payload?.errors || []) {
    const path = String(item?.path || "");
    const text = String(item?.error || "");
    if (!text) continue;
    if (path.endsWith(".up_mbps")) errors.up = errors.up || text;
    else if (path.endsWith(".down_mbps")) errors.down = errors.down || text;
    else errors.form = errors.form || text;
  }
  if (!errors.up && !errors.down && !errors.form) errors.form = "Не удалось сохранить тариф.";
  return { ok: false, errors };
}

// Speeds the connection really reached in the last day: { up_mbps, down_mbps } or null.
export function tariffPeaks(history24, connectionId) {
  const peak = (name) => {
    let top = null;
    for (const v of history24?.metrics?.[name]?.max || []) if (typeof v === "number" && (top == null || v > top)) top = v;
    return top;
  };
  const up = peak(`rate_up:${connectionId}`);
  const down = peak(`rate_down:${connectionId}`);
  return up == null && down == null ? null : { up_mbps: up, down_mbps: down };
}

// opts: { link: { id, label, tariff }, peaks, onSaved(), onClose() }
export function mountTariffForm(host, opts) {
  const { link, peaks } = opts;
  const tariff = link.tariff || {};
  const hint = peaks && peaks.up_mbps != null && peaks.down_mbps != null
    ? `за сутки приём доходил до ${Math.round(peaks.down_mbps)} Мбит/с, отдача до ${Math.round(peaks.up_mbps)} — проверьте, верно ли указан тариф`
    : "Скорость по договору с провайдером. Пустое поле — тариф для этого направления не задан.";
  host.hidden = false;
  host.innerHTML = `<form class="xkt" novalidate>
    <div class="xkt-title">Тариф · ${esc(link.label)}</div>
    <div class="xkt-hint">${esc(hint)}</div>
    <div class="xkt-fields">
      <label class="xkt-field"><span>Отдача, Мбит/с</span><input name="up" inputmode="numeric" autocomplete="off" value="${esc(tariff.up_mbps ?? "")}"><span class="xkt-error" data-for="up"></span></label>
      <label class="xkt-field"><span>Приём, Мбит/с</span><input name="down" inputmode="numeric" autocomplete="off" value="${esc(tariff.down_mbps ?? "")}"><span class="xkt-error" data-for="down"></span></label>
    </div>
    <div class="xkt-error" data-for="form"></div>
    <div class="xkt-actions"><button type="submit" class="xkc-b primary">Сохранить</button><button type="button" class="xkc-b" data-cancel>Отмена</button></div>
  </form>`;
  const form = host.querySelector("form");
  const field = (name) => form.elements[name];
  const errorOf = (name) => form.querySelector(`[data-for="${name}"]`);
  const showErrors = (errors) => {
    for (const name of ["up", "down", "form"]) {
      const text = errors?.[name] || "";
      errorOf(name).textContent = text;
      if (name !== "form") field(name).setAttribute("aria-invalid", text ? "true" : "false");
    }
  };
  const close = () => {
    host.hidden = true;
    host.innerHTML = "";
    opts.onClose?.();
  };
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  });
  form.querySelector("[data-cancel]").addEventListener("click", close);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const up = parseSpeed(field("up").value);
    const down = parseSpeed(field("down").value);
    if (up.error || down.error) {
      showErrors({ up: up.error, down: down.error });
      return;
    }
    showErrors({});
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    const result = await saveTariff(link.id, up.value, down.value);
    submit.disabled = false;
    if (!result.ok) {
      showErrors(result.errors);
      return;
    }
    close();
    opts.onSaved?.();
  });
  field("up").focus();
  return { close };
}
