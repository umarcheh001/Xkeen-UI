(() => {
  "use strict";

  // Badge under global auto-restart checkbox.
  // Shows last load/save time and the active config file depending on the selected core:
  //   - xray   -> 05_routing.json (routing file)
  //   - mihomo -> config.yaml
  // Public API (back-compat):
  //   window.updateLastActivity(kind, source, filePath?)

  const STORAGE_KEY = "xkeen_last_activity_v2";

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
    const files = (window.XKEEN_FILES && typeof window.XKEEN_FILES === "object") ? window.XKEEN_FILES : {};
    if (core === "mihomo") return files.mihomo || "/opt/etc/mihomo/config.yaml";
    // default to routing file for xray
    return files.routing || "/opt/etc/xray/configs/05_routing.json";
  }

  function effectiveLabel(payload) {
    // Requirement: show 05_routing.json OR config.yaml depending on selected core.
    const core = currentCore();
    const p = coreFile(core);
    const b = basename(p);
    if (b) return b;
    // Fallbacks
    return basename(payload && payload.filePath) || (payload && payload.source) || "";
  }

  function render(payload) {
    const el = $("last-load");
    if (!el || !payload) return;

    const label = effectiveLabel(payload);
    const t = payload.ts ? fmtTime(payload.ts) : "";

    // Reset state classes
    el.classList.remove("last-load-loaded", "last-load-saved", "last-load-error");
    if (payload.kind === "loaded") el.classList.add("last-load-loaded");
    else if (payload.kind === "saved") el.classList.add("last-load-saved");
    else if (payload.kind === "error") el.classList.add("last-load-error");

    if (!label) {
      el.textContent = "";
      return;
    }

    if (payload.kind === "loaded") el.textContent = `Загружено ${label}${t ? " в " + t : ""}`;
    else if (payload.kind === "saved") el.textContent = `Сохранено ${label}${t ? " в " + t : ""}`;
    else if (payload.kind === "error") el.textContent = `Ошибка ${label}${t ? " в " + t : ""}`;
    else el.textContent = `${label}${t ? " в " + t : ""}`;
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

  function init() {
    const stored = readStored();
    if (stored) render(stored);

    // Re-render when core changes (service_status updates data-core)
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
