import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../xkeen-ui/static/js/features/xray_log_rules.js';
import { parseXrayAccessLine } from '../../xkeen-ui/static/js/features/xray_log_parser.js';

const access = (port = '53000', target = '203.0.113.7', proto = 'tcp') => parseXrayAccessLine(`2026/11/14 17:00:00.500000 from 192.168.10.2:${port} accepted ${proto}:${target}:443 [redirect -> block]`);
const event = (id = 1, overrides = {}) => ({ id, stamp: Date.UTC(2026, 10, 14, 17), srcIp: '192.168.10.2', srcPort: '53000',
  host: '203.0.113.7', port: '443', proto: 'tcp', inTag: 'redirect', outTag: 'block', tag: 'ads', domain: 'ads.example', ...overrides });
function setup() {
  let clock = 0;
  const index = api.createXrayRoutingEventIndex({ now: () => clock });
  index.begin({ generation: 'one', since: 0, dropped: 0, events: [] });
  return { index, advance(ms = 2500) { clock += ms; } };
}

test('webhook confirms blocked domain and rule only after settle, using the full tuple', () => {
  const { index, advance } = setup();
  index.ingest(event());
  assert.equal(index.lookup(access()), '');
  advance();
  assert.equal(index.lookup(access()), 'ads');
  assert.equal(index.lookupDomain(access()), 'ads.example');
  assert.equal(index.lookup(access('53001')), '');
  assert.equal(index.lookup({ ...access(), inTag: 'other' }), '');
  assert.equal(index.lookup({ ...access(), outTag: 'direct' }), '');
  assert.equal(index.lookup(access(undefined, undefined, 'udp')), '');
  assert.equal(index.lookup({ ...access(), mark: '>>' }), '');
});

test('duplicate deliveries do not create ambiguity but a second connection does', () => {
  const { index, advance } = setup();
  index.ingest(event()); index.ingest(event()); advance();
  assert.equal(index.lookup(access()), 'ads');
  index.ingest(event(2, { tag: 'other' })); advance();
  assert.equal(index.lookup(access(), 'ads'), '');
});

test('generation cutoff prevents assigning new events to pre-restart access rows', () => {
  const { index, advance } = setup();
  index.begin({ generation: 'two', since: event().stamp + 700, dropped: 0, events: [] });
  index.ingest(event()); advance();
  assert.equal(index.lookup(access(), 'old'), '');
  assert.equal(index.lookup({ ...access(), frac: '.800000' }), 'ads');
});

test('timestamp mismatch and dropped events cannot preserve a false confirmation', () => {
  const { index, advance } = setup();
  index.ingest(event()); advance();
  assert.equal(index.lookup({ ...access(), time: '17:00:10' }), '');
  index.begin({ generation: 'one', since: 0, dropped: 1, events: [event(2)] });
  index.ingest(event(2)); advance();
  assert.equal(index.lookup(access(), 'ads'), '');
});

test('IPv6 UDP addresses are canonicalized on both sides', () => {
  const { index, advance } = setup();
  index.ingest(event(1, { host: '2001:db8::7', proto: 'udp' })); advance();
  assert.equal(index.lookup(access(undefined, '[2001:0db8::7]', 'udp')), 'ads');
});

test('expiry preserves known metadata but cannot confirm a new row; memory is bounded', () => {
  const { index, advance } = setup();
  index.ingest(event()); advance();
  assert.equal(index.lookup(access()), 'ads');
  advance(30001);
  assert.equal(index.lookup(access(), 'ads'), 'ads');
  assert.equal(index.lookup(access()), '');
  for (let n = 2; n < 2052; n++) index.ingest(event(n, { srcPort: String(10000 + n) }));
  advance();
  assert.equal(index.lookup(access('10002')), '');
  assert.equal(index.lookup(access('12051')), '');
});

test('malformed and oversized server metadata is rejected without poisoning candidates', () => {
  const { index, advance } = setup();
  for (const row of [event(1, { host: 'a'.repeat(2048) }), event(2, { tag: 'a'.repeat(2048) }), event(3, { stamp: NaN })]) index.ingest(row);
  advance();
  assert.equal(index.lookup(access()), '');
});

test('expiry cannot turn an ambiguous pair into a newly confirmed survivor', () => {
  const { index, advance } = setup();
  index.ingest(event());
  advance(1000);
  index.ingest(event(2, { tag: 'other' }));
  advance(2500);
  assert.equal(index.lookup(access()), '');
  advance(27000);
  assert.equal(index.lookup(access()), '');
});

test('loss with an empty batch blocks cached tags and later survivors in that generation', () => {
  const { index, advance } = setup();
  index.ingest(event()); advance();
  assert.equal(index.lookup(access()), 'ads');
  index.begin({ generation: 'one', since: 0, dropped: 1, events: [] });
  assert.equal(index.lookup(access(), 'ads'), '');
  index.ingest(event(2)); advance();
  assert.equal(index.lookup(access()), '');
  index.begin({ generation: 'two', since: 0, dropped: 0, events: [] });
  index.ingest(event(3)); advance();
  assert.equal(index.lookup(access()), 'ads');
});

test('a fresh browser respects server expiry even when it never saw the lost candidate', () => {
  const { index, advance } = setup();
  index.begin({ generation: 'one', since: 0, dropped: 0, expired_until: event().stamp + 2000, events: [event(2)] });
  index.ingest(event(2)); advance();
  assert.equal(index.lookup(access()), '');
});

test('ring eviction of already received events is not a loss at a sustained 500 per second', () => {
  const { index, advance } = setup();
  const batch = (start, end) => Array.from({ length: end - start + 1 }, (_, n) => event(start + n, { srcPort: String(10000 + start + n), stamp: event().stamp + (start + n) * 2 }));
  const first = index.begin({ generation: 'one', since: 0, first_id: 1, dropped: 0, events: batch(1, 1250) });
  first.events.forEach(index.ingest);
  advance();
  const second = index.begin({ generation: 'one', since: 0, first_id: 1, dropped: 452, events: batch(453, 2500) });
  second.events.forEach(index.ingest);
  advance();
  assert.equal(index.lookup({ ...access('12500'), time: '17:00:05', frac: '.000000' }), 'ads');
});

test('successive 500-per-second polls can confirm settled flows despite unrelated client evictions', () => {
  const { index, advance } = setup();
  for (let round = 1; round <= 4; round++) {
    advance();
    const end = round * 1250;
    const start = Math.max(1, end - 2047);
    const events = Array.from({ length: end - start + 1 }, (_, n) => event(start + n, {
      srcPort: String(10000 + start + n), stamp: event().stamp + (start + n) * 2,
    }));
    index.begin({ generation: 'one', since: 0, first_id: 1, dropped: Math.max(0, end - 2048), events }).events.forEach(index.ingest);
    if (round > 1) {
      const id = end - 1250;
      const p = { ...access(String(10000 + id)), time: `17:00:${String(id * 2 / 1000).split('.')[0].padStart(2, '0')}`,
        frac: id * 2 % 1000 ? '.500000' : '.000000' };
      assert.equal(index.lookup(p), 'ads');
    }
  }
});

test('client eviction cannot turn two matching connections into a confirmed survivor', () => {
  const { index, advance } = setup();
  index.ingest(event(1));
  index.ingest(event(2, { tag: 'other' }));
  for (let n = 3; n <= 2049; n++) index.ingest(event(n, { srcPort: String(10000 + n) }));
  advance();
  assert.equal(index.lookup(access()), '');
});

test('tag delimiters cannot make different inbound/outbound tuples collide', () => {
  const { index, advance } = setup();
  index.ingest(event(1, { inTag: 'a|b', outTag: 'c' })); advance();
  assert.equal(index.lookup({ ...access(), inTag: 'a', outTag: 'b|c' }), '');
  assert.equal(index.lookup({ ...access(), inTag: 'a|b', outTag: 'c' }), 'ads');
});
