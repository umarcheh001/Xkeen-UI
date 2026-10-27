// Pure, bounded observability helpers. No timers, storage, or router requests.
export function metricNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// The JSON snapshot of the diagnostics window: the summary, the hardware and the
// history columns of the chosen range (GET /api/system/{summary,hardware,history}).
export function buildResourceSnapshot(summary, hardware, history, range, stale) {
  // Explicit allowlist: never export router identifiers, IPs, MACs, clients,
  // logs, process arguments, modem data, provider names, paths, or arbitrary
  // future API fields. Connections are numbered, not named.
  const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, metricNumber(source?.[key])]));
  const column = (metric) => ({
    avg: (metric?.avg || []).map(metricNumber),
    max: (metric?.max || []).map(metricNumber),
  });
  const metrics = history?.metrics || {};
  const links = (history?.links || []).map((link) => ({
    primary: link?.primary === true,
    tariff: link?.tariff ? pick(link.tariff, ["up_mbps", "down_mbps"]) : null,
    up_percent: column(metrics[`link_up:${link?.id}`]),
    down_percent: column(metrics[`link_down:${link?.id}`]),
    up_mbps: column(metrics[`rate_up:${link?.id}`]),
    down_mbps: column(metrics[`rate_down:${link?.id}`]),
  }));
  const cards = summary?.cards || {};
  return {
    schema_version: 2,
    exported_at: new Date().toISOString(),
    sampled_at: metricNumber(summary?.ts),
    range,
    stale: Boolean(stale),
    uptime_seconds: metricNumber(summary?.uptime_s),
    now: {
      cpu_percent: metricNumber(cards.cpu?.value),
      memory_percent: metricNumber(cards.memory?.value),
      memory: pick(cards.memory, ["programs_bytes", "cache_bytes", "free_bytes", "total_bytes"]),
      link: pick(cards.link, ["up_percent", "down_percent", "up_mbps", "down_mbps"]),
    },
    hardware: {
      cores: metricNumber(hardware?.cores),
      temperatures: (hardware?.temperatures || []).map((group) => ({ id: String(group?.id ?? ""), value_c: metricNumber(group?.value_c) })),
      storage: pick(hardware?.storage, ["percent", "total_bytes", "used_bytes", "free_bytes"]),
      conntrack: pick(hardware?.conntrack, ["count", "max", "percent"]),
      zram: pick(hardware?.zram, ["size_bytes", "used_bytes"]),
    },
    history: {
      start: metricNumber(history?.start),
      step_seconds: metricNumber(history?.step_s),
      cpu: column(metrics.cpu),
      memory: column(metrics.memory),
      queue: column(metrics.queue),
      online: column(metrics.online),
      links,
    },
  };
}
