// Tab "Процессы": top of the router's processes by processor or memory.

import { NBSP, bytesText, clockText, esc, num, percentWidth, processNote, toNumber } from "./tools_format.js";
import { isAborted, requestJson } from "./tools_net.js";

const PROCESS_ENDPOINT = "/api/system/processes";
const SHOWN = 24;

const note = (item) => processNote(item.name);

export function createProcsTab(panel, ctx) {
  const state = { payload: null, sort: "cpu", loading: false, error: false };
  panel.innerHTML = `<div class="xkt-bar"><span class="xkt-lead" data-role="lead">Загрузка списка процессов…</span><span class="xkt-actions"><span class="xkt-seg" role="group" aria-label="Сортировка"><button type="button" class="xkt-btn" data-sort="cpu" aria-pressed="true">По процессору</button><button type="button" class="xkt-btn" data-sort="memory" aria-pressed="false">По памяти</button></span><button type="button" class="xkt-btn" data-act="refresh">Обновить</button></span></div><div data-role="body"></div>`;
  const lead = panel.querySelector('[data-role="lead"]');
  const body = panel.querySelector('[data-role="body"]');
  const refresh = panel.querySelector('[data-act="refresh"]');

  function paint() {
    for (const button of panel.querySelectorAll("[data-sort]")) button.setAttribute("aria-pressed", button.dataset.sort === state.sort ? "true" : "false");
    if (state.error || !state.payload) {
      if (state.error) lead.textContent = "Не удалось получить процессы. Проверьте доступ RCI и повторите.";
      body.innerHTML = "";
      return;
    }
    const all = Array.isArray(state.payload.items) ? state.payload.items : [];
    const useful = all.filter((item) => Number(item.cpu_percent || 0) > 0 || Number(item.memory_bytes || 0) > 0 || String(item.service || "").trim());
    const pool = (useful.length ? useful : all).slice();
    const key = state.sort === "memory" ? (item) => Number(item.memory_bytes || 0) : (item) => Number(item.cpu_percent || 0);
    pool.sort((a, b) => key(b) - key(a));
    const items = pool.slice(0, SHOWN);
    const sampled = clockText(state.payload.sampled_at, true);
    lead.textContent = items.length
      ? `Топ по нагрузке на ${state.sort === "memory" ? "память" : "процессор"} · снято в ${sampled}`
      : "Роутер не вернул процессов.";
    if (!items.length) {
      body.innerHTML = "";
      return;
    }
    const topCpu = Math.max(1, ...items.map((item) => Number(item.cpu_percent || 0)));
    const rows = items.map((item) => {
      const cpu = toNumber(item.cpu_percent);
      const text = note(item) || item.service || "";
      return `<div class="xkt-row xkt-pr-cols" role="row">
        <div class="xkt-c xkt-ident"><b>${esc(item.name || "process")}</b><small>${esc(text)}</small></div>
        <div class="xkt-c xkt-cpu"><span class="xkt-meter"><i style="width:${Math.max(cpu ? 3 : 0, percentWidth(cpu, 0, Math.max(topCpu, 10))).toFixed(1)}%"></i></span><span class="xkt-num">${cpu == null ? "—" : `${num(cpu, 1)}${NBSP}%`}</span></div>
        <div class="xkt-c xkt-num">${esc(bytesText(item.memory_bytes))}</div>
        <div class="xkt-c xkt-num">${esc(item.threads || "—")}</div>
        <div class="xkt-c xkt-num">${esc(item.pid || "—")}</div>
      </div>`;
    }).join("");
    body.innerHTML = `<div role="table" aria-label="Процессы"><div class="xkt-head xkt-pr-cols" role="row"><div>Процесс</div><div>Процессор</div><div>Память</div><div>Потоки</div><div>PID</div></div>${rows}</div>`;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    refresh.disabled = true;
    if (!state.payload) lead.textContent = "Загрузка списка процессов…";
    const signal = ctx.signal();
    try {
      const { ok, data } = await requestJson(PROCESS_ENDPOINT, { signal });
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
    const sort = event.target.closest?.("[data-sort]")?.dataset.sort;
    if (sort) {
      state.sort = sort === "memory" ? "memory" : "cpu";
      paint();
      return;
    }
    if (event.target.closest?.('[data-act="refresh"]')) void load();
  });

  return {
    load,
    update() {},
    reset() {
      state.payload = null;
      state.sort = "cpu";
      state.error = false;
      state.loading = false;
      body.innerHTML = "";
      lead.textContent = "Загрузка списка процессов…";
    },
  };
}
