// Tab "Модемы": a full-width card per LTE modem (state, four signal gauges, the
// aggregated frequencies as tiles, the details in four columns). Read-only: the card
// can only probe the control port; restarting a modem is not offered (see
// docs/superpowers/specs/2026-10-04-router-modem-controls-design.md).

import { NBSP, clockText, durationText, esc, num, percentWidth, toNumber } from "./tools_format.js";
import { isAborted, requestJson } from "./tools_net.js";

const LTE_ENDPOINT = "/api/system/router/lte";
const LTE_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 20000;
export const SAFETY_NOTE = "Перезапуск из панели отключён: модемами управляет Keenetic.";

// Radio-signal rating of a modem. This is RF quality (what the number means for the
// connection), not a load zone of the router, so it is not part of zones.py.
// Per metric: value range of the gauge, unit, and tiers (first with value >= min wins).
export const SIGNAL_SCALES = {
  rsrp: { title: "Сигнал", abbr: "RSRP", unit: "дБм", from: -125, to: -70, tiers: [{ min: -90, word: "отличный", tone: "g" }, { min: -100, word: "хороший", tone: "g" }, { min: -110, word: "слабый", tone: "o" }, { min: -Infinity, word: "очень слабый", tone: "r" }] },
  rsrq: { title: "Качество", abbr: "RSRQ", unit: "дБ", from: -20, to: -3, tiers: [{ min: -10, word: "хорошее", tone: "g" }, { min: -15, word: "среднее", tone: "o" }, { min: -Infinity, word: "плохое", tone: "r" }] },
  cinr: { title: "Помехи", abbr: "SINR", unit: "дБ", from: -5, to: 30, tiers: [{ min: 13, word: "хорошо", tone: "g" }, { min: 0, word: "средне", tone: "o" }, { min: -Infinity, word: "плохо", tone: "r" }] },
  rssi: { title: "Мощность", abbr: "RSSI", unit: "дБм", from: -110, to: -50, tiers: [{ min: -65, word: "сильный", tone: "g" }, { min: -85, word: "средний", tone: "g" }, { min: -95, word: "слабый", tone: "o" }, { min: -Infinity, word: "очень слабый", tone: "r" }] },
};

// Centre frequency of the LTE bands the carriers report (MHz).
const BAND_MHZ = { 1: 2100, 2: 1900, 3: 1800, 5: 850, 7: 2600, 8: 900, 20: 800, 28: 700, 31: 450, 38: 2600, 40: 2300, 41: 2500 };
const CARRIER_SCALE_MHZ = 20;

function signalTile(key, value) {
  const scale = SIGNAL_SCALES[key];
  const number = toNumber(value);
  if (number == null) {
    return `<div class="xkt-sig-tile" data-signal="${key}"><span class="xkt-tile-h">${scale.title} <em>${scale.abbr}</em></span><b class="xkt-tile-v">—</b><span class="xkt-meter"><i style="width:0"></i></span><span class="xkt-tile-s n">нет данных</span></div>`;
  }
  const tier = scale.tiers.find((step) => number >= step.min);
  return `<div class="xkt-sig-tile" data-signal="${key}"><span class="xkt-tile-h">${scale.title} <em>${scale.abbr}</em></span><b class="xkt-tile-v">${num(number, Number.isInteger(number) ? 0 : 1).replace("-", "−")}${NBSP}<small>${scale.unit}</small></b><span class="xkt-meter ${tier.tone}"><i style="width:${percentWidth(number, scale.from, scale.to).toFixed(1)}%"></i></span><span class="xkt-tile-s ${tier.tone}">${tier.word}</span></div>`;
}

function bandNumber(band) {
  const match = String(band ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function carrierList(item) {
  if (Array.isArray(item.carriers) && item.carriers.length) return item.carriers;
  // an older answer without the carrier list: the modem's own band is the only frequency
  if (item.band) return [{ band: item.band, bandwidth: item.bandwidth, earfcn: item.earfcn, phy_cell_id: item.phy_cell_id }];
  return [];
}

function carrierTile(carrier, index, count) {
  const number = bandNumber(carrier.band);
  const mhz = number != null ? BAND_MHZ[number] : null;
  const role = count === 1 ? "Одна частота" : index === 0 ? "Основная" : `Доп. ${index}`;
  const name = number != null ? `B${number}${mhz ? ` · ${mhz}${NBSP}МГц` : ""}` : "частота не определена";
  const width = toNumber(carrier.bandwidth);
  const ids = [carrier.earfcn != null ? `EARFCN ${esc(carrier.earfcn)}` : "", carrier.phy_cell_id ? `PCI ${esc(carrier.phy_cell_id)}` : ""].filter(Boolean).join(" · ");
  return `<div class="xkt-carrier" data-carrier="${index}"><span class="xkt-tile-h">${role}</span><b class="xkt-carrier-b">${esc(name)}</b><span class="xkt-carrier-w"><span class="xkt-meter p"><i style="width:${Math.max(width ? 4 : 0, percentWidth(width, 0, CARRIER_SCALE_MHZ)).toFixed(1)}%"></i></span><span>${width == null ? "" : `${num(width, Number.isInteger(width) ? 0 : 1)}${NBSP}МГц`}</span></span><small>${ids || "&nbsp;"}</small></div>`;
}

// "агрегация 3 частот · 50 МГц" (the genitive plural follows the word "агрегация")
export function aggregationLabel(carriers) {
  if (carriers.length < 2) return "";
  const total = carriers.reduce((sum, carrier) => sum + (toNumber(carrier.bandwidth) || 0), 0);
  return `агрегация ${carriers.length} частот${total > 0 ? ` · ${num(total, Number.isInteger(total) ? 0 : 1)}${NBSP}МГц` : ""}`;
}

export function maskImei(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 5) return "—";
  return `•••• •••• ${digits.slice(-4)}`;
}

function distanceText(meters) {
  const value = toNumber(meters);
  if (value == null) return "—";
  if (value >= 1000) return `≈${NBSP}${num(value / 1000, 1)}${NBSP}км`;
  return `≈${NBSP}${num(value)}${NBSP}м`;
}

function stationText(item) {
  if (item.enb_id) return `eNB ${item.enb_id}${item.sector_id ? `, сектор ${item.sector_id}` : ""}`;
  return item.base_station || "";
}

function cell(label, value) {
  const text = value == null || String(value).trim() === "" ? "—" : String(value);
  return `<div class="xkt-info-c"><dt>${label}</dt><dd>${esc(text)}</dd></div>`;
}

function isConnected(item) {
  return item.connected === true || String(item.connection_state || "").toLowerCase() === "connected";
}

function cardHtml(item, index) {
  const connected = isConnected(item);
  const carriers = carrierList(item);
  const label = aggregationLabel(carriers);
  const role = item.default_route === true ? "основной канал" : "резервный канал";
  const title = [item.operator || item.name || item.id, item.technology].filter(Boolean).join(" · ") || `Модем ${index + 1}`;
  const sub = [item.model, item.id, role].filter(Boolean).join(" · ");
  const roaming = item.roaming === true ? "да" : item.roaming === false ? "нет" : "";
  const uptime = connected ? durationText(item.uptime) : "";
  const aggHead = carriers.length > 1
    ? "Агрегация частот: модем принимает сразу на нескольких частотах, их ширина складывается"
    : carriers.length === 1 ? "Агрегации нет: модем работает на одной частоте" : "";
  return `<article class="xkt-modem" data-modem-id="${esc(item.id)}" data-connected="${connected}"${item.default_route === true ? ' data-primary="true"' : ""}>
    <header class="xkt-modem-h">
      <div class="xkt-modem-t"><strong>${esc(title)}</strong>${label ? `<span class="xkt-agg">${esc(label)}</span>` : ""}<span class="xkt-modem-sub">${esc(sub)}</span></div>
      <div class="xkt-modem-meta"><span class="xkt-st ${connected ? "up" : ""}"><i></i>${connected ? "подключён" : esc(item.connection_state || "ожидает")}</span><span>в сети <b>${esc(uptime || "—")}</b></span><span>адрес <b>${esc(item.address || "—")}</b></span></div>
    </header>
    <div class="xkt-signals">${signalTile("rsrp", item.rsrp)}${signalTile("rsrq", item.rsrq)}${signalTile("cinr", item.cinr)}${signalTile("rssi", item.rssi)}</div>
    ${carriers.length ? `<div class="xkt-agg-h">${aggHead}</div><div class="xkt-carriers" style="--n:${carriers.length}">${carriers.map((carrier, i) => carrierTile(carrier, i, carriers.length)).join("")}</div>` : ""}
    <dl class="xkt-info">${cell("Базовая станция", stationText(item))}${cell("TAC", item.tac)}${cell("До вышки", distanceText(item.distance))}${cell("APN", item.apn)}${cell("SIM", item.sim)}${cell("Роуминг", roaming)}${cell("Прошивка модема", item.firmware)}${cell("IMEI", maskImei(item.imei))}</dl>
    <div class="xkt-probe"><button type="button" class="xkt-btn" data-probe="${esc(item.id)}">Проверить управление</button><span class="xkt-probe-status" role="status" aria-live="polite" hidden></span></div>
  </article>`;
}

function probeMessage(code) {
  const messages = {
    modem_not_found: "Модем больше не найден. Обновите данные.",
    transport_not_matched: "Управляющий порт этого модема не найден.",
    qmi_tool_missing: "QMI-инструмент на роутере недоступен. Установите пакет qmi-utils: opkg update && opkg install qmi-utils. Затем повторите проверку.",
    qmi_probe_timeout: "Проверка QMI превысила время ожидания.",
    qmi_probe_failed: "Проверка QMI завершилась ошибкой.",
  };
  return messages[code] || "Не удалось проверить управляющий порт.";
}

export function createModemsTab(panel, ctx) {
  const state = { payload: null, loading: false, error: false };
  const controls = new Map(); // modem id -> { busy, message, tone, connected }

  panel.innerHTML = `<div class="xkt-bar"><span class="xkt-lead" data-role="lead">Запрашиваем состояние модемов…</span><span class="xkt-actions"><button type="button" class="xkt-btn" data-act="refresh">Обновить</button></span></div><p class="xkt-note">${SAFETY_NOTE}</p><div class="xkt-modems" data-role="body"></div>`;
  const lead = panel.querySelector('[data-role="lead"]');
  const body = panel.querySelector('[data-role="body"]');
  const refresh = panel.querySelector('[data-act="refresh"]');

  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { busy: false, message: "", tone: "", connected: false });
    return controls.get(id);
  };

  function syncControl(id) {
    const card = Array.from(body.children).find((node) => node.dataset.modemId === id);
    if (!card) return;
    const entry = control(id);
    const button = card.querySelector("[data-probe]");
    const status = card.querySelector(".xkt-probe-status");
    if (button) button.disabled = entry.busy || !id;
    if (status) {
      status.textContent = entry.message;
      status.dataset.state = entry.tone;
      status.hidden = !entry.message;
    }
  }

  function paint() {
    const payload = state.payload;
    const items = Array.isArray(payload?.items) ? payload.items : payload?.available ? [payload] : [];
    if (state.error) {
      lead.textContent = "Не удалось получить данные LTE. Повторите попытку.";
      return;
    }
    if (!items.length) {
      lead.textContent = "LTE-модемы не обнаружены";
      body.innerHTML = '<div class="xkt-empty">Роутер не вернул данные модемов.</div>';
      return;
    }
    lead.textContent = `Найдено модемов: ${items.length} · перезапуск — в веб-интерфейсе Keenetic · снято в ${clockText(payload.sampled_at, true)}`;
    body.innerHTML = items.map(cardHtml).join("");
    items.forEach((item) => {
      const id = String(item.id || "");
      const entry = control(id);
      entry.connected = isConnected(item);
      if (!entry.connected) {
        if (!entry.message || entry.tone !== "running") {
          entry.message = "Модем не подключён.";
          entry.tone = "error";
        }
      } else if (entry.message === "Модем не подключён.") {
        entry.message = "";
        entry.tone = "";
      }
      if (!id) {
        entry.message = "Идентификатор модема недоступен.";
        entry.tone = "error";
      }
      syncControl(id);
    });
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    refresh.disabled = true;
    if (!state.payload) lead.textContent = "Запрашиваем состояние модемов…";
    const signal = ctx.signal();
    try {
      const { ok, data } = await requestJson(LTE_ENDPOINT, { signal, timeoutMs: LTE_TIMEOUT_MS });
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

  async function probe(id) {
    const entry = control(id);
    if (entry.busy) return;
    entry.busy = true;
    entry.message = "Проверяем управляющий порт…";
    entry.tone = "running";
    syncControl(id);
    const signal = ctx.signal();
    try {
      const { ok, data } = await requestJson(`${LTE_ENDPOINT}/${encodeURIComponent(id)}/probe`, { method: "POST", signal, timeoutMs: PROBE_TIMEOUT_MS });
      if (isAborted(signal)) return;
      if (!ok) throw new Error(probeMessage(data?.code));
      const available = Boolean(data?.preferred_transport && data?.transports?.some((transport) => transport.kind === data.preferred_transport && transport.available === true));
      entry.message = !entry.connected
        ? "Модем не подключён."
        : available
          ? `${data.preferred_transport === "qmi" ? "QMI" : "AT"} доступен · ${id}`
          : probeMessage(data?.code);
      entry.tone = entry.connected && available ? "success" : "error";
    } catch (error) {
      if (isAborted(signal)) return;
      entry.message = error.timedOut ? "Нет ответа от роутера. Проверьте состояние модема." : error.message || probeMessage();
      entry.tone = "error";
    } finally {
      entry.busy = false;
      syncControl(id);
    }
  }

  panel.addEventListener("click", (event) => {
    const probeId = event.target.closest?.("[data-probe]")?.dataset.probe;
    if (probeId != null) {
      void probe(probeId);
      return;
    }
    if (event.target.closest?.('[data-act="refresh"]')) void load();
  });

  return {
    load,
    update() {},
    reset() {
      state.payload = null;
      state.error = false;
      state.loading = false;
      controls.clear();
      body.innerHTML = "";
      lead.textContent = "Запрашиваем состояние модемов…";
    },
  };
}

// Do the connection list or the interfaces name a mobile modem? The tab exists only then,
// so the answer must not need the modem request itself.
const MODEM_ID = /^(usbqmi|usblte|usbmbim|usbnet|modem|wwan)/i;

export function hasModems(snapshot) {
  const names = [];
  for (const item of snapshot?.router?.interfaces?.items || []) names.push(item.name, item.kind);
  for (const link of snapshot?.links || []) names.push(link.id, link.kernel);
  return names.some((name) => MODEM_ID.test(String(name || "")));
}
