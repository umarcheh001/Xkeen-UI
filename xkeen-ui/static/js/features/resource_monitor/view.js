// The router diagnostics window: status line, four cards, connection chain and the
// hardware block, rendered inside a shadow root (panel-operator.css cannot reach it).
//
// The view only DRAWS what the server decided: zones, labels of the card texts and
// the temperature bands all come from /api/system/{summary,hardware}; no threshold
// is computed here.
//
// mountDashboardView(host) -> View
//   renderSummary(summary)   status line + cards (GET /api/system/summary)
//   renderHardware(hw)       hardware block (GET /api/system/hardware)
//   renderConnection(router) connection chain (summary.router)
//   onCardClick(cb)          cb(metric) with metric in cpu | memory | internet | link
//   onLinkClick(cb)          cb(name) with name in tariff | dns-log
//   focusConnection()        open the details of the connection chain
//   chartHost, toolsHost     empty containers for the big chart and the tool tabs
//   redraw()                 repaints the canvases (after the window was resized/shown)
//   destroy()

import { drawAvailabilityStrip, drawMiniIndicator, drawMiniMirror } from "./canvas_charts.js";
import { setHtml } from "./tools_format.js";
import { VIEW_CSS } from "./view_css.js";

const MB = 1048576;
const GB = 1024 * MB;
const NBSP = " ";

const CARD_TITLES = { cpu: "Процессор", memory: "Память", internet: "Интернет", link: "Загрузка канала" };
const ZONE_WORDS = {
  cpu: ["норма", "высокая", "перегрузка"],
  memory: ["норма", "мало свободной", "критично"],
  internet: ["работает", "сбой DNS", "нет связи"],
  link: ["свободен", "загружен", "забит"],
};
const TEMP_WORDS = ["норма", "горячо", "перегрев"];
const TEMP_FLOOR_C = 20;

// What a temperature tile is and what heats it, in words for a person: [what, heated by].
const TEMP_NOTES = {
  cpu: ["Ядра процессора: на них работают система роутера, Xray или Mihomo и эта панель.", "шифрование прокси, обновление подписок и списков."],
  soc: ["Общая температура главной микросхемы роутера. По ней роутер решает, когда аварийно выключиться.", "любая долгая нагрузка, тесный или закрытый корпус."],
  npu: ["Блок, который пропускает трафик в обход процессора (аппаратное ускорение).", "большой трафик напрямую, без прокси: загрузки, торренты, IPTV."],
  ports: ["Блок проводных портов LAN и WAN.", "большой трафик по проводам, особенно на 2,5 Гбит/с."],
  wifi24: ["Радиомодуль Wi‑Fi 2,4 ГГц, отдельная микросхема.", "много клиентов и трафика по Wi‑Fi."],
  wifi5: ["Радиомодуль Wi‑Fi 5 ГГц, отдельная микросхема.", "много клиентов и трафика по Wi‑Fi; 5 ГГц обычно горячее 2,4 ГГц."],
};

function tempPop(group) {
  const [what, heat] = TEMP_NOTES[group.id] || [];
  const bands = group.bands || {};
  const zones = finite(bands.orange_c) && finite(bands.red_c)
    ? `<span class="zs"><span><i class="g"></i>норма до ${num(bands.orange_c)} °C</span><span><i class="o"></i>горячо ${num(bands.orange_c)}–${num(bands.red_c)} °C</span><span><i class="r"></i>перегрев выше ${num(bands.red_c)} °C</span></span>`
    : "";
  return `<div class="hw-pop" role="tooltip"><span class="h">${esc(group.label)}</span>${what ? `<span class="p">${esc(what)}</span>` : ""}${heat ? `<span class="p"><b>Греется от:</b> ${esc(heat)}</span>` : ""}${zones}</div>`;
}

const METER_CLASS = ["", "o", "r"]; // server zone index -> meter colour

let viewSheet = null;

function adoptViewStyles(shadow) {
  try {
    if (!viewSheet && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
      viewSheet = new CSSStyleSheet();
      viewSheet.replaceSync(VIEW_CSS);
    }
    if (viewSheet && "adoptedStyleSheets" in shadow) {
      shadow.adoptedStyleSheets = [viewSheet];
      return "";
    }
  } catch (error) {
    // fall through to the <style> fallback
  }
  return `<style>${VIEW_CSS}</style>`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function num(value, digits = 0) {
  if (!finite(value)) return "—";
  return value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function lowerFirst(text) {
  const value = String(text || "");
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function uptimeText(seconds) {
  if (!finite(seconds) || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days} д ${hours} ч`;
  if (hours) return `${hours} ч ${minutes % 60} мин`;
  return `${minutes} мин`;
}

function megabytes(bytes) {
  return `${num(Math.round((bytes || 0) / MB))}${NBSP}МБ`;
}

function bigBytes(bytes) {
  if (!finite(bytes)) return "—";
  if (bytes >= GB) return `${num(bytes / GB, bytes / GB >= 10 || Number.isInteger(bytes / GB) ? 0 : 1)}${NBSP}ГБ`;
  return megabytes(bytes);
}

function speedText(port) {
  if (!port.link || !finite(port.speed_mbps)) return "нет кабеля";
  if (port.speed_mbps >= 1000) return `${num(port.speed_mbps / 1000, port.speed_mbps % 1000 ? 1 : 0)}${NBSP}Гбит/с`;
  return `${port.speed_mbps}${NBSP}Мбит/с`;
}

function series(bars) {
  return { avg: bars?.values || [], zone: bars?.zones || [] };
}

function badge(metric, zone) {
  if (zone == null) return '<span class="xkm-badge none">нет данных</span>';
  return `<span class="xkm-badge z${zone}">${esc(ZONE_WORDS[metric][zone])}</span>`;
}

function card(metric, zone, badgeHtml, big, sub, spark, extra = "") {
  return `<div class="xkm-card" data-metric="${metric}" data-zone="${zone ?? ""}" role="button" tabindex="0">
    <div class="xkm-card-h"><span>${esc(CARD_TITLES[metric] || "")}</span>${badgeHtml}</div>
    <div class="xkm-big">${big}</div>
    <div class="xkm-sub">${sub}</div>
    ${extra}
    ${spark}
  </div>`;
}

// "Билайн: ↑ 0 % / ↓ 3 %": the other connections that carry traffic right now.
function secondaryLine(link) {
  const items = (link?.secondary || []).map((other) => {
    const known = finite(other.up_percent) && finite(other.down_percent);
    const speed = known
      ? `↑${NBSP}${num(other.up_percent)}${NBSP}% / ↓${NBSP}${num(other.down_percent)}${NBSP}%`
      : `↑${NBSP}${num(other.up_mbps, 1)} / ↓${NBSP}${num(other.down_mbps, 1)}${NBSP}Мбит/с`;
    return `${esc(other.label)}: ${speed}`;
  });
  return items.length ? `<div class="xkm-sec">${items.join(" · ")}</div>` : "";
}

const sparkCanvas = (kind) => `<canvas class="xkm-spark" data-kind="${kind}" style="width:100%;height:34px"></canvas>`;

// ---- status line ---------------------------------------------------------

function problemItems(summary, hardware) {
  const items = [];
  const throttle = hardware?.throttle?.throttled ? hardware.throttle : null;
  let throttleShown = false;
  for (const problem of summary?.status?.problems || []) {
    if (problem.type === "cpu_throttled") {
      throttleShown = true;
      if (throttle) items.push(`процессор замедлился из-за нагрева: ${throttle.current_mhz} из ${throttle.max_mhz} МГц`);
      else items.push(`${lowerFirst(problem.title)}${problem.detail ? `: ${problem.detail}` : ""}`);
    } else if (problem.type === "cpu_overload" && problem.leaders?.length) {
      const [name, share] = problem.leaders[0];
      items.push(`${lowerFirst(problem.title)} — больше всех ${name} (${Math.round(share)} %)`);
    } else {
      items.push(lowerFirst(problem.title));
    }
  }
  if (throttle && !throttleShown) items.push(`процессор замедлился из-за нагрева: ${throttle.current_mhz} из ${throttle.max_mhz} МГц`);
  return items;
}

function statusHtml(summary, hardware) {
  if (!summary) {
    return `<div class="xkm-status" data-tone="muted"><span class="dot"></span><div class="msg"><strong>Ожидание данных</strong></div></div>`;
  }
  const items = problemItems(summary, hardware);
  const rciDown = summary.rci_available === false;
  let tone = "ok";
  let title = "Всё в порядке";
  let note = "роутер не перегружен, интернет работает";
  if (items.length) {
    tone = "warn";
    title = `Есть проблемы: ${items.length}`;
    note = [...items, ...(rciDown ? ["часть данных недоступна"] : [])].join(" · ");
  } else if (rciDown) {
    tone = "warn";
    title = "Часть данных недоступна";
    note = "роутер не отвечает на запросы состояния, показаны данные самой панели";
  }
  const identity = summary.identity || hardware?.identity || {};
  const model = [identity.model, identity.firmware].filter(Boolean).join(" · ");
  const uptime = uptimeText(summary.uptime_s);
  const facts = [model ? `<span>${esc(model)}</span>` : "", uptime ? `<span>Работает <b>${esc(uptime)}</b></span>` : ""].join("");
  return `<div class="xkm-status" data-tone="${tone}"><span class="dot"></span><div class="msg"><strong>${esc(title)}</strong> <span class="note">· ${esc(note)}</span></div><div class="facts">${facts}</div></div>`;
}

// ---- cards ---------------------------------------------------------------

function cardsHtml(cards) {
  const parts = [];
  const cpu = cards?.cpu || {};
  parts.push(card("cpu", cpu.zone, badge("cpu", cpu.zone), `${num(cpu.value)}<small>%</small>`, esc(cpu.text), sparkCanvas("level")));
  const memory = cards?.memory || {};
  parts.push(card("memory", memory.zone, badge("memory", memory.zone), `${num(memory.value)}<small>%</small>`, esc(memory.text), sparkCanvas("level")));
  const internet = cards?.internet || {};
  parts.push(card("internet", internet.zone, badge("internet", internet.zone), esc(internet.label || "нет данных"), esc(internet.text), sparkCanvas("strip")));
  const link = cards?.link;
  if (!link) {
    parts.push(card("link", null, '<span class="xkm-badge none">нет данных</span>', "—", "", sparkCanvas("mirror")));
  } else if (link.has_tariff) {
    parts.push(card("link", link.zone, badge("link", link.zone),
      `↑${NBSP}${num(link.up_percent)}<small>%</small><span class="sep">/</span>↓${NBSP}${num(link.down_percent)}<small>%</small>`,
      esc(link.text), sparkCanvas("mirror"), secondaryLine(link)));
  } else {
    parts.push(`<div class="xkm-card" data-metric="link" data-zone="" role="button" tabindex="0">
    <div class="xkm-card-h"><span>Интернет-трафик</span><span class="xkm-badge none">тариф не задан</span></div>
    <div class="xkm-big">↑${NBSP}${num(link.up_mbps, 1)}<span class="sep">/</span>↓${NBSP}${num(link.down_mbps, 1)}<small>Мбит/с</small></div>
    <div class="xkm-sub">Отдача / приём · <button type="button" class="xkm-a" data-link="tariff">указать тариф</button></div>
    ${secondaryLine(link)}
    ${sparkCanvas("mirror")}
  </div>`);
  }
  return parts.join("");
}

// The indicators change only when a column of their history closes, so a repaint with the same
// data is skipped (a canvas costs a backing-store clear, a raster and a commit). `force` repaints
// anyway: after a resize, and at least every SPARK_REPAINT_MS so a changed theme shows up.
const SPARK_REPAINT_MS = 30000;

function drawSparks(root, cards, force = false) {
  const now = Date.now();
  for (const canvas of root.querySelectorAll(".xkm-spark")) {
    const metric = canvas.closest(".xkm-card")?.dataset.metric;
    const data = cards?.[metric];
    if (!data) continue;
    const signature = JSON.stringify(data.bars || null) + (data.has_tariff ? "t" : "");
    if (!force && canvas.xkSignature === signature && now - canvas.xkPainted < SPARK_REPAINT_MS) continue;
    canvas.xkSignature = signature;
    canvas.xkPainted = now;
    try {
      if (metric === "internet") drawAvailabilityStrip(canvas, data.bars?.zones || []);
      else if (metric === "link") {
        if (data.has_tariff) drawMiniMirror(canvas, series(data.bars?.up), series(data.bars?.down));
        else drawMiniMirror(canvas, series(data.bars?.up), series(data.bars?.down), { percent: false, neutral: true });
      } else drawMiniIndicator(canvas, series(data.bars));
    } catch (error) {
      // a failed canvas must not break the window
    }
  }
}

// ---- connection ----------------------------------------------------------

function chainModel(router) {
  const info = router?.internet;
  const known = info && info.available !== false;
  const flag = (value) => (!known || value == null ? null : Boolean(value));
  const steps = [
    { id: "router", title: "Роутер", ok: known ? true : null, good: "WAN подключён", bad: "", unknown: "нет данных" },
    { id: "gateway", title: "Провайдер", ok: flag(info?.gateway), good: "шлюз отвечает", bad: "шлюз не отвечает", unknown: "нет данных" },
    { id: "dns", title: "DNS", ok: flag(info?.dns), good: "имена находятся", bad: "не отвечает", unknown: "нет данных" },
    { id: "internet", title: "Интернет", ok: flag(info?.internet), good: "сайты открываются", bad: "нет связи", unknown: "нет данных" },
  ];
  let broken = false;
  for (const step of steps) {
    if (broken) {
      step.state = "unk";
      step.text = "не проверить";
      continue;
    }
    step.state = step.ok === true ? "ok" : step.ok === false ? "bad" : "unk";
    step.text = step.ok === true ? step.good : step.ok === false ? step.bad : step.unknown;
    if (step.state === "bad") broken = true;
  }
  return steps;
}

const ALERTS = {
  gateway: "<b>Шлюз провайдера не отвечает.</b> Проверьте кабель и питание модема провайдера; если не помогает, обратитесь к провайдеру.",
  dns: '<b>DNS не отвечает.</b> Роутер не может узнать адреса сайтов. Чаще всего помогает сменить DNS-сервер в настройках интернета или проверить DoH/DoT. <button type="button" class="xkm-a" data-link="dns-log">Журнал ошибок DNS</button>',
  internet: "<b>Нет связи с интернетом.</b> Шлюз и DNS отвечают, но сайты не открываются: проверьте тариф и подключение у провайдера.",
};

function nodeDetail(step, info) {
  const bits = [];
  if (step.id === "router") {
    if (info?.interface) bits.push(`Интерфейс ${info.interface}`);
    if (info?.address) bits.push(`адрес ${info.address}`);
  }
  if (info?.checked) bits.push(`проверено ${info.checked}`);
  return bits.length ? `${step.title}: ${step.text} · ${bits.join(" · ")}` : `${step.title}: ${step.text}`;
}

function connectionHtml(router, openNode) {
  const info = router?.internet;
  const steps = chainModel(router);
  const marks = { ok: "✓", bad: "✕", unk: "?" };
  let chain = "";
  steps.forEach((step, index) => {
    if (index) chain += `<span class="xkm-link ${step.state === "ok" ? "" : step.state}"></span>`;
    chain += `<button type="button" class="xkm-node ${step.state}" data-node="${step.id}" aria-expanded="${openNode === step.id}"><span class="ic">${marks[step.state]}</span><span class="t"><b>${esc(step.title)}</b><span>${esc(step.text)}</span></span></button>`;
  });
  const failed = steps.find((step) => step.state === "bad");
  const detail = steps.find((step) => step.id === openNode);
  const captive = info?.captive;
  const address = router?.external_address || info?.address;
  const meta = [
    address ? `<span>Внешний адрес <b>${esc(address)}</b></span>` : "",
    info?.interface ? `<span>Интерфейс <b>${esc(info.interface)}</b></span>` : "",
    `<span>Авторизация в сети <b>${captive === true ? "не требуется" : captive === false ? "требуется" : "нет данных"}</b></span>`,
  ].join("");
  return `<div class="xkm-panel-h"><h3>Подключение</h3><span class="xkm-hint">Нажмите на звено — подробности</span></div>
    <div class="xkm-chain">${chain}</div>
    ${detail ? `<div class="xkm-node-detail">${esc(nodeDetail(detail, info))}</div>` : ""}
    ${failed && ALERTS[failed.id] ? `<div class="xkm-conn-alert">${ALERTS[failed.id]}</div>` : ""}
    <div class="xkm-conn-meta">${meta}</div>`;
}

// ---- hardware ------------------------------------------------------------

// `edge`: which side the hint hangs from, on a wide grid and on the two-column phone grid.
function tempTile(group, throttle, edge = "") {
  const value = group.value_c;
  const name = esc(group.label);
  if (!finite(value)) {
    const why = group.kind === "wifi" ? "радио выключено" : "датчик не отвечает";
    return `<div class="hw-t off" data-temp="${esc(group.id)}"${edge} tabindex="0"><span class="n">${name}</span><b>— <small>°C</small></b><span class="hw-track"><span class="g" style="width:100%"></span></span><small class="s">нет данных · ${why}</small>${tempPop(group)}</div>`;
  }
  const throttled = Boolean(throttle?.throttled);
  const zone = throttled ? 2 : (group.zone ?? 0);
  const bands = group.bands || {};
  const red = finite(bands.red_c) ? bands.red_c : null;
  const orange = finite(bands.orange_c) ? bands.orange_c : null;
  const top = finite(group.shutdown_c) ? group.shutdown_c : (red != null ? red + 25 : 125);
  const pct = (degrees) => Math.max(0, Math.min(100, ((degrees - TEMP_FLOOR_C) / (top - TEMP_FLOOR_C)) * 100));
  const mark = pct(value);
  let track = '<span class="g" style="width:100%"></span>';
  if (orange != null && red != null) {
    track = `<span class="g" style="width:${pct(orange).toFixed(1)}%"></span><span class="o" style="left:${pct(orange).toFixed(1)}%;width:${(pct(red) - pct(orange)).toFixed(1)}%"></span><span class="r" style="left:${pct(red).toFixed(1)}%;width:${(100 - pct(red)).toFixed(1)}%"></span>`;
  }
  let line = `${TEMP_WORDS[zone]}`;
  if (throttled) line = `процессор замедлился из-за нагрева: ${throttle.current_mhz} из ${throttle.max_mhz} МГц`;
  else if (zone === 2) line += " · выше безопасного";
  else if (red != null) line += ` · до перегрева ${num(Math.max(0, Math.round(red - value)))} °C`;
  const hot = finite(group.hotter_by) && group.hotter_by > 0 ? `<small class="hot">на ${num(group.hotter_by)} °C горячее обычного — проверьте, не закрыт ли роутер</small>` : "";
  const pop = tempPop(group);
  return `<div class="hw-t z${zone}" data-temp="${esc(group.id)}"${edge} tabindex="0"><span class="n">${name}</span><b>${num(value)} <small>°C</small></b><span class="hw-track">${track}<i style="left:${mark.toFixed(1)}%"></i></span><small class="s">${esc(line)}</small>${hot}${pop}</div>`;
}

function temperatureSection(hw) {
  const groups = hw.temperatures || [];
  const count = groups.length;
  const cols = count > 3 ? Math.ceil(count / 2) : count;
  // throttling is shown on the processor tile, or on the whole chip where it is the only sensor
  const throttleHost = groups.some((g) => g.id === "cpu") ? "cpu" : "soc";
  const shutdown = Math.max(0, ...groups.map((g) => (finite(g.shutdown_c) ? g.shutdown_c : 0)));
  const hint = shutdown ? `аварийное отключение чипа при ${num(shutdown)} °C` : "";
  const valued = groups.filter((g) => finite(g.value_c));
  const hottest = valued.reduce((best, g) => (best == null || g.value_c > best.value_c ? g : best), null);
  const alertZone = hottest ? (hottest.zone ?? 0) : 0;
  const alert = hottest && alertZone > 0
    ? `<div class="hw-alert z${alertZone}"><b>${alertZone === 2 ? "Роутер перегревается." : "Роутер сильно нагрелся."}</b> Проверьте, что он стоит открыто: не в шкафу, не накрыт, не рядом с батареей. Сейчас горячее всего — ${esc(lowerFirst(hottest.label))}, ${num(hottest.value_c)} °C.</div>`
    : "";
  return `<div class="hw-sec" data-section="temperature"><div class="hw-sh"><b>Температура</b>${hint ? `<span>${esc(hint)}</span>` : ""}</div>${alert}<div class="hw-temps" style="--cols:${cols}">${groups.map((g, i) => tempTile(g, g.id === throttleHost ? hw.throttle : null, ` data-edge="${i % cols === cols - 1 && cols > 1 ? "end" : "start"}" data-pedge="${i % 2 ? "end" : "start"}"`)).join("")}</div></div>`;
}

function memorySection(hw, two) {
  const mem = hw.memory || {};
  const total = mem.total_bytes || 0;
  const share = (bytes) => (total ? Math.max(0, Math.min(100, ((bytes || 0) / total) * 100)).toFixed(1) : "0");
  const ram = total
    ? `<div class="hw-m"><span class="n">Оперативная память · ${megabytes(total)}</span><div class="hw-stack"><i class="p" style="width:${share(mem.programs_bytes)}%"></i><i class="c" style="width:${share(mem.cache_bytes)}%"></i><i class="f" style="width:${share(mem.free_bytes)}%"></i></div><div class="hw-leg"><span><i class="p"></i>программы ${megabytes(mem.programs_bytes)}</span><span><i class="c"></i>кэш ${megabytes(mem.cache_bytes)}</span><span><i class="f"></i>свободно ${megabytes(mem.free_bytes)}</span></div></div>`
    : '<div class="hw-m"><span class="n">Оперативная память</span><b>нет данных</b></div>';
  const zram = hw.zram;
  let zramHtml;
  if (!zram) zramHtml = '<div class="hw-kv"><span>Сжатая подкачка в памяти (zram)</span><b>выключена</b></div>';
  else {
    const used = zram.used_bytes || 0;
    const heavy = zram.pressure === true;
    zramHtml = `<div class="hw-kv"><span>Сжатая подкачка в памяти (zram)</span><b>до ${bigBytes(zram.size_bytes)} <small>· ${used > 0 ? `используется ${megabytes(used)}` : "включена, не используется"}</small></b>${heavy ? '<em class="o">роутеру не хватает памяти</em>' : ""}</div>`;
  }
  const st = hw.storage;
  const flash = st
    ? `<div class="hw-kv"><span>Флешка Entware</span><b>${bigBytes(st.used_bytes)} <small>из ${bigBytes(st.total_bytes)}</small></b><div class="hw-meter ${METER_CLASS[st.zone] || ""}"><i style="width:${Math.max(0, Math.min(100, st.percent || 0))}%"></i></div></div>`
    : '<div class="hw-kv"><span>Флешка Entware</span><b>нет данных</b></div>';
  const ct = hw.conntrack;
  const conn = ct?.available
    ? `<div class="hw-kv"><span>Открытые соединения</span><b>${num(ct.count)} <small>из ${num(ct.max)}</small></b><div class="hw-meter ${METER_CLASS[ct.zone] || ""}"><i style="width:${Math.max(0, Math.min(100, ct.percent || 0))}%"></i></div></div>`
    : '<div class="hw-kv"><span>Открытые соединения</span><b>нет данных</b></div>';
  return `<div class="hw-sec" data-section="memory"><div class="hw-sh"><b>Память и хранилище</b></div><div class="hw-res${two ? " two" : ""}">${ram}${zramHtml}${flash}${conn}</div></div>`;
}

function portsSection(hw) {
  const list = hw.ports || [];
  const slow = new Set((hw.slow_ports || []).map((p) => p.id));
  const sockets = list.map((port) => {
    const state = !port.link ? "down" : slow.has(port.id) ? "warn" : "up";
    const wan = port.is_wan ? " wan" : "";
    const desc = port.description ? `<small class="d">${esc(port.description)}</small>` : "";
    return `<div class="hw-port ${state}${wan}"><span class="jack"></span><b>${esc(port.is_wan ? "WAN" : port.label)}</b><small>${esc(speedText(port))}</small>${desc}</div>`;
  });
  const notes = (hw.slow_ports || []).map((p) => `<div class="hw-note">Порт ${esc(p.label)} работает на ${num(p.speed_mbps)}${NBSP}Мбит/с вместо 1${NBSP}Гбит/с. Обычно виноват кабель (нужен с 8 жилами, категории 5e или выше) или устройство с медленным портом.</div>`);
  return `<div class="hw-sec" data-section="ports"><div class="hw-sh"><b>Порты</b><span>как на задней панели</span></div><div class="hw-ports" style="--np:${Math.max(1, list.length)}">${sockets.join("")}</div>${notes.join("")}</div>`;
}

function hardwareHtml(hw) {
  const count = (hw.temperatures || []).length;
  const mode = count === 0 ? "none" : count > 3 ? "many" : "few";
  const model = hw.identity?.model || "";
  const hint = [model, count ? "" : "датчиков температуры у этой модели нет"].filter(Boolean).join(" · ");
  return `<div class="xkm-panel-h"><h3>Состояние железа</h3><span class="xkm-hint">${esc(hint)}</span></div>
    <div class="hw-grid" data-temps="${mode}">${count ? temperatureSection(hw) : ""}${memorySection(hw, count <= 3)}${portsSection(hw)}</div>`;
}

// ---- mount ---------------------------------------------------------------

export function mountDashboardView(host) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  const fallback = adoptViewStyles(shadow);
  shadow.innerHTML = `${fallback}<div class="xkm">
    <div data-slot="status"></div>
    <div class="xkm-kpis" data-slot="cards"></div>
    <section class="xkm-panel" data-slot="connection"></section>
    <section class="xkm-panel" data-slot="hardware"></section>
    <div class="xkm-lazy" data-slot="chart"></div>
    <div class="xkm-lazy" data-slot="tools"></div>
  </div>`;
  const slot = (name) => shadow.querySelector(`[data-slot="${name}"]`);
  const state = { summary: null, hardware: null, router: null, openNode: null, hardwareKey: "", cardCb: null, linkCb: null, frame: 0 };

  const paintStatus = () => { setHtml(slot("status"), statusHtml(state.summary, state.hardware)); };
  const paintConnection = () => {
    const panel = slot("connection");
    panel.hidden = !state.router;
    if (state.router) setHtml(panel, connectionHtml(state.router, state.openNode));
  };
  const paintSparks = (force = true) => drawSparks(shadow, state.summary?.cards, force === true);

  shadow.addEventListener("click", (event) => {
    const link = event.target.closest?.("[data-link]");
    if (link) {
      event.stopPropagation();
      state.linkCb?.(link.dataset.link);
      return;
    }
    const node = event.target.closest?.("[data-node]");
    if (node) {
      state.openNode = state.openNode === node.dataset.node ? null : node.dataset.node;
      paintConnection();
      return;
    }
    const cardEl = event.target.closest?.(".xkm-card");
    if (cardEl) state.cardCb?.(cardEl.dataset.metric);
  });
  shadow.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const cardEl = event.target.closest?.(".xkm-card");
    if (!cardEl || event.target !== cardEl) return;
    event.preventDefault();
    state.cardCb?.(cardEl.dataset.metric);
  });

  paintStatus();
  paintConnection();

  let observer = null;
  if (typeof ResizeObserver === "function") {
    let lastWidth = 0;
    observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (width === lastWidth || !width) return;
      lastWidth = width;
      cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => paintSparks(true));
    });
    observer.observe(host);
  }

  return {
    renderSummary(summary) {
      state.summary = summary || null;
      paintStatus();
      setHtml(slot("cards"), summary ? cardsHtml(summary.cards) : "");
      paintSparks(false);
    },
    renderHardware(hw) {
      state.hardware = hw || null;
      paintStatus();
      const key = JSON.stringify(hw || null);
      if (key === state.hardwareKey) return;
      state.hardwareKey = key;
      const panel = slot("hardware");
      panel.hidden = !hw;
      panel.innerHTML = hw ? hardwareHtml(hw) : "";
    },
    renderConnection(router) {
      state.router = router || null;
      paintConnection();
    },
    // Open the details of the connection chain (the broken link, else the last one).
    focusConnection() {
      const failed = chainModel(state.router).find((step) => step.state === "bad");
      state.openNode = failed ? failed.id : "internet";
      paintConnection();
      slot("connection").scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    },
    onCardClick(cb) { state.cardCb = typeof cb === "function" ? cb : null; },
    onLinkClick(cb) { state.linkCb = typeof cb === "function" ? cb : null; },
    chartHost: slot("chart"),
    toolsHost: slot("tools"),
    redraw: () => paintSparks(true),
    destroy() {
      observer?.disconnect();
      cancelAnimationFrame(state.frame);
      shadow.innerHTML = "";
    },
  };
}
