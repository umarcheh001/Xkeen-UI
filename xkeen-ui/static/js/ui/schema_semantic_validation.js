function asString(value) {
  return String(value == null ? '' : value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanName(value) {
  const text = asString(value).trim();
  return text || '';
}

function uniqueSorted(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(cleanName).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function previewNames(values, limit = 8) {
  const list = uniqueSorted(values);
  if (!list.length) return '';
  const shown = list.slice(0, Math.max(1, Number(limit || 0)));
  const tail = list.length - shown.length;
  return tail > 0 ? `${shown.join(', ')} ... (+${tail})` : shown.join(', ');
}

function _normalizeSeverity(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === 'warning' || text === 'warn') return 'warning';
  if (text === 'info' || text === 'suggestion' || text === 'hint') return 'info';
  return 'error';
}

function pushDiagnostic(target, item) {
  if (!item || typeof item !== 'object') return;
  const message = cleanName(item.message);
  if (!message) return;
  const hint = cleanName(item.hint);
  target.push({
    severity: _normalizeSeverity(item.severity),
    source: cleanName(item.source) || 'semantic-validation',
    message,
    hint,
    path: Array.isArray(item.path) ? item.path.slice() : [],
    pointer: cleanName(item.pointer),
    code: cleanName(item.code),
  });
}

function pointerFromPath(path) {
  const parts = Array.isArray(path) ? path : [];
  if (!parts.length) return '';
  return parts.reduce((acc, part) => {
    const value = String(part == null ? '' : part).replace(/~/g, '~0').replace(/\//g, '~1');
    return `${acc}/${value}`;
  }, '');
}

function pathFromPointer(pointer) {
  const text = cleanName(pointer);
  if (!text || text === '/') return [];
  return text.split('/').slice(1).map((part) => {
    const value = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(value) ? Number(value) : value;
  });
}

function createYamlDiagnostic(path, message, options = {}) {
  const nextPath = Array.isArray(path) ? path.slice() : [];
  return {
    path: nextPath,
    message: cleanName(message),
    severity: _normalizeSeverity(options.severity),
    source: cleanName(options.source) || 'mihomo-semantic',
    code: cleanName(options.code),
    hint: cleanName(options.hint),
  };
}

function createJsonDiagnostic(pointer, message, options = {}) {
  const nextPointer = cleanName(pointer);
  return {
    pointer: nextPointer,
    path: pathFromPointer(nextPointer),
    message: cleanName(message),
    severity: _normalizeSeverity(options.severity),
    source: cleanName(options.source) || 'xray-semantic',
    code: cleanName(options.code),
    hint: cleanName(options.hint),
  };
}

function collectNamedItems(list, nameKey = 'name') {
  const names = [];
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const name = cleanName(item[nameKey]);
    if (!name) return;
    names.push(name);
    if (!seen.has(name)) {
      seen.set(name, { index, item });
    }
  });
  return { names: uniqueSorted(names), seen };
}

function collectProviderNames(mapLike) {
  if (!isPlainObject(mapLike)) return [];
  return uniqueSorted(Object.keys(mapLike));
}

const MIHOMO_RESERVED_PROXY_NAMES = Object.freeze({
  DIRECT: true,
  REJECT: true,
  REJECT_DROP: true,
  PASS: true,
  COMPATIBLE: true,
});

function isReservedMihomoTarget(name) {
  const key = cleanName(name).toUpperCase();
  return !!MIHOMO_RESERVED_PROXY_NAMES[key];
}

function splitTopLevelRuleParts(rule) {
  const text = cleanName(rule);
  if (!text) return [];
  const parts = [];
  let chunk = '';
  let depth = 0;
  let inQuote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (escaped) {
      chunk += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      chunk += ch;
      escaped = true;
      continue;
    }
    if (inQuote) {
      chunk += ch;
      if (ch === inQuote) inQuote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      chunk += ch;
      inQuote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      chunk += ch;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      chunk += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(chunk.trim());
      chunk = '';
      continue;
    }
    chunk += ch;
  }
  if (chunk.trim() || !parts.length) parts.push(chunk.trim());
  return parts.filter((item) => item !== '');
}

function extractRuleSetNames(rule) {
  const text = cleanName(rule);
  const names = [];
  const pattern = /\bRULE-SET,([^,\s)]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const name = cleanName(match[1]);
    if (name) names.push(name);
  }
  return uniqueSorted(names);
}

function resolveMihomoRuleTarget(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const skip = {
    'no-resolve': true,
    src: true,
    dst: true,
  };
  for (let index = list.length - 1; index >= 1; index -= 1) {
    const token = cleanName(list[index]);
    if (!token) continue;
    if (skip[token.toLowerCase()]) continue;
    return token;
  }
  return '';
}

function expectedProviderFields(kind, type) {
  const nextType = cleanName(type);
  if (nextType === 'http') {
    return {
      required: ['url'],
      warn: ['interval'],
      noun: kind === 'rule' ? 'rule-provider' : 'proxy-provider',
    };
  }
  if (nextType === 'file') {
    return {
      required: ['path'],
      warn: [],
      noun: kind === 'rule' ? 'rule-provider' : 'proxy-provider',
    };
  }
  if (nextType === 'inline') {
    return {
      required: ['payload'],
      warn: [],
      noun: kind === 'rule' ? 'rule-provider' : 'proxy-provider',
    };
  }
  return { required: [], warn: [], noun: kind === 'rule' ? 'rule-provider' : 'proxy-provider' };
}

function validateProviderShape(target, mapLike, pathPrefix, kind) {
  if (!isPlainObject(mapLike)) return;
  Object.keys(mapLike).forEach((name) => {
    const item = mapLike[name];
    if (!isPlainObject(item)) return;
    const itemPath = [pathPrefix, name];
    const type = cleanName(item.type);
    const spec = expectedProviderFields(kind, type);
    spec.required.forEach((field) => {
      if (item[field] == null || (typeof item[field] === 'string' && !cleanName(item[field]))) {
        pushDiagnostic(target, createYamlDiagnostic(itemPath, `${spec.noun} \`${name}\` типа \`${type}\` ожидает поле \`${field}\`.`, {
          source: 'mihomo-semantic',
          code: `${kind}-provider-missing-${field}`,
        }));
      }
    });
    spec.warn.forEach((field) => {
      if (item[field] == null || (typeof item[field] === 'string' && !cleanName(item[field]))) {
        pushDiagnostic(target, createYamlDiagnostic(itemPath, `${spec.noun} \`${name}\` типа \`${type}\` обычно лучше указывать с полем \`${field}\`, чтобы обновления не зависели от runtime defaults.`, {
          severity: 'warning',
          source: 'mihomo-semantic',
          code: `${kind}-provider-missing-${field}-warning`,
        }));
      }
    });
  });
}

function validateMihomoProxyCompat(target, proxies) {
  (Array.isArray(proxies) ? proxies : []).forEach((proxy, index) => {
    if (!isPlainObject(proxy)) return;
    const path = ['proxies', index];
    const type = cleanName(proxy.type);
    const network = cleanName(proxy.network);
    const tls = proxy.tls === true;

    const networkBlocks = [
      ['ws-opts', 'ws'],
      ['grpc-opts', 'grpc'],
      ['h2-opts', 'h2'],
      ['xhttp-opts', 'xhttp'],
    ];
    networkBlocks.forEach(([field, expected]) => {
      if (!isPlainObject(proxy[field])) return;
      if (network && network === expected) return;
      pushDiagnostic(target, createYamlDiagnostic(path.concat(field), `Блок \`${field}\` имеет смысл только при \`network: ${expected}\`. Сейчас указано \`${network || 'tcp'}\`.`, {
        source: 'mihomo-semantic',
        code: `proxy-network-${field}`,
      }));
    });

    if (!tls) {
      ['servername', 'fingerprint', 'client-fingerprint', 'reality-opts'].forEach((field) => {
        const value = proxy[field];
        if (value == null) return;
        if (typeof value === 'string' && !cleanName(value)) return;
        if (isPlainObject(value) && !Object.keys(value).length) return;
        pushDiagnostic(target, createYamlDiagnostic(path.concat(field), `Поле \`${field}\` обычно используется только вместе с \`tls: true\`. Сейчас TLS выключен.`, {
          severity: 'warning',
          source: 'mihomo-semantic',
          code: `proxy-tls-${field}`,
        }));
      });
    }

    if (Object.prototype.hasOwnProperty.call(proxy, 'alterId') && type && type !== 'vmess') {
      pushDiagnostic(target, createYamlDiagnostic(path.concat('alterId'), `Поле \`alterId\` ожидается у \`type: vmess\`, а сейчас указан \`${type}\`.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'proxy-type-alterid',
      }));
    }

    if (Object.prototype.hasOwnProperty.call(proxy, 'flow') && cleanName(proxy.flow) && type && type !== 'vless') {
      pushDiagnostic(target, createYamlDiagnostic(path.concat('flow'), `Поле \`flow\` обычно используется только у \`type: vless\`, а сейчас указан \`${type}\`.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'proxy-type-flow',
      }));
    }
  });
}

export function validateMihomoConfigSemantics(data, options = {}) {
  const diagnostics = [];
  if (!isPlainObject(data)) return diagnostics;

  const proxies = Array.isArray(data.proxies) ? data.proxies : [];
  const proxyGroups = Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : [];
  const proxyProviders = isPlainObject(data['proxy-providers']) ? data['proxy-providers'] : {};
  const ruleProviders = isPlainObject(data['rule-providers']) ? data['rule-providers'] : {};
  const rules = Array.isArray(data.rules) ? data.rules : [];

  const proxyInfo = collectNamedItems(proxies, 'name');
  const groupInfo = collectNamedItems(proxyGroups, 'name');
  const proxyProviderNames = collectProviderNames(proxyProviders);
  const ruleProviderNames = collectProviderNames(ruleProviders);

  const knownProxyTargets = new Set([
    ...proxyInfo.names,
    ...groupInfo.names,
  ]);

  validateMihomoProxyCompat(diagnostics, proxies);
  validateProviderShape(diagnostics, proxyProviders, 'proxy-providers', 'proxy');
  validateProviderShape(diagnostics, ruleProviders, 'rule-providers', 'rule');

  Object.keys(proxyProviders).forEach((name) => {
    const provider = proxyProviders[name];
    if (!isPlainObject(provider)) return;
    const proxyName = cleanName(provider.proxy);
    if (!proxyName || isReservedMihomoTarget(proxyName)) return;
    if (!knownProxyTargets.has(proxyName)) {
      pushDiagnostic(diagnostics, createYamlDiagnostic(['proxy-providers', name, 'proxy'], `proxy-provider \`${name}\` ссылается на proxy/group \`${proxyName}\`, но такого имени нет в \`proxies\` или \`proxy-groups\`.`, {
        source: 'mihomo-semantic',
        code: 'proxy-provider-proxy-missing',
      }));
    }
  });

  Object.keys(ruleProviders).forEach((name) => {
    const provider = ruleProviders[name];
    if (!isPlainObject(provider)) return;
    const proxyName = cleanName(provider.proxy);
    if (!proxyName || isReservedMihomoTarget(proxyName)) return;
    if (!knownProxyTargets.has(proxyName)) {
      pushDiagnostic(diagnostics, createYamlDiagnostic(['rule-providers', name, 'proxy'], `rule-provider \`${name}\` ссылается на proxy/group \`${proxyName}\`, но такого имени нет в \`proxies\` или \`proxy-groups\`.`, {
        source: 'mihomo-semantic',
        code: 'rule-provider-proxy-missing',
      }));
    }
  });

  proxyGroups.forEach((group, index) => {
    if (!isPlainObject(group)) return;
    const path = ['proxy-groups', index];
    const groupName = cleanName(group.name);
    const type = cleanName(group.type);
    const proxiesList = Array.isArray(group.proxies) ? group.proxies : [];
    const useList = Array.isArray(group.use) ? group.use : [];
    const includeAll = group['include-all'] === true || group['include-all-proxies'] === true || group['include-all-providers'] === true;

    proxiesList.forEach((name, itemIndex) => {
      const targetName = cleanName(name);
      if (!targetName || isReservedMihomoTarget(targetName)) return;
      if (groupName && targetName === groupName) {
        pushDiagnostic(diagnostics, createYamlDiagnostic(path.concat('proxies', itemIndex), `Группа \`${groupName}\` ссылается сама на себя в \`proxies\`. Это обычно приводит к циклу выбора.`, {
          severity: 'warning',
          source: 'mihomo-semantic',
          code: 'proxy-group-self-reference',
        }));
        return;
      }
      if (knownProxyTargets.has(targetName)) return;
      pushDiagnostic(diagnostics, createYamlDiagnostic(path.concat('proxies', itemIndex), `Группа \`${groupName || `proxy-groups[${index}]`}\` ссылается на \`${targetName}\`, но такого proxy/group нет.`, {
        source: 'mihomo-semantic',
        code: 'proxy-group-target-missing',
      }));
    });

    useList.forEach((name, itemIndex) => {
      const providerName = cleanName(name);
      if (!providerName) return;
      if (proxyProviderNames.includes(providerName)) return;
      pushDiagnostic(diagnostics, createYamlDiagnostic(path.concat('use', itemIndex), `Группа \`${groupName || `proxy-groups[${index}]`}\` использует proxy-provider \`${providerName}\`, но такого provider нет.`, {
        source: 'mihomo-semantic',
        code: 'proxy-group-provider-missing',
      }));
    });

    if (!includeAll && !proxiesList.length && !useList.length) {
      pushDiagnostic(diagnostics, createYamlDiagnostic(path, `Группа \`${groupName || `proxy-groups[${index}]`}\` не содержит ни \`proxies\`, ни \`use\`, ни include-all-флага. Выбрать в ней будет нечего.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'proxy-group-empty',
      }));
    }

    if (['url-test', 'fallback', 'load-balance'].includes(type) && !cleanName(group.url)) {
      pushDiagnostic(diagnostics, createYamlDiagnostic(path, `Группа \`${groupName || `proxy-groups[${index}]`}\` типа \`${type}\` обычно ожидает поле \`url\` для проверки доступности узлов.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'proxy-group-missing-url',
      }));
    }
  });

  rules.forEach((rule, index) => {
    if (typeof rule !== 'string') return;
    const path = ['rules', index];
    const parts = splitTopLevelRuleParts(rule);
    const providers = extractRuleSetNames(rule);
    providers.forEach((name) => {
      if (ruleProviderNames.includes(name)) return;
      pushDiagnostic(diagnostics, createYamlDiagnostic(path, `Правило \`${rule}\` ссылается на rule-provider \`${name}\`, но такого provider нет в \`rule-providers\`.`, {
        source: 'mihomo-semantic',
        code: 'rule-provider-missing',
      }));
    });

    if (parts.length < 2) return;
    const targetName = resolveMihomoRuleTarget(parts);
    if (!targetName) {
      pushDiagnostic(diagnostics, createYamlDiagnostic(path, `Правило \`${rule}\` не указывает целевую proxy-group или proxy в конце строки.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'rule-target-missing',
      }));
      return;
    }
    if (isReservedMihomoTarget(targetName)) return;
    if (knownProxyTargets.has(targetName) || groupInfo.seen.has(targetName) || proxyInfo.seen.has(targetName)) return;
    pushDiagnostic(diagnostics, createYamlDiagnostic(path, `Правило \`${rule}\` направляет трафик в \`${targetName}\`, но такого proxy/group нет.`, {
      source: 'mihomo-semantic',
      code: 'rule-target-not-found',
    }));
  });

  return diagnostics;
}

function collectXrayTagsFromArray(list, field = 'tag') {
  const tags = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (!isPlainObject(item)) return;
    const tag = cleanName(item[field]);
    if (tag) tags.push(tag);
  });
  return uniqueSorted(tags);
}

function getXrayRoutingShape(data) {
  if (!isPlainObject(data)) return null;
  if (isPlainObject(data.routing)) {
    return {
      routing: data.routing,
      rulesPointer: '/routing/rules',
      balancersPointer: '/routing/balancers',
      outbounds: Array.isArray(data.outbounds) ? data.outbounds : [],
      inbounds: Array.isArray(data.inbounds) ? data.inbounds : [],
    };
  }
  if (Array.isArray(data.rules) || Array.isArray(data.balancers)) {
    return {
      routing: data,
      rulesPointer: '/rules',
      balancersPointer: '/balancers',
      outbounds: Array.isArray(data.outbounds) ? data.outbounds : [],
      inbounds: Array.isArray(data.inbounds) ? data.inbounds : [],
    };
  }
  return null;
}

function collectXrayKnownTags(shape, options, kind) {
  const directField = kind === 'outbound'
    ? ['knownOutboundTags', 'outboundTags']
    : ['knownInboundTags', 'inboundTags'];
  const contextKeys = kind === 'outbound'
    ? ['contextOutbounds', 'context', 'externalOutbounds']
    : ['contextInbounds', 'context', 'externalInbounds'];
  const docTags = kind === 'outbound'
    ? collectXrayTagsFromArray(shape && shape.outbounds, 'tag')
    : collectXrayTagsFromArray(shape && shape.inbounds, 'tag');
  const out = [...docTags];

  directField.forEach((key) => {
    const list = options && Array.isArray(options[key]) ? options[key] : [];
    out.push(...list);
  });

  contextKeys.forEach((key) => {
    const value = options ? options[key] : null;
    if (!value) return;
    if (Array.isArray(value)) {
      out.push(...value);
      return;
    }
    if (isPlainObject(value) && Array.isArray(value[kind === 'outbound' ? 'outboundTags' : 'inboundTags'])) {
      out.push(...value[kind === 'outbound' ? 'outboundTags' : 'inboundTags']);
    }
  });

  return uniqueSorted(out);
}

function quoteRuleLabel(ruleTag, index) {
  return ruleTag ? `Правило "${ruleTag}"` : `Правило routing.rules[${index}]`;
}

const PRIVATE_CIDR_SET = new Set([
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
]);

function countPrivateCidrs(ips) {
  if (!Array.isArray(ips)) return 0;
  let matches = 0;
  for (let i = 0; i < ips.length; i += 1) {
    if (PRIVATE_CIDR_SET.has(cleanName(ips[i]))) matches += 1;
  }
  return matches;
}

function hasNegatedGeoip(ips) {
  if (!Array.isArray(ips)) return false;
  for (let i = 0; i < ips.length; i += 1) {
    if (/^ext:[^:]+:!/.test(cleanName(ips[i]))) return true;
  }
  return false;
}

function detectPrivateIpRuleOrdering(rules, rulesPointer, diagnostics) {
  let privateRuleIndex = -1;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!isPlainObject(rule)) continue;
    if (cleanName(rule.outboundTag) !== 'direct') continue;
    if (countPrivateCidrs(rule.ip) < 2) continue;
    privateRuleIndex = index;
    break;
  }
  if (privateRuleIndex <= 0) return;

  let riskyEarlierIndex = -1;
  for (let index = 0; index < privateRuleIndex; index += 1) {
    const rule = rules[index];
    if (!isPlainObject(rule)) continue;
    if (hasNegatedGeoip(rule.ip)) {
      riskyEarlierIndex = index;
      break;
    }
  }
  if (riskyEarlierIndex < 0) return;

  pushDiagnostic(diagnostics, createJsonDiagnostic(
    `${rulesPointer}/${privateRuleIndex}`,
    `Правило с приватными подсетями (routing.rules[${privateRuleIndex}]) расположено после правила с негированным geoip routing.rules[${riskyEarlierIndex}] (ext:…:!…). Такое ext-негирование совпадает с любым IP, который не входит в указанный geoip-набор — в том числе с LAN-адресами — и может неожиданно отправить локальный трафик в прокси.`,
    {
      severity: 'warning',
      source: 'xray-semantic',
      code: 'private-ip-rule-not-first',
      hint: 'Перенесите правило с приватными подсетями в начало routing.rules, чтобы LAN-трафик всегда уходил direct до остальных правил.',
    },
  ));
}

export function validateXrayRoutingSemantics(data, options = {}) {
  const diagnostics = [];
  const shape = getXrayRoutingShape(data);
  if (!shape || !isPlainObject(shape.routing)) return diagnostics;

  const routing = shape.routing;
  const rules = Array.isArray(routing.rules) ? routing.rules : [];
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const balancerTags = collectXrayTagsFromArray(balancers, 'tag');
  const outboundTags = collectXrayKnownTags(shape, options, 'outbound');
  const inboundTags = collectXrayKnownTags(shape, options, 'inbound');
  const seenRuleTags = new Map();

  rules.forEach((rule, index) => {
    if (!isPlainObject(rule)) return;
    const rulePointer = `${shape.rulesPointer}/${index}`;
    const ruleTag = cleanName(rule.ruleTag);
    const outboundTag = cleanName(rule.outboundTag);
    const balancerTag = cleanName(rule.balancerTag);
    const inboundTagList = Array.isArray(rule.inboundTag) ? rule.inboundTag.map(cleanName).filter(Boolean) : [];

    if (ruleTag) {
      if (seenRuleTags.has(ruleTag)) {
        const firstIndex = seenRuleTags.get(ruleTag);
        pushDiagnostic(diagnostics, createJsonDiagnostic(`${rulePointer}/ruleTag`, `Имя ruleTag "${ruleTag}" уже используется в routing.rules[${firstIndex}]. Повторяющиеся ruleTag мешают понятной диагностике и сопровождению правил.`, {
          severity: 'warning',
          source: 'xray-semantic',
          code: 'rule-tag-duplicate',
        }));
      } else {
        seenRuleTags.set(ruleTag, index);
      }
    }

    if (outboundTag && balancerTag) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${rulePointer}/balancerTag`, `${quoteRuleLabel(ruleTag, index)} одновременно указывает и outboundTag "${outboundTag}", и balancerTag "${balancerTag}". Обычно здесь нужен только один маршрут назначения.`, {
        source: 'xray-semantic',
        code: 'rule-multiple-targets',
      }));
    } else if (!outboundTag && !balancerTag) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(rulePointer, `${quoteRuleLabel(ruleTag, index)} не указывает ни outboundTag, ни balancerTag. Такое правило формально выглядит завершённым, но не задаёт направление маршрутизации.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'rule-missing-target',
      }));
    }

    if (outboundTag && outboundTags.length && !outboundTags.includes(outboundTag)) {
      const available = previewNames(outboundTags);
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${rulePointer}/outboundTag`, `${quoteRuleLabel(ruleTag, index)} ссылается на outboundTag "${outboundTag}", но такого outbound нет.${available ? ` Сейчас доступны: ${available}.` : ''}`, {
        source: 'xray-semantic',
        code: 'outbound-tag-missing',
      }));
    }

    if (balancerTag && !balancerTags.includes(balancerTag)) {
      const available = previewNames(balancerTags);
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${rulePointer}/balancerTag`, `${quoteRuleLabel(ruleTag, index)} ссылается на balancerTag "${balancerTag}", но такого balancer нет.${available ? ` Сейчас доступны: ${available}.` : ''}`, {
        source: 'xray-semantic',
        code: 'balancer-tag-missing',
      }));
    }

    inboundTagList.forEach((tag, inboundIndex) => {
      if (!inboundTags.length || inboundTags.includes(tag)) return;
      const available = previewNames(inboundTags);
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${rulePointer}/inboundTag/${inboundIndex}`, `${quoteRuleLabel(ruleTag, index)} ссылается на inboundTag "${tag}", но такого inbound нет.${available ? ` Сейчас доступны: ${available}.` : ''}`, {
        source: 'xray-semantic',
        code: 'inbound-tag-missing',
      }));
    });
  });

  detectPrivateIpRuleOrdering(rules, shape.rulesPointer, diagnostics);

  balancers.forEach((balancer, index) => {
    if (!isPlainObject(balancer)) return;
    const tag = cleanName(balancer.tag);
    const selector = Array.isArray(balancer.selector) ? balancer.selector.map(cleanName).filter(Boolean) : [];
    if (!selector.length) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${shape.balancersPointer}/${index}`, `Balancer "${tag || index}" не содержит selector. Без selector ему будет нечего выбирать среди outbound тегов.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'balancer-selector-empty',
      }));
    }
  });

  return diagnostics;
}

export const schemaSemanticValidationApi = Object.freeze({
  validateMihomoConfigSemantics,
  validateXrayRoutingSemantics,
});
