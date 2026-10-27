// Tab "Интерфейсы": what the router reports about its interfaces. No request of its own:
// the list is part of the window's summary (summary.router.interfaces), repainted
// with every summary while the tab is open.

import { bitsPairText, bytesPairText, esc, num, toNumber } from "./tools_format.js";

const KIND_NAMES = { wan: "Интернет (WAN)", lan: "Домашняя сеть", wifi: "Wi‑Fi", vpn: "VPN" };

function title(item) {
  const description = String(item.description || "").trim();
  if (description && description !== item.name) return description;
  return KIND_NAMES[item.kind] || item.name || "—";
}

function stateHtml(item) {
  if (item.online === true) return '<span class="xkt-st up"><i></i>подключён</span>';
  if (item.online === false) return '<span class="xkt-st down"><i></i>отключён</span>';
  return `<span class="xkt-st"><i></i>${esc(item.state || "—")}</span>`;
}

function errorsHtml(item) {
  const parts = [["RX ошибок", item.receive_errors], ["RX потерь", item.receive_dropped], ["TX ошибок", item.send_errors], ["TX потерь", item.send_dropped]]
    .map(([label, value]) => [label, toNumber(value)])
    .filter(([, value]) => value != null);
  if (!parts.length) return '<span class="xkt-dim">—</span>';
  const total = parts.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return "нет";
  const detail = parts.filter(([, value]) => value > 0).map(([label, value]) => `${label}: ${num(value)}`).join(" · ");
  return `<span class="xkt-warn" title="${esc(detail)}">${num(total)} ${lossWord(total)}</span><small>${esc(detail)}</small>`;
}

function lossWord(count) {
  const last = count % 10;
  const tens = count % 100;
  if (last === 1 && tens !== 11) return "потеря";
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return "потери";
  return "потерь";
}

export function createIfacesTab(panel, ctx) {
  const state = { filter: "active" };
  panel.innerHTML = `<div class="xkt-bar"><span class="xkt-lead" data-role="lead"></span><span class="xkt-seg" role="group" aria-label="Фильтр интерфейсов"><button type="button" class="xkt-btn" data-filter="active" aria-pressed="true">Активные</button><button type="button" class="xkt-btn" data-filter="all" aria-pressed="false">Все</button></span></div><div data-role="body"></div>`;
  const lead = panel.querySelector('[data-role="lead"]');
  const body = panel.querySelector('[data-role="body"]');

  function paint() {
    const data = ctx.snapshot().router?.interfaces;
    for (const button of panel.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", button.dataset.filter === state.filter ? "true" : "false");
    const all = Array.isArray(data?.items) ? data.items : [];
    if (!data?.available || !all.length) {
      lead.textContent = "Данные об интерфейсах недоступны";
      body.innerHTML = '<div class="xkt-empty">Роутер не вернул список интерфейсов.</div>';
      return;
    }
    const items = state.filter === "all" ? all : all.filter((item) => item.online === true);
    lead.textContent = state.filter === "all" ? `Показаны все · ${all.length}` : `Показаны активные · ${items.length} из ${all.length}`;
    const head = '<div class="xkt-head xkt-if-cols" role="row"><div>Интерфейс</div><div>Состояние</div><div>Адрес</div><div>Сейчас ↓ / ↑</div><div>Передано ↓ / ↑</div><div>Ошибки</div></div>';
    const rows = items.map((item) => `<div class="xkt-row xkt-if-cols" role="row" data-iface="${esc(item.name)}">
      <div class="xkt-c xkt-ident"><b>${esc(title(item))}</b><small>${esc(item.name)}</small></div>
      <div class="xkt-c">${stateHtml(item)}</div>
      <div class="xkt-c xkt-num">${esc(item.address || "—")}</div>
      <div class="xkt-c xkt-num">${esc(bitsPairText(item.receive_bits_per_second, item.send_bits_per_second))}</div>
      <div class="xkt-c xkt-num">${esc(bytesPairText(item.received_bytes, item.sent_bytes))}</div>
      <div class="xkt-c">${errorsHtml(item)}</div>
    </div>`).join("");
    body.innerHTML = `<div role="table" aria-label="Интерфейсы">${head}${rows || '<div class="xkt-empty">Активных интерфейсов нет.</div>'}</div>`;
  }

  panel.addEventListener("click", (event) => {
    const filter = event.target.closest?.("[data-filter]")?.dataset.filter;
    if (!filter) return;
    state.filter = filter === "all" ? "all" : "active";
    paint();
  });

  return {
    load: paint,
    update: paint,
    reset() {
      state.filter = "active";
      body.innerHTML = "";
    },
  };
}
