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

function looksLikeIpLiteral(value) {
  const text = cleanName(value);
  if (!text) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return true;
  if (text.includes(':')) return true;
  return false;
}

function collectNamedOccurrences(list, nameKey = 'name') {
  const out = new Map();
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const name = cleanName(item[nameKey]);
    if (!name) return;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(index);
  });
  return out;
}

function validateNamedDuplicates(target, list, pathPrefix, noun) {
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const name = cleanName(item.name);
    if (!name) return;
    const path = [pathPrefix, index, 'name'];
    if (isReservedMihomoTarget(name)) {
      pushDiagnostic(target, createYamlDiagnostic(path, `${noun} \`${name}\` совпадает со спец-именем Mihomo (\`DIRECT\`, \`REJECT\`, \`PASS\`). Такое имя создаёт путаницу в \`rules\` и \`proxy-groups\`.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: `${pathPrefix}-reserved-name`,
      }));
    }
    if (seen.has(name)) {
      const firstIndex = seen.get(name);
      pushDiagnostic(target, createYamlDiagnostic(path, `${noun} \`${name}\` уже существует в \`${pathPrefix}[${firstIndex}]\`. Повторяющиеся имена ломают понятные ссылки из \`rules\` и \`proxy-groups\`.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: `${pathPrefix}-duplicate-name`,
      }));
      return;
    }
    seen.set(name, index);
  });
}

function validateMihomoTargetNameCollisions(target, proxies, proxyGroups) {
  const proxyNames = collectNamedOccurrences(proxies, 'name');
  const groupNames = collectNamedOccurrences(proxyGroups, 'name');
  proxyNames.forEach((proxyIndexes, name) => {
    if (!groupNames.has(name)) return;
    proxyIndexes.forEach((proxyIndex) => {
      pushDiagnostic(target, createYamlDiagnostic(['proxies', proxyIndex, 'name'], `Имя \`${name}\` используется и в \`proxies\`, и в \`proxy-groups\`. Для правил и групп это неоднозначная ссылка.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'proxy-name-collides-with-group',
      }));
    });
    groupNames.get(name).forEach((groupIndex) => {
      pushDiagnostic(target, createYamlDiagnostic(['proxy-groups', groupIndex, 'name'], `Имя \`${name}\` уже занято в \`proxies\`. Лучше развести имена proxy и proxy-group, чтобы target в \`rules\` читался однозначно.`, {
        severity: 'warning',
        source: 'mihomo-semantic',
        code: 'group-name-collides-with-proxy',
      }));
    });
  });
}

function validateMihomoProxyGroupCycles(target, proxyGroups) {
  const groupIndexes = new Map();
  const edgesByGroup = new Map();
  (Array.isArray(proxyGroups) ? proxyGroups : []).forEach((group, index) => {
    if (!isPlainObject(group)) return;
    const groupName = cleanName(group.name);
    if (!groupName) return;
    if (!groupIndexes.has(groupName)) groupIndexes.set(groupName, index);
    const edges = [];
    const proxies = Array.isArray(group.proxies) ? group.proxies : [];
    proxies.forEach((value, itemIndex) => {
      const targetName = cleanName(value);
      if (!targetName || targetName === groupName) return;
      edges.push({
        from: groupName,
        to: targetName,
        groupIndex: index,
        itemIndex,
      });
    });
    edgesByGroup.set(groupName, edges);
  });

  const reported = new Set();
  const settled = new Set();

  function visit(groupName, stackNames, stackEdges) {
    const cycleStart = stackNames.indexOf(groupName);
    if (cycleStart >= 0) {
      const cycleEdges = stackEdges.slice(cycleStart);
      const cycleNames = stackNames.slice(cycleStart).concat(groupName);
      const cycleLabel = cycleNames.join(' -> ');
      if (!reported.has(cycleLabel)) {
        reported.add(cycleLabel);
        cycleEdges.forEach((edge) => {
          pushDiagnostic(target, createYamlDiagnostic(['proxy-groups', edge.groupIndex, 'proxies', edge.itemIndex], `Proxy-group cycle: \`${cycleLabel}\`. Такая цепочка не даст группам собрать конечный список proxy target-ов и часто приводит к "пустому" выбору в UI.`, {
            severity: 'warning',
            source: 'mihomo-semantic',
            code: 'proxy-group-cycle',
          }));
        });
      }
      return;
    }

    if (settled.has(groupName)) return;
    const nextNames = stackNames.concat(groupName);
    const edges = edgesByGroup.get(groupName) || [];
    edges.forEach((edge) => {
      if (!groupIndexes.has(edge.to)) return;
      visit(edge.to, nextNames, stackEdges.concat(edge));
    });
    settled.add(groupName);
  }

  Array.from(groupIndexes.keys()).forEach((groupName) => {
    visit(groupName, [], []);
  });
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
          severity: 'suggestion',
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
    const server = cleanName(proxy.server);
    const flow = cleanName(proxy.flow);
    const wsHost = cleanName(proxy && proxy['ws-opts'] && proxy['ws-opts'].headers && (proxy['ws-opts'].headers.Host || proxy['ws-opts'].headers.host));
    const xhttpHost = cleanName(proxy && proxy['xhttp-opts'] && proxy['xhttp-opts'].host);
    const h2Hosts = Array.isArray(proxy && proxy['h2-opts'] && proxy['h2-opts'].host)
      ? proxy['h2-opts'].host.map(cleanName).filter(Boolean)
      : [];

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
        severity: 'suggestion',
        source: 'mihomo-semantic',
        code: 'proxy-type-alterid',
        hint: 'Если это современный non-vmess прокси, поле `alterId` обычно можно просто удалить.',
      }));
    }

    if (Object.prototype.hasOwnProperty.call(proxy, 'flow') && cleanName(proxy.flow) && type && type !== 'vless') {
      pushDiagnostic(target, createYamlDiagnostic(path.concat('flow'), `Поле \`flow\` обычно используется только у \`type: vless\`, а сейчас указан \`${type}\`.`, {
        severity: 'suggestion',
        source: 'mihomo-semantic',
        code: 'proxy-type-flow',
        hint: 'Обычно это поле имеет смысл только для VLESS Reality / TLS-сценариев.',
      }));
    }

    if (flow === 'xtls-rprx-vision' && (network === 'grpc' || network === 'xhttp')) {
      pushDiagnostic(target, createYamlDiagnostic(path.concat('flow'), `Flow \`xtls-rprx-vision\` не сочетается с \`network: ${network}\`. Для Vision обычно оставляют raw TCP/TLS/REALITY без gRPC/XHTTP.`, {
        source: 'mihomo-semantic',
        code: 'proxy-flow-network-incompatible',
      }));
    }

    if (tls && !cleanName(proxy.servername) && ['vless', 'vmess', 'trojan'].includes(type) && (
      looksLikeIpLiteral(server) || !!wsHost || !!xhttpHost || h2Hosts.length
    )) {
      pushDiagnostic(target, createYamlDiagnostic(path.concat('servername'), `Для \`${type}\` c \`tls: true\` обычно лучше явно указать \`servername\`, чтобы SNI не зависел от того, как потом меняется \`server\` или CDN-host.`, {
        severity: 'suggestion',
        source: 'mihomo-semantic',
        code: 'proxy-servername-suggested',
        hint: 'Если сервер маскируется под другой домен или работает через CDN, задайте `servername` явно.',
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

  validateNamedDuplicates(diagnostics, proxies, 'proxies', 'Proxy');
  validateNamedDuplicates(diagnostics, proxyGroups, 'proxy-groups', 'Proxy-group');
  validateMihomoTargetNameCollisions(diagnostics, proxies, proxyGroups);
  validateMihomoProxyGroupCycles(diagnostics, proxyGroups);
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

function xrayItemPointer(basePointer, index) {
  const base = cleanName(basePointer);
  return base ? `${base}/${index}` : `/${index}`;
}

function getExternalXrayBlock(options, key) {
  const source = options && typeof options === 'object' ? options : null;
  if (!source) return null;
  const suffix = cleanName(key);
  if (!suffix) return null;
  const candidate = `external${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
  return isPlainObject(source[candidate]) ? source[candidate] : null;
}

function getXrayConfigShape(data, options = {}) {
  let kind = cleanName(options.kind || options.schemaKind || options.fragment || options.target).toLowerCase();

  if (!kind && isPlainObject(data)) {
    const keys = Object.keys(data);
    if (Array.isArray(data.inbounds) && !Array.isArray(data.outbounds) && !isPlainObject(data.routing)) kind = 'xray-inbounds';
    else if (Array.isArray(data.outbounds) && !Array.isArray(data.inbounds) && !isPlainObject(data.routing)) kind = 'xray-outbounds';
    else if (isPlainObject(data.routing) || Array.isArray(data.rules) || Array.isArray(data.balancers)) {
      const routingOnlyKeys = new Set(['routing', 'rules', 'balancers', 'domainStrategy', 'observatory', 'burstObservatory']);
      kind = keys.length && keys.every((key) => routingOnlyKeys.has(key)) ? 'xray-routing' : 'xray-config';
    } else if (Array.isArray(data.inbounds) || Array.isArray(data.outbounds)) {
      kind = 'xray-config';
    }
  }

  if (Array.isArray(data)) {
    if (kind.includes('inbounds')) {
      return {
        kind,
        data,
        inbounds: data,
        inboundsPointer: '',
        outbounds: [],
        outboundsPointer: '/outbounds',
        routing: null,
        rulesPointer: '',
        balancersPointer: '',
        observatory: null,
        observatoryPointer: '/observatory',
        burstObservatory: null,
        burstObservatoryPointer: '/burstObservatory',
      };
    }
    if (kind.includes('outbounds')) {
      return {
        kind,
        data,
        inbounds: [],
        inboundsPointer: '/inbounds',
        outbounds: data,
        outboundsPointer: '',
        routing: null,
        rulesPointer: '',
        balancersPointer: '',
        observatory: null,
        observatoryPointer: '/observatory',
        burstObservatory: null,
        burstObservatoryPointer: '/burstObservatory',
      };
    }
    return null;
  }

  if (!isPlainObject(data)) return null;

  const routing = isPlainObject(data.routing)
    ? data.routing
    : ((Array.isArray(data.rules) || Array.isArray(data.balancers)) ? data : null);
  const localObservatory = isPlainObject(data.observatory) ? data.observatory : null;
  const localBurstObservatory = isPlainObject(data.burstObservatory) ? data.burstObservatory : null;
  const externalObservatory = getExternalXrayBlock(options, 'observatory');
  const externalBurstObservatory = getExternalXrayBlock(options, 'burstObservatory');

  return {
    kind,
    data,
    inbounds: Array.isArray(data.inbounds) ? data.inbounds : [],
    inboundsPointer: '/inbounds',
    outbounds: Array.isArray(data.outbounds) ? data.outbounds : [],
    outboundsPointer: '/outbounds',
    routing,
    rulesPointer: routing ? (routing === data ? '/rules' : '/routing/rules') : '',
    balancersPointer: routing ? (routing === data ? '/balancers' : '/routing/balancers') : '',
    localObservatory,
    observatory: localObservatory || externalObservatory || null,
    observatoryPointer: localObservatory ? '/observatory' : cleanName(options.externalObservatoryPointer || '/observatory'),
    externalObservatory,
    localBurstObservatory,
    burstObservatory: localBurstObservatory || externalBurstObservatory || null,
    burstObservatoryPointer: localBurstObservatory ? '/burstObservatory' : cleanName(options.externalBurstObservatoryPointer || '/burstObservatory'),
    externalBurstObservatory,
  };
}

function getXrayRoutingShape(data, options = {}) {
  const shape = getXrayConfigShape(data, options);
  if (!shape || !isPlainObject(shape.routing)) return null;
  return shape;
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

function selectorMatchesAnyTag(selector, tags) {
  const token = cleanName(selector);
  if (!token) return false;
  const list = Array.isArray(tags) ? tags : [];
  for (let index = 0; index < list.length; index += 1) {
    const tag = cleanName(list[index]);
    if (!tag) continue;
    if (tag === token || tag.startsWith(token)) return true;
  }
  return false;
}

function collectDuplicateXrayTags(list) {
  const seen = new Map();
  const duplicates = [];
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const tag = cleanName(item.tag);
    if (!tag) return;
    if (seen.has(tag)) {
      duplicates.push({ tag, index, firstIndex: seen.get(tag) });
      return;
    }
    seen.set(tag, index);
  });
  return duplicates;
}

function getXrayPrimaryEndpointHost(item) {
  if (!isPlainObject(item) || !isPlainObject(item.settings)) return '';
  const settings = item.settings;
  if (Array.isArray(settings.vnext) && settings.vnext.length) {
    return cleanName(settings.vnext[0] && settings.vnext[0].address);
  }
  if (Array.isArray(settings.servers) && settings.servers.length) {
    return cleanName(settings.servers[0] && settings.servers[0].address);
  }
  return cleanName(settings.address);
}

function collectXrayFlowValues(item, role) {
  const flows = [];
  if (!isPlainObject(item) || !isPlainObject(item.settings)) return flows;
  if (role === 'outbound') {
    const vnext = Array.isArray(item.settings.vnext) ? item.settings.vnext : [];
    vnext.forEach((server) => {
      const users = Array.isArray(server && server.users) ? server.users : [];
      users.forEach((user) => {
        const flow = cleanName(user && user.flow);
        if (flow) flows.push(flow);
      });
    });
    return uniqueSorted(flows);
  }
  const clients = Array.isArray(item.settings.clients) ? item.settings.clients : [];
  clients.forEach((client) => {
    const flow = cleanName(client && client.flow);
    if (flow) flows.push(flow);
  });
  return uniqueSorted(flows);
}

function hasConfiguredScalar(value) {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return !!cleanName(value);
}

function validateXraySettingsCollection(diagnostics, pointer, roleLabel, itemLabel, protocol, collection, field, spec) {
  const list = Array.isArray(collection) ? collection : [];
  if (!list.length) {
    pushDiagnostic(diagnostics, createJsonDiagnostic(pointer, `${roleLabel} "${itemLabel}" с \`protocol: ${protocol}\` ожидает непустой блок \`${field}\`. Сейчас semantic-проверка не видит ни одной записи для подключения.`, {
      source: 'xray-semantic',
      code: `${roleLabel.toLowerCase()}-${protocol}-${field}-missing`,
    }));
    return [];
  }

  list.forEach((entry, entryIndex) => {
    if (!isPlainObject(entry)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/${entryIndex}`, `${roleLabel} "${itemLabel}" ожидает объект внутри \`${field}[${entryIndex}]\`, а получил другое значение.`, {
        source: 'xray-semantic',
        code: `${roleLabel.toLowerCase()}-${protocol}-${field}-entry-invalid`,
      }));
      return;
    }
    (Array.isArray(spec) ? spec : []).forEach((rule) => {
      const value = entry[rule.key];
      if (hasConfiguredScalar(value)) return;
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/${entryIndex}/${rule.key}`, `${roleLabel} "${itemLabel}" с \`protocol: ${protocol}\` ожидает поле \`${rule.key}\` внутри \`${field}[${entryIndex}]\`. ${rule.hint}`, {
        source: 'xray-semantic',
        code: `${roleLabel.toLowerCase()}-${protocol}-${field}-${rule.key}-missing`,
      }));
    });
  });
  return list;
}

function validateXrayUserCollection(diagnostics, pointer, roleLabel, itemLabel, protocol, users, field, options = {}) {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) {
    pushDiagnostic(diagnostics, createJsonDiagnostic(pointer, `${roleLabel} "${itemLabel}" с \`protocol: ${protocol}\` не содержит ни одной записи в \`${field}\`. Без пользователей/клиентов Xray не сможет принять или установить соединение.`, {
      source: 'xray-semantic',
      code: `${roleLabel.toLowerCase()}-${protocol}-${field}-empty`,
    }));
    return [];
  }

  list.forEach((entry, entryIndex) => {
    if (!isPlainObject(entry)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/${entryIndex}`, `${roleLabel} "${itemLabel}" ожидает объект внутри \`${field}[${entryIndex}]\`, а получил другое значение.`, {
        source: 'xray-semantic',
        code: `${roleLabel.toLowerCase()}-${protocol}-${field}-entry-invalid`,
      }));
      return;
    }
    const required = Array.isArray(options.required) ? options.required : [];
    required.forEach((rule) => {
      const value = entry[rule.key];
      if (hasConfiguredScalar(value)) return;
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/${entryIndex}/${rule.key}`, `${roleLabel} "${itemLabel}" с \`protocol: ${protocol}\` ожидает поле \`${rule.key}\` внутри \`${field}[${entryIndex}]\`. ${rule.hint}`, {
        source: 'xray-semantic',
        code: `${roleLabel.toLowerCase()}-${protocol}-${field}-${rule.key}-missing`,
      }));
    });

    if (protocol === 'vless') {
      const encryption = cleanName(entry.encryption);
      if (encryption && encryption !== 'none') {
        pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/${entryIndex}/encryption`, `${roleLabel} "${itemLabel}" использует \`protocol: vless\`, но указывает \`encryption: ${encryption}\`. Для VLESS здесь обычно ожидается только \`none\`.`, {
          severity: 'warning',
          source: 'xray-semantic',
          code: `${roleLabel.toLowerCase()}-vless-encryption-invalid`,
        }));
      }
    }
  });
  return list;
}

function validateXrayOutboundProtocolSettingsItem(item, pointer, diagnostics) {
  if (!isPlainObject(item)) return;
  const settings = isPlainObject(item.settings) ? item.settings : {};
  const protocol = cleanName(item.protocol);
  const itemLabel = cleanName(item.tag) || pointer;
  const roleLabel = 'Outbound';

  if (protocol === 'vless' || protocol === 'vmess') {
    const vnext = validateXraySettingsCollection(diagnostics, `${pointer}/settings/vnext`, roleLabel, itemLabel, protocol, settings.vnext, 'vnext', [
      { key: 'address', hint: 'Без адреса Xray не поймёт, к какому серверу подключаться.' },
      { key: 'port', hint: 'Без порта нельзя собрать endpoint для remote-сервера.' },
    ]);
    vnext.forEach((server, serverIndex) => {
      validateXrayUserCollection(diagnostics, `${pointer}/settings/vnext/${serverIndex}/users`, roleLabel, itemLabel, protocol, server && server.users, 'users', {
        required: [
          { key: 'id', hint: 'Это UUID пользователя/клиента на удалённом сервере.' },
        ],
      });
    });
    return;
  }

  if (protocol === 'trojan') {
    validateXraySettingsCollection(diagnostics, `${pointer}/settings/servers`, roleLabel, itemLabel, protocol, settings.servers, 'servers', [
      { key: 'address', hint: 'Без адреса Xray не поймёт, к какому Trojan-серверу подключаться.' },
      { key: 'port', hint: 'Без порта нельзя собрать endpoint для Trojan.' },
      { key: 'password', hint: 'Для Trojan пароль обязателен: это основной credential клиента.' },
    ]);
    return;
  }

  if (protocol === 'shadowsocks') {
    validateXraySettingsCollection(diagnostics, `${pointer}/settings/servers`, roleLabel, itemLabel, protocol, settings.servers, 'servers', [
      { key: 'address', hint: 'Без адреса Xray не поймёт, где находится Shadowsocks-сервер.' },
      { key: 'port', hint: 'Без порта endpoint сервера будет неполным.' },
      { key: 'method', hint: 'Shadowsocks ожидает явный шифр в поле `method`.' },
      { key: 'password', hint: 'Пароль нужен для формирования Shadowsocks-credential.' },
    ]);
    return;
  }

  if (protocol === 'http' || protocol === 'socks') {
    validateXraySettingsCollection(diagnostics, `${pointer}/settings/servers`, roleLabel, itemLabel, protocol, settings.servers, 'servers', [
      { key: 'address', hint: 'Без адреса Xray не поймёт, куда слать запросы этого proxy-outbound.' },
      { key: 'port', hint: 'Порт нужен даже если upstream выглядит "очевидным".' },
    ]);
  }
}

function validateXrayInboundProtocolSettingsItem(item, pointer, diagnostics) {
  if (!isPlainObject(item)) return;
  const settings = isPlainObject(item.settings) ? item.settings : {};
  const protocol = cleanName(item.protocol);
  const itemLabel = cleanName(item.tag) || pointer;
  const roleLabel = 'Inbound';

  if (protocol === 'vless' || protocol === 'vmess') {
    validateXrayUserCollection(diagnostics, `${pointer}/settings/clients`, roleLabel, itemLabel, protocol, settings.clients, 'clients', {
      required: [
        { key: 'id', hint: 'Это UUID клиента, по которому сервер узнаёт пользователя.' },
      ],
    });
    return;
  }

  if (protocol === 'trojan') {
    validateXrayUserCollection(diagnostics, `${pointer}/settings/clients`, roleLabel, itemLabel, protocol, settings.clients, 'clients', {
      required: [
        { key: 'password', hint: 'Trojan inbound аутентифицирует клиентов именно по паролю.' },
      ],
    });
  }
}

function validateXrayTagDuplicates(list, basePointer, noun, diagnostics) {
  collectDuplicateXrayTags(list).forEach(({ tag, index, firstIndex }) => {
    pushDiagnostic(diagnostics, createJsonDiagnostic(`${xrayItemPointer(basePointer, index)}/tag`, `${noun} "${tag}" уже используется в ${basePointer || '(корне)'}[${firstIndex}]. Повторяющиеся tag мешают routing, balancer selector и chain proxy ссылкам.`, {
      severity: 'warning',
      source: 'xray-semantic',
      code: `${noun.toLowerCase().replace(/\s+/g, '-')}-duplicate-tag`,
    }));
  });
}

function validateXrayOutboundLinks(shape, options, diagnostics) {
  const outboundTags = collectXrayKnownTags(shape, options, 'outbound');
  const outbounds = Array.isArray(shape.outbounds) ? shape.outbounds : [];

  outbounds.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const basePointer = xrayItemPointer(shape.outboundsPointer, index);
    const ownTag = cleanName(item.tag);

    const proxyTag = cleanName(item && item.proxySettings && item.proxySettings.tag);
    if (proxyTag) {
      if (ownTag && proxyTag === ownTag) {
        pushDiagnostic(diagnostics, createJsonDiagnostic(`${basePointer}/proxySettings/tag`, `Outbound "${ownTag}" ссылается на самого себя в \`proxySettings.tag\`. Такая chain proxy ссылка создаёт цикл.`, {
          severity: 'warning',
          source: 'xray-semantic',
          code: 'proxy-settings-self-reference',
        }));
      } else if (outboundTags.length && !outboundTags.includes(proxyTag)) {
        pushDiagnostic(diagnostics, createJsonDiagnostic(`${basePointer}/proxySettings/tag`, `Outbound "${ownTag || index}" ссылается на proxySettings.tag "${proxyTag}", но такого outbound нет.${previewNames(outboundTags) ? ` Сейчас доступны: ${previewNames(outboundTags)}.` : ''}`, {
          source: 'xray-semantic',
          code: 'proxy-settings-tag-missing',
        }));
      }
    }

    const dialerProxy = cleanName(item && item.streamSettings && item.streamSettings.sockopt && item.streamSettings.sockopt.dialerProxy);
    if (dialerProxy) {
      if (ownTag && dialerProxy === ownTag) {
        pushDiagnostic(diagnostics, createJsonDiagnostic(`${basePointer}/streamSettings/sockopt/dialerProxy`, `Outbound "${ownTag}" указывает самого себя в \`streamSettings.sockopt.dialerProxy\`. Такая цепочка не сможет разрешиться корректно.`, {
          severity: 'warning',
          source: 'xray-semantic',
          code: 'dialer-proxy-self-reference',
        }));
      } else if (outboundTags.length && !outboundTags.includes(dialerProxy)) {
        pushDiagnostic(diagnostics, createJsonDiagnostic(`${basePointer}/streamSettings/sockopt/dialerProxy`, `Outbound "${ownTag || index}" ссылается на dialerProxy "${dialerProxy}", но такого outbound tag нет.${previewNames(outboundTags) ? ` Сейчас доступны: ${previewNames(outboundTags)}.` : ''}`, {
          source: 'xray-semantic',
          code: 'dialer-proxy-missing',
        }));
      }
    }
  });
}

function validateXrayBalancers(shape, options, diagnostics) {
  if (!shape || !isPlainObject(shape.routing)) return;
  const routing = shape.routing;
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const outboundTags = collectXrayKnownTags(shape, options, 'outbound');

  validateXrayTagDuplicates(balancers, shape.balancersPointer, 'Balancer tag', diagnostics);

  balancers.forEach((balancer, index) => {
    if (!isPlainObject(balancer)) return;
    const pointer = xrayItemPointer(shape.balancersPointer, index);
    const tag = cleanName(balancer.tag);
    const selector = Array.isArray(balancer.selector) ? balancer.selector.map(cleanName).filter(Boolean) : [];

    if (!selector.length) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(pointer, `Balancer "${tag || index}" не содержит selector. Без selector ему будет нечего выбирать среди outbound тегов.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'balancer-selector-empty',
      }));
    }

    selector.forEach((token, selectorIndex) => {
      if (!outboundTags.length || selectorMatchesAnyTag(token, outboundTags)) return;
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/selector/${selectorIndex}`, `Selector "${token}" у balancer "${tag || index}" не совпадает ни с одним известным outbound tag или префиксом.${previewNames(outboundTags) ? ` Сейчас доступны: ${previewNames(outboundTags)}.` : ''}`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'balancer-selector-unmatched',
      }));
    });

    const fallbackTag = cleanName(balancer.fallbackTag);
    if (fallbackTag && outboundTags.length && !outboundTags.includes(fallbackTag)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/fallbackTag`, `Balancer "${tag || index}" использует fallbackTag "${fallbackTag}", но такого outbound нет.${previewNames(outboundTags) ? ` Сейчас доступны: ${previewNames(outboundTags)}.` : ''}`, {
        source: 'xray-semantic',
        code: 'balancer-fallback-tag-missing',
      }));
    }
  });
}

function validateXrayObservabilityDependencies(shape, diagnostics) {
  if (!shape || !isPlainObject(shape.routing)) return;
  const routing = shape.routing;
  const balancers = Array.isArray(routing.balancers) ? routing.balancers : [];
  const shouldCheckLeastPing = shape.kind === 'xray-config' || !!shape.observatory;
  const shouldCheckLeastLoad = shape.kind === 'xray-config' || !!shape.burstObservatory;
  if (!shouldCheckLeastPing && !shouldCheckLeastLoad) return;

  balancers.forEach((balancer, index) => {
    if (!isPlainObject(balancer)) return;
    const strategyType = cleanName(balancer && balancer.strategy && balancer.strategy.type) || 'random';
    const pointer = `${xrayItemPointer(shape.balancersPointer, index)}/strategy/type`;
    const tag = cleanName(balancer.tag) || index;

    if (strategyType === 'leastPing' && !shape.observatory) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(pointer, `Balancer "${tag}" использует стратегию \`leastPing\`, но в конфиге не видно блока \`observatory\`. Без него Xray не знает фактическую задержку outbound-ов.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'balancer-observatory-missing',
        hint: 'Добавьте top-level `observatory` или переключите strategy.type на random/roundRobin.',
      }));
    }

    if (strategyType === 'leastLoad' && !shape.burstObservatory) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(pointer, `Balancer "${tag}" использует стратегию \`leastLoad\`, но в конфиге не видно блока \`burstObservatory\`. Без burst probe стратегия не сможет измерять нагрузку.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'balancer-burst-observatory-missing',
        hint: 'Добавьте top-level `burstObservatory` или используйте random/roundRobin.',
      }));
    }
  });
}

function validateXrayObservatorySelectors(shape, options, diagnostics) {
  const outboundTags = collectXrayKnownTags(shape, options, 'outbound');
  if (!outboundTags.length) return;
  [
    ['observatory', shape.observatory, shape.observatoryPointer, 'observatory-selector-unmatched'],
    ['burstObservatory', shape.burstObservatory, shape.burstObservatoryPointer, 'burst-observatory-selector-unmatched'],
  ].forEach(([label, block, pointer, code]) => {
    if (!isPlainObject(block) || !Array.isArray(block.subjectSelector)) return;
    block.subjectSelector.forEach((token, index) => {
      const selector = cleanName(token);
      if (!selector || selectorMatchesAnyTag(selector, outboundTags)) return;
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/subjectSelector/${index}`, `Selector "${selector}" в \`${label}.subjectSelector\` не совпадает ни с одним известным outbound tag или префиксом.${previewNames(outboundTags) ? ` Сейчас доступны: ${previewNames(outboundTags)}.` : ''}`, {
        severity: 'warning',
        source: 'xray-semantic',
        code,
      }));
    });
  });
}

function validateXrayStreamSettingsItem(item, pointer, role, diagnostics) {
  if (!isPlainObject(item) || !isPlainObject(item.streamSettings)) return;
  const streamSettings = item.streamSettings;
  const protocol = cleanName(item.protocol);
  const security = cleanName(streamSettings.security) || 'none';
  const network = cleanName(streamSettings.network) || 'tcp';
  const hasReality = isPlainObject(streamSettings.realitySettings);
  const hasTls = isPlainObject(streamSettings.tlsSettings);
  const flowValues = collectXrayFlowValues(item, role);
  const itemLabel = cleanName(item.tag) || `${role}[${pointer}]`;

  if (network === 'grpc') {
    pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/network`, `${role === 'outbound' ? 'Outbound' : 'Inbound'} "${itemLabel}" использует устаревший transport gRPC. Для новых конфигов Xray обычно лучше перейти на XHTTP (\`network: xhttp\`), если сервер поддерживает этот transport.`, {
      severity: 'warning',
      source: 'xray-semantic',
      code: `${role}-stream-network-grpc-deprecated`,
      hint: 'Если сервер поддерживает XHTTP, замените `streamSettings.network` на `xhttp` и перенесите transport-specific поля в `xhttpSettings`.',
    }));
  }

  if ((security === 'reality' || hasReality) && protocol && protocol !== 'vless') {
    pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/${hasReality ? 'realitySettings' : 'security'}`, `${role === 'outbound' ? 'Outbound' : 'Inbound'} "${itemLabel}" использует REALITY, но протокол сейчас \`${protocol}\`. Reality обычно ожидает \`protocol: vless\`.`, {
      source: 'xray-semantic',
      code: `${role}-reality-protocol-incompatible`,
    }));
  }

  if (role === 'outbound' && security === 'tls' && hasTls && ['vless', 'vmess', 'trojan'].includes(protocol)) {
    const serverName = cleanName(streamSettings.tlsSettings && streamSettings.tlsSettings.serverName);
    const host = getXrayPrimaryEndpointHost(item);
    if (!serverName && host && !looksLikeIpLiteral(host)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/tlsSettings`, `Outbound "${itemLabel}" использует TLS для \`${protocol}\`, но в \`tlsSettings\` не указан \`serverName\`. Xray может попытаться взять SNI из address, но явный \`serverName\` делает конфиг стабильнее для CDN и маскировки.`, {
        severity: 'suggestion',
        source: 'xray-semantic',
        code: 'outbound-tls-server-name-suggested',
        hint: 'Обычно сюда кладут домен, который сервер ждёт в SNI.',
      }));
    }
  }

  if (role === 'outbound' && (security === 'reality' || hasReality)) {
    const realitySettings = isPlainObject(streamSettings.realitySettings) ? streamSettings.realitySettings : {};
    if (!cleanName(realitySettings.publicKey)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/realitySettings`, `Outbound "${itemLabel}" использует REALITY, но в \`realitySettings\` не указан \`publicKey\`. Без публичного ключа клиент не сможет собрать рабочее соединение.`, {
        source: 'xray-semantic',
        code: 'outbound-reality-public-key-missing',
      }));
    }
    if (!cleanName(realitySettings.serverName)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/realitySettings`, `Outbound "${itemLabel}" использует REALITY, но в \`realitySettings\` не указан \`serverName\`. Без SNI-кандидата маскировка и matching на сервере становятся непредсказуемыми.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'outbound-reality-server-name-missing',
      }));
    }
  }

  if (role === 'inbound' && (security === 'reality' || hasReality)) {
    const realitySettings = isPlainObject(streamSettings.realitySettings) ? streamSettings.realitySettings : {};
    if (!cleanName(realitySettings.privateKey)) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/realitySettings`, `Inbound "${itemLabel}" использует REALITY, но в \`realitySettings\` не указан \`privateKey\`. Серверный REALITY без приватного ключа не заработает.`, {
        source: 'xray-semantic',
        code: 'inbound-reality-private-key-missing',
      }));
    }
    if (!Array.isArray(realitySettings.shortIds) || !realitySettings.shortIds.some((itemValue) => cleanName(itemValue) || itemValue === '')) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/realitySettings`, `Inbound "${itemLabel}" использует REALITY, но в \`realitySettings.shortIds\` не видно ни одного shortId. Обычно серверу нужен хотя бы пустой или явный shortId для сопоставления клиентов.`, {
        severity: 'warning',
        source: 'xray-semantic',
        code: 'inbound-reality-shortids-missing',
      }));
    }
  }

  if (role === 'outbound') {
    const muxEnabled = !!(item && item.mux && item.mux.enabled === true);
    if (muxEnabled && (network === 'grpc' || network === 'xhttp')) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/mux/enabled`, `Outbound "${itemLabel}" включает mux вместе с \`network: ${network}\`. Для gRPC/XHTTP mux обычно не поддерживается и даёт ложное ощущение ускорения.`, {
        source: 'xray-semantic',
        code: 'outbound-mux-network-incompatible',
      }));
    }
    if (muxEnabled && flowValues.includes('xtls-rprx-vision')) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/mux/enabled`, `Outbound "${itemLabel}" включает mux, но среди пользователей есть \`flow: xtls-rprx-vision\`. Vision ожидает отдельный поток и плохо сочетается с mux.`, {
        source: 'xray-semantic',
        code: 'outbound-flow-mux-incompatible',
      }));
    }
    if (flowValues.includes('xtls-rprx-vision') && (network === 'grpc' || network === 'xhttp')) {
      pushDiagnostic(diagnostics, createJsonDiagnostic(`${pointer}/streamSettings/network`, `Outbound "${itemLabel}" использует \`flow: xtls-rprx-vision\` вместе с \`network: ${network}\`. Такой набор обычно конфликтует: для Vision чаще оставляют raw TCP/TLS/REALITY без gRPC/XHTTP.`, {
        source: 'xray-semantic',
        code: 'outbound-flow-network-incompatible',
      }));
    }
  }
}

function validateXrayEndpoints(shape, options, diagnostics) {
  validateXrayTagDuplicates(shape.inbounds, shape.inboundsPointer, 'Inbound tag', diagnostics);
  validateXrayTagDuplicates(shape.outbounds, shape.outboundsPointer, 'Outbound tag', diagnostics);
  validateXrayOutboundLinks(shape, options, diagnostics);

  (Array.isArray(shape.inbounds) ? shape.inbounds : []).forEach((item, index) => {
    validateXrayInboundProtocolSettingsItem(item, xrayItemPointer(shape.inboundsPointer, index), diagnostics);
    validateXrayStreamSettingsItem(item, xrayItemPointer(shape.inboundsPointer, index), 'inbound', diagnostics);
  });
  (Array.isArray(shape.outbounds) ? shape.outbounds : []).forEach((item, index) => {
    validateXrayOutboundProtocolSettingsItem(item, xrayItemPointer(shape.outboundsPointer, index), diagnostics);
    validateXrayStreamSettingsItem(item, xrayItemPointer(shape.outboundsPointer, index), 'outbound', diagnostics);
  });
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
  const shape = getXrayRoutingShape(data, options);
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
  validateXrayBalancers(shape, options, diagnostics);

  if (shape.kind === 'xray-routing' && isPlainObject(shape.localObservatory) && isPlainObject(shape.externalObservatory)) {
    pushDiagnostic(diagnostics, createJsonDiagnostic('/observatory', 'В текущем routing-фрагменте уже есть блок `observatory`, но отдельный `07_observatory.json` тоже существует. Для фрагментированной Xray-конфигурации это обычно дублирование одного и того же observatory-слоя.', {
      severity: 'suggestion',
      source: 'xray-semantic',
      code: 'observatory-duplicates-external',
      hint: 'Обычно observatory лучше оставить в `07_observatory.json`, а из `05_routing.json` удалить локальный дубль.',
    }));
  }

  return diagnostics;
}

export function validateXrayConfigSemantics(data, options = {}) {
  const diagnostics = [];
  const shape = getXrayConfigShape(data, options);
  if (!shape) return diagnostics;

  diagnostics.push(...validateXrayRoutingSemantics(data, options));
  validateXrayEndpoints(shape, options, diagnostics);
  validateXrayObservabilityDependencies(shape, diagnostics);
  validateXrayObservatorySelectors(shape, options, diagnostics);

  return diagnostics;
}

export const schemaSemanticValidationApi = Object.freeze({
  validateMihomoConfigSemantics,
  validateXrayConfigSemantics,
  validateXrayRoutingSemantics,
});
