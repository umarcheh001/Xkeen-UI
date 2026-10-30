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
  const state = { events: null, exceptions: [], showExceptions: false, filter: "all", only: null, loading: false, reloadPending: false, actionBusy: false, error: false, actionError: "", nowMs: 0 };
  panel.innerHTML = `<div class="xkt-bar"><span class="xkt-lead">За последнюю неделю · хранятся на роутере</span><span class="xkt-actions"><span class="xkt-seg" role="group" aria-label="Фильтр событий"><button type="button" class="xkt-btn" data-filter="all" aria-pressed="true">Все</button><button type="button" class="xkt-btn" data-filter="problems" aria-pressed="false">Только проблемы</button></span></span></div><div class="xkt-chips" data-role="chips" hidden></div><div data-role="body" class="xkt-events"></div>`;
  const body = panel.querySelector('[data-role="body"]');
  const chips = panel.querySelector('[data-role="chips"]');
  panel.querySelector('.xkt-actions').insertAdjacentHTML('beforeend', '<button type="button" class="xkt-btn" data-act="exceptions">Исключения</button>');
  panel.querySelector('.xkt-bar').insertAdjacentHTML('afterend', '<div data-role="exceptions" hidden></div><div data-role="action-error" class="xkt-note" role="alert" hidden></div>');
  const exceptions = panel.querySelector('[data-role="exceptions"]');
  const actionError = panel.querySelector('[data-role="action-error"]');

  const labels = { port_slow: 'Порт работает на 100 Мбит/с', dns_failed: 'Не отвечает DNS', internet_lost: 'Связь с интернетом потеряна', overheat: 'Перегрев', cpu_overload: 'Процессор перегружен', memory_low: 'Память занята', link_saturated: 'Канал забит', cpu_throttled: 'Процессор замедлился из-за нагрева', wan_failover: 'Интернет переключился на резервное подключение' };
  const sourceLabel = (type, key) => !key ? 'все источники' : type === 'port_slow' ? `порт ${key}` : ({ 'temp:cpu': 'процессор', 'temp:soc': 'главный чип', 'temp:npu': 'сетевой ускоритель', 'temp:ports': 'порты и коммутатор', 'temp:wifi24': 'Wi-Fi 2,4 ГГц', 'temp:wifi5': 'Wi-Fi 5 ГГц', cpu: 'процессор', memory: 'память' }[key] || key);

  function paint() {
    const toggle = panel.querySelector('[data-act="exceptions"]');
    toggle.textContent = `Исключения${state.exceptions.length ? ` · ${state.exceptions.length}` : ''}`;
    toggle.setAttribute('aria-pressed', String(state.showExceptions));
    exceptions.hidden = !state.showExceptions;
    exceptions.innerHTML = state.showExceptions ? `<div class="xkt-exceptions"><b>Исключения проблем и предупреждений</b><p>Сохраняются на роутере и действуют во всех браузерах. Новые события для исключений не записываются; текущее состояние остаётся в диагностике.</p>${state.exceptions.length ? state.exceptions.map((item, i) => `<div class="xkt-exception"><span><strong>${esc(labels[item.type] || item.type)}</strong> · ${esc(sourceLabel(item.type, item.key))}</span><button type="button" class="xkt-btn" data-restore="${i}">Снова предупреждать</button></div>`).join('') : '<p>Исключений нет.</p>'}</div>` : '';
    actionError.hidden = !state.actionError;
    actionError.textContent = state.actionError;
    if (state.actionError) actionError.insertAdjacentHTML('beforeend', ' <button type="button" class="xkt-btn" data-act="retry-action">Повторить загрузку</button>');
    for (const button of exceptions.querySelectorAll('[data-restore]')) button.disabled = state.actionBusy || !!state.actionError;
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
        <div class="xkt-ev-m"><b>${esc(event.title)}</b>${event.detail ? `<small>${esc(event.detail)}</small>` : ""}${['problem', 'warning'].includes(event.severity) ? `<div class="xkt-event-actions">${event.acknowledged ? '<small>Прочитано</small>' : `<button type="button" class="xkt-btn" data-ack="${esc(event.id)}">Прочитано</button>`}${state.exceptions.some(item => item.type === event.type && (!item.key || item.key === (event.key || ''))) ? '<small>Повторные предупреждения отключены</small>' : `<button type="button" class="xkt-btn" data-exclude="${esc(event.id)}">Не предупреждать повторно</button>`}</div>` : ''}</div>
        <span class="xkt-ev-l">${esc(length)}</span>
      </div>`;
    }).join("");
    for (const button of panel.querySelectorAll('[data-ack], [data-exclude], [data-restore]')) button.disabled = state.actionBusy || !!state.actionError;
  }

  async function load() {
    if (state.loading) { state.reloadPending = true; return; }
    state.loading = true;
    state.nowMs = Date.now();
    const signal = ctx.signal();
    try {
      const since = Math.floor(state.nowMs / 1000) - WEEK_S;
      const { ok, data } = await requestJson(`${EVENTS_ENDPOINT}?since=${since}`, { signal });
      if (isAborted(signal)) return;
      if (!ok || data?.ok === false || !Array.isArray(data?.events)) throw new Error("HTTP");
      state.events = data.events.filter((event) => event && finite(event.at));
      state.exceptions = Array.isArray(data.exceptions) ? data.exceptions.filter(item => item && typeof item.type === 'string' && typeof item.key === 'string') : [];
      state.actionError = data.preferences_available === false ? 'Не удалось прочитать настройки событий. Исключения могут не действовать; изменение настроек недоступно.' : '';
      state.error = false;
    } catch (error) {
      if (isAborted(signal)) return;
      state.error = true;
    } finally {
      state.loading = false;
    }
    paint();
    if (state.reloadPending && !isAborted(signal)) { state.reloadPending = false; void load(); }
  }

  panel.addEventListener("click", (event) => {
    const acknowledge = event.target.closest?.('[data-ack]');
    const exclude = event.target.closest?.('[data-exclude]');
    const restore = event.target.closest?.('[data-restore]');
    if (acknowledge || exclude || restore) {
      if (state.actionBusy || state.actionError) return;
      const item = restore ? state.exceptions[Number(restore.dataset.restore)] : null;
      const selected = exclude ? state.events?.find(e => e.id === exclude.dataset.exclude) : null;
      if (selected && !window.confirm(`Не предупреждать повторно: ${selected.title} · ${sourceLabel(selected.type, selected.key)}? Новые события этого типа для указанного источника записываться не будут.`)) return;
      const payload = acknowledge ? { action: 'acknowledge', id: acknowledge.dataset.ack } : exclude ? { action: 'exclude', id: exclude.dataset.exclude } : { action: 'restore', type: item?.type, key: item?.key };
      state.actionBusy = true;
      paint();
      void (async () => {
        try {
          const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
          const response = await fetch('/api/system/events/action', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(payload), signal: ctx.signal() });
          if (!response.ok) throw new Error('save');
          state.actionError = '';
          await load();
        } catch (error) {
          if (!isAborted(ctx.signal())) { state.actionError = 'Не удалось сохранить настройку события.'; paint(); }
        } finally {
          state.actionBusy = false;
          paint();
        }
      })();
      return;
    }
    const filter = event.target.closest?.("[data-filter]")?.dataset.filter;
    if (filter) {
      state.filter = filter === "problems" ? "problems" : "all";
      paint();
      return;
    }
    const act = event.target.closest?.("[data-act]")?.dataset.act;
    if (act === 'retry-action') {
      void load();
    } else if (act === 'exceptions') {
      state.showExceptions = !state.showExceptions;
      paint();
    } else if (act === "clear-only") {
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
