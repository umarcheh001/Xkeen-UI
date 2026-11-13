// Grammar: Mihomo v1.19.34 tunnel.logMetadata and dns.Resolver log messages.
// Keep unknown input intact: a port or a name alone never proves a route kind.
function endpoint(value) {
  const match = /^(?:\[([^\]]+)\]|([^\s:]+)):(\d+)(?:\s.*)?$/u.exec(value);
  return match ? { host: match[1] || match[2], port: match[3] } : null;
}

function routeParts(value) {
  if (!value.endsWith("]")) return { group: value, node: "" };
  let depth = 0;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (value[i] === "]") depth += 1;
    if (value[i] === "[") {
      depth -= 1;
      if (!depth)
        return {
          group: value.slice(0, i).trim(),
          node: value.slice(i + 1, -1).trim(),
        };
    }
  }
  return { group: value, node: "" };
}

export function parseMihomoLogEntry(dto = {}, id) {
  const raw = String(dto.message ?? "");
  const record = {
    id,
    raw,
    time: String(dto.time || ""),
    level: String(dto.level || "info").toLowerCase(),
    fields: dto.fields && typeof dto.fields === "object" ? dto.fields : {},
    devices: Array.isArray(dto.devices) ? dto.devices : [],
    type: "message",
    kind: null,
    network: "",
    sourceIp: "",
    sourcePort: "",
    destination: "",
    destinationPort: "",
    group: "",
    node: "",
    rule: "",
    search: "",
  };
  if (/^\[DNS\](?:\s|$)/u.test(raw)) {
    record.type = "dns";
    record.kind = "dns";
  } else {
    const line =
      /^\[(TCP|UDP)\] (.+?) --> (\S+) (?:match (.+?) |doesn't match any rule )?using (.+)$/u.exec(
        raw,
      );
    if (line) {
      const source = endpoint(line[2]);
      const target = endpoint(line[3]);
      if (source && target) {
        const route = routeParts(line[5]);
        const terminal = route.node || route.group;
        Object.assign(record, {
          type: "connection",
          network: line[1].toLowerCase(),
          sourceIp: source.host,
          sourcePort: source.port,
          destination: target.host,
          destinationPort: target.port,
          group: route.group,
          node: route.node,
          rule: line[4] || "",
          kind:
            terminal === "DIRECT"
              ? "direct"
              : /^REJECT(?:-DROP)?$/u.test(terminal)
                ? "block"
                : terminal === "GLOBAL"
                  ? null
                  : "proxy",
        });
      }
    }
  }
  record.search = [
    raw,
    record.level,
    ...Object.entries(record.fields).flat(),
    ...record.devices.flatMap((d) => [d.ip, d.name]),
  ]
    .join(" ")
    .toLocaleLowerCase("ru");
  return record;
}
