import { modify as modifyJsonc } from 'jsonc-parser';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import {
  buildJsoncPointerMap,
  findDiagnosticMapping,
  getSchemaAtPointer,
  resolveSchema,
  safeParseJson,
  validateValue,
} from '../vendor/codemirror_json_schema.js';
import {
  buildYamlPathLocationMap,
  pathToString,
  resolveSchemaAtPath,
  validateYamlTextAgainstSchema,
} from './yaml_schema.js';
import {
  validateMihomoConfigSemantics,
  validateXrayConfigSemantics,
  validateXrayRoutingSemantics,
} from './schema_semantic_validation.js';

const JSONC_FORMATTING_OPTIONS = Object.freeze({
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
});

const DEFAULT_HEALTHCHECK_URL = 'http://www.gstatic.com/generate_204';
const DEFAULT_PROVIDER_INTERVAL = 86400;

function asString(value) {
  return value == null ? '' : String(value);
}

function cleanName(value) {
  return asString(value).trim();
}

function looksLikeIpLiteral(value) {
  const raw = cleanName(value);
  if (!raw) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return true;
  return /^[0-9a-f:.]+$/i.test(raw) && raw.includes(':');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (!isPlainObject(value)) return value;
  const out = {};
  Object.keys(value).forEach((key) => {
    out[key] = cloneValue(value[key]);
  });
  return out;
}

function splitPathString(path) {
  const raw = cleanName(path);
  if (!raw) return [];
  const out = [];
  let buffer = '';
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw.charAt(index);
    if (ch === '.') {
      if (buffer) out.push(buffer);
      buffer = '';
      continue;
    }
    if (ch === '[') {
      if (buffer) out.push(buffer);
      buffer = '';
      let end = raw.indexOf(']', index + 1);
      if (end < 0) end = raw.length;
      const part = raw.slice(index + 1, end);
      out.push(/^\d+$/.test(part) ? Number(part) : part);
      index = end;
      continue;
    }
    buffer += ch;
  }
  if (buffer) out.push(buffer);
  return out;
}

function pathFromPointer(pointer) {
  const raw = cleanName(pointer);
  if (!raw || raw === '/') return [];
  return raw.split('/').slice(1).map((part) => {
    const value = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(value) ? Number(value) : value;
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

function getValueAtPath(data, path) {
  const parts = Array.isArray(path) ? path : [];
  let current = data;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (current == null) return undefined;
    if (typeof part === 'number') {
      if (!Array.isArray(current) || part < 0 || part >= current.length) return undefined;
      current = current[part];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(Object(current), part)) return undefined;
    current = current[part];
  }
  return current;
}

function getValueAtPointer(data, pointer) {
  return getValueAtPath(data, pathFromPointer(pointer));
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(cleanName).filter(Boolean)));
}

function chooseSchemaCandidate(schema, rootSchema) {
  const resolved = resolveSchema(schema, rootSchema) || schema;
  if (!resolved || typeof resolved !== 'object') return null;
  const families = ['oneOf', 'anyOf', 'allOf'];
  for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
    const key = families[familyIndex];
    if (!Array.isArray(resolved[key]) || !resolved[key].length) continue;
    for (let index = 0; index < resolved[key].length; index += 1) {
      const candidate = chooseSchemaCandidate(resolved[key][index], rootSchema);
      if (candidate) return candidate;
    }
  }
  return resolved;
}

function schemaTypeList(schema, rootSchema) {
  const candidate = chooseSchemaCandidate(schema, rootSchema);
  if (!candidate || !candidate.type) return [];
  if (Array.isArray(candidate.type)) return candidate.type.map((item) => cleanName(item)).filter(Boolean);
  return [cleanName(candidate.type)].filter(Boolean);
}

function buildDefaultValueFromSchema(schema, rootSchema) {
  const candidate = chooseSchemaCandidate(schema, rootSchema);
  if (!candidate || typeof candidate !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(candidate, 'default')) return cloneValue(candidate.default);
  if (Object.prototype.hasOwnProperty.call(candidate, 'const')) return cloneValue(candidate.const);
  if (Array.isArray(candidate.enum) && candidate.enum.length) {
    const deprecated = new Set((Array.isArray(candidate.deprecatedValues) ? candidate.deprecatedValues : []).map((item) => JSON.stringify(item)));
    const preferred = candidate.enum.find((item) => !deprecated.has(JSON.stringify(item)));
    return cloneValue(preferred !== undefined ? preferred : candidate.enum[0]);
  }

  const types = schemaTypeList(candidate, rootSchema);
  if (types.includes('object') || candidate.properties || candidate.additionalProperties || candidate.patternProperties) return {};
  if (types.includes('array') || candidate.items) return [];
  if (types.includes('boolean')) return false;
  if (types.includes('integer') || types.includes('number')) return 0;
  if (types.includes('null')) return null;
  return '';
}

function getObjectPropertySchema(schema, key, rootSchema) {
  const candidate = resolveSchema(schema, rootSchema) || schema;
  if (!candidate || typeof candidate !== 'object') return null;
  if (candidate.properties && Object.prototype.hasOwnProperty.call(candidate.properties, key)) {
    return resolveSchema(candidate.properties[key], rootSchema) || candidate.properties[key];
  }
  if (candidate.patternProperties) {
    const names = Object.keys(candidate.patternProperties);
    for (let index = 0; index < names.length; index += 1) {
      const pattern = names[index];
      try {
        if (new RegExp(pattern, 'u').test(key)) {
          return resolveSchema(candidate.patternProperties[pattern], rootSchema) || candidate.patternProperties[pattern];
        }
      } catch (e) {}
    }
  }
  if (candidate.additionalProperties && typeof candidate.additionalProperties === 'object') {
    return resolveSchema(candidate.additionalProperties, rootSchema) || candidate.additionalProperties;
  }
  const families = ['allOf', 'anyOf', 'oneOf'];
  for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
    const family = families[familyIndex];
    if (!Array.isArray(candidate[family])) continue;
    for (let index = 0; index < candidate[family].length; index += 1) {
      const nested = getObjectPropertySchema(candidate[family][index], key, rootSchema);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeTextEdits(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const from = Math.max(0, Number(item && (item.from != null ? item.from : item.offset) || 0));
      const to = Math.max(from, Number(item && (item.to != null ? item.to : (item.offset != null ? Number(item.offset) + Number(item.length || 0) : from)) || from));
      return {
        from,
        to,
        insert: asString(item && (item.insert != null ? item.insert : item.content)),
      };
    })
    .sort((a, b) => {
      if (a.from !== b.from) return a.from - b.from;
      return a.to - b.to;
    });
}

function normalizeJsoncEdits(list) {
  return normalizeTextEdits((Array.isArray(list) ? list : []).map((item) => ({
    offset: Number(item && item.offset || 0),
    length: Number(item && item.length || 0),
    content: asString(item && item.content),
  })));
}

export function applyTextEdits(text, edits) {
  const source = asString(text);
  const list = normalizeTextEdits(edits);
  if (!list.length) return source;
  let out = source;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    out = out.slice(0, item.from) + item.insert + out.slice(item.to);
  }
  return out;
}

export function applyQuickFixText(text, fix) {
  if (!fix || typeof fix !== 'object') return asString(text);
  if (typeof fix.text === 'string') return fix.text;
  if (Array.isArray(fix.edits) && fix.edits.length) return applyTextEdits(text, fix.edits);
  return asString(text);
}

function createQuickFix(meta, edits) {
  const normalizedEdits = normalizeTextEdits(edits);
  if (!normalizedEdits.length) return null;
  const rangeFrom = Number.isFinite(meta && meta.rangeFrom) ? Math.max(0, Number(meta.rangeFrom)) : normalizedEdits[0].from;
  const lastEdit = normalizedEdits[normalizedEdits.length - 1];
  const rangeTo = Number.isFinite(meta && meta.rangeTo) ? Math.max(rangeFrom, Number(meta.rangeTo)) : Math.max(lastEdit.to, rangeFrom + 1);
  return {
    id: cleanName(meta && meta.id) || `fix-${Math.random().toString(36).slice(2, 9)}`,
    title: cleanName(meta && meta.title) || 'Исправить',
    label: cleanName(meta && meta.label) || cleanName(meta && meta.title) || 'Исправить',
    code: cleanName(meta && meta.code),
    isPreferred: !!(meta && meta.isPreferred),
    priority: Number.isFinite(meta && meta.priority) ? Number(meta.priority) : 0,
    rangeFrom,
    rangeTo,
    family: cleanName(meta && meta.family),
    edits: normalizedEdits,
  };
}

function dedupeQuickFixes(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((item) => {
    if (!item || !item.id || !item.title) return false;
    const key = `${item.id}\u0000${item.title}\u0000${item.rangeFrom}\u0000${item.rangeTo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalizeQuickFixes(list, ctx) {
  const items = dedupeQuickFixes(list).sort((a, b) => {
    if (!!a.isPreferred !== !!b.isPreferred) return a.isPreferred ? -1 : 1;
    if ((Number(a.priority) || 0) !== (Number(b.priority) || 0)) return (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (a.rangeFrom !== b.rangeFrom) return a.rangeFrom - b.rangeFrom;
    return a.title.localeCompare(b.title);
  });
  const offset = Number.isFinite(ctx && ctx.offset) ? Math.max(0, Number(ctx.offset)) : NaN;
  const scoped = Number.isFinite(offset)
    ? (() => {
        const matching = items.filter((item) => offset >= item.rangeFrom && offset <= item.rangeTo);
        return matching.length ? matching : items;
      })()
    : items;
  const limit = Math.max(0, Number(ctx && ctx.limit || 0));
  return limit > 0 ? scoped.slice(0, limit) : scoped;
}

function levenshtein(a, b) {
  const left = asString(a);
  const right = asString(b);
  if (!left) return right.length;
  if (!right) return left.length;
  const prev = new Array(right.length + 1);
  const next = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;
  for (let i = 0; i < left.length; i += 1) {
    next[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left.charAt(i) === right.charAt(j) ? 0 : 1;
      next[j + 1] = Math.min(
        next[j] + 1,
        prev[j + 1] + 1,
        prev[j] + cost
      );
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = next[j];
  }
  return prev[right.length];
}

function pickClosestString(source, candidates, preferred = []) {
  const target = cleanName(source);
  const list = uniqueStrings(candidates);
  if (!list.length) return '';
  const priority = uniqueStrings(preferred).filter((item) => list.includes(item));
  if (!target) return priority[0] || list[0];
  let best = '';
  let bestScore = Infinity;
  const ordered = priority.concat(list.filter((item) => !priority.includes(item)));
  ordered.forEach((candidate, index) => {
    const distance = levenshtein(target.toLowerCase(), candidate.toLowerCase());
    const penalty = index / 1000;
    const score = distance + penalty;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  });
  return best;
}

function preferredOutboundTag(tags) {
  return pickClosestString('', tags, ['direct', 'proxy', 'block']);
}

function jsonRangeForPointer(text, pointer) {
  const map = buildJsoncPointerMap(asString(text));
  const mapping = findDiagnosticMapping(map, cleanName(pointer));
  if (!mapping) return { from: 0, to: 1 };
  const from = Number.isFinite(mapping.valueFrom) ? Number(mapping.valueFrom) : Number(mapping.keyFrom || 0);
  const to = Number.isFinite(mapping.valueTo) ? Number(mapping.valueTo) : Number(mapping.keyTo || from + 1);
  return { from: Math.max(0, from), to: Math.max(Math.max(0, from) + 1, to) };
}

function modifyJsonText(text, path, value, meta) {
  let edits = [];
  try {
    edits = modifyJsonc(asString(text), Array.isArray(path) ? path : [], value, {
      formattingOptions: JSONC_FORMATTING_OPTIONS,
    });
  } catch (e) {
    edits = [];
  }
  return createQuickFix(meta, normalizeJsoncEdits(edits));
}

function jsonTransportProperty(network) {
  const raw = cleanName(network).toLowerCase();
  if (raw === 'ws') return 'wsSettings';
  if (raw === 'grpc') return 'grpcSettings';
  if (raw === 'httpupgrade') return 'httpupgradeSettings';
  return '';
}

function jsonTransportScaffold(network) {
  const raw = cleanName(network).toLowerCase();
  if (raw === 'ws' || raw === 'httpupgrade') return { path: '/' };
  if (raw === 'grpc') return { serviceName: 'grpc' };
  return {};
}

function collectXrayBalancerTags(data) {
  const root = isPlainObject(data && data.routing) ? data.routing : data;
  const balancers = Array.isArray(root && root.balancers) ? root.balancers : [];
  return uniqueStrings(balancers.map((item) => item && item.tag));
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

function buildXrayObservatoryScaffold(selectors) {
  const subjectSelector = uniqueStrings(selectors);
  return {
    subjectSelector: subjectSelector.length ? subjectSelector : ['proxy-'],
    probeUrl: DEFAULT_HEALTHCHECK_URL,
    probeInterval: '60s',
  };
}

function buildXrayBurstObservatoryScaffold(selectors) {
  const subjectSelector = uniqueStrings(selectors);
  return {
    subjectSelector: subjectSelector.length ? subjectSelector : ['proxy-'],
    pingConfig: {
      destination: '1.1.1.1:80',
      connectivity: DEFAULT_HEALTHCHECK_URL,
      interval: '30s',
      sampling: 5,
      timeout: '5s',
    },
  };
}

function collectXrayObservabilityQuickFixes(text, data, semanticOptions) {
  const fixes = [];
  const root = isPlainObject(data && data.routing) ? data.routing : data;
  const rootPath = root === data ? [] : ['routing'];
  const balancers = Array.isArray(root && root.balancers) ? root.balancers : [];
  const options = semanticOptions && typeof semanticOptions === 'object' ? semanticOptions : {};
  const hasObservatory = !!(
    isPlainObject(data && data.observatory)
    || isPlainObject(root && root.observatory)
    || isPlainObject(options.externalObservatory)
  );
  const hasBurstObservatory = !!(
    isPlainObject(data && data.burstObservatory)
    || isPlainObject(root && root.burstObservatory)
    || isPlainObject(options.externalBurstObservatory)
  );

  balancers.forEach((balancer, index) => {
    if (!isPlainObject(balancer)) return;
    const strategyType = cleanName(balancer && balancer.strategy && balancer.strategy.type) || 'random';
    const balancerPath = rootPath.concat('balancers', index);
    const range = jsonRangeForPointer(text, pointerFromPath(balancerPath.concat('strategy', 'type')));
    const selectors = uniqueStrings(Array.isArray(balancer.selector) ? balancer.selector : []);

    if (strategyType === 'leastPing' && !hasObservatory) {
      const fix = modifyJsonText(text, ['observatory'], buildXrayObservatoryScaffold(selectors), {
        id: `xray-observatory-add-${balancerPath.join('.')}`,
        title: 'Добавить блок `observatory`',
        code: 'balancer-observatory-missing',
        isPreferred: true,
        priority: 90,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
    }

    if (strategyType === 'leastLoad' && !hasBurstObservatory) {
      const fix = modifyJsonText(text, ['burstObservatory'], buildXrayBurstObservatoryScaffold(selectors), {
        id: `xray-burst-observatory-add-${balancerPath.join('.')}`,
        title: 'Добавить блок `burstObservatory`',
        code: 'balancer-burst-observatory-missing',
        isPreferred: true,
        priority: 90,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
    }
  });

  return fixes;
}

function walkJsonTree(value, path, visit) {
  if (Array.isArray(value)) {
    visit(path, value);
    value.forEach((item, index) => walkJsonTree(item, path.concat(index), visit));
    return;
  }
  if (isPlainObject(value)) {
    visit(path, value);
    Object.keys(value).forEach((key) => walkJsonTree(value[key], path.concat(key), visit));
    return;
  }
  visit(path, value);
}

function buildXraySchemaQuickFixes(text, data, schema) {
  if (!schema || data == null) return [];
  const fixes = [];
  let errors = [];
  try {
    errors = validateValue(data, schema, schema, '');
  } catch (e) {
    errors = [];
  }

  errors.forEach((item) => {
    const pointer = cleanName(item && item.pointer);
    const message = cleanName(item && item.message);
    if (!pointer || !message) return;
    const range = jsonRangeForPointer(text, pointer);
    const path = pathFromPointer(pointer);
    const currentValue = getValueAtPointer(data, pointer);
    const fieldMatch = message.match(/`([^`]+)`/);
    if (message.includes('отсутствует') && fieldMatch && path.length) {
      const propertyName = cleanName(fieldMatch[1]);
      const parentPath = path.slice(0, -1);
      const parentPointer = pointerFromPath(parentPath);
      const parentSchema = getSchemaAtPointer(schema, schema, parentPointer);
      const propertySchema = getObjectPropertySchema(parentSchema, propertyName, schema);
      const defaultValue = buildDefaultValueFromSchema(propertySchema, schema);
      const fix = modifyJsonText(text, parentPath.concat(propertyName), defaultValue, {
        id: `json-required-${parentPath.join('.')}-${propertyName}`,
        title: `Добавить поле \`${propertyName}\``,
        code: 'schema-required-missing',
        isPreferred: true,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'schema',
      });
      if (fix) fixes.push(fix);
      return;
    }

    const valueSchema = getSchemaAtPointer(schema, schema, pointer);
    const types = schemaTypeList(valueSchema, schema);
    if (types.includes('array') && !Array.isArray(currentValue) && currentValue !== undefined) {
      const fix = modifyJsonText(text, path, [cloneValue(currentValue)], {
        id: `json-array-wrap-${path.join('.')}`,
        title: 'Обернуть значение в массив',
        code: 'schema-wrap-array',
        isPreferred: true,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'schema',
      });
      if (fix) fixes.push(fix);
      return;
    }

    const resolvedSchema = resolveSchema(valueSchema, schema) || valueSchema;
    const deprecatedValues = Array.isArray(resolvedSchema && resolvedSchema.deprecatedValues) ? resolvedSchema.deprecatedValues : [];
    if (deprecatedValues.length && deprecatedValues.some((itemValue) => itemValue === currentValue)) {
      const replacement = (() => {
        const enumValues = Array.isArray(resolvedSchema && resolvedSchema.enum) ? resolvedSchema.enum : [];
        if (currentValue === 'grpc' && enumValues.includes('xhttp')) return 'xhttp';
        return enumValues.find((itemValue) => !deprecatedValues.includes(itemValue) && itemValue !== currentValue);
      })();
      if (replacement !== undefined && replacement !== null && replacement !== currentValue) {
        const fix = modifyJsonText(text, path, replacement, {
          id: `json-deprecated-${path.join('.')}`,
          title: `Заменить \`${currentValue}\` на \`${replacement}\``,
          code: 'schema-deprecated-value',
          isPreferred: true,
          rangeFrom: range.from,
          rangeTo: range.to,
          family: 'schema',
        });
        if (fix) fixes.push(fix);
      }
    }
  });

  walkJsonTree(data, [], (path, value) => {
    if (!isPlainObject(value) || !isPlainObject(value.streamSettings)) return;
    const network = cleanName(value.streamSettings.network);
    const property = jsonTransportProperty(network);
    if (!property || Object.prototype.hasOwnProperty.call(value.streamSettings, property)) return;
    const pointer = pointerFromPath(path.concat('streamSettings', 'network'));
    const range = jsonRangeForPointer(text, pointer);
    const fix = modifyJsonText(text, path.concat('streamSettings', property), jsonTransportScaffold(network), {
      id: `json-transport-${path.join('.')}-${property}`,
      title: `Добавить блок \`${property}\``,
      code: 'transport-block-missing',
      rangeFrom: range.from,
      rangeTo: range.to,
      family: 'transport',
    });
    if (fix) fixes.push(fix);
  });

  return fixes;
}

function buildXraySemanticQuickFixes(text, data, semanticOptions) {
  const fixes = [];
  const diagnostics = validateXrayConfigSemantics(data, semanticOptions || {});
  const outboundTags = uniqueStrings((semanticOptions && semanticOptions.knownOutboundTags) || []);
  const inboundTags = uniqueStrings((semanticOptions && semanticOptions.knownInboundTags) || []);
  const balancerTags = collectXrayBalancerTags(data);

  diagnostics.forEach((item) => {
    const code = cleanName(item && item.code);
    const pointer = cleanName(item && item.pointer);
    const path = pathFromPointer(pointer);
    const range = jsonRangeForPointer(text, pointer || '/');
    if (code === 'rule-missing-target' && path.length) {
      const tag = preferredOutboundTag(outboundTags);
      if (!tag) return;
      const fix = modifyJsonText(text, path.concat('outboundTag'), tag, {
        id: `xray-rule-target-${path.join('.')}`,
        title: `Добавить \`outboundTag: ${tag}\``,
        code,
        isPreferred: true,
        priority: 95,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if ((code === 'outbound-tag-missing' || code === 'balancer-tag-missing' || code === 'inbound-tag-missing') && path.length) {
      const current = cleanName(getValueAtPath(data, path));
      const pool = code === 'outbound-tag-missing'
        ? outboundTags
        : (code === 'balancer-tag-missing' ? balancerTags : inboundTags);
      const preferred = code === 'outbound-tag-missing' ? ['direct', 'proxy', 'block'] : [];
      const suggestion = pickClosestString(current, pool, preferred);
      if (!suggestion || suggestion === current) return;
      const fix = modifyJsonText(text, path, suggestion, {
        id: `xray-tag-replace-${code}-${path.join('.')}`,
        title: `Заменить на \`${suggestion}\``,
        code,
        isPreferred: true,
        priority: 95,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'balancer-selector-empty' && path.length) {
      const selectorTag = preferredOutboundTag(outboundTags);
      if (!selectorTag) return;
      const fix = modifyJsonText(text, path.concat('selector'), [selectorTag], {
        id: `xray-balancer-selector-${path.join('.')}`,
        title: `Добавить selector с \`${selectorTag}\``,
        code,
        isPreferred: true,
        priority: 90,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'balancer-observatory-missing' && path.length >= 2) {
      const balancerPath = path.slice(0, -2);
      const balancer = getValueAtPath(data, balancerPath);
      const selectors = uniqueStrings(Array.isArray(balancer && balancer.selector) ? balancer.selector : []);
      const fix = modifyJsonText(text, ['observatory'], buildXrayObservatoryScaffold(selectors), {
        id: `xray-observatory-add-${balancerPath.join('.')}`,
        title: 'Добавить блок `observatory`',
        code,
        isPreferred: true,
        priority: 90,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'balancer-burst-observatory-missing' && path.length >= 2) {
      const balancerPath = path.slice(0, -2);
      const balancer = getValueAtPath(data, balancerPath);
      const selectors = uniqueStrings(Array.isArray(balancer && balancer.selector) ? balancer.selector : []);
      const fix = modifyJsonText(text, ['burstObservatory'], buildXrayBurstObservatoryScaffold(selectors), {
        id: `xray-burst-observatory-add-${balancerPath.join('.')}`,
        title: 'Добавить блок `burstObservatory`',
        code,
        isPreferred: true,
        priority: 90,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'observatory-duplicates-external') {
      const fix = modifyJsonText(text, ['observatory'], undefined, {
        id: 'xray-observatory-remove-duplicate-external',
        title: 'Удалить локальный дубль `observatory`',
        code,
        isPreferred: true,
        priority: 100,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'outbound-tls-server-name-suggested' && path.length >= 2) {
      const itemPath = path.slice(0, -2);
      const itemValue = getValueAtPath(data, itemPath);
      const host = getXrayPrimaryEndpointHost(itemValue);
      if (!host || looksLikeIpLiteral(host)) return;
      const fix = modifyJsonText(text, path.concat('serverName'), host, {
        id: `xray-tls-servername-${path.join('.')}`,
        title: `Добавить \`serverName: ${host}\``,
        code,
        isPreferred: true,
        priority: 80,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'outbound-reality-server-name-missing' && path.length >= 2) {
      const itemPath = path.slice(0, -2);
      const itemValue = getValueAtPath(data, itemPath);
      const host = getXrayPrimaryEndpointHost(itemValue);
      if (!host || looksLikeIpLiteral(host)) return;
      const fix = modifyJsonText(text, path.concat('serverName'), host, {
        id: `xray-reality-servername-${path.join('.')}`,
        title: `Добавить \`serverName: ${host}\``,
        code,
        isPreferred: true,
        priority: 80,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'inbound-reality-shortids-missing' && path.length) {
      const fix = modifyJsonText(text, path.concat('shortIds'), [''], {
        id: `xray-reality-shortids-${path.join('.')}`,
        title: 'Добавить `shortIds: [""]`',
        code,
        isPreferred: true,
        priority: 85,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'private-ip-rule-not-first' && path.length >= 3) {
      const ruleIndex = path[path.length - 1];
      if (typeof ruleIndex !== 'number' || ruleIndex <= 0) return;
      const rulesPath = path.slice(0, -1);
      const rulesArray = getValueAtPath(data, rulesPath);
      if (!Array.isArray(rulesArray)) return;
      const ruleToMove = rulesArray[ruleIndex];
      if (!isPlainObject(ruleToMove)) return;
      let combined = [];
      try {
        const insertEdits = modifyJsonc(asString(text), rulesPath.concat(0), cloneValue(ruleToMove), {
          formattingOptions: JSONC_FORMATTING_OPTIONS,
          isArrayInsertion: true,
        });
        const deleteEdits = modifyJsonc(asString(text), rulesPath.concat(ruleIndex), undefined, {
          formattingOptions: JSONC_FORMATTING_OPTIONS,
        });
        combined = normalizeJsoncEdits([].concat(insertEdits, deleteEdits));
      } catch (e) {
        combined = [];
      }
      if (!combined.length) return;
      const fix = createQuickFix({
        id: `xray-private-ip-move-${path.join('.')}`,
        title: 'Переместить LAN-правило в начало routing.rules',
        code,
        isPreferred: true,
        priority: 100,
        rangeFrom: range.from,
        rangeTo: range.to,
        family: 'semantic',
      }, combined);
      if (fix) fixes.push(fix);
    }
  });

  fixes.push(...collectXrayObservabilityQuickFixes(text, data, semanticOptions));
  return fixes;
}

function resolveXraySemanticOptions(options, ctx) {
  const getter = options && typeof options.getSemanticOptions === 'function' ? options.getSemanticOptions : null;
  if (getter) {
    try { return getter(ctx) || {}; } catch (e) {}
  }
  if (options && typeof options.semanticOptions === 'object') return options.semanticOptions;
  return {};
}

function yamlIndent(text) {
  const raw = asString(text);
  return raw.length - raw.replace(/^\s+/, '').length;
}

function indentBlock(text, spaces) {
  const prefix = ' '.repeat(Math.max(0, Number(spaces || 0)));
  return asString(text).split('\n').map((line) => line ? `${prefix}${line}` : line).join('\n');
}

function yamlScalarLiteral(value) {
  if (typeof value === 'string') {
    if (value === '') return '""';
    if (/^[A-Za-z0-9_./@:-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return asString(value);
}

function findYamlToken(index, path, kind) {
  const target = Array.isArray(path) ? pathToString(path) : cleanName(path);
  const list = Array.isArray(index && index.tokens) ? index.tokens : [];
  let best = null;
  for (let itemIndex = 0; itemIndex < list.length; itemIndex += 1) {
    const item = list[itemIndex];
    if (!item || pathToString(item.path) !== target) continue;
    if (kind && cleanName(item.kind) !== cleanName(kind)) continue;
    if (!best || (item.to - item.from) < (best.to - best.from)) best = item;
  }
  return best;
}

function yamlValueReplacement(index, path, value) {
  const token = findYamlToken(index, path, 'value');
  if (!token) return null;
  if (Array.isArray(value) || isPlainObject(value)) {
    const keyPath = Array.isArray(path) ? path.slice() : splitPathString(path);
    const keyLocation = index && index.map ? index.map.get(pathToString(keyPath)) : null;
    const childIndent = Math.max(0, Number(keyLocation && keyLocation.column || 1) + 1);
    const dumped = dumpYaml(cloneValue(value), { noRefs: true, lineWidth: -1 }).trimEnd();
    return {
      from: token.from,
      to: token.to,
      insert: `\n${indentBlock(dumped, childIndent)}`,
    };
  }
  return {
    from: token.from,
    to: token.to,
    insert: yamlScalarLiteral(value),
  };
}

function yamlBlockInsertOffset(index, parentPath) {
  const path = Array.isArray(parentPath) ? parentPath : splitPathString(parentPath);
  if (!path.length) {
    return {
      offset: index && typeof index.normalized === 'string' ? index.normalized.length : 0,
      indent: 0,
    };
  }
  const location = index && index.map ? index.map.get(pathToString(path)) : null;
  if (!location) {
    return {
      offset: index && typeof index.normalized === 'string' ? index.normalized.length : 0,
      indent: 0,
    };
  }
  const parentIndent = Math.max(0, Number(location.column || 1) - 1);
  let insertLine = Math.max(0, Number(location.line || 1));
  const lines = Array.isArray(index && index.lines) ? index.lines : [];
  const starts = Array.isArray(index && index.starts) ? index.starts : [];
  while (insertLine < lines.length) {
    const raw = lines[insertLine];
    const trimmed = asString(raw).trim();
    if (!trimmed) {
      insertLine += 1;
      continue;
    }
    const indent = yamlIndent(raw);
    if (indent <= parentIndent) break;
    insertLine += 1;
  }
  return {
    offset: insertLine < starts.length ? starts[insertLine] : (index && typeof index.normalized === 'string' ? index.normalized.length : 0),
    indent: parentIndent + 2,
  };
}

function buildYamlMappingEntry(key, value, indent) {
  const dumped = dumpYaml({ [key]: cloneValue(value) }, { noRefs: true, lineWidth: -1 }).trimEnd();
  return indentBlock(dumped, indent);
}

function buildYamlArrayItems(items, indent) {
  const dumped = dumpYaml(Array.isArray(items) ? cloneValue(items) : [], { noRefs: true, lineWidth: -1 }).trimEnd();
  return indentBlock(dumped, indent);
}

function insertYamlMappingEntry(text, index, parentPath, key, value, meta) {
  const source = asString(text);
  const parent = Array.isArray(parentPath) ? parentPath : splitPathString(parentPath);
  if (!parent.length) {
    const body = buildYamlMappingEntry(key, value, 0);
    const prefix = source.trim() ? (source.endsWith('\n') ? '\n' : '\n\n') : '';
    return createQuickFix(meta, [{
      from: source.length,
      to: source.length,
      insert: `${prefix}${body}\n`,
    }]);
  }

  if (parent.length === 1 && !(index && index.map && index.map.has(pathToString(parent)))) {
    const dumped = dumpYaml({ [parent[0]]: { [key]: cloneValue(value) } }, { noRefs: true, lineWidth: -1 }).trimEnd();
    const prefix = source.trim() ? (source.endsWith('\n') ? '\n' : '\n\n') : '';
    return createQuickFix(meta, [{
      from: source.length,
      to: source.length,
      insert: `${prefix}${dumped}\n`,
    }]);
  }

  const insertAt = yamlBlockInsertOffset(index, parent);
  const entry = `${buildYamlMappingEntry(key, value, insertAt.indent)}\n`;
  const prefix = insertAt.offset > 0 && source.charAt(insertAt.offset - 1) !== '\n' ? '\n' : '';
  return createQuickFix(meta, [{
    from: insertAt.offset,
    to: insertAt.offset,
    insert: `${prefix}${entry}`,
  }]);
}

function insertYamlArrayItem(text, index, sectionName, value, meta) {
  const source = asString(text);
  const sectionPath = [cleanName(sectionName)];
  const hasSection = !!(index && index.map && index.map.has(pathToString(sectionPath)));
  if (!hasSection) {
    const dumped = dumpYaml({ [sectionName]: [cloneValue(value)] }, { noRefs: true, lineWidth: -1 }).trimEnd();
    const prefix = source.trim() ? (source.endsWith('\n') ? '\n' : '\n\n') : '';
    return createQuickFix(meta, [{
      from: source.length,
      to: source.length,
      insert: `${prefix}${dumped}\n`,
    }]);
  }
  const insertAt = yamlBlockInsertOffset(index, sectionPath);
  const entry = `${buildYamlArrayItems([value], insertAt.indent)}\n`;
  const prefix = insertAt.offset > 0 && source.charAt(insertAt.offset - 1) !== '\n' ? '\n' : '';
  return createQuickFix(meta, [{
    from: insertAt.offset,
    to: insertAt.offset,
    insert: `${prefix}${entry}`,
  }]);
}

function replaceYamlValue(text, index, path, value, meta) {
  const edit = yamlValueReplacement(index, path, value);
  if (!edit) return null;
  return createQuickFix(meta, [edit]);
}

function upsertYamlMappingEntry(text, index, data, parentPath, key, value, meta) {
  const basePath = Array.isArray(parentPath) ? parentPath.slice() : splitPathString(parentPath);
  const targetPath = basePath.concat(key);
  const currentValue = getValueAtPath(data, targetPath);
  if (currentValue !== undefined) {
    const replaced = replaceYamlValue(text, index, targetPath, value, meta);
    if (replaced) return replaced;
  }
  return insertYamlMappingEntry(text, index, basePath, key, value, meta);
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

function resolveMihomoRuleTargetIndex(parts) {
  const skip = {
    'no-resolve': true,
    src: true,
    dst: true,
  };
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const token = cleanName(parts[index]);
    if (!token) continue;
    if (skip[token.toLowerCase()]) continue;
    return index;
  }
  return -1;
}

function extractRuleSetNames(rule) {
  const names = [];
  const pattern = /\bRULE-SET,([^,\s)]+)/g;
  const text = cleanName(rule);
  let match;
  while ((match = pattern.exec(text))) {
    const name = cleanName(match[1]);
    if (name) names.push(name);
  }
  return uniqueStrings(names);
}

function mihomoTargetNames(data) {
  const proxies = Array.isArray(data && data.proxies) ? data.proxies : [];
  const groups = Array.isArray(data && data['proxy-groups']) ? data['proxy-groups'] : [];
  return uniqueStrings(
    proxies.map((item) => item && item.name).concat(groups.map((item) => item && item.name))
  );
}

function mihomoProviderNames(data, section) {
  const map = isPlainObject(data && data[section]) ? data[section] : {};
  return uniqueStrings(Object.keys(map));
}

function mihomoTransportProperty(network) {
  const raw = cleanName(network).toLowerCase();
  if (raw === 'ws') return 'ws-opts';
  if (raw === 'grpc') return 'grpc-opts';
  if (raw === 'h2') return 'h2-opts';
  if (raw === 'xhttp') return 'xhttp-opts';
  return '';
}

function mihomoTransportScaffold(network) {
  const raw = cleanName(network).toLowerCase();
  if (raw === 'ws') return { path: '/' };
  if (raw === 'grpc') return { 'grpc-service-name': 'grpc' };
  if (raw === 'h2') return { path: '/' };
  if (raw === 'xhttp') return { path: '/', mode: 'stream-one' };
  return {};
}

function buildMihomoRuleProviderSkeleton(name) {
  const safe = cleanName(name) || 'ruleset';
  return {
    type: 'http',
    behavior: 'domain',
    format: 'mrs',
    url: `https://example.invalid/${encodeURIComponent(safe)}.mrs`,
    interval: DEFAULT_PROVIDER_INTERVAL,
  };
}

function buildMihomoProxyProviderSkeleton(name) {
  const safe = cleanName(name) || 'provider';
  return {
    type: 'http',
    url: `https://example.invalid/${encodeURIComponent(safe)}.yaml`,
    path: `./providers/${safe.replace(/[^A-Za-z0-9._-]+/g, '_')}.yaml`,
    interval: DEFAULT_PROVIDER_INTERVAL,
    'health-check': {
      enable: true,
      url: DEFAULT_HEALTHCHECK_URL,
      interval: 300,
    },
  };
}

function buildMihomoProxyGroupSkeleton(name) {
  return {
    name: cleanName(name) || 'AutoGroup',
    type: 'select',
    proxies: ['DIRECT'],
  };
}

function suggestMihomoServerName(proxy) {
  if (!isPlainObject(proxy)) return '';
  const wsHost = cleanName(proxy && proxy['ws-opts'] && proxy['ws-opts'].headers && proxy['ws-opts'].headers.Host);
  if (wsHost) return wsHost;
  const xhttpHost = cleanName(proxy && proxy['xhttp-opts'] && proxy['xhttp-opts'].host);
  if (xhttpHost) return xhttpHost;
  const h2Hosts = Array.isArray(proxy && proxy['h2-opts'] && proxy['h2-opts'].host)
    ? proxy['h2-opts'].host.map(cleanName).filter(Boolean)
    : [];
  if (h2Hosts.length) return h2Hosts[0];
  const server = cleanName(proxy && proxy.server);
  if (server && !looksLikeIpLiteral(server)) return server;
  return '';
}

function buildMihomoSchemaQuickFixes(text, data, schema) {
  if (!schema) return [];
  const fixes = [];
  let result = null;
  try {
    result = validateYamlTextAgainstSchema(text, schema, { maxErrors: 60 });
  } catch (e) {
    result = null;
  }
  const index = buildYamlPathLocationMap(text);
  const diagnostics = result && Array.isArray(result.diagnostics) ? result.diagnostics : [];

  diagnostics.forEach((item) => {
    const path = splitPathString(item && item.path);
    const message = cleanName(item && item.message);
    const fieldMatch = message.match(/`([^`]+)`/);
    const rangeFrom = Math.max(0, Number(item && item.from || 0));
    const rangeTo = Math.max(rangeFrom + 1, Number(item && item.to || rangeFrom + 1));
    if (fieldMatch && message.toLowerCase().includes('обяз')) {
      const field = cleanName(fieldMatch[1]);
      const parentSchema = resolveSchemaAtPath(schema, path, data, schema);
      const propertySchema = getObjectPropertySchema(parentSchema, field, schema);
      const defaultValue = buildDefaultValueFromSchema(propertySchema, schema);
      const fix = insertYamlMappingEntry(text, index, path, field, defaultValue, {
        id: `yaml-required-${path.join('.')}-${field}`,
        title: `Добавить поле \`${field}\``,
        code: 'schema-required-missing',
        isPreferred: true,
        rangeFrom,
        rangeTo,
        family: 'schema',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (path.length) {
      const valueSchema = resolveSchemaAtPath(schema, path, data, schema);
      const types = schemaTypeList(valueSchema, schema);
      const currentValue = getValueAtPath(data, path);
      if (types.includes('array') && currentValue !== undefined && !Array.isArray(currentValue)) {
        const fix = replaceYamlValue(text, index, path, [cloneValue(currentValue)], {
          id: `yaml-array-${path.join('.')}`,
          title: 'Обернуть значение в список',
          code: 'schema-wrap-array',
          isPreferred: true,
          rangeFrom,
          rangeTo,
          family: 'schema',
        });
        if (fix) fixes.push(fix);
      }
    }
  });

  (Array.isArray(data && data.proxies) ? data.proxies : []).forEach((proxy, proxyIndex) => {
    if (!isPlainObject(proxy)) return;
    const network = cleanName(proxy.network);
    const property = mihomoTransportProperty(network);
    if (!property || Object.prototype.hasOwnProperty.call(proxy, property)) return;
    const path = ['proxies', proxyIndex, 'network'];
    const token = findYamlToken(index, path, 'value');
    const rangeFrom = token ? token.from : 0;
    const rangeTo = token ? token.to : 1;
    const fix = insertYamlMappingEntry(text, index, ['proxies', proxyIndex], property, mihomoTransportScaffold(network), {
      id: `yaml-transport-${proxyIndex}-${property}`,
      title: `Добавить блок \`${property}\``,
      code: 'transport-block-missing',
      rangeFrom,
      rangeTo,
      family: 'transport',
    });
    if (fix) fixes.push(fix);
  });

  const valuePaths = Array.isArray(index && index.tokens)
    ? index.tokens.filter((token) => token && token.kind === 'value').map((token) => token.path)
    : [];
  valuePaths.forEach((path) => {
    const schemaAtPath = resolveSchemaAtPath(schema, path, data, schema);
    const currentValue = getValueAtPath(data, path);
    const resolvedSchema = resolveSchema(schemaAtPath, schema) || schemaAtPath;
    const deprecatedValues = Array.isArray(resolvedSchema && resolvedSchema.deprecatedValues) ? resolvedSchema.deprecatedValues : [];
    if (!deprecatedValues.length || !deprecatedValues.some((item) => item === currentValue)) return;
    const enumValues = Array.isArray(resolvedSchema && resolvedSchema.enum) ? resolvedSchema.enum : [];
    const replacement = currentValue === 'grpc' && enumValues.includes('xhttp')
      ? 'xhttp'
      : enumValues.find((item) => !deprecatedValues.includes(item) && item !== currentValue);
    if (replacement === undefined || replacement === currentValue) return;
    const token = findYamlToken(index, path, 'value');
    const rangeFrom = token ? token.from : 0;
    const rangeTo = token ? token.to : 1;
    const fix = replaceYamlValue(text, index, path, replacement, {
      id: `yaml-deprecated-${path.join('.')}`,
      title: `Заменить \`${currentValue}\` на \`${replacement}\``,
      code: 'schema-deprecated-value',
      isPreferred: true,
      rangeFrom,
      rangeTo,
      family: 'schema',
    });
    if (fix) fixes.push(fix);
  });

  return fixes;
}

function buildMihomoSemanticQuickFixes(text, data) {
  const fixes = [];
  const index = buildYamlPathLocationMap(text);
  const diagnostics = validateMihomoConfigSemantics(data, {});
  const targetNames = mihomoTargetNames(data);
  const proxyProviderNames = mihomoProviderNames(data, 'proxy-providers');
  const ruleProviderNames = mihomoProviderNames(data, 'rule-providers');

  diagnostics.forEach((item) => {
    const code = cleanName(item && item.code);
    const path = Array.isArray(item && item.path) ? item.path.slice() : [];
    const pathString = pathToString(path);
    const token = findYamlToken(index, path, 'value');
    const rangeFrom = token ? token.from : ((index.map && index.map.get(pathString)) ? index.map.get(pathString).offset : 0);
    const rangeTo = token ? token.to : Math.max(rangeFrom + 1, rangeFrom);

    if ((code === 'proxy-provider-proxy-missing' || code === 'rule-provider-proxy-missing' || code === 'proxy-group-target-missing') && path.length) {
      const current = cleanName(getValueAtPath(data, path));
      const suggestion = pickClosestString(current, targetNames, ['DIRECT']);
      if (!suggestion || suggestion === current) return;
      const fix = replaceYamlValue(text, index, path, suggestion, {
        id: `mihomo-replace-${code}-${path.join('.')}`,
        title: `Заменить на \`${suggestion}\``,
        code,
        isPreferred: true,
        priority: 95,
        rangeFrom,
        rangeTo,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'proxy-group-provider-missing' && path.length) {
      const current = cleanName(getValueAtPath(data, path));
      const suggestion = pickClosestString(current, proxyProviderNames);
      if (suggestion && suggestion !== current) {
        const replaceFix = replaceYamlValue(text, index, path, suggestion, {
          id: `mihomo-provider-replace-${path.join('.')}`,
          title: `Заменить provider на \`${suggestion}\``,
          code,
          isPreferred: true,
          priority: 90,
          rangeFrom,
          rangeTo,
          family: 'semantic',
        });
        if (replaceFix) fixes.push(replaceFix);
      }
      if (current) {
        const createFix = insertYamlMappingEntry(text, index, ['proxy-providers'], current, buildMihomoProxyProviderSkeleton(current), {
          id: `mihomo-provider-create-${current}`,
          title: `Создать proxy-provider \`${current}\``,
          code,
          rangeFrom,
          rangeTo,
          family: 'semantic',
        });
        if (createFix) fixes.push(createFix);
      }
      return;
    }

    if (code === 'rule-provider-missing' && path.length) {
      const ruleText = cleanName(getValueAtPath(data, path));
      const providers = extractRuleSetNames(ruleText);
      const missing = providers.find((name) => !ruleProviderNames.includes(name)) || providers[0] || '';
      const suggestion = pickClosestString(missing, ruleProviderNames);
      if (missing && suggestion && suggestion !== missing) {
        const parts = splitTopLevelRuleParts(ruleText);
        if (parts.length >= 2) {
          parts[1] = suggestion;
          const replaceFix = replaceYamlValue(text, index, path, parts.join(','), {
            id: `mihomo-ruleset-replace-${path.join('.')}`,
            title: `Заменить rule-provider на \`${suggestion}\``,
            code,
            isPreferred: true,
            priority: 90,
            rangeFrom,
            rangeTo,
            family: 'semantic',
          });
          if (replaceFix) fixes.push(replaceFix);
        }
      }
      if (missing) {
        const createFix = insertYamlMappingEntry(text, index, ['rule-providers'], missing, buildMihomoRuleProviderSkeleton(missing), {
          id: `mihomo-ruleset-create-${missing}`,
          title: `Создать rule-provider \`${missing}\``,
          code,
          rangeFrom,
          rangeTo,
          family: 'semantic',
        });
        if (createFix) fixes.push(createFix);
      }
      return;
    }

    if ((code === 'rule-target-missing' || code === 'rule-target-not-found') && path.length) {
      const ruleText = cleanName(getValueAtPath(data, path));
      const parts = splitTopLevelRuleParts(ruleText);
      const targetIndex = resolveMihomoRuleTargetIndex(parts);
      const current = targetIndex >= 0 ? cleanName(parts[targetIndex]) : '';
      const suggestion = pickClosestString(current, targetNames, ['DIRECT']);
      if (targetIndex >= 0 && suggestion && suggestion !== current) {
        const nextParts = parts.slice();
        nextParts[targetIndex] = suggestion;
        const replaceFix = replaceYamlValue(text, index, path, nextParts.join(','), {
          id: `mihomo-rule-target-${path.join('.')}`,
          title: `Заменить target на \`${suggestion}\``,
          code,
          isPreferred: true,
          priority: 90,
          rangeFrom,
          rangeTo,
          family: 'semantic',
        });
        if (replaceFix) fixes.push(replaceFix);
      }
      if (current && !suggestion) {
        const createFix = insertYamlArrayItem(text, index, 'proxy-groups', buildMihomoProxyGroupSkeleton(current), {
          id: `mihomo-create-group-${current}`,
          title: `Создать proxy-group \`${current}\``,
          code,
          rangeFrom,
          rangeTo,
          family: 'semantic',
        });
        if (createFix) fixes.push(createFix);
      }
      return;
    }

    if ((code === 'proxy-provider-missing-url' || code === 'rule-provider-missing-url' || code === 'proxy-provider-missing-path' || code === 'rule-provider-missing-path' || code === 'proxy-provider-missing-payload' || code === 'rule-provider-missing-payload' || code === 'proxy-provider-missing-interval-warning' || code === 'rule-provider-missing-interval-warning') && path.length) {
      const field = code.endsWith('missing-url') ? 'url'
        : code.endsWith('missing-path') ? 'path'
        : code.endsWith('missing-payload') ? 'payload'
        : 'interval';
      const name = typeof path[path.length - 1] === 'string' ? String(path[path.length - 1]) : '';
      const section = cleanName(path[0]);
      const defaults = field === 'url'
        ? `https://example.invalid/${encodeURIComponent(name || 'provider')}.${section === 'rule-providers' ? 'mrs' : 'yaml'}`
        : field === 'path'
          ? `./providers/${(name || 'provider').replace(/[^A-Za-z0-9._-]+/g, '_')}.${section === 'rule-providers' ? 'mrs' : 'yaml'}`
          : field === 'payload'
            ? []
            : DEFAULT_PROVIDER_INTERVAL;
      const fix = insertYamlMappingEntry(text, index, path, field, defaults, {
        id: `mihomo-provider-field-${path.join('.')}-${field}`,
        title: `Добавить поле \`${field}\``,
        code,
        isPreferred: field === 'interval',
        rangeFrom,
        rangeTo,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code.startsWith('proxy-tls-') && path.length >= 2) {
      const proxyPath = path.slice(0, -1);
      const fix = upsertYamlMappingEntry(text, index, data, proxyPath, 'tls', true, {
        id: `mihomo-proxy-tls-${path.join('.')}`,
        title: 'Включить `tls: true`',
        code,
        isPreferred: true,
        priority: 85,
        rangeFrom,
        rangeTo,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'proxy-group-empty' && path.length) {
      const fix = insertYamlMappingEntry(text, index, path, 'proxies', ['DIRECT'], {
        id: `mihomo-group-empty-${path.join('.')}`,
        title: 'Добавить `proxies: [DIRECT]`',
        code,
        isPreferred: true,
        priority: 85,
        rangeFrom,
        rangeTo,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'proxy-group-missing-url' && path.length) {
      const fix = insertYamlMappingEntry(text, index, path, 'url', DEFAULT_HEALTHCHECK_URL, {
        id: `mihomo-group-url-${path.join('.')}`,
        title: `Добавить \`url: ${DEFAULT_HEALTHCHECK_URL}\``,
        code,
        isPreferred: true,
        priority: 80,
        rangeFrom,
        rangeTo,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
      return;
    }

    if (code === 'proxy-servername-suggested' && path.length >= 2) {
      const proxyPath = path.slice(0, -1);
      const proxy = getValueAtPath(data, proxyPath);
      const serverName = suggestMihomoServerName(proxy);
      if (!serverName) return;
      const fix = upsertYamlMappingEntry(text, index, data, proxyPath, 'servername', serverName, {
        id: `mihomo-servername-${path.join('.')}`,
        title: `Добавить \`servername: ${serverName}\``,
        code,
        isPreferred: true,
        priority: 80,
        rangeFrom,
        rangeTo,
        family: 'semantic',
      });
      if (fix) fixes.push(fix);
    }
  });

  return fixes;
}

function resolveQuickFixGetter(provider) {
  if (!provider) return null;
  if (typeof provider === 'function') return provider;
  if (provider && typeof provider.getQuickFixes === 'function') return (ctx) => provider.getQuickFixes(ctx);
  return null;
}

export function getQuickFixesFromProvider(provider, ctx) {
  const getter = resolveQuickFixGetter(provider);
  if (!getter) return [];
  try {
    const list = getter(ctx || {});
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function createXrayQuickFixProvider(options = {}) {
  return {
    kind: 'xray',
    getQuickFixes(ctx = {}) {
      const text = asString(ctx.text);
      if (!cleanName(text)) return [];
      const data = safeParseJson(text);
      if (data == null) return [];
      const schema = ctx.schema || null;
      const semanticOptions = resolveXraySemanticOptions(options, ctx);
      const fixes = []
        .concat(buildXraySemanticQuickFixes(text, data, semanticOptions))
        .concat(buildXraySchemaQuickFixes(text, data, schema));
      return finalizeQuickFixes(fixes, ctx);
    },
  };
}

export function createMihomoQuickFixProvider(options = {}) {
  return {
    kind: 'mihomo',
    getQuickFixes(ctx = {}) {
      const text = asString(ctx.text);
      if (!cleanName(text)) return [];
      let data;
      try {
        data = loadYaml(text);
      } catch (e) {
        data = undefined;
      }
      if (data == null) return [];
      const schema = ctx.schema || (ctx.yamlAssist && typeof ctx.yamlAssist.getSchema === 'function'
        ? ctx.yamlAssist.getSchema()
        : (ctx.yamlAssist && ctx.yamlAssist.schema ? ctx.yamlAssist.schema : null));
      const fixes = []
        .concat(buildMihomoSemanticQuickFixes(text, data))
        .concat(buildMihomoSchemaQuickFixes(text, data, schema));
      return finalizeQuickFixes(fixes, ctx);
    },
  };
}

export const schemaQuickFixApi = Object.freeze({
  applyTextEdits,
  applyQuickFixText,
  createXrayQuickFixProvider,
  createMihomoQuickFixProvider,
  getQuickFixesFromProvider,
});
