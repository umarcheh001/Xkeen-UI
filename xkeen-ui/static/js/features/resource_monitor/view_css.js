// Styles of the router diagnostics window. They live inside a shadow root, so the
// panel stylesheet (panel-operator.css) cannot reach them; colours come from the
// --op-* variables of the panel, which the shadow host inherits from <body>.

import { CHART_CSS } from "./chart_css.js";
import { TOOLS_CSS } from "./tools_css.js";

export const VIEW_CSS = `
:host { display: block; min-width: 0; }
* { box-sizing: border-box; }
.xkm { display: grid; gap: 14px; min-width: 0; font-size: 13px; line-height: 1.4; color: var(--op-text); }
button { font: inherit; }
a, .xkm-a { color: var(--op-accent-hover, var(--op-accent)); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; background: none; border: 0; padding: 0; font: inherit; }

.xkm-status { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid var(--op-success-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-success-soft); }
.xkm-status[data-tone="warn"] { border-color: var(--op-warning-border); background: var(--op-warning-soft); }
.xkm-status[data-tone="muted"] { border-color: var(--op-border); background: var(--op-surface-2); }
.xkm-status .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--op-success); box-shadow: 0 0 0 4px color-mix(in srgb, var(--op-success) 22%, transparent); }
.xkm-status[data-tone="warn"] .dot { background: var(--op-warning); box-shadow: 0 0 0 4px color-mix(in srgb, var(--op-warning) 22%, transparent); }
.xkm-status[data-tone="muted"] .dot { background: var(--op-faint); box-shadow: none; }
.xkm-status .msg { min-width: 0; }
.xkm-status strong { font-size: 15px; font-weight: 650; color: var(--op-text-strong); }
.xkm-status .note { color: var(--op-muted); }
.xkm-status .facts { display: flex; gap: 18px; margin-left: auto; color: var(--op-muted); font-size: 12px; white-space: nowrap; }
.xkm-status .facts b { color: var(--op-text); font-weight: 600; }

.xkm-initrc { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: start; gap: 12px; padding: 12px 16px; border: 1px solid var(--op-warning-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-warning-soft); }
.xkm-initrc .dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; background: var(--op-warning); box-shadow: 0 0 0 4px color-mix(in srgb, var(--op-warning) 22%, transparent); }
.xkm-initrc-copy { min-width: 0; overflow-wrap: anywhere; }
.xkm-initrc strong { font-weight: 650; color: var(--op-text-strong); }
.xkm-initrc .note { margin-top: 5px; color: var(--op-muted); }
.xkm-initrc code { font-size: 11px; background: var(--op-surface-2); padding: 1px 5px; border-radius: 3px; }
.xkm-initrc-actions { display: flex; flex-wrap: wrap; gap: 8px; align-self: center; }
.xkm-initrc button { padding: 7px 14px; border: 1px solid var(--op-border); border-radius: var(--op-radius-md, 8px); color: var(--op-text); background: var(--op-surface-2); cursor: pointer; font-size: 12px; }
.xkm-initrc button.primary { background: var(--op-accent); border-color: var(--op-accent); color: #fff; font-weight: 600; }
.xkm-initrc button:disabled { opacity: .6; cursor: wait; }
.xkm-initrc button:focus-visible { outline: 2px solid var(--op-accent); outline-offset: 2px; }
.xkm-initrc[data-state="confirm"] .xkm-initrc-actions, .xkm-initrc[data-state="applying"] .xkm-initrc-actions { grid-column: 2 / -1; }
.xkm-initrc[data-state="confirm"] .xkm-initrc-copy, .xkm-initrc[data-state="applying"] .xkm-initrc-copy { grid-column: 2 / -1; }
.xkm-initrc[data-state="success"] { border-color: var(--op-success-border); background: var(--op-success-soft); }
.xkm-initrc[data-state="success"] .dot { background: var(--op-success); box-shadow: 0 0 0 4px color-mix(in srgb, var(--op-success) 22%, transparent); }
@media (max-width: 600px) {
  .xkm-initrc { grid-template-columns: 10px minmax(0, 1fr); }
  .xkm-initrc-actions { grid-column: 2 / -1; }
}

.xkm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.xkm-card, .xkm-panel { min-width: 0; border: 1px solid var(--op-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-surface-2); }
.xkm-card { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px 12px; cursor: pointer; }
.xkm-card:hover { border-color: var(--op-border-strong); }
.xkm-card:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkm-card[data-zone="1"] { border-color: var(--op-warning-border); }
.xkm-card[data-zone="2"] { border-color: color-mix(in srgb, var(--op-danger) 50%, transparent); }
.xkm-card-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--op-data-muted, var(--op-muted)); font-size: 12.5px; font-weight: 600; }
.xkm-badge { padding: 2px 8px; border: 1px solid var(--op-success-border); border-radius: 999px; background: var(--op-success-soft); color: var(--op-success-strong); font-size: 11px; font-weight: 600; white-space: nowrap; }
.xkm-badge.z1 { border-color: var(--op-warning-border); background: var(--op-warning-soft); color: var(--op-warning-strong); }
.xkm-badge.z2 { border-color: color-mix(in srgb, var(--op-danger) 45%, transparent); background: var(--op-danger-soft); color: var(--op-danger); }
.xkm-badge.none { border-color: var(--op-border); background: transparent; color: var(--op-muted); }
.xkm-big { color: var(--op-text-strong); font-size: 28px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; white-space: nowrap; }
.xkm-big small { margin-left: 3px; color: var(--op-muted); font-size: 14px; font-weight: 500; }
.xkm-big .sep { margin: 0 8px; color: var(--op-faint); font-weight: 400; }
.xkm-sub { margin-bottom: 6px; overflow: hidden; color: var(--op-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.xkm-sec { margin-bottom: 6px; overflow: hidden; color: var(--op-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.xkm-spark { display: block; width: 100%; height: 34px; margin-top: auto; }

.xkm-panel-h { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--op-border); }
.xkm-panel-h h3 { margin: 0; color: var(--op-text-strong); font-size: 13.5px; font-weight: 650; }
.xkm-hint { color: var(--op-muted); font-size: 12px; }

.xkm-chain { display: flex; align-items: center; padding: 16px 14px 8px; }
.xkm-node { display: flex; align-items: center; gap: 9px; padding: 8px 12px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); color: inherit; text-align: left; white-space: nowrap; cursor: pointer; }
.xkm-node:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkm-node[aria-expanded="true"] { border-color: var(--op-accent-border); }
.xkm-node .ic { display: grid; flex: none; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--op-success-soft); color: var(--op-success-strong); font-size: 13px; font-weight: 700; }
.xkm-node.bad { border-color: color-mix(in srgb, var(--op-danger) 45%, transparent); }
.xkm-node.bad .ic { background: var(--op-danger-soft); color: var(--op-danger); }
.xkm-node.unk .ic { background: var(--op-surface-3); color: var(--op-muted); }
.xkm-node .t { display: grid; line-height: 1.25; }
.xkm-node .t b { color: var(--op-text-strong); font-size: 13px; font-weight: 600; }
.xkm-node .t span { color: var(--op-muted); font-size: 11.5px; }
.xkm-link { flex: 1; min-width: 18px; height: 2px; background: var(--op-success); opacity: .7; }
.xkm-link.bad { background: repeating-linear-gradient(90deg, var(--op-danger) 0 6px, transparent 6px 11px); opacity: 1; }
.xkm-link.unk { background: var(--op-border-strong); }
.xkm-node-detail { margin: 0 14px 8px; padding: 8px 12px; border-radius: var(--op-radius, 8px); background: var(--op-surface); color: var(--op-muted); font-size: 12.5px; }
.xkm-conn-alert { margin: 0 14px 14px; padding: 9px 12px; border-radius: var(--op-radius, 8px); background: var(--op-danger-soft); color: var(--op-text); font-size: 12.5px; }
.xkm-conn-alert b { color: var(--op-danger); }
.xkm-conn-meta { display: flex; flex-wrap: wrap; gap: 6px 22px; padding: 6px 14px 14px; color: var(--op-muted); font-size: 12px; }
.xkm-conn-meta b { color: var(--op-text); font-weight: 600; }

/* the same sections on every model: tile status lines fit one row, the ports keep room for "нет кабеля" */
.hw-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1.25fr); }
.hw-grid[data-temps="none"] { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
.hw-sec { display: grid; align-content: start; gap: 14px; min-width: 0; padding: 14px; }
.hw-sec + .hw-sec { border-left: 1px solid var(--op-border); }
.hw-sh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.hw-sh b { color: var(--op-data-muted, var(--op-muted)); font-size: 12.5px; font-weight: 650; }
.hw-sh span { color: var(--op-faint); font-size: 11.5px; }
.hw-temps { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); gap: 6px; }
.hw-t { position: relative; display: grid; align-content: start; gap: 3px; min-width: 0; padding: 10px 12px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); }
.hw-t:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.hw-t.z1 { border-color: var(--op-warning-border); }
.hw-t.z2 { border-color: color-mix(in srgb, var(--op-danger) 50%, transparent); }
.hw-t.off { border-style: dashed; }
.hw-t .n { color: var(--op-muted); font-size: 12px; }
.hw-t .n em { color: var(--op-faint); font-size: 11px; font-style: normal; }
.hw-t b { color: var(--op-text-strong); font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
.hw-t.off b { color: var(--op-faint); }
.hw-t b small { color: var(--op-muted); font-size: 12px; font-weight: 500; }
.hw-t .s { color: var(--op-success-strong); font-size: 11.5px; }
.hw-t.z1 .s { color: var(--op-warning-strong); }
.hw-t.z2 .s { color: var(--op-danger); }
.hw-t.off .s { color: var(--op-muted); }
.hw-t .hot { color: var(--op-warning-strong); font-size: 11.5px; }
.hw-track { position: relative; display: block; height: 6px; margin: 4px 0 2px; border-radius: 3px; background: var(--op-surface-3); }
.hw-track span { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; }
.hw-track .g { background: color-mix(in srgb, var(--op-success) 45%, transparent); }
.hw-track .o { background: color-mix(in srgb, var(--op-warning) 55%, transparent); }
.hw-track .r { background: color-mix(in srgb, var(--op-danger) 60%, transparent); }
.hw-t.off .hw-track .g { background: var(--op-surface-3); }
.hw-track i { position: absolute; top: -4px; width: 4px; height: 14px; margin-left: -2px; border-radius: 2px; background: var(--op-text-strong); box-shadow: 0 0 0 2px var(--op-surface); }
.hw-t[tabindex] { cursor: help; }
.hw-pop { position: absolute; z-index: 3; left: 0; top: calc(100% + 6px); width: min(320px, calc(100vw - 48px)); display: none; gap: 6px; padding: 10px 12px; border: 1px solid var(--op-border-strong); border-radius: var(--op-radius, 8px); background: var(--op-surface); box-shadow: var(--op-shadow-float); font-size: 12px; line-height: 1.45; color: var(--op-text); }
.hw-pop .p b { color: var(--op-text-strong); font-size: 12px; font-weight: 600; }
.hw-pop .zs { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--op-muted); font-size: 11.5px; }
.hw-pop .zs i { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 2px; vertical-align: 0; }
.hw-pop .zs i.g { background: var(--op-success); }
.hw-pop .zs i.o { background: var(--op-warning); }
.hw-pop .zs i.r { background: var(--op-danger); }
.hw-t:hover .hw-pop, .hw-t:focus .hw-pop, .hw-t:focus-within .hw-pop { display: grid; }
.hw-t[data-edge="end"] .hw-pop { left: auto; right: 0; }
.hw-pop .h { color: var(--op-text-strong); font-size: 12.5px; font-weight: 650; }
.hw-alert { padding: 8px 12px; border-radius: var(--op-radius, 8px); background: var(--op-warning-soft); font-size: 12.5px; }
.hw-alert b { color: var(--op-warning-strong); }
.hw-alert.z2 { background: var(--op-danger-soft); }
.hw-alert.z2 b { color: var(--op-danger); }
/* RAM across the block, the three amount-of-total cells in a row under it */
.hw-res { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 14px; }
.hw-res > .hw-m { grid-column: 1 / -1; min-width: 0; }
.hw-m .n, .hw-kv span { color: var(--op-muted); font-size: 12px; }
.hw-stack { display: flex; height: 10px; margin: 6px 0; overflow: hidden; border-radius: 5px; background: var(--op-surface-3); }
.hw-stack i { display: block; height: 100%; }
.hw-stack .p, .hw-leg .p { background: var(--op-accent); }
/* the cache is part of the free memory: hatched over the free track */
.hw-stack .c, .hw-leg .c { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--op-accent) 45%, var(--op-surface-3)) 0 3px, var(--op-surface-3) 3px 6px); }
.hw-stack .f, .hw-leg .f { background: var(--op-surface-3); }
.hw-leg { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11.5px; }
.hw-leg [title] { cursor: help; }
.hw-leg i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border: 1px solid var(--op-border); border-radius: 2px; vertical-align: -1px; }
.hw-kv { display: grid; align-content: start; gap: 3px; min-width: 0; }
.hw-kv b { color: var(--op-text-strong); font-size: 15px; font-weight: 650; }
.hw-kv b small { color: var(--op-muted); font-size: 12px; font-weight: 500; }
.hw-kv em { font-size: 11.5px; font-style: normal; }
.hw-kv em.o { color: var(--op-warning-strong); cursor: help; }
.hw-meter { height: 5px; overflow: hidden; border-radius: 3px; background: var(--op-surface-3); }
.hw-meter i { display: block; height: 100%; border-radius: 3px; background: var(--op-success); }
.hw-meter.o i { background: var(--op-warning); }
.hw-meter.r i { background: var(--op-danger); }
.hw-ports { display: grid; grid-template-columns: repeat(var(--np, 5), minmax(0, 1fr)); gap: 6px; }
.hw-port { display: grid; justify-items: center; align-content: start; gap: 3px; min-width: 0; padding: 10px 4px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); text-align: center; }
.hw-port.wan { border-color: var(--op-accent-border); }
.hw-port .jack { position: relative; width: 30px; height: 22px; border: 2px solid var(--op-border-strong); border-radius: 3px; background: var(--op-surface-3); }
.hw-port .jack::after { content: ""; position: absolute; right: 8px; bottom: -2px; left: 8px; height: 6px; border: 2px solid var(--op-border-strong); border-bottom: 0; border-radius: 2px 2px 0 0; background: var(--op-surface); }
.hw-port.up .jack { border-color: var(--op-success); background: var(--op-success-soft); }
.hw-port.warn .jack { border-color: var(--op-warning); background: var(--op-warning-soft); }
.hw-port b { font-size: 12.5px; }
.hw-port small { max-width: 100%; overflow: hidden; color: var(--op-muted); font-size: 11px; line-height: 1.25; }
.hw-port small.d { text-overflow: ellipsis; white-space: nowrap; }
.hw-port.up small { color: var(--op-success-strong); }
.hw-port.warn small { color: var(--op-warning-strong); }
.hw-port small.d { color: var(--op-faint); }
.hw-note { padding: 8px 12px; border-radius: var(--op-radius, 8px); background: var(--op-warning-soft); font-size: 12.5px; }

.xkm-lazy { min-width: 0; content-visibility: auto; contain-intrinsic-size: auto 420px; }
.xkm-lazy:empty { display: none; }

@media (max-width: 1100px) {
  .hw-grid, .hw-grid[data-temps="none"] { grid-template-columns: 1fr 1fr; }
  .hw-grid[data-temps="many"] > .hw-sec:first-child { grid-column: 1 / -1; border-bottom: 1px solid var(--op-border); }
  .hw-grid[data-temps="many"] > .hw-sec:nth-child(2) { border-left: 0; }
}
@media (max-width: 760px) {
  .xkm-kpis { grid-template-columns: 1fr 1fr; }
  .xkm-kpis > .xkm-card:nth-child(n+3) { grid-column: span 2; }
  .xkm-big { font-size: 24px; }
  .xkm-status { flex-wrap: wrap; align-items: flex-start; }
  .xkm-status .dot { margin-top: 5px; }
  .xkm-status .msg { flex: 1 1 0; }
  .xkm-status .facts { flex-wrap: wrap; gap: 4px 14px; margin-left: 22px; white-space: normal; }
  .xkm-chain { flex-wrap: wrap; gap: 8px; }
  .xkm-link { display: none; }
  .xkm-node { flex: 1 1 calc(50% - 8px); }
  .hw-grid, .hw-grid[data-temps="none"] { grid-template-columns: 1fr; }
  .hw-sec + .hw-sec { border-top: 1px solid var(--op-border); border-left: 0; }
  .hw-grid[data-temps="many"] > .hw-sec:first-child { border-bottom: 0; }
  .hw-temps { grid-template-columns: 1fr 1fr; }
  .hw-ports { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .hw-res { grid-template-columns: 1fr; }
  .hw-t[data-edge] .hw-pop { left: 0; right: auto; }
  .hw-t[data-pedge="end"] .hw-pop { left: auto; right: 0; }
}
` + CHART_CSS + TOOLS_CSS;
