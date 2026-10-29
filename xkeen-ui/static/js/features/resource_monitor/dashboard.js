// Controller of the router diagnostics window: state, requests, polling, wiring of
// the view (status line, cards, connection, hardware), the big chart and the tariff form.
//
//   openDashboard()  fetches summary + hardware + history (range 1h) in parallel, then
//                    every 5 s the summary and, when a column of the chart has closed,
//                    the history of the same range; the open column is patched in place.
//   closeDashboard() stops every timer and request.
// A hidden tab polls nothing; coming back costs exactly one history request.

import { buildResourceSnapshot } from "../resource_monitor_model.js";
import { columnCount, linkOf } from "./chart_data.js";
import { createChartView } from "./chart_view.js";
import { mountTariffForm, tariffPeaks } from "./tariff_form.js";
import { mountTools } from "./tools.js";
import { mountDashboardView } from "./view.js";

const SUMMARY_ENDPOINT = "/api/system/summary";
const HARDWARE_ENDPOINT = "/api/system/hardware";
const HISTORY_ENDPOINT = "/api/system/history";
const INITRC_ENDPOINT = "/api/system/router/initrc";
const TICK_MS = 5000;
const HARDWARE_EVERY_TICKS = 12;
const SAMPLE_S = 5;
const LOAD_ERROR = "Не удалось получить данные диагностики роутера.";
const HISTORY_ERROR = "Не удалось загрузить историю за выбранный интервал.";

const state = {
  open: false,
  metric: "cpu",
  range: "1h",
  linkId: null,
  rememberedMetric: "cpu",
  highlight: null,
  summary: null,
  summaryStale: true,
  hardware: null,
  history: null,
  stale: false,
  lastCol: null,
  live: { n: 1 },
  okAt: 0,
  tickN: 0,
  busy: false,
  historyToken: 0,
  tickTimer: 0,
  freshTimer: 0,
  abort: null,
};
let view = null;
let chart = null;
let tools = null;
let toolListener = null;
let initrcState = "hidden";
let initrcRetry = "apply";

const byId = (id) => document.getElementById(id);
const isHidden = () => document.visibilityState === "hidden" || document.hidden === true;

export function getDashboardState() {
  return { metric: state.metric, range: state.range };
}

async function fetchJson(url) {
  const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin", signal: state.abort?.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ---- mounting ---------------------------------------------------------------

function ensureMounted() {
  if (view) return true;
  const host = byId("xk-resource-dashboard-view");
  if (!host) return false;
  view = mountDashboardView(host);
  view.onInitrcAction(onInitrcAction);
  chart = createChartView(view.chartHost, {
    onRange: selectRange,
    onMetric: selectMetric,
    onLink: (id) => { state.linkId = id; renderChart(); },
    onTariff: () => void openTariff(),
    onRetry: () => void refreshData(),
    onCell: ({ range, from, to }) => {
      state.highlight = range === "24h" ? null : { from, to };
      selectRange(range, { keepHighlight: true });
    },
  });
  tools = mountTools(view.toolsHost, { snapshot: toolsSnapshot });
  view.onCardClick(onCardClick);
  view.onLinkClick((name) => {
    if (name === "tariff") void openTariff();
    else byId("xk-resource-dashboard-modal")?.dispatchEvent(new CustomEvent("xk-resource-tool", { bubbles: true, detail: { tool: name } }));
  });
  if (!toolListener) {
    toolListener = onToolRequest;
    byId("xk-resource-dashboard-modal")?.addEventListener("xk-resource-tool", toolListener);
  }
  return true;
}

// What the tool tabs need from the summary: connections, interfaces, active problems.
function toolsSnapshot() {
  const summary = state.summary;
  return { router: summary?.router || null, links: summary?.links || [], problems: summary?.status?.problems?.length || 0 };
}

// The connection chain asks for a tool. The old window had no DNS journal of its own
// (the guidance lived in sections that are gone), so "dns-log" opens the events tab
// narrowed to DNS failures.
function onToolRequest(event) {
  if (event?.detail?.tool === "dns-log") tools?.show("events", { scroll: true, focus: "dns_failed" });
}

// ---- state changes -------------------------------------------------------------

function renderInitrc(stateName, details = "") {
  initrcState = stateName;
  view?.renderInitrcHint({ state: stateName, details });
}

async function loadInitrc() {
  const session = state.abort;
  renderInitrc("hidden");
  try {
    const response = await fetch(INITRC_ENDPOINT, { cache: "no-store", credentials: "same-origin", signal: session.signal });
    const data = await response.json();
    if (session !== state.abort || !state.open || session.signal.aborted) return;
    if (response.ok && data.ok === true && data.state === "missing" && !data.dismissed) renderInitrc("warning");
  } catch (error) {
    // An optional firmware check must not prevent the dashboard from loading.
  }
}

function onInitrcAction(action) {
  if (!state.open || initrcState === "applying" || initrcState === "dismissing") return;
  if (action === "fix") renderInitrc("confirm");
  else if (action === "cancel") renderInitrc("warning");
  else if (action === "confirm") void mutateInitrc("apply");
  else if (action === "dismiss") void mutateInitrc("dismiss");
  else if (action === "retry") void mutateInitrc(initrcRetry);
}

async function mutateInitrc(action) {
  const session = state.abort;
  initrcRetry = action;
  renderInitrc(action === "apply" ? "applying" : "dismissing");
  try {
    let init = { method: "POST", cache: "no-store", credentials: "same-origin", signal: session.signal };
    const http = window.XKeen?.core?.http;
    if (typeof http?.withCSRF === "function") init = http.withCSRF(init, "POST");
    else {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
      if (token) init.headers = { "X-CSRF-Token": token };
    }
    const response = await fetch(`${INITRC_ENDPOINT}/${action}`, init);
    const data = await response.json();
    if (session !== state.abort || !state.open || session.signal.aborted) return;
    if (!response.ok || data.ok !== true || (action === "apply" && data.state !== "ok")) {
      throw new Error([data.error, data.details].filter(Boolean).join("\n") || "Не удалось выполнить действие. Попробуйте ещё раз.");
    }
    renderInitrc(action === "apply" ? "success" : "hidden");
  } catch (error) {
    if (session !== state.abort || !state.open || session.signal.aborted) return;
    renderInitrc("error", error?.message || "Не удалось связаться с роутером. Попробуйте ещё раз.");
  }
}

function selectRange(range, { keepHighlight = false } = {}) {
  // the same range is ignored only while its history is on screen; after a failed load it retries
  if (!range || (range === state.range && !keepHighlight && state.history?.range === range)) return;
  if (!keepHighlight) state.highlight = null;
  if (range === "7d" && state.range !== "7d") {
    state.rememberedMetric = state.metric;
    state.metric = "all";
  } else if (range !== "7d" && state.metric === "all") {
    state.metric = state.rememberedMetric === "all" ? "cpu" : state.rememberedMetric;
  }
  state.range = range;
  chart?.markRange(range);
  void loadHistory();
}

function selectMetric(metric) {
  state.metric = metric;
  renderChart();
}

function onCardClick(metric) {
  if (metric === "internet") {
    view.focusConnection();
    return;
  }
  const next = { cpu: "cpu", memory: "memory", link: "net" }[metric];
  if (!next) return;
  state.metric = next;
  if (state.range === "24h") {
    state.range = "1h";
    state.highlight = null;
    void loadHistory();
  } else {
    renderChart();
  }
  try {
    view.chartHost.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    // an old browser without options: the chart stays where it is
  }
}

// ---- rendering --------------------------------------------------------------------

function renderChart() {
  // while the history of a newly chosen range is on its way the old one stays as it was
  if (!chart || !state.history || state.history.range !== state.range) return;
  chart.render({ history: state.history, snapshot: state.summaryStale ? null : state.summary, range: state.range, metric: state.metric, linkId: state.linkId, highlight: state.highlight, stale: state.stale });
}

function syncExport() {
  const button = byId("xk-resource-export");
  const disabled = !(state.summary && state.history);
  if (button && button.disabled !== disabled) button.disabled = disabled;
}

function paintFreshness() {
  const el = byId("xk-resource-dashboard-freshness");
  if (!el) return;
  let text = "Обновлено —";
  if (state.okAt) {
    const seconds = Math.max(0, Math.round((Date.now() - state.okAt) / 1000));
    text = seconds < 60 ? `Обновлено ${seconds} с назад` : `Обновлено ${Math.floor(seconds / 60)} мин назад`;
  }
  // the text node is edited in place: no new node, no restyling of the modal around it
  const node = el.firstChild;
  if (node && node.nodeType === 3 && !node.nextSibling) {
    if (node.data !== text) node.data = text;
  } else {
    el.textContent = text;
  }
}

function applySummary(summary) {
  state.summary = summary;
  state.summaryStale = false;
  state.okAt = Date.now();
  view.renderSummary(summary);
  view.renderConnection(summary.router);
  tools?.update();
  paintFreshness();
  syncExport();
  chart?.updateSnapshot(summary);
}

function applyHistory(data) {
  state.history = data;
  state.stale = false;
  const step = data.step_s || 0;
  const count = columnCount(data);
  state.lastCol = step && count ? Math.floor((data.start + (count - 1) * step) / step) : null;
  const colStart = data.start + (count - 1) * step;
  const ts = state.summary?.ts;
  state.live = { n: Number.isFinite(ts) ? Math.min(60, Math.max(1, Math.round((ts - colStart) / SAMPLE_S))) : 1 };
  chart.showError("");
  renderChart();
  syncExport();
}

// ---- requests -------------------------------------------------------------------------

async function loadSummary() {
  try {
    const summary = await fetchJson(SUMMARY_ENDPOINT);
    if (!state.open) return null;
    applySummary(summary);
    return summary;
  } catch (error) {
    state.summaryStale = true;
    chart?.updateSnapshot(null);
    return null;
  }
}

async function loadHardware() {
  try {
    const hardware = await fetchJson(HARDWARE_ENDPOINT);
    if (!state.open) return;
    state.hardware = hardware;
    view.renderHardware(hardware);
  } catch (error) {
    // the block keeps the last data
  }
}

async function loadHistory() {
  const range = state.range;
  const token = ++state.historyToken;
  try {
    const data = await fetchJson(`${HISTORY_ENDPOINT}?range=${range}`);
    if (!state.open || token !== state.historyToken || data.range !== state.range) return;
    applyHistory(data);
  } catch (error) {
    if (!state.open || token !== state.historyToken || state.abort?.signal.aborted) return;
    if (state.history && state.history.range === state.range) {
      state.stale = true;
      renderChart();
    } else {
      chart.markRange(state.range);
      chart.showError(state.history ? HISTORY_ERROR : LOAD_ERROR);
    }
  }
}

const historyShown = () => Boolean(state.history && state.history.range === state.range);

// ---- polling --------------------------------------------------------------------------------

// The open column of a short range moves with every sample: average it in place and
// repaint that one column. The server's exact values replace it when the column closes.
function patchOpenColumn(summary) {
  const history = state.history;
  if (!history || history.range === "24h" || history.range === "7d" || !summary?.values) return;
  const last = columnCount(history) - 1;
  if (last < 0) return;
  const n = state.live.n;
  for (const [name, metric] of Object.entries(history.metrics)) {
    const value = summary.values[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (metric.avg[last] == null) {
      metric.avg[last] = value;
      metric.max[last] = value;
      if (metric.zone) {
        metric.zone[last] = summary.zones?.[name] ?? null;
        metric.peak_zone[last] = summary.zones?.[name] ?? null;
      }
      continue;
    }
    metric.avg[last] = (metric.avg[last] * n + value) / (n + 1);
    metric.max[last] = Math.max(metric.max[last] ?? value, value);
    const zone = summary.zones?.[name];
    if (metric.peak_zone && zone != null) metric.peak_zone[last] = Math.max(metric.peak_zone[last] ?? 0, zone);
  }
  state.live.n = n + 1;
  chart.updateLast();
}

async function tick() {
  if (!state.open || isHidden() || state.busy) return;
  state.busy = true;
  state.tickN += 1;
  try {
    const summary = await loadSummary();
    if (summary && state.history) {
      const step = state.history.step_s || 0;
      if (!historyShown() || (step && Math.floor(summary.ts / step) !== state.lastCol)) await loadHistory();
      else patchOpenColumn(summary);
    } else if (!summary && state.history) {
      state.stale = true;
      renderChart();
    }
    if (state.tickN % HARDWARE_EVERY_TICKS === 0) await loadHardware();
  } finally {
    state.busy = false;
  }
}

function startTimers() {
  stopTimers();
  if (!state.open || isHidden()) return;
  state.tickTimer = window.setInterval(() => void tick(), TICK_MS);
  state.freshTimer = window.setInterval(paintFreshness, 1000);
}

function stopTimers() {
  window.clearInterval(state.tickTimer);
  window.clearInterval(state.freshTimer);
  state.tickTimer = 0;
  state.freshTimer = 0;
}

function onVisibilityChange() {
  if (!state.open) return;
  if (isHidden()) {
    stopTimers();
    return;
  }
  startTimers();
  void Promise.allSettled([loadSummary(), loadHistory()]);
}

// Opens a tool tab of the window and loads it again (the entry's old loadProcesses and friends).
export function loadDashboardTool(tab) {
  return state.open && tools ? tools.show(tab, { reload: true }) : false;
}

export async function refreshDashboard() {
  tools?.refresh();
  await refreshData();
}

// ---- public ---------------------------------------------------------------------------------

// The data of the window; the open tool tab is reloaded only by the window's refresh button.
async function refreshData() {
  if (!state.open || !ensureMounted()) return;
  await Promise.allSettled([loadSummary(), loadHardware(), loadHistory()]);
  chart.showError(historyShown() ? "" : state.history ? HISTORY_ERROR : LOAD_ERROR);
}

export async function openDashboard() {
  if (state.open || !ensureMounted()) return;
  state.open = true;
  state.abort = new AbortController();
  void loadInitrc();
  state.tickN = 0;
  state.stale = false;
  document.addEventListener("visibilitychange", onVisibilityChange);
  startTimers();
  paintFreshness();
  syncExport();
  await Promise.allSettled([loadSummary(), loadHardware(), loadHistory()]);
  if (!state.open) return;
  chart.showError(state.history && state.summary ? "" : LOAD_ERROR);
  view.redraw();
}

export function closeDashboard() {
  if (!state.open) return;
  state.open = false;
  stopTimers();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  state.abort?.abort();
  state.abort = null;
  renderInitrc("hidden");
  state.historyToken += 1;
  state.busy = false;
  state.summary = null;
  state.history = null;
  state.hardware = null;
  state.okAt = 0;
  state.highlight = null;
  state.range = "1h";
  state.metric = "cpu";
  state.rememberedMetric = "cpu";
  state.linkId = null;
  state.stale = false;
  chart?.reset();
  tools?.reset();
  paintFreshness();
}

async function openTariff() {
  const history = state.history;
  const link = history ? linkOf(history, state.linkId) : null;
  if (!link || !chart) return;
  let day = history.range === "24h" ? history : null;
  if (!day) {
    try {
      day = await fetchJson(`${HISTORY_ENDPOINT}?range=24h`);
    } catch (error) {
      day = null;
    }
  }
  mountTariffForm(chart.formHost, {
    link,
    peaks: day ? tariffPeaks(day, link.id) : null,
    onSaved: () => void refreshData(),
  });
}

export function exportDashboardSnapshot() {
  if (!state.summary || !state.history) return;
  const snapshot = buildResourceSnapshot(state.summary, state.hardware, state.history, state.range, state.stale);
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `xkeen-resources-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
