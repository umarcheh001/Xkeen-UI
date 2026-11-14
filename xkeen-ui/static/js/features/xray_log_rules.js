import { parseXrayErrorLine } from './xray_log_parser.js';

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

export function createXrayLogRuleIndex({ now = Date.now } = {}) {
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
    if (!line.includes('received request for ') && !line.includes('detour [') && !line.includes('tunneling request to ')) return;
    const p = parseXrayErrorLine(line);
    if (!p?.session || !Number.isFinite(timestamp(p))) return;
    const source = p.module === 'proxy/dokodemo' && /^received request for (.+)$/.exec(p.message);
    const hit = p.module === 'app/dispatcher' && /^(?:Hit route rule: \[(.*)\] so )?taking detour \[(.*?)\] for \[((?:tcp|udp):.+)\]$/.exec(p.message);
    const tunnel = /^(?:proxy\/(?:vless|vmess)\/outbound|proxy\/(?:trojan|shadowsocks))$/.test(p.module)
      && /^tunneling request to ((?:tcp|udp):\S+) via /.exec(p.message);
    if (!source && !hit && !tunnel) return;
    let item = sessions.get(p.session);
    if (!item) {
      item = { created: now(), seen: now(), source: '', proto: '', out: '', tag: '', targets: new Set(), stamp: timestamp(p), conflict: false, ready: false, baseKey: '', keys: new Set() };
      sessions.set(p.session, item);
      prune();
    }
    if (source) {
      const value = endpoint(source[1]);
      if (item.source && item.source !== value) item.conflict = true;
      item.source = value;
    }
    if (hit) {
      const dest = destination(hit[3]);
      if (!dest) return;
      const tag = hit[1] || '';
      if (tag.length > 1024) { item.conflict = true; return; }
      if (item.proto && (item.tag !== tag || item.out !== hit[2] || item.proto !== dest.proto)) item.conflict = true;
      Object.assign(item, { tag, out: hit[2], proto: dest.proto, stamp: timestamp(p), seen: now(), ready: false });
      if (item.targets.size < 4) item.targets.add(dest.target);
      else if (!item.targets.has(dest.target)) item.conflict = true;
    }
    if (tunnel) {
      const dest = destination(tunnel[1]);
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
  function lookup(p, previous = '') {
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
      if (match || !item.ready || item.conflict || !item.tag) return '';
      match = item;
    }
    if (match && previous && match.tag !== previous) return '';
    return match?.tag || previous;
  }
  return { ingest, complete, lookup, reset() { sessions.clear(); buckets.clear(); lostUntil = expiredUntil = -Infinity; } };
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
