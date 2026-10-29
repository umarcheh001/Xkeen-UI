// Canvas drawing for the router diagnostics window: level meters, mirror charts,
// mini indicators, availability strip and cell grids.
//
// The browser only DRAWS zones. `zone` / `peak_zone` (0 green, 1 orange, 2 red,
// null = no data) come from GET /api/system/history; thresholds are never
// recomputed here. A series is { avg, max, zone, peak_zone } of equal-length
// column arrays. Colours come from the CSS variables of the canvas element.
//
// Every draw function returns a handle; redrawColumn(handle, index, column)
// repaints exactly one column's rectangle and leaves the rest of the canvas alone.

const FALLBACK = {
  success: "#4db68b",
  warning: "#d7a650",
  danger: "#df727b",
  surface: "#20252d",
  muted: "#969da9",
  accent: "#7477e8",
};
const UNLIT_ALPHA = 0.22;
const OUTLINE_ALPHA = 0.4;
const LABEL_WIDTH = 30;

function readColors(canvas) {
  const style = getComputedStyle(canvas);
  const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const zones = [
    pick("--op-success", FALLBACK.success),
    pick("--op-warning", FALLBACK.warning),
    pick("--op-danger", FALLBACK.danger),
  ];
  return {
    zones,
    surface: pick("--op-surface-3", FALLBACK.surface),
    muted: pick("--op-muted", FALLBACK.muted),
    accent: pick("--op-accent", FALLBACK.accent),
    font: style.fontFamily || "sans-serif",
  };
}

// Size the backing store to CSS size x devicePixelRatio and scale the context,
// so all drawing below uses CSS pixels.
function prepare(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || Number(canvas.getAttribute("width")) || 300;
  const cssH = canvas.clientHeight || Number(canvas.getAttribute("height")) || 100;
  // A canvas without any CSS size would grow with its backing store; pin it.
  if (!canvas.style.width && canvas.clientWidth === canvas.width) canvas.style.width = `${cssW}px`;
  if (!canvas.style.height && canvas.clientHeight === canvas.height) canvas.style.height = `${cssH}px`;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, width: cssW, height: cssH, colors: readColors(canvas) };
}

function zoneColor(colors, zone) {
  return colors.zones[zone] || colors.zones[0];
}

function litCount(avg, scaleMax, segments) {
  if (avg == null || !(avg > 0) || !(scaleMax > 0)) return 0;
  return Math.min(segments, Math.max(1, Math.round((avg / scaleMax) * segments)));
}

function normalizeColumn(column) {
  if (!column || column.avg == null) return null;
  return column;
}

function seriesColumn(series, index) {
  return {
    avg: series?.avg?.[index] ?? null,
    max: series?.max?.[index] ?? null,
    zone: series?.zone?.[index] ?? null,
    peak_zone: series?.peak_zone?.[index] ?? null,
  };
}

function columnIndex(x, plot, count) {
  if (!(count > 0) || x < plot.left || x >= plot.left + plot.width) return -1;
  return Math.min(count - 1, Math.floor(((x - plot.left) / plot.width) * count));
}

// One stack of segments growing from baseY (dir -1 = up, +1 = down).
// style: { colorOf(zone, segmentIndex), peak, bands }.
function paintStack(ctx, colors, geo, column, style) {
  const { x, width, baseY, dir, segments, segH, gap } = geo;
  const col = normalizeColumn(column);
  const segRect = (k) => {
    const top = dir < 0 ? baseY - (k + 1) * segH : baseY + k * segH;
    return dir < 0 ? [x, top + gap, width, segH - gap] : [x, top, width, segH - gap];
  };
  if (!col) {
    ctx.globalAlpha = OUTLINE_ALPHA;
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    for (let k = 0; k < segments; k += 1) {
      const [rx, ry, rw, rh] = segRect(k);
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
    }
    ctx.globalAlpha = 1;
    return;
  }
  const lit = litCount(col.avg, geo.scaleMax, segments);
  const extent = Math.max(0, Math.min(1, (col.avg || 0) / geo.scaleMax)) * segments * segH;
  for (let k = 0; k < segments; k += 1) {
    const color = style.colorOf(col.zone, k);
    ctx.fillStyle = color;
    ctx.globalAlpha = !style.fractional && k < lit ? 1 : UNLIT_ALPHA;
    const [rx, ry, rw, rh] = segRect(k);
    ctx.fillRect(rx, ry, rw, rh);
    if (style.fractional) {
      const top = dir < 0 ? Math.max(ry, baseY - extent) : ry;
      const bottom = dir < 0 ? ry + rh : Math.min(ry + rh, baseY + extent);
      if (bottom > top) {
        ctx.globalAlpha = 1;
        ctx.fillRect(rx, top, rw, bottom - top);
      }
    }
  }
  ctx.globalAlpha = 1;
  if (style.peak && col.max != null && col.max > 0) {
    const peakSeg = Math.max(0, litCount(col.max, geo.scaleMax, segments) - 1);
    const [rx, ry, rw, rh] = segRect(peakSeg);
    ctx.fillStyle = style.peakColor(col.peak_zone ?? col.zone);
    const dashH = Math.min(2, rh);
    const peakExtent = Math.max(0, Math.min(1, col.max / geo.scaleMax)) * segments * segH;
    const peakY = dir < 0 ? baseY - peakExtent : baseY + peakExtent - dashH;
    const sideMin = dir < 0 ? baseY - segments * segH : baseY;
    const sideMax = dir < 0 ? baseY : baseY + segments * segH;
    const clippedPeakY = Math.max(sideMin, Math.min(sideMax - dashH, peakY));
    ctx.fillRect(rx, style.fractional ? clippedPeakY : (dir < 0 ? ry : ry + rh - dashH), rw, dashH);
  }
}

function columnGeometry(plot, count, index) {
  const colW = plot.width / count;
  const gap = colW >= 4 ? 1 : 0;
  const left = plot.left + index * colW;
  return { cellLeft: left, cellWidth: colW, x: left, width: Math.max(1, colW - gap) };
}

// opts: segments (20), scaleMax (100), axisLabels [{ value, text }] placed by value
// on the scale, hoverIndex, wholeColumn (mini cards: no peak dash), peak (default
// !wholeColumn), bands { orange, red } = scale values where the bands start; without
// bands a lit column is painted wholly in its own `zone` colour.
export function drawLevelChart(canvas, series, opts = {}) {
  const segments = opts.segments || 20;
  const scaleMax = opts.scaleMax || 100;
  const labels = Array.isArray(opts.axisLabels) ? opts.axisLabels : [];
  const { ctx, width, height, colors } = prepare(canvas);
  const left = labels.length ? LABEL_WIDTH : 0;
  const plot = { left, top: 0, width: Math.max(1, width - left), height };
  const count = series?.avg?.length || 0;
  const segH = height / segments;
  const gap = segH > 3 ? 1 : 0;
  const showPeak = opts.peak ?? !opts.wholeColumn;
  const bands = opts.bands;
  const bandZone = (k) => {
    if (!bands) return null;
    const value = ((k + 0.5) / segments) * scaleMax;
    return value >= bands.red ? 2 : value >= bands.orange ? 1 : 0;
  };
  const style = {
    peak: showPeak,
    colorOf: (zone, k) => zoneColor(colors, !opts.wholeColumn && bands ? bandZone(k) : zone),
    peakColor: (zone) => zoneColor(colors, zone),
  };

  if (labels.length) {
    ctx.fillStyle = colors.muted;
    ctx.font = `10px ${colors.font}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const label of labels) {
      const y = height - (label.value / scaleMax) * height;
      ctx.fillText(label.text, left - 4, Math.min(height - 5, Math.max(5, y)));
    }
  }

  const paint = (index, column, clear) => {
    const g = columnGeometry(plot, count, index);
    if (clear) ctx.clearRect(g.cellLeft, 0, g.cellWidth, height);
    if (opts.hoverIndex === index) {
      ctx.fillStyle = colors.surface;
      ctx.fillRect(g.cellLeft, 0, g.cellWidth, height);
    }
    paintStack(ctx, colors, { ...g, baseY: height, dir: -1, segments, segH, gap, scaleMax }, column, style);
  };
  for (let i = 0; i < count; i += 1) paint(i, seriesColumn(series, i), false);
  return {
    kind: "level",
    plot,
    count,
    paint,
    columnAt: (x) => columnIndex(x, plot, count),
  };
}

// Upload (up) is drawn above the centre line, download (down) below.
// opts: segmentsPerSide (10), percent (scale 100 %), scaleMax, neutral (no zones:
// every lit segment in the accent colour), hoverIndex.
export function drawMirrorChart(canvas, up, down, opts = {}) {
  const segments = opts.segmentsPerSide || 10;
  const { ctx, width, height, colors } = prepare(canvas);
  const plot = { left: 0, top: 0, width, height };
  const count = Math.max(up?.avg?.length || 0, down?.avg?.length || 0);
  const half = height / 2;
  const segH = (half - 1) / segments;
  const gap = segH > 3 ? 1 : 0;
  let scaleMax = opts.scaleMax || (opts.percent ? 100 : 0);
  if (!scaleMax) {
    for (const s of [up, down]) {
      for (const key of ["avg", "max"]) {
        for (const v of s?.[key] || []) if (v != null && v > scaleMax) scaleMax = v;
      }
    }
    scaleMax = scaleMax || 1;
  }
  const style = {
    fractional: true,
    peak: opts.peak !== false,
    colorOf: (zone) => (opts.neutral ? colors.accent : zoneColor(colors, zone)),
    peakColor: (zone) => (opts.neutral ? colors.accent : zoneColor(colors, zone)),
  };
  const paint = (index, column, clear) => {
    const g = columnGeometry(plot, count, index);
    if (clear) ctx.clearRect(g.cellLeft, 0, g.cellWidth, height);
    if (opts.hoverIndex === index) {
      ctx.fillStyle = colors.surface;
      ctx.fillRect(g.cellLeft, 0, g.cellWidth, height);
    }
    const base = { ...g, segments, segH, gap, scaleMax };
    paintStack(ctx, colors, { ...base, baseY: half, dir: -1 }, column.up, style);
    paintStack(ctx, colors, { ...base, baseY: half, dir: 1 }, column.down, style);
    ctx.fillStyle = colors.muted;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(g.cellLeft, half - 0.5, g.cellWidth, 1);
    ctx.globalAlpha = 1;
  };
  for (let i = 0; i < count; i += 1) paint(i, { up: seriesColumn(up, i), down: seriesColumn(down, i) }, false);
  return { kind: "mirror", plot, count, paint, columnAt: (x) => columnIndex(x, plot, count) };
}

export function drawMiniIndicator(canvas, series, opts = {}) {
  return drawLevelChart(canvas, series, { segments: 7, wholeColumn: true, ...opts });
}

export function drawMiniMirror(canvas, up, down, opts = {}) {
  return drawMirrorChart(canvas, up, down, { segmentsPerSide: 4, percent: true, peak: false, ...opts });
}

// cells: 0 in service (green), 1 warning (orange), 2 failure (red), null no data (grey).
export function drawAvailabilityStrip(canvas, cells) {
  const { ctx, width, height, colors } = prepare(canvas);
  const count = cells?.length || 0;
  const plot = { left: 0, top: 0, width, height };
  const paint = (index, cell, clear) => {
    const g = columnGeometry(plot, count, index);
    if (clear) ctx.clearRect(g.cellLeft, 0, g.cellWidth, height);
    ctx.fillStyle = cell == null ? colors.muted : zoneColor(colors, cell);
    ctx.globalAlpha = cell == null ? OUTLINE_ALPHA : 1;
    ctx.fillRect(g.x, 0, g.width, height);
    ctx.globalAlpha = 1;
  };
  for (let i = 0; i < count; i += 1) paint(i, cells[i], false);
  return { kind: "strip", plot, count, paint, columnAt: (x) => columnIndex(x, plot, count) };
}

// rows: { label, cells: (zone|null)[], peakDots: boolean[] }[]; opts.columns cells per row.
// cellAt(x, y) -> { row, column, index } or null outside the grid.
export function drawCellGrid(canvas, rows, opts = {}) {
  const { ctx, width, height, colors } = prepare(canvas);
  const list = Array.isArray(rows) ? rows : [];
  const columns = opts.columns || list[0]?.cells?.length || 1;
  const hasLabels = list.some((row) => row.label);
  const left = hasLabels ? LABEL_WIDTH : 0;
  const plot = { left, top: 0, width: Math.max(1, width - left), height };
  const cellW = plot.width / columns;
  const cellH = list.length ? height / list.length : height;
  const gap = cellW >= 4 && cellH >= 4 ? 1 : 0;

  const paint = (index, cell, clear) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = left + column * cellW;
    const y = row * cellH;
    if (clear) ctx.clearRect(x, y, cellW, cellH);
    const zone = cell && cell.zone !== undefined ? cell.zone : cell;
    if (zone == null) {
      ctx.globalAlpha = OUTLINE_ALPHA;
      ctx.fillStyle = colors.surface;
      ctx.fillRect(x, y, cellW - gap, cellH - gap);
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      if (gap) ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, cellW - gap - 1), Math.max(0, cellH - gap - 1));
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = zoneColor(colors, zone);
      ctx.fillRect(x, y, cellW - gap, cellH - gap);
    }
    if (cell && cell.peak) {
      ctx.fillStyle = colors.zones[2];
      ctx.fillRect(x + (cellW - gap) / 2 - 1, y + 1, 2, 2);
    }
  };

  ctx.fillStyle = colors.muted;
  ctx.font = `10px ${colors.font}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  list.forEach((row, r) => {
    if (row.label) ctx.fillText(row.label, left - 4, r * cellH + cellH / 2);
    (row.cells || []).forEach((zone, c) => {
      paint(r * columns + c, { zone: zone ?? null, peak: Boolean(row.peakDots?.[c]) }, false);
    });
  });

  return {
    kind: "grid",
    plot,
    count: list.length * columns,
    paint,
    cellAt(x, y) {
      if (x < left || x >= left + plot.width || y < 0 || y >= height || !list.length) return null;
      const column = Math.min(columns - 1, Math.floor((x - left) / cellW));
      const row = Math.min(list.length - 1, Math.floor(y / cellH));
      return { row, column, index: row * columns + column };
    },
  };
}

// Repaint a single column (level/mini/strip: series column object or zone; mirror:
// { up, down }; grid: index = row * columns + column, column = zone or { zone, peak }).
export function redrawColumn(handle, index, column) {
  if (!handle || typeof handle.paint !== "function" || index < 0 || index >= handle.count) return;
  handle.paint(index, column, true);
}
