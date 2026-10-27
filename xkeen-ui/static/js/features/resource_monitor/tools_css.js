// Styles of the tool tabs (inside the shadow root of the window). Every tab fills the
// whole width: grids with minmax(0, 1fr) columns, nothing has a fixed width.

export const TOOLS_CSS = `
.xkt-root { overflow: hidden; }
.xkt-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 10px 14px; }
.xkt-tabs { display: inline-flex; flex-wrap: wrap; gap: 6px; padding: 4px; border: 1px solid var(--op-border); border-radius: calc(var(--op-radius, 8px) + 2px); background: var(--op-surface); }
.xkt-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface-2); color: var(--op-muted); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.xkt-tab[hidden] { display: none; }
.xkt-tab:hover { border-color: var(--op-border-strong); color: var(--op-text); }
.xkt-tab:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkt-tab[aria-selected="true"] { border-color: var(--op-accent-border); background: var(--op-accent-soft, var(--op-surface-3)); color: var(--op-accent-hover, var(--op-accent)); }
.xkt-count { min-width: 18px; padding: 0 6px; border-radius: 999px; background: var(--op-danger-soft); color: var(--op-danger); font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
.xkt-count[hidden] { display: none; }
.xkt-hint { color: var(--op-faint); font-size: 12px; }
.xkt-panel { min-width: 0; border-top: 1px solid var(--op-border); }
.xkt-panel[hidden] { display: none; }
.xkt-panel[data-panel="ping"] { padding: 14px; }

.xkt-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 12px 14px; }
.xkt-lead { color: var(--op-muted); font-size: 12.5px; }
.xkt-lead b { color: var(--op-text); font-weight: 650; }
.xkt-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xkt-seg { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--op-border); border-radius: calc(var(--op-radius, 8px) + 2px); background: var(--op-surface); }
.xkt-btn { padding: 5px 12px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); color: var(--op-text); font-size: 12.5px; line-height: 1.3; cursor: pointer; }
.xkt-btn:hover:not(:disabled) { border-color: var(--op-border-strong); }
.xkt-btn:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkt-btn:disabled { opacity: .55; cursor: default; }
.xkt-btn[hidden] { display: none; }
.xkt-btn[aria-pressed="true"] { border-color: var(--op-accent-border); background: var(--op-accent-soft, var(--op-surface-3)); color: var(--op-accent-hover, var(--op-accent)); font-weight: 600; }
.xkt-primary { padding: 8px 22px; border-color: var(--op-accent-border); }
.xkt-note { margin: 0; padding: 0 14px 10px; color: var(--op-muted); font-size: 12px; }
.xkt-empty { padding: 18px 14px; color: var(--op-muted); font-size: 12.5px; }
.xkt-dim { color: var(--op-faint); }
.xkt-warn { color: var(--op-warning-strong); font-weight: 600; }

.xkt-head, .xkt-row { display: grid; align-items: center; gap: 12px; padding: 0 14px; }
.xkt-head { min-height: 34px; border-top: 1px solid var(--op-border); border-bottom: 1px solid var(--op-border); background: var(--op-surface); color: var(--op-muted); font-size: 11.5px; font-weight: 650; }
.xkt-row { min-height: 52px; border-bottom: 1px solid color-mix(in srgb, var(--op-border) 55%, transparent); }
.xkt-row:last-child { border-bottom: 0; }
.xkt-dev-cols { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1.3fr); }
.xkt-if-cols { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(0, 1fr); }
.xkt-pr-cols { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, .8fr) minmax(0, .8fr); }
.xkt-c { display: flex; flex-direction: column; justify-content: center; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xkt-c small, .xkt-ident small { overflow: hidden; color: var(--op-muted); font-size: 11.5px; text-overflow: ellipsis; }
.xkt-ident b, .xkt-strong { overflow: hidden; color: var(--op-text-strong); font-weight: 650; text-overflow: ellipsis; }
.xkt-num { font-variant-numeric: tabular-nums; }
.xkt-sig { flex-direction: row; align-items: center; gap: 8px; }
.xkt-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 15px; }
.xkt-bars i { display: block; width: 3px; border-radius: 1px; background: var(--op-surface-3); }
.xkt-bars i.on.g { background: var(--op-success); }
.xkt-bars i.on.o { background: var(--op-warning); }
.xkt-sigword { color: var(--op-text); }
.xkt-st { display: inline-flex; align-items: center; gap: 7px; color: var(--op-text); font-weight: 600; }
.xkt-st i { width: 8px; height: 8px; border-radius: 50%; background: var(--op-faint); }
.xkt-st.up i { background: var(--op-success); }
.xkt-st.down i { background: var(--op-danger); }
/* a row cell: start at the column edge, under the header (.xkt-c centres a column cell) */
.xkt-cpu { flex-direction: row; justify-content: flex-start; align-items: center; gap: 10px; }
.xkt-cpu .xkt-meter { flex: 1; max-width: 160px; }

.xkv { position: relative; overflow-y: auto; overscroll-behavior: contain; }
.xkv:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: -2px; }
.xkv-space { position: relative; }
.xkv-rows { position: absolute; top: 0; right: 0; left: 0; }
.xkv-row { overflow: hidden; }
.xkv-row .xkt-row { height: 100%; }

.xkt-meter { display: block; height: 6px; overflow: hidden; border-radius: 3px; background: var(--op-surface-3); }
.xkt-meter i { display: block; height: 100%; border-radius: 3px; background: var(--op-accent); }
.xkt-meter.g i { background: var(--op-success); }
.xkt-meter.o i { background: var(--op-warning); }
.xkt-meter.r i { background: var(--op-danger); }
.xkt-meter.p i { background: var(--op-accent); }
.xkt-tile-s.g, .xkt-hop-l.g { color: var(--op-success-strong); }
.xkt-tile-s.o, .xkt-hop-l.o { color: var(--op-warning-strong); }
.xkt-tile-s.r, .xkt-hop-l.r { color: var(--op-danger); }
.xkt-tile-s.n, .dim { color: var(--op-muted); }

.xkt-ping-form { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto auto; align-items: end; gap: 12px 16px; }
.xkt-field { display: grid; gap: 5px; min-width: 0; color: var(--op-muted); font-size: 12px; }
.xkt-input { width: 100%; padding: 8px 12px; border: 1px solid var(--op-border); border-radius: var(--op-radius, 8px); background: var(--op-surface); color: var(--op-text-strong); font: inherit; font-weight: 600; }
.xkt-input:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.xkt-quick-wrap { display: grid; gap: 5px; color: var(--op-muted); font-size: 12px; }
.xkt-quick-row { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.xkt-check { display: inline-flex; align-items: center; gap: 8px; padding-bottom: 8px; color: var(--op-text); font-size: 12.5px; }
.xkt-ping-status { min-height: 0; padding-top: 8px; color: var(--op-muted); font-size: 12.5px; }
.xkt-ping-status:empty { display: none; }
.xkt-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 14px; }
.xkt-tiles[hidden], .xkt-route[hidden], .xkt-tech[hidden] { display: none; }
.xkt-tile, .xkt-sig-tile { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 14px 16px; border: 1px solid var(--op-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-surface); }
.xkt-tile-h { color: var(--op-muted); font-size: 12.5px; }
.xkt-tile-h em { color: var(--op-faint); font-size: 11px; font-style: normal; }
.xkt-tile-v { color: var(--op-text-strong); font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; }
.xkt-tile-v small { color: var(--op-muted); font-size: 13px; font-weight: 500; }
.xkt-tile-s { font-size: 12px; }
.xkt-verdict { justify-content: center; border-color: var(--op-success-border); background: var(--op-success-soft); }
.xkt-verdict.o { border-color: var(--op-warning-border); background: var(--op-warning-soft); }
.xkt-verdict.r { border-color: color-mix(in srgb, var(--op-danger) 45%, transparent); background: var(--op-danger-soft); }
.xkt-verdict.n { border-color: var(--op-border); background: var(--op-surface); }
.xkt-verdict-t { color: var(--op-text-strong); font-size: 15px; font-weight: 650; }
.xkt-verdict small { color: var(--op-muted); font-size: 12px; }
.xkt-route { margin-top: 16px; }
.xkt-route-h { color: var(--op-text); font-size: 12.5px; }
.xkt-route-h b { font-weight: 650; }
.xkt-route-note { padding-top: 4px; color: var(--op-muted); font-size: 12.5px; }
.xkt-route-line { position: relative; display: grid; grid-template-columns: repeat(var(--hops), minmax(0, 1fr)); gap: 0; margin-top: 14px; }
.xkt-route-line::before { content: ""; position: absolute; top: 14px; right: calc(50% / var(--hops)); left: calc(50% / var(--hops)); height: 2px; background: var(--op-border-strong); }
.xkt-hop { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; padding: 0 8px; text-align: center; }
.xkt-hop-c { display: grid; place-items: center; width: 30px; height: 30px; border: 2px solid var(--op-success); border-radius: 50%; background: var(--op-surface-2); color: var(--op-text-strong); font-size: 12.5px; font-weight: 700; }
.xkt-hop-c.o { border-color: var(--op-warning); }
.xkt-hop-c.r { border-color: var(--op-danger); }
.xkt-hop.silent .xkt-hop-c { border-color: var(--op-faint); border-style: dashed; color: var(--op-muted); }
.xkt-hop.slow .xkt-hop-c { border-color: var(--op-warning); }
.xkt-hop-n { min-height: 16px; color: var(--op-muted); font-size: 12px; }
.xkt-hop-a { max-width: 100%; overflow: hidden; color: var(--op-text-strong); font-size: 12.5px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.xkt-hop-a.dim { color: var(--op-muted); font-weight: 500; }
.xkt-hop-l { font-size: 12px; font-variant-numeric: tabular-nums; }
.xkt-hop .xkt-meter { width: calc(100% - 16px); margin-top: 6px; }
.xkt-tech { margin-top: 14px; color: var(--op-muted); font-size: 12px; }
.xkt-tech pre { max-height: 240px; margin: 8px 0 0; padding: 10px 12px; overflow: auto; border-radius: var(--op-radius, 8px); background: var(--op-surface); color: var(--op-text); font-size: 11.5px; white-space: pre-wrap; }

.xkt-modems { display: grid; gap: 14px; padding: 0 14px 14px; }
.xkt-modems > .xkt-empty { padding: 4px 0; }
.xkt-modem { display: grid; gap: 14px; min-width: 0; padding: 16px; border: 1px solid var(--op-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-surface); }
.xkt-modem[data-connected="false"] { border-style: dashed; }
.xkt-modem-h { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
.xkt-modem-t { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.xkt-modem-t strong { color: var(--op-text-strong); font-size: 15px; font-weight: 650; }
.xkt-agg { padding: 2px 9px; border: 1px solid var(--op-accent-border); border-radius: 999px; background: var(--op-accent-soft, var(--op-surface-3)); color: var(--op-accent-hover, var(--op-accent)); font-size: 11.5px; font-weight: 600; }
.xkt-modem-sub { flex-basis: 100%; color: var(--op-muted); font-size: 12px; }
.xkt-modem-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; color: var(--op-muted); font-size: 12px; }
.xkt-modem-meta b { color: var(--op-text); font-weight: 650; }
.xkt-signals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.xkt-sig-tile { gap: 5px; padding: 12px 14px; background: var(--op-surface-2); }
.xkt-sig-tile .xkt-tile-v { font-size: 22px; }
.xkt-agg-h { color: var(--op-text); font-size: 12.5px; font-weight: 650; }
.xkt-carriers { display: grid; grid-template-columns: repeat(var(--n, 1), minmax(0, 1fr)); gap: 14px; margin-top: -4px; }
.xkt-carrier { display: flex; flex-direction: column; gap: 5px; min-width: 0; padding: 12px 14px; border: 1px solid var(--op-border); border-radius: var(--op-radius-lg, 10px); background: var(--op-surface-2); }
.xkt-carrier-b { color: var(--op-text-strong); font-size: 14px; font-weight: 650; }
.xkt-carrier-w { display: flex; align-items: center; gap: 10px; color: var(--op-text); font-size: 12px; }
.xkt-carrier-w .xkt-meter { flex: 1; height: 7px; }
.xkt-carrier small { color: var(--op-muted); font-size: 11.5px; }
.xkt-info { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 18px; margin: 0; padding-top: 12px; border-top: 1px solid var(--op-border); }
.xkt-info-c { min-width: 0; }
.xkt-info dt { color: var(--op-muted); font-size: 12px; }
.xkt-info dd { margin: 2px 0 0; overflow: hidden; color: var(--op-text-strong); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.xkt-probe { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.xkt-probe-status { color: var(--op-muted); font-size: 12px; }
.xkt-probe-status[hidden] { display: none; }
.xkt-probe-status[data-state="success"] { color: var(--op-success-strong); }
.xkt-probe-status[data-state="error"] { color: var(--op-warning-strong); }

.xkt-chips { padding: 0 14px 8px; }
.xkt-chips[hidden] { display: none; }
.xkt-chip { display: inline-flex; align-items: center; gap: 10px; padding: 3px 10px; border: 1px solid var(--op-accent-border); border-radius: 999px; background: var(--op-accent-soft, var(--op-surface-3)); font-size: 12px; }
.xkt-chip button { padding: 0; border: 0; background: none; color: var(--op-accent-hover, var(--op-accent)); font: inherit; text-decoration: underline; cursor: pointer; }
.xkt-ev { display: grid; grid-template-columns: 86px 12px minmax(0, 1fr) auto; align-items: start; gap: 12px; padding: 12px 14px; border-top: 1px solid color-mix(in srgb, var(--op-border) 55%, transparent); }
.xkt-ev-t { color: var(--op-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.xkt-ev-d { width: 10px; height: 10px; margin-top: 4px; border-radius: 50%; background: var(--op-success); }
.xkt-ev-d.problem { background: var(--op-danger); }
.xkt-ev-d.warning { background: var(--op-warning); }
.xkt-ev-m { display: flex; flex-direction: column; min-width: 0; }
.xkt-ev-m b { color: var(--op-text-strong); font-weight: 650; }
.xkt-ev-m small { color: var(--op-muted); font-size: 12px; }
.xkt-ev-l { color: var(--op-muted); font-size: 12px; white-space: nowrap; }

@media (max-width: 1100px) {
  .xkt-signals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .xkt-info { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .xkt-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .xkt-carriers { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .xkt-hint { display: none; }
  .xkt-ping-form { grid-template-columns: 1fr; }
  .xkt-primary { width: 100%; }
  .xkt-route-line { grid-template-columns: 1fr; gap: 10px; }
  .xkt-route-line::before { display: none; }
  .xkt-hop { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 2px 10px; padding: 0; text-align: left; }
  .xkt-hop-c { grid-row: span 2; }
  .xkt-hop-n { grid-column: 2; min-height: 0; }
  .xkt-hop-l { grid-column: 3; grid-row: 1 / span 2; }
  .xkt-hop-a { grid-column: 2; }
  .xkt-hop .xkt-meter { grid-column: 2 / -1; width: 100%; margin-top: 2px; }
  .xkt-dev-cols { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, .9fr); }
  .xkt-dev-cols > :nth-child(2), .xkt-dev-cols > :nth-child(4) { display: none; }
  .xkt-if-cols { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, .9fr); }
  .xkt-if-cols > :nth-child(3), .xkt-if-cols > :nth-child(4), .xkt-if-cols > :nth-child(5) { display: none; }
  .xkt-pr-cols { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.2fr) minmax(0, .9fr); }
  .xkt-pr-cols > :nth-child(4), .xkt-pr-cols > :nth-child(5) { display: none; }
  .xkt-ev { grid-template-columns: 62px 12px minmax(0, 1fr); }
  .xkt-ev-l { grid-column: 3; }
}
@media (max-width: 520px) {
  .xkt-tiles, .xkt-signals { grid-template-columns: 1fr; }
  .xkt-info { grid-template-columns: 1fr 1fr; }
  .xkt-modem { padding: 12px; }
}
`;
