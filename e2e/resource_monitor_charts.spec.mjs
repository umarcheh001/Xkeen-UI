import { test, expect } from './fixtures.mjs';

const MODULE = '/static/js/features/resource_monitor/canvas_charts.js';

// Runs `body` on the real panel page with the chart module and small pixel helpers.
async function inPage(page, body, arg) {
  await page.goto('/');
  return page.evaluate(async ({ source, arg, module }) => {
    const charts = await import(module);
    const make = (w, h) => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px`;
      document.body.appendChild(canvas);
      return canvas;
    };
    const css = (name) => {
      const probe = document.createElement('canvas').getContext('2d');
      probe.fillStyle = getComputedStyle(document.body).getPropertyValue(name).trim();
      probe.fillRect(0, 0, 1, 1);
      return Array.from(probe.getImageData(0, 0, 1, 1).data);
    };
    const px = (canvas, x, y) => {
      const dpr = canvas.width / canvas.clientWidth;
      return Array.from(canvas.getContext('2d').getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data);
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('charts', 'make', 'css', 'px', 'arg', source)(charts, make, css, px, arg);
  }, { source: body, arg, module: MODULE });
}

const near = (a, b, tol = 8) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

test('network mirror fills fractional segments without inflating small loads', async ({ page }) => {
  const r = await inPage(page, `
    const canvas = make(300, 202);
    const s = { avg: [4], max: [4], zone: [0], peak_zone: [0] };
    charts.drawMiniMirror(canvas, s, s);
    return { upInside: px(canvas, 50, 98), upOutside: px(canvas, 50, 85),
      downInside: px(canvas, 50, 103), downOutside: px(canvas, 50, 115) };
  `);
  expect(r.upInside[3]).toBe(255);
  expect(r.downInside[3]).toBe(255);
  expect(r.upOutside[3]).toBeLessThan(120);
  expect(r.downOutside[3]).toBeLessThan(120);
});

test('network fill handles zero, tiny, partial, full and missing values and exact peaks', async ({ page }) => {
  const r = await inPage(page, `
    const values = [0, 0.1, 4, 25, 80, 100, 150, null];
    const canvas = make(800, 202);
    const s = { avg: values, max: values, zone: values.map(v => v == null ? null : 0) };
    charts.drawMiniMirror(canvas, s, s);
    const outside = values.map((v, i) => v == null || v >= 100 ? null : px(canvas, i * 100 + 50, Math.min(97, 101 - v - 4))[3]);
    const peak = make(100, 202);
    charts.drawMirrorChart(peak, { avg: [4], max: [37], zone: [0], peak_zone: [2] }, { avg: [4], max: [37], zone: [0], peak_zone: [2] }, { percent: true });
    return { outside, full: [px(canvas, 550, 10)[3], px(canvas, 650, 10)[3]],
      missing: px(canvas, 750, 98)[3], upPeak: px(peak, 50, 64), downPeak: px(peak, 50, 136), red: css('--op-danger') };
  `);
  for (const alpha of r.outside.filter(a => a !== null)) expect(alpha).toBeLessThan(120);
  expect(r.full).toEqual([255, 255]);
  expect(r.missing).toBe(0);
  expect(near(r.upPeak, r.red)).toBe(true);
  expect(near(r.downPeak, r.red)).toBe(true);
});

test('level chart colours segments by zone, dims unlit ones and hit-tests columns', async ({ page }) => {
  const r = await inPage(page, `
    const canvas = make(300, 100);
    const series = {
      avg: [50, 50, 50], max: [90, 50, 50], zone: [0, 1, 2], peak_zone: [2, 1, 2],
    };
    const handle = charts.drawLevelChart(canvas, series, { segments: 20, scaleMax: 100 });
    return {
      bottomAt: [50, 150, 250].map(x => px(canvas, x, 97)),
      unlit: px(canvas, 50, 2),
      peak: px(canvas, 50, 12),
      col: [handle.columnAt(150), handle.columnAt(0), handle.columnAt(299.5), handle.columnAt(100), handle.columnAt(99.9), handle.columnAt(300), handle.columnAt(-1)],
      green: css('--op-success'), orange: css('--op-warning'), red: css('--op-danger'),
    };
  `);
  expect(near(r.bottomAt[0], r.green)).toBe(true);
  expect(near(r.bottomAt[1], r.orange)).toBe(true);
  expect(near(r.bottomAt[2], r.red)).toBe(true);
  expect(r.bottomAt[0][3]).toBe(255);
  expect(r.unlit[3]).toBeGreaterThan(0);
  expect(r.unlit[3]).toBeLessThan(120);
  expect(near(r.peak, r.red)).toBe(true);
  expect(r.col).toEqual([1, 0, 2, 1, 0, -1, -1]);
});

test('null column draws outlines only', async ({ page }) => {
  const r = await inPage(page, `
    const canvas = make(300, 100);
    charts.drawLevelChart(canvas, { avg: [null, 50], max: [null, 50], zone: [null, 0], peak_zone: [null, 0] }, { segments: 20, scaleMax: 100 });
    return { inside: px(canvas, 75, 97), other: px(canvas, 225, 97) };
  `);
  expect(r.inside[3]).toBe(0);
  expect(r.other[3]).toBe(255);
});

test('mirror chart: upload above the centre line, download below, neutral without zones', async ({ page }) => {
  const r = await inPage(page, `
    const canvas = make(300, 100);
    const up = { avg: [100], max: [100], zone: [2], peak_zone: [2] };
    const down = { avg: [100], max: [100], zone: [0], peak_zone: [0] };
    charts.drawMirrorChart(canvas, up, down, { segmentsPerSide: 10, percent: true });
    const a = { above: px(canvas, 150, 47), below: px(canvas, 150, 53) };
    const canvas2 = make(300, 100);
    charts.drawMirrorChart(canvas2, up, down, { segmentsPerSide: 10, percent: true, neutral: true });
    const b = { above: px(canvas2, 150, 47), below: px(canvas2, 150, 53) };
    return { a, b, green: css('--op-success'), red: css('--op-danger'), accent: css('--op-accent') };
  `);
  expect(near(r.a.above, r.red)).toBe(true);
  expect(near(r.a.below, r.green)).toBe(true);
  expect(near(r.b.above, r.accent)).toBe(true);
  expect(near(r.b.below, r.accent)).toBe(true);
});

test('mini indicators and availability strip', async ({ page }) => {
  const r = await inPage(page, `
    const mini = make(60, 30);
    charts.drawMiniIndicator(mini, { avg: [100, 100], max: [100, 100], zone: [1, 2], peak_zone: [1, 2] }, { segments: 7, wholeColumn: true });
    const mirror = make(60, 30);
    charts.drawMiniMirror(mirror, { avg: [100], max: [100], zone: [2], peak_zone: [2] }, { avg: [100], max: [100], zone: [0], peak_zone: [0] }, { segmentsPerSide: 4 });
    const strip = make(90, 10);
    charts.drawAvailabilityStrip(strip, [0, 2, null]);
    return {
      mini: [px(mini, 15, 12), px(mini, 45, 12), px(mini, 15, 28)],
      mirror: [px(mirror, 30, 12), px(mirror, 30, 18)],
      strip: [px(strip, 15, 5), px(strip, 45, 5), px(strip, 75, 5)],
      green: css('--op-success'), orange: css('--op-warning'), red: css('--op-danger'),
    };
  `);
  expect(near(r.mini[0], r.orange)).toBe(true);
  expect(near(r.mini[1], r.red)).toBe(true);
  expect(near(r.mini[2], r.orange)).toBe(true);
  expect(near(r.mirror[0], r.red)).toBe(true);
  expect(near(r.mirror[1], r.green)).toBe(true);
  expect(near(r.strip[0], r.green)).toBe(true);
  expect(near(r.strip[1], r.red)).toBe(true);
  expect(r.strip[2][3]).toBeGreaterThan(0);
  expect(near(r.strip[2], r.green, 0)).toBe(false);
});

test('cell grid hit-testing for 96 cells and 7 day rows', async ({ page }) => {
  const r = await inPage(page, `
    const canvas = make(960, 40);
    const cells = Array.from({ length: 96 }, (_, i) => (i === 3 ? null : i % 3));
    const grid = charts.drawCellGrid(canvas, [{ label: '', cells, peakDots: cells.map(() => false) }], { columns: 96 });
    const first = grid.cellAt(5, 5), last = grid.cellAt(955, 5), edge = grid.cellAt(960, 5), under = grid.cellAt(5, 41), gapEdge = grid.cellAt(10, 5);
    const week = make(480, 140);
    const rows = Array.from({ length: 7 }, (_, d) => ({ label: 'd' + d, cells: Array.from({ length: 48 }, () => 0), peakDots: Array.from({ length: 48 }, () => false) }));
    const g2 = charts.drawCellGrid(week, rows, { columns: 48 });
    const left = g2.plot.left, w = g2.plot.width / 48, h = g2.plot.height / 7;
    return { first, last, edge, under, gapEdge,
      wk: g2.cellAt(left + w * 2.5, h * 3.5), wkOut: g2.cellAt(left - 1, 5),
      sample: px(canvas, 5, 20), nullCell: px(canvas, 35, 20), green: css('--op-success') };
  `);
  expect(r.first).toMatchObject({ row: 0, column: 0, index: 0 });
  expect(r.last).toMatchObject({ row: 0, column: 95, index: 95 });
  expect(r.gapEdge.index).toBe(1);
  expect(r.edge).toBeNull();
  expect(r.under).toBeNull();
  expect(r.wk).toMatchObject({ row: 3, column: 2, index: 3 * 48 + 2 });
  expect(r.wkOut).toBeNull();
  expect(near(r.sample, r.green)).toBe(true);
  expect(r.nullCell[3]).toBeLessThan(255);
});

test('redrawColumn repaints one column and leaves the rest untouched', async ({ page }) => {
  const r = await inPage(page, `
    const canvas = make(300, 100);
    const series = { avg: [50, 50, 50], max: [50, 50, 50], zone: [0, 0, 0], peak_zone: [0, 0, 0] };
    const handle = charts.drawLevelChart(canvas, series, { segments: 20, scaleMax: 100 });
    const ctx = canvas.getContext('2d');
    const snap = (x, w) => Array.from(ctx.getImageData(x, 0, w, 100).data).join(',');
    const before = [snap(100, 100), snap(200, 100)];
    charts.redrawColumn(handle, 0, { avg: 100, max: 100, zone: 1, peak_zone: 1 });
    return {
      same: [before[0] === snap(100, 100), before[1] === snap(200, 100)],
      top: px(canvas, 50, 3), orange: css('--op-warning'),
    };
  `);
  expect(r.same).toEqual([true, true]);
  expect(near(r.top, r.orange)).toBe(true);
});
