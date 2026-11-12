import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const flags = await import('../../xkeen-ui/static/js/ui/country_flags.js');
const outboundsSrc = fs.readFileSync(
  new URL('../../xkeen-ui/static/js/features/outbounds.js', import.meta.url),
  'utf8',
);

test('every known country has its own flag picture', () => {
  const missing = Object.keys(flags.COUNTRY_NAMES).filter((code) => !flags.countryFlag(code).svg);
  assert.deepEqual(missing, []);
});

test('Moldova is recognised and drawn', () => {
  for (const name of ['🇲🇩 Chisinau 01', 'MD-01', 'Moldova Premium']) {
    assert.equal(flags.nodeCountryCode(name), 'MD', name);
  }
  assert.match(flags.countryFlag('MD').svg, /<svg/);
});

test('European Union is recognised, drawn and named in Russian', () => {
  for (const name of ['🇪🇺 Frankfurt', 'EU-Node 3', 'European Union 2']) {
    assert.equal(flags.nodeCountryCode(name), 'EU', name);
  }
  assert.equal(flags.countryFlag('EU').label, 'Европейский союз');
  assert.match(flags.countryFlag('EU').svg, /<svg/);
});

test('a bare word Europe does not become the EU flag', () => {
  assert.equal(flags.nodeCountryCode('Europe Fast 1'), '');
});

test('countries of the former subscriptions dictionary are known everywhere', () => {
  const codes = ['AM', 'AR', 'AT', 'AZ', 'BE', 'BG', 'BY', 'DK', 'GE', 'GR', 'HU', 'IE',
    'MX', 'RO', 'RS', 'SI', 'SK', 'EE', 'GL', 'PT'];
  for (const code of codes) assert.ok(flags.COUNTRY_NAMES[code], code);
});

test('normalizeCountryCode follows aliases and the dictionary', () => {
  assert.equal(flags.normalizeCountryCode('uk'), 'GB');
  assert.equal(flags.normalizeCountryCode('md'), 'MD');
  assert.equal(flags.normalizeCountryCode('ZZ'), '');
});

test('the subscriptions window takes flags from the shared dictionary', () => {
  assert.match(outboundsSrc, /from 'xk-core\/js\/ui\/country_flags\.js'/);
  assert.doesNotMatch(outboundsSrc, /<svg/);
  assert.doesNotMatch(outboundsSrc, /COUNTRY_FLAG_NAMES|COUNTRY_FLAG_SVG|COUNTRY_CODE_ALIASES = /);
});
