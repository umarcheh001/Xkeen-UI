// Styles of the big chart and the tariff form (inside the shadow root of the window).

export const CHART_CSS = `
.xkc { --g: 64px; overflow: hidden; }
.xkc[hidden], .xkc-error[hidden] { display: none; }
.xkc-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--op-border); }
.xkc-tabs, .xkc-ranges, .xkc-links { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.xkc-tabs[hidden] { display: none; }
.xkc-cap { margin-right: 2px; color: var(--op-muted); font-size: 12px; }
.xkc-b { padding: 5px 12px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); color: var(--op-text); font-size: 12.5px; line-height: 1.3; cursor: pointer; }
.xkc-b[hidden] { display: none; }
.xkc-b:hover { border-color: var(--op-border-strong); }
.xkc-b:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkc-b[aria-pressed="true"] { border-color: var(--op-accent-border); background: var(--op-accent-soft, var(--op-surface-3)); color: var(--op-accent-hover, var(--op-accent)); font-weight: 600; }
.xkc-info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; min-height: 20px; padding: 10px 14px 0; color: var(--op-muted); font-size: 12px; }
.xkc-chip { display: inline-flex; align-items: center; gap: 6px; }
.xkc-chip i { width: 9px; height: 9px; border-radius: 2px; background: var(--op-success); }
.xkc-chip i.z1 { background: var(--op-warning); }
.xkc-chip i.z2 { background: var(--op-danger); }
.xkc-dim { color: var(--op-faint); }
.xkc-tariff { color: var(--op-text); }
.xkc-reserve { padding: 1px 8px; border: 1px solid var(--op-warning-border); border-radius: 999px; background: var(--op-warning-soft); color: var(--op-warning-strong); font-size: 11.5px; font-weight: 600; }
.xkc-stale { color: var(--op-warning-strong); }
.xkc-plot { display: flex; align-items: stretch; gap: 8px; padding: 12px 14px 0 8px; }
.xkc-gutter { position: relative; flex: none; width: var(--g); color: var(--op-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.xkc-gutter span { position: absolute; right: 0; max-width: 100%; overflow: hidden; text-align: right; text-overflow: ellipsis; white-space: nowrap; transform: translateY(50%); }
.xkc-gutter span.m { transform: translateY(-50%); }
.xkc-gutter span.b { color: var(--op-text-strong); font-weight: 650; }
.xkc-gutter span.rl { display: flex; align-items: center; justify-content: flex-end; transform: none; color: var(--op-text); font-size: 12px; }
.xkc-wrap { position: relative; flex: 1; min-width: 0; }
.xkc-canvas { display: block; width: 100%; touch-action: pan-y; }
.xkc-hl { position: absolute; top: 0; bottom: 0; border: 1px solid var(--op-accent-border); border-radius: 3px; background: color-mix(in srgb, var(--op-accent) 14%, transparent); pointer-events: none; }
.xkc-hl[hidden] { display: none; }
.xkc-tip { position: absolute; z-index: 4; min-width: 150px; max-width: 320px; padding: 8px 10px; border: 1px solid var(--op-border-strong); border-radius: var(--op-radius, 8px); background: var(--op-surface); box-shadow: var(--op-shadow-float); font-size: 12px; pointer-events: none; }
.xkc-tip[hidden] { display: none; }
.xkc-tip .h { margin-bottom: 3px; color: var(--op-muted); font-size: 11.5px; }
.xkc-tip .l { display: flex; justify-content: space-between; gap: 14px; }
.xkc-tip .l span { color: var(--op-muted); }
.xkc-tip .l b { color: var(--op-text-strong); font-weight: 600; font-variant-numeric: tabular-nums; }
.xkc-axis { position: relative; height: 22px; margin: 4px 14px 0 calc(8px + var(--g) + 8px); color: var(--op-muted); font-size: 11px; }
.xkc-axis span { position: absolute; top: 4px; transform: translateX(-50%); white-space: nowrap; }
.xkc-axis span.first { transform: none; }
.xkc-axis span.now { right: 0; left: auto; transform: none; }
.xkc-summary { display: flex; flex-wrap: wrap; gap: 6px 22px; padding: 10px 14px; border-top: 1px solid var(--op-border); color: var(--op-muted); font-size: 12.5px; }
.xkc-summary b { color: var(--op-text-strong); font-weight: 650; }
.xkc-summary i { color: var(--op-muted); font-style: normal; }
.xkc-summary b.z1 { color: var(--op-warning-strong); }
.xkc-summary b.z2 { color: var(--op-danger); }
.xkc-summary b.zero, .xkc-summary .zero { color: var(--op-muted); font-weight: 500; }
.xkc-error { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--op-warning-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-warning-soft); }

.xkc-form { padding: 12px 14px 4px; }
.xkc-form[hidden] { display: none; }
.xkt { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); }
.xkt-title { color: var(--op-text-strong); font-size: 13px; font-weight: 650; }
.xkt-hint { color: var(--op-muted); font-size: 12px; }
.xkt-fields { display: flex; flex-wrap: wrap; gap: 12px 18px; }
.xkt-field { display: grid; gap: 4px; min-width: 150px; font-size: 12px; color: var(--op-muted); }
.xkt-field input { width: 100%; padding: 6px 10px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface-2); color: var(--op-text); font: inherit; font-size: 13px; }
.xkt-field input:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkt-field input[aria-invalid="true"] { border-color: var(--op-danger); }
.xkt-error { min-height: 0; color: var(--op-danger); font-size: 12px; }
.xkt-error:empty { display: none; }
.xkt-actions { display: flex; gap: 8px; }
.xkt-actions .primary { border-color: var(--op-accent-border); background: var(--op-accent); color: var(--op-accent-contrast, #fff); font-weight: 600; }
.xkt-actions .primary:disabled { opacity: .6; cursor: default; }
.xkm-lazy[data-slot="chart"] { content-visibility: visible; }

@media (max-width: 760px) {
  .xkc-bar { align-items: flex-start; }
  .xkc-plot { padding-left: 4px; }
  .xkc-axis { margin-left: calc(4px + var(--g) + 8px); }
}
`;
