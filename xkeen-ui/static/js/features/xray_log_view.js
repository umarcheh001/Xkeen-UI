// Output of the Xray logs screen: a virtual table for access.log and error.log,
// the route/node/level chips and the summary.
//
// Every line is parsed once when it arrives. Counters for chips and summary are
// kept incrementally, so a new line costs one parse and a few map updates.
//
// Rows live in a shadow root with their own small stylesheet. The panel's
// global stylesheet is large, and matching it against every new row cost more
// than everything else together; panel colour tokens still inherit inside.
// Table rows stay bound to their record: new lines fill only new rows, and a
// trim from the front of the buffer moves one container, not every row.
// Scroll positions are computed, never read back after a DOM change.

import { parseXrayAccessLine, parseXrayErrorLine, xrayRegistrableDomain } from './xray_log_parser.js';
import { countryFlag, nodeCountryCode, nodeDisplayName } from '../ui/country_flags.js';

const ROW_H = 32;
const HEAD_H = 30;
const OVERSCAN = 6;
const STATS_INTERVAL_MS = 1000;
const TOP_N = 3;
const NODE_CHIPS_MAX = 6;
const KINDS = ['proxy', 'direct', 'block', 'dns'];
const LEVELS = ['debug', 'info', 'warning', 'error'];
const LEVEL_LABEL = { debug: 'debug', info: 'info', warning: 'warn', error: 'error' };
const KIND_LABEL = { proxy: 'proxy', direct: 'direct', block: 'block', dns: 'dns' };

const VIEW_CSS = `
:host { --mono: var(--xk-mono-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); --c-proxy: var(--op-accent); --c-direct: var(--op-success); --c-block: var(--op-danger); --c-dns: var(--op-warning); }
* { box-sizing: border-box; }
.ic { display: block; flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.thead, .tr { display: grid; grid-template-columns: 3px 26px 64px minmax(150px, .6fr) minmax(200px, .95fr) minmax(280px, 1.25fr) 72px 26px; align-items: center; column-gap: 12px; padding-right: 8px; }
.thead { position: sticky; top: 0; z-index: 2; height: ${HEAD_H}px; border-bottom: 1px solid var(--op-border); background: var(--op-surface); color: var(--op-muted); font-size: 11px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; }
.body { position: relative; overflow: hidden; contain: strict; }
.rows { position: absolute; inset: 0 0 auto 0; will-change: transform; }
.tr { position: absolute; top: 0; left: 0; right: 0; height: ${ROW_H}px; border-bottom: 1px solid color-mix(in srgb, var(--op-border) 55%, transparent); contain: strict; user-select: none; }
.tr[hidden] { display: none; }
.tr:hover { background: var(--op-surface-2); }
.tr.sel { background: var(--op-accent-soft); }
.tr.open { background: var(--op-surface-2); }
.lv { align-self: stretch; background: var(--k, transparent); }
.k-proxy { --k: var(--c-proxy); } .k-direct { --k: var(--c-direct); } .k-block { --k: var(--c-block); } .k-dns { --k: var(--c-dns); }
.k-debug { --k: var(--op-border-strong); } .k-info { --k: var(--op-accent); } .k-warning { --k: var(--op-warning); } .k-error { --k: var(--op-danger); } .k-raw { --k: var(--op-border-strong); }
.ts, .pp { color: var(--op-faint); font: 12px var(--mono); font-variant-numeric: tabular-nums; }
.pp { color: var(--op-muted); }
.dev, .dst, .rt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dev small { margin-left: 4px; color: var(--op-faint); font: 11px var(--mono); }
.dst { color: var(--op-text-strong); font: 12.5px var(--mono); }
.dst small { color: var(--op-faint); font-size: 11.5px; }
.rt { display: flex; align-items: center; gap: 6px; }
.raw { display: none; }
.tr.is-raw { grid-template-columns: 3px 26px minmax(0, 1fr); }
.tr.is-raw > :is(.ts, .dev, .dst, .rt, .pp, .chev) { display: none; }
.tr.is-raw > .raw { display: block; overflow: hidden; color: var(--op-muted); font: 12px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.cb { position: relative; justify-self: center; width: 14px; height: 14px; border: 1.5px solid var(--op-border-strong); border-radius: 4px; opacity: 0; cursor: pointer; }
.thead .cb, .tr:hover .cb, .has-sel .cb { opacity: 1; }
.cb[aria-checked="true"], .cb[aria-checked="mixed"] { border-color: var(--op-accent); background: var(--op-accent); opacity: 1; }
.cb[aria-checked="true"]::after { content: ""; position: absolute; top: .5px; left: 3.5px; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.cb[aria-checked="mixed"]::after { content: ""; position: absolute; top: 5px; left: 2px; width: 7px; height: 2px; background: #fff; }
.chev { display: grid; place-items: center; justify-self: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--op-faint); cursor: pointer; }
.tr:hover .chev { background: var(--op-surface-3); color: var(--op-text); }
.tr.open .chev { color: var(--op-accent); }
.tr.open .chev .ic { transform: rotate(180deg); }
.pill { display: inline-flex; flex: 0 1 auto; align-items: center; gap: 5px; min-width: 0; height: 20px; padding: 0 8px; overflow: hidden; border: 1px solid transparent; border-radius: 999px; font: 600 11.5px/20px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.pill.in { flex: 0 0 auto; border-color: var(--op-border); background: var(--op-surface-2); color: var(--op-muted); font-weight: 500; }
.pill.proxy { background: var(--op-accent-soft); color: var(--op-accent); font-family: inherit; }
.pill.direct { background: var(--op-success-soft); color: var(--op-success); }
.pill.block { background: var(--op-danger-soft); color: var(--op-danger); }
.pill.dns { background: var(--op-warning-soft); color: var(--op-warning); }
.arr { flex: 0 0 auto; color: var(--op-faint); }
.grp { overflow: hidden; color: var(--op-faint); font: 11px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.flag { display: inline-flex; flex: 0 0 auto; width: 18px; height: 13px; overflow: hidden; border-radius: 2px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--op-text) 18%, transparent); }
.flag svg { display: block; width: 18px; height: 13px; }
.detail { position: absolute; top: 0; left: 0; right: 0; z-index: 1; display: grid; gap: 8px; padding: 10px 14px 12px 44px; border-bottom: 1px solid var(--op-border); background: var(--op-surface); user-select: text; }
.detail dl { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 0; }
.detail dt { color: var(--op-muted); font-size: 11px; }
.detail dd { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--op-text-strong); font: 12px var(--mono); }
.detail .line { padding: 6px 8px; overflow-wrap: anywhere; border: 1px dashed var(--op-border); border-radius: var(--op-radius-sm, 6px); background: var(--op-editor); color: var(--op-muted); font: 11.5px var(--mono); }
.acts { display: flex; flex-wrap: wrap; gap: 6px; }
.btn { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px; border: 1px solid var(--op-border); border-radius: var(--op-control-radius, 6px); background: var(--op-surface-2); color: var(--op-text); font: 600 12px inherit; font-family: inherit; white-space: nowrap; cursor: pointer; }
.btn:hover { background: var(--op-surface-3); }
.btn.on { border-color: var(--op-accent-border); background: var(--op-accent-soft); color: var(--op-accent); }
.btn:focus-visible, .chev:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.wrap.is-error .thead, .wrap.is-error .tr { grid-template-columns: 3px 26px 92px 52px minmax(140px, .32fr) minmax(0, 1fr) 26px; }
.ts i { font-style: normal; opacity: .55; }
.lvl { color: var(--k, var(--op-faint)); font: 700 10px/16px var(--mono); letter-spacing: .04em; text-transform: uppercase; }
.k-debug .lvl { color: var(--op-faint); }
.mod { min-width: 0; overflow: hidden; color: var(--op-accent); font: 12px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.msg { min-width: 0; overflow: hidden; color: var(--op-text); font: 12.5px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.msg .sid { color: var(--op-faint); }
.tr.k-error:not(.sel) { background: color-mix(in srgb, var(--op-danger) 9%, transparent); }
.tr.k-error .msg { color: var(--op-danger); }
.detail .full { overflow-wrap: anywhere; color: var(--op-text); font: 12.5px/1.55 var(--mono); white-space: pre-wrap; }
.empty { position: absolute; inset: ${HEAD_H}px 0 0; display: grid; place-content: center; gap: 4px; padding: 16px; color: var(--op-muted); text-align: center; pointer-events: none; }
.empty[hidden] { display: none; }
.empty [data-empty-state="title"] { color: var(--op-text); font-weight: 600; }
.ansi-bold { font-weight: 700; } .ansi-underline { text-decoration: underline; }
.wrap { position: relative; min-width: 860px; }
.wrap.is-error { min-width: 640px; }
@media (max-width: 900px) {
  .wrap { min-width: 620px; }
  .wrap.is-error { min-width: 520px; }
  .thead, .tr { grid-template-columns: 3px 26px 60px minmax(90px, .6fr) minmax(140px, 1fr) minmax(170px, 1fr) 0 26px; column-gap: 8px; }
  .pp, .thead > :nth-child(7) { visibility: hidden; }
  .wrap.is-error .thead, .wrap.is-error .tr { grid-template-columns: 3px 26px 76px 44px minmax(90px, .4fr) minmax(0, 1fr) 26px; column-gap: 8px; }
}
`;

let viewSheet = null;

function adoptViewStyles(shadow) {
  try {
    if (!viewSheet && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
      viewSheet = new CSSStyleSheet();
      viewSheet.replaceSync(VIEW_CSS);
    }
    if (viewSheet && 'adoptedStyleSheets' in shadow) {
      shadow.adoptedStyleSheets = [viewSheet];
      return '';
    }
  } catch (e) {}
  return `<style>${VIEW_CSS}</style>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bump(map, key, delta) {
  if (!key) return;
  const next = (map.get(key) || 0) + delta;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function topEntries(map, limit) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function percent(part, total) {
  if (!total) return 0;
  const value = (part * 100) / total;
  return value > 0 && value < 1 ? 1 : Math.round(value);
}

// Search syntax matches services/log_filter.py: spaces are AND, '|' is OR.
export function buildXrayLogSearchGroups(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .split('|')
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.split(/\s+/).filter(Boolean));
}

function splitSubscriptionTag(tag) {
  const value = String(tag || '');
  const at = value.indexOf('--');
  if (at <= 0) return { group: '', node: value };
  return { group: value.slice(0, at), node: value.slice(at + 2) };
}

function iconInShadow(html) {
  return String(html || '').replace(/class="xk-action-icon[^"]*"/, 'class="ic"');
}

export function createXrayLogView(options) {
  const opts = options || {};
  const host = opts.root;
  const hooks = {
    deviceName: typeof opts.deviceName === 'function' ? opts.deviceName : () => '',
    domainHint: typeof opts.domainHint === 'function' ? opts.domainHint : () => '',
    nodeName: typeof opts.nodeName === 'function' ? opts.nodeName : () => null,
    icon: typeof opts.icon === 'function' ? opts.icon : () => '',
    ansi: typeof opts.ansi === 'function' ? opts.ansi : null,
    onContextMenu: typeof opts.onContextMenu === 'function' ? opts.onContextMenu : null,
    onCopy: typeof opts.onCopy === 'function' ? opts.onCopy : null,
    onRenameDevice: typeof opts.onRenameDevice === 'function' ? opts.onRenameDevice : null,
    onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
  };
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const inlineStyle = adoptViewStyles(shadow);

  const state = {
    mode: '',
    maxLines: 800,
    seq: 0,
    ord: 0,
    records: [],
    visible: [],
    frozen: false,
    follow: true,
    decoVersion: 1,
    filter: {
      groups: [],
      kinds: new Set(KINDS),
      levels: new Set(LEVELS),
      nodes: new Set(),
      conditions: [],
      showRaw: false,
    },
    counts: {
      kinds: new Map(),
      nodes: new Map(),
      devices: new Map(),
      domains: new Map(),
      levels: new Map(),
      raw: 0,
    },
    selected: new Set(),
    anchorSeq: null,
    openSeq: null,
    openOrd: null,
    detailH: 0,
    emptyHtml: '',
    statsTimer: null,
    statsDirty: false,
    renderQueued: false,
    scrollTop: 0,
    viewH: 0,
    rowsBySeq: new Map(),
    freeRows: [],
    baseOrd: 0,
    nodeCache: new Map(),
  };

  const dom = {
    wrap: null,
    thead: null,
    body: null,
    rows: null,
    detail: null,
    empty: null,
    chips: opts.chips || null,
    summary: opts.summary || null,
    selbar: opts.selbar || null,
  };

  // ---------- Records ----------

  function nodeInfo(tag) {
    if (!tag) return null;
    const cached = state.nodeCache.get(tag);
    if (cached) return cached;
    const known = hooks.nodeName(tag);
    const split = splitSubscriptionTag(tag);
    const rawName = (known && known.name) || split.node || tag;
    const code = nodeCountryCode(rawName);
    const flag = code ? countryFlag(code) : null;
    const info = {
      tag,
      code,
      flagSvg: flag && flag.svg ? flag.svg : '',
      flagLabel: flag ? flag.label : '',
      label: (code ? nodeDisplayName(rawName, code) : rawName) || tag,
      group: (known && known.subscription) || split.group,
    };
    state.nodeCache.set(tag, info);
    return info;
  }

  function makeRecord(line) {
    const text = String(line ?? '').replace(/\r?\n$/, '');
    const record = { seq: ++state.seq, ord: 0, line: text, lower: '', p: null, kind: '', level: '', domain: '', html: null, v: 0 };
    if (state.mode === 'access') {
      const p = parseXrayAccessLine(text);
      if (p) {
        record.p = p;
        record.kind = p.kind || '';
        record.domain = p.host ? xrayRegistrableDomain(p.host) : '';
      }
    } else {
      const p = parseXrayErrorLine(text);
      if (p) {
        record.p = p;
        record.level = p.level;
      }
    }
    return record;
  }

  function countRecord(record, delta) {
    const c = state.counts;
    if (!record.p) {
      c.raw += delta;
      return;
    }
    if (state.mode === 'access') {
      bump(c.kinds, record.kind, delta);
      if (record.kind === 'proxy') bump(c.nodes, record.p.outTag, delta);
      bump(c.devices, record.p.srcIp, delta);
      bump(c.domains, record.domain, delta);
    } else {
      bump(c.levels, record.level, delta);
    }
  }

  function resetCounts() {
    const c = state.counts;
    c.kinds.clear();
    c.nodes.clear();
    c.devices.clear();
    c.domains.clear();
    c.levels.clear();
    c.raw = 0;
  }

  // ---------- Filter ----------

  function matches(record) {
    const f = state.filter;
    if (!record.p) {
      if (!f.showRaw) return false;
    } else if (state.mode === 'access') {
      if (record.kind && !f.kinds.has(record.kind)) return false;
      if (f.nodes.size && !(record.kind === 'proxy' && f.nodes.has(record.p.outTag))) return false;
      for (const cond of f.conditions) {
        if (cond.field === 'ip' && record.p.srcIp !== cond.value) return false;
        if (cond.field === 'host' && record.p.host !== cond.value) return false;
        if (cond.field === 'domain' && record.domain !== cond.value) return false;
        if (cond.field === 'node' && record.p.outTag !== cond.value) return false;
      }
    } else {
      if (!f.levels.has(record.level)) return false;
      for (const cond of f.conditions) {
        if (cond.field === 'module' && record.p.module !== cond.value) return false;
        if (cond.field === 'session' && record.p.session !== cond.value) return false;
      }
    }
    if (f.groups.length) {
      if (!record.lower) record.lower = record.line.toLowerCase();
      const lower = record.lower;
      if (!f.groups.some((terms) => terms.every((term) => lower.includes(term)))) return false;
    }
    return true;
  }

  function pushVisible(record) {
    record.ord = state.ord++;
    state.visible.push(record);
  }

  function renumber() {
    state.ord = 0;
    state.visible.forEach((record) => { record.ord = state.ord++; });
    state.baseOrd = 0;
    state.rowsBySeq.forEach((row) => { row._y = null; });
  }

  function refilter() {
    state.visible = [];
    state.ord = 0;
    state.records.forEach((record) => { if (matches(record)) pushVisible(record); });
    state.baseOrd = state.visible.length ? state.visible[0].ord : 0;
    const shown = new Set(state.visible.map((r) => r.seq));
    state.selected.forEach((seq) => { if (!shown.has(seq)) state.selected.delete(seq); });
    if (state.openSeq != null && !shown.has(state.openSeq)) state.openSeq = null;
    releaseAllRows();
  }

  // ---------- Shells ----------

  function buildShell(mode) {
    state.rowsBySeq.clear();
    state.freeRows = [];
    const head = mode === 'access'
      ? '<span>Время</span><span>Устройство</span><span>Назначение</span><span>Маршрут</span><span>Порт</span><span></span>'
      : '<span>Время</span><span>Уровень</span><span>Модуль</span><span>Сообщение</span><span></span>';
    shadow.innerHTML = `${inlineStyle}<div class="wrap is-${mode}" part="wrap">
      <div class="thead" role="row"><span></span>
        <span class="cb" role="checkbox" aria-checked="false" aria-label="Выбрать все видимые строки" data-act="select-all"></span>${head}</div>
      <div class="body" role="rowgroup"><div class="rows"></div></div>
      <div class="empty" hidden></div></div>`;
    dom.wrap = shadow.querySelector('.wrap');
    dom.thead = shadow.querySelector('.thead');
    dom.body = shadow.querySelector('.body');
    dom.rows = shadow.querySelector('.rows');
    dom.detail = null;
    dom.empty = shadow.querySelector('.empty');
    host.dataset.xlogMode = mode;
  }

  // ---------- Access table ----------

  function deviceHtml(ip) {
    const name = hooks.deviceName(ip);
    const value = String(ip || '');
    // The full address follows the name in grey: a bare ".22" read as part of the name.
    if (name) return `${escapeHtml(name)} <small>${escapeHtml(value)}</small>`;
    return escapeHtml(value);
  }

  function destinationHtml(p) {
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(p.host) || p.host.includes(':');
    const hint = isIp ? hooks.domainHint(p.host) : '';
    return `${escapeHtml(p.host || '—')}${hint ? ` <small>· ${escapeHtml(hint)}</small>` : ''}`;
  }

  function flagHtml(info) {
    return info && info.flagSvg ? `<span class="flag" title="${escapeHtml(info.flagLabel)}">${info.flagSvg}</span>` : '';
  }

  function routeHtml(p, kind) {
    const inPill = p.inTag ? `<span class="pill in">${escapeHtml(p.inTag)}</span>` : '';
    const arrow = inPill ? '<span class="arr">→</span>' : '';
    if (p.status === 'rejected') return `${inPill}${arrow}<span class="pill block">rejected</span>`;
    if (!p.outTag) return inPill;
    if (kind === 'proxy') {
      const info = nodeInfo(p.outTag);
      const group = info.group ? `<span class="grp">${escapeHtml(info.group)}</span>` : '';
      return `${inPill}${arrow}<span class="pill proxy" title="${escapeHtml(p.outTag)}">${flagHtml(info)}${escapeHtml(info.label)}</span>${group}`;
    }
    return `${inPill}${arrow}<span class="pill ${kind || 'proxy'}">${escapeHtml(p.outTag)}</span>`;
  }

  function rowHtml(record) {
    if (record.html && record.v === state.decoVersion) return record.html;
    const p = record.p;
    const chev = `<button type="button" class="chev" data-act="expand" aria-label="Подробности строки">${iconInShadow(hooks.icon('chevron-down'))}</button>`;
    const cb = '<span class="cb" role="checkbox" aria-checked="false" data-act="toggle"></span>';
    if (!p) {
      record.html = `<span class="lv"></span>${cb}<span class="raw">${escapeHtml(record.line)}</span>`;
    } else if (state.mode !== 'access') {
      const message = escapeHtml(p.message);
      record.html = `<span class="lv"></span>${cb}<span class="ts">${escapeHtml(p.time)}<i>${escapeHtml(p.frac.slice(0, 4))}</i></span>`
        + `<span class="lvl">${LEVEL_LABEL[p.level] || p.level}</span>`
        + `<span class="mod" title="${escapeHtml(p.module)}">${escapeHtml(p.module || '—')}</span>`
        + `<span class="msg" title="${message}">${p.session ? `<span class="sid">[${escapeHtml(p.session)}]</span> ` : ''}${message}</span>${chev}`;
    } else {
      record.html = `<span class="lv"></span>${cb}<span class="ts">${escapeHtml(p.time)}</span>`
        + `<span class="dev" title="${escapeHtml(hooks.deviceName(p.srcIp) ? `${hooks.deviceName(p.srcIp)} · ${p.srcIp}` : p.srcIp)}">${deviceHtml(p.srcIp)}</span>`
        + `<span class="dst" title="${escapeHtml(p.host ? `${p.host}:${p.port}` : '')}">${destinationHtml(p)}</span>`
        + `<span class="rt">${routeHtml(p, record.kind)}</span>`
        + `<span class="pp">${p.port ? `${escapeHtml(p.port)}/${escapeHtml(p.proto || 'tcp')}` : ''}</span>${chev}`;
    }
    record.v = state.decoVersion;
    return record.html;
  }

  function releaseRow(row) {
    if (row._seq != null) state.rowsBySeq.delete(row._seq);
    row._seq = null;
    row.hidden = true;
    state.freeRows.push(row);
  }

  function releaseAllRows() {
    Array.from(state.rowsBySeq.values()).forEach(releaseRow);
  }

  function takeRow() {
    const row = state.freeRows.pop();
    if (row) {
      row.hidden = false;
      return row;
    }
    const fresh = document.createElement('div');
    fresh.setAttribute('role', 'row');
    dom.rows.appendChild(fresh);
    return fresh;
  }

  function rowY(record) {
    const ord = record.ord;
    return ord * ROW_H + (state.openOrd != null && ord > state.openOrd ? state.detailH : 0);
  }

  function syncRowState(row, record) {
    const sel = state.selected.has(record.seq);
    const open = state.openSeq === record.seq;
    if (row._sel !== sel) {
      row._sel = sel;
      row.classList.toggle('sel', sel);
      const cb = row.children[1];
      if (cb) cb.setAttribute('aria-checked', sel ? 'true' : 'false');
    }
    if (row._open !== open) {
      row._open = open;
      row.classList.toggle('open', open);
    }
    const y = rowY(record);
    if (row._y !== y) {
      row._y = y;
      row.style.transform = `translateY(${y}px)`;
    }
  }

  function bindRow(row, record) {
    row._seq = record.seq;
    row._v = state.decoVersion;
    row._sel = null;
    row._open = null;
    row._y = null;
    row.dataset.seq = String(record.seq);
    const kind = record.p ? (state.mode === 'access' ? (record.kind || 'none') : record.level) : 'raw';
    row.className = `tr k-${kind}${record.p ? '' : ' is-raw'}`;
    row.innerHTML = rowHtml(record);
    state.rowsBySeq.set(record.seq, row);
  }

  function errorDetailHtml(record) {
    const p = record.p;
    const icon = (name) => iconInShadow(hooks.icon(name));
    const message = hooks.ansi ? hooks.ansi(escapeHtml(p.message)) : escapeHtml(p.message);
    return `
      <dl>
        <div><dt>Время</dt><dd>${escapeHtml(p.date)} ${escapeHtml(p.time)}${escapeHtml(p.frac)}</dd></div>
        <div><dt>Уровень</dt><dd>${escapeHtml(LEVEL_LABEL[p.level] || p.level)}</dd></div>
        <div><dt>Модуль</dt><dd>${escapeHtml(p.module || '—')}</dd></div>
        <div><dt>Соединение</dt><dd>${escapeHtml(p.session || '—')}</dd></div>
      </dl>
      <div class="full">${message}</div>
      <div class="acts">
        ${p.module ? `<button type="button" class="btn${condOn('module', p.module)}" data-act="cond" data-field="module" data-value="${escapeHtml(p.module)}" data-label="${escapeHtml(p.module)}">${icon('search')}Только ${escapeHtml(p.module)}</button>` : ''}
        ${p.session ? `<button type="button" class="btn${condOn('session', p.session)}" data-act="cond" data-field="session" data-value="${escapeHtml(p.session)}" data-label="[${escapeHtml(p.session)}]">${icon('search')}Это соединение [${escapeHtml(p.session)}]</button>` : ''}
        <button type="button" class="btn" data-act="copy-line" data-seq="${record.seq}">${icon('duplicate')}Копировать строку</button>
      </div>`;
  }

  function detailHtml(record) {
    const p = record.p;
    if (!p) return '';
    if (state.mode !== 'access') return errorDetailHtml(record);
    const info = record.kind === 'proxy' ? nodeInfo(p.outTag) : null;
    const device = hooks.deviceName(p.srcIp);
    const icon = (name) => iconInShadow(hooks.icon(name));
    const nodeBtn = info
      ? `<button type="button" class="btn${condOn('node', p.outTag)}" data-act="cond" data-field="node" data-value="${escapeHtml(p.outTag)}" data-label="${escapeHtml(info.label)}">${flagHtml(info) || icon('search')}Только узел ${escapeHtml(info.label)}</button>`
      : '';
    return `
      <dl>
        <div><dt>Устройство</dt><dd>${escapeHtml(device || '—')} · ${escapeHtml(p.srcIp)}</dd></div>
        <div><dt>Назначение</dt><dd>${escapeHtml(p.host || '—')}${p.port ? ':' + escapeHtml(p.port) : ''}${p.proto ? ' (' + escapeHtml(p.proto) + ')' : ''}</dd></div>
        <div><dt>${info ? 'Узел' : 'Outbound'}</dt><dd>${info ? flagHtml(info) + escapeHtml(info.label) : escapeHtml(p.outTag || '—')}</dd></div>
        ${info ? `<div><dt>Тег outbound${info.group ? ' / подписка' : ''}</dt><dd>${escapeHtml(p.outTag)}${info.group ? ' · ' + escapeHtml(info.group) : ''}</dd></div>` : ''}
        <div><dt>Пользователь</dt><dd>${escapeHtml(p.email || '—')}</dd></div>
        ${p.reason ? `<div><dt>Причина</dt><dd>${escapeHtml(p.reason)}</dd></div>` : ''}
      </dl>
      <div class="line">${escapeHtml(record.line)}</div>
      <div class="acts">
        <button type="button" class="btn${condOn('ip', p.srcIp)}" data-act="cond" data-field="ip" data-value="${escapeHtml(p.srcIp)}" data-label="${escapeHtml(device || p.srcIp)}">${icon('devices')}Только это устройство</button>
        ${hooks.onRenameDevice && /[.:]/.test(p.srcIp) ? `<button type="button" class="btn" data-act="rename-device" data-ip="${escapeHtml(p.srcIp)}" data-name="${escapeHtml(device)}">${icon('devices')}Имя устройства…</button>` : ''}
        ${p.host ? `<button type="button" class="btn${condOn('host', p.host)}" data-act="cond" data-field="host" data-value="${escapeHtml(p.host)}" data-label="${escapeHtml(p.host)}">${icon('search')}Только ${escapeHtml(p.host)}</button>` : ''}
        ${nodeBtn}
        <button type="button" class="btn" data-act="copy-line" data-seq="${record.seq}">${icon('duplicate')}Копировать строку</button>
      </div>`;
  }

  function syncDetail() {
    let openRecord = null;
    if (state.openSeq != null) openRecord = state.visible.find((r) => r.seq === state.openSeq) || null;
    if (!openRecord) {
      state.openSeq = null;
      state.openOrd = null;
      state.detailH = 0;
      if (dom.detail) {
        dom.detail.remove();
        dom.detail = null;
      }
      return;
    }
    if (!dom.detail) {
      dom.detail = document.createElement('div');
      dom.detail.className = 'detail';
      dom.rows.appendChild(dom.detail);
    }
    if (dom.detail._seq !== openRecord.seq || dom.detail._v !== state.decoVersion) {
      dom.detail.innerHTML = detailHtml(openRecord);
      dom.detail._seq = openRecord.seq;
      dom.detail._v = state.decoVersion;
      state.detailH = dom.detail.offsetHeight;
    }
    state.openOrd = openRecord.ord;
    dom.detail.style.transform = `translateY(${(openRecord.ord + 1) * ROW_H}px)`;
  }

  function contentHeight() {
    return state.visible.length * ROW_H + (state.openOrd != null ? state.detailH : 0);
  }

  function renderTable() {
    if (!dom.rows) return;
    syncDetail();
    const total = state.visible.length;
    const bodyH = contentHeight();
    if (dom.body._h !== bodyH) {
      dom.body._h = bodyH;
      dom.body.style.height = `${bodyH}px`;
    }
    if (dom.rows._base !== state.baseOrd) {
      dom.rows._base = state.baseOrd;
      dom.rows.style.transform = `translateY(${-state.baseOrd * ROW_H}px)`;
    }

    const viewH = state.viewH || 600;
    const top = Math.max(0, state.scrollTop - HEAD_H);
    let first = Math.floor(top / ROW_H);
    if (state.openOrd != null && first > state.openOrd - state.baseOrd) {
      first = Math.floor(Math.max(0, top - state.detailH) / ROW_H);
    }
    first = Math.max(0, first - OVERSCAN);
    const last = Math.min(total, first + Math.ceil(viewH / ROW_H) + OVERSCAN * 2);

    const keep = new Set();
    for (let i = first; i < last; i += 1) keep.add(state.visible[i].seq);
    Array.from(state.rowsBySeq.entries()).forEach(([seq, row]) => {
      if (!keep.has(seq) || row._v !== state.decoVersion) releaseRow(row);
    });
    const ordered = [];
    for (let i = first; i < last; i += 1) {
      const record = state.visible[i];
      let row = state.rowsBySeq.get(record.seq);
      if (!row) {
        row = takeRow();
        bindRow(row, record);
      }
      syncRowState(row, record);
      ordered.push(row);
    }
    // Keep DOM order equal to screen order (screen readers, copy, tests).
    // Rows already in place are not touched; on append only new rows move.
    let ref = dom.rows.firstChild;
    for (const row of ordered) {
      while (ref && ref !== row && (ref.hidden || ref === dom.detail)) ref = ref.nextSibling;
      if (row === ref) {
        ref = ref.nextSibling;
        continue;
      }
      dom.rows.insertBefore(row, ref);
    }

    const headCb = dom.thead && dom.thead.children[1];
    if (headCb) {
      const n = state.selected.size;
      const value = n === 0 ? 'false' : (n >= total ? 'true' : 'mixed');
      if (headCb.getAttribute('aria-checked') !== value) headCb.setAttribute('aria-checked', value);
    }
    const hasSel = state.selected.size > 0;
    if (dom.wrap._sel !== hasSel) {
      dom.wrap._sel = hasSel;
      dom.wrap.classList.toggle('has-sel', hasSel);
    }
  }

  // ---------- Scrolling and rendering ----------

  function nearBottom() {
    return state.scrollTop + (state.viewH || 0) >= HEAD_H + contentHeight() - ROW_H;
  }

  function scrollToEnd() {
    const target = Math.max(0, HEAD_H + contentHeight() - (state.viewH || 0));
    state.scrollTop = target;
    host.scrollTop = target;
  }

  function renderEmpty() {
    if (!dom.empty) return;
    const empty = state.visible.length === 0;
    if (empty && state.emptyHtml) {
      if (dom.empty._html !== state.emptyHtml) {
        dom.empty._html = state.emptyHtml;
        dom.empty.innerHTML = state.emptyHtml;
      }
      if (dom.empty.hidden) dom.empty.hidden = false;
    } else if (!dom.empty.hidden) {
      dom.empty.hidden = true;
    }
  }

  function renderAll() {
    if (state.follow || nearBottom()) scrollToEnd();
    renderTable();
    renderEmpty();
    renderSelbar();
    markStatsDirty(true);
  }

  function onScroll() {
    state.scrollTop = host.scrollTop;
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderTable();
    });
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      state.viewH = host.clientHeight;
      renderTable();
    }).observe(host);
  }
  state.viewH = host.clientHeight;

  // ---------- Chips and summary ----------

  function lightFlagHtml(info) {
    return info && info.flagSvg ? `<span class="xk-xlog-flag" title="${escapeHtml(info.flagLabel)}">${info.flagSvg}</span>` : '';
  }

  function chipHtml({ act, value, on, label, count, dot, extra }) {
    return `<button type="button" class="xk-xlog-chip${on ? ' is-on' : ''}" data-xlog-act="${act}" data-value="${escapeHtml(value)}" aria-pressed="${on ? 'true' : 'false'}">`
      + `${dot ? `<span class="dot dot-${dot}"></span>` : ''}${extra || ''}${escapeHtml(label)}`
      + `${count != null ? `<em>${count}</em>` : ''}</button>`;
  }

  function renderChips() {
    if (!dom.chips) return;
    const c = state.counts;
    const f = state.filter;
    const rows = [];
    if (state.mode === 'access') {
      const kinds = KINDS.map((kind) => chipHtml({
        act: 'kind', value: kind, on: f.kinds.has(kind), label: KIND_LABEL[kind], count: c.kinds.get(kind) || 0, dot: kind,
      })).join('');
      const conds = f.conditions.map((cond, idx) => (
        `<button type="button" class="xk-xlog-chip is-cond" data-xlog-act="drop-cond" data-index="${idx}" title="Снять условие">`
        + `${cond.field === 'ip' ? hooks.icon('devices') : ''}${escapeHtml(cond.label || cond.value)}<span class="x" aria-hidden="true">✕</span></button>`
      )).join('');
      const hint = f.conditions.length ? '' : '<span class="xk-xlog-hint">Alt+клик по ячейке — добавить условие</span>';
      const dirty = f.conditions.length || f.nodes.size || f.kinds.size !== KINDS.length;
      rows.push(`<div class="xk-xlog-chiprow"><span class="lbl">Маршрут</span>${kinds}<span class="xk-xlog-vsep"></span>${conds}${hint}`
        + `${dirty ? '<button type="button" class="xk-xlog-reset" data-xlog-act="reset">Сбросить</button>' : ''}</div>`);
      const nodes = topEntries(c.nodes, NODE_CHIPS_MAX);
      if (nodes.length) {
        const nodeChips = nodes.map(([tag, count]) => {
          const info = nodeInfo(tag);
          return chipHtml({ act: 'node', value: tag, on: f.nodes.has(tag), label: info.label, count, extra: lightFlagHtml(info) });
        }).join('');
        rows.push(`<div class="xk-xlog-chiprow"><span class="lbl">Узел</span>${nodeChips}</div>`);
      }
    } else {
      const levels = LEVELS.map((level) => chipHtml({
        act: 'level', value: level, on: f.levels.has(level), label: LEVEL_LABEL[level], count: c.levels.get(level) || 0, dot: level,
      })).join('');
      const conds = f.conditions.map((cond, idx) => (
        `<button type="button" class="xk-xlog-chip is-cond" data-xlog-act="drop-cond" data-index="${idx}" title="Снять условие">`
        + `${escapeHtml(cond.label || cond.value)}<span class="x" aria-hidden="true">✕</span></button>`
      )).join('');
      const hint = f.conditions.length ? '' : '<span class="xk-xlog-hint">Alt+клик по модулю или сообщению — добавить условие</span>';
      const dirty = f.levels.size !== LEVELS.length || f.conditions.length;
      rows.push(`<div class="xk-xlog-chiprow"><span class="lbl">Уровень</span>${levels}<span class="xk-xlog-vsep"></span>${conds}${hint}`
        + `${dirty ? '<button type="button" class="xk-xlog-reset" data-xlog-act="reset">Сбросить</button>' : ''}</div>`);
    }
    const html = rows.join('');
    if (dom.chips._html !== html) {
      dom.chips._html = html;
      dom.chips.innerHTML = html;
    }
  }

  function topListHtml(entries, labelFn, field) {
    if (!entries.length) return '<p class="xk-xlog-muted">Пока пусто</p>';
    const max = entries[0][1] || 1;
    return `<ul class="xk-xlog-top">${entries.map(([key, count]) => {
      const label = labelFn(key);
      const on = hasCondition(field, key);
      return `<li class="${on ? 'is-on' : ''}" style="--w:${Math.max(6, Math.round((count * 100) / max))}%"><button type="button" data-xlog-act="cond" data-field="${field}" data-value="${escapeHtml(key)}" data-label="${escapeHtml(label.text)}" aria-pressed="${on ? 'true' : 'false'}" title="${on ? 'Снять условие' : 'Показать только это'}">${label.html}</button><em>${count}</em></li>`;
    }).join('')}</ul>`;
  }

  function setHtml(el, html) {
    if (el && el._html !== html) {
      el._html = html;
      el.innerHTML = html;
    }
  }

  function renderSummary() {
    const box = dom.summary;
    if (!box || state.mode !== 'access') return;
    const c = state.counts;
    const total = KINDS.reduce((sum, kind) => sum + (c.kinds.get(kind) || 0), 0);
    const shares = KINDS.map((kind) => ({ kind, n: c.kinds.get(kind) || 0 })).filter((s) => s.n);
    setHtml(box.querySelector('[data-xlog-summary-mini]'), shares.map((s) => `<span class="dot-${s.kind}">${KIND_LABEL[s.kind]} <em>${percent(s.n, total)}%</em></span>`).join(''));
    const extra = box.querySelector('[data-xlog-summary-extra]');
    const extraText = `· ${total} соединений · устройств ${c.devices.size} · узлов ${c.nodes.size} · доменов ${c.domains.size}`;
    if (extra && extra.textContent !== extraText) extra.textContent = extraText;
    const body = box.querySelector('[data-xlog-summary-body]');
    if (!body || body.hidden) return;
    const bar = shares.map((s) => `<i class="dot-${s.kind}" style="flex:${s.n}"></i>`).join('');
    const legend = shares.map((s) => `<span class="dot-${s.kind}"><b>${KIND_LABEL[s.kind]}</b><em>${percent(s.n, total)}%</em></span>`).join('');
    const nodes = topListHtml(topEntries(c.nodes, TOP_N), (tag) => {
      const info = nodeInfo(tag);
      return { text: info.label, html: `${lightFlagHtml(info)}${escapeHtml(info.label)}` };
    }, 'node');
    const devices = topListHtml(topEntries(c.devices, TOP_N), (ip) => {
      const name = hooks.deviceName(ip) || ip;
      return { text: name, html: escapeHtml(name) };
    }, 'ip');
    const domains = topListHtml(topEntries(c.domains, TOP_N), (d) => ({ text: d, html: escapeHtml(d) }), 'domain');
    setHtml(body, `
      <div class="xk-xlog-tile"><h4>Куда уходит трафик</h4><div class="xk-xlog-bar">${bar}</div><div class="xk-xlog-legend">${legend || '<span class="xk-xlog-muted">Пока пусто</span>'}</div></div>
      <div class="xk-xlog-tile"><h4>Узлы</h4>${nodes}</div>
      <div class="xk-xlog-tile"><h4>Устройства</h4>${devices}</div>
      <div class="xk-xlog-tile"><h4>Домены</h4>${domains}</div>`);
  }

  function renderSelbar() {
    const bar = dom.selbar;
    if (!bar) return;
    const n = state.selected.size;
    if (bar.hidden !== (n === 0)) bar.hidden = n === 0;
    const count = bar.querySelector('[data-xlog-selcount]');
    if (count && count.textContent !== String(n)) count.textContent = String(n);
  }

  function flushStats() {
    state.statsTimer = null;
    if (!state.statsDirty) return;
    state.statsDirty = false;
    renderChips();
    renderSummary();
    if (hooks.onChange) hooks.onChange(stats());
  }

  function markStatsDirty(now) {
    state.statsDirty = true;
    if (now) {
      if (state.statsTimer) clearTimeout(state.statsTimer);
      flushStats();
      return;
    }
    if (!state.statsTimer) state.statsTimer = setTimeout(flushStats, STATS_INTERVAL_MS);
  }

  // ---------- Buffer operations ----------

  function trim() {
    const over = state.records.length - state.maxLines;
    if (over <= 0) return 0;
    const dropped = state.records.splice(0, over);
    dropped.forEach((record) => {
      countRecord(record, -1);
      state.selected.delete(record.seq);
      if (state.openSeq === record.seq) state.openSeq = null;
    });
    if (!state.frozen) {
      const firstSeq = state.records.length ? state.records[0].seq : state.seq + 1;
      let cut = 0;
      while (cut < state.visible.length && state.visible[cut].seq < firstSeq) cut += 1;
      if (cut) {
        const gone = state.visible.splice(0, cut);
        gone.forEach((record) => {
          const row = state.rowsBySeq.get(record.seq);
          if (row) releaseRow(row);
        });
        state.baseOrd = state.visible.length ? state.visible[0].ord : state.ord;
        // Row offsets grow with every line; renumber long before float precision matters.
        if (state.baseOrd > 200000) renumber();
        // Keep the same lines under the eye when not following the end.
        if (!state.follow) {
          state.scrollTop = Math.max(0, state.scrollTop - cut * ROW_H);
          host.scrollTop = state.scrollTop;
        }
      }
    }
    return over;
  }

  function clearRecords() {
    state.records = [];
    state.visible = [];
    state.ord = 0;
    state.baseOrd = 0;
    state.selected.clear();
    state.openSeq = null;
    state.openOrd = null;
    resetCounts();
  }

  function reset(lines) {
    clearRecords();
    const list = Array.isArray(lines) ? lines : [];
    const start = Math.max(0, list.length - state.maxLines);
    for (let i = start; i < list.length; i += 1) {
      const record = makeRecord(list[i]);
      state.records.push(record);
      countRecord(record, 1);
    }
    if (state.frozen) {
      markStatsDirty(true);
      return;
    }
    refilter();
    renderAll();
  }

  function append(lines) {
    const list = Array.isArray(lines) ? lines : [];
    if (!list.length) return;
    const stick = state.follow || nearBottom();
    const added = [];
    for (let i = 0; i < list.length; i += 1) {
      const record = makeRecord(list[i]);
      state.records.push(record);
      countRecord(record, 1);
      added.push(record);
    }
    trim();
    if (state.frozen) {
      markStatsDirty(false);
      return;
    }
    const firstSeq = state.records.length ? state.records[0].seq : 0;
    const shown = added.filter((record) => record.seq >= firstSeq && matches(record));
    if (shown.length) {
      shown.forEach(pushVisible);
      if (state.visible.length === shown.length) state.baseOrd = state.visible[0].ord;
      if (stick) scrollToEnd();
      renderTable();
      renderEmpty();
    } else {
      renderTable();
    }
    markStatsDirty(false);
  }

  function setMode(mode) {
    const next = mode === 'error' ? 'error' : 'access';
    if (next === state.mode) return;
    state.mode = next;
    state.filter.conditions = [];
    clearRecords();
    state.scrollTop = 0;
    buildShell(next);
    host.scrollTop = 0;
    renderAll();
  }

  function setFrozen(on) {
    const next = !!on;
    if (next === state.frozen) return;
    state.frozen = next;
    if (!next) {
      refilter();
      renderAll();
    }
  }

  function applyFilter() {
    if (state.frozen) return;
    if (dom.detail) dom.detail._seq = null;
    refilter();
    renderAll();
  }

  function setSearch(raw) {
    const groups = buildXrayLogSearchGroups(raw);
    if (JSON.stringify(groups) === JSON.stringify(state.filter.groups)) return;
    state.filter.groups = groups;
    applyFilter();
  }

  function hasCondition(field, value) {
    return state.filter.conditions.some((c) => c.field === field && c.value === value);
  }

  function condOn(field, value) {
    return hasCondition(field, value) ? ' on" aria-pressed="true' : '" aria-pressed="false';
  }

  // A second click on the same node, device, domain or module removes it again.
  function toggleCondition(field, value, label) {
    if (!field || !value) return;
    const at = state.filter.conditions.findIndex((c) => c.field === field && c.value === value);
    if (at >= 0) state.filter.conditions.splice(at, 1);
    else state.filter.conditions.push({ field, value, label: label || value });
    applyFilter();
  }

  function addCondition(field, value, label) {
    if (!field || !value) return;
    const exists = state.filter.conditions.some((c) => c.field === field && c.value === value);
    if (!exists) state.filter.conditions.push({ field, value, label: label || value });
    applyFilter();
  }

  function resetFilter() {
    const f = state.filter;
    f.kinds = new Set(KINDS);
    f.levels = new Set(LEVELS);
    f.nodes.clear();
    f.conditions = [];
    applyFilter();
  }

  function toggleIn(set, value) {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }

  // ---------- Selection ----------

  function visibleIndexOf(seq) {
    return state.visible.findIndex((r) => r.seq === seq);
  }

  function afterSelection() {
    renderTable();
    renderSelbar();
  }

  function selectBySeq(seq, ev) {
    const e = ev || {};
    if (e.shiftKey && state.anchorSeq != null) {
      const a = visibleIndexOf(state.anchorSeq);
      const b = visibleIndexOf(seq);
      if (a >= 0 && b >= 0) {
        if (!(e.ctrlKey || e.metaKey)) state.selected.clear();
        const [from, to] = a < b ? [a, b] : [b, a];
        for (let i = from; i <= to; i += 1) state.selected.add(state.visible[i].seq);
      }
    } else if (e.ctrlKey || e.metaKey || e.toggle) {
      toggleIn(state.selected, seq);
      state.anchorSeq = seq;
    } else {
      const only = state.selected.size === 1 && state.selected.has(seq);
      state.selected.clear();
      if (!only) state.selected.add(seq);
      state.anchorSeq = seq;
    }
    afterSelection();
  }

  function selectAll() {
    state.visible.forEach((record) => state.selected.add(record.seq));
    afterSelection();
    return true;
  }

  function clearSelection() {
    if (!state.selected.size) return;
    state.selected.clear();
    afterSelection();
  }

  function selectedRecords() {
    return state.visible.filter((record) => state.selected.has(record.seq));
  }

  function recordsToTsv(records) {
    const head = ['Время', 'Устройство', 'IP', 'Назначение', 'Порт', 'Протокол', 'Inbound', 'Outbound', 'Узел'];
    const rows = records.map((record) => {
      const p = record.p;
      if (!p) return [record.line];
      const info = record.kind === 'proxy' ? nodeInfo(p.outTag) : null;
      return [
        `${p.date} ${p.time}${p.frac}`,
        hooks.deviceName(p.srcIp) || '',
        p.srcIp,
        p.host,
        p.port,
        p.proto,
        p.inTag,
        p.outTag,
        info ? info.label : '',
      ];
    });
    return [head, ...rows].map((cols) => cols.map((v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  }

  function copyRecords(records, asTable) {
    if (!records.length || !hooks.onCopy) return;
    const text = asTable ? recordsToTsv(records) : records.map((r) => r.line).join('\n');
    hooks.onCopy(text, records.length, asTable);
  }

  // ---------- Events ----------

  function findRecord(seq) {
    return state.visible.find((r) => r.seq === seq) || state.records.find((r) => r.seq === seq) || null;
  }

  function recordFromEvent(target) {
    const row = target && target.closest ? target.closest('[data-seq]') : null;
    if (!row) return null;
    return findRecord(Number(row.dataset.seq));
  }

  function toggleDetail(record) {
    state.openSeq = state.openSeq === record.seq ? null : record.seq;
    if (dom.detail) dom.detail._seq = null;
    // Rows after the detail move by its height; reposition them all.
    state.rowsBySeq.forEach((row) => { row._y = null; });
    renderTable();
  }

  function onShadowClick(e) {
    const actEl = e.target.closest ? e.target.closest('[data-act]') : null;
    const act = actEl ? actEl.dataset.act : '';
    if (act === 'cond') {
      e.preventDefault();
      toggleCondition(actEl.dataset.field, actEl.dataset.value, actEl.dataset.label);
      return;
    }
    if (act === 'rename-device') {
      e.preventDefault();
      if (hooks.onRenameDevice) hooks.onRenameDevice(actEl.dataset.ip, actEl.dataset.name || '');
      return;
    }
    if (act === 'copy-line') {
      e.preventDefault();
      const record = findRecord(Number(actEl.dataset.seq));
      if (record) copyRecords([record], false);
      return;
    }
    if (act === 'select-all') {
      e.preventDefault();
      if (state.selected.size >= state.visible.length && state.visible.length) clearSelection();
      else selectAll();
      return;
    }
    if (dom.detail && dom.detail.contains(e.target)) return;
    const record = recordFromEvent(e.target);
    if (!record) return;
    if (act === 'expand') {
      e.preventDefault();
      toggleDetail(record);
      return;
    }
    if (e.altKey && record.p) {
      e.preventDefault();
      const errCell = e.target.closest('.mod, .msg');
      if (errCell && errCell.classList.contains('mod') && record.p.module) toggleCondition('module', record.p.module, record.p.module);
      else if (errCell && record.p.session) toggleCondition('session', record.p.session, `[${record.p.session}]`);
      if (errCell) return;
      const cell = e.target.closest('.dev, .dst, .rt');
      if (cell && cell.classList.contains('dev')) toggleCondition('ip', record.p.srcIp, hooks.deviceName(record.p.srcIp) || record.p.srcIp);
      else if (cell && cell.classList.contains('dst')) toggleCondition('host', record.p.host, record.p.host);
      else if (cell && cell.classList.contains('rt') && record.kind === 'proxy') toggleCondition('node', record.p.outTag, nodeInfo(record.p.outTag).label);
      return;
    }
    selectBySeq(record.seq, act === 'toggle' ? { toggle: true, shiftKey: e.shiftKey } : e);
  }

  function onShadowDblClick(e) {
    if (dom.detail && dom.detail.contains(e.target)) return;
    const record = recordFromEvent(e.target);
    if (!record || !record.p) return;
    e.preventDefault();
    toggleDetail(record);
  }

  function onShadowContextMenu(e) {
    if (!hooks.onContextMenu) return;
    const record = recordFromEvent(e.target);
    if (!record) return;
    e.preventDefault();
    hooks.onContextMenu(record, e.clientX, e.clientY);
  }

  function onHostKeyDown(e) {
    const key = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'a') {
      e.preventDefault();
      selectAll();
    } else if ((e.ctrlKey || e.metaKey) && key === 'c' && state.selected.size) {
      const sel = window.getSelection ? String(window.getSelection() || '') : '';
      if (sel) return;
      e.preventDefault();
      copyRecords(selectedRecords(), false);
    } else if (key === 'escape' && state.selected.size) {
      clearSelection();
    }
  }

  function onChipsClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-xlog-act]') : null;
    if (!btn) return;
    const act = btn.dataset.xlogAct;
    const f = state.filter;
    if (act === 'kind') toggleIn(f.kinds, btn.dataset.value);
    else if (act === 'level') toggleIn(f.levels, btn.dataset.value);
    else if (act === 'node') toggleIn(f.nodes, btn.dataset.value);
    else if (act === 'drop-cond') f.conditions.splice(Number(btn.dataset.index), 1);
    else if (act === 'reset') return resetFilter();
    else if (act === 'cond') return toggleCondition(btn.dataset.field, btn.dataset.value, btn.dataset.label);
    else return;
    applyFilter();
  }

  function onSelbarClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-xlog-act]') : null;
    if (!btn) return;
    const act = btn.dataset.xlogAct;
    if (act === 'copy-selected') copyRecords(selectedRecords(), false);
    else if (act === 'copy-selected-tsv') copyRecords(selectedRecords(), true);
    else if (act === 'clear-selection') clearSelection();
  }

  function setSummaryOpen(open) {
    if (!dom.summary) return;
    const body = dom.summary.querySelector('[data-xlog-summary-body]');
    const toggle = dom.summary.querySelector('[data-xlog-summary-toggle]');
    if (body) body.hidden = !open;
    dom.summary.classList.toggle('is-open', !!open);
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const label = toggle.querySelector('[data-xlog-summary-toggle-label]');
      if (label) label.textContent = open ? 'Свернуть' : 'Развернуть';
    }
    if (open && body) body._html = '';
    renderSummary();
  }

  function onSummaryClick(e) {
    const toggle = e.target.closest ? e.target.closest('[data-xlog-summary-toggle]') : null;
    if (toggle) {
      const body = dom.summary.querySelector('[data-xlog-summary-body]');
      if (!body) return;
      setSummaryOpen(body.hidden);
      if (typeof opts.onSummaryToggle === 'function') opts.onSummaryToggle(!body.hidden);
      return;
    }
    onChipsClick(e);
  }

  host.addEventListener('scroll', onScroll, { passive: true });
  host.addEventListener('keydown', onHostKeyDown);
  shadow.addEventListener('click', onShadowClick);
  shadow.addEventListener('dblclick', onShadowDblClick);
  shadow.addEventListener('contextmenu', onShadowContextMenu);
  if (dom.chips) dom.chips.addEventListener('click', onChipsClick);
  if (dom.selbar) dom.selbar.addEventListener('click', onSelbarClick);
  if (dom.summary) dom.summary.addEventListener('click', onSummaryClick);

  function stats() {
    return {
      mode: state.mode,
      total: state.records.length,
      shown: state.visible.length,
      raw: state.counts.raw,
      hiddenRaw: state.filter.showRaw ? 0 : state.counts.raw,
      selected: state.selected.size,
    };
  }

  setMode('access');

  return {
    setMode,
    reset,
    append,
    setFrozen,
    setSearch,
    addCondition,
    resetFilter,
    setFollow(on) { state.follow = !!on; },
    setMaxLines(n) {
      const value = Math.max(50, parseInt(n, 10) || 800);
      state.maxLines = value;
      if (trim()) renderAll();
    },
    setShowRaw(on) {
      if (state.filter.showRaw === !!on) return;
      state.filter.showRaw = !!on;
      applyFilter();
    },
    setEmptyHtml(html) {
      state.emptyHtml = String(html || '');
      renderEmpty();
    },
    setSummaryOpen,
    refreshDecorations() {
      state.decoVersion += 1;
      state.nodeCache.clear();
      renderTable();
      markStatsDirty(true);
    },
    isNearBottom: nearBottom,
    scrollToEnd() {
      scrollToEnd();
      renderTable();
    },
    relayout() {
      state.viewH = host.clientHeight;
      renderTable();
    },
    visibleLines() { return state.visible.map((r) => r.line); },
    copyVisible() { copyRecords(state.visible, false); },
    lineBySeq(seq) {
      const record = state.records.find((r) => r.seq === seq);
      return record ? record.line : '';
    },
    indexOfSeq(seq) { return state.records.findIndex((r) => r.seq === seq); },
    offsetFromEnd(seq) {
      const index = state.records.findIndex((r) => r.seq === seq);
      return index < 0 ? -1 : state.records.length - 1 - index;
    },
    stats,
  };
}
