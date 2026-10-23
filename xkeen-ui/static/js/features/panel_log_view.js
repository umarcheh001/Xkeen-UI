// The table of DevTools -> Logs: records from panel_log_parser.js in a virtual
// list with day separators, one expandable detail and source chips.
//
// Same build as the Xray logs table: rows live in a shadow root with their own
// stylesheet, have one fixed height and are positioned by transform, and only
// the rows on screen exist. Unlike Xray the window is rebuilt as a whole on
// every update (see panel_log_parser.js); rows are keyed by record id, so a row
// that did not change is not touched.

import { buildPanelLogRecords, panelLogDayLabel } from './panel_log_parser.js';

const ROW_H = 32;
const ROW_H_NARROW = 48;
const NARROW_W = 640;
const OVERSCAN = 6;
const KV_INLINE = 3;
const LEVEL_LABEL = { debug: 'DEBUG', info: 'INFO', warning: 'WARN', error: 'ERROR', ok: 'OK' };
const LEVEL_RANK = { debug: 0, info: 1, ok: 1, warning: 2, error: 3 };

const VIEW_CSS = `
:host { --mono: var(--xk-mono-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
* { box-sizing: border-box; }
.ic { display: block; flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.wrap { position: relative; min-width: 0; }
.thead, .tr { display: grid; grid-template-columns: 3px 64px 48px minmax(110px, 150px) minmax(0, 1fr) auto 26px; align-items: center; column-gap: 12px; padding-right: 8px; }
.thead { position: sticky; top: 0; z-index: 2; height: 30px; border-bottom: 1px solid var(--op-border); background: var(--op-surface); color: var(--op-muted); font-size: 11px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; }
.thead > :nth-child(2) { padding-left: 10px; }
.body { position: relative; overflow: hidden; contain: strict; }
.rows { position: absolute; inset: 0 0 auto 0; }
.tr, .day { position: absolute; top: 0; left: 0; right: 0; height: var(--row-h); contain: strict; }
.tr { border-bottom: 1px solid color-mix(in srgb, var(--op-border) 55%, transparent); cursor: pointer; user-select: none; }
.tr[hidden], .day[hidden] { display: none; }
.tr:hover, .tr.open { background: var(--op-surface-2); }
.tr:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: -2px; }
.day { display: flex; align-items: center; padding: 0 14px; border-bottom: 1px solid var(--op-border); background: var(--op-surface); color: var(--op-muted); font: 600 11px var(--mono); letter-spacing: .04em; text-transform: uppercase; }
.lv { align-self: stretch; background: var(--k, transparent); }
.k-debug { --k: var(--op-border-strong); } .k-info { --k: var(--op-accent); } .k-ok { --k: var(--op-success); }
.k-warning { --k: var(--op-warning); } .k-error { --k: var(--op-danger); }
.tr.k-error:not(.open) { background: color-mix(in srgb, var(--op-danger) 9%, transparent); }
.ts { padding-left: 10px; color: var(--op-faint); font: 12px var(--mono); font-variant-numeric: tabular-nums; }
.lvl { color: var(--k); font: 700 10px var(--mono); letter-spacing: .04em; }
.k-debug .lvl { color: var(--op-faint); }
.src { justify-self: start; max-width: 100%; height: 20px; padding: 0 8px; overflow: hidden; border: 1px solid var(--op-border); border-radius: 999px; background: var(--op-surface-2); color: var(--op-text); font-size: 11.5px; font-weight: 600; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.src:empty { visibility: hidden; }
.msg { min-width: 0; overflow: hidden; color: var(--op-text-strong); font: 12.5px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.msg small { margin-left: 10px; color: var(--op-faint); font-size: 11.5px; }
.msg small b { color: var(--op-muted); font-weight: 500; }
.tr.k-error .msg { color: var(--op-danger); }
.rep { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--op-warning-soft); color: var(--op-warning); font: 600 11px var(--mono); white-space: nowrap; }
.rep span { color: var(--op-muted); font-weight: 400; }
.rep.dur { background: transparent; color: var(--op-muted); font-weight: 500; }
.rep:empty { visibility: hidden; padding: 0; }
.chev { display: grid; place-items: center; justify-self: center; width: 22px; height: 22px; border-radius: 5px; color: var(--op-faint); }
.tr:hover .chev { background: var(--op-surface-3); color: var(--op-text); }
.tr.open .chev { color: var(--op-accent); }
.tr.open .chev .ic { transform: rotate(180deg); }
.detail { position: absolute; top: 0; left: 0; right: 0; z-index: 1; display: grid; gap: 8px; padding: 10px 14px 12px 79px; border-bottom: 1px solid var(--op-border); background: var(--op-surface); user-select: text; cursor: auto; }
.detail dl { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 0; }
.detail dt { color: var(--op-muted); font-size: 11px; }
.detail dd { margin: 0; color: var(--op-text-strong); font: 12px var(--mono); overflow-wrap: anywhere; }
.detail .note { color: var(--op-muted); font-size: 12px; }
.detail .note b { color: var(--op-text); }
.detail .block { max-height: 320px; margin: 0; padding: 6px 8px; overflow: auto; border: 1px dashed var(--op-border); border-radius: var(--op-radius-sm, 6px); background: var(--op-editor); color: var(--op-muted); font: 11.5px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.detail .block.err { border-style: solid; border-color: color-mix(in srgb, var(--op-danger) 35%, transparent); color: var(--op-danger); }
.detail details > summary { color: var(--op-muted); font-size: 12px; cursor: pointer; }
.detail details[open] > summary { margin-bottom: 6px; }
.steps { display: grid; gap: 2px; font: 12px/1.6 var(--mono); }
.steps div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; color: var(--op-text); }
.steps i { color: var(--op-faint); font-style: normal; }
.acts { display: flex; flex-wrap: wrap; gap: 6px; }
.btn { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px; border: 1px solid var(--op-border); border-radius: var(--op-control-radius, 6px); background: var(--op-surface-2); color: var(--op-text); font: 600 12px inherit; font-family: inherit; white-space: nowrap; cursor: pointer; }
.btn:hover { background: var(--op-surface-3); }
.btn:focus-visible { outline: 2px solid var(--op-accent-border); outline-offset: 1px; }
.empty { position: absolute; inset: 30px 0 0; display: grid; place-content: center; gap: 4px; padding: 16px; color: var(--op-muted); text-align: center; pointer-events: none; }
.empty[hidden] { display: none; }
.empty b { color: var(--op-text); font-weight: 600; }
.wrap.narrow .thead { display: none; }
.wrap.narrow .tr { grid-template-columns: 3px 60px minmax(0, 1fr) auto 22px; grid-template-rows: auto auto; column-gap: 8px; row-gap: 2px; align-content: center; }
.wrap.narrow .lv { grid-row: 1 / span 2; }
.wrap.narrow .ts { grid-row: 1; padding-left: 6px; }
.wrap.narrow .lvl { display: none; }
.wrap.narrow .src { grid-column: 3; grid-row: 1; }
.wrap.narrow .msg { grid-column: 3 / 5; grid-row: 2; }
.wrap.narrow .msg small { display: none; }
.wrap.narrow .rep { grid-column: 4; grid-row: 1; justify-self: end; }
.wrap.narrow .chev { grid-column: 5; grid-row: 1 / span 2; }
.wrap.narrow .detail { padding-left: 14px; }
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

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortDate(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${m[2]}.${m[1]}` : '';
}

export function createPanelLogView(options) {
  const opts = options || {};
  const host = opts.root;
  const hooks = {
    icon: typeof opts.icon === 'function' ? opts.icon : () => '',
    onCopy: typeof opts.onCopy === 'function' ? opts.onCopy : null,
    onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
  };
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const inlineStyle = adoptViewStyles(shadow);

  const state = {
    kind: 'core',
    lines: [],
    records: [],
    items: [],
    fold: true,
    follow: true,
    level: 'all',
    terms: [],
    hidden: new Set(),
    openId: null,
    openIdx: null,
    detailH: 0,
    rowH: ROW_H,
    narrow: false,
    scrollTop: 0,
    viewH: 0,
    renderQueued: false,
    rowsByKey: new Map(),
    freeRows: [],
    emptyHtml: '',
    counts: { levels: new Map(), sources: new Map() },
  };

  shadow.innerHTML = `${inlineStyle}<div class="wrap" part="wrap">
    <div class="thead" role="row"><span></span><span>Время</span><span>Ур.</span><span>Источник</span><span>Событие</span><span></span><span></span></div>
    <div class="body" role="rowgroup"><div class="rows"></div></div>
    <div class="empty" hidden></div></div>`;
  const dom = {
    wrap: shadow.querySelector('.wrap'),
    thead: shadow.querySelector('.thead'),
    body: shadow.querySelector('.body'),
    rows: shadow.querySelector('.rows'),
    empty: shadow.querySelector('.empty'),
    detail: null,
    chips: opts.chips || null,
  };

  const icon = (name) => String(hooks.icon(name) || '').replace('xk-action-icon', 'ic');

  // ---------- Records and filter ----------

  function matches(rec) {
    if (state.level !== 'all' && (LEVEL_RANK[rec.level] || 0) < LEVEL_RANK[state.level]) return false;
    if (state.hidden.size && state.hidden.has(rec.source)) return false;
    if (state.terms.length && !state.terms.every((t) => rec.text.includes(t))) return false;
    return true;
  }

  function count() {
    const levels = new Map();
    const sources = new Map();
    for (const rec of state.records) {
      levels.set(rec.level, (levels.get(rec.level) || 0) + rec.rep);
      if (rec.source) sources.set(rec.source, (sources.get(rec.source) || 0) + rec.rep);
    }
    state.counts = { levels, sources };
  }

  function refilter() {
    const items = [];
    let day = null;
    for (const rec of state.records) {
      if (!matches(rec)) continue;
      if (rec.date && rec.date !== day) {
        day = rec.date;
        items.push({ day: rec.date, key: `d:${rec.date}` });
      }
      items.push({ rec, key: `r:${rec.id}` });
    }
    state.items = items;
    if (state.openId != null && !items.some((it) => it.rec && it.rec.id === state.openId)) state.openId = null;
  }

  // ---------- Rows ----------

  function kvInline(rec) {
    return rec.kv.slice(0, KV_INLINE).map(([k, v]) => `${esc(k)}=<b>${esc(v)}</b>`).join(' ');
  }

  function rowHtml(rec) {
    let rep = '';
    let repClass = 'rep';
    if (rec.rep > 1) {
      const since = rec.firstDate && rec.firstDate !== rec.date ? `${shortDate(rec.firstDate)} ${rec.firstTime.slice(0, 5)}` : rec.firstTime;
      rep = `×${rec.rep}<span>с ${esc(since)}</span>`;
    } else if (rec.dur) {
      rep = esc(rec.dur);
      repClass = 'rep dur';
    } else if (rec.extra.length && state.kind === 'restart') {
      rep = `вывод · ${rec.extra.length}`;
      repClass = 'rep dur';
    }
    const inline = kvInline(rec);
    return `<span class="lv"></span><span class="ts">${esc(rec.time)}</span><span class="lvl">${LEVEL_LABEL[rec.level] || ''}</span>`
      + `<span class="src">${esc(rec.source)}</span>`
      + `<span class="msg" title="${esc(rec.msg)}">${esc(rec.msg)}${inline ? `<small>${inline}</small>` : ''}</span>`
      + `<span class="${repClass}">${rep}</span><span class="chev">${icon('chevron-down')}</span>`;
  }

  function releaseRow(row) {
    if (row._key != null) state.rowsByKey.delete(row._key);
    row._key = null;
    row.hidden = true;
    state.freeRows.push(row);
  }

  function takeRow() {
    const row = state.freeRows.pop();
    if (row) {
      row.hidden = false;
      return row;
    }
    const fresh = document.createElement('div');
    dom.rows.appendChild(fresh);
    return fresh;
  }

  function bindRow(row, item) {
    row._key = item.key;
    row._y = null;
    row._open = null;
    if (item.day) {
      row.className = 'day';
      row.removeAttribute('role');
      row.removeAttribute('tabindex');
      row.removeAttribute('aria-expanded');
      row.removeAttribute('data-id');
      row.textContent = panelLogDayLabel(item.day);
    } else {
      const rec = item.rec;
      row.className = `tr k-${rec.level}`;
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.dataset.id = rec.id;
      row.innerHTML = rowHtml(rec);
      row._sig = `${rec.rep}|${rec.time}|${rec.dur}|${rec.extra.length}`;
    }
    state.rowsByKey.set(item.key, row);
  }

  function rowY(idx) {
    return idx * state.rowH + (state.openIdx != null && idx > state.openIdx ? state.detailH : 0);
  }

  // ---------- Detail ----------

  function detailHtml(rec) {
    const parts = [];
    if (rec.rep > 1) {
      parts.push(`<div class="note">Повторилось <b>${rec.rep} раз</b> подряд: с ${esc(shortDate(rec.firstDate))} ${esc(rec.firstTime)} по ${esc(shortDate(rec.date))} ${esc(rec.time)}. Между повторами других записей нет.</div>`);
    }
    if (rec.kv.length) {
      parts.push(`<dl>${rec.kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`);
    }
    if (rec.steps.length) {
      parts.push(`<div class="steps">${rec.steps.map(([t, s]) => `<div><i>${esc(t)}</i><span>${esc(s)}</span></div>`).join('')}</div>`);
    }
    if (rec.extra.length) {
      const text = esc(rec.extra.join('\n'));
      if (state.kind === 'update') {
        parts.push(`<details><summary>Вывод установщика · ${rec.extra.length} строк</summary><pre class="block">${text}</pre></details>`);
      } else if (state.kind === 'restart') {
        parts.push(`<pre class="block">${text}</pre>`);
      } else {
        parts.push(`<pre class="block${rec.level === 'error' ? ' err' : ''}">${text}</pre>`);
      }
    }
    if (rec.raw.length && state.kind !== 'update') parts.push(`<pre class="block">${esc(rec.raw.join('\n'))}</pre>`);
    const src = rec.source ? esc(rec.source) : '';
    parts.push(`<div class="acts">
      <button type="button" class="btn" data-act="copy" data-id="${esc(rec.id)}">${icon('duplicate')}Копировать запись</button>
      ${src ? `<button type="button" class="btn" data-act="only" data-source="${src}">Только «${src}»</button>
      <button type="button" class="btn" data-act="hide" data-source="${src}">Скрыть «${src}»</button>` : ''}
    </div>`);
    return parts.join('');
  }

  function syncDetail() {
    const idx = state.openId == null ? -1 : state.items.findIndex((it) => it.rec && it.rec.id === state.openId);
    if (idx < 0) {
      state.openId = null;
      state.openIdx = null;
      state.detailH = 0;
      if (dom.detail) {
        dom.detail.remove();
        dom.detail = null;
      }
      return;
    }
    const rec = state.items[idx].rec;
    if (!dom.detail) {
      dom.detail = document.createElement('div');
      dom.detail.className = 'detail';
      dom.rows.appendChild(dom.detail);
    }
    const sig = `${rec.id}|${rec.rep}|${rec.extra.length}|${state.kind}`;
    if (dom.detail._sig !== sig) {
      dom.detail.innerHTML = detailHtml(rec);
      dom.detail._sig = sig;
      state.detailH = dom.detail.offsetHeight;
    }
    state.openIdx = idx;
    dom.detail.style.transform = `translateY(${(idx + 1) * state.rowH}px)`;
  }

  function contentHeight() {
    return state.items.length * state.rowH + (state.openIdx != null ? state.detailH : 0);
  }

  function renderTable() {
    syncDetail();
    const total = state.items.length;
    const bodyH = contentHeight();
    if (dom.body._h !== bodyH) {
      dom.body._h = bodyH;
      dom.body.style.height = `${bodyH}px`;
    }
    const headH = state.narrow ? 0 : 30;
    const top = Math.max(0, state.scrollTop - headH);
    let first = Math.floor(top / state.rowH);
    if (state.openIdx != null && first > state.openIdx) first = Math.floor(Math.max(0, top - state.detailH) / state.rowH);
    first = Math.max(0, first - OVERSCAN);
    const last = Math.min(total, first + Math.ceil((state.viewH || 600) / state.rowH) + OVERSCAN * 2);

    const keep = new Set();
    for (let i = first; i < last; i += 1) keep.add(state.items[i].key);
    Array.from(state.rowsByKey.entries()).forEach(([key, row]) => { if (!keep.has(key)) releaseRow(row); });
    const ordered = [];
    for (let i = first; i < last; i += 1) {
      const item = state.items[i];
      let row = state.rowsByKey.get(item.key);
      if (row && item.rec && row._sig !== `${item.rec.rep}|${item.rec.time}|${item.rec.dur}|${item.rec.extra.length}`) {
        releaseRow(row);
        row = null;
      }
      if (!row) {
        row = takeRow();
        bindRow(row, item);
      }
      const open = !!(item.rec && item.rec.id === state.openId);
      if (row._open !== open && item.rec) {
        row._open = open;
        row.classList.toggle('open', open);
        row.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      const y = rowY(i);
      if (row._y !== y) {
        row._y = y;
        row.style.transform = `translateY(${y}px)`;
      }
      ordered.push(row);
    }
    // DOM order equals screen order (screen readers, copy, tests).
    let ref = dom.rows.firstChild;
    for (const row of ordered) {
      while (ref && ref !== row && (ref.hidden || ref === dom.detail)) ref = ref.nextSibling;
      if (row === ref) {
        ref = ref.nextSibling;
        continue;
      }
      dom.rows.insertBefore(row, ref);
    }
  }

  function renderEmpty() {
    const empty = state.items.length === 0;
    let html = state.emptyHtml;
    if (!html && empty && state.records.length) html = '<b>Ничего не найдено</b><span>Под фильтр не подходит ни одна запись.</span>';
    if (!html && empty) html = '<b>Файл пуст</b><span>Записей пока нет.</span>';
    if (empty) {
      if (dom.empty._html !== html) {
        dom.empty._html = html;
        dom.empty.innerHTML = html;
      }
      dom.empty.hidden = false;
    } else {
      dom.empty.hidden = true;
    }
  }

  function nearBottom() {
    return state.scrollTop + (state.viewH || 0) >= (state.narrow ? 0 : 30) + contentHeight() - state.rowH * 2;
  }

  function scrollToEnd() {
    // The body has to be tall before the host can scroll that far.
    syncDetail();
    const bodyH = contentHeight();
    if (dom.body._h !== bodyH) {
      dom.body._h = bodyH;
      dom.body.style.height = `${bodyH}px`;
    }
    const target = Math.max(0, (state.narrow ? 0 : 30) + bodyH - (state.viewH || 0));
    host.scrollTop = target;
    // A hidden tab has no height: the browser keeps 0, and so must we.
    state.scrollTop = host.scrollTop;
  }

  // ---------- Chips ----------

  function renderChips() {
    if (!dom.chips) return;
    const sources = Array.from(state.counts.sources.entries()).sort((a, b) => b[1] - a[1]);
    if (sources.length < 2) {
      if (dom.chips._html !== '') {
        dom.chips._html = '';
        dom.chips.innerHTML = '';
      }
      dom.chips.hidden = true;
      return;
    }
    const chips = sources.map(([name, n]) => {
      const off = state.hidden.has(name);
      return `<button type="button" class="xk-xlog-chip${off ? ' is-off' : ''}" data-plog-source="${esc(name)}" aria-pressed="${off ? 'false' : 'true'}" title="${off ? 'Показать' : 'Скрыть'} «${esc(name)}»">${esc(name)}<em>${n}</em></button>`;
    }).join('');
    const reset = state.hidden.size ? '<button type="button" class="xk-xlog-chip is-reset" data-plog-source-reset>Показать все</button>' : '';
    const html = `<div class="xk-xlog-chiprow"><span class="lbl">Источник</span>${chips}${reset}</div>`;
    if (dom.chips._html !== html) {
      dom.chips._html = html;
      dom.chips.innerHTML = html;
    }
    dom.chips.hidden = false;
  }

  function stats() {
    const visible = state.items.reduce((n, it) => n + (it.rec ? it.rec.rep : 0), 0);
    const levels = state.counts.levels;
    return {
      lines: state.lines.length,
      records: state.records.length,
      visible,
      warnings: (levels.get('warning') || 0) + (levels.get('error') || 0),
      errors: levels.get('error') || 0,
      total: Array.from(levels.values()).reduce((a, b) => a + b, 0),
      folded: state.fold && state.records.some((r) => r.rep > 1),
    };
  }

  function renderAll(stick) {
    if (stick) scrollToEnd();
    renderTable();
    renderEmpty();
    renderChips();
    if (hooks.onChange) hooks.onChange(stats());
  }

  function rebuild() {
    state.records = buildPanelLogRecords(state.kind, state.lines, { fold: state.fold });
    count();
    refilter();
  }

  // ---------- Events ----------

  function onScroll() {
    state.scrollTop = host.scrollTop;
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderTable();
    });
  }

  function measure() {
    state.viewH = host.clientHeight;
    const narrow = host.clientWidth > 0 && host.clientWidth < NARROW_W;
    if (narrow !== state.narrow) {
      state.narrow = narrow;
      state.rowH = narrow ? ROW_H_NARROW : ROW_H;
      dom.wrap.classList.toggle('narrow', narrow);
      dom.wrap.style.setProperty('--row-h', `${state.rowH}px`);
      Array.from(state.rowsByKey.values()).forEach(releaseRow);
      if (dom.detail) dom.detail._sig = null;
    }
  }

  function toggle(id) {
    state.openId = state.openId === id ? null : id;
    renderTable();
    if (state.openIdx == null) return;
    // The detail opens below its row: bring all of it into view.
    const headH = state.narrow ? 0 : 30;
    const bottom = headH + (state.openIdx + 1) * state.rowH + state.detailH;
    const viewH = state.viewH || host.clientHeight;
    if (bottom > state.scrollTop + viewH) {
      state.scrollTop = Math.max(0, bottom - viewH);
      host.scrollTop = state.scrollTop;
      renderTable();
    }
  }

  function recordById(id) {
    return state.records.find((r) => r.id === id) || null;
  }

  function recordText(rec) {
    return [...rec.raw, ...rec.extra].join('\n');
  }

  host.addEventListener('scroll', onScroll, { passive: true });
  shadow.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (btn) {
      const act = btn.dataset.act;
      if (act === 'copy') {
        const rec = recordById(btn.dataset.id);
        if (rec && hooks.onCopy) hooks.onCopy(recordText(rec), 'Запись скопирована');
      } else if (act === 'only') {
        api.onlySource(btn.dataset.source);
      } else if (act === 'hide') {
        api.toggleSource(btn.dataset.source);
      }
      return;
    }
    if (ev.target.closest('.detail')) return;
    const row = ev.target.closest('.tr');
    if (row && row.dataset.id) toggle(row.dataset.id);
  });
  shadow.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = ev.target.closest && ev.target.closest('.tr');
    if (!row || !row.dataset.id) return;
    ev.preventDefault();
    toggle(row.dataset.id);
  });
  if (dom.chips) {
    dom.chips.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-plog-source-reset]')) {
        api.resetSources();
        return;
      }
      const chip = ev.target.closest('[data-plog-source]');
      if (chip) api.toggleSource(chip.dataset.plogSource);
    });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const wasHidden = !state.viewH;
      measure();
      if (state.follow && (wasHidden || nearBottom())) scrollToEnd();
      renderTable();
    }).observe(host);
  }
  dom.wrap.style.setProperty('--row-h', `${state.rowH}px`);
  measure();

  // ---------- API ----------

  const api = {
    setData(kind, lines) {
      const stick = state.follow || nearBottom();
      const changedKind = kind !== state.kind;
      state.kind = kind;
      state.lines = Array.isArray(lines) ? lines.slice() : [];
      if (changedKind) {
        state.openId = null;
        state.hidden.clear();
      }
      rebuild();
      state.emptyHtml = '';
      renderAll(stick);
    },
    clear() {
      state.lines = [];
      state.records = [];
      state.items = [];
      state.openId = null;
      renderAll(false);
    },
    setEmpty(html) {
      state.emptyHtml = String(html || '');
      state.lines = [];
      state.records = [];
      count();
      refilter();
      renderAll(false);
    },
    setFold(on) {
      state.fold = !!on;
      rebuild();
      renderAll(state.follow);
    },
    setFollow(on) {
      state.follow = !!on;
      if (state.follow) renderAll(true);
    },
    setLevel(level) {
      state.level = ['warning', 'error'].includes(level) ? level : 'all';
      refilter();
      renderAll(state.follow);
    },
    setSearch(raw) {
      state.terms = String(raw || '').toLowerCase().split(/\s+/).filter(Boolean);
      refilter();
      renderAll(state.follow);
    },
    toggleSource(name) {
      if (state.hidden.has(name)) state.hidden.delete(name);
      else state.hidden.add(name);
      refilter();
      renderAll(false);
    },
    onlySource(name) {
      state.hidden = new Set(Array.from(state.counts.sources.keys()).filter((n) => n !== name));
      refilter();
      renderAll(false);
    },
    resetSources() {
      state.hidden.clear();
      refilter();
      renderAll(false);
    },
    visibleText() {
      return state.items.filter((it) => it.rec).map((it) => recordText(it.rec)).join('\n');
    },
    stats,
    scrollToEnd() {
      scrollToEnd();
      renderTable();
    },
  };
  return api;
}
