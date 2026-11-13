// Text of one Mihomo log row for the clipboard: the original line (copy raw)
// or a tab-separated table. The last column always carries the original
// message, so a system error or a DNS answer is not lost in a table copy.
const TSV_COLUMNS = 10;

const cell = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ");

export function mihomoLogRowText(record, tsv = false) {
  const r = record || {};
  if (!tsv) return String(r.raw ?? "");
  const columns = [
    r.time,
    r.sourceIp,
    r.destination,
    r.group,
    r.node,
    r.rule,
    r.destinationPort,
    r.network,
    r.level,
    r.raw,
  ];
  return columns
    .slice(0, TSV_COLUMNS)
    .map(cell)
    .join("\t");
}

export { TSV_COLUMNS };
