// Tab "События": the week's journal kept by the router-side collector
// (GET /api/system/events?since=). Filter "Все / Только проблемы"; "проблема" is an
// event with severity "problem", the same ones the status line counts.

import { clockText, durationText, esc, finite } from "./tools_format.js";
import { isAborted, requestJson } from "./tools_net.js";

const EVENTS_ENDPOINT = "/api/system/events";
const WEEK_S = 7 * 24 * 3600;
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function whenText(at, nowMs) {
  const date = new Date(at * 1000);
  const now = new Date(nowMs);
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86400000);
  const time = clockText(at);
  if (days <= 0) return time;
  if (days === 1) return `вчера ${time}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

// Closed event: how long it lasted; open one: how long it goes on. A moment has no length.
export function lengthText(event, nowSeconds) {
  if (event.until != null && event.until === event.at) return "";
  if (event.until == null) {
    const text = durationText(nowSeconds - event.at);
    return text ? `идёт ${text}` : "";
  }
  const text = durationText(event.until - event.at);
  return text ? `длилось ${text}` : "";
}

export function createEventsTab(panel, ctx) {
  const state = { events: null, filter: "all", only: null, loading: false, error: false, nowMs: 0 };
  panel.innerHTML = `<div class="xkt-bar"><span class="xkt-lead">За последнюю неделю · хранятся на роутере</span><span class="xkt-actions"><span class="xkt-seg" role="group" aria-label="Фильтр событий"><button type="button" class="xkt-btn" data-filter="all" aria-pressed="true">Все</button><button type="button" class="xkt-btn" data-filter="problems" aria-pressed="false">Только проблемы</button></span></span></div><div class="xkt-chips" data-role="chips" hidden></div><div data-role="body" class="xkt-events"></div>`;
  const body = panel.querySelector('[data-role="body"]');
  const chips = panel.querySelector('[data-role="chips"]');

  function paint() {
    for (const button of panel.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", button.dataset.filter === state.filter ? "true" : "false");
    chips.hidden = !state.only;
    chips.innerHTML = state.only ? '<span class="xkt-chip">Только сбои DNS <button type="button" data-act="clear-only" aria-label="Показать все события">показать все события</button></span>' : "";
    if (state.error) {
      body.innerHTML = '<div class="xkt-empty">Не удалось загрузить журнал событий. <button type="button" class="xkt-btn" data-act="retry">Повторить</button></div>';
      return;
    }
    if (!state.events) {
      body.innerHTML = '<div class="xkt-empty">Загрузка журнала…</div>';
      return;
    }
    let list = state.events.slice().sort((a, b) => b.at - a.at);
    if (state.only) list = list.filter((event) => event.type === state.only);
    if (state.filter === "problems") list = list.filter((event) => event.severity === "problem");
    if (!list.length) {
      body.innerHTML = `<div class="xkt-empty">${state.filter === "problems" || state.only ? "Проблем за неделю не было." : "Пока без событий."}</div>`;
      return;
    }
    const nowSeconds = state.nowMs / 1000;
    body.innerHTML = list.map((event) => {
      const length = lengthText(event, nowSeconds);
      return `<div class="xkt-ev" data-severity="${esc(event.severity)}" data-type="${esc(event.type)}">
        <span class="xkt-ev-t">${esc(whenText(event.at, state.nowMs))}</span>
        <span class="xkt-ev-d ${esc(event.severity)}"></span>
        <div class="xkt-ev-m"><b>${esc(event.title)}</b>${event.detail ? `<small>${esc(event.detail)}</small>` : ""}</div>
        <span class="xkt-ev-l">${esc(length)}</span>
      </div>`;
    }).join("");
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.nowMs = Date.now();
    const signal = ctx.signal();
    try {
      const since = Math.floor(state.nowMs / 1000) - WEEK_S;
      const { ok, data } = await requestJson(`${EVENTS_ENDPOINT}?since=${since}`, { signal });
      if (isAborted(signal)) return;
      if (!ok || data?.ok === false || !Array.isArray(data?.events)) throw new Error("HTTP");
      state.events = data.events.filter((event) => event && finite(event.at));
      state.error = false;
    } catch (error) {
      if (isAborted(signal)) return;
      state.error = true;
    } finally {
      state.loading = false;
    }
    paint();
  }

  panel.addEventListener("click", (event) => {
    const filter = event.target.closest?.("[data-filter]")?.dataset.filter;
    if (filter) {
      state.filter = filter === "problems" ? "problems" : "all";
      paint();
      return;
    }
    const act = event.target.closest?.("[data-act]")?.dataset.act;
    if (act === "clear-only") {
      state.only = null;
      paint();
    } else if (act === "retry") {
      void load();
    }
  });

  return {
    load,
    update() {},
    // the connection chain's "Журнал ошибок DNS" link: the journal narrowed to DNS failures
    focusType(type) {
      state.only = type;
      state.filter = "all";
      paint();
    },
    reset() {
      state.events = null;
      state.filter = "all";
      state.only = null;
      state.error = false;
      state.loading = false;
      paint();
    },
  };
}
