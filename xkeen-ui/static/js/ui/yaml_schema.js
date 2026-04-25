import { load as loadYaml } from 'js-yaml';
import { validateMihomoConfigSemantics } from './schema_semantic_validation.js';

function asString(value) {
  return value == null ? '' : String(value);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathToString(path) {
  const parts = Array.isArray(path) ? path : [];
  let out = '';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === 'number') {
      out += `[${part}]`;
    } else if (out) {
      out += `.${part}`;
    } else {
      out = String(part || '');
    }
  }
  return out;
}

function pathLabel(path) {
  const value = pathToString(path);
  return value || '(корень)';
}

function pathWithKey(path, key) {
  return (Array.isArray(path) ? path : []).concat([String(key || '')]);
}

function pathWithIndex(path, index) {
  return (Array.isArray(path) ? path : []).concat([Math.max(0, Number(index || 0))]);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (let index = 0; index < aKeys.length; index += 1) {
      const key = aKeys[index];
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function typeLabels() {
  return {
    string: 'строка',
    integer: 'целое число',
    number: 'число',
    boolean: 'boolean',
    array: 'список',
    object: 'объект',
    null: 'null',
  };
}

function actualTypeLabel(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'список';
  if (Number.isInteger(value)) return 'целое число';
  if (typeof value === 'number') return 'число';
  if (typeof value === 'string') return 'строка';
  if (typeof value === 'boolean') return 'boolean';
  if (isPlainObject(value)) return 'объект';
  return typeof value;
}

function normalizeTypeList(rawType) {
  if (Array.isArray(rawType)) return rawType.map((item) => String(item || '')).filter(Boolean);
  if (typeof rawType === 'string' && rawType.trim()) return [rawType.trim()];
  return [];
}

function formatTypeList(rawType) {
  const labels = typeLabels();
  const values = normalizeTypeList(rawType).map((item) => labels[item] || item);
  if (!values.length) return 'значение';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} или ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} или ${values[values.length - 1]}`;
}

function typeMatches(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function isSchemaLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchema(schema, rootSchema) {
  let current = schema;
  let guard = 0;
  while (isSchemaLike(current) && typeof current.$ref === 'string' && guard < 24) {
    guard += 1;
    const ref = String(current.$ref || '');
    if (!ref.startsWith('#/')) break;
    const parts = ref.slice(2).split('/').map((part) => decodeURIComponent(part));
    let next = rootSchema;
    for (let index = 0; index < parts.length; index += 1) {
      const key = parts[index];
      if (!next || typeof next !== 'object' || !Object.prototype.hasOwnProperty.call(next, key)) {
        next = null;
        break;
      }
      next = next[key];
    }
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function stripYamlComment(text) {
  const raw = asString(text);
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw.charAt(index);
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '#') return raw.slice(0, index);
  }
  return raw;
}

function unquoteYamlKey(key) {
  const raw = asString(key).trim();
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function splitYamlKeyValue(text) {
  const raw = asString(text);
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw.charAt(index);
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === ':') {
      const rawKeyPart = raw.slice(0, index);
      const rawKey = rawKeyPart.trim();
      if (!rawKey) return null;
      const tail = raw.slice(index + 1);
      const commentlessTail = stripYamlComment(tail);
      const trimmedTail = commentlessTail.replace(/\s+$/, '');
      const leading = trimmedTail.match(/^\s*/);
      const valueOffset = leading ? leading[0].length : 0;
      const value = trimmedTail.slice(valueOffset);
      const keyStart = rawKeyPart.search(/\S/);
      return {
        key: unquoteYamlKey(rawKey),
        rawKey,
        keyStart: keyStart >= 0 ? keyStart : 0,
        keyEnd: index,
        delimiterIndex: index,
        hasInlineValue: value !== '',
        value,
        rawValue: value,
        valueStart: index + 1 + valueOffset,
        valueEnd: index + 1 + trimmedTail.length,
      };
    }
  }
  return null;
}

function lineStartOffsets(text) {
  const normalized = asString(text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const starts = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts.push(offset);
    offset += lines[index].length + 1;
  }
  return { normalized, lines, starts };
}

function buildYamlPathLocationMap(text) {
  const { normalized, lines, starts } = lineStartOffsets(text);
  const map = new Map();
  const tokens = [];
  const stack = [{ indent: -1, path: [], type: 'object', nextIndex: 0 }];

  function lineOffsetAt(line) {
    return starts[Math.max(0, Number(line || 1) - 1)] || 0;
  }

  function record(path, line, column, length) {
    const key = pathToString(path);
    if (!key || map.has(key)) return;
    const safeLine = Math.max(1, Number(line || 1));
    const safeColumn = Math.max(1, Number(column || 1));
    const lineOffset = lineOffsetAt(safeLine);
    map.set(key, {
      line: safeLine,
      column: safeColumn,
      length: Math.max(1, Number(length || 1)),
      offset: lineOffset + safeColumn - 1,
    });
  }

  function addToken(kind, path, line, column, length, extra) {
    const safeLine = Math.max(1, Number(line || 1));
    const safeColumn = Math.max(1, Number(column || 1));
    const safeLength = Math.max(1, Number(length || 1));
    const lineOffset = lineOffsetAt(safeLine);
    tokens.push({
      kind: asString(kind),
      path: Array.isArray(path) ? path.slice() : [],
      line: safeLine,
      column: safeColumn,
      length: safeLength,
      from: lineOffset + safeColumn - 1,
      to: lineOffset + safeColumn - 1 + safeLength,
      ...(extra || {}),
    });
  }

  function resolvePending(currentIndent, startsWithDash) {
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (top.type !== 'pending') break;
      if (currentIndent > top.indent) {
        top.type = startsWithDash ? 'array' : 'object';
        top.nextIndex = 0;
        break;
      }
      stack.pop();
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = rawLine.length - rawLine.replace(/^\s+/, '').length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    resolvePending(indent, trimmed.startsWith('-'));

    let parent = stack[stack.length - 1];
    if (!parent) parent = stack[0];

    if (trimmed.startsWith('-')) {
      if (parent.type !== 'array') {
        parent = { indent: indent - 1, path: parent.path.slice(), type: 'array', nextIndex: 0 };
        stack.push(parent);
      }
      const itemIndex = Math.max(0, Number(parent.nextIndex || 0));
      parent.nextIndex = itemIndex + 1;
      const itemPath = pathWithIndex(parent.path, itemIndex);
      const hyphenOffset = rawLine.indexOf('-', indent);
      record(itemPath, lineIndex + 1, hyphenOffset + 1, 1);

      const rest = rawLine.slice(hyphenOffset + 1);
      if (!rest.trim()) {
        stack.push({ indent, path: itemPath, type: 'pending', nextIndex: 0 });
        continue;
      }

      const kv = splitYamlKeyValue(rest);
      if (kv) {
        const itemObject = { indent, path: itemPath, type: 'object', nextIndex: 0 };
        stack.push(itemObject);
        const keyColumnIndex = hyphenOffset + 1 + kv.keyStart;
        const keyPath = pathWithKey(itemPath, kv.key);
        record(keyPath, lineIndex + 1, keyColumnIndex + 1, kv.rawKey.length);
        addToken('key', keyPath, lineIndex + 1, keyColumnIndex + 1, kv.rawKey.length, { key: kv.key });
        if (kv.hasInlineValue) {
          const valueLength = Math.max(1, kv.valueEnd - kv.valueStart);
          addToken('value', keyPath, lineIndex + 1, hyphenOffset + 1 + kv.valueStart + 1, valueLength, { rawValue: kv.rawValue });
        }
        if (!kv.hasInlineValue) {
          stack.push({ indent: keyColumnIndex, path: keyPath, type: 'pending', nextIndex: 0 });
        }
        continue;
      }

      const scalar = stripYamlComment(rest).trim();
      if (scalar) {
        const leading = rest.match(/^\s*/);
        const valueColumnIndex = hyphenOffset + 1 + (leading ? leading[0].length : 0);
        addToken('value', itemPath, lineIndex + 1, valueColumnIndex + 1, Math.max(1, scalar.length), { rawValue: scalar });
      }
      continue;
    }

    const content = rawLine.slice(indent);
    const kv = splitYamlKeyValue(content);
    if (!kv) continue;

    const keyPath = pathWithKey(parent.path, kv.key);
    const keyColumnIndex = indent + kv.keyStart;
    record(keyPath, lineIndex + 1, keyColumnIndex + 1, kv.rawKey.length);
    addToken('key', keyPath, lineIndex + 1, keyColumnIndex + 1, kv.rawKey.length, { key: kv.key });
    if (kv.hasInlineValue) {
      const valueLength = Math.max(1, kv.valueEnd - kv.valueStart);
      addToken('value', keyPath, lineIndex + 1, indent + kv.valueStart + 1, valueLength, { rawValue: kv.rawValue });
    }
    if (!kv.hasInlineValue) {
      stack.push({ indent: keyColumnIndex, path: keyPath, type: 'pending', nextIndex: 0 });
    }
  }

  return { normalized, lines, starts, map, tokens };
}

function findLocation(index, path) {
  const pathParts = Array.isArray(path) ? path.slice() : [];
  for (let size = pathParts.length; size >= 0; size -= 1) {
    const key = pathToString(pathParts.slice(0, size));
    if (key && index.map.has(key)) return index.map.get(key);
  }
  return { line: 1, column: 1, offset: 0, length: 1 };
}

function makeDiagnostic(index, error) {
  const location = findLocation(index, error && error.path ? error.path : []);
  const message = asString(error && error.message);
  return {
    from: Math.max(0, Number(location.offset || 0)),
    to: Math.max(1, Number(location.offset || 0) + Math.max(1, Number(location.length || 1))),
    line: Math.max(1, Number(location.line || 1)),
    column: Math.max(1, Number(location.column || 1)),
    length: Math.max(1, Number(location.length || 1)),
    severity: asString(error && error.severity) || 'error',
    message,
    source: asString(error && error.source) || 'mihomo-schema',
    path: pathToString(error && error.path ? error.path : []),
  };
}

function valuePreview(value) {
  if (typeof value === 'string') return `\`${value}\``;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'список';
  if (isPlainObject(value)) return 'объект';
  return actualTypeLabel(value);
}

function validateUnion(value, schemas, ctx, path) {
  let best = null;
  for (let index = 0; index < schemas.length; index += 1) {
    const errors = validateNode(value, schemas[index], ctx, path);
    if (!errors.length) return [];
    if (!best || errors.length < best.length) best = errors;
  }
  return best || [{
    path,
    message: `Значение не соответствует ожидаемой схеме (путь ${pathLabel(path)}).`,
  }];
}

function validateNode(value, rawSchema, ctx, path) {
  const schema = resolveSchema(rawSchema, ctx.rootSchema);
  if (!schema || typeof schema !== 'object') return [];

  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    return validateUnion(value, schema.oneOf, ctx, path);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    return validateUnion(value, schema.anyOf, ctx, path);
  }

  const errors = [];
  const typeList = normalizeTypeList(schema.type);
  if (typeList.length && !typeList.some((type) => typeMatches(value, type))) {
    return [{
      path,
      message: `Ожидается ${formatTypeList(typeList)}, получено ${actualTypeLabel(value)} (путь ${pathLabel(path)}).`,
    }];
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    const matched = schema.enum.some((item) => deepEqual(item, value));
    if (!matched) {
      errors.push({
        path,
        message: `Недопустимое значение ${valuePreview(value)}: ожидается одно из ${schema.enum.map((item) => valuePreview(item)).join(', ')} (путь ${pathLabel(path)}).`,
      });
      return errors;
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(schema.const, value)) {
    errors.push({
      path,
      message: `Значение должно быть ${valuePreview(schema.const)} (путь ${pathLabel(path)}).`,
    });
    return errors;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({
        path,
        message: `Значение должно быть не меньше ${schema.minimum} (путь ${pathLabel(path)}).`,
      });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({
        path,
        message: `Значение должно быть не больше ${schema.maximum} (путь ${pathLabel(path)}).`,
      });
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(...validateNode(value[index], schema.items, ctx, pathWithIndex(path, index)));
      if (errors.length >= ctx.maxErrors) return errors.slice(0, ctx.maxErrors);
    }
    return errors.slice(0, ctx.maxErrors);
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const dependentRequired = isPlainObject(schema.dependentRequired) ? schema.dependentRequired : {};

    for (let index = 0; index < required.length; index += 1) {
      const key = String(required[index] || '');
      if (!key || Object.prototype.hasOwnProperty.call(value, key)) continue;
      errors.push({
        path,
        message: `Не хватает обязательного поля \`${key}\` (путь ${pathLabel(path)}).`,
      });
      if (errors.length >= ctx.maxErrors) return errors.slice(0, ctx.maxErrors);
    }

    Object.keys(dependentRequired).forEach((key) => {
      if (!key || !Object.prototype.hasOwnProperty.call(value, key)) return;
      const peers = Array.isArray(dependentRequired[key]) ? dependentRequired[key] : [];
      peers.forEach((peer) => {
        const peerKey = String(peer || '');
        if (!peerKey || Object.prototype.hasOwnProperty.call(value, peerKey)) return;
        errors.push({
          path,
          message: `Поле \`${key}\` требует также поле \`${peerKey}\` (путь ${pathLabel(path)}).`,
        });
      });
    });
    if (errors.length >= ctx.maxErrors) return errors.slice(0, ctx.maxErrors);

    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const childPath = pathWithKey(path, key);
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validateNode(value[key], properties[key], ctx, childPath));
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: childPath,
          message: `Неизвестное поле \`${key}\` (путь ${pathLabel(childPath)}).`,
        });
      } else if (isSchemaLike(schema.additionalProperties)) {
        errors.push(...validateNode(value[key], schema.additionalProperties, ctx, childPath));
      }
      if (errors.length >= ctx.maxErrors) return errors.slice(0, ctx.maxErrors);
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    for (let index = 0; index < schema.allOf.length; index += 1) {
      errors.push(...validateNode(value, schema.allOf[index], ctx, path));
      if (errors.length >= ctx.maxErrors) return errors.slice(0, ctx.maxErrors);
    }
  }

  if (schema.not) {
    const nestedErrors = validateNode(value, schema.not, ctx, path);
    if (!nestedErrors.length) {
      errors.push({
        path,
        message: `Значение не должно соответствовать запрещённой схеме (путь ${pathLabel(path)}).`,
      });
    }
  }

  if (schema.if) {
    const matchesIf = validateNode(value, schema.if, ctx, path).length === 0;
    if (matchesIf && schema.then) {
      errors.push(...validateNode(value, schema.then, ctx, path));
    } else if (!matchesIf && schema.else) {
      errors.push(...validateNode(value, schema.else, ctx, path));
    }
  }

  return errors.slice(0, ctx.maxErrors);
}

export function validateYamlTextAgainstSchema(text, schema, options = {}) {
  const source = asString(text);
  const trimmed = source.trim();
  const index = buildYamlPathLocationMap(source);
  if (!trimmed) {
    return {
      ok: true,
      empty: true,
      diagnostics: [],
      summary: '',
      line: null,
      column: null,
    };
  }

  let parsed;
  try {
    parsed = loadYaml(source);
  } catch (error) {
    const line = error && error.mark ? Number(error.mark.line || 0) + 1 : 1;
    const column = error && error.mark ? Number(error.mark.column || 0) + 1 : 1;
    const lineOffset = index.starts[Math.max(0, line - 1)] || 0;
    const messageText = error && typeof error.message === 'string' ? error.message.split('\n')[0] : 'YAML содержит ошибку';
    const diagnostic = {
      from: lineOffset + Math.max(0, column - 1),
      to: lineOffset + Math.max(1, column),
      line,
      column,
      length: 1,
      severity: 'error',
      message: `YAML содержит ошибку: ${messageText} (строка ${line}, столбец ${column}).`,
      source: 'mihomo-yaml',
      path: '',
    };
    return {
      ok: false,
      parseOk: false,
      diagnostics: [diagnostic],
      summary: diagnostic.message,
      line,
      column,
    };
  }

  const ctx = {
    rootSchema: schema || {},
    maxErrors: Math.max(1, Number(options.maxErrors || 40)),
  };
  const schemaErrors = validateNode(parsed, schema, ctx, []);
  const semanticErrors = validateMihomoConfigSemantics(parsed, options);
  const errors = schemaErrors.concat(Array.isArray(semanticErrors) ? semanticErrors : []);
  const diagnostics = errors.map((item) => makeDiagnostic(index, item)).slice(0, ctx.maxErrors);
  const first = diagnostics[0] || null;
  return {
    ok: diagnostics.length === 0,
    parseOk: true,
    diagnostics,
    summary: first ? first.message : '',
    line: first ? first.line : null,
    column: first ? first.column : null,
    data: parsed,
  };
}

function getValueAtPath(data, path) {
  let current = data;
  const parts = Array.isArray(path) ? path : [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === 'number') {
      if (!Array.isArray(current) || part < 0 || part >= current.length) return undefined;
      current = current[part];
      continue;
    }
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function schemaCandidates(rawSchema, rootSchema) {
  const resolved = resolveSchema(rawSchema, rootSchema);
  if (!isSchemaLike(resolved)) return [];
  if (Array.isArray(resolved.oneOf) && resolved.oneOf.length) {
    return resolved.oneOf.flatMap((item) => schemaCandidates(item, rootSchema));
  }
  if (Array.isArray(resolved.anyOf) && resolved.anyOf.length) {
    return resolved.anyOf.flatMap((item) => schemaCandidates(item, rootSchema));
  }
  return [resolved];
}

function uniqueSchemas(candidates) {
  const seen = new Set();
  const out = [];
  (Array.isArray(candidates) ? candidates : []).forEach((item) => {
    if (!isSchemaLike(item) || seen.has(item)) return;
    seen.add(item);
    out.push(item);
  });
  return out;
}

function pickBestSchema(candidates, sampleValue, rootSchema) {
  const list = uniqueSchemas(candidates);
  if (!list.length) return null;
  if (list.length === 1 || typeof sampleValue === 'undefined') return list[0];
  let best = list[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < list.length; index += 1) {
    const candidate = list[index];
    const score = validateNode(sampleValue, candidate, { rootSchema, maxErrors: 8 }, []).length;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
      if (!score) break;
    }
  }
  return best;
}

function childSchemasForSegment(rawSchema, segment, rootSchema) {
  const candidates = schemaCandidates(rawSchema, rootSchema);
  const out = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!isSchemaLike(candidate)) continue;
    if (typeof segment === 'number') {
      if (candidate.items) out.push(resolveSchema(candidate.items, rootSchema) || candidate.items);
      continue;
    }
    const properties = isPlainObject(candidate.properties) ? candidate.properties : {};
    if (Object.prototype.hasOwnProperty.call(properties, segment)) {
      out.push(resolveSchema(properties[segment], rootSchema) || properties[segment]);
      continue;
    }
    if (isSchemaLike(candidate.additionalProperties)) {
      out.push(resolveSchema(candidate.additionalProperties, rootSchema) || candidate.additionalProperties);
    }
  }
  return uniqueSchemas(out);
}

function resolveSchemaAtPath(rawSchema, path, data, rootSchema) {
  const root = rootSchema || rawSchema || {};
  let candidates = schemaCandidates(rawSchema, root);
  if (!candidates.length) return null;
  let sample = data;
  const parts = Array.isArray(path) ? path : [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const childCandidates = [];
    for (let cursor = 0; cursor < candidates.length; cursor += 1) {
      childCandidates.push(...childSchemasForSegment(candidates[cursor], part, root));
    }
    candidates = uniqueSchemas(childCandidates);
    if (!candidates.length) return null;
    sample = typeof sample === 'undefined' ? undefined : getValueAtPath(sample, [part]);
  }
  return pickBestSchema(candidates, sample, root);
}

function collectObjectProperties(rawSchema, rootSchema) {
  const out = new Map();
  const candidates = schemaCandidates(rawSchema, rootSchema);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const properties = isPlainObject(candidate && candidate.properties) ? candidate.properties : {};
    const required = new Set(Array.isArray(candidate && candidate.required) ? candidate.required.map((item) => String(item || '')) : []);
    Object.keys(properties).forEach((key) => {
      const existing = out.get(key) || {
        label: key,
        schema: resolveSchema(properties[key], rootSchema) || properties[key],
        required: false,
      };
      existing.required = existing.required || required.has(key);
      if (!existing.schema) existing.schema = resolveSchema(properties[key], rootSchema) || properties[key];
      out.set(key, existing);
    });
  }
  return Array.from(out.values());
}

function formatSchemaDefault(value) {
  if (typeof value === 'string') return `\`${value}\``;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'список';
  if (isPlainObject(value)) return 'объект';
  return asString(value);
}

function formatEnumValues(values) {
  const list = Array.isArray(values) ? values.slice(0, 12).map((item) => valuePreview(item)) : [];
  if (!list.length) return '';
  return list.join(', ');
}

function _readYamlBeginnerMeta(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const explain = asString(schema['x-ui-explain'] || '').trim();
  const useCase = asString(schema['x-ui-use-case'] || '').trim();
  const example = asString(schema['x-ui-example'] || '').trim();
  const warning = asString(schema['x-ui-warning'] || '').trim();
  const docLink = asString(schema['x-ui-doc-link'] || '').trim();
  if (!explain && !useCase && !example && !warning && !docLink) return null;
  return { explain, useCase, example, warning, docLink };
}

function _formatYamlBeginnerBlockPlain(meta) {
  if (!meta) return '';
  const rows = [];
  if (meta.explain) rows.push(`Простыми словами: ${meta.explain}`);
  if (meta.useCase) rows.push(`Когда нужно: ${meta.useCase}`);
  if (meta.example) rows.push(`Пример: ${meta.example}`);
  if (meta.warning) rows.push(`Осторожно: ${meta.warning}`);
  if (meta.docLink) rows.push(`Подробнее: ${meta.docLink}`);
  return rows.join('\n');
}

function _formatYamlBeginnerBlockMarkdown(meta) {
  if (!meta) return '';
  const rows = [];
  if (meta.explain) rows.push(`**Простыми словами:** ${meta.explain}`);
  if (meta.useCase) rows.push(`**Когда нужно:** ${meta.useCase}`);
  if (meta.example) rows.push('**Пример:** `' + meta.example + '`');
  if (meta.warning) rows.push(`**⚠ Осторожно:** ${meta.warning}`);
  if (meta.docLink) rows.push('**Подробнее:** `' + meta.docLink + '`');
  return rows.join('\n\n');
}

function buildSchemaHelp(rawSchema, options = {}) {
  const rootSchema = options.rootSchema || rawSchema || {};
  const schema = resolveSchema(rawSchema, rootSchema);
  if (!schema || typeof schema !== 'object') return { plain: '', markdown: '' };
  const label = asString(options.label || '').trim();
  const typeText = formatTypeList(schema.type);
  const description = asString(schema.description || '').trim();
  const details = [];
  if (typeText && typeText !== 'значение') details.push(`Тип: ${typeText}.`);
  if (Array.isArray(schema.enum) && schema.enum.length) details.push(`Допустимые значения: ${formatEnumValues(schema.enum)}.`);
  if (Object.prototype.hasOwnProperty.call(schema, 'default')) details.push(`По умолчанию: ${formatSchemaDefault(schema.default)}.`);
  if (options.required) details.push('Обязательное поле.');
  const beginnerMode = !!options.beginnerMode;
  const beginnerMeta = beginnerMode ? _readYamlBeginnerMeta(schema) : null;
  const plainParts = [];
  if (label) plainParts.push(label);
  if (description) plainParts.push(description);
  if (beginnerMeta) {
    const beginnerPlain = _formatYamlBeginnerBlockPlain(beginnerMeta);
    if (beginnerPlain) plainParts.push(beginnerPlain);
  }
  if (details.length) plainParts.push(details.join(' '));
  const markdownParts = [];
  if (label) markdownParts.push(`**\`${label}\`**`);
  if (description) markdownParts.push(description);
  if (beginnerMeta) {
    const beginnerMd = _formatYamlBeginnerBlockMarkdown(beginnerMeta);
    if (beginnerMd) markdownParts.push(beginnerMd);
  }
  if (details.length) markdownParts.push(details.join('\n\n'));
  return {
    plain: plainParts.join('\n\n').trim(),
    markdown: markdownParts.join('\n\n').trim(),
  };
}

function normalizeAssistOffset(text, offset) {
  const source = asString(text).replace(/\r\n/g, '\n');
  const raw = Number(offset);
  if (!Number.isFinite(raw)) return source.length;
  return Math.max(0, Math.min(source.length, raw));
}

function lineIndexFromOffset(starts, offset) {
  const list = Array.isArray(starts) ? starts : [];
  if (!list.length) return 0;
  let low = 0;
  let high = list.length - 1;
  let answer = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (list[mid] <= offset) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function isOffsetInsideYamlComment(lineText, column) {
  const raw = asString(lineText).slice(0, Math.max(0, Number(column || 0)));
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw.charAt(index);
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '#') return true;
  }
  return false;
}

function resolvePendingStack(stack, currentIndent, startsWithDash) {
  while (stack.length > 1) {
    const top = stack[stack.length - 1];
    if (top.type !== 'pending') break;
    if (currentIndent > top.indent) {
      top.type = startsWithDash ? 'array' : 'object';
      top.nextIndex = 0;
      break;
    }
    stack.pop();
  }
}

function buildYamlStructuralStack(lines, uptoExclusive) {
  const stack = [{ indent: -1, path: [], type: 'object', nextIndex: 0 }];
  const rows = Array.isArray(lines) ? lines : [];
  const limit = Math.max(0, Math.min(rows.length, Number(uptoExclusive || 0)));
  for (let lineIndex = 0; lineIndex < limit; lineIndex += 1) {
    const rawLine = rows[lineIndex];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = rawLine.length - rawLine.replace(/^\s+/, '').length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    resolvePendingStack(stack, indent, trimmed.startsWith('-'));

    let parent = stack[stack.length - 1];
    if (!parent) parent = stack[0];

    if (trimmed.startsWith('-')) {
      if (parent.type !== 'array') {
        parent = { indent: indent - 1, path: parent.path.slice(), type: 'array', nextIndex: 0 };
        stack.push(parent);
      }
      const itemIndex = Math.max(0, Number(parent.nextIndex || 0));
      parent.nextIndex = itemIndex + 1;
      const itemPath = pathWithIndex(parent.path, itemIndex);
      const hyphenOffset = rawLine.indexOf('-', indent);
      const rest = rawLine.slice(hyphenOffset + 1);
      if (!rest.trim()) {
        stack.push({ indent, path: itemPath, type: 'pending', nextIndex: 0 });
        continue;
      }
      const kv = splitYamlKeyValue(rest);
      if (kv) {
        const itemObject = { indent, path: itemPath, type: 'object', nextIndex: 0 };
        stack.push(itemObject);
        if (!kv.hasInlineValue) {
          stack.push({ indent: hyphenOffset + 1 + kv.keyStart, path: pathWithKey(itemPath, kv.key), type: 'pending', nextIndex: 0 });
        }
      }
      continue;
    }

    const kv = splitYamlKeyValue(rawLine.slice(indent));
    if (!kv) continue;
    if (!kv.hasInlineValue) {
      stack.push({ indent: indent + kv.keyStart, path: pathWithKey(parent.path, kv.key), type: 'pending', nextIndex: 0 });
    }
  }
  return stack;
}

function buildYamlCursorContext(text, offset) {
  const index = lineStartOffsets(text);
  const safeOffset = normalizeAssistOffset(index.normalized, offset);
  const lineIndex = lineIndexFromOffset(index.starts, safeOffset);
  const lineStart = index.starts[Math.max(0, lineIndex)] || 0;
  const lineText = index.lines[Math.max(0, lineIndex)] || '';
  const column = Math.max(0, safeOffset - lineStart);
  if (isOffsetInsideYamlComment(lineText, column)) return null;

  const stack = buildYamlStructuralStack(index.lines, lineIndex);
  const indent = lineText.length - lineText.replace(/^\s+/, '').length;
  const prefix = lineText.slice(0, column);
  const trimmedPrefix = prefix.trim();

  while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
    stack.pop();
  }
  resolvePendingStack(stack, indent, trimmedPrefix.startsWith('-'));

  let parent = stack[stack.length - 1];
  if (!parent) parent = stack[0];

  if (trimmedPrefix.startsWith('-')) {
    const hyphenOffset = lineText.indexOf('-', indent);
    const afterDash = prefix.slice(hyphenOffset + 1);
    if (parent.type !== 'array') {
      parent = { indent: indent - 1, path: parent.path.slice(), type: 'array', nextIndex: Math.max(0, Number(parent.nextIndex || 0)) };
    }
    const itemIndex = Math.max(0, Number(parent.nextIndex || 0));
    const itemPath = pathWithIndex(parent.path, itemIndex);
    if (!afterDash.trim()) {
      return {
        kind: 'array-item',
        path: itemPath,
        replaceFrom: safeOffset,
        replaceTo: safeOffset,
        prefix: '',
      };
    }
    const kv = splitYamlKeyValue(afterDash);
    if (kv) {
      const keyBase = lineStart + hyphenOffset + 1;
      const keyPath = pathWithKey(itemPath, kv.key);
      if (column <= hyphenOffset + 1 + kv.delimiterIndex) {
        return {
          kind: 'key',
          path: itemPath,
          replaceFrom: keyBase + kv.keyStart,
          replaceTo: keyBase + kv.keyEnd,
          prefix: prefix.slice(hyphenOffset + 1 + kv.keyStart),
          preserveExistingDelimiter: true,
        };
      }
      if (kv.hasInlineValue && column >= hyphenOffset + 1 + kv.valueStart) {
        return {
          kind: 'value',
          path: keyPath,
          replaceFrom: keyBase + kv.valueStart,
          replaceTo: keyBase + kv.valueEnd,
          prefix: prefix.slice(hyphenOffset + 1 + kv.valueStart),
        };
      }
      return {
        kind: 'value',
        path: keyPath,
        replaceFrom: safeOffset,
        replaceTo: safeOffset,
        prefix: '',
      };
    }
    const fullAfterDash = lineText.slice(hyphenOffset + 1);
    const fullKv = splitYamlKeyValue(fullAfterDash);
    if (fullKv && column <= hyphenOffset + 1 + fullKv.delimiterIndex) {
      return {
        kind: 'key',
        path: itemPath,
        replaceFrom: lineStart + hyphenOffset + 1 + fullKv.keyStart,
        replaceTo: lineStart + hyphenOffset + 1 + fullKv.keyEnd,
        prefix: prefix.slice(hyphenOffset + 1 + fullKv.keyStart),
        preserveExistingDelimiter: true,
      };
    }
    const leading = afterDash.match(/^\s*/);
    const keyStart = hyphenOffset + 1 + (leading ? leading[0].length : 0);
    return {
      kind: 'key',
      path: itemPath,
      replaceFrom: lineStart + keyStart,
      replaceTo: safeOffset,
      prefix: prefix.slice(keyStart),
    };
  }

  const content = prefix.slice(indent);
  if (!content.trim()) {
    return {
      kind: 'key',
      path: parent.path.slice(),
      replaceFrom: lineStart + indent,
      replaceTo: safeOffset,
      prefix: '',
    };
  }

  const kv = splitYamlKeyValue(content);
  if (kv) {
    const keyBase = lineStart + indent;
    const keyPath = pathWithKey(parent.path, kv.key);
    if (column <= indent + kv.delimiterIndex) {
      return {
        kind: 'key',
        path: parent.path.slice(),
        replaceFrom: keyBase + kv.keyStart,
        replaceTo: keyBase + kv.keyEnd,
        prefix: prefix.slice(indent + kv.keyStart),
        preserveExistingDelimiter: true,
      };
    }
    if (kv.hasInlineValue && column >= indent + kv.valueStart) {
      return {
        kind: 'value',
        path: keyPath,
        replaceFrom: keyBase + kv.valueStart,
        replaceTo: keyBase + kv.valueEnd,
        prefix: prefix.slice(indent + kv.valueStart),
      };
    }
    return {
      kind: 'value',
      path: keyPath,
      replaceFrom: safeOffset,
      replaceTo: safeOffset,
      prefix: '',
    };
  }
  const fullContent = lineText.slice(indent);
  const fullKv = splitYamlKeyValue(fullContent);
  if (fullKv && column <= indent + fullKv.delimiterIndex) {
    return {
      kind: 'key',
      path: parent.path.slice(),
      replaceFrom: lineStart + indent + fullKv.keyStart,
      replaceTo: lineStart + indent + fullKv.keyEnd,
      prefix: prefix.slice(indent + fullKv.keyStart),
      preserveExistingDelimiter: true,
    };
  }

  return {
    kind: 'key',
    path: parent.path.slice(),
    replaceFrom: lineStart + indent,
    replaceTo: safeOffset,
    prefix: content,
  };
}

function prefixMatches(label, prefix) {
  const value = asString(label);
  const probe = asString(prefix).trim().replace(/^['"]/, '');
  if (!probe) return true;
  return value.toLowerCase().startsWith(probe.toLowerCase());
}

function isSchemaObjectLike(rawSchema, rootSchema) {
  const candidates = schemaCandidates(rawSchema, rootSchema);
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    if (normalizeTypeList(candidate.type).includes('object')) return true;
    if (isPlainObject(candidate.properties) && Object.keys(candidate.properties).length) return true;
    return false;
  });
}

function yamlScalarLiteral(value) {
  if (typeof value === 'string') {
    if (value === '') return '""';
    if (/^[A-Za-z0-9_./@-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return asString(value);
}

function buildKeyCompletionOptions(rawSchema, rootSchema, prefix, options = {}) {
  const preserveExistingDelimiter = !!options.preserveExistingDelimiter;
  const properties = collectObjectProperties(rawSchema, rootSchema);
  return properties
    .filter((item) => prefixMatches(item.label, prefix))
    .sort((a, b) => {
      if (!!a.required !== !!b.required) return a.required ? -1 : 1;
      return a.label.localeCompare(b.label);
    })
    .map((item) => {
      const help = buildSchemaHelp(item.schema, { label: item.label, required: item.required, rootSchema });
      return {
        label: item.label,
        type: 'property',
        insertText: preserveExistingDelimiter ? item.label : `${item.label}: `,
        detail: item.required ? 'обязательное поле' : 'поле',
        documentation: help,
      };
    });
}

function buildValueCompletionOptions(rawSchema, rootSchema, prefix) {
  const candidates = schemaCandidates(rawSchema, rootSchema);
  const seen = new Set();
  const options = [];

  function pushOption(value, detail, schema) {
    const label = yamlScalarLiteral(value);
    if (!label || seen.has(label) || !prefixMatches(label, prefix)) return;
    seen.add(label);
    const help = buildSchemaHelp(schema, { label, rootSchema });
    options.push({
      label,
      type: 'value',
      insertText: label,
      detail,
      documentation: help,
    });
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate !== 'object') continue;
    if (Array.isArray(candidate.enum) && candidate.enum.length) {
      candidate.enum.forEach((item) => pushOption(item, 'enum', candidate));
      continue;
    }
    const types = normalizeTypeList(candidate.type);
    if (types.includes('boolean')) {
      pushOption(true, 'boolean', candidate);
      pushOption(false, 'boolean', candidate);
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'default')) {
      pushOption(candidate.default, 'default', candidate);
    }
  }

  return options;
}

function parseYamlBestEffort(text) {
  try {
    return loadYaml(asString(text));
  } catch (e) {}
  return undefined;
}

function resolveYamlSnippetProvider(options) {
  if (!options || typeof options !== 'object') return null;
  const provider = options.snippetProvider;
  if (typeof provider === 'function') return provider;
  if (provider && typeof provider.getSnippets === 'function') {
    return (ctx) => provider.getSnippets(ctx);
  }
  return null;
}

function buildYamlSnippetCompletionOptions(snippets) {
  const list = Array.isArray(snippets) ? snippets : [];
  return list
    .filter((item) => item && item.label && (item.insertText || item.monacoSnippet))
    .map((item) => {
      const plainParts = [];
      if (item.documentation) plainParts.push(String(item.documentation));
      if (item.warning) plainParts.push(`⚠ ${String(item.warning)}`);
      const plain = plainParts.join('\n\n') || '';
      const insertPlain = String(item.insertText || item.monacoSnippet || '');
      const insertSnippet = String(item.monacoSnippet || item.insertText || '');
      return {
        label: `📦 ${String(item.label)}`,
        type: 'snippet',
        insertText: insertPlain,
        monacoSnippet: insertSnippet,
        detail: String(item.detail || 'snippet'),
        documentation: plain ? { plain, markdown: plain } : {},
      };
    });
}

export function completeYamlTextFromSchema(text, schema, options = {}) {
  const source = asString(text);
  const rootSchema = schema || {};
  const context = buildYamlCursorContext(source, options.offset);
  if (!context) return null;

  const data = parseYamlBestEffort(source);
  let targetSchema = resolveSchemaAtPath(rootSchema, context.path, data, rootSchema);
  let list = [];

  if (context.kind === 'array-item') {
    if (isSchemaObjectLike(targetSchema, rootSchema)) {
      list = buildKeyCompletionOptions(targetSchema, rootSchema, context.prefix, context);
    } else {
      list = buildValueCompletionOptions(targetSchema, rootSchema, context.prefix);
    }
  } else if (context.kind === 'key') {
    list = buildKeyCompletionOptions(targetSchema, rootSchema, context.prefix, context);
  } else if (context.kind === 'value') {
    list = buildValueCompletionOptions(targetSchema, rootSchema, context.prefix);
  }

  const provider = resolveYamlSnippetProvider(options);
  let snippetOptions = [];
  if (provider) {
    let snippets = null;
    try {
      snippets = provider({
        path: Array.isArray(context.path) ? context.path.slice() : [],
        kind: context.kind || '',
        prefix: context.prefix || '',
        offset: options.offset,
      });
    } catch (e) {
      snippets = null;
    }
    snippetOptions = buildYamlSnippetCompletionOptions(snippets);
    if (snippetOptions.length) list = list.concat(snippetOptions);
  }

  if (!list.length) return null;
  return {
    from: Math.max(0, Number(context.replaceFrom || 0)),
    to: Math.max(0, Number(context.replaceTo || context.replaceFrom || 0)),
    options: list,
    context: {
      kind: context.kind,
      path: pathToString(context.path),
    },
  };
}

function isPathRequired(rootSchema, path, data) {
  const parts = Array.isArray(path) ? path : [];
  if (!parts.length) return false;
  const last = parts[parts.length - 1];
  if (typeof last !== 'string') return false;
  const parentPath = parts.slice(0, -1);
  const parentSchema = resolveSchemaAtPath(rootSchema, parentPath, data, rootSchema);
  const required = Array.isArray(parentSchema && parentSchema.required) ? parentSchema.required.map((item) => String(item || '')) : [];
  return required.includes(last);
}

function findYamlTokenAtOffset(index, offset) {
  const tokens = Array.isArray(index && index.tokens) ? index.tokens : [];
  const safeOffset = Math.max(0, Number(offset || 0));
  let best = null;
  for (let itemIndex = 0; itemIndex < tokens.length; itemIndex += 1) {
    const item = tokens[itemIndex];
    if (safeOffset < item.from || safeOffset > item.to) continue;
    if (!best || (item.to - item.from) < (best.to - best.from)) best = item;
  }
  return best;
}

export function hoverYamlTextFromSchema(text, schema, options = {}) {
  const source = asString(text);
  if (!source.trim()) return null;
  const rootSchema = schema || {};
  const index = buildYamlPathLocationMap(source);
  const safeOffset = normalizeAssistOffset(index.normalized, options.offset);
  const token = findYamlTokenAtOffset(index, safeOffset);
  if (!token) return null;
  const data = parseYamlBestEffort(source);
  const targetSchema = resolveSchemaAtPath(rootSchema, token.path, data, rootSchema);
  if (!targetSchema) return null;
  const label = token.kind === 'key'
    ? asString(token.key || token.path[token.path.length - 1] || '').trim()
    : asString(token.path[token.path.length - 1] || '').trim();
  const help = buildSchemaHelp(targetSchema, {
    label,
    required: isPathRequired(rootSchema, token.path, data),
    rootSchema,
    beginnerMode: !!options.beginnerMode,
  });
  if (!help.plain && !help.markdown) return null;
  return {
    from: token.from,
    to: token.to,
    line: token.line,
    column: token.column,
    path: pathToString(token.path),
    kind: token.kind,
    plain: help.plain,
    markdown: help.markdown || help.plain,
  };
}

export const yamlSchemaApi = Object.freeze({
  validateYamlTextAgainstSchema,
  completeYamlTextFromSchema,
  hoverYamlTextFromSchema,
  buildYamlPathLocationMap,
  resolveSchemaAtPath,
});

export {
  buildYamlPathLocationMap,
  resolveSchemaAtPath,
  pathToString,
};
