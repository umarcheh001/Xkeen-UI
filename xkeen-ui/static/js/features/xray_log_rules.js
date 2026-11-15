import { parseXrayErrorLine } from './xray_log_parser.js';
import { normalizeXrayLogDomain } from './xray_log_domain_hints.js';

const MAX_SESSIONS = 2048;
const TTL = 30000;
const WINDOW = 2000;

function timestamp(p) {
  return Date.parse(`${p.date.replaceAll('/', '-')}T${p.time}${(p.frac || '').slice(0, 4)}Z`);
}

function endpoint(value) {
  if (value.length > 512) return '';
  const m = /^(?:tcp:|udp:)?(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(value);
  return m ? `${(m[1] || m[2]).toLowerCase()}|${m[3]}` : '';
}

function destination(value) {
  const m = /^(tcp|udp):(.+)$/.exec(value);
  return m && endpoint(m[2]) ? { proto: m[1], target: endpoint(m[2]) } : null;
}

export function createXrayLogDomainIndex({ now = Date.now } = {}) {
  const sessions = new Map();
  const buckets = new Map();
  let lostUntil = -Infinity, expiredUntil = -Infinity;
  function remove(id, item) {
    sessions.delete(id);
    for (const key of item.keys) {
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.delete(id);
        if (!bucket.size) buckets.delete(key);
      }
    }
  }
  function prune() {
    for (const [id, item] of sessions) {
      if (sessions.size <= MAX_SESSIONS && now() - item.created <= TTL) break;
      if (Number.isFinite(item.stamp)) {
        if (sessions.size > MAX_SESSIONS) lostUntil = Math.max(lostUntil, item.stamp + WINDOW);
        else expiredUntil = Math.max(expiredUntil, item.stamp + WINDOW);
      }
      remove(id, item);
    }
  }
  function ingest(line) {
    if (!line.includes('received request for ') && !line.includes('detour [') && !line.includes('tunneling request to ') && !line.includes('connection opened to ')) return;
    const p = parseXrayErrorLine(line);
    if (!p?.session || !Number.isFinite(timestamp(p))) return;
    const source = p.module === 'proxy/dokodemo' && /^received request for (.+)$/.exec(p.message);
    const hit = p.module === 'app/dispatcher' && /^(?:Hit route rule: \[.*\] so )?taking detour \[(.*?)\] for \[((?:tcp|udp):.+)\]$/.exec(p.message);
    const tunnel = /^(?:proxy\/(?:vless|vmess)\/outbound|proxy\/(?:trojan|shadowsocks))$/.test(p.module)
      && /^tunneling request to ((?:tcp|udp):\S+) via /.exec(p.message);
    const direct = p.module === 'proxy/freedom'
      && /^connection opened to ((?:tcp|udp):[^\s,]+), local endpoint /.exec(p.message);
    const target = tunnel || direct;
    if (!source && !hit && !target) return;
    let item = sessions.get(p.session);
    if (!item) {
      item = { created: now(), seen: now(), source: '', proto: '', out: '', domain: '', targets: new Set(), stamp: timestamp(p), conflict: false, ready: false, baseKey: '', keys: new Set() };
      sessions.set(p.session, item);
      prune();
    }
    if (source) {
      const value = endpoint(source[1]);
      if (item.source && item.source !== value) item.conflict = true;
      item.source = value;
    }
    if (hit) {
      const dest = destination(hit[2]);
      if (!dest) return;
      const domain = normalizeXrayLogDomain(dest.target.split('|')[0]);
      if (item.proto && (item.domain !== domain || item.out !== hit[1] || item.proto !== dest.proto)) item.conflict = true;
      Object.assign(item, { domain, out: hit[1], proto: dest.proto, stamp: timestamp(p), seen: now(), ready: false });
      if (item.targets.size < 4) item.targets.add(dest.target);
      else if (!item.targets.has(dest.target)) item.conflict = true;
    }
    if (target) {
      const dest = destination(target[1]);
      if (dest && item.targets.size < 4) item.targets.add(dest.target);
    }
    if (item.source && item.proto && item.out) {
      const base = `${item.source}|${item.proto}|${item.out}`;
      if (item.baseKey && item.baseKey !== base) {
        for (const key of item.keys) {
          const old = buckets.get(key);
          old?.delete(p.session);
          if (old && !old.size) buckets.delete(key);
        }
        item.keys.clear();
      }
      item.baseKey = base;
      for (const target of item.targets) {
        const key = `${base}|${target}`;
        if (item.keys.has(key)) continue;
        item.keys.add(key);
        if (!buckets.has(key)) buckets.set(key, new Set());
        buckets.get(key).add(p.session);
      }
    }
    prune();
  }
  function complete() {
    prune();
    for (const item of sessions.values()) item.ready = now() - item.seen >= WINDOW;
  }
  function lookupDomain(p, previous = '') {
    if (!p || p.mark !== '->') return '';
    const target = `${String(p.host).toLowerCase()}|${p.port}`;
    const bucket = buckets.get(`${String(p.srcIp).toLowerCase()}|${p.srcPort}|${p.proto || 'tcp'}|${p.outTag}|${target}`);
    if (!bucket && lostUntil === -Infinity && expiredUntil === -Infinity) return previous;
    const stamp = timestamp(p);
    if (!Number.isFinite(stamp)) return '';
    if (stamp <= lostUntil || (!previous && stamp <= expiredUntil)) return '';
    if (!bucket) return previous;
    let match = null;
    for (const id of bucket) {
      const item = sessions.get(id);
      if (now() - item.created > TTL || Math.abs(item.stamp - stamp) > WINDOW || !item.targets.has(target)) continue;
      if (match || !item.ready || item.conflict || !item.domain) return '';
      match = item;
    }
    if (match && previous && match.domain !== previous) return '';
    return match?.domain || previous;
  }
  return { ingest, complete, lookupDomain,
    reset() { sessions.clear(); buckets.clear(); lostUntil = expiredUntil = -Infinity; } };
}

function hostKey(value) {
  const host = String(value || '').toLowerCase();
  if (host.length > 512) return '';
  if (!host.includes(':')) return host;
  try { return new URL(`http://[${host}]`).hostname.slice(1, -1); } catch { return ''; }
}

export function createXrayRoutingEventIndex({ now = Date.now } = {}) {
  const items = new Map(), buckets = new Map(), evicted = new Map();
  let generation = '', since = 0, dropped = 0, lastId = 0, coveredId = 0, lostUntil = -Infinity, expiredUntil = -Infinity;
  const key = p => JSON.stringify([hostKey(p.srcIp), p.srcPort, p.proto || 'tcp', p.inTag, p.outTag, hostKey(p.host), p.port]);
  function prune() {
    for (const [id, item] of items) {
      if (items.size <= MAX_SESSIONS && now() - item.received <= TTL) break;
      if (items.size > MAX_SESSIONS) {
        const cutoff = Math.max(evicted.get(item.key) || -Infinity, item.stamp + WINDOW);
        evicted.delete(item.key);
        evicted.set(item.key, cutoff);
        if (evicted.size > MAX_SESSIONS) {
          // Fold old tuple barriers into a global cutoff to keep memory bounded.
          const [oldest, stamp] = evicted.entries().next().value;
          lostUntil = Math.max(lostUntil, stamp);
          evicted.delete(oldest);
        }
      } else expiredUntil = Math.max(expiredUntil, item.stamp + WINDOW);
      items.delete(id);
      const bucket = buckets.get(item.key);
      bucket?.delete(id);
      if (bucket && !bucket.size) buckets.delete(item.key);
    }
  }
  function markLost(stamp) {
    // Without a timestamp barrier, only a new generation can prove a match again.
    lostUntil = Number.isFinite(stamp) ? Math.max(lostUntil, stamp + WINDOW) : Infinity;
    items.clear(); buckets.clear();
  }
  function begin(payload) {
    const reset = generation !== payload.generation;
    if (reset) {
      items.clear(); buckets.clear();
      evicted.clear();
      generation = payload.generation;
      since = Number(payload.since) || 0;
      dropped = lastId = 0; lostUntil = expiredUntil = -Infinity;
      coveredId = Math.max(0, (Number(payload.first_id) || 1) - 1);
    }
    const events = Array.isArray(payload.events) ? payload.events.slice(-MAX_SESSIONS) : [];
    const latestStamp = events.reduce((max, item) => Number.isFinite(item.stamp) ? Math.max(max, item.stamp) : max, -Infinity);
    const next = events.find(item => item.id > coveredId);
    if ((next && next.id > coveredId + 1) || (Number(payload.dropped) > dropped && !events.length)
      || (payload.events?.length || 0) > MAX_SESSIONS) markLost(latestStamp);
    coveredId = events.reduce((max, item) => Number.isSafeInteger(item.id) ? Math.max(max, item.id) : max, coveredId);
    if (Number.isFinite(payload.expired_until)) expiredUntil = Math.max(expiredUntil, payload.expired_until);
    dropped = Number(payload.dropped) || 0;
    return { events: events.filter(item => item.id > lastId), reset, latestStamp };
  }
  function ingest(event) {
    if (!event || !Number.isSafeInteger(event.id) || event.id <= lastId || !Number.isFinite(event.stamp)) return;
    lastId = event.id;
    if (['srcIp', 'srcPort', 'host', 'port', 'inTag', 'outTag', 'tag'].some(field => typeof event[field] !== 'string' || event[field].length > (field === 'tag' ? 1024 : 512))
      || !hostKey(event.host) || !hostKey(event.srcIp) || !['tcp', 'udp'].includes(event.proto)) return;
    const item = { ...event, domain: normalizeXrayLogDomain(event.domain), received: now(), key: key(event) };
    items.set(event.id, item);
    if (!buckets.has(item.key)) buckets.set(item.key, new Set());
    buckets.get(item.key).add(event.id);
    prune();
  }
  function lookup(p, previous = '', field = 'tag') {
    if (!p || p.mark !== '->') return '';
    const stamp = timestamp(p);
    if (!Number.isFinite(stamp) || stamp < since) return '';
    prune();
    if (stamp <= lostUntil || stamp <= (evicted.get(key(p)) ?? -Infinity)) return '';
    if (!previous && stamp <= expiredUntil) return '';
    let match = null;
    for (const id of buckets.get(key(p)) || []) {
      const item = items.get(id);
      if (Math.abs(item.stamp - stamp) > WINDOW) continue;
      if (match || now() - item.received < WINDOW || !item[field]) return '';
      match = item;
    }
    if (match && previous && match[field] !== previous) return '';
    return match?.[field] || previous;
  }
  return { begin, ingest, lookup, markLost,
    lookupDomain(p, previous = '') { return lookup(p, previous, 'domain'); },
    reset() { items.clear(); buckets.clear(); evicted.clear(); generation = ''; since = dropped = lastId = coveredId = 0; lostUntil = expiredUntil = -Infinity; } };
}

export function createXrayLogDiagnosticQueue({ consume, onComplete, onReset = () => {},
  schedule = fn => setTimeout(fn, 0), cancel = clearTimeout, now = () => performance.now() }) {
  let jobs = [], pending = 0, timer = null;
  function reset() {
    if (timer !== null) cancel(timer);
    timer = null;
    jobs = [];
    pending = 0;
  }
  function run() {
    timer = null;
    const start = now();
    let count = 0;
    while (jobs.length && count < 128 && now() - start < 2) {
      const job = jobs[0];
      if (job.offset < job.lines.length) {
        consume(job.lines[job.offset++]);
        pending--;
        count++;
      }
      if (job.offset >= job.lines.length) {
        jobs.shift();
        onComplete(job.meta);
      }
    }
    if (jobs.length) timer = schedule(run);
  }
  function push(lines, meta = {}) {
    if (meta.reset || pending + lines.length > 8192) {
      reset();
      onReset(meta);
    }
    if (lines.length > 8192) {
      onComplete({ reset: true, skipped: true, caught_up: false });
      return;
    }
    jobs.push({ lines, meta, offset: 0 });
    pending += lines.length;
    if (timer === null) timer = schedule(run);
  }
  return { push, reset };
}
