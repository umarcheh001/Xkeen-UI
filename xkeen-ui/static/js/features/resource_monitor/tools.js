// The tool tabs of the diagnostics window (devices, connection check, interfaces,
// processes, modems, events), full width, each loaded on its first show.
//
//   const tools = mountTools(host, { snapshot })
//   snapshot() -> { router, links, problems }   what the window already knows (summary)
//   tools.show(tab, { scroll, focus, reload })  tab: devices | ping | ifaces | procs | modems | events
//   tools.update()                              the summary changed: counter, modem tab, interfaces
//   tools.refresh()                             reload the open tab (the window's refresh button)
//   tools.reset()                               the window closed: abort, forget, nothing selected
//   tools.destroy()
//
// Nothing is requested before a tab is shown. The tab bodies live in tool_*.js.

import { createDevicesTab } from "./tool_devices.js";
import { createEventsTab } from "./tool_events.js";
import { createIfacesTab } from "./tool_ifaces.js";
import { createModemsTab, hasModems } from "./tool_modems.js";
import { createPingTab } from "./tool_ping.js";
import { createProcsTab } from "./tool_procs.js";

const TABS = [
  { id: "devices", title: "Устройства", create: createDevicesTab },
  { id: "ping", title: "Проверка связи", create: createPingTab },
  { id: "ifaces", title: "Интерфейсы", create: createIfacesTab },
  { id: "procs", title: "Процессы", create: createProcsTab },
  { id: "modems", title: "Модемы", create: createModemsTab },
  { id: "events", title: "События", create: createEventsTab },
];

export function mountTools(host, api = {}) {
  const snapshot = () => (typeof api.snapshot === "function" ? api.snapshot() || {} : {});
  let controller = new AbortController();
  const ctx = { signal: () => controller.signal, snapshot };
  const loaded = new Set();
  let active = null;

  host.innerHTML = `<section class="xkm-panel xkt-root" aria-label="Инструменты диагностики">
    <div class="xkt-top"><div class="xkt-tabs" role="tablist" aria-label="Инструменты">${TABS.map((tab) => `<button type="button" class="xkt-tab" role="tab" id="xkt-tab-${tab.id}" data-tab="${tab.id}" aria-selected="false" aria-controls="xkt-panel-${tab.id}"${tab.id === "modems" ? " hidden" : ""}>${tab.title}${tab.id === "events" ? '<span class="xkt-count" hidden></span>' : ""}</button>`).join("")}</div><span class="xkt-hint">Загружается по нажатию — роутер не нагружается зря</span></div>
    ${TABS.map((tab) => `<div class="xkt-panel" role="tabpanel" id="xkt-panel-${tab.id}" data-panel="${tab.id}" aria-labelledby="xkt-tab-${tab.id}" hidden></div>`).join("")}
  </section>`;
  const tabButton = (id) => host.querySelector(`[data-tab="${id}"]`);
  const panelOf = (id) => host.querySelector(`[data-panel="${id}"]`);
  const counter = host.querySelector(".xkt-count");
  const tabs = {};
  for (const tab of TABS) tabs[tab.id] = tab.create(panelOf(tab.id), ctx);

  function paintActive() {
    for (const tab of TABS) {
      const on = tab.id === active;
      tabButton(tab.id).setAttribute("aria-selected", on ? "true" : "false");
      tabButton(tab.id).tabIndex = on || (!active && tab.id === "devices") ? 0 : -1;
      panelOf(tab.id).hidden = !on;
    }
  }

  function show(id, { scroll = false, focus = null, reload = false } = {}) {
    if (!tabs[id] || tabButton(id).hidden) return false;
    active = id;
    paintActive();
    if (focus && tabs[id].focusType) tabs[id].focusType(focus);
    if (reload || !loaded.has(id)) {
      loaded.add(id);
      void tabs[id].load();
    }
    if (scroll) {
      try {
        host.scrollIntoView({ block: "start", behavior: "smooth" });
      } catch (error) {
        // an old browser without options: the tabs stay where they are
      }
    }
    return true;
  }

  function update() {
    const state = snapshot();
    const modems = hasModems(state);
    tabButton("modems").hidden = !modems;
    if (!modems && active === "modems") {
      active = null;
      paintActive();
    }
    const problems = Number(state.problems) || 0;
    counter.hidden = problems <= 0;
    counter.textContent = problems > 0 ? String(problems) : "";
    tabButton("events").setAttribute("aria-label", problems > 0 ? `События, проблем сейчас: ${problems}` : "События");
    if (active === "ifaces") tabs.ifaces.update();
  }

  host.addEventListener("click", (event) => {
    const id = event.target.closest?.("[data-tab]")?.dataset.tab;
    if (id) show(id);
  });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const current = event.target.closest?.("[data-tab]");
    if (!current) return;
    const visible = TABS.filter((tab) => !tabButton(tab.id).hidden);
    const index = visible.findIndex((tab) => tab.id === current.dataset.tab);
    const next = visible[(index + (event.key === "ArrowRight" ? 1 : -1) + visible.length) % visible.length];
    event.preventDefault();
    show(next.id);
    tabButton(next.id).focus();
  });

  paintActive();
  update();

  return {
    show,
    update,
    refresh() {
      if (!active || active === "ping") return;
      if (active === "ifaces") tabs.ifaces.update();
      else void tabs[active].load();
    },
    reset() {
      controller.abort();
      controller = new AbortController();
      loaded.clear();
      active = null;
      for (const tab of TABS) tabs[tab.id].reset();
      paintActive();
      update();
    },
    activeTab: () => active,
    destroy() {
      controller.abort();
      host.innerHTML = "";
    },
  };
}
