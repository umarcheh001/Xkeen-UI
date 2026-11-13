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

test('all ISO countries and Unicode flag regions are recognised with local pictures', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../fixtures/country-flag-codes.json', import.meta.url), 'utf8'));
  assert.equal(catalog.iso.length, 249);
  for (const code of new Set([...catalog.iso, ...catalog.unicode])) {
    const emoji = String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
    assert.equal(flags.nodeCountryCode(`${emoji} Node`), code, code);
    assert.equal(flags.nodeDisplayName(`${emoji} Node`), 'Node', code);
    assert.ok(flags.COUNTRY_NAMES[code], code);
    const svg = flags.countryFlag(code).svg;
    assert.match(svg, /<svg/, code);
    const reference = svg.match(/href="([^"#]+)#([^"]+)"/);
    if (reference) {
      assert.match(reference[1], /^\/static\/icons\/country-flags\.svg/);
      const sprite = fs.readFileSync(new URL('../../xkeen-ui/static/icons/country-flags.svg', import.meta.url), 'utf8');
      assert.ok(sprite.includes(`id="${reference[2]}"`), code);
    }
  }
});

test('unknown flag uses a globe and loses its emoji only in the displayed name', () => {
  const raw = '🇿🇿 Анти «Белые списки» 90';
  const code = flags.nodeCountryCode(raw);
  assert.equal(code, 'ZZ');
  assert.equal(flags.normalizeCountryCode(code), '');
  assert.match(flags.countryFlag(code).svg, /xk-country-globe/);
  assert.equal(flags.countryFlag(code).label, 'Страна не определена');
  assert.equal(flags.nodeDisplayName(raw), 'Анти «Белые списки» 90');
  assert.equal(flags.nodeCountryCode('ordinary node'), '');
  assert.equal(flags.nodeDisplayName('ordinary node'), 'ordinary node');
  assert.equal(flags.nodeDisplayName('🇿🇿'), 'Страна не определена');
  assert.equal(flags.nodeCountryCode('🏳 Неизвестный регион'), 'ZZ');
  assert.equal(flags.nodeDisplayName('🏳 Неизвестный регион'), 'Неизвестный регион');
});

test('England Scotland and Wales use their Unicode tag flags', () => {
  for (const [tag, code] of [['gbeng','GB-ENG'],['gbsct','GB-SCT'],['gbwls','GB-WLS']]) {
    const emoji = String.fromCodePoint(0x1F3F4, ...[...tag].map(c => 0xE0000+c.charCodeAt(0)), 0xE007F);
    assert.equal(flags.nodeCountryCode(`${emoji} Node`), code);
    assert.equal(flags.nodeDisplayName(`${emoji} Node`), 'Node');
    assert.match(flags.countryFlag(code).svg, new RegExp(`#flag-${code}`));
    assert.equal(flags.countryFlag(code).region, '');
  }
});

test('sprite has unique IDs, resolves its internal references and contains no active or remote content', () => {
  const sprite = fs.readFileSync(new URL('../../xkeen-ui/static/icons/country-flags.svg', import.meta.url), 'utf8');
  const ids = [...sprite.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size);
  for (const m of sprite.matchAll(/(?:href="#|url\(#)([^"\s)]+)/g)) assert.ok(unique.has(m[1]), m[1]);
  assert.doesNotMatch(sprite, /<(?:script|image|foreignObject)\b|\bon\w+=|(?:href|src)="(?:https?:|data:)/i);
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
