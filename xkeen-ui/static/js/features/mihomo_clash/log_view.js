import {
  countryFlag,
  nodeCountryCode,
  nodeDisplayName,
} from "../../ui/country_flags.js";
import { MIHOMO_ROUTE_LABELS as LABELS } from "./log_model.js";
import { iconHtml } from "../../ui/operator_icons.js";

export const logEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const e = logEscape;
const ROW = 32;
const CSS = `
:host{display:block;position:relative;contain:layout style;--mono:var(--xk-mono-font-family,ui-monospace,Consolas,monospace);color:var(--op-text);font:12px system-ui}
*{box-sizing:border-box}button{cursor:pointer;font:inherit;color:inherit}button:focus-visible{outline:2px solid var(--op-accent)}
.header,.tr{display:grid;grid-template-columns:30px 76px minmax(150px,.8fr) minmax(180px,1.1fr) minmax(240px,1.4fr) minmax(130px,.7fr) 76px 24px;align-items:center;gap:10px;padding:0 10px}
.header{position:sticky;top:0;height:30px;z-index:4;background:var(--op-surface-2);border-bottom:1px solid var(--op-border);border-left:3px solid transparent;font-size:10px;font-weight:650;text-transform:uppercase;color:var(--op-muted)}
.body{position:relative}.tr{position:absolute;left:0;right:0;height:32px;border-bottom:1px solid var(--op-border);border-left:3px solid var(--op-border);background:var(--op-surface);cursor:default}
.tr.stripe{background:var(--op-surface-2)}.tr.proxy{border-left-color:var(--op-accent)}.tr.direct{border-left-color:var(--op-success)}.tr.block,.tr.error{border-left-color:var(--op-danger)}.tr.dns{border-left-color:var(--op-warning)}
.tr.selected{background:var(--op-accent-soft)}.tr>span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.muted,.time,.port{color:var(--op-muted);font:11px var(--mono)}.device small{margin-left:7px;color:var(--op-muted);font:10px var(--mono)}
.pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:20px;vertical-align:middle;padding:0 8px;border-radius:999px;font-size:11.5px;overflow:hidden;white-space:nowrap}.pill.proxy{color:var(--op-accent);background:var(--op-accent-soft)}.pill.proxy .label{color:color-mix(in srgb,var(--op-accent) 65%,var(--op-text) 35%)}.pill.direct{color:var(--op-success);background:var(--op-success-soft)}.pill.block{color:var(--op-danger);background:var(--op-danger-soft)}.pill.dns{color:var(--op-warning);background:var(--op-warning-soft)}
.flag{display:inline-flex;flex-shrink:0;width:18px;height:13px;border-radius:2px;overflow:hidden}.flag svg{width:18px;height:13px}.node{min-width:0;overflow:hidden;text-overflow:ellipsis}.route-icon{width:14px;height:14px;object-fit:contain}.rule{color:var(--op-muted);font:11px var(--mono)}
.check,.chev{justify-self:center;background:transparent;padding:0;color:var(--op-muted)}.check{position:relative;width:14px;height:14px;border:1.5px solid var(--op-border-strong);border-radius:4px}.check[aria-checked=true],.check[aria-checked=mixed]{border-color:var(--op-accent);background:var(--op-accent)}.check[aria-checked=true]::after{content:"";position:absolute;top:.5px;left:3.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}.check[aria-checked=mixed]::after{content:"";position:absolute;top:5px;left:2px;width:7px;height:2px;background:#fff}
.chev{display:grid;place-items:center;width:22px;height:22px;border:0;border-radius:5px}.chev .ic{display:block;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.chev[aria-expanded=true]{color:var(--op-accent)}.chev[aria-expanded=true] .ic{transform:rotate(180deg)}.tr:hover .chev{background:var(--op-surface-3)}
.message{grid-column:3/8;font:12px var(--mono)}.level{font:10px var(--mono);color:var(--op-muted)}.error .level{color:var(--op-danger)}
.detail{position:absolute;left:0;right:0;display:grid;gap:8px;padding:12px 18px;background:var(--op-surface);border:1px solid var(--op-border);z-index:2}.detail pre{min-width:0;font:11px/1.6 var(--mono);white-space:pre-wrap;word-break:break-word;user-select:text;margin:0;padding:8px;border:1px dashed var(--op-border);border-radius:6px;background:var(--op-editor);color:var(--op-muted)}.detail .acts{display:flex;flex-wrap:wrap;gap:6px}.detail button{border:1px solid var(--op-border);background:var(--op-surface-2);border-radius:6px;padding:6px 9px}.detail dl{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:11px;margin:0}.detail dl:empty{display:none}.detail dt{color:var(--op-muted)}.detail dd{margin:0;overflow-wrap:anywhere}.empty{padding:35px;color:var(--op-muted);text-align:center}
@media(max-width:900px){.header,.tr{grid-template-columns:24px 65px minmax(110px,.8fr) minmax(130px,1fr) minmax(160px,1.1fr) 68px 22px;gap:6px}.rule{display:none}.message{grid-column:3/7}.device small{display:none}}
@media(max-width:600px){.header,.tr{grid-template-columns:20px 58px minmax(110px,1fr) minmax(130px,1.2fr) 22px;padding:0 4px}.device,.port{display:none!important}.message{grid-column:3/5}.time{font-size:10px}.pill{padding:0 4px;font-size:10px}}
`;

export function logNodeHtml(name, light = false) {
  const code = nodeCountryCode(name),
    flag = code && countryFlag(code);
  const flagClass = light ? "xk-xlog-flag" : "flag";
  return `${flag?.svg ? `<span class="${flagClass}" data-country="${e(code)}" title="${e(flag.label)}">${flag.svg}</span>` : ""}<span class="node">${e(nodeDisplayName(name, code) || name)}</span>`;
}

export function createMihomoLogView({
  host,
  summary,
  chips,
  footer,
  onAction,
  routeIcon = () => "",
}) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CSS}</style><div class="header" role="row"><button class="check" data-action="select-all" role="checkbox" aria-checked="false" aria-label="Выбрать все строки"></button><span>Время</span><span class="device">Устройство</span><span>Назначение</span><span>Маршрут / узел</span><span class="rule">Правило</span><span class="port">Порт</span><span></span></div><div class="body" role="rowgroup"></div><div class="empty"></div>`;
  const body = shadow.querySelector(".body"),
    empty = shadow.querySelector(".empty");
  let snapshot = null,
    openId = null,
    stuck = true,
    unseen = 0,
    frame = 0,
    lastStats = -Infinity,
    detailEl = null,
    detailH = 0;
  const nodes = new Map();
  const more = host.parentElement.querySelector("[data-mlog-new]");
  const getOpenIndex = () =>
    snapshot?.visible.findIndex((r) => r.id === openId) ?? -1;
  const topOf = (i, open = getOpenIndex()) =>
    i * ROW + (open >= 0 && i > open ? detailH : 0);
  const edge = () =>
    !snapshot || snapshot.order === "newest"
      ? host.scrollTop < 24
      : host.scrollHeight - host.clientHeight - host.scrollTop < 24;
  function scrollNew() {
    stuck = true;
    unseen = 0;
    host.scrollTop = snapshot?.order === "oldest" ? host.scrollHeight : 0;
    paint();
    updateNew();
  }
  function updateNew() {
    if (!more) return;
    more.hidden = stuck || !unseen;
    more.textContent = `${snapshot?.order === "oldest" ? "↓" : "↑"} К новым · ${unseen}`;
  }
  function device(r) {
    return r.devices.find((d) => d.ip === r.sourceIp)?.name || r.sourceIp;
  }
  function rowHtml(r) {
    const check = `<button class="check" data-action="select" aria-label="Выбрать строку" role="checkbox" aria-checked="${snapshot.selected.includes(r.id)}"></button>`;
    const arrow = `<button class="chev" data-action="detail" aria-label="Подробности" aria-expanded="${openId === r.id}">${iconHtml('chevron-down', 'ic')}</button>`;
    if (r.type !== "connection")
      return `${check}<span class="time">${e(r.time || "—")}</span><span class="message"><span class="level">${e(r.kind === "dns" ? "DNS" : r.level.toUpperCase())}</span>　${e(r.raw)}</span>${arrow}`;
    const node = r.node || r.group,
      icon = routeIcon(r.group);
    const marker = icon
      ? `<img class="route-icon" src="${e(icon)}" alt="" referrerpolicy="no-referrer">`
      : "";
    const route =
      r.kind === "proxy"
        ? `<span class="label">Через прокси</span> · ${marker}${r.node ? `${e(r.group)} → ` : ""}${logNodeHtml(node)}`
        : // An unclassified route (GLOBAL has no proven destination) keeps its
          // group icon, but gains no route label.
          `${marker}${e(LABELS[r.kind] || r.group || "Не определён")}`;
    return `${check}<span class="time">${e(r.time || "—")}</span><span class="device" data-field="device" title="${e(r.sourceIp)}">${e(device(r))}${device(r) !== r.sourceIp ? `<small>${e(r.sourceIp)}</small>` : ""}</span><span data-field="domain" title="${e(r.destination)}">${e(r.destination)}</span><span data-field="node" title="${e(node)}"><span class="pill ${r.kind}">${route}</span></span><span class="rule" title="${e(r.rule)}">${e(r.rule || "—")}</span><span class="port">${e(r.destinationPort)}/${e(r.network)}</span>${arrow}`;
  }
  function paint() {
    if (!snapshot) return;
    const rows = snapshot.visible,
      open = getOpenIndex();
    if (open >= 0) {
      const r = rows[open];
      if (!detailEl) {
        detailEl = document.createElement("section");
        detailEl.className = "detail";
        body.append(detailEl);
      }
      detailEl.style.top = `${open * ROW + ROW}px`;
      if (detailEl.dataset.id !== String(r.id)) {
        detailEl.dataset.id = r.id;
        detailEl.innerHTML = `<b>${e(r.destination || r.level.toUpperCase())}</b>${r.rule ? `<div>Правило: ${e(r.rule)}</div>` : ""}<dl>${Object.entries(r.fields).map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl><pre>${e(r.raw)}</pre><div class="acts"><button data-action="copy-raw">Копировать строку</button>${r.sourceIp ? '<button data-action="filter-device">Только это устройство</button>' : ""}${r.destination ? '<button data-action="filter-domain">Только этот домен</button>' : ""}${r.kind === "proxy" ? '<button data-action="filter-node">Только этот узел</button>' : ""}</div>`;
      }
      detailH = detailEl.offsetHeight;
    } else {
      detailEl?.remove();
      detailEl = null;
      detailH = 0;
    }
    const selected = rows.filter(r => snapshot.selected.includes(r.id)).length;
    shadow.querySelector('[data-action="select-all"]').setAttribute('aria-checked', selected ? (selected === rows.length ? 'true' : 'mixed') : 'false');
    const total = rows.length * ROW + detailH;
    body.style.height = `${total}px`;
    empty.hidden = !!rows.length;
    empty.textContent = snapshot.records.length
      ? "Записи по текущему фильтру не найдены."
      : "Новые записи появятся здесь в реальном времени. История до открытия вкладки не загружается.";
    const y = Math.max(0, host.scrollTop - 30),
      height = host.clientHeight || 500;
    let first = Math.max(
      0,
      Math.floor((y - (open >= 0 && y > topOf(open) ? detailH : 0)) / ROW) - 8,
    );
    const last = Math.min(rows.length, first + Math.ceil(height / ROW) + 20),
      keep = new Set();
    let cursor = body.firstElementChild;
    for (let i = first; i < last; i++) {
      const r = rows[i];
      keep.add(r.id);
      let el = nodes.get(r.id);
      if (!el) {
        el = document.createElement("div");
        el.className = `tr ${r.kind || ""} ${r.level === "error" ? "error" : ""}`;
        el.dataset.id = r.id;
        el.setAttribute("role", "row");
        nodes.set(r.id, el);
        body.append(el);
      }
      el.style.top = `${topOf(i, open)}px`;
      el.classList.toggle("stripe", i % 2 === 1);
      el.classList.toggle("selected", snapshot.selected.includes(r.id));
      const key = `${openId === r.id}|${snapshot.selected.includes(r.id)}`;
      if (el._key !== key) {
        el.innerHTML = rowHtml(r);
        el._key = key;
      }
      // Reused rows stay in display order, also for keyboard/assistive readers.
      if (el !== cursor) body.insertBefore(el, cursor);
      cursor = el.nextElementSibling;
    }
    for (const [id, el] of nodes)
      if (!keep.has(id)) {
        el.remove();
        nodes.delete(id);
      }
  }
  function topEntries(map, n = 3) {
    return [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  // Counters change every second, so the markup is rewritten constantly. A
  // plain innerHTML swap would replace the very button someone is pressing or
  // tabbing through, swallowing the click and dropping keyboard focus. Instead
  // nodes that carry an identity (a filter button) are reused and only their
  // attributes and text are brought up to date; everything else is matched by
  // position.
  const identity = (node) =>
    node?.nodeType === 1 && node.dataset.filter && node.dataset.value != null
      ? `${node.dataset.filter}\u0000${node.dataset.value}`
      : "";
  function syncAttrs(old, fresh) {
    for (const { name } of [...old.attributes])
      if (!fresh.hasAttribute(name)) old.removeAttribute(name);
    for (const { name, value } of [...fresh.attributes])
      if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
  function sync(old, fresh) {
    const olds = [...old.childNodes],
      freshList = [...fresh.childNodes],
      byKey = new Map(),
      used = new Set();
    for (const node of olds) {
      const key = identity(node);
      if (key && !byKey.has(key)) byKey.set(key, node);
    }
    const keep = freshList.map((node, i) => {
      const key = identity(node);
      let old$ = key ? byKey.get(key) || null : null;
      if (old$) {
        byKey.delete(key);
        used.add(old$);
      } else if (!key) {
        const candidate = olds[i];
        if (
          candidate &&
          !used.has(candidate) &&
          !identity(candidate) &&
          candidate.nodeName === node.nodeName
        ) {
          old$ = candidate;
          used.add(candidate);
        }
      }
      if (!old$ || old$.nodeType !== node.nodeType) return node;
      if (node.nodeType === 3) {
        if (old$.nodeValue !== node.nodeValue) old$.nodeValue = node.nodeValue;
        return old$;
      }
      if (old$.nodeName !== node.nodeName) return node;
      syncAttrs(old$, node);
      sync(old$, node);
      return old$;
    });
    let ref = old.firstChild;
    for (const node of keep) {
      if (node === ref) {
        ref = ref.nextSibling;
        continue;
      }
      old.insertBefore(node, ref);
    }
    while (ref) {
      const next = ref.nextSibling;
      old.removeChild(ref);
      ref = next;
    }
  }
  function setHtml(el, html) {
    if (el._html === html) return;
    el._html = html;
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    sync(el, tpl.content);
  }
  function stats(force) {
    if (!snapshot) return;
    const now = performance.now();
    if (!force && now - lastStats < 1000) return;
    lastStats = now;
    const s = snapshot.summary;
    const nameForIp = (ip) =>
      snapshot.records.flatMap((r) => r.devices).find((d) => d.ip === ip)
        ?.name || ip;
    const chip = (field, value, label, count, on, extra = "") =>
      `<button class="xk-xlog-chip${on ? " is-on" : ""}" type="button" data-filter="${field}" data-value="${e(value)}" aria-pressed="${on}">${extra}${label}<em>${count}</em></button>`;
    let html = `<div class="xk-xlog-chiprow"><span class="lbl">Маршрут</span>${Object.keys(
      LABELS,
    )
      .map((k) =>
        chip(
          "kind",
          k,
          e(LABELS[k]),
          snapshot.counts[k],
          snapshot.filters.kinds.includes(k),
          `<span class="dot dot-${k}"></span>`,
        ),
      )
      .join(
        "",
      )}<span class="xk-xlog-vsep"></span><span class="xk-xlog-hint">Alt+клик по ячейке — добавить условие</span><button type="button" class="xk-xlog-reset" data-filter="reset">Сбросить</button></div>`;
    const allNodes = new Map();
    for (const r of snapshot.records)
      if (r.kind === "proxy") {
        const n = r.node || r.group;
        allNodes.set(n, (allNodes.get(n) || 0) + 1);
      }
    if (allNodes.size)
      html += `<div class="xk-xlog-chiprow"><span class="lbl">Узел</span>${topEntries(
        allNodes,
        12,
      )
        .map(([n, c]) =>
          chip("node", n, logNodeHtml(n, true), c, snapshot.filters.node === n),
        )
        .join("")}</div>`;
    if (snapshot.filters.device || snapshot.filters.domain)
      html += `<div class="xk-xlog-chiprow"><span class="lbl">Условия</span>${[
        "device",
        "domain",
      ]
        .filter((f) => snapshot.filters[f])
        .map((f) =>
          chip(
            f,
            snapshot.filters[f],
            e(snapshot.filters[f]) + " ✕",
            null,
            true,
          ),
        )
        .join("")}</div>`;
    setHtml(chips, html);
    const shares = Object.entries(s.kinds).filter(([, n]) => n),
      percent = (n) => (s.total ? Math.round((n * 100) / s.total) : 0);
    const extra = summary.querySelector("[data-mlog-summary-extra]");
    extra.textContent = `· ${s.total} соединений · устройств ${s.devices.size} · узлов ${s.nodes.size} · доменов ${s.domains.size}`;
    setHtml(
      summary.querySelector("[data-mlog-summary-mini]"),
      shares
        .map(
          ([k, n]) =>
            `<span class="dot-${k}">${e(LABELS[k])} <em>${percent(n)}%</em></span>`,
        )
        .join(""),
    );
    const list = (map, field, label) => {
      const entries = topEntries(map);
      const max = entries[0]?.[1] || 1;
      return entries.length
        ? `<ul class="xk-xlog-top">${entries.map(([v, n]) => `<li style="--w:${Math.round((n * 100) / max)}%"><button type="button" data-filter="${field}" data-value="${e(v)}">${label(v)}</button><em>${n}</em></li>`).join("")}</ul>`
        : '<p class="xk-xlog-muted">Пока пусто</p>';
    };
    setHtml(
      summary.querySelector("[data-mlog-summary-body]"),
      `<div class="xk-xlog-tile"><h4>Куда уходит трафик</h4><div class="xk-xlog-bar">${shares.map(([k, n]) => `<i class="dot-${k}" style="flex:${n}"></i>`).join("")}</div><div class="xk-xlog-legend">${shares.map(([k, n]) => `<span class="dot-${k}"><b>${e(LABELS[k])}</b><em>${percent(n)}%</em></span>`).join("")}</div></div><div class="xk-xlog-tile"><h4>Узлы</h4>${list(s.nodes, "node", (n) => logNodeHtml(n, true))}</div><div class="xk-xlog-tile"><h4>Устройства</h4>${list(s.devices, "device", (ip) => e(nameForIp(ip)))}</div><div class="xk-xlog-tile"><h4>Домены</h4>${list(s.domains, "domain", e)}</div>`,
    );
  }
  // The row at the top edge of the view and how far it stands above it, both
  // measured on the geometry currently on screen: an expanded row above the eye
  // shifts every row below it by its measured height.
  function anchorAt(scrollTop, openIndex) {
    const y = Math.max(0, scrollTop - 30);
    let i = 0;
    while (
      i + 1 < (snapshot?.visible.length ?? 0) &&
      topOf(i + 1, openIndex) <= y
    )
      i += 1;
    return { id: snapshot?.visible[i]?.id, offset: topOf(i, openIndex) - y };
  }
  function render(next, { force = false } = {}) {
    const old = snapshot,
      atEdge = stuck,
      previousTop = host.scrollTop;
    const oldAnchor = old ? anchorAt(previousTop, getOpenIndex()) : null;
    snapshot = next;
    if (openId && !next.visible.some((r) => r.id === openId)) openId = null;
    paint();
    const changed = old && old.visible[0]?.id !== next.visible[0]?.id;
    if (atEdge) {
      host.scrollTop = next.order === "newest" ? 0 : host.scrollHeight;
      unseen = 0;
    } else if (changed && oldAnchor?.id != null) {
      const index = next.visible.findIndex((r) => r.id === oldAnchor.id);
      host.scrollTop =
        index >= 0
          ? 30 + topOf(index, getOpenIndex()) - oldAnchor.offset
          : previousTop;
    }
    if (old && !atEdge) {
      const lastId = old.records.at(-1)?.id || 0;
      unseen += next.records.filter((r) => r.id > lastId).length;
    }
    paint();
    stats(force);
    updateNew();
    footer.textContent = `Показано ${next.visible.length} из ${next.records.length} · В буфере ${next.buffered} / 500${next.paused ? ` · Накоплено ${next.pending}${next.evictedWhilePaused ? ` · Вытеснено ${next.evictedWhilePaused}` : ""}` : ""}`;
  }
  function onScroll() {
    stuck = edge();
    if (stuck) unseen = 0;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
        updateNew();
      });
  }
  function onClick(event) {
    const target = event.target.closest("[data-action]"),
      row = event.target.closest("[data-id]");
    if (!row && !target) return;
    const id = row ? Number(row.dataset.id) : null;
    if (target?.dataset.action === "detail") {
      openId = openId === id ? null : id;
      paint();
      return;
    }
    if (event.altKey && event.target.closest("[data-field]")) {
      const field = event.target.closest("[data-field]").dataset.field;
      onAction({ type: "filter-" + field, id });
      return;
    }
    // The checkbox cell is a toggle by itself; Ctrl/Cmd extends the selection
    // from anywhere in the row.
    onAction({
      type: target?.dataset.action || "select",
      id,
      toggle:
        event.ctrlKey || event.metaKey || target?.dataset.action === "select",
      range: event.shiftKey,
    });
  }
  function onDouble(event) {
    const row = event.target.closest(".tr");
    if (row) {
      openId =
        openId === Number(row.dataset.id) ? null : Number(row.dataset.id);
      paint();
    }
  }
  function onKey(event) {
    if (event.target.closest("button,input")) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onAction({ type: "select-all" });
    }
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault();
      onAction({ type: "copy-selected" });
    }
    if (event.key === "Escape") onAction({ type: "clear-selection" });
  }
  host.addEventListener("scroll", onScroll, { passive: true });
  shadow.addEventListener("click", onClick);
  shadow.addEventListener("dblclick", onDouble);
  host.addEventListener("keydown", onKey);
  const resize = new ResizeObserver(() => {
    if (snapshot) paint();
  });
  resize.observe(host);
  return {
    render,
    scrollNew,
    refresh() {
      for(const node of nodes.values())node._key=null;
      stats(true);
      paint();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      host.removeEventListener("scroll", onScroll);
      shadow.removeEventListener("click", onClick);
      shadow.removeEventListener("dblclick", onDouble);
      host.removeEventListener("keydown", onKey);
      nodes.clear();
      shadow.innerHTML = "";
    },
  };
}
