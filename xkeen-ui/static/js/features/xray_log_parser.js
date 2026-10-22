// Parsing of Xray access.log and error.log lines into plain records.
//
// access.log is written by Xray's AccessMessage:
//   <date> <time> from [proto:]<src>:<port> accepted|rejected [proto:]<dst>:<port> [<detour>] [<reason>] [email: <user>]
// where <detour> is "<in> -> <out>" (routing rule), "<in> >> <out>" (default
// route), "<in> ==> <out>" (balancer pick) or a bare outbound tag. Xray's own
// DNS client writes "from DNS accepted ..." without a port. Anything
// that does not fit stays unparsed: the caller keeps the raw line.

const DATE_TIME = '(\\d{4}[/-]\\d{2}[/-]\\d{2})\\s+(\\d{2}:\\d{2}:\\d{2})(\\.\\d+)?';
const ENDPOINT = '(?:(tcp|udp):)?(\\[[0-9A-Fa-f:.%a-z]+\\]|[^\\s\\[\\]]+?):(\\d{1,5})';

const ACCESS_HEAD_RE = new RegExp(`^${DATE_TIME}\\s+from\\s+(?:${ENDPOINT}|([A-Za-z][\\w.-]*))\\s+(accepted|rejected)(?=\\s|$)\\s*(.*)$`);
const ACCESS_DEST_RE = new RegExp(`^${ENDPOINT}(?=\\s|$)\\s*(.*)$`);
const DETOUR_RE = /^\[([^\]]*)\]\s*(.*)$/;
const DETOUR_SPLIT_RE = /\s+(->|>>|==>)\s+/;
const EMAIL_RE = /(?:^|\s)email:\s+(\S+)\s*$/;

const ERROR_RE = new RegExp(`^${DATE_TIME}\\s+\\[(debug|info|warning|warn|error)\\]\\s+(?:\\[(\\d+)\\]\\s+)?(?:([A-Za-z][\\w./-]*):\\s)?(.*)$`, 'i');

const SERVICE_OUTBOUNDS = Object.freeze({
  direct: 'direct',
  freedom: 'direct',
  block: 'block',
  blackhole: 'block',
  reject: 'block',
  dns: 'dns',
  'dns-out': 'dns',
});

function stripBrackets(host) {
  const value = String(host || '');
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function parseDetour(raw) {
  const value = String(raw || '').trim();
  if (!value) return { inTag: '', outTag: '', mark: '' };
  const parts = value.split(DETOUR_SPLIT_RE);
  if (parts.length === 3) return { inTag: parts[0].trim(), mark: parts[1], outTag: parts[2].trim() };
  return { inTag: '', outTag: value, mark: '' };
}

// Route class of an outbound tag: direct, block, dns or proxy.
export function xrayOutboundKind(tag) {
  const value = String(tag || '').trim().toLowerCase();
  if (!value) return '';
  if (SERVICE_OUTBOUNDS[value]) return SERVICE_OUTBOUNDS[value];
  if (/^(?:direct|block|blackhole)(?:[-_]|$)/.test(value)) return value.startsWith('direct') ? 'direct' : 'block';
  return 'proxy';
}

export function parseXrayAccessLine(line) {
  const text = String(line || '').replace(/\r?\n$/, '');
  const head = ACCESS_HEAD_RE.exec(text);
  if (!head) return null;
  const [, date, time, frac, srcProto, srcHost, srcPort, srcName, status, tail] = head;
  const record = {
    date,
    time,
    frac: frac || '',
    srcProto: srcProto || '',
    srcIp: srcName || stripBrackets(srcHost),
    srcPort: srcPort || '',
    status,
    proto: '',
    host: '',
    port: '',
    inTag: '',
    outTag: '',
    mark: '',
    kind: '',
    reason: '',
    email: '',
  };

  let rest = String(tail || '');
  const email = EMAIL_RE.exec(rest);
  if (email) {
    record.email = email[1];
    rest = rest.slice(0, email.index).trim();
  }

  const dest = ACCESS_DEST_RE.exec(rest);
  if (dest) {
    record.proto = dest[1] || '';
    record.host = stripBrackets(dest[2]);
    record.port = dest[3];
    rest = dest[4] || '';
  } else if (status === 'accepted') {
    return null;
  }

  const detour = DETOUR_RE.exec(rest);
  if (detour) {
    Object.assign(record, parseDetour(detour[1]));
    rest = detour[2] || '';
  }
  record.reason = rest.trim();
  record.kind = status === 'rejected' ? 'block' : xrayOutboundKind(record.outTag);
  return record;
}

export function parseXrayErrorLine(line) {
  const text = String(line || '').replace(/\r?\n$/, '');
  const m = ERROR_RE.exec(text);
  if (!m) return null;
  const [, date, time, frac, levelRaw, session, module, message] = m;
  const lower = levelRaw.toLowerCase();
  return {
    date,
    time,
    frac: frac || '',
    level: lower === 'warn' ? 'warning' : lower,
    session: session || '',
    module: module || '',
    message: message || '',
  };
}

// "rr3---sn-4g5e.googlevideo.com" -> "googlevideo.com"; keeps IP addresses as is.
export function xrayRegistrableDomain(host) {
  const value = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!value || value.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;
  const labels = value.split('.');
  if (labels.length <= 2) return value;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const keepThree = tld.length === 2 && /^(?:co|com|net|org|gov|edu|ac|or|ne|go)$/.test(second);
  return labels.slice(keepThree ? -3 : -2).join('.');
}
