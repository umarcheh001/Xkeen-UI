const DOMAIN_MIN_TLD_LEN = 2;
const DOMAIN_EXCLUDES = new Set([
  'access.log',
  'error.log',
  'localhost',
]);

function stripTrailingDomainPunctuation(value) {
  return String(value || '').replace(/[)\],;'"`]+$/g, '').replace(/\.+$/g, '');
}

export function normalizeXrayLogDomain(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  value = value.split(/[/?#]/, 1)[0] || '';
  value = stripTrailingDomainPunctuation(value);

  if (value.startsWith('[') && value.endsWith(']')) return '';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return '';

  const portMatch = value.match(/^(.+):(\d{1,5})$/);
  if (portMatch && portMatch[1] && !portMatch[1].includes(':')) {
    value = portMatch[1];
  }

  value = value.toLowerCase();
  if (!value || DOMAIN_EXCLUDES.has(value)) return '';
  if (value.length > 253) return '';
  if (value.includes('..')) return '';

  const labels = value.split('.');
  if (labels.length < 2) return '';
  const tld = labels[labels.length - 1] || '';
  if (tld.length < DOMAIN_MIN_TLD_LEN) return '';
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)) return '';

  for (const label of labels) {
    if (!label || label.length > 63) return '';
    if (label.startsWith('-') || label.endsWith('-')) return '';
    if (!/^[a-z0-9-]+$/.test(label)) return '';
  }

  return value;
}

export function normalizeXrayLogIp(raw) {
  const value = String(raw || '').trim();
  const parts = value.split('.');
  if (parts.length !== 4) return '';

  const normalized = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return '';
    const n = parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return '';
    normalized.push(String(n));
  }

  return normalized.join('.');
}

function normalizePort(raw) {
  if (raw == null || raw === '') return '';
  if (!/^\d{1,5}$/.test(String(raw))) return '';
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return '';
  return String(n);
}

function addDestination(out, ipRaw, portRaw, kind) {
  const ip = normalizeXrayLogIp(ipRaw);
  if (!ip) return;
  const port = normalizePort(portRaw);
  out.push({
    ip,
    port,
    key: port ? `${ip}:${port}` : ip,
    kind: String(kind || ''),
  });
}

export function collectXrayLogDestinationIpPorts(line) {
  const s = String(line || '');
  if (!s) return [];

  const out = [];
  const patterns = [
    { re: /\baccepted\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?/gi, kind: 'accepted' },
    { re: /\btunneling request to\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?/gi, kind: 'tunnel' },
    { re: /\bprocessing from\s+(?:tcp|udp):\S+\s+to\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?/gi, kind: 'processing' },
    { re: /\bdialing\s+(?:tcp|udp)\s+to\s+(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?/gi, kind: 'dial' },
    { re: /\bfor\s+\[(?:tcp|udp):((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?\]/gi, kind: 'route' },
  ];

  const seen = new Set();
  for (const item of patterns) {
    item.re.lastIndex = 0;
    let m;
    while ((m = item.re.exec(s))) {
      const beforeLen = out.length;
      addDestination(out, m[1], m[2], item.kind);
      if (out.length > beforeLen) {
        const key = out[out.length - 1].key;
        if (seen.has(key)) out.pop();
        else seen.add(key);
      }
    }
  }

  return out;
}

function addDomainCandidate(out, seen, raw, source) {
  const domain = normalizeXrayLogDomain(raw);
  if (!domain || seen.has(domain)) return;
  seen.add(domain);
  out.push({ domain, source: String(source || '') });
}

function isXrayOutboundEndpointDialLine(line) {
  const s = String(line || '');
  return /\btransport\/internet\/[A-Za-z0-9_.-]+:\s+dialing\s+(?:tcp|udp)\s+to\s+(?:tcp|udp):/i.test(s);
}

export function collectXrayLogDomainCandidates(line) {
  const s = String(line || '');
  if (!s) return [];

  const out = [];
  const seen = new Set();

  const sniffed = s.match(/\bsniffed domain:\s*([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?=$|[\s,\]])/i);
  if (sniffed && sniffed[1]) addDomainCandidate(out, seen, sniffed[1], 'sniffed');

  if (isXrayOutboundEndpointDialLine(s)) return out;

  const domainTargets = [
    /\b(?:accepted|to|for)\s+\[(?:tcp|udp):([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?::\d{1,5})?\]/gi,
    /\b(?:accepted|to|for)\s+(?:tcp|udp):([A-Za-z0-9.-]+\.[A-Za-z0-9-]+)(?::\d{1,5})?/gi,
  ];

  for (const re of domainTargets) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m[1]) addDomainCandidate(out, seen, m[1], 'destination');
    }
  }

  return out;
}

export function extractXrayLogConnectionId(line) {
  const s = String(line || '');
  const m = s.match(/\[(?:debug|info|warning|error)\]\s+\[([0-9]{3,})\]/i);
  return m && m[1] ? String(m[1]) : '';
}
