import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorModel } from '../../xkeen-ui/static/js/features/resource_monitor/chart_data.js';
import { drawMirrorChart } from '../../xkeen-ui/static/js/features/resource_monitor/canvas_charts.js';

const links = [{ id: 'wan', primary: true, tariff: { up_mbps: 500, down_mbps: 500 } }, { id: 'usb', tariff: null }];
const history = { links, metrics: {
  'link_up:wan': { avg: [20], max: [80] }, 'link_down:wan': { avg: [40], max: [90] },
  'rate_up:usb': { avg: [50], max: [60] }, 'rate_down:usb': { avg: [70], max: [80] },
} };

test('network current values come from selected snapshot and averages stay historical', () => {
  const snapshot = { links, values: { 'link_up:wan': 4, 'link_down:wan': 0, 'rate_up:usb': 1, 'rate_down:usb': 2 } };
  const summary = mirrorModel(history, 'wan', snapshot).summary();
  assert.equal(summary.upNow, '4 %');
  assert.equal(summary.downNow, '0 %');
  assert.equal(summary.upMean, '20 %');
  assert.equal(summary.downMean, '40 %');
  assert.equal(mirrorModel(history, 'usb', snapshot).summary().downNow, '2,0 Мбит/с');
});

test('missing current values never borrow historical values', () => {
  assert.equal(mirrorModel(history, 'wan', null).summary().upNow, null);
  assert.equal(mirrorModel(history, 'wan', { links, values: {} }).summary().downNow, null);
});

test('the last column average preserves a gap instead of reusing an older value', () => {
  const withGap = structuredClone(history);
  withGap.metrics['link_up:wan'].avg = [20, null];
  assert.equal(mirrorModel(withGap, 'wan', null).summary().upMean, null);
});

test('a tiny upload peak never paints in the download half', () => {
  const previousWindow = globalThis.window, previousStyle = globalThis.getComputedStyle;
  const fills = [];
  const ctx = { globalAlpha: 1, setTransform() {}, clearRect() {}, strokeRect() {},
    fillRect(x, y, w, h) { fills.push({ y, h, color: this.fillStyle, alpha: this.globalAlpha }); } };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', fontFamily: 'sans-serif' });
  const canvas = { clientWidth: 100, clientHeight: 202, width: 100, height: 202, style: {}, getContext: () => ctx };
  try {
    drawMirrorChart(canvas, { avg: [0.1], max: [0.1], zone: [0], peak_zone: [2] }, { avg: [0], max: [0], zone: [0] }, { percent: true });
    const peaks = fills.filter(f => f.color === '#df727b' && f.alpha === 1);
    assert.ok(peaks.length > 0);
    assert.ok(peaks.every(f => f.y + f.h <= 101));
  } finally {
    globalThis.window = previousWindow;
    globalThis.getComputedStyle = previousStyle;
  }
});
