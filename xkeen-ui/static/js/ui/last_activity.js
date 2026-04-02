import { getXkeenFilePath } from '../features/xkeen_runtime.js';

(() => {
  "use strict";

  // Compact header chip for last load/save activity.
  // Shows the active config file depending on the selected core:
  //   - xray   -> 05_routing.json (routing file)
  //   - mihomo -> config.yaml
  // Public API (back-compat):
  //   window.updateLastActivity(kind, source, filePath?)

  const STORAGE_KEY = "xkeen_last_activity_v2";
  const COLLAPSE_KEY = "xkeen_last_activity_chip_collapsed_v1";

  function $(id) {
    return document.getElementById(id);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function basename(p) {
    if (!p) return "";
    return String(p).split(/[\\/]/).pop();
  }

  function currentCore() {
    const el = $("xkeen-core-text");
    const core = el && el.dataset ? String(el.dataset.core || "") : "";
    return core === "mihomo" ? "mihomo" : core === "xray" ? "xray" : "";
  }

  function coreFile(core) {
    if (core === "mihomo") return getXkeenFilePath('mihomo', "/opt/etc/mihomo/config.yaml");
    // default to routing file for xray
    return getXkeenFilePath('routing', "/opt/etc/xray/configs/05_routing.json");
  }

  function effectiveLabel(payload) {
    const core = currentCore();
    const p = coreFile(core);
    const b = basename(p);
    if (b) return b;
    return basename(payload && payload.filePath) || (payload && payload.source) || "";
  }

  function readCollapsed() {
    try {
      if (!window.localStorage) return true;
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw == null) return true;
      return raw !== "0";
    } catch (_) {
      return true;
    }
  }

  function writeCollapsed(value) {
    try {
      if (!window.localStorage) return;
      localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
    } catch (_) {}
  }

  function ensureStructure(el) {
    if (!el || el.dataset.lastActivityReady === "1") return el;

    el.innerHTML =
      '<span class="last-load-chip__icon" aria-hidden="true"></span>' +
      '<span class="last-load-chip__body">' +
        '<span class="last-load-chip__prefix"></span>' +
        '<span class="last-load-chip__text"></span>' +
      "</span>" +
      '<span class="last-load-chip__caret" aria-hidden="true"></span>';

    el.dataset.lastActivityReady = "1";
    return el;
  }

  function setCollapsed(el, collapsed) {
    if (!el) return;
    el.classList.toggle("is-collapsed", !!collapsed);
    el.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function fullText(kind, label, timeText) {
    if (kind === "loaded") return `Загружено ${label}${timeText ? " в " + timeText : ""}`;
    if (kind === "saved") return `Сохранено ${label}${timeText ? " в " + timeText : ""}`;
    if (kind === "error") return `Ошибка ${label}${timeText ? " в " + timeText : ""}`;
    return `${label}${timeText ? " в " + timeText : ""}`;
  }

  function prefixText(kind) {
    if (kind === "loaded") return "Загружено";
    if (kind === "saved") return "Сохранено";
    if (kind === "error") return "Ошибка";
    return "Активно";
  }

  function detailText(label, timeText) {
    if (!timeText) return label;
    return `${label} · ${timeText}`;
  }

  function render(payload) {
    const rawEl = $("last-load");
    if (!rawEl || !payload) return;

    const el = ensureStructure(rawEl);

    const label = effectiveLabel(payload);
    const t = payload.ts ? fmtTime(payload.ts) : "";
    const message = fullText(payload.kind, label, t);
    const prefix = prefixText(payload.kind);
    const detail = detailText(label, t);

    el.classList.remove("last-load-loaded", "last-load-saved", "last-load-error");
    if (payload.kind === "loaded") el.classList.add("last-load-loaded");
    else if (payload.kind === "saved") el.classList.add("last-load-saved");
    else if (payload.kind === "error") el.classList.add("last-load-error");

    if (!label) {
      el.classList.add("hidden");
      el.title = "";
      el.setAttribute("aria-label", "Последняя операция с конфигом");
      return;
    }

    el.classList.remove("hidden");
    el.dataset.kind = String(payload.kind || "info");
    el.title = message;
    el.setAttribute("aria-label", message);

    const prefixEl = el.querySelector(".last-load-chip__prefix");
    const textEl = el.querySelector(".last-load-chip__text");
    if (prefixEl) prefixEl.textContent = prefix;
    if (textEl) textEl.textContent = detail;
  }

  function readStored() {
    try {
      const raw = window.localStorage ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      return obj;
    } catch (_) {
      return null;
    }
  }

  function writeStored(payload) {
    try {
      if (!window.localStorage) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function updateLastActivity(kind, source, filePath) {
    const payload = {
      kind: String(kind || "info"),
      source: String(source || ""),
      filePath: filePath ? String(filePath) : "",
      ts: Date.now(),
    };
    writeStored(payload);
    render(payload);
  }

  // Back-compat global
  if (typeof window.updateLastActivity !== "function") {
    window.updateLastActivity = updateLastActivity;
  }

  function bindChip() {
    const el = $("last-load");
    if (!el || el.dataset.lastActivityBound === "1") return;

    ensureStructure(el);
    setCollapsed(el, readCollapsed());

    el.addEventListener("click", () => {
      const next = !el.classList.contains("is-collapsed");
      setCollapsed(el, next);
      writeCollapsed(next);
    });

    el.dataset.lastActivityBound = "1";
  }

  function init() {
    bindChip();

    const stored = readStored();
    if (stored) render(stored);

    const coreEl = $("xkeen-core-text");
    if (coreEl && window.MutationObserver) {
      const mo = new MutationObserver(() => {
        const p = readStored();
        if (p) render(p);
      });
      mo.observe(coreEl, { attributes: true, attributeFilter: ["data-core"] });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
