import { parseMihomoLogEntry } from "./log_parser.js";

export const MIHOMO_ROUTE_LABELS = Object.freeze({
  proxy: "Через прокси",
  direct: "Напрямую",
  block: "Заблокировано",
  dns: "DNS",
});

export function createMihomoLogModel({ limit = 500 } = {}) {
  let records = [],
    frozen = null,
    nextId = 0,
    pending = 0,
    evictedWhilePaused = 0;
  let order = "newest",
    anchor = null;
  let filters = {
    query: "",
    kinds: ["proxy", "direct", "block"],
    level: "all",
    node: "",
    device: "",
    domain: "",
  };
  const selected = new Set();
  const source = () => frozen || records;
  function visible() {
    const needle = filters.query.trim().toLocaleLowerCase("ru");
    const result = source().filter(
      (r) =>
        (!r.kind || filters.kinds.includes(r.kind)) &&
        (filters.level === "all" || r.level === filters.level) &&
        (!needle || r.search.includes(needle)) &&
        (!filters.node ||
          (r.node || (r.kind === "proxy" ? r.group : "")) === filters.node) &&
        (!filters.device || r.sourceIp === filters.device) &&
        (!filters.domain || r.destination === filters.domain),
    );
    return order === "newest" ? result.reverse() : result;
  }
  function pruneSelection() {
    const ids = new Set(source().map((r) => r.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    if (!ids.has(anchor)) anchor = null;
  }
  function snapshot() {
    const shown = visible();
    const counts = { proxy: 0, direct: 0, block: 0, dns: 0, messages: 0 };
    const nodes = new Map(),
      devices = new Map(),
      domains = new Map();
    const add = (map, key) => {
      if (key) map.set(key, (map.get(key) || 0) + 1);
    };
    for (const r of source()) {
      if (r.kind) counts[r.kind] += 1;
      else counts.messages += 1;
    }
    const kinds = { proxy: 0, direct: 0, block: 0 };
    let total = 0;
    for (const r of shown) {
      if (r.type !== "connection" || !r.kind) continue;
      total += 1;
      kinds[r.kind] += 1;
      if (r.kind === "proxy") add(nodes, r.node || r.group);
      add(devices, r.sourceIp);
      add(domains, r.destination);
    }
    return {
      records: source().slice(),
      buffered: records.length,
      visible: shown,
      counts,
      summary: { total, kinds, nodes, devices, domains },
      selected: [...selected],
      pending,
      evictedWhilePaused,
      order,
      paused: !!frozen,
      filters: { ...filters, kinds: [...filters.kinds] },
    };
  }
  return {
    append(dto) {
      const r = parseMihomoLogEntry(dto, ++nextId);
      records.push(r);
      if (frozen) pending += 1;
      if (records.length > limit) {
        const n = records.length - limit;
        records.splice(0, n);
        if (frozen) evictedWhilePaused += n;
      }
      if (!frozen) pruneSelection();
      return r;
    },
    clear() {
      records = [];
      if (frozen) frozen = [];
      pending = 0;
      evictedWhilePaused = 0;
      selected.clear();
      anchor = null;
    },
    setPaused(paused) {
      if (paused && !frozen) {
        frozen = records.slice();
        pending = 0;
        evictedWhilePaused = 0;
      }
      if (!paused && frozen) {
        frozen = null;
        pending = 0;
        evictedWhilePaused = 0;
        pruneSelection();
      }
    },
    setFilters(patch) {
      filters = { ...filters, ...patch };
    },
    setOrder(value) {
      order = value === "oldest" ? "oldest" : "newest";
    },
    select(id, { toggle = false, range = false, all = false } = {}) {
      const rows = visible();
      if (all) {
        for (const r of rows) selected.add(r.id);
        return;
      }
      if (range && anchor !== null) {
        const a = rows.findIndex((r) => r.id === anchor),
          b = rows.findIndex((r) => r.id === id);
        if (a >= 0 && b >= 0)
          for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1))
            selected.add(r.id);
      } else if (toggle) {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        anchor = id;
      } else {
        selected.clear();
        selected.add(id);
        anchor = id;
      }
    },
    clearSelection() {
      selected.clear();
      anchor = null;
    },
    snapshot,
  };
}
