// Pure data helpers of the big chart in the router diagnostics window: turn the
// columns of GET /api/system/history into what the canvas draws, and into the texts
// of the tooltip and the summary line. No DOM, no timers, no requests.
//
// Zones (0 green, 1 orange, 2 red, null no data) and the segment bands always come
// from the server (`zone`, `peak_zone`, `bands`); nothing here knows a threshold.

import { processNote } from "./tools_format.js";

export const METRIC_LABELS = { cpu: "Процессор", memory: "Память", net: "Сеть", queue: "Очередь задач", all: "Все" };
export const RANGE_LABELS = { "15m": "15 мин", "30m": "30 мин", "1h": "1 ч", "6h": "6 ч", "24h": "24 ч", "7d": "7 д" };
export const ZONE_NAMES = ["норма", "высокая", "перегрузка"];

const DAY_S = 86400;
const WEEK_DAYS = 7;

export function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function num(value, digits = 0) {
  if (!finite(value)) return "—";
  return value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const pct = (value) => `${num(value)} %`;
export const mbit = (value) => `${num(value, 1)} Мбит/с`;

export function hhmm(ts) {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function stepWords(seconds) {
  if (seconds < 60) return `${seconds} с`;
  const minutes = seconds / 60;
  if (minutes === 1) return "1 минута";
  return `${num(minutes)} минут`;
}

export function minutesText(minutes) {
  if (!(minutes > 0)) return "0 мин";
  return `${Math.max(1, Math.round(minutes))} мин`;
}

export function columnCount(history) {
  const first = Object.values(history?.metrics || {})[0];
  return first?.avg?.length || 0;
}

const nulls = (n) => Array(n).fill(null);

// { avg, max, zone, peak_zone } of equal-length arrays; a missing metric is all "no data".
export function seriesOf(history, name) {
  const n = columnCount(history);
  const m = history?.metrics?.[name];
  return {
    avg: m?.avg || nulls(n),
    max: m?.max || nulls(n),
    zone: m?.zone || nulls(n),
    peak_zone: m?.peak_zone || nulls(n),
  };
}

const LEADERS_SHOWN = 3;
const LEADER_MIN_SHARE = 1;

// Leaders of `factor` neighbouring columns: each program's share averaged over the
// columns that have data (no data stays null, an empty list is "nobody worth a line").
function foldLeaders(top, factor) {
  const out = [];
  for (let i = 0; i < top.length; i += factor) {
    const cols = top.slice(i, i + factor).filter(Array.isArray);
    if (!cols.length) { out.push(null); continue; }
    const sums = new Map();
    for (const col of cols) for (const [name, share] of col) sums.set(name, (sums.get(name) || 0) + share);
    out.push([...sums]
      .map(([name, total]) => [name, Math.round((total / cols.length) * 10) / 10])
      .filter(([, share]) => share >= LEADER_MIN_SHARE)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, LEADERS_SHOWN));
  }
  return out;
}

// Tooltip lines "who loaded the processor" of one column (`history.top[i]`).
export function leaderLines(leaders) {
  if (!Array.isArray(leaders) || !leaders.length) return [];
  return [["Больше всех нагружали", ""], ...leaders.map(([name, share]) => {
    const note = processNote(name);
    return [note ? `${name} · ${note}` : name, pct(share)];
  })];
}

const worst = (values) => {
  let top = null;
  for (const v of values) if (v != null && (top == null || v > top)) top = v;
  return top;
};

// Fold `factor` neighbouring columns into one (phones draw half as many columns):
// the average of the averages, the highest peak, the worst zone.
// `only`: the metric names to fold (the redraw of one open column needs just the shown ones).
export function foldHistory(history, factor, only = null) {
  if (!history || !(factor > 1)) return history;
  const metrics = {};
  for (const [name, m] of Object.entries(history.metrics || {})) {
    if (only && !only.includes(name)) continue;
    const out = { avg: [], max: [] };
    if (m.zone) { out.zone = []; out.peak_zone = []; }
    for (let i = 0; i < m.avg.length; i += factor) {
      const slice = (arr) => (arr || []).slice(i, i + factor);
      const avgs = slice(m.avg).filter((v) => v != null);
      out.avg.push(avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null);
      const maxs = slice(m.max).filter((v) => v != null);
      out.max.push(maxs.length ? Math.max(...maxs) : null);
      if (m.zone) {
        out.zone.push(worst(slice(m.zone)));
        out.peak_zone.push(worst(slice(m.peak_zone)));
      }
    }
    metrics[name] = out;
  }
  const top = Array.isArray(history.top) ? foldLeaders(history.top, factor) : history.top;
  return { ...history, metrics, top, step_s: history.step_s * factor };
}

export function linkOf(history, linkId) {
  const links = history?.links || [];
  return links.find((l) => l.id === linkId) || links.find((l) => l.primary) || links[0] || null;
}

export function hasTariff(link) {
  return Boolean(link?.tariff && (link.tariff.up_mbps != null || link.tariff.down_mbps != null));
}

// ---- level chart (cpu, memory, queue) -----------------------------------

export function levelModel(history, metric) {
  const bands = history?.bands?.[metric] || null;
  const series = seriesOf(history, metric);
  const isQueue = metric === "queue";
  const scaleMax = isQueue ? bands?.scale_max || Math.max(2, (history?.cores || 1) * 2) : 100;
  const fmt = isQueue ? (v) => num(v, 1) : pct;
  const ticks = isQueue && bands
    ? [0, bands.orange, bands.red, scaleMax]
    : [0, 50, 100];
  const axis = ticks.map((value) => ({ value, text: isQueue ? num(value, 1) : pct(value) }));
  const legend = bands
    ? [
        { zone: 0, text: isQueue ? `свободно до ${num(bands.orange, 1)}` : `норма до ${num(bands.orange)} %` },
        { zone: 1, text: isQueue ? `занято ${num(bands.orange, 1)}–${num(bands.red, 1)}` : `высокая ${num(bands.orange)}–${num(bands.red)} %` },
        { zone: 2, text: isQueue ? `перегрузка выше ${num(bands.red, 1)} (числа ядер)` : `перегрузка выше ${num(bands.red)} %` },
      ]
    : [];
  return {
    kind: "level",
    series,
    scaleMax,
    bands: bands ? { orange: bands.orange, red: bands.red } : null,
    axis,
    legend,
    fmt,
    columnAt: (i) => ({ avg: series.avg[i], max: series.max[i], zone: series.zone[i], peak_zone: series.peak_zone[i] }),
    summary: (stepMin) => levelSummary(series, history, fmt, stepMin),
    tooltip: (i, times) => {
      if (series.avg[i] == null) return { head: times, lines: [["", "нет данных"]] };
      const leaders = metric === "cpu" ? leaderLines(history?.top?.[i]) : [];
      return { head: times, lines: [["В среднем", fmt(series.avg[i])], ["Пик", fmt(series.max[i])], ...leaders] };
    },
  };
}

function lastValue(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] != null) return values[i];
  return null;
}

function peakOf(series, history) {
  let best = null;
  let at = null;
  series.max.forEach((v, i) => {
    if (v != null && (best == null || v > best)) { best = v; at = i; }
  });
  return { value: best, at: at == null ? null : history.start + at * history.step_s };
}

function zoneMinutes(zones, zone, stepS) {
  return zones.filter((z) => z === zone).length * stepS / 60;
}

function levelSummary(series, history, fmt) {
  const known = series.avg.filter((v) => v != null);
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const peak = peakOf(series, history);
  return {
    kind: "level",
    now: lastValue(series.avg) == null ? null : fmt(lastValue(series.avg)),
    mean: mean == null ? null : fmt(mean),
    peakAt: peak.at == null ? null : hhmm(peak.at),
    peakValue: peak.value == null ? null : fmt(peak.value),
    orange: zoneMinutes(series.zone, 1, history.step_s),
    red: zoneMinutes(series.zone, 2, history.step_s),
  };
}

// ---- mirror chart (network) -----------------------------------------------

export function mirrorModel(history, linkId) {
  const link = linkOf(history, linkId);
  const id = link?.id;
  const tariffed = hasTariff(link);
  const up = seriesOf(history, tariffed ? `link_up:${id}` : `rate_up:${id}`);
  const down = seriesOf(history, tariffed ? `link_down:${id}` : `rate_down:${id}`);
  const rateUp = seriesOf(history, `rate_up:${id}`);
  const rateDown = seriesOf(history, `rate_down:${id}`);
  let scaleMax = 100;
  if (!tariffed) {
    scaleMax = 0;
    for (const s of [up, down]) for (const key of ["avg", "max"]) for (const v of s[key]) if (v != null && v > scaleMax) scaleMax = v;
    scaleMax = scaleMax || 1;
  }
  const column = (i) => ({
    up: { avg: up.avg[i], max: up.max[i], zone: up.zone[i], peak_zone: up.peak_zone[i] },
    down: { avg: down.avg[i], max: down.max[i], zone: down.zone[i], peak_zone: down.peak_zone[i] },
  });
  const half = (name, s, rate, i) => {
    if (s.avg[i] == null) return `${name} нет данных`;
    const speed = rate.avg[i] == null ? "" : ` · ${mbit(rate.avg[i])}`;
    if (!tariffed) return `${name} ${mbit(s.avg[i])}`;
    const over = s.avg[i] > 100 ? " — выше тарифа" : "";
    return `${name} ${pct(s.avg[i])}${over}${speed}`;
  };
  const peakLine = (i) => {
    const a = tariffed ? up.max[i] : rateUp.max[i];
    const b = tariffed ? down.max[i] : rateDown.max[i];
    if (a == null && b == null) return null;
    const f = tariffed ? pct : (v) => num(v, 1);
    return `пик: отдача ${f(a)}, приём ${f(b)}${tariffed ? "" : " Мбит/с"}`;
  };
  return {
    kind: "mirror",
    link,
    tariffed,
    up,
    down,
    scaleMax,
    axis: tariffed
      ? [{ at: 0, text: "100 %" }, { at: 0.25, text: "↑ Отдача", bold: true }, { at: 0.5, text: "0" }, { at: 0.75, text: "↓ Приём", bold: true }, { at: 1, text: "100 %" }]
      : [{ at: 0, text: `${num(scaleMax, 1)}` }, { at: 0.25, text: "↑ Отдача", bold: true }, { at: 0.5, text: "Мбит/с" }, { at: 0.75, text: "↓ Приём", bold: true }, { at: 1, text: `${num(scaleMax, 1)}` }],
    columnAt: column,
    tooltip: (i, times) => {
      if (up.avg[i] == null && down.avg[i] == null) return { head: times, lines: [["", "нет данных"]] };
      const lines = [["", half("↑ Отдача", up, rateUp, i)], ["", half("↓ Приём", down, rateDown, i)]];
      const peak = peakLine(i);
      if (peak) lines.push(["", peak]);
      return { head: times, lines };
    },
    summary: () => {
      const zones = [...up.zone, ...down.zone];
      const f = tariffed ? pct : mbit;
      const best = (s) => worst(s.max);
      return {
        kind: "mirror",
        tariffed,
        upNow: lastValue(up.avg) == null ? null : f(lastValue(up.avg)),
        downNow: lastValue(down.avg) == null ? null : f(lastValue(down.avg)),
        upPeak: best(up) == null ? null : f(best(up)),
        downPeak: best(down) == null ? null : f(best(down)),
        red: tariffed ? zoneMinutes(up.zone.map((z, i) => Math.max(z ?? -1, down.zone[i] ?? -1)), 2, history.step_s) : 0,
        any: zones.length,
      };
    },
  };
}

// ---- cell grids ---------------------------------------------------------------

function worstRow(seriesList, i) {
  const zones = seriesList.map((s) => s.zone[i]).filter((z) => z != null);
  const cell = zones.length ? Math.max(...zones) : null;
  const peaks = seriesList.map((s) => s.peak_zone[i]).filter((z) => z != null);
  return { cell, peak: cell != null && cell < 2 && peaks.includes(2) };
}

function gridRow(key, label, seriesList, count, describe) {
  const cells = [];
  const peakDots = [];
  for (let i = 0; i < count; i += 1) {
    const { cell, peak } = worstRow(seriesList, i);
    cells.push(cell);
    peakDots.push(peak);
  }
  return { key, label, cells, peakDots, describe };
}

const valueLine = (s, i, fmt) => (s.avg[i] == null ? "нет данных" : `в среднем ${fmt(s.avg[i])}, пик ${fmt(s.max[i])}`);

export function grid24Model(history) {
  const count = columnCount(history);
  const rows = [];
  const plain = (key, label, metric, fmt) => {
    const s = seriesOf(history, metric);
    rows.push(gridRow(key, label, [s], count, (i) => valueLine(s, i, fmt)));
  };
  plain("cpu", "Процессор", "cpu", pct);
  plain("memory", "Память", "memory", pct);
  for (const link of history?.links || []) {
    const tariffed = hasTariff(link);
    const up = seriesOf(history, `link_up:${link.id}`);
    const down = seriesOf(history, `link_down:${link.id}`);
    rows.push(gridRow(`link:${link.id}`, `Канал · ${link.label}`, [up, down], count, (i) => {
      if (!tariffed) return "тариф не указан";
      if (up.avg[i] == null && down.avg[i] == null) return "нет данных";
      return `↑ ${pct(up.avg[i])} · ↓ ${pct(down.avg[i])}, пик ↑ ${pct(up.max[i])} · ↓ ${pct(down.max[i])}`;
    }));
  }
  plain("queue", "Очередь задач", "queue", (v) => num(v, 1));
  const online = seriesOf(history, "online");
  rows.push(gridRow("online", "Интернет", [online], count, (i) => (online.avg[i] == null ? "нет данных" : online.zone[i] === 0 ? "в сети" : "были перебои")));
  const temps = Object.keys(history?.metrics || {}).filter((n) => n.startsWith("temp:")).map((n) => seriesOf(history, n));
  if (temps.length) {
    rows.push(gridRow("temp", "Температура", temps, count, (i) => {
      const top = worst(temps.map((s) => s.max[i]));
      return top == null ? "нет данных" : `до ${num(top)} °C`;
    }));
  }
  return { kind: "grid24", rows, columns: count, cellSeconds: history.step_s };
}

export function grid24Summary(model, history) {
  const { rows, columns } = model;
  let heavyAt = null;
  let heavy = 0;
  for (let i = 0; i < columns; i += 1) {
    const score = rows.reduce((sum, row) => sum + (row.key === "online" ? 0 : row.cells[i] || 0), 0);
    if (score > heavy) { heavy = score; heavyAt = i; }
  }
  const red = rows
    .filter((row) => row.key !== "online")
    .map((row) => ({ label: row.label, minutes: row.cells.filter((z) => z === 2).length * history.step_s / 60 }))
    .filter((row) => row.minutes > 0);
  const online = rows.find((row) => row.key === "online");
  return {
    heavy: heavyAt == null ? null : `${hhmm(history.start + heavyAt * history.step_s)}–${hhmm(history.start + (heavyAt + 1) * history.step_s)}`,
    red,
    breaks: online ? runs(online.cells, 2) : 0,
  };
}

function runs(cells, zone) {
  let n = 0;
  for (let i = 0; i < cells.length; i += 1) if (cells[i] === zone && cells[i - 1] !== zone) n += 1;
  return n;
}

function dayStart(ts) {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

function dayLabel(offset, dayTs) {
  if (offset === 0) return "Сегодня";
  if (offset === 1) return "Вчера";
  return new Date(dayTs * 1000).toLocaleDateString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit" });
}

// Seven rows (today first), 48 cells of 30 minutes in each; metric "all" paints the worst one.
export function grid7Model(history, metric, linkId) {
  const count = columnCount(history);
  const step = history.step_s;
  const perDay = Math.max(1, Math.round(DAY_S / step));
  const end = history.start + count * step;
  const today = dayStart(end - 1);
  const names = {
    all: Object.keys(history.metrics || {}).filter((n) => n === "cpu" || n === "memory" || n === "queue" || n.startsWith("link_") || n.startsWith("temp:")),
    net: [`link_up:${linkOf(history, linkId)?.id}`, `link_down:${linkOf(history, linkId)?.id}`],
  }[metric] || [metric];
  const labelOf = (name) => (name.startsWith("link_") ? "Канал" : name.startsWith("temp:") ? "Температура" : METRIC_LABELS[name] || name);
  const series = names.map((n) => ({ name: n, s: seriesOf(history, n) }));
  const rows = Array.from({ length: WEEK_DAYS }, (_, r) => {
    const ts = today - r * DAY_S;
    return { key: `day${r}`, label: dayLabel(r, ts), dayTs: ts, cells: Array(perDay).fill(null), peakDots: Array(perDay).fill(false), by: Array(perDay).fill(null), column: Array(perDay).fill(null) };
  });
  for (let j = 0; j < count; j += 1) {
    const t = history.start + j * step;
    const ds = dayStart(t);
    const offset = Math.round((today - ds) / DAY_S);
    if (offset < 0 || offset >= WEEK_DAYS) continue;
    const c = Math.min(perDay - 1, Math.floor((t - ds) / step));
    let top = null;
    let by = null;
    let peak = false;
    for (const { name, s } of series) {
      const z = s.zone[j];
      if (z == null) continue;
      if (top == null || z > top) { top = z; by = name; }
      if (s.peak_zone[j] === 2) peak = true;
    }
    const row = rows[offset];
    row.cells[c] = top;
    row.peakDots[c] = top != null && top < 2 && peak;
    row.by[c] = by == null ? null : labelOf(by);
    row.column[c] = j;
  }
  for (const row of rows) {
    if (row.cells.every((z) => z == null)) row.label += " · нет данных";
  }
  return { kind: "grid7", rows, columns: perDay, cellSeconds: step, series, metric };
}

export function grid7Summary(model, history) {
  let best = null;
  let bestScore = 0;
  model.rows.forEach((row) => {
    row.cells.forEach((z, c) => {
      if (z == null) return;
      const score = z * 1000 + (row.peakDots[c] ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = { row, c }; }
    });
  });
  const t0 = best ? best.row.dayTs + best.c * model.cellSeconds : null;
  const online = seriesOf(history, "online");
  return {
    heavy: t0 == null ? null : `${new Date(t0 * 1000).toLocaleDateString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit" })}, ${hhmm(t0)}–${hhmm(t0 + model.cellSeconds)}`,
    breaks: runs(online.zone, 2),
  };
}

export function cellTimes(model, history, rowIndex, column) {
  if (model.kind === "grid24") {
    const t = history.start + column * model.cellSeconds;
    return { from: t, to: t + model.cellSeconds, head: `${hhmm(t)}–${hhmm(t + model.cellSeconds)}` };
  }
  const row = model.rows[rowIndex];
  const t = row.dayTs + column * model.cellSeconds;
  const date = new Date(t * 1000).toLocaleDateString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit" });
  return { from: t, to: t + model.cellSeconds, head: `${date}, ${hhmm(t)}–${hhmm(t + model.cellSeconds)}` };
}

export function xLabels(history, count, stepS) {
  const out = [];
  const total = count;
  const every = Math.max(1, Math.round(total / 6));
  for (let i = 0; i < total; i += every) {
    if (total - i < every * 0.6) break;
    out.push({ at: i / total, text: hhmm(history.start + i * stepS) });
  }
  return out;
}

export function timesOfColumn(history, i) {
  const t = history.start + i * history.step_s;
  return `${hhmm(t)}–${hhmm(t + history.step_s)}`;
}
