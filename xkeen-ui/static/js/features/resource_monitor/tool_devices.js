// Tab "Устройства": who is on the network now, the five most active devices,
// "Показать все" turns on the windowed list when there are more than 50 of them.

import { createVirtualRows } from "./virtual_rows.js";
import { NBSP, bitsText, bytesText, esc, num, toNumber } from "./tools_format.js";
import { isAborted, requestJson } from "./tools_net.js";

const CLIENTS_ENDPOINT = "/api/system/router/clients";
const TOP_COUNT = 5;
export const VIRTUAL_FROM = 50;
const ROW_HEIGHT = 52;
const LIST_HEIGHT = 468;

// Wi-Fi signal of a device (dBm) -> bars and a word. Radio-quality scale, not a load zone.
const CLIENT_SIGNAL = [
  { min: -55, bars: 4, word: "отличный", tone: "g" },
  { min: -67, bars: 3, word: "хороший", tone: "g" },
  { min: -75, bars: 2, word: "средний", tone: "o" },
  { min: -Infinity, bars: 1, word: "слабый", tone: "o" },
];

function signalHtml(rssi) {
  const value = toNumber(rssi);
  if (value == null) return '<span class="xkt-dim">—</span>';
  const level = CLIENT_SIGNAL.find((step) => value >= step.min);
  const bars = [1, 2, 3, 4].map((n) => `<i class="${n <= level.bars ? `on ${level.tone}` : ""}" style="height:${3 + n * 3}px"></i>`).join("");
  return `<span class="xkt-bars" aria-hidden="true">${bars}</span><span class="xkt-sigword">${level.word}</span>`;
}

// Same radio numbering as the hardware temperature tiles: WifiMaster0 = 2,4 GHz.
const WIFI_BANDS = { WifiMaster0: "2,4 ГГц", WifiMaster1: "5 ГГц" };

// Link speed reads like the ports of the hardware section: "1 Гбит/с", "2,4 Гбит/с", "867 Мбит/с".
function linkText(bitsPerSecond) {
  const mbps = Math.round(bitsPerSecond / 1e6);
  if (mbps < 1000) return bitsText(bitsPerSecond);
  return `${num(mbps / 1000, mbps % 1000 ? 1 : 0)}${NBSP}Гбит/с`;
}

function connectionHtml(item) {
  const iface = item.interface || "";
  const wifi = toNumber(item.rssi) != null || /wifi|accesspoint/i.test(iface);
  const label = item.port ? `порт ${item.port}` : WIFI_BANDS[iface.split("/")[0]] || iface;
  const sub = label ? `<small>${esc(label)}</small>` : "";
  return `<span class="xkt-strong">${wifi ? "Wi‑Fi" : "Кабель"}</span>${sub}`;
}

function rowHtml(item) {
  const name = item.name || item.mac || item.ip || "Устройство";
  const ident = [item.ip, item.mac].filter(Boolean).join(" · ");
  // Wi-Fi: the radio link rate; cable: the negotiated speed of the switch port.
  const speed = toNumber(item.rx_rate) ?? toNumber(item.port_speed);
  const rate = speed != null ? linkText(speed) : "—";
  return `<div class="xkt-c xkt-ident"><b>${esc(name)}</b><small>${esc(ident)}</small></div>
    <div class="xkt-c">${connectionHtml(item)}</div>
    <div class="xkt-c xkt-sig">${signalHtml(item.rssi)}</div>
    <div class="xkt-c xkt-num">${esc(rate)}</div>
    <div class="xkt-c xkt-num">${esc(bytesText(item.traffic_bytes))}</div>`;
}

const HEAD = `<div class="xkt-head xkt-dev-cols" role="row"><div role="columnheader">Устройство</div><div role="columnheader">Подключение</div><div role="columnheader">Сигнал</div><div role="columnheader">Скорость связи</div><div role="columnheader">Передано с подключения</div></div>`;

export function createDevicesTab(panel, ctx) {
  const state = { payload: null, all: false, busy: false, error: false, list: null, loading: false };

  panel.innerHTML = `<div class="xkt-bar"><span class="xkt-lead" data-role="lead">Загрузка списка устройств…</span><span class="xkt-actions"><button type="button" class="xkt-btn" data-act="all" hidden></button><button type="button" class="xkt-btn" data-act="refresh">Обновить</button></span></div><div data-role="body"></div>`;
  const lead = panel.querySelector('[data-role="lead"]');
  const body = panel.querySelector('[data-role="body"]');
  const allButton = panel.querySelector('[data-act="all"]');
  const refresh = panel.querySelector('[data-act="refresh"]');

  const items = () => (Array.isArray(state.payload?.items) ? state.payload.items : []);

  function destroyList() {
    state.list?.destroy();
    state.list = null;
  }

  function paint() {
    destroyList();
    const payload = state.payload;
    if (state.error || !payload?.available) {
      lead.textContent = state.error ? "Не удалось получить список устройств. Проверьте доступ RCI и повторите." : "Роутер не вернул список устройств.";
      allButton.hidden = true;
      body.innerHTML = "";
      return;
    }
    const all = items();
    const online = all.filter((item) => item.online !== false).length;
    const top = Array.isArray(payload.top) && payload.top.length ? payload.top : all.slice(0, TOP_COUNT);
    const canShowAll = all.length > TOP_COUNT;
    allButton.hidden = !canShowAll;
    allButton.textContent = state.all ? "Показать самых активных" : `Показать все (${all.length})`;
    allButton.setAttribute("aria-pressed", state.all ? "true" : "false");
    const shown = state.all ? all : top.slice(0, TOP_COUNT);
    lead.innerHTML = `Сейчас в сети <b>${online} ${deviceWord(online)}</b> · ${state.all ? `показаны все ${all.length}` : `показаны ${shown.length} самых активных`}${payload.truncated ? " · лимит роутера: 100 записей" : ""}`;
    if (!shown.length) {
      body.innerHTML = '<div class="xkt-empty">Активных устройств не найдено.</div>';
      return;
    }
    if (state.all && all.length > VIRTUAL_FROM) {
      body.innerHTML = `${HEAD}<div data-role="virtual"></div>`;
      state.list = createVirtualRows(body.querySelector('[data-role="virtual"]'), {
        rowHeight: ROW_HEIGHT,
        height: LIST_HEIGHT,
        label: "Все устройства",
        renderRow: (item) => `<div class="xkt-row xkt-dev-cols">${rowHtml(item)}</div>`,
      });
      state.list.setItems(all);
      return;
    }
    body.innerHTML = `<div role="table" aria-label="Устройства">${HEAD}${shown.map((item) => `<div class="xkt-row xkt-dev-cols" role="row">${rowHtml(item)}</div>`).join("")}</div>`;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    refresh.disabled = true;
    if (!state.payload) lead.textContent = "Загрузка списка устройств…";
    const signal = ctx.signal();
    try {
      const { ok, data } = await requestJson(CLIENTS_ENDPOINT, { signal });
      if (isAborted(signal)) return;
      if (!ok) throw new Error("HTTP");
      state.payload = data;
      state.error = false;
    } catch (error) {
      if (isAborted(signal)) return;
      state.error = true;
    } finally {
      state.loading = false;
      refresh.disabled = false;
    }
    paint();
  }

  panel.addEventListener("click", (event) => {
    const act = event.target.closest?.("[data-act]")?.dataset.act;
    if (act === "refresh") void load();
    else if (act === "all") {
      state.all = !state.all;
      paint();
    }
  });

  return {
    load,
    update() {},
    reset() {
      destroyList();
      state.payload = null;
      state.all = false;
      state.error = false;
      state.loading = false;
      body.innerHTML = "";
      lead.textContent = "Загрузка списка устройств…";
      allButton.hidden = true;
    },
    // test handle: the windowed list of the "all" view
    virtualRows: () => state.list?.rowCount() ?? 0,
  };
}

function deviceWord(count) {
  const last = count % 10;
  const tens = count % 100;
  if (last === 1 && tens !== 11) return "устройство";
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return "устройства";
  return "устройств";
}
