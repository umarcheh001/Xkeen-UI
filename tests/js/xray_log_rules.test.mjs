import test from 'node:test';
import assert from 'node:assert/strict';
import { createXrayLogDomainIndex, createXrayLogDiagnosticQueue } from '../../xkeen-ui/static/js/features/xray_log_rules.js';
import { parseXrayAccessLine } from '../../xkeen-ui/static/js/features/xray_log_parser.js';

const line = (id, text, module = 'app/dispatcher') => `2026/11/14 17:00:00.000000 [Info] [${id}] ${module}: ${text}`;
const access = (source = '192.168.10.2:53000', target = 'tcp:203.0.113.7:443', out = 'proxy') => parseXrayAccessLine(`2026/11/14 17:00:00.001000 from ${source} accepted ${target} [redirect -> ${out}]`);
function setup() {
  let clock = 0;
  const index = createXrayLogDomainIndex({ now: () => clock });
  return { index, advance(ms = 2500) { clock += ms; index.complete(); } };
}
function session(index, id = 1, source = '192.168.10.2:53000', domain = 'example.org', out = 'proxy') {
  index.ingest(line(id, `received request for ${source}`, 'proxy/dokodemo'));
  index.ingest(line(id, `Hit route rule: [debug-rule] so taking detour [${out}] for [tcp:${domain}:443]`));
}
const tunnel = (index, id = 1, target = 'tcp:203.0.113.7:443') => index.ingest(line(id, `tunneling request to ${target} via 198.51.100.10:443`, 'proxy/vless/outbound'));

test('diagnostic index confirms domains after settle and no longer exposes rule lookup', () => {
  const { index, advance } = setup();
  assert.equal(index.lookup, undefined);
  session(index); tunnel(index);
  assert.equal(index.lookupDomain(access()), '');
  advance(1999);
  assert.equal(index.lookupDomain(access()), '');
  advance(1);
  assert.equal(index.lookupDomain(access()), 'example.org');
  assert.equal(index.lookupDomain(access(undefined, undefined, 'other')), '');
});

test('routeOnly domain needs explicit original target, never a transport upstream', () => {
  const { index, advance } = setup();
  session(index);
  index.ingest(line(1, 'dialing TCP to tcp:203.0.113.7:443', 'transport/internet/tcp'));
  advance();
  assert.equal(index.lookupDomain(access()), '');
  tunnel(index); advance();
  assert.equal(index.lookupDomain(access()), 'example.org');
  assert.equal(index.lookupDomain(access(undefined, 'tcp:198.51.100.10:443')), '');
});

test('direct freedom target is accepted, not its local/remote endpoints', () => {
  const { index, advance } = setup();
  session(index, 1, undefined, 'example.org', 'direct');
  index.ingest(line(1, 'connection opened to tcp:203.0.113.7:443, local endpoint 192.168.10.1:55000, remote endpoint 203.0.113.8:443', 'proxy/freedom'));
  advance();
  assert.equal(index.lookupDomain(access(undefined, undefined, 'direct')), 'example.org');
  assert.equal(index.lookupDomain(access(undefined, 'tcp:203.0.113.8:443', 'direct')), '');
  assert.equal(index.lookupDomain(access(undefined, 'tcp:192.168.10.1:55000', 'direct')), '');
});

test('untagged routing messages still confirm a domain', () => {
  const { index, advance } = setup();
  index.ingest(line(1, 'received request for 192.168.10.2:53000', 'proxy/dokodemo'));
  index.ingest(line(1, 'taking detour [proxy] for [tcp:example.org:443]'));
  tunnel(index); advance();
  assert.equal(index.lookupDomain(access()), 'example.org');
});

test('untrusted modules and malformed or IP route targets cannot supply domains', () => {
  const { index, advance } = setup();
  index.ingest(line(1, 'received request for 192.168.10.2:53000', 'proxy/dokodemo'));
  index.ingest(line(1, 'taking detour [proxy] for [tcp:wrong.example:443]', 'proxy/freedom'));
  tunnel(index); advance();
  assert.equal(index.lookupDomain(access()), '');
  session(index, 2, undefined, '203.0.113.7'); advance();
  assert.equal(index.lookupDomain(access()), '');
});

test('sessions on shared IP keep separate domains and reused tuples become ambiguous', () => {
  const { index, advance } = setup();
  session(index); tunnel(index);
  session(index, 2, '192.168.10.2:53001', 'other.example'); tunnel(index, 2); advance();
  assert.equal(index.lookupDomain(access()), 'example.org');
  assert.equal(index.lookupDomain(access('192.168.10.2:53001')), 'other.example');
  session(index, 3, undefined, 'third.example'); tunnel(index, 3); advance();
  assert.equal(index.lookupDomain(access(), 'example.org'), '');
});

test('IPv6 UDP endpoints preserve protocol and bracket boundaries', () => {
  const { index, advance } = setup();
  index.ingest(line(1, 'received request for [2001:db8::2]:53000', 'proxy/dokodemo'));
  index.ingest(line(1, 'taking detour [proxy] for [udp:example.org:443]'));
  tunnel(index, 1, 'udp:[2001:db8::7]:443'); advance();
  assert.equal(index.lookupDomain(access('[2001:db8::2]:53000', 'udp:[2001:db8::7]:443')), 'example.org');
});

test('invalid timestamps, reset and distant access rows never match', () => {
  const { index, advance } = setup();
  session(index); tunnel(index); advance();
  assert.equal(index.lookupDomain({ ...access(), date: '2026/99/99' }), '');
  assert.equal(index.lookupDomain({ ...access(), time: '17:00:10' }), '');
  index.reset();
  assert.equal(index.lookupDomain(access()), '');
});

test('TTL keeps previous proof but does not permit a new confirmation', () => {
  const { index, advance } = setup();
  session(index); tunnel(index); advance(); advance(30001);
  assert.equal(index.lookupDomain(access(), 'example.org'), 'example.org');
  assert.equal(index.lookupDomain(access()), '');
});

test('eviction and invalid oversized endpoints fail closed', () => {
  const { index, advance } = setup();
  for (let n = 0; n < 2050; n++) {
    session(index, n + 1, `192.168.10.2:${10000 + n}`); tunnel(index, n + 1);
  }
  advance();
  assert.equal(index.lookupDomain(access('192.168.10.2:10000')), '');
  assert.equal(index.lookupDomain(access('192.168.10.2:12049')), '');
  session(index, 3000, undefined, 'a'.repeat(2048)); advance();
  assert.equal(index.lookupDomain(access()), '');
});

test('one endpoint with many destinations does not scan unrelated sessions', () => {
  let clock = 0, checks = 0;
  const index = createXrayLogDomainIndex({ now: () => { checks++; return clock; } });
  for (let n = 0; n < 1800; n++) session(index, n + 1, undefined, `host${n}.example`);
  clock = 2500; index.complete(); checks = 0;
  assert.equal(index.lookupDomain(access(undefined, 'tcp:host1799.example:443')), 'host1799.example');
  assert(checks < 8);
});

test('diagnostic queue yields and cancels obsolete work', () => {
  const tasks = new Map(); let id = 0, clock = 0;
  const consumed = [], completed = [];
  const queue = createXrayLogDiagnosticQueue({ consume: row => { consumed.push(row); clock++; },
    onComplete: meta => completed.push(meta), schedule: fn => { tasks.set(++id, fn); return id; },
    cancel: key => tasks.delete(key), now: () => clock });
  queue.push(Array.from({ length: 300 }, (_, n) => n), { caught_up: true });
  const tick = () => { const [key, fn] = tasks.entries().next().value; tasks.delete(key); fn(); };
  tick(); assert(consumed.length > 0 && consumed.length < 300); assert.equal(completed.length, 0);
  while (tasks.size) tick();
  assert.equal(consumed.length, 300); assert.equal(completed.length, 1);
  queue.push(['obsolete']); queue.reset(); assert.equal(tasks.size, 0);
});
