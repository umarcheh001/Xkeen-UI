const COUNTRY_NAMES = Object.freeze({
  AE: 'United Arab Emirates', AU: 'Australia', BR: 'Brazil', CA: 'Canada', CH: 'Switzerland',
  CN: 'China', CZ: 'Czechia', DE: 'Germany', ES: 'Spain', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', HK: 'Hong Kong', ID: 'Indonesia', IL: 'Israel', IN: 'India',
  IT: 'Italy', JP: 'Japan', KR: 'South Korea', KZ: 'Kazakhstan', LV: 'Latvia',
  MY: 'Malaysia', NL: 'Netherlands', NO: 'Norway', PL: 'Poland', RU: 'Russia',
  SE: 'Sweden', SG: 'Singapore', TH: 'Thailand', TR: 'Turkey', TW: 'Taiwan',
  UA: 'Ukraine', US: 'United States', VN: 'Vietnam',
});

const COUNTRY_RULES = Object.freeze([
  [/\b(HONG\s*KONG|HKG)\b/i, 'HK'], [/\b(SINGAPORE)\b/i, 'SG'],
  [/\b(JAPAN|TOKYO|OSAKA)\b/i, 'JP'], [/\b(KOREA|SEOUL)\b/i, 'KR'],
  [/\b(UNITED\s*STATES|USA|NEW\s*YORK|LOS\s*ANGELES|CHICAGO)\b/i, 'US'],
  [/\b(UNITED\s*KINGDOM|GREAT\s*BRITAIN|LONDON)\b/i, 'GB'],
  [/\b(GERMANY|DEUTSCHLAND|BERLIN|FRANKFURT)\b/i, 'DE'],
  [/\b(SWITZERLAND|SWISS|ZURICH|ZÜRICH|GENEVA)\b/i, 'CH'],
  [/\b(CZECHIA|CZECH\s*REPUBLIC|PRAGUE|PRAHA)\b/i, 'CZ'],
  [/\b(LATVIA|RIGA)\b/i, 'LV'], [/\b(SWEDEN|STOCKHOLM)\b/i, 'SE'],
  [/\b(NETHERLANDS|AMSTERDAM|HOLLAND)\b/i, 'NL'], [/\b(FRANCE|PARIS)\b/i, 'FR'],
  [/\b(SPAIN|MADRID)\b/i, 'ES'], [/\b(INDIA|MUMBAI|DELHI)\b/i, 'IN'],
  [/\b(TURKEY|ISTANBUL)\b/i, 'TR'], [/\b(KAZAKHSTAN|ALMATY|ASTANA)\b/i, 'KZ'],
  [/\b(ISRAEL|TEL\s*AVIV)\b/i, 'IL'], [/\b(RUSSIA|MOSCOW|SAINT\s*PETERSBURG)\b/i, 'RU'],
  [/\b(ITALY|MILAN|ROME)\b/i, 'IT'], [/\b(CANADA|TORONTO|MONTREAL)\b/i, 'CA'],
  [/\b(AUSTRALIA|SYDNEY|MELBOURNE)\b/i, 'AU'], [/\b(FINLAND|HELSINKI)\b/i, 'FI'],
  [/\b(NORWAY|OSLO)\b/i, 'NO'], [/\b(POLAND|WARSAW)\b/i, 'PL'],
  [/\b(UKRAINE|KYIV|KIEV)\b/i, 'UA'], [/\b(BRAZIL|SAO\s*PAULO)\b/i, 'BR'],
  [/\b(CHINA|BEIJING|SHANGHAI)\b/i, 'CN'], [/\b(TAIWAN|TAIPEI)\b/i, 'TW'],
  [/\b(VIETNAM|HANOI)\b/i, 'VN'], [/\b(THAILAND|BANGKOK)\b/i, 'TH'],
  [/\b(MALAYSIA|KUALA\s*LUMPUR)\b/i, 'MY'], [/\b(INDONESIA|JAKARTA)\b/i, 'ID'],
  [/\b(UAE|DUBAI|ABU\s*DHABI)\b/i, 'AE'],
]);

const NODE_FLAG_SVG = Object.freeze({
  DE: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#ffce00"/><rect width="20" height="9.333" fill="#dd0000"/><rect width="20" height="4.667" fill="#000"/></svg>',
  LV: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#9e3039"/><rect y="6" width="20" height="2" fill="#fff"/></svg>',
  SE: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#006aa7"/><rect x="6" width="3" height="14" fill="#fecc00"/><rect y="5.5" width="20" height="3" fill="#fecc00"/></svg>',
  NL: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#21468b"/><rect width="20" height="9.333" fill="#fff"/><rect width="20" height="4.667" fill="#ae1c28"/></svg>',
  RU: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#d52b1e"/><rect width="20" height="9.333" fill="#0039a6"/><rect width="20" height="4.667" fill="#fff"/></svg>',
  US: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#b22234"/><rect y="1" width="20" height="1" fill="#fff"/><rect y="3" width="20" height="1" fill="#fff"/><rect y="5" width="20" height="1" fill="#fff"/><rect y="7" width="20" height="1" fill="#fff"/><rect y="9" width="20" height="1" fill="#fff"/><rect y="11" width="20" height="1" fill="#fff"/><rect y="13" width="20" height="1" fill="#fff"/><rect width="8.6" height="7.6" fill="#3c3b6e"/><circle cx="1.6" cy="1.5" r=".45" fill="#fff"/><circle cx="3.6" cy="1.5" r=".45" fill="#fff"/><circle cx="5.6" cy="1.5" r=".45" fill="#fff"/><circle cx="7.6" cy="1.5" r=".45" fill="#fff"/><circle cx="2.6" cy="3.5" r=".45" fill="#fff"/><circle cx="4.6" cy="3.5" r=".45" fill="#fff"/><circle cx="6.6" cy="3.5" r=".45" fill="#fff"/><circle cx="1.6" cy="5.5" r=".45" fill="#fff"/><circle cx="3.6" cy="5.5" r=".45" fill="#fff"/><circle cx="5.6" cy="5.5" r=".45" fill="#fff"/><circle cx="7.6" cy="5.5" r=".45" fill="#fff"/></svg>',
  ES: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#aa151b"/><rect y="3.5" width="20" height="7" fill="#f1bf00"/></svg>',
  IN: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#138808"/><rect width="20" height="9.333" fill="#fff"/><rect width="20" height="4.667" fill="#ff9933"/><circle cx="10" cy="7" r="1.5" fill="none" stroke="#000080" stroke-width=".55"/><path d="M10 5.25v3.5M8.25 7h3.5M8.76 5.76l2.48 2.48M11.24 5.76L8.76 8.24" stroke="#000080" stroke-width=".35"/></svg>',
  TR: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#e30a17"/><circle cx="8" cy="7" r="4" fill="#fff"/><circle cx="9.3" cy="7" r="3.25" fill="#e30a17"/><path d="M14.05 4.65l.57 1.48 1.58-.09-1.22 1.01.58 1.48-1.34-.85-1.22 1.01.39-1.54-1.34-.85 1.58-.1z" fill="#fff"/></svg>',
  KZ: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#00afca"/><path d="M3 1.2v11.6" stroke="#f4c430" stroke-width="1.1"/><circle cx="10.5" cy="5.6" r="2.05" fill="#f4c430"/><path d="M10.5 1.7v1.2M10.5 8.3v1.2M6.6 5.6h1.2M13.2 5.6h1.2M7.7 2.8l.85.85M12.45 7.55l.85.85M13.3 2.8l-.85.85M8.55 7.55l-.85.85" stroke="#f4c430" stroke-width=".55" stroke-linecap="round"/><path d="M7.7 9.6c1.75 1.05 3.8 1.05 5.6 0-.85 1.4-1.85 2.05-2.8 2.05s-1.95-.65-2.8-2.05z" fill="#f4c430"/></svg>',
  JP: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><circle cx="10" cy="7" r="3.7" fill="#bc002d"/></svg>',
  IL: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect y="1.7" width="20" height="1.7" fill="#0038b8"/><rect y="10.6" width="20" height="1.7" fill="#0038b8"/><path d="M10 4.1l3.15 5.45h-6.3z" fill="none" stroke="#0038b8" stroke-width=".75"/><path d="M10 9.9L6.85 4.45h6.3z" fill="none" stroke="#0038b8" stroke-width=".75"/></svg>',
  FR: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect width="6.667" height="14" fill="#0055a4"/><rect x="13.333" width="6.667" height="14" fill="#ef4135"/></svg>',
  IT: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect width="6.667" height="14" fill="#009246"/><rect x="13.333" width="6.667" height="14" fill="#ce2b37"/></svg>',
  GB: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#012169"/><path d="M0 0l20 14M20 0L0 14" stroke="#fff" stroke-width="3"/><path d="M0 0l20 14M20 0L0 14" stroke="#c8102e" stroke-width="1.25"/><path d="M10 0v14M0 7h20" stroke="#fff" stroke-width="4"/><path d="M10 0v14M0 7h20" stroke="#c8102e" stroke-width="2"/></svg>',
  FI: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect x="6" width="3.2" height="14" fill="#002f6c"/><rect y="5.4" width="20" height="3.2" fill="#002f6c"/></svg>',
  NO: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#ba0c2f"/><rect x="5.6" width="4.4" height="14" fill="#fff"/><rect y="4.9" width="20" height="4.2" fill="#fff"/><rect x="6.9" width="1.8" height="14" fill="#00205b"/><rect y="6.1" width="20" height="1.8" fill="#00205b"/></svg>',
  SG: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect width="20" height="7" fill="#ef3340"/><circle cx="5.1" cy="3.5" r="2.2" fill="#fff"/><circle cx="5.8" cy="3.5" r="1.8" fill="#ef3340"/><circle cx="8.1" cy="2.1" r=".35" fill="#fff"/><circle cx="9" cy="3.1" r=".35" fill="#fff"/><circle cx="8.7" cy="4.4" r=".35" fill="#fff"/><circle cx="7.4" cy="4.4" r=".35" fill="#fff"/><circle cx="7.1" cy="3.1" r=".35" fill="#fff"/></svg>',
  HK: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#de2910"/><g fill="#fff" transform="translate(10 7)"><ellipse rx="1.1" ry="3.1" transform="rotate(0) translate(0 -2.2)"/><ellipse rx="1.1" ry="3.1" transform="rotate(72) translate(0 -2.2)"/><ellipse rx="1.1" ry="3.1" transform="rotate(144) translate(0 -2.2)"/><ellipse rx="1.1" ry="3.1" transform="rotate(216) translate(0 -2.2)"/><ellipse rx="1.1" ry="3.1" transform="rotate(288) translate(0 -2.2)"/></g></svg>',
  KR: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><circle cx="10" cy="7" r="3.1" fill="#0047a0"/><path d="M6.9 7a3.1 3.1 0 0 1 6.2 0z" fill="#cd2e3a"/><path d="M4.2 3.1l2.2-1.4M4.8 4l2.2-1.4M13.6 11.9l2.2-1.4M13 11l2.2-1.4M15.8 3.1l-2.2-1.4M15.2 4L13 2.6M6.4 11.9l-2.2-1.4M7 11l-2.2-1.4" stroke="#111827" stroke-width=".55"/></svg>',
  AE: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#000"/><rect width="20" height="9.333" fill="#fff"/><rect width="20" height="4.667" fill="#009639"/><rect width="5.2" height="14" fill="#ff0000"/></svg>',
  CA: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect width="5" height="14" fill="#d52b1e"/><rect x="15" width="5" height="14" fill="#d52b1e"/><path d="M10 2.2l.8 2.1 1.8-.9-.7 2 1.9.6-1.9 1.1.7 2-1.8-.45-.25 2.15h-1.1L9.2 8.65l-1.8.45.7-2L6.2 6l1.9-.6-.7-2 1.8.9z" fill="#d52b1e"/></svg>',
  CH: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#d52b1e"/><rect x="8.2" y="2.3" width="3.6" height="9.4" fill="#fff"/><rect x="5.2" y="5.2" width="9.6" height="3.6" fill="#fff"/></svg>',
  AU: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#012169"/><rect width="9" height="6.5" fill="#012169"/><path d="M0 0l9 6.5M9 0L0 6.5" stroke="#fff" stroke-width="1.4"/><path d="M4.5 0v6.5M0 3.25h9" stroke="#fff" stroke-width="1.8"/><path d="M4.5 0v6.5M0 3.25h9" stroke="#c8102e" stroke-width=".9"/><circle cx="14.8" cy="9.1" r="1" fill="#fff"/><circle cx="17.1" cy="3.6" r=".7" fill="#fff"/></svg>',
  PL: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#dc143c"/><rect width="20" height="7" fill="#fff"/></svg>',
  CZ: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#d7141a"/><rect width="20" height="7" fill="#fff"/><path d="M0 0l10 7L0 14z" fill="#11457e"/></svg>',
  UA: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#ffd700"/><rect width="20" height="7" fill="#0057b7"/></svg>',
  BR: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#009b3a"/><path d="M10 1.7L18.1 7 10 12.3 1.9 7z" fill="#ffdf00"/><circle cx="10" cy="7" r="3.1" fill="#002776"/><path d="M6.9 6.35c2.1-.35 4.15-.05 6.2.85" stroke="#fff" stroke-width=".55" fill="none"/></svg>',
  CN: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#de2910"/><path d="M4.2 1.6l.5 1.5h1.6l-1.3.95.5 1.55-1.3-.95-1.3.95.5-1.55-1.3-.95h1.6z" fill="#ffde00"/><circle cx="8" cy="2.2" r=".5" fill="#ffde00"/><circle cx="9.2" cy="3.6" r=".5" fill="#ffde00"/><circle cx="9.1" cy="5.4" r=".5" fill="#ffde00"/><circle cx="7.8" cy="6.6" r=".5" fill="#ffde00"/></svg>',
  TW: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fe0000"/><rect width="9" height="7" fill="#000095"/><circle cx="4.5" cy="3.5" r="1.7" fill="#fff"/></svg>',
  VN: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#da251d"/><path d="M10 2.2l1.1 3.2h3.4l-2.75 1.95 1.05 3.25L10 8.6l-2.8 2 1.05-3.25L5.5 5.4h3.4z" fill="#ff0"/></svg>',
  TH: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#a51931"/><rect y="2.4" width="20" height="9.2" fill="#fff"/><rect y="4.5" width="20" height="5" fill="#2d2a4a"/></svg>',
  MY: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#cc0001"/><rect y="1" width="20" height="1" fill="#fff"/><rect y="3" width="20" height="1" fill="#fff"/><rect y="5" width="20" height="1" fill="#fff"/><rect y="7" width="20" height="1" fill="#fff"/><rect y="9" width="20" height="1" fill="#fff"/><rect y="11" width="20" height="1" fill="#fff"/><rect y="13" width="20" height="1" fill="#fff"/><rect width="9" height="7.5" fill="#010066"/><circle cx="4.4" cy="3.7" r="2" fill="#ffcc00"/><circle cx="5.1" cy="3.7" r="1.7" fill="#010066"/><path d="M7.1 2.2l.35 1.1h1.15l-.95.65.35 1.1-.9-.7-.9.7.35-1.1-.95-.65h1.15z" fill="#ffcc00"/></svg>',
  ID: '<svg class="xk-sub-node-country-svg" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><rect width="20" height="7" fill="#ce1126"/></svg>',
});

export function mihomoNodeCountryCode(name) {
  const value = String(name || '');
  const indicators = Array.from(value);
  for (let index = 0; index < indicators.length - 1; index += 1) {
    const first = indicators[index].codePointAt(0);
    const second = indicators[index + 1].codePointAt(0);
    if (first >= 0x1F1E6 && first <= 0x1F1FF && second >= 0x1F1E6 && second <= 0x1F1FF) {
      const code = String.fromCharCode(65 + first - 0x1F1E6, 65 + second - 0x1F1E6);
      if (COUNTRY_NAMES[code]) return code;
    }
  }
  const normalized = value.replace(/[_.\/-]+/g, ' ');
  const token = normalized.match(/^(?:\s*)([A-Z]{2,3})(?=\s|$)/)?.[1];
  const aliases = { UK: 'GB', UAE: 'AE', USA: 'US', SH: 'CH' };
  const tokenCode = aliases[token] || token;
  if (COUNTRY_NAMES[tokenCode]) return tokenCode;
  return COUNTRY_RULES.find(([rule]) => rule.test(normalized))?.[1] || '';
}

export function mihomoNodeDisplayName(name, countryCode = mihomoNodeCountryCode(name)) {
  let value = String(name || '').trim();
  if (!countryCode) return value;
  value = value.replace(/^(?:(?:[\u{1F1E6}-\u{1F1FF}]{2})|\uFE0F|\u200D|\s)+/gu, '').trim();
  const aliases = countryCode === 'GB' ? 'GB|UK' : countryCode;
  return value.replace(new RegExp(`^(?:${aliases})(?=$|[\\s._:-])(?:[\\s._:-]+)?`, 'i'), '').trim() || String(name || '').trim();
}

export function mihomoCountryFlag(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  const region = /^[A-Z]{2}$/.test(code)
    ? String.fromCodePoint(...Array.from(code, (letter) => 0x1F1E6 + letter.charCodeAt(0) - 65))
    : '';
  return {
    code,
    label: COUNTRY_NAMES[code] || code,
    region,
    svg: NODE_FLAG_SVG[code] || '',
  };
}
