import { stripJsonComments } from '../util/strip_json_comments.js';

export const ROUTING_SCENARIO_NORMAL = 'normal';
export const ROUTING_SCENARIO_MOBILE_WHITELIST = 'mobile-whitelist';

export const ROUTING_SCENARIO_RULE_PREFIX = 'xk_scenario_mobile_whitelist_';
export const ROUTING_SCENARIO_MOBILE_BALANCER_TAG = 'xk_mobile_whitelist';
export const ROUTING_SCENARIO_MAIN_BALANCER_TAG = 'balancer_main';
export const ROUTING_SCENARIO_RESERVE_BALANCER_TAG = 'balancer_reserv';
export const ROUTING_SCENARIO_WHITE_LIST_BALANCER_TAG = 'balancer_white_list';
export const ROUTING_SCENARIO_MAIN_SELECTOR = 'my_proxy';
export const ROUTING_SCENARIO_RESERVE_SELECTOR = 'reserve_proxy';
export const ROUTING_SCENARIO_MOBILE_SELECTOR = 'white_list';
export const ROUTING_SCENARIO_LOOPBACK_TO_RESERVE = 'loopback_to_reserv';
export const ROUTING_SCENARIO_LOOPBACK_TO_WHITE = 'loopback_to_white';
export const ROUTING_SCENARIO_FROM_MAIN = 'from_balancer_main';
export const ROUTING_SCENARIO_FROM_RESERVE = 'from_balancer_reserv';

const DIRECT_INBOUNDS = Object.freeze(['redirect', 'tproxy', 'socks-in']);
const RESERVED_CIDRS = Object.freeze([
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
]);

const RU_SERVICE_DOMAINS = Object.freeze([
  'ext:geosite_v2fly.dat:ru-available-only-inside',
  'ext:geosite_v2fly.dat:category-ru',
  'ext:geosite_v2fly.dat:steam',
  'ext:geosite_v2fly.dat:category-bank-ru',
  'ext:geosite_v2fly.dat:category-gov-ru',
  'ext:geosite_v2fly.dat:ozon',
  'ext:geosite_v2fly.dat:wildberries',
  'domain:ozon.ru',
  'domain:wildberries.ru',
  'domain:wb.ru',
  'domain:sber.ru',
  'domain:sberbank.ru',
  'domain:tbank.ru',
  'domain:tinkoff.ru',
  'domain:vtb.ru',
  'domain:alfabank.ru',
  'domain:gazprombank.ru',
  'domain:raiffeisen.ru',
  'domain:mkb.ru',
  'domain:pochtabank.ru',
  'domain:gosuslugi.ru',
  'domain:nalog.gov.ru',
  'domain:mos.ru',
  'domain:yandex.ru',
  'domain:mail.ru',
  'domain:vk.com',
  'domain:avito.ru',
  'domain:2gis.ru',
  'regexp:.*\\.ru$',
  'regexp:.*\\.xn--p1ai$',
]);

const RU_IPCIDR = Object.freeze([
  'ext:geoip_v2fly.dat:RU-WHITELIST',
]);

const BLOCKED_DOMAINS = Object.freeze([
  'ext:geosite_v2fly.dat:rutracker',
  'ext:geosite_v2fly.dat:tmdb',
  'ext:geosite_v2fly.dat:facebook',
  'ext:geosite_v2fly.dat:meta',
  'ext:geosite_v2fly.dat:telegram',
  'ext:geosite_v2fly.dat:twitter',
  'ext:geosite_v2fly.dat:instagram',
  'ext:geosite_v2fly.dat:whatsapp',
  'ext:geosite_v2fly.dat:tiktok',
  'ext:geosite_v2fly.dat:github',
  'domain:nnmclub.to',
  'domain:clamav.net',
  'domain:2ip.io',
]);

const BLOCKED_IPS = Object.freeze([
  'ext:geoip_v2fly.dat:cloudflare',
  'ext:geoip_v2fly.dat:cloudfront',
  'ext:geoip_v2fly.dat:telegram',
  'ext:geoip_v2fly.dat:twitter',
  'ext:geoip_v2fly.dat:facebook',
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanScenarioString(value) {
  return String(value == null ? '' : value).trim();
}

function cleanScenarioStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  value.forEach((item) => {
    const text = cleanScenarioString(item);
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out;
}

function readScenarioListField(item, keys) {
  if (!isPlainObject(item)) return [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      return cleanScenarioStringList(item[key]);
    }
  }
  return [];
}

function readScenarioBoolField(item, keys, fallback) {
  if (!isPlainObject(item)) return !!fallback;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (Object.prototype.hasOwnProperty.call(item, key)) return !!item[key];
  }
  return !!fallback;
}

function scenarioSelectorMatchesTag(selector, tag) {
  const token = cleanScenarioString(selector);
  const value = cleanScenarioString(tag);
  return !!(token && value && (value === token || value.startsWith(token)));
}

function subscriptionMatchesScenarioSelector(item, selector) {
  if (!isPlainObject(item)) return false;
  const token = cleanScenarioString(selector);
  if (!token) return false;
  const tokenLower = token.toLowerCase();
  const identity = [
    item.id,
    item.tag,
    item.name,
  ].map((value) => cleanScenarioString(value).toLowerCase()).filter(Boolean);
  if (identity.includes(tokenLower)) return true;
  const selectorTerms = readScenarioListField(item, ['last_selector_terms', 'lastSelectorTerms']);
  if (selectorTerms.includes(token)) return true;
  const tags = readScenarioListField(item, ['last_tags', 'lastTags']);
  return tags.some((tag) => scenarioSelectorMatchesTag(token, tag));
}

function subscriptionScenarioLabel(item) {
  if (!isPlainObject(item)) return '';
  return cleanScenarioString(item.name) || cleanScenarioString(item.tag) || cleanScenarioString(item.id);
}

function subscriptionRoutingAutoRuleEnabled(item) {
  return readScenarioBoolField(item, ['routing_auto_rule', 'routingAutoRule'], true);
}

function normalizeMode(mode) {
  const text = String(mode || '').trim().toLowerCase();
  return text === ROUTING_SCENARIO_MOBILE_WHITELIST ? ROUTING_SCENARIO_MOBILE_WHITELIST : ROUTING_SCENARIO_NORMAL;
}

function managedRuleTag(rule) {
  return isPlainObject(rule) ? String(rule.ruleTag || '').trim() : '';
}

function isManagedScenarioRule(rule) {
  return managedRuleTag(rule).startsWith(ROUTING_SCENARIO_RULE_PREFIX);
}

function isManagedScenarioBalancer(item) {
  if (!isPlainObject(item)) return false;
  const tag = String(item.tag || '').trim();
  const selector = cleanScenarioStringList(item.selector);
  const fallback = cleanScenarioString(item.fallbackTag);
  if (tag === ROUTING_SCENARIO_MOBILE_BALANCER_TAG) return true;
  if (tag === ROUTING_SCENARIO_MAIN_BALANCER_TAG) {
    return selector.length === 1 && selector[0] === ROUTING_SCENARIO_MAIN_SELECTOR && fallback === ROUTING_SCENARIO_LOOPBACK_TO_RESERVE;
  }
  if (tag === ROUTING_SCENARIO_RESERVE_BALANCER_TAG) {
    return selector.length === 1 && selector[0] === ROUTING_SCENARIO_RESERVE_SELECTOR && fallback === ROUTING_SCENARIO_LOOPBACK_TO_WHITE;
  }
  if (tag === ROUTING_SCENARIO_WHITE_LIST_BALANCER_TAG) {
    return selector.length === 1 && selector[0] === ROUTING_SCENARIO_MOBILE_SELECTOR;
  }
  return false;
}

function routingTarget(root) {
  if (isPlainObject(root) && isPlainObject(root.routing)) {
    return { root, routing: root.routing };
  }
  if (
    isPlainObject(root)
    && (Array.isArray(root.rules) || Array.isArray(root.balancers) || root.domainStrategy != null)
  ) {
    return { root, routing: root };
  }
  throw new Error('routing object not found');
}

function mobileRules() {
  return [
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}direct_private`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'direct',
      ip: Array.from(RESERVED_CIDRS),
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}block_windows_udp`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'block',
      network: 'udp',
      port: '135,137-139',
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}block_ads`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'block',
      domain: ['ext:geosite_v2fly.dat:category-ads-all'],
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}block_quic`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'block',
      network: 'udp',
      port: '443,8443',
      ip: ['ext:geoip_zkeenip.dat:!ru'],
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}direct_bittorrent`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'direct',
      protocol: ['bittorrent'],
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}direct_ru_domains`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'direct',
      domain: Array.from(RU_SERVICE_DOMAINS),
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}direct_ru_ip`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'direct',
      ip: Array.from(RU_IPCIDR),
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}blocked_domains_main`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      balancerTag: ROUTING_SCENARIO_MAIN_BALANCER_TAG,
      domain: Array.from(BLOCKED_DOMAINS),
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}blocked_ips_main`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      balancerTag: ROUTING_SCENARIO_MAIN_BALANCER_TAG,
      ip: Array.from(BLOCKED_IPS),
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}default_direct`,
      inboundTag: Array.from(DIRECT_INBOUNDS),
      outboundTag: 'direct',
      network: 'tcp,udp',
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}fallback_from_main`,
      inboundTag: [ROUTING_SCENARIO_FROM_MAIN],
      balancerTag: ROUTING_SCENARIO_RESERVE_BALANCER_TAG,
      network: 'tcp,udp',
    },
    {
      type: 'field',
      ruleTag: `${ROUTING_SCENARIO_RULE_PREFIX}fallback_from_reserve`,
      inboundTag: [ROUTING_SCENARIO_FROM_RESERVE],
      balancerTag: ROUTING_SCENARIO_WHITE_LIST_BALANCER_TAG,
      network: 'tcp,udp',
    },
  ];
}

function mobileBalancers() {
  return [
    {
      tag: ROUTING_SCENARIO_MAIN_BALANCER_TAG,
      selector: [ROUTING_SCENARIO_MAIN_SELECTOR],
      strategy: { type: 'leastPing' },
      fallbackTag: ROUTING_SCENARIO_LOOPBACK_TO_RESERVE,
    },
    {
      tag: ROUTING_SCENARIO_RESERVE_BALANCER_TAG,
      selector: [ROUTING_SCENARIO_RESERVE_SELECTOR],
      strategy: { type: 'leastPing' },
      fallbackTag: ROUTING_SCENARIO_LOOPBACK_TO_WHITE,
    },
    {
      tag: ROUTING_SCENARIO_WHITE_LIST_BALANCER_TAG,
      selector: [ROUTING_SCENARIO_MOBILE_SELECTOR],
      strategy: { type: 'leastPing' },
    },
  ];
}

function isScenarioTerminalRule(rule) {
  const tag = managedRuleTag(rule);
  return tag === `${ROUTING_SCENARIO_RULE_PREFIX}default_direct`
    || tag === `${ROUTING_SCENARIO_RULE_PREFIX}fallback_from_main`
    || tag === `${ROUTING_SCENARIO_RULE_PREFIX}fallback_from_reserve`;
}

export function parseRoutingScenarioText(text) {
  const cleaned = stripJsonComments(String(text ?? ''));
  return JSON.parse(cleaned || '{}');
}

export function detectRoutingScenarioFromObject(config) {
  try {
    const target = routingTarget(config);
    const routing = target.routing;
    const rules = Array.isArray(routing.rules) ? routing.rules : [];
    const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
    if (rules.some(isManagedScenarioRule) || balancers.some(isManagedScenarioBalancer)) {
      return ROUTING_SCENARIO_MOBILE_WHITELIST;
    }
  } catch (e) {
    return '';
  }
  return ROUTING_SCENARIO_NORMAL;
}

export function detectRoutingScenarioFromText(text) {
  try {
    return detectRoutingScenarioFromObject(parseRoutingScenarioText(text));
  } catch (e) {
    return '';
  }
}

export function applyRoutingScenarioToObject(config, mode) {
  const nextMode = normalizeMode(mode);
  const root = cloneJson(isPlainObject(config) ? config : {});
  const target = routingTarget(root);
  const routing = target.routing;
  const currentRules = Array.isArray(routing.rules) ? routing.rules : [];
  const currentBalancers = Array.isArray(routing.balancers) ? routing.balancers : [];

  const userRules = currentRules.filter((rule) => !isManagedScenarioRule(rule));
  const userBalancers = currentBalancers.filter((item) => !isManagedScenarioBalancer(item));

  if (nextMode === ROUTING_SCENARIO_MOBILE_WHITELIST) {
    if (!routing.domainStrategy) routing.domainStrategy = 'IPIfNonMatch';
    const generatedRules = mobileRules();
    const leadingRules = generatedRules.filter((rule) => !isScenarioTerminalRule(rule));
    const terminalRules = generatedRules.filter(isScenarioTerminalRule);
    routing.rules = leadingRules.concat(userRules, terminalRules);
    routing.balancers = mobileBalancers().concat(userBalancers);
  } else {
    routing.rules = userRules;
    routing.balancers = userBalancers;
  }

  return root;
}

export function applyRoutingScenarioText(text, mode) {
  const before = String(text ?? '');
  const parsed = parseRoutingScenarioText(before);
  const next = applyRoutingScenarioToObject(parsed, mode);
  const nextText = JSON.stringify(next, null, 2) + '\n';
  return {
    mode: normalizeMode(mode),
    text: nextText,
    changed: nextText !== before,
  };
}

export function analyzeRoutingScenarioPreflight(input = {}) {
  const selector = cleanScenarioString(input.selector || ROUTING_SCENARIO_MOBILE_SELECTOR);
  const selectors = [
    ROUTING_SCENARIO_MAIN_SELECTOR,
    ROUTING_SCENARIO_RESERVE_SELECTOR,
    selector,
    ROUTING_SCENARIO_LOOPBACK_TO_RESERVE,
    ROUTING_SCENARIO_LOOPBACK_TO_WHITE,
  ];
  const outboundTags = Array.isArray(input.outboundTags) ? cleanScenarioStringList(input.outboundTags) : null;
  const subscriptions = Array.isArray(input.subscriptions) ? input.subscriptions.filter(isPlainObject) : null;
  const matchingOutboundTags = outboundTags
    ? outboundTags.filter((tag) => scenarioSelectorMatchesTag(selector, tag))
    : [];
  const matchingSubscriptions = subscriptions
    ? subscriptions.filter((item) => subscriptionMatchesScenarioSelector(item, selector))
    : [];
  const autoRuleSubscriptions = matchingSubscriptions.filter(subscriptionRoutingAutoRuleEnabled);
  const selectorChecks = selectors.map((item) => {
    const matches = outboundTags ? outboundTags.filter((tag) => scenarioSelectorMatchesTag(item, tag)) : [];
    return {
      selector: item,
      count: matches.length,
      matchingOutboundTags: matches,
    };
  });

  return {
    selector,
    selectors,
    selectorChecks,
    tagsChecked: Array.isArray(outboundTags),
    subscriptionsChecked: Array.isArray(subscriptions),
    matchingOutboundTags,
    outboundCount: matchingOutboundTags.length,
    matchingSubscriptions: matchingSubscriptions.map((item) => ({
      id: cleanScenarioString(item.id),
      tag: cleanScenarioString(item.tag),
      name: cleanScenarioString(item.name),
      label: subscriptionScenarioLabel(item),
      routingAutoRule: subscriptionRoutingAutoRuleEnabled(item),
    })),
    autoRuleSubscriptions: autoRuleSubscriptions.map((item) => ({
      id: cleanScenarioString(item.id),
      tag: cleanScenarioString(item.tag),
      name: cleanScenarioString(item.name),
      label: subscriptionScenarioLabel(item),
    })),
  };
}

export function formatRoutingScenarioPreflightMessage(preflight) {
  const data = isPlainObject(preflight) ? preflight : {};
  const selector = cleanScenarioString(data.selector || ROUTING_SCENARIO_MOBILE_SELECTOR);
  const parts = [];
  let tone = 'success';

  if (data.tagsChecked) {
    const checks = Array.isArray(data.selectorChecks) ? data.selectorChecks : [];
    const missing = checks.filter((item) => Number(item.count || 0) <= 0).map((item) => cleanScenarioString(item.selector)).filter(Boolean);
    if (!missing.length && checks.length) {
      parts.push(`Цепочка найдена: ${checks.map((item) => `${item.selector}=${Number(item.count || 0)}`).join(', ')}.`);
    } else if (checks.length) {
      parts.push(`В цепочке не найдены: ${missing.join(', ')}. Проверьте подписки и loopback outbounds.`);
      tone = 'error';
    } else {
      const count = Number(data.outboundCount || 0);
      if (count > 0) {
        parts.push(`Пул ${selector} найден: ${count} outbound.`);
      } else {
        parts.push(`Пул ${selector} не найден. Сначала обновите подписку/профиль ${selector}.`);
        tone = 'error';
      }
    }
  } else {
    parts.push('Не удалось проверить цепочку: список outbound недоступен.');
    tone = 'warning';
  }

  if (data.tagsChecked) {
    const count = Number(data.outboundCount || 0);
    if (count > 0 && !String(parts[0] || '').includes(`white_list=${count}`)) {
      parts.push(`Пул ${selector} найден: ${count} outbound.`);
    } else {
      if (count <= 0 && tone !== 'error') tone = 'error';
    }
  }

  if (data.subscriptionsChecked) {
    const autoRule = Array.isArray(data.autoRuleSubscriptions) ? data.autoRuleSubscriptions : [];
    const matching = Array.isArray(data.matchingSubscriptions) ? data.matchingSubscriptions : [];
    if (autoRule.length) {
      const labels = autoRule.map((item) => cleanScenarioString(item.label || item.tag || item.id)).filter(Boolean);
      parts.push(`У профиля ${labels.join(', ') || selector} включено авто-правило routing; для этого сценария лучше выключить.`);
      if (tone !== 'error') tone = 'warning';
    } else if (matching.length) {
      parts.push('Авто-routing подписки выключен.');
    } else {
      parts.push(`Профиль ${selector} в подписках не найден; проверяю только outbound-теги.`);
      if (tone !== 'error') tone = 'warning';
    }
  } else if (tone !== 'error') {
    parts.push('Не удалось проверить настройки подписки.');
    tone = 'warning';
  }

  return {
    message: parts.join(' '),
    tone,
  };
}

export const routingScenarios = Object.freeze({
  normal: ROUTING_SCENARIO_NORMAL,
  mobileWhitelist: ROUTING_SCENARIO_MOBILE_WHITELIST,
  managedRulePrefix: ROUTING_SCENARIO_RULE_PREFIX,
  mobileBalancerTag: ROUTING_SCENARIO_MOBILE_BALANCER_TAG,
  mainBalancerTag: ROUTING_SCENARIO_MAIN_BALANCER_TAG,
  reserveBalancerTag: ROUTING_SCENARIO_RESERVE_BALANCER_TAG,
  whiteListBalancerTag: ROUTING_SCENARIO_WHITE_LIST_BALANCER_TAG,
  mainSelector: ROUTING_SCENARIO_MAIN_SELECTOR,
  reserveSelector: ROUTING_SCENARIO_RESERVE_SELECTOR,
  mobileSelector: ROUTING_SCENARIO_MOBILE_SELECTOR,
  applyText: applyRoutingScenarioText,
  detectText: detectRoutingScenarioFromText,
  analyzePreflight: analyzeRoutingScenarioPreflight,
  formatPreflightMessage: formatRoutingScenarioPreflightMessage,
});
