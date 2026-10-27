// The big chart of the router diagnostics window, rendered inside the shadow root of
// the window (host = view.chartHost): metric tabs, interval buttons, the level meter,
// the network mirror, the 24 h / 7 d cell grids, the tooltip and the summary line.
//
// The view only draws what chart_data.js derived from /api/system/history. The
// controller (dashboard.js) owns the state and the requests and passes callbacks:
//   onRange(range), onMetric(metric), onLink(id), onTariff(), onRetry(),
//   onCell({ range, from, to }).

import { drawCellGrid, drawLevelChart, drawMirrorChart, redrawColumn } from "./canvas_charts.js";
import {
  METRIC_LABELS, RANGE_LABELS, ZONE_NAMES, cellTimes, foldHistory, grid24Model, grid24Summary, grid7Model,
  grid7Summary, hasTariff, levelModel, linkOf, minutesText, mirrorModel, num, stepWords, timesOfColumn, xLabels,
  hhmm, columnCount,
} from "./chart_data.js";

const RANGES = ["15m", "30m", "1h", "6h", "24h", "7d"];
const METRICS = ["cpu", "memory", "net", "queue", "all"];
const PHONE_WIDTH = 560;
const ROW_H = 26;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const ZONE_CLASS = ["z0", "z1", "z2"];

export function createChartView(host, callbacks = {}) {
  host.innerHTML = `<section class="xkm-panel xkc" hidden>
    <div class="xkc-bar">
      <div class="xkc-tabs" role="group" aria-label="Показатель">${METRICS.map((m) => `<button type="button" class="xkc-b" data-metric="${m}" aria-pressed="false">${METRIC_LABELS[m]}</button>`).join("")}</div>
      <div class="xkc-ranges" role="group" aria-label="История за"><span class="xkc-cap">История за</span>${RANGES.map((r) => `<button type="button" class="xkc-b" data-range="${r}" aria-pressed="false">${RANGE_LABELS[r]}</button>`).join("")}</div>
    </div>
    <div class="xkc-info"></div>
    <div class="xkc-form" hidden></div>
    <div class="xkc-plot">
      <div class="xkc-gutter"></div>
      <div class="xkc-wrap"><canvas class="xkc-canvas" role="img" aria-label="График нагрузки"></canvas><div class="xkc-hl" hidden></div><div class="xkc-tip" role="status" hidden></div></div>
    </div>
    <div class="xkc-axis"></div>
    <div class="xkc-summary"></div>
  </section>
  <div class="xkc-error" hidden><span class="xkc-error-text"></span> <button type="button" class="xkc-b" data-retry>Повторить</button></div>`;
  const $ = (selector) => host.querySelector(selector);
  const panel = $(".xkc");
  const canvas = $(".xkc-canvas");
  const wrap = $(".xkc-wrap");
  const gutter = $(".xkc-gutter");
  const tip = $(".xkc-tip");
  const hl = $(".xkc-hl");
  const info = $(".xkc-info");
  const axis = $(".xkc-axis");
  const summaryEl = $(".xkc-summary");
  const errorBox = $(".xkc-error");
  let cur = { input: null, history: null, model: null, handle: null, opts: null, hover: -1, folded: false, tipCell: null };
  let frame = 0;
  let resizeObserver = null;

  // ---- static controls -------------------------------------------------
  panel.addEventListener("click", (event) => {
    const target = event.target.closest?.("button, [data-link]");
    if (!target) return;
    if (target.dataset.range) callbacks.onRange?.(target.dataset.range);
    else if (target.dataset.metric) callbacks.onMetric?.(target.dataset.metric);
    else if (target.dataset.linkId) callbacks.onLink?.(target.dataset.linkId);
    else if (target.dataset.link === "tariff") callbacks.onTariff?.();
  });
  errorBox.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-retry]")) callbacks.onRetry?.();
  });

  // ---- pieces ------------------------------------------------------------
  const legendChip = (zone, text) => `<span class="xkc-chip"><i class="${ZONE_CLASS[zone]}"></i>${esc(text)}</span>`;

  function infoHtml(input, history, model) {
    const parts = [];
    const isNet = input.range !== "24h" && input.metric === "net";
    const links = history.links || [];
    if (isNet && links.length > 1) {
      const active = linkOf(history, input.linkId)?.id;
      parts.push(`<span class="xkc-links" role="group" aria-label="Подключение">${links.map((l) => `<button type="button" class="xkc-b" data-link-id="${esc(l.id)}" aria-pressed="${l.id === active}">${esc(l.label)}</button>`).join("")}</span>`);
    }
    if (model.kind === "level") {
      parts.push(...model.legend.map((item) => legendChip(item.zone, item.text)));
      parts.push(`<span class="xkc-dim">столбец = ${esc(stepWords(history.step_s))}</span><span class="xkc-dim">черта — пик за столбец</span>`);
    } else if (model.kind === "mirror") {
      const bands = history.bands?.link;
      const link = model.link;
      if (model.tariffed && bands) {
        parts.push(legendChip(0, `до ${num(bands.orange)} % тарифа`), legendChip(1, `${num(bands.orange)}–${num(bands.red)} %`), legendChip(2, `канал забит, выше ${num(bands.red)} %`));
      } else {
        parts.push('<span class="xkc-dim">без тарифа: скорость в Мбит/с, шкала по максимуму за интервал</span>');
      }
      parts.push(`<span class="xkc-dim">столбец = ${esc(stepWords(history.step_s))}</span>`);
      if (link) {
        const t = link.tariff;
        const reserve = !model.tariffed && link.primary && links.some((l) => l.id !== link.id && hasTariff(l));
        const tariffText = model.tariffed
          ? `Тариф: приём ${t.down_mbps == null ? "—" : num(t.down_mbps)}, отдача ${t.up_mbps == null ? "—" : num(t.up_mbps)} Мбит/с <button type="button" class="xkm-a" data-link="tariff">изменить</button>`
          : `<button type="button" class="xkm-a" data-link="tariff">указать скорость тарифа</button>`;
        parts.push(`<span class="xkc-tariff">${links.length > 1 ? `Канал · ${esc(link.label)} · ` : ""}${tariffText}</span>`);
        if (reserve) parts.push('<span class="xkc-reserve">резервный канал</span>');
      }
    } else {
      parts.push(legendChip(0, ZONE_NAMES[0]), legendChip(1, ZONE_NAMES[1]), legendChip(2, ZONE_NAMES[2]));
      parts.push(`<span class="xkc-dim">клетка = ${esc(stepWords(model.cellSeconds))}, цвет — худшее значение за это время</span>`);
    }
    const since = history.history_since;
    if (Number.isFinite(since) && since > history.start + history.step_s) parts.push(`<span class="xkc-dim">история с ${hhmm(since)}</span>`);
    if (input.stale) parts.push('<span class="xkc-stale">обновить не удалось</span>');
    return parts.join("");
  }

  function paintGutter(model, height) {
    gutter.style.height = `${height}px`;
    if (model.kind === "level") {
      gutter.innerHTML = model.axis.map((a) => `<span style="bottom:${(a.value / model.scaleMax) * 100}%">${esc(a.text)}</span>`).join("");
    } else if (model.kind === "mirror") {
      gutter.innerHTML = model.axis.map((a) => `<span class="m${a.bold ? " b" : ""}" style="top:${a.at * 100}%">${esc(a.text)}</span>`).join("");
    } else {
      const rowH = height / model.rows.length;
      gutter.innerHTML = model.rows.map((row) => `<span class="rl" style="top:${model.rows.indexOf(row) * rowH}px;height:${rowH}px" title="${esc(row.label)}">${esc(row.label)}</span>`).join("");
    }
  }

  function paintAxis(model, history, count) {
    let labels;
    if (model.kind === "grid7") {
      labels = [0, 6, 12, 18].map((h, i) => ({ at: i / 4, text: `${String(h).padStart(2, "0")}:00` }));
    } else {
      labels = xLabels(history, count, history.step_s);
    }
    const now = model.kind === "grid7" ? "" : '<span class="now">сейчас</span>';
    axis.innerHTML = `${labels.map((l, i) => `<span class="${i === 0 ? "first" : ""}" style="left:${l.at * 100}%">${esc(l.text)}</span>`).join("")}${now}`;
  }

  function summaryHtml(model, history) {
    const item = (label, value, cls = "") => `<span>${label} <b class="${cls}">${value}</b></span>`;
    if (model.kind === "level") {
      const s = model.summary();
      const zoneItem = (label, m, cls) => `<span>${label} <b class="${m > 0 ? cls : "zero"}">${minutesText(m)}</b></span>`;
      return [
        item("Сейчас", esc(s.now ?? "—")),
        item("В среднем", esc(s.mean ?? "—")),
        `<span>Пик в <b>${esc(s.peakAt ?? "—")}</b>${s.peakValue ? ` <i>(${esc(s.peakValue)})</i>` : ""}</span>`,
        zoneItem("В оранжевой зоне", s.orange, "z1"),
        zoneItem("В красной", s.red, "z2"),
      ].join("");
    }
    if (model.kind === "mirror") {
      const s = model.summary();
      const out = [
        item("↑ Отдача сейчас", esc(s.upNow ?? "—")), item("пик", esc(s.upPeak ?? "—")),
        item("↓ Приём сейчас", esc(s.downNow ?? "—")), item("пик", esc(s.downPeak ?? "—")),
      ];
      if (s.tariffed) out.push(`<span>Канал забит <b class="${s.red > 0 ? "z2" : "zero"}">${minutesText(s.red)}</b></span>`);
      return out.join("");
    }
    if (model.kind === "grid24") {
      const s = grid24Summary(model, history);
      const out = [s.heavy ? item("Самое тяжёлое время", esc(s.heavy)) : '<span class="zero">Тяжёлых периодов нет</span>'];
      for (const r of s.red) out.push(`<span>${esc(r.label)} в красной зоне <b class="z2">${minutesText(r.minutes)}</b></span>`);
      out.push(`<span>Перерывов связи <b class="${s.breaks ? "z2" : "zero"}">${s.breaks}</b></span>`);
      return out.join("");
    }
    const s = grid7Summary(model, history);
    return [
      s.heavy ? item("Самый тяжёлый день и час", esc(s.heavy)) : '<span class="zero">Тяжёлых периодов нет</span>',
      `<span>Перерывов связи за неделю <b class="${s.breaks ? "z2" : "zero"}">${s.breaks}</b></span>`,
    ].join("");
  }

  function paintHighlight(input, history, count) {
    const range = input.highlight;
    if (!range || !count) { hl.hidden = true; return; }
    const total = count * history.step_s;
    const left = Math.max(0, (range.from - history.start) / total);
    const right = Math.min(1, (range.to - history.start) / total);
    if (!(right > left)) { hl.hidden = true; return; }
    hl.hidden = false;
    hl.style.left = `${left * 100}%`;
    hl.style.width = `${(right - left) * 100}%`;
  }

  // ---- tooltip -----------------------------------------------------------
  function showTip(x, y, tooltip) {
    tip.innerHTML = `<div class="h">${esc(tooltip.head)}</div>${tooltip.lines.map(([label, value]) => `<div class="l">${label ? `<span>${esc(label)}</span>` : ""}<b>${esc(value)}</b></div>`).join("")}`;
    tip.hidden = false;
    const width = tip.offsetWidth;
    const left = x + 14 + width > wrap.clientWidth ? Math.max(0, x - 14 - width) : x + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, Math.min(y + 10, wrap.clientHeight - tip.offsetHeight))}px`;
  }

  function hideTip() {
    tip.hidden = true;
    cur.tipCell = null;
    setHover(-1);
  }

  function setHover(index) {
    const { handle, opts, model } = cur;
    if (!handle || !opts || cur.hover === index) return;
    const old = cur.hover;
    cur.hover = index;
    opts.hoverIndex = index;
    if (old >= 0 && old < handle.count) redrawColumn(handle, old, model.columnAt(old));
    if (index >= 0 && index < handle.count) redrawColumn(handle, index, model.columnAt(index));
  }

  function pointerAt(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function gridCell(x, y) {
    const hit = cur.handle?.cellAt?.(x, y);
    if (!hit) return null;
    const { model, history } = cur;
    const times = cellTimes(model, history, model.kind === "grid24" ? 0 : hit.row, hit.column);
    return { hit, times };
  }

  function gridTooltip(cell) {
    const { model } = cur;
    const { hit, times } = cell;
    if (model.kind === "grid24") {
      return { head: times.head, lines: model.rows.map((row) => [row.label, row.cells[hit.column] == null ? "нет данных" : row.describe(hit.column)]) };
    }
    const row = model.rows[hit.row];
    const zone = row.cells[hit.column];
    if (zone == null) return { head: times.head, lines: [["", "нет данных"]] };
    const by = row.by[hit.column];
    return { head: times.head, lines: [["", `${ZONE_NAMES[zone]}${model.metric === "all" && by ? ` · хуже всего: ${by}` : ""}`]] };
  }

  function onMove(event) {
    if (!cur.model || !cur.handle) return;
    const { x, y } = pointerAt(event);
    if (cur.model.kind === "grid24" || cur.model.kind === "grid7") {
      const cell = gridCell(x, y);
      if (!cell) { hideTip(); return; }
      cur.tipCell = `${cell.hit.row}:${cell.hit.column}`;
      showTip(x, y, gridTooltip(cell));
      return;
    }
    const index = cur.handle.columnAt(x);
    if (index < 0) { hideTip(); return; }
    setHover(index);
    cur.tipCell = String(index);
    showTip(x, y, cur.model.tooltip(index, timesOfColumn(cur.history, index)));
  }

  function onClick(event) {
    if (!cur.model || !(cur.model.kind === "grid24" || cur.model.kind === "grid7")) return;
    const { x, y } = pointerAt(event);
    const cell = gridCell(x, y);
    if (!cell) return;
    const key = `${cell.hit.row}:${cell.hit.column}`;
    // a first touch only shows the tooltip, the second one on the same cell navigates
    if (event.pointerType === "touch" && cur.tipCell !== key) {
      cur.tipCell = key;
      showTip(x, y, gridTooltip(cell));
      return;
    }
    const { history } = cur;
    const now = history.start + columnCount(history) * history.step_s;
    const { from, to } = cell.times;
    if (cur.model.kind === "grid24") {
      if (from >= now - 3600) callbacks.onCell?.({ range: "1h", from, to });
      else if (from >= now - 6 * 3600) callbacks.onCell?.({ range: "6h", from, to });
    } else if (from >= now - 86400 && cell.hit.row <= 1 && cur.model.rows[cell.hit.row].cells[cell.hit.column] != null) {
      callbacks.onCell?.({ range: "24h", from, to });
    }
  }

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", (event) => { if (event.pointerType === "touch") onMove(event); });
  canvas.addEventListener("pointerleave", hideTip);
  canvas.addEventListener("click", (event) => onClick(event));

  // ---- render ------------------------------------------------------------
  function render(input) {
    cur.input = input;
    if (!input?.history) return;
    errorBox.hidden = true;
    panel.hidden = false;
    const phone = (host.clientWidth || 1000) < PHONE_WIDTH;
    cur.folded = phone;
    const history = phone ? foldHistory(input.history, 2) : input.history;
    cur.history = history;
    const { range, metric } = input;
    for (const b of panel.querySelectorAll("[data-range]")) b.setAttribute("aria-pressed", String(b.dataset.range === range));
    for (const b of panel.querySelectorAll("[data-metric]")) {
      b.hidden = b.dataset.metric === "all" && range !== "7d";
      b.setAttribute("aria-pressed", String(b.dataset.metric === metric));
    }
    $(".xkc-tabs").hidden = range === "24h";

    let model;
    let height;
    if (range === "24h") {
      model = grid24Model(history);
      height = model.rows.length * ROW_H;
    } else if (range === "7d") {
      model = grid7Model(history, metric, input.linkId);
      height = model.rows.length * ROW_H;
    } else if (metric === "net") {
      model = mirrorModel(history, input.linkId);
      height = phone ? 190 : 240;
    } else {
      model = levelModel(history, metric === "all" ? "cpu" : metric);
      height = phone ? 160 : 220;
    }
    cur.model = model;
    cur.hover = -1;
    cur.tipCell = null;
    tip.hidden = true;
    canvas.style.height = `${height}px`;
    canvas.dataset.kind = model.kind;
    panel.style.setProperty("--g", model.kind === "grid24" || model.kind === "grid7" ? (phone ? "78px" : "104px") : (phone ? "52px" : "64px"));
    info.innerHTML = infoHtml(input, history, model);
    paintGutter(model, height);

    let handle;
    let opts = null;
    if (model.kind === "level") {
      opts = { segments: 20, scaleMax: model.scaleMax, bands: model.bands || undefined, hoverIndex: -1 };
      handle = drawLevelChart(canvas, model.series, opts);
    } else if (model.kind === "mirror") {
      opts = model.tariffed ? { percent: true, hoverIndex: -1 } : { neutral: true, scaleMax: model.scaleMax, hoverIndex: -1 };
      handle = drawMirrorChart(canvas, model.up, model.down, opts);
    } else {
      handle = drawCellGrid(canvas, model.rows.map((row) => ({ cells: row.cells, peakDots: row.peakDots })), { columns: model.columns });
    }
    cur.handle = handle;
    cur.opts = opts;
    canvas.xkChart = handle;
    canvas.dataset.columns = String(model.kind === "grid24" || model.kind === "grid7" ? model.columns : handle.count);
    canvas.dataset.rows = String(model.rows ? model.rows.length : 1);
    paintAxis(model, history, model.kind === "grid24" || model.kind === "grid7" ? model.columns : handle.count);
    summaryEl.innerHTML = summaryHtml(model, history);
    paintHighlight(input, history, model.kind === "grid7" ? 0 : (model.kind === "grid24" ? model.columns : handle.count));
  }

  // Only the last column changed (a tick of the open column): repaint that one.
  function updateLast() {
    const { model, handle, history } = cur;
    if (!model || !handle || cur.folded || !(model.kind === "level" || model.kind === "mirror")) {
      if (cur.input) render(cur.input);
      return;
    }
    const last = handle.count - 1;
    if (last < 0) return;
    redrawColumn(handle, last, model.columnAt(last));
    summaryEl.innerHTML = summaryHtml(model, history);
  }

  if (typeof ResizeObserver === "function") {
    let lastWidth = 0;
    resizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (!width || width === lastWidth) return;
      lastWidth = width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => cur.input && render(cur.input));
    });
    resizeObserver.observe(wrap);
  }

  return {
    render,
    updateLast,
    formHost: $(".xkc-form"),
    showError(text) {
      errorBox.hidden = !text;
      $(".xkc-error-text").textContent = text || "";
    },
    hasData: () => Boolean(cur.input?.history),
    redraw: () => cur.input && render(cur.input),
    destroy() {
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      host.innerHTML = "";
    },
  };
}
