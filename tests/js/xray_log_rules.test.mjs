import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXrayAccessLine } from '../../xkeen-ui/static/js/features/xray_log_parser.js';
const api = await import('../../xkeen-ui/static/js/features/xray_log_rules.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const errorLine = (id, text, module = 'app/dispatcher') => `2026/11/14 17:00:00.000000 [Info] [${id}] ${module}: ${text}`;
const access = (source = '192.168.10.2:53000', target = 'tcp:example.org:443', out = 'proxy') => parseXrayAccessLine(`2026/11/14 17:00:00.001000 from ${source} accepted ${target} [redirect -> ${out}]`);
function setup() {
  assert.equal(typeof api.createXrayLogRuleIndex, 'function');
  let now = 0;
  const index = api.createXrayLogRuleIndex({ now: () => now });
  return { index, advance(ms = 2500) { now += ms; index.complete(); } };
}
function session(index, id, source, tag, target = 'tcp:example.org:443', out = 'proxy') {
  index.ingest(errorLine(id, `received request for ${source}`, 'proxy/dokodemo'));
  index.ingest(errorLine(id, tag ? `Hit route rule: [${tag}] so taking detour [${out}] for [${target}]` : `taking detour [${out}] for [${target}]`));
}

test('rule is confirmed only after the diagnostic settle window', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'youtube');
  assert.equal(index.lookup(access()), '');
  advance();
  assert.equal(index.lookup(access()), 'youtube');
  assert.equal(index.lookup(access(undefined, undefined, 'other')), '');
});

test('interleaved sessions on the same outbound keep their own tags', () => {
  const { index, advance } = setup();
  session(index, 2, '192.168.10.3:53001', 'telegram');
  session(index, 1, '192.168.10.2:53000', 'youtube');
  advance();
  assert.equal(index.lookup(access()), 'youtube');
  assert.equal(index.lookup(access('192.168.10.3:53001')), 'telegram');
});

test('late second candidate makes a reused endpoint ambiguous', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'first');
  advance();
  assert.equal(index.lookup(access()), 'first');
  session(index, 2, '192.168.10.2:53000', 'second');
  assert.equal(index.lookup(access()), '');
  advance();
  assert.equal(index.lookup(access()), '');
});

test('untagged and incomplete sessions never borrow a tag', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', '');
  index.ingest(errorLine(2, 'Hit route rule: [other] so taking detour [proxy] for [tcp:example.org:443]'));
  advance();
  assert.equal(index.lookup(access()), '');
});

test('sniffed routeOnly domain matches the explicit proxy tunnel target', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'youtube');
  index.ingest(errorLine(1, 'tunneling request to tcp:203.0.113.7:443 via 198.51.100.10:443', 'proxy/vless/outbound'));
  advance();
  assert.equal(index.lookup(access(undefined, 'tcp:203.0.113.7:443')), 'youtube');
  assert.equal(index.lookup(access(undefined, 'tcp:203.0.113.8:443')), '');
});

test('IPv6 UDP endpoints are matched without confusing bracket boundaries', () => {
  const { index, advance } = setup();
  session(index, 1, '[2001:db8::2]:53000', 'udp6', 'udp:[2001:db8::7]:443');
  advance();
  assert.equal(index.lookup(access('[2001:db8::2]:53000', 'udp:[2001:db8::7]:443')), 'udp6');
});

test('timestamps outside two seconds and reset never reuse old sessions', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'old');
  advance();
  const p = access();
  p.time = '17:00:10';
  assert.equal(index.lookup(p), '');
  index.reset();
  assert.equal(index.lookup(access()), '');
});

test('session cache is bounded and expired entries cannot resolve a row', () => {
  const { index, advance } = setup();
  for (let n = 0; n < 2050; n++) session(index, n + 1, `192.168.10.2:${10000 + n}`, `rule-${n}`);
  advance();
  assert.equal(index.lookup(access('192.168.10.2:10000')), '');
  assert.equal(index.lookup(access('192.168.10.2:12049')), '');
  advance(30001);
  assert.equal(index.lookup(access('192.168.10.2:12049')), '');
});

test('transport dialing to the proxy server is never an access destination alias', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'youtube');
  index.ingest(errorLine(1, 'dialing TCP to tcp:198.51.100.10:443', 'transport/internet/tcp'));
  advance();
  assert.equal(index.lookup(access(undefined, 'tcp:198.51.100.10:443')), '');
});

test('oversized endpoints cannot expand the bounded session index', () => {
  const { index, advance } = setup();
  const host = `${'a'.repeat(2048)}.example`;
  session(index, 1, '192.168.10.2:53000', 'oversized', `tcp:${host}:443`);
  advance();
  assert.equal(index.lookup(access(undefined, `tcp:${host}:443`)), '');
});

test('eviction does not turn two conflicting candidates into a confirmed survivor', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'first');
  session(index, 2, '192.168.10.2:53000', 'second');
  advance();
  assert.equal(index.lookup(access()), '');
  for (let n = 3; n <= 2049; n++) session(index, n, `192.168.10.3:${10000 + n}`, 'noise');
  advance();
  assert.equal(index.lookup(access()), '');
});

test('rule text may contain brackets but an untrusted module cannot forge a hit', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'test[<img>]');
  index.ingest(errorLine(2, 'received request for 192.168.10.3:53000', 'proxy/dokodemo'));
  index.ingest(errorLine(2, 'Hit route rule: [wrong] so taking detour [proxy] for [tcp:example.org:443]', 'proxy/freedom'));
  advance();
  assert.equal(index.lookup(access()), 'test[<img>]');
  assert.equal(index.lookup(access('192.168.10.3:53000')), '');
});

test('expiry preserves an already assigned tag but ambiguity revokes it', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'confirmed');
  advance();
  const tag = index.lookup(access());
  advance(30001);
  assert.equal(index.lookup(access(), tag), 'confirmed');
  session(index, 2, '192.168.10.2:53000', 'other');
  advance();
  assert.equal(index.lookup(access(), tag), '');
});

test('malformed access timestamp cannot match a session', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'confirmed');
  advance();
  const p = access(); p.date = '2026/99/99';
  assert.equal(index.lookup(p), '');
});

test('invalid diagnostic targets cannot bypass the session memory limit', () => {
  const { index, advance } = setup();
  session(index, 1, '192.168.10.2:53000', 'confirmed');
  advance();
  for (let n = 2; n < 2052; n++) index.ingest(errorLine(n, 'Hit route rule: [bad] so taking detour [proxy] for [tcp:bad-target]'));
  assert.equal(index.lookup(access()), '');
});

test('one endpoint with many destinations does not scan unrelated sessions per lookup', () => {
  let clock = 0, checks = 0;
  const index = api.createXrayLogRuleIndex({ now: () => { checks++; return clock; } });
  for (let n = 0; n < 1800; n++) session(index, n + 1, '192.168.10.2:53000', `rule-${n}`, `tcp:host${n}.example:443`);
  clock = 2500; index.complete(); checks = 0;
  assert.equal(index.lookup(access(undefined, 'tcp:host1799.example:443')), 'rule-1799');
  assert(checks < 8, `Lookup inspected ${checks} unrelated sessions`);
});

test('diagnostic queue yields, completes after consume and cancels obsolete work', () => {
  assert.equal(typeof api.createXrayLogDiagnosticQueue, 'function');
  const tasks = new Map(); let next = 0; let clock = 0;
  const consumed = [], completed = [];
  const queue = api.createXrayLogDiagnosticQueue({
    consume: line => { consumed.push(line); clock++; }, onComplete: meta => completed.push(meta),
    schedule: fn => { tasks.set(++next, fn); return next; }, cancel: id => tasks.delete(id), now: () => clock,
  });
  const tick = () => { const [id, fn] = tasks.entries().next().value; tasks.delete(id); fn(); };
  queue.push(Array.from({ length: 300 }, (_, n) => `line-${n}`), { caught_up: true });
  assert.equal(consumed.length, 0);
  tick();
  assert(consumed.length > 0 && consumed.length < 300);
  assert.equal(completed.length, 0);
  while (tasks.size) tick();
  assert.equal(consumed.length, 300);
  assert.equal(completed.length, 1);
  queue.push(['obsolete'], {});
  queue.reset();
  assert.equal(tasks.size, 0);
  assert.equal(consumed.at(-1), 'line-299');
});
