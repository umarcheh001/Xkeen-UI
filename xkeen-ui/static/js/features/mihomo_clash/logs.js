import {
  mihomoClashLogsWsUrl,
  requestMihomoClashWsToken,
  fetchMihomoClashGroups,
} from "./client.js";
import { createMihomoLogModel } from "./log_model.js";
import { createMihomoLogView } from "./log_view.js";
import { mihomoLogRowText } from "./log_export.js";

const SETTINGS = "xkeen:mihomo-clash-log-settings:v1";
const model = createMihomoLogModel();
let root = null,
  view = null,
  active = false,
  stopped = true,
  generation = 0,
  socket = null,
  controller = null;
let reconnectTimer = 0,
  reconnectAttempt = 0,
  renderFrame = 0,
  statsTimer = 0;
let level = "all",
  localLevel = "all",
  capabilities = {},
  runtime = {},
  summaryOpen = false;
const visuals = new Map();
const byId = (id) => document.getElementById(id);
const upstreamLogLevel = () =>
  ["debug", "info", "warning", "error"].includes(level) ? level : "info";
function save() {
  try {
    localStorage.setItem(
      SETTINGS,
      JSON.stringify({ order: model.snapshot().order, summaryOpen }),
    );
  } catch {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS) || "{}");
    model.setOrder(s.order);
    summaryOpen = s.summaryOpen === true;
  } catch {}
}
function setState(text, tone = "neutral") {
  const el = byId("mihomo-clash-logs-state");
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  el.dataset.tone = tone;
}
function render(force = false) {
  if (!view) return;
  const s = model.snapshot();
  view.render(s, { force });
  const pause = byId("mihomo-clash-logs-pause");
  pause.setAttribute("aria-pressed", String(s.paused));
  pause.classList.toggle("is-paused", s.paused);
  pause.setAttribute(
    "aria-label",
    s.paused ? "Продолжить вывод логов" : "Пауза логов",
  );
  const label = pause.querySelector("span");
  label.textContent = s.paused
    ? `Продолжить${s.pending ? " +" + s.pending : ""}`
    : "Пауза";
  pause.hidden = stopped;
  byId("mihomo-clash-logs-play").hidden = !stopped;
  byId("mihomo-clash-logs-order").setAttribute(
    "aria-pressed",
    String(s.order === "newest"),
  );
  byId("mihomo-clash-logs-order").title =
    s.order === "newest"
      ? "Новые сверху. Нажмите — старые сверху"
      : "Старые сверху. Нажмите — новые сверху";
  if (stopped) setState("Остановлено");
  else if (s.paused)
    setState(
      `Пауза · ${s.buffered}/500${s.evictedWhilePaused ? " · вытеснено " + s.evictedWhilePaused : ""}`,
      "warning",
    );
  else if (
    socket?.readyState === 1 ||
    (socket?.readyState === undefined && socket)
  )
    setState(
      `Онлайн · ${s.buffered}/500${runtime.log_level === "silent" ? " · silent" : ""}`,
      "positive",
    );
  const bar = byId("mihomo-log-selection");
  bar.hidden = !s.selected.length;
  bar.querySelector("[data-count]").textContent = s.selected.length;
}
function schedule() {
  if (!renderFrame)
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      if (active) render();
    });
  if (!statsTimer)
    statsTimer = setTimeout(() => {
      statsTimer = 0;
      if (active) render(true);
    }, 1000);
}
function closeStream() {
  const old = socket;
  socket = null;
  controller?.abort();
  controller = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  if (old) {
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try {
      old.close();
    } catch {}
  }
}
function reconnect(run) {
  if (!active || stopped || generation !== run || reconnectTimer) return;
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(
    () => {
      reconnectTimer = 0;
      void openStream(run);
    },
    Math.min(5000, 500 * 2 ** Math.min(3, reconnectAttempt - 1)),
  );
}
async function openStream(run) {
  if (!active || stopped || run !== generation) return;
  if (capabilities.logs_stream !== true) {
    setState("Поток логов недоступен без WebSocket runtime.", "warning");
    return;
  }
  const request = new AbortController();
  controller = request;
  setState("Подключение…");
  try {
    const token = await requestMihomoClashWsToken({
      signal: request.signal,
      scope: "mihomo-clash-logs",
    });
    if (!active || stopped || generation !== run || request.signal.aborted)
      return;
    if (!token) {
      setState("Не удалось открыть поток · повторяем…", "warning");
      reconnect(run);
      return;
    }
    const ws = new WebSocket(mihomoClashLogsWsUrl(token, upstreamLogLevel()));
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      reconnectAttempt = 0;
      render(true);
    };
    ws.onmessage = (event) => {
      if (!active || stopped || generation !== run || socket !== ws) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        message?.type !== "mihomo-clash-logs" ||
        Number(message.schema_version) !== 1
      )
        return;
      if (
        message.state === "ended" &&
        message.payload?.reason === "debug_window_expired"
      ) {
        level = "all";
        byId("mihomo-clash-logs-level").value = "all";
        setState(
          "Debug завершён через 5 минут · возвращаем обычный поток.",
          "warning",
        );
        closeStream();
        reconnect(run);
        return;
      }
      if (message.state === "error") {
        setState(
          message.error?.code === "stream_busy"
            ? "Предыдущий поток завершается · повторяем подключение…"
            : "Поток прерван · повторяем подключение…",
          "warning",
        );
        return;
      }
      if (message.state === "live" && message.payload) {
        model.append(message.payload);
        schedule();
      }
    };
    ws.onerror = () => setState("Соединение с логами прервано.", "warning");
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (active && !stopped && generation === run) {
        setState("Переподключение потока логов…");
        reconnect(run);
      }
    };
  } catch {
    if (!request.signal.aborted && active && !stopped && generation === run) {
      setState("Не удалось открыть поток · повторяем…", "warning");
      reconnect(run);
    }
  } finally {
    if (controller === request) controller = null;
  }
}
function rowText(r, tsv = false) {
  return mihomoLogRowText(r, tsv);
}
async function copy(records, tsv = false) {
  try {
    await navigator.clipboard.writeText(
      records.map((r) => rowText(r, tsv)).join("\n"),
    );
    setState(`Скопировано · ${records.length} записей`, "positive");
  } catch {
    setState("Не удалось скопировать записи.", "warning");
  }
}
function filter(field, value) {
  const s = model.snapshot();
  if (field === "kind") {
    const kinds = new Set(s.filters.kinds);
    if (kinds.has(value)) kinds.delete(value);
    else kinds.add(value);
    model.setFilters({ kinds: [...kinds] });
  } else if (field === "reset") {
    model.setFilters({
      query: "",
      kinds: ["proxy", "direct", "block"],
      node: "",
      device: "",
      domain: "",
      level: "all",
    });
    byId("mihomo-clash-logs-filter").value = "";
    byId("mihomo-log-local-level").value = "all";
    localLevel = "all";
  } else model.setFilters({ [field]: s.filters[field] === value ? "" : value });
  render(true);
}
function onAction(action) {
  const s = model.snapshot(),
    row = s.records.find((r) => r.id === action.id);
  if (action.type === "select") model.select(action.id, action);
  else if (action.type === "select-all") model.select(null, { all: true });
  else if (action.type === "clear-selection") model.clearSelection();
  else if (action.type === "copy-raw" && row) {
    void copy([row]);
    return;
  } else if (action.type === "copy-selected" || action.type === "copy-tsv") {
    void copy(
      s.visible.filter((r) => s.selected.includes(r.id)),
      action.type === "copy-tsv",
    );
    return;
  } else if (action.type.startsWith("filter-") && row) {
    const field = action.type.slice(7);
    if(field==='node'&&row.kind!=='proxy'){
      if(row.kind)model.setFilters({kinds:[row.kind]});
      render(true);return;
    }
    filter(
      field,
      field === "device"
        ? row.sourceIp
        : field === "domain"
          ? row.destination
          : row.node || row.group,
    );
    return;
  }
  render(true);
}
function applySummary() {
  const box = byId("mihomo-log-summary");
  box.classList.toggle("is-open", summaryOpen);
  box.querySelector("[data-mlog-summary-body]").hidden = !summaryOpen;
  const b = box.querySelector("[data-mlog-summary-toggle]");
  b.setAttribute("aria-expanded", String(summaryOpen));
  b.querySelector("[data-label]").textContent = summaryOpen
    ? "Свернуть"
    : "Развернуть";
}
function initView() {
  if (view) return;
  view = createMihomoLogView({
    host: byId("mihomo-clash-logs-list"),
    summary: byId("mihomo-log-summary"),
    chips: byId("mihomo-log-chips"),
    footer: byId("mihomo-log-stats"),
    onAction,
    routeIcon: (group) => visuals.get(group) || "",
  });
}
function bind() {
  if (root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  root.addEventListener("click", (event) => {
    const f = event.target.closest("[data-filter]");
    if (f) {
      filter(f.dataset.filter, f.dataset.value);
      return;
    }
    const action = event.target.closest("[data-selection]");
    if (action) onAction({ type: action.dataset.selection });
    if (event.target.closest("[data-mlog-summary-toggle]")) {
      summaryOpen = !summaryOpen;
      applySummary();
      save();
      view?.refresh();
    }
  });
  byId("mihomo-clash-logs-pause").addEventListener("click", () => {
    model.setPaused(!model.snapshot().paused);
    render(true);
  });
  byId("mihomo-clash-logs-stop").addEventListener("click", () => {
    stopped = true;
    generation += 1;
    closeStream();
    render(true);
  });
  byId("mihomo-clash-logs-play").addEventListener("click", () => {
    stopped = false;
    model.setPaused(false);
    generation += 1;
    void openStream(generation);
    render(true);
  });
  byId("mihomo-clash-logs-clear").addEventListener("click", () => {
    model.clear();
    render(true);
  });
  byId("mihomo-clash-logs-copy").addEventListener(
    "click",
    () => void copy(model.snapshot().visible),
  );
  byId("mihomo-clash-logs-filter").addEventListener("input", (event) => {
    model.setFilters({ query: event.target.value });
    render(true);
  });
  byId("mihomo-log-local-level").addEventListener("change", (event) => {
    localLevel = event.target.value;
    model.setFilters({ level: localLevel });
    render(true);
  });
  byId("mihomo-clash-logs-level").addEventListener("change", (event) => {
    level = event.target.value;
    generation += 1;
    closeStream();
    reconnectAttempt = 0;
    if (active && !stopped) void openStream(generation);
  });
  byId("mihomo-clash-logs-order").addEventListener("click", () => {
    model.setOrder(model.snapshot().order === "newest" ? "oldest" : "newest");
    save();
    render(true);
    view?.scrollNew();
  });
  root
    .querySelector("[data-mlog-new]")
    .addEventListener("click", () => view?.scrollNew());
  byId("mihomo-log-fullscreen").addEventListener("click", () => {
    root.classList.toggle("is-fullscreen");
    byId("mihomo-log-fullscreen").setAttribute(
      "aria-pressed",
      String(root.classList.contains("is-fullscreen")),
    );
    view?.refresh();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "/" && !event.target.closest("input,select,textarea")) {
      event.preventDefault();
      byId("mihomo-clash-logs-filter").focus();
    }
    if (event.key === "Escape") {
      root.classList.remove("is-fullscreen");
      byId("mihomo-log-fullscreen")?.setAttribute("aria-pressed", "false");
    }
  });
}
export function initMihomoClashLogs() {
  root = byId("mihomo-clash-logs");
  if (!root) return false;
  load();
  bind();
  applySummary();
  return true;
}
export function activateMihomoClashLogs(
  nextCapabilities = {},
  nextRuntime = {},
) {
  if (!root && !initMihomoClashLogs()) return false;
  deactivateMihomoClashLogs();
  active = true;
  stopped = true;
  model.setPaused(false);
  capabilities = nextCapabilities || {};
  runtime = nextRuntime || {};
  reconnectAttempt = 0;
  generation += 1;
  initView();
  render(true);
  const currentView = view;
  void fetchMihomoClashGroups()
    .then((payload) => {
      if (!active || view !== currentView) return;
      visuals.clear();
      // GLOBAL arrives as a separate field, not inside `groups`; a route that
      // names it still needs its icon.
      for (const g of [...(payload?.groups || []), payload?.global_group])
        if (g?.name && g.icon) visuals.set(g.name, g.icon);
      view?.refresh();
    })
    .catch(() => {});
  return true;
}
export function deactivateMihomoClashLogs() {
  active = false;
  generation += 1;
  closeStream();
  if (renderFrame) cancelAnimationFrame(renderFrame);
  if (statsTimer) clearTimeout(statsTimer);
  renderFrame = statsTimer = 0;
  view?.destroy();
  view = null;
  root?.classList.remove("is-fullscreen");
  return true;
}
export const mihomoClashLogsApi = Object.freeze({
  init: initMihomoClashLogs,
  activate: activateMihomoClashLogs,
  deactivate: deactivateMihomoClashLogs,
});
