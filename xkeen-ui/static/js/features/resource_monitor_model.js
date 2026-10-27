// Pure, bounded observability helpers. No timers, storage, or router requests.
export function metricNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function nearestPointIndex(points, at) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].at < at) low = middle + 1;
    else high = middle;
  }
  return low > 0 && at - points[low - 1].at < points[low].at - at ? low - 1 : low;
}

export function selectClients(payload, showAll) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const top = Array.isArray(payload?.top) ? payload.top : items;
  return (showAll ? items : top).slice(0, showAll ? 100 : 5);
}

export function resourceHealth(payload, dnsDiagnostics) {
  const internet = payload?.router?.internet;
  const conntrack = payload?.router?.conntrack;
  const dnsError = (dnsDiagnostics || internet?.dns_diagnostics)?.state === "error";
  const issues = [];
  let severity = 0;
  for (const [label, value] of [
    ["CPU", payload?.cpu?.percent],
    ["RAM", payload?.memory?.percent],
    ["Диск", payload?.storage?.total_bytes ? payload?.storage?.percent : null],
    ["Conntrack", conntrack?.available ? conntrack.percent : null],
  ]) {
    const number = metricNumber(value);
    if (number !== null && number >= 75) {
      issues.push(`${label} ${number.toFixed(1)}%`);
      severity = Math.max(severity, number >= 90 ? 2 : 1);
    }
  }
  if (internet?.available) {
    for (const [key, label] of [
      ["internet", "Интернет недоступен"],
      ["gateway", "Шлюз недоступен"],
      ["dns", "DNS недоступен"],
      ["captive", "Требуется авторизация сети"],
    ]) {
      // Router normalization exposes captive=true when no portal intercepts.
      if (internet[key] === false) { issues.push(label); severity = 2; }
    }
  }
  if (dnsError) { issues.push("Ошибка DoH/DoT"); severity = 2; }
  const incomplete = metricNumber(payload?.cpu?.percent) === null ||
    metricNumber(payload?.memory?.percent) === null ||
    !internet?.available ||
    ["internet", "gateway", "dns", "captive"].some((key) => typeof internet?.[key] !== "boolean") ||
    payload?.router?.freshness?.state === "stale";
  return {
    tone: severity === 2 ? "danger" : severity === 1 ? "warning" : incomplete ? "unknown" : "normal",
    title: dnsError ? "Проблема с зашифрованным DNS" : severity ? "Требуется внимание" : incomplete ? "Телеметрия неполная" : "Система в норме",
    note: issues.join(" · ") || (incomplete ? "Часть проверок недоступна или устарела — это не подтверждение исправности" : "Критических сигналов не обнаружено"),
  };
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
