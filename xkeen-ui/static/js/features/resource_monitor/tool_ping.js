// Tab "Проверка связи": address row, four equal tiles (delay, spread, loss, verdict) and
// the route as a scale of hops over the full width.

import { NBSP, clockText, esc, num, percentWidth, toNumber } from "./tools_format.js";
import { isAborted, requestJson } from "./tools_net.js";

const CHANNEL_ENDPOINT = "/api/system/router/channel-check";
const CHECK_TIMEOUT_MS = 30000;
const QUICK_TARGETS = ["1.1.1.1", "8.8.8.8", "ya.ru"];

// Quality words of a ping result. Network-quality scale of this tab, not a load zone.
// A tier applies while the value is <= max; the last one catches the rest.
const PING_TIERS = {
  latency: { scale: 200, tiers: [{ max: 30, word: "отлично", tone: "g" }, { max: 80, word: "нормально", tone: "g" }, { max: 150, word: "высокая", tone: "o" }, { max: Infinity, word: "очень высокая", tone: "r" }] },
  jitter: { scale: 50, tiers: [{ max: 5, word: "стабильно", tone: "g" }, { max: 20, word: "заметный разброс", tone: "o" }, { max: Infinity, word: "нестабильно", tone: "r" }] },
  loss: { scale: 100, tiers: [{ max: 0, word: "без потерь", tone: "g" }, { max: 5, word: "есть потери", tone: "o" }, { max: Infinity, word: "много потерь", tone: "r" }] },
};
// Hop latency colour on the route scale.
const HOP_TIERS = [{ max: 50, tone: "g" }, { max: 100, tone: "o" }, { max: Infinity, tone: "r" }];
const HOP_SCALE_MS = 150;

const VERDICTS = {
  good: { tone: "g", title: "Связь хорошая", text: "Подходит для игр и видеозвонков." },
  warning: { tone: "o", title: "Связь нестабильна", text: "Игры и видеозвонки могут подвисать." },
  bad: { tone: "r", title: "Связь плохая", text: "Страницы и видео могут грузиться с трудом." },
  unavailable: { tone: "n", title: "Проверка недоступна", text: "Команда ping на роутере не запускается." },
};

const tierOf = (kind, value) => PING_TIERS[kind].tiers.find((tier) => value <= tier.max);

function tile(kind, title, value, unit, caption) {
  const number = toNumber(value);
  if (number == null) {
    return `<div class="xkt-tile" data-tile="${kind}"><span class="xkt-tile-h">${title}</span><b class="xkt-tile-v">—</b><span class="xkt-tile-s n">нет данных</span><span class="xkt-meter"><i style="width:0"></i></span></div>`;
  }
  const tier = tierOf(kind, number);
  const width = Math.max(number > 0 ? 3 : 0, percentWidth(number, 0, PING_TIERS[kind].scale));
  return `<div class="xkt-tile" data-tile="${kind}"><span class="xkt-tile-h">${title}</span><b class="xkt-tile-v">${num(number, kind === "loss" ? 0 : number < 10 ? 1 : 0)} <small>${unit}</small></b><span class="xkt-tile-s ${tier.tone}">${caption || tier.word}</span><span class="xkt-meter ${tier.tone}"><i style="width:${width.toFixed(1)}%"></i></span></div>`;
}

// The slowest stretch: the biggest rise of latency between two answering hops.
export function slowestStretch(hops) {
  let previous = { number: 0, latency: 0 };
  let best = null;
  for (const hop of hops) {
    if (!hop.responded || toNumber(hop.latency_ms) == null) continue;
    const rise = hop.latency_ms - previous.latency;
    if (!best || rise > best.rise) best = { from: previous.number, to: hop.number, rise };
    previous = { number: hop.number, latency: hop.latency_ms };
  }
  return best;
}

function hopName(hop, index, count, target) {
  if (index === 0) return "роутер";
  if (index === 1 && count > 2) return "провайдер";
  if (index === count - 1 || hop.address === target) return "цель";
  return "";
}

function routeHtml(payload, target) {
  const hops = Array.isArray(payload.trace_hops) ? payload.trace_hops : [];
  if (!hops.length) {
    return `<div class="xkt-route-h"><b>${esc(payload.trace_summary || "Маршрут")}</b></div><div class="xkt-route-note">${esc(payload.trace_note || "")}</div>`;
  }
  const stretch = slowestStretch(hops);
  let title = `Маршрут до ${esc(target)} · ${hops.length} ${nodesWord(hops.length)}`;
  if (stretch && stretch.rise >= 1) {
    title += stretch.from ? ` · самый медленный участок — между узлами ${stretch.from} и ${stretch.to} (+${num(stretch.rise, stretch.rise < 10 ? 1 : 0)}${NBSP}мс)` : ` · самый медленный участок — до узла ${stretch.to} (+${num(stretch.rise, stretch.rise < 10 ? 1 : 0)}${NBSP}мс)`;
  }
  const nodes = hops.map((hop, index) => {
    const silent = !hop.responded;
    const latency = toNumber(hop.latency_ms);
    const tone = latency == null ? "g" : HOP_TIERS.find((tier) => latency <= tier.max).tone;
    const slow = stretch && stretch.to === hop.number && stretch.rise >= 1 && hops.length > 2;
    const width = latency == null ? 0 : Math.max(3, percentWidth(latency, 0, HOP_SCALE_MS));
    const name = hopName(hop, index, hops.length, target);
    return `<div class="xkt-hop${silent ? " silent" : ""}${slow ? " slow" : ""}" data-hop="${esc(hop.number)}">
      <span class="xkt-hop-c ${silent ? "" : tone}">${esc(hop.number)}</span>
      <span class="xkt-hop-n">${esc(name)}</span>
      ${silent ? '<b class="xkt-hop-a dim">не отвечает</b><span class="xkt-hop-l dim">это нормально</span>' : `<b class="xkt-hop-a">${esc(hop.address || "узел ответил")}</b><span class="xkt-hop-l ${tone}">${latency == null ? "ответ получен" : `${num(latency, latency < 10 ? 1 : 0)}${NBSP}мс`}</span>`}
      <span class="xkt-meter ${silent ? "" : tone}"><i style="width:${silent ? 0 : width.toFixed(1)}%"></i></span>
    </div>`;
  }).join("");
  return `<div class="xkt-route-h"><b>${title}</b></div><div class="xkt-route-line" style="--hops:${hops.length}">${nodes}</div>`;
}

function nodesWord(count) {
  const last = count % 10;
  const tens = count % 100;
  if (last === 1 && tens !== 11) return "узел";
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return "узла";
  return "узлов";
}

export function createPingTab(panel, ctx) {
  const state = { busy: false, trace: true, gateway: "", result: null };

  panel.innerHTML = `<div class="xkt-ping-form">
      <label class="xkt-field"><span>Адрес или имя сайта</span><input class="xkt-input" data-role="target" value="1.1.1.1" maxlength="253" autocomplete="off" spellcheck="false"></label>
      <div class="xkt-quick-wrap"><span class="xkt-cap">Быстрый выбор</span><span class="xkt-quick-row">${QUICK_TARGETS.map((t) => `<button type="button" class="xkt-btn xkt-quick" data-quick="${t}">${t}</button>`).join("")}<button type="button" class="xkt-btn xkt-quick" data-quick="gateway">шлюз провайдера</button></span></div>
      <label class="xkt-check"><input type="checkbox" data-role="trace" checked><span>Показать маршрут</span></label>
      <button type="button" class="xkt-btn xkt-primary" data-act="run">Проверить</button>
    </div>
    <div class="xkt-ping-status" data-role="status" role="status"></div>
    <div class="xkt-tiles" data-role="tiles" hidden></div>
    <div class="xkt-route" data-role="route" hidden></div>
    <details class="xkt-tech" data-role="tech" hidden><summary>Технические детали</summary><pre data-role="raw"></pre></details>`;
  const target = panel.querySelector('[data-role="target"]');
  const trace = panel.querySelector('[data-role="trace"]');
  const status = panel.querySelector('[data-role="status"]');
  const tiles = panel.querySelector('[data-role="tiles"]');
  const route = panel.querySelector('[data-role="route"]');
  const tech = panel.querySelector('[data-role="tech"]');
  const raw = panel.querySelector('[data-role="raw"]');
  const run = panel.querySelector('[data-act="run"]');

  function paint(payload, checkedTarget) {
    const unavailable = !payload?.available && payload?.state === "unavailable";
    const verdict = VERDICTS[unavailable ? "unavailable" : payload?.state] || VERDICTS.bad;
    const sent = toNumber(payload?.sent);
    const received = toNumber(payload?.received);
    const lossCaption = sent != null && received != null && payload?.loss_percent === 0 ? `${received} из ${sent} ответов` : null;
    tiles.hidden = false;
    tiles.innerHTML = `${tile("latency", "Задержка", payload?.latency_ms, "мс")}${tile("jitter", "Разброс задержки", payload?.jitter_ms, "мс")}${tile("loss", "Потери", payload?.loss_percent, "%", lossCaption)}
      <div class="xkt-tile xkt-verdict ${verdict.tone}" data-tile="verdict"><b class="xkt-verdict-t">${esc(verdict.title)}</b><span>${esc(unavailable && payload?.error ? payload.error : verdict.text)}</span><small>${esc(checkedTarget)} · проверено в ${esc(clockText(payload?.sampled_at))}</small></div>`;
    if (state.trace && (payload?.trace_hops || payload?.trace_summary)) {
      route.hidden = false;
      route.innerHTML = routeHtml(payload, checkedTarget);
      const hop2 = (payload.trace_hops || [])[1];
      if (hop2?.responded && hop2.address) state.gateway = hop2.address;
    } else {
      route.hidden = true;
      route.innerHTML = "";
    }
    tech.hidden = !payload?.trace;
    raw.textContent = payload?.trace || "";
    status.textContent = "";
  }

  async function check() {
    if (state.busy) return;
    const address = target.value.trim() || "1.1.1.1";
    state.trace = trace.checked;
    state.busy = true;
    run.disabled = true;
    run.textContent = "Проверка…";
    status.textContent = `Проверяем ${address}…`;
    const signal = ctx.signal();
    try {
      const { ok, data } = await requestJson(`${CHANNEL_ENDPOINT}?target=${encodeURIComponent(address)}&trace=${state.trace ? "1" : "0"}`, { signal, timeoutMs: CHECK_TIMEOUT_MS });
      if (isAborted(signal)) return;
      if (!ok) throw new Error("HTTP");
      state.result = data;
      paint(data, address);
    } catch (error) {
      if (isAborted(signal)) return;
      status.textContent = "Проверка канала не выполнена. Повторите ещё раз.";
    } finally {
      state.busy = false;
      run.disabled = false;
      run.textContent = "Проверить";
    }
  }

  panel.addEventListener("click", (event) => {
    const quick = event.target.closest?.("[data-quick]")?.dataset.quick;
    if (quick) {
      const address = quick === "gateway" ? (ctx.snapshot().router?.internet?.gateway_address || state.gateway) : quick;
      if (address) {
        target.value = address;
        status.textContent = "";
      } else {
        status.textContent = "Адрес шлюза провайдера пока неизвестен: выполните проверку с маршрутом, второй узел и есть шлюз.";
      }
      return;
    }
    if (event.target.closest?.('[data-act="run"]')) void check();
  });
  target.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void check();
  });

  return {
    // the check starts only on the button: showing the tab costs no request
    load() {},
    update() {},
    reset() {
      state.result = null;
      state.gateway = "";
      state.busy = false;
      tiles.hidden = true;
      tiles.innerHTML = "";
      route.hidden = true;
      route.innerHTML = "";
      tech.hidden = true;
      status.textContent = "";
      run.disabled = false;
      run.textContent = "Проверить";
    },
  };
}
