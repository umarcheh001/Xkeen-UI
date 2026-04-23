/**
 * codemirror-json-schema — lightweight ESM build for Xkeen UI
 * Provides JSON Schema validation (linter), autocomplete and hover tooltips
 * for CodeMirror 6 editors.
 *
 * Based on codemirror-json-schema 0.8.1 (MIT License)
 * Re-implemented without heavy deps (json-schema-library, markdown-it, shiki)
 * to work self-contained with the existing importmap.
 *
 * Exports:
 *   stateExtensions(schema?)  — StateField + init for schema
 *   updateSchema(view, schema) — update schema at runtime
 *   getJSONSchema(state)       — read current schema from state
 *   jsonSchemaLinter(opts?)    — linter source function
 *   handleRefresh(vu)          — needsRefresh callback
 *   jsonSchemaHover(opts?)     — hoverTooltip source
 *   jsonCompletion(opts?)      — autocomplete source
 */

import { StateEffect, StateField } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parse as parseJsonc, parseTree as parseJsoncTree } from 'jsonc-parser';

/* ════════════════════════════════════════════════════════════
 *  1. Schema StateField — stores the current JSON Schema
 * ════════════════════════════════════════════════════════════ */

const schemaEffect = StateEffect.define();

const schemaStateField = StateField.define({
  create() { return undefined; },
  update(schema, tr) {
    for (const e of tr.effects) {
      if (e.is(schemaEffect)) return e.value;
    }
    return schema;
  },
});

function updateSchema(view, schema) {
  view.dispatch({ effects: schemaEffect.of(schema) });
}

function getJSONSchema(state) {
  return state.field(schemaStateField);
}

function stateExtensions(schema) {
  return [schemaStateField.init(() => schema)];
}

const handleRefresh = (vu) => {
  return vu.startState.field(schemaStateField) !== vu.state.field(schemaStateField);
};

/* ════════════════════════════════════════════════════════════
 *  2. Lightweight JSON Schema Validator (Draft-04/07 subset)
 * ════════════════════════════════════════════════════════════ */

function resolveRef(rootSchema, ref) {
  if (!ref || typeof ref !== 'string') return undefined;
  const parts = ref.split('/');
  let cur = rootSchema;
  for (const p of parts) {
    if (!p || p === '#') { cur = rootSchema; continue; }
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[decodeURIComponent(p)];
  }
  return cur;
}

function resolveSchema(schema, rootSchema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    const resolved = resolveRef(rootSchema, schema.$ref);
    if (resolved && typeof resolved === 'object') {
      const merged = { ...schema, ...resolved };
      delete merged.$ref;
      return merged;
    }
  }
  return schema;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string', 'number', 'boolean', 'object'
}

function matchesType(value, schemaType) {
  const vt = typeOf(value);
  if (Array.isArray(schemaType)) return schemaType.some(t => matchesType(value, t));
  if (schemaType === 'integer') return vt === 'number' && Number.isInteger(value);
  return vt === schemaType;
}

function errorPointerDepth(err) {
  return String((err && err.pointer) || '').split('/').filter(Boolean).length;
}

function branchObjectFitScore(value, schema, rootSchema) {
  if (typeOf(value) !== 'object' || !schema || typeof schema !== 'object') return 0;
  const resolved = resolveSchema(schema, rootSchema);
  if (!resolved || typeof resolved !== 'object') return 0;

  const props = collectAllProperties(resolved, rootSchema);
  const patterns = resolved.patternProperties || {};
  const additional = resolved.additionalProperties;
  let score = 0;

  for (const key of Object.keys(value)) {
    if (key in props) {
      score += 4;
      continue;
    }

    let matchedPattern = false;
    for (const pat of Object.keys(patterns)) {
      try {
        if (new RegExp(pat, 'u').test(key)) {
          matchedPattern = true;
          break;
        }
      } catch (e) {}
    }
    if (matchedPattern) {
      score += 3;
      continue;
    }

    if (additional && typeof additional === 'object') {
      score += 1;
      continue;
    }

    if (additional === false) score -= 2;
  }

  if (Array.isArray(resolved.required)) {
    for (const req of resolved.required) {
      if (req in value) score += 1;
    }
  }

  return score;
}

function sameJsonValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function schemaDeprecationMessage(schema, value) {
  if (!schema || typeof schema !== 'object') return '';
  if (schema.deprecated === true) {
    return String(schema.deprecationMessage || 'Это значение устарело.');
  }
  if (Array.isArray(schema.deprecatedValues)) {
    const matched = schema.deprecatedValues.some((item) => sameJsonValue(item, value));
    if (matched) {
      const label = typeof value === 'string' ? `\`${value}\`` : `\`${JSON.stringify(value)}\``;
      return String(schema.deprecationMessage || `Значение ${label} устарело.`);
    }
  }
  return '';
}

function findCaseInsensitivePropertyName(key, props) {
  const lower = String(key || '').toLowerCase();
  if (!lower || !props || typeof props !== 'object') return '';
  for (const candidate of Object.keys(props)) {
    if (candidate.toLowerCase() === lower && candidate !== key) return candidate;
  }
  return '';
}

function wrongCasePropertyMessage(actual, expected) {
  return `Свойство \`${actual}\` написано с другим регистром. Ключи Xray регистрозависимы; используйте \`${expected}\`.`;
}

function getValueAtPointer(rootValue, pointer) {
  if (!pointer) return rootValue;
  const parts = String(pointer).slice(1).split('/').map((part) =>
    part.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  let current = rootValue;
  for (const part of parts) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Validate a parsed JSON value against a JSON Schema.
 * Returns an array of { pointer, message } error objects.
 */
function validateValue(value, schema, rootSchema, pointer) {
  if (!schema || typeof schema !== 'object') return [];
  schema = resolveSchema(schema, rootSchema);
  if (!schema || typeof schema !== 'object') return [];

  const errors = [];
  const p = pointer || '';

  // --- type ---
  if (schema.type !== undefined && value !== undefined) {
    if (!matchesType(value, schema.type)) {
      const expected = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
      errors.push({ pointer: p, message: `Ожидается тип \`${expected}\`, получено \`${typeOf(value)}\`` });
      return errors; // type mismatch → skip deeper checks
    }
  }

  // --- enum ---
  if (schema.enum !== undefined) {
    const found = schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value));
    if (!found) {
      const allowed = schema.enum.map(e => JSON.stringify(e)).join(', ');
      errors.push({ pointer: p, message: `Значение должно быть одним из: ${allowed}` });
    }
  }

  // --- const ---
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push({ pointer: p, message: `Значение должно быть: ${JSON.stringify(schema.const)}` });
    }
  }

  // --- deprecation ---
  const deprecationMessage = schemaDeprecationMessage(schema, value);
  if (deprecationMessage) {
    errors.push({ pointer: p, message: deprecationMessage });
  }

  // --- string constraints ---
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push({ pointer: p, message: `Строка должна быть не короче ${schema.minLength} символов` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push({ pointer: p, message: `Строка должна быть не длиннее ${schema.maxLength} символов` });
    if (schema.pattern !== undefined) {
      try { if (!new RegExp(schema.pattern, 'u').test(value)) errors.push({ pointer: p, message: `Строка не соответствует паттерну: ${schema.pattern}` }); } catch (e) {}
    }
  }

  // --- number constraints ---
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push({ pointer: p, message: `Значение должно быть ≥ ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push({ pointer: p, message: `Значение должно быть ≤ ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      errors.push({ pointer: p, message: `Значение должно быть > ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      errors.push({ pointer: p, message: `Значение должно быть < ${schema.exclusiveMaximum}` });
  }

  // --- object ---
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    const props = schema.properties || {};
    const patterns = schema.patternProperties || {};
    const additional = schema.additionalProperties;

    // required
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) {
          const caseVariant = keys.find(key => key.toLowerCase() === String(req).toLowerCase());
          if (caseVariant) {
            if (additional !== false) {
              const childPointer = `${p}/${caseVariant.replace(/~/g, '~0').replace(/\//g, '~1')}`;
              errors.push({ pointer: childPointer, message: wrongCasePropertyMessage(caseVariant, req) });
            }
            continue;
          }
          errors.push({ pointer: p ? `${p}/${req}` : `/${req}`, message: `Обязательное свойство \`${req}\` отсутствует` });
        }
      }
    }

    // properties
    for (const key of keys) {
      const childPointer = `${p}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      let matched = false;

      if (key in props) {
        matched = true;
        const propSchema = resolveSchema(props[key], rootSchema);
        if (propSchema && typeof propSchema === 'object') {
          errors.push(...validateValue(value[key], propSchema, rootSchema, childPointer));
        }
      }

      for (const pat of Object.keys(patterns)) {
        try {
          if (new RegExp(pat, 'u').test(key)) {
            matched = true;
            const patSchema = resolveSchema(patterns[pat], rootSchema);
            if (patSchema && typeof patSchema === 'object') {
              errors.push(...validateValue(value[key], patSchema, rootSchema, childPointer));
            }
          }
        } catch (e) {}
      }

      if (!matched && additional === false) {
        const suggestedKey = findCaseInsensitivePropertyName(key, props);
        errors.push({
          pointer: childPointer,
          message: suggestedKey
            ? wrongCasePropertyMessage(key, suggestedKey)
            : `Свойство \`${key}\` не разрешено схемой`,
        });
      } else if (!matched && additional && typeof additional === 'object') {
        errors.push(...validateValue(value[key], additional, rootSchema, childPointer));
      }
    }

    // minProperties / maxProperties
    if (schema.minProperties !== undefined && keys.length < schema.minProperties)
      errors.push({ pointer: p, message: `Объект должен содержать ≥ ${schema.minProperties} свойств` });
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      errors.push({ pointer: p, message: `Объект должен содержать ≤ ${schema.maxProperties} свойств` });
  }

  // --- array ---
  if (Array.isArray(value)) {
    const items = schema.items;
    if (items) {
      if (Array.isArray(items)) {
        // tuple
        for (let i = 0; i < value.length; i++) {
          const itemSchema = i < items.length ? items[i] : schema.additionalItems;
          if (itemSchema && typeof itemSchema === 'object') {
            errors.push(...validateValue(value[i], resolveSchema(itemSchema, rootSchema), rootSchema, `${p}/${i}`));
          } else if (itemSchema === false && i >= items.length) {
            errors.push({ pointer: `${p}/${i}`, message: `Дополнительные элементы массива не разрешены` });
          }
        }
      } else if (typeof items === 'object') {
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateValue(value[i], resolveSchema(items, rootSchema), rootSchema, `${p}/${i}`));
        }
      }
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push({ pointer: p, message: `Массив должен содержать ≥ ${schema.minItems} элементов` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push({ pointer: p, message: `Массив должен содержать ≤ ${schema.maxItems} элементов` });
    if (schema.uniqueItems && value.length > 1) {
      const seen = new Set();
      for (let i = 0; i < value.length; i++) {
        const s = JSON.stringify(value[i]);
        if (seen.has(s)) errors.push({ pointer: `${p}/${i}`, message: `Элементы массива должны быть уникальными` });
        seen.add(s);
      }
    }
  }

  // --- oneOf ---
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter(sub => {
      const resolved = resolveSchema(sub, rootSchema);
      return validateValue(value, resolved, rootSchema, p).length === 0;
    });
    if (matching.length === 0) errors.push({ pointer: p, message: `Значение не соответствует ни одной из oneOf-схем` });
    else if (matching.length > 1) errors.push({ pointer: p, message: `Значение соответствует нескольким oneOf-схемам` });
  }

  // --- anyOf ---
  if (Array.isArray(schema.anyOf)) {
    const baseDepth = errorPointerDepth({ pointer: p });
    const branchResults = [];
    const matching = schema.anyOf.some(sub => {
      const resolved = resolveSchema(sub, rootSchema);
      const subErrors = validateValue(value, resolved, rootSchema, p);
      branchResults.push({
        errors: subErrors,
        fitScore: branchObjectFitScore(value, resolved, rootSchema),
        maxDepth: subErrors.length ? Math.max(...subErrors.map(errorPointerDepth)) : baseDepth,
        topLevelAdditionalCount: subErrors.filter(err =>
          errorPointerDepth(err) <= baseDepth + 1 &&
          String((err && err.message) || '').includes('не разрешено')
        ).length,
      });
      return subErrors.length === 0;
    });
    if (!matching) {
      const sorted = branchResults
        .filter(branch => Array.isArray(branch.errors) && branch.errors.length)
        .sort((a, b) => {
          if (a.fitScore !== b.fitScore) return b.fitScore - a.fitScore;
          if (a.topLevelAdditionalCount !== b.topLevelAdditionalCount) return a.topLevelAdditionalCount - b.topLevelAdditionalCount;
          if (a.maxDepth !== b.maxDepth) return b.maxDepth - a.maxDepth;
          return a.errors.length - b.errors.length;
        });
      if (sorted.length) errors.push(...sorted[0].errors);
      else errors.push({ pointer: p, message: `Значение не соответствует ни одной из anyOf-схем` });
    }
  }

  // --- allOf ---
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const resolved = resolveSchema(sub, rootSchema);
      errors.push(...validateValue(value, resolved, rootSchema, p));
    }
  }

  // --- not ---
  if (schema.not) {
    const resolved = resolveSchema(schema.not, rootSchema);
    if (validateValue(value, resolved, rootSchema, p).length === 0) {
      errors.push({ pointer: p, message: `Значение не должно соответствовать вложенной not-схеме` });
    }
  }

  // --- if/then/else ---
  if (schema.if) {
    const ifResolved = resolveSchema(schema.if, rootSchema);
    const ifValid = validateValue(value, ifResolved, rootSchema, p).length === 0;
    if (ifValid && schema.then) {
      const thenResolved = resolveSchema(schema.then, rootSchema);
      errors.push(...validateValue(value, thenResolved, rootSchema, p));
    }
    if (!ifValid && schema.else) {
      const elseResolved = resolveSchema(schema.else, rootSchema);
      errors.push(...validateValue(value, elseResolved, rootSchema, p));
    }
  }

  return errors;
}

/* ════════════════════════════════════════════════════════════
 *  3. AST → JSON Pointer mapping (from Lezer syntax tree)
 * ════════════════════════════════════════════════════════════ */

const TOKENS = {
  STRING: 'String', NUMBER: 'Number', TRUE: 'True', FALSE: 'False',
  NULL: 'Null', OBJECT: 'Object', ARRAY: 'Array', PROPERTY: 'Property',
  PROPERTY_NAME: 'PropertyName', JSON_TEXT: 'JsonText', INVALID: '⚠',
};

function getWord(doc, node, strip) {
  if (!node) return '';
  const w = doc.sliceString(node.from, node.to);
  return strip !== false ? w.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1') : w;
}

function getChildNodes(node) {
  const children = [];
  let c = node.firstChild;
  while (c) { children.push(c); c = c.nextSibling; }
  return children;
}

function isSameSyntaxNode(a, b) {
  return !!(a && b && a.from === b.from && a.to === b.to && a.name === b.name);
}

function getJsonPointerAt(doc, node) {
  const path = [];
  for (let n = node; n && n.parent; n = n.parent) {
    if (n.parent.name === 'Property') {
      const nameNode = getChildNodes(n.parent).find(c => c.name === 'PropertyName');
      if (nameNode) {
        const key = getWord(doc, nameNode).replace(/~/g, '~0').replace(/\//g, '~1');
        path.unshift(key);
      }
    } else if (n.parent.name === 'Array') {
      const valueChildren = getChildNodes(n.parent).filter(c =>
        c.name !== '[' && c.name !== ']' && c.name !== ','
      );
      const foundIdx = valueChildren.findIndex(c => isSameSyntaxNode(c, n));
      if (foundIdx >= 0) path.unshift(`${foundIdx}`);
    }
  }
  return path.length ? '/' + path.join('/') : '';
}

function buildJsoncPointerMap(text) {
  const pointers = new Map();
  let root = null;
  try {
    const errors = [];
    root = parseJsoncTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  } catch (e) {}
  if (!root) return pointers;

  const visit = (node, pointer, keyNode) => {
    if (!node) return;
    const from = Math.max(0, Number(node.offset || 0));
    const to = Math.max(from, from + Math.max(0, Number(node.length || 0)));
    const keyFrom = keyNode ? Math.max(0, Number(keyNode.offset || 0)) : from;
    const keyTo = keyNode ? Math.max(keyFrom, keyFrom + Math.max(0, Number(keyNode.length || 0))) : Math.min(to, from + 1);
    pointers.set(pointer || '', {
      keyFrom,
      keyTo,
      valueFrom: from,
      valueTo: to,
    });

    if (node.type === 'object' && Array.isArray(node.children)) {
      for (const propNode of node.children) {
        const children = Array.isArray(propNode.children) ? propNode.children : [];
        const propKeyNode = children[0];
        const valueNode = children[1];
        if (!propKeyNode || !valueNode) continue;
        const key = propKeyNode.value == null ? '' : String(propKeyNode.value);
        const childPointer = joinPointer(pointer || '', key);
        visit(valueNode, childPointer, propKeyNode);
      }
      return;
    }

    if (node.type === 'array' && Array.isArray(node.children)) {
      node.children.forEach((childNode, index) => {
        visit(childNode, joinPointer(pointer || '', String(index)), null);
      });
    }
  };

  visit(root, '', null);
  return pointers;
}

/**
 * Build a Map<pointer, {keyFrom, keyTo, valueFrom, valueTo}> from the syntax tree
 */
function buildPointerMap(state) {
  const jsoncPointers = buildJsoncPointerMap(state.doc.toString());
  if (jsoncPointers.size) return jsoncPointers;

  const tree = syntaxTree(state);
  const doc = state.doc;
  const pointers = new Map();

  tree.iterate({
    enter(type) {
      if (type.name === 'PropertyName' || type.name === 'Object') {
        const pointer = getJsonPointerAt(doc, type.node);
        const { from: keyFrom, to: keyTo } = type.node;
        const next = type.node.nextSibling;
        if (next) {
          pointers.set(pointer, { keyFrom, keyTo, valueFrom: next.from, valueTo: next.to });
        } else {
          pointers.set(pointer, { keyFrom, keyTo });
        }
        return true;
      }
    },
  });
  return pointers;
}

function parentPointer(pointer) {
  const text = String(pointer || '');
  if (!text || text === '/') return null;
  const index = text.lastIndexOf('/');
  if (index <= 0) return '';
  return text.slice(0, index);
}

function findDiagnosticMapping(pointerMap, pointer) {
  let current = String(pointer || '');
  while (current != null) {
    const mapping = pointerMap.get(current);
    if (mapping) return mapping;
    current = parentPointer(current);
  }
  return null;
}

function diagnosticPointerLabel(pointer) {
  if (!pointer) return 'root';
  const parts = String(pointer).slice(1).split('/').filter(Boolean).map(part =>
    part.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  if (!parts.length) return 'root';
  return parts.reduce((acc, part) => {
    if (/^\d+$/.test(part)) return `${acc}[${part}]`;
    return acc ? `${acc}.${part}` : part;
  }, '');
}

function locationForMapping(doc, mapping) {
  if (!mapping) return null;
  const pos = Number.isFinite(mapping.keyFrom) ? mapping.keyFrom : mapping.valueFrom;
  if (!Number.isFinite(pos)) return null;
  try {
    const safePos = Math.max(0, Math.min(doc.length, pos));
    const line = doc.lineAt(safePos);
    return {
      line: line.number,
      column: Math.max(1, safePos - line.from + 1),
    };
  } catch (e) {}
  return null;
}

function withDiagnosticContext(message, pointer, doc, mapping) {
  const parts = [];
  const loc = locationForMapping(doc, mapping);
  if (loc) parts.push(`строка ${loc.line}, столбец ${loc.column}`);
  const path = diagnosticPointerLabel(pointer);
  if (path && path !== 'root') parts.push(`путь ${path}`);
  if (!parts.length) return message;
  return `${message} (${parts.join('; ')})`;
}

/**
 * Parse JSON from editor, with fallback for partial content
 */
function safeParseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  try {
    const errors = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (!errors.length) return parsed;
  } catch (e) {}
  // attempt best-effort: strip trailing commas, incomplete content
  try {
    const cleaned = text.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(cleaned);
  } catch (e) {}
  return null;
}

/* ════════════════════════════════════════════════════════════
 *  4. jsonSchemaLinter — CodeMirror linter extension source
 * ════════════════════════════════════════════════════════════ */

function jsonSchemaLinter(options) {
  return function schemaLintSource(view) {
    const schema = getJSONSchema(view.state);
    if (!schema) return [];

    const text = view.state.doc.toString();
    if (!text.trim()) return [];

    const data = safeParseJson(text);
    if (data == null) return []; // syntax errors handled by jsonc-parser linter

    const pointerMap = buildPointerMap(view.state);
    const schemaErrors = validateValue(data, schema, schema, '');

    // Map pointer-based errors to document positions
    const diagnostics = [];
    for (const err of schemaErrors) {
      const pointer = err.pointer || '';
      const mapping = findDiagnosticMapping(pointerMap, pointer);

      let from = 0, to = 0;
      if (mapping) {
        // For "property missing" errors, highlight the parent object key
        // For value errors, highlight the value
        if (
          err.message.includes('отсутствует') ||
          err.message.includes('не разрешено') ||
          err.message.includes('написано с другим регистром')
        ) {
          from = mapping.keyFrom;
          to = mapping.keyTo;
        } else if (mapping.valueFrom !== undefined) {
          from = mapping.valueFrom;
          to = mapping.valueTo;
        } else {
          from = mapping.keyFrom;
          to = mapping.keyTo;
        }
      }
      const message = withDiagnosticContext(err.message, pointer, view.state.doc, mapping);

      diagnostics.push({
        from,
        to,
        severity: 'warning',
        message,
        source: schema.title || 'json-schema',
      });
    }

    return diagnostics;
  };
}

/* ════════════════════════════════════════════════════════════
 *  5. jsonSchemaHover — hover tooltip with descriptions
 * ════════════════════════════════════════════════════════════ */

function getSchemaAtPointer(schema, rootSchema, pointer) {
  if (!pointer || pointer === '') return schema;
  const parts = pointer.slice(1).split('/').map(p =>
    p.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  let cur = resolveSchema(schema, rootSchema);
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = resolveSchema(cur, rootSchema);

    if (cur.properties && part in cur.properties) {
      cur = cur.properties[part];
    } else if (cur.patternProperties) {
      let found = false;
      for (const pat of Object.keys(cur.patternProperties)) {
        try {
          if (new RegExp(pat, 'u').test(part)) { cur = cur.patternProperties[pat]; found = true; break; }
        } catch (e) {}
      }
      if (!found && cur.additionalProperties && typeof cur.additionalProperties === 'object') {
        cur = cur.additionalProperties;
      } else if (!found) return undefined;
    } else if (cur.items) {
      if (Array.isArray(cur.items)) {
        const idx = parseInt(part, 10);
        cur = idx < cur.items.length ? cur.items[idx] : cur.additionalItems;
      } else {
        cur = cur.items;
      }
    } else if (cur.additionalProperties && typeof cur.additionalProperties === 'object') {
      cur = cur.additionalProperties;
    } else {
      // Try allOf/anyOf/oneOf
      let found = false;
      for (const kw of ['allOf', 'anyOf', 'oneOf']) {
        if (Array.isArray(cur[kw])) {
          for (const sub of cur[kw]) {
            const resolved = resolveSchema(sub, rootSchema);
            if (resolved && typeof resolved === 'object' && resolved.properties && part in resolved.properties) {
              cur = resolved.properties[part];
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      if (!found) return undefined;
    }
  }
  return resolveSchema(cur, rootSchema);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMarkdownCode(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

function markdownCode(str) {
  return `\`${escapeMarkdownCode(str)}\``;
}

function pointerLabel(pointer) {
  if (!pointer) return 'root';
  const parts = pointer.slice(1).split('/').map(p =>
    p.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  const label = parts.map((part, index) => {
    if (/^\d+$/.test(part)) return '[]';
    return index > 0 && /^\d+$/.test(parts[index - 1]) ? `.${part}` : part;
  }).join('.').replace(/\.\[\]/g, '[]').replace(/\[\]\./g, '[].');
  return label || 'root';
}

function schemaTypeLabel(schema) {
  if (!schema || typeof schema !== 'object') return '';
  if (schema.type) return Array.isArray(schema.type) ? schema.type.join(' | ') : String(schema.type);
  if (schema.enum) return 'enum';
  if (schema.const !== undefined) return 'const';
  if (schema.properties || schema.additionalProperties || schema.patternProperties) return 'object';
  if (schema.items) return 'array';
  if (schema.anyOf) return 'anyOf';
  if (schema.oneOf) return 'oneOf';
  if (schema.allOf) return 'allOf';
  return '';
}

function schemaHint(schema) {
  if (!schema || typeof schema !== 'object') return '';
  if (schema.description) return String(schema.description);
  const bits = [];
  const type = schemaTypeLabel(schema);
  if (type) bits.push(type);
  if (schema.enum && Array.isArray(schema.enum)) bits.push(schema.enum.map(v => JSON.stringify(v)).join(', '));
  if (schema.examples && Array.isArray(schema.examples) && schema.examples.length) {
    bits.push(`examples ${schema.examples.map(v => JSON.stringify(v)).join(', ')}`);
  }
  if (schema.default !== undefined) bits.push(`default ${JSON.stringify(schema.default)}`);
  if (schema.format) bits.push(`format ${schema.format}`);
  return bits.join(' · ');
}

function renderPropertiesSummary(schema, rootSchema) {
  const props = collectAllProperties(schema, rootSchema);
  const entries = Object.entries(props || {});
  if (!entries.length) return '';

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shown = entries.slice(0, 12).map(([key, value]) => {
    const resolved = resolveSchema(value, rootSchema) || value;
    const hint = schemaHint(resolved);
    const req = required.has(key) ? ' *' : '';
    const suffix = hint ? ` — ${escapeHtml(hint)}` : '';
    return `<li><code>${escapeHtml(key)}</code>${req}${suffix}</li>`;
  }).join('');
  const more = entries.length > 12
    ? `<li style="opacity:.72">и ещё ${entries.length - 12}</li>`
    : '';
  const requiredLine = required.size
    ? `<div style="margin-top:6px;font-size:.9em;opacity:.86">обязательные: ${Array.from(required).map(k => `<code>${escapeHtml(k)}</code>`).join(', ')}</div>`
    : '';

  return [
    '<div style="margin-top:8px">',
    '<div style="margin-bottom:4px;font-size:.9em;opacity:.86">поля:</div>',
    `<ul style="margin:0;padding-left:18px">${shown}${more}</ul>`,
    requiredLine,
    '</div>',
  ].join('');
}

function renderPropertiesSummaryMarkdown(schema, rootSchema) {
  const props = collectAllProperties(schema, rootSchema);
  const entries = Object.entries(props || {});
  if (!entries.length) return '';

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shown = entries.slice(0, 12).map(([key, value]) => {
    const resolved = resolveSchema(value, rootSchema) || value;
    const hint = schemaHint(resolved);
    const req = required.has(key) ? ' (обязательное)' : '';
    const suffix = hint ? ` — ${hint}` : '';
    return `- ${markdownCode(key)}${req}${suffix}`;
  }).join('\n');
  const more = entries.length > 12
    ? `- и ещё ${entries.length - 12}`
    : '';
  const requiredLine = required.size
    ? `Обязательные: ${Array.from(required).map((key) => markdownCode(key)).join(', ')}`
    : '';

  return [
    'Поля:',
    shown,
    more,
    requiredLine,
  ].filter(Boolean).join('\n');
}

function renderArrayItemsSummary(schema, rootSchema) {
  if (!schema || typeof schema !== 'object' || !schema.items) return '';
  const itemSchema = resolveSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items, rootSchema);
  if (!itemSchema || typeof itemSchema !== 'object') return '';
  const itemType = schemaTypeLabel(itemSchema);
  const itemHint = schemaHint(itemSchema);
  const parts = [];
  if (itemType) parts.push(`элементы: <code>${escapeHtml(itemType)}</code>`);
  if (itemHint && itemHint !== itemType) parts.push(escapeHtml(itemHint));
  const props = renderPropertiesSummary(itemSchema, rootSchema);
  return [
    parts.length ? `<div style="margin-top:8px;font-size:.9em;opacity:.88">${parts.join(' · ')}</div>` : '',
    props,
  ].join('');
}

function renderArrayItemsSummaryMarkdown(schema, rootSchema) {
  if (!schema || typeof schema !== 'object' || !schema.items) return '';
  const itemSchema = resolveSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items, rootSchema);
  if (!itemSchema || typeof itemSchema !== 'object') return '';
  const itemType = schemaTypeLabel(itemSchema);
  const itemHint = schemaHint(itemSchema);
  const headerParts = [];
  if (itemType) headerParts.push(`Элементы: ${markdownCode(itemType)}`);
  if (itemHint && itemHint !== itemType) headerParts.push(itemHint);
  const props = renderPropertiesSummaryMarkdown(itemSchema, rootSchema);
  return [
    headerParts.join(' · '),
    props,
  ].filter(Boolean).join('\n\n');
}

function buildJsonSchemaHoverContent(rootSchema, subSchema, pointer, currentValue) {
  const deprecationMessage = schemaDeprecationMessage(subSchema, currentValue);
  const label = pointerLabel(pointer);
  const htmlParts = [];
  const markdownParts = [];
  const plainParts = [];

  if (label) {
    htmlParts.push(`<div style="margin-bottom:5px;font-size:.9em;opacity:.74"><code>${escapeHtml(label)}</code></div>`);
    markdownParts.push(`**${markdownCode(label)}**`);
    plainParts.push(label);
  }

  if (subSchema.description) {
    const description = String(subSchema.description);
    htmlParts.push(`<div style="margin-bottom:6px">${escapeHtml(description)}</div>`);
    markdownParts.push(description);
    plainParts.push(description);
  }

  if (deprecationMessage) {
    const message = String(deprecationMessage);
    htmlParts.push(`<div style="margin-bottom:6px;padding:6px 8px;border-radius:8px;border:1px solid rgba(245, 158, 11, 0.35);background:rgba(245, 158, 11, 0.12);color:#fcd34d">${escapeHtml(message)}</div>`);
    markdownParts.push(`> ${message}`);
    plainParts.push(message);
  }

  const typeInfoHtml = [];
  const typeInfoMarkdown = [];
  const typeInfoPlain = [];
  if (subSchema.type) {
    const typeText = Array.isArray(subSchema.type) ? subSchema.type.join(' | ') : subSchema.type;
    typeInfoHtml.push(`тип: <code>${escapeHtml(typeText)}</code>`);
    typeInfoMarkdown.push(`Тип: ${markdownCode(typeText)}`);
    typeInfoPlain.push(`Тип: ${typeText}`);
  }
  if (subSchema.enum) {
    const enumHtml = subSchema.enum.map((value) => `<code>${escapeHtml(JSON.stringify(value))}</code>`).join(', ');
    const enumMarkdown = subSchema.enum.map((value) => markdownCode(JSON.stringify(value))).join(', ');
    typeInfoHtml.push(`enum: ${enumHtml}`);
    typeInfoMarkdown.push(`Допустимые значения: ${enumMarkdown}`);
    typeInfoPlain.push(`Допустимые значения: ${subSchema.enum.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  if (subSchema.examples && Array.isArray(subSchema.examples) && subSchema.examples.length) {
    const examplesHtml = subSchema.examples.map((value) => `<code>${escapeHtml(JSON.stringify(value))}</code>`).join(', ');
    const examplesMarkdown = subSchema.examples.map((value) => markdownCode(JSON.stringify(value))).join(', ');
    typeInfoHtml.push(`примеры: ${examplesHtml}`);
    typeInfoMarkdown.push(`Примеры: ${examplesMarkdown}`);
    typeInfoPlain.push(`Примеры: ${subSchema.examples.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  if (subSchema.default !== undefined) {
    const defaultText = JSON.stringify(subSchema.default);
    typeInfoHtml.push(`по-умолчанию: <code>${escapeHtml(defaultText)}</code>`);
    typeInfoMarkdown.push(`По умолчанию: ${markdownCode(defaultText)}`);
    typeInfoPlain.push(`По умолчанию: ${defaultText}`);
  }
  if (subSchema.format) {
    const formatText = String(subSchema.format);
    typeInfoHtml.push(`формат: <code>${escapeHtml(formatText)}</code>`);
    typeInfoMarkdown.push(`Формат: ${markdownCode(formatText)}`);
    typeInfoPlain.push(`Формат: ${formatText}`);
  }
  if (subSchema.pattern) {
    const patternText = String(subSchema.pattern);
    typeInfoHtml.push(`паттерн: <code>${escapeHtml(patternText)}</code>`);
    typeInfoMarkdown.push(`Паттерн: ${markdownCode(patternText)}`);
    typeInfoPlain.push(`Паттерн: ${patternText}`);
  }
  if (subSchema.minimum !== undefined || subSchema.maximum !== undefined) {
    const rangeHtml = [];
    const rangeMarkdown = [];
    const rangePlain = [];
    if (subSchema.minimum !== undefined) {
      rangeHtml.push(`мин: ${subSchema.minimum}`);
      rangeMarkdown.push(`мин: ${subSchema.minimum}`);
      rangePlain.push(`мин: ${subSchema.minimum}`);
    }
    if (subSchema.maximum !== undefined) {
      rangeHtml.push(`макс: ${subSchema.maximum}`);
      rangeMarkdown.push(`макс: ${subSchema.maximum}`);
      rangePlain.push(`макс: ${subSchema.maximum}`);
    }
    typeInfoHtml.push(rangeHtml.join(', '));
    typeInfoMarkdown.push(rangeMarkdown.join(', '));
    typeInfoPlain.push(rangePlain.join(', '));
  }

  if (typeInfoHtml.length) {
    htmlParts.push(`<div style="font-size:0.9em;opacity:0.85">${typeInfoHtml.join(' · ')}</div>`);
    markdownParts.push(typeInfoMarkdown.join(' · '));
    plainParts.push(typeInfoPlain.join(' · '));
  }

  if (schemaTypeLabel(subSchema).includes('object') || subSchema.properties || subSchema.anyOf || subSchema.allOf || subSchema.oneOf) {
    const propertiesSummary = renderPropertiesSummary(subSchema, rootSchema);
    const propertiesSummaryMarkdown = renderPropertiesSummaryMarkdown(subSchema, rootSchema);
    if (propertiesSummary) htmlParts.push(propertiesSummary);
    if (propertiesSummaryMarkdown) markdownParts.push(propertiesSummaryMarkdown);
    if (propertiesSummaryMarkdown) plainParts.push(propertiesSummaryMarkdown.replace(/`/g, ''));
  }

  if (schemaTypeLabel(subSchema).includes('array') || subSchema.items) {
    const arraySummary = renderArrayItemsSummary(subSchema, rootSchema);
    const arraySummaryMarkdown = renderArrayItemsSummaryMarkdown(subSchema, rootSchema);
    if (arraySummary) htmlParts.push(arraySummary);
    if (arraySummaryMarkdown) markdownParts.push(arraySummaryMarkdown);
    if (arraySummaryMarkdown) plainParts.push(arraySummaryMarkdown.replace(/`/g, ''));
  }

  return {
    html: htmlParts.join(''),
    markdown: markdownParts.filter(Boolean).join('\n\n').trim(),
    plain: plainParts.filter(Boolean).join('\n\n').trim(),
  };
}

function findJsonSchemaHoverTarget(pointerMap, offset) {
  if (!(pointerMap instanceof Map)) return null;
  const probe = Math.max(0, Number(offset || 0));
  const candidates = [];
  pointerMap.forEach((mapping, pointer) => {
    const keyFrom = Math.max(0, Number(mapping && mapping.keyFrom));
    const keyTo = Math.max(keyFrom, Number(mapping && mapping.keyTo));
    const valueFrom = Math.max(0, Number(mapping && mapping.valueFrom));
    const valueTo = Math.max(valueFrom, Number(mapping && mapping.valueTo));
    if (probe >= keyFrom && probe <= keyTo) {
      candidates.push({
        pointer,
        from: keyFrom,
        to: keyTo,
        span: Math.max(0, keyTo - keyFrom),
        depth: errorPointerDepth({ pointer }),
        kind: 'key',
      });
    }
    if (probe >= valueFrom && probe <= valueTo) {
      candidates.push({
        pointer,
        from: valueFrom,
        to: valueTo,
        span: Math.max(0, valueTo - valueFrom),
        depth: errorPointerDepth({ pointer }),
        kind: 'value',
      });
    }
  });
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    if (left.span !== right.span) return left.span - right.span;
    if (left.depth !== right.depth) return right.depth - left.depth;
    if (left.kind !== right.kind) return left.kind === 'key' ? -1 : 1;
    return 0;
  });
  return candidates[0] || null;
}

function buildJsonSchemaHoverInfo(text, schema, offset) {
  if (!schema || typeof schema !== 'object') return null;
  const source = String(text || '');
  if (!source.trim()) return null;
  const pointerMap = buildJsoncPointerMap(source);
  const target = findJsonSchemaHoverTarget(pointerMap, offset);
  if (!target) return null;
  const subSchema = getSchemaAtPointer(schema, schema, target.pointer);
  if (!subSchema || typeof subSchema !== 'object') return null;
  const docValue = safeParseJson(source);
  const currentValue = docValue == null ? undefined : getValueAtPointer(docValue, target.pointer);
  const content = buildJsonSchemaHoverContent(schema, subSchema, target.pointer, currentValue);
  if (!content.html && !content.markdown && !content.plain) return null;
  return {
    from: target.from,
    to: target.to,
    pointer: target.pointer,
    html: content.html,
    markdown: content.markdown,
    plain: content.plain,
  };
}

function jsonSchemaHover(options) {
  return async function schemaHoverSource(view, pos, side) {
    const schema = getJSONSchema(view.state);
    if (!schema) return null;
    const probe = Math.max(0, pos + (side < 0 ? -1 : 0));
    const result = buildJsonSchemaHoverInfo(view.state.doc.toString(), schema, probe);
    if (!result || !result.html) return null;

    return {
      pos: Math.max(0, Number(result.from || 0)),
      end: Math.max(0, Number(result.to || result.from || 0)),
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm6-json-schema-hover';
        dom.style.cssText = 'padding:8px 12px;max-width:520px;line-height:1.45;font-size:13px;';
        dom.innerHTML = result.html;
        return { dom };
      },
    };
  };
}

/* ════════════════════════════════════════════════════════════
 *  6. jsonCompletion — autocomplete from schema
 * ════════════════════════════════════════════════════════════ */

function collectAllProperties(schema, rootSchema) {
  if (!schema || typeof schema !== 'object') return {};
  schema = resolveSchema(schema, rootSchema);
  if (!schema) return {};

  const result = {};
  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      const resolved = resolveSchema(val, rootSchema);
      result[key] = resolved || val;
    }
  }
  // Also collect from allOf/anyOf/oneOf
  for (const kw of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[kw])) {
      for (const sub of schema[kw]) {
        Object.assign(result, collectAllProperties(sub, rootSchema));
      }
    }
  }
  // if/then
  if (schema.then) Object.assign(result, collectAllProperties(schema.then, rootSchema));

  return result;
}

function getValueSnippet(propSchema) {
  if (!propSchema || typeof propSchema !== 'object') return '';
  if (propSchema.default !== undefined) return JSON.stringify(propSchema.default);
  if (propSchema.enum && propSchema.enum.length === 1) return JSON.stringify(propSchema.enum[0]);
  if (propSchema.const !== undefined) return JSON.stringify(propSchema.const);

  const type = Array.isArray(propSchema.type) ? propSchema.type[0] : propSchema.type;
  switch (type) {
    case 'string': return '""';
    case 'number': case 'integer': return '0';
    case 'boolean': return 'false';
    case 'object': return '{}';
    case 'array': return '[]';
    case 'null': return 'null';
    default: return '""';
  }
}

function escapePointerPart(part) {
  return String(part == null ? '' : part).replace(/~/g, '~0').replace(/\//g, '~1');
}

function joinPointer(base, part) {
  const clean = escapePointerPart(part);
  return base ? `${base}/${clean}` : `/${clean}`;
}

function readJsonStringToken(text, start) {
  const quote = text[start];
  let escaped = false;
  let raw = quote;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    raw += ch;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      try {
        return { value: JSON.parse(raw), end: i + 1 };
      } catch (e) {
        return { value: raw.slice(1, -1), end: i + 1 };
      }
    }
  }
  return { value: raw.slice(1), end: text.length };
}

function inferObjectPointerBefore(text) {
  const context = inferJsonContextBefore(text);
  return context && context.objectPointer != null ? context.objectPointer : null;
}

function inferJsonContextBefore(text) {
  const stack = [{ type: 'root', path: '', index: 0, pendingKey: null }];
  let lastString = null;

  const top = () => stack[stack.length - 1];
  const pathForNewValue = () => {
    const frame = top();
    if (!frame) return '';
    if (frame.type === 'object' && frame.pendingKey != null) {
      const pointer = joinPointer(frame.path, frame.pendingKey);
      frame.pendingKey = null;
      return pointer;
    }
    if (frame.type === 'array') return joinPointer(frame.path, String(frame.index || 0));
    return frame.path || '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i < text.length) i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      lastString = readJsonStringToken(text, i);
      i = lastString.end - 1;
      continue;
    }
    if (/\s/.test(ch)) continue;

    if (ch === ':') {
      const frame = top();
      if (frame && frame.type === 'object' && lastString) frame.pendingKey = lastString.value;
      lastString = null;
      continue;
    }
    if (ch === '{') {
      stack.push({ type: 'object', path: pathForNewValue(), index: 0, pendingKey: null });
      lastString = null;
      continue;
    }
    if (ch === '[') {
      stack.push({ type: 'array', path: pathForNewValue(), index: 0, pendingKey: null });
      lastString = null;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length > 1) stack.pop();
      lastString = null;
      continue;
    }
    if (ch === ',') {
      const frame = top();
      if (frame) {
        if (frame.type === 'array') frame.index = (frame.index || 0) + 1;
        if (frame.type === 'object') frame.pendingKey = null;
      }
      lastString = null;
      continue;
    }

    lastString = null;
  }

  const frame = top();
  if (!frame) return null;
  const objectPointer = frame.type === 'object' ? frame.path || '' : null;
  let valuePointer = null;
  if (frame.type === 'object' && frame.pendingKey != null) {
    valuePointer = joinPointer(frame.path || '', frame.pendingKey);
  } else if (frame.type === 'array') {
    valuePointer = joinPointer(frame.path || '', String(frame.index || 0));
  }
  return {
    objectPointer,
    pendingKey: frame.type === 'object' ? frame.pendingKey : null,
    valuePointer,
  };
}

function findPreviousSignificantChar(doc, pos) {
  const text = doc.sliceString(0, pos);
  let inString = false;
  let quote = '';
  let escaped = false;
  let last = '';

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      last = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i < text.length) i += 1;
      continue;
    }
    if (!/\s/.test(ch)) last = ch;
  }

  return last;
}

function completionKeyToken(ctx) {
  const token = ctx.matchBefore(/["']?[A-Za-z_$][\w$-]*$/);
  if (!token) return null;
  const previous = findPreviousSignificantChar(ctx.state.doc, token.from);
  if (previous && previous !== '{' && previous !== ',') return null;
  const quote = token.text[0] === '"' || token.text[0] === "'";
  const prefix = quote ? token.text.slice(1) : token.text;
  const to = quote && ctx.state.doc.sliceString(ctx.pos, ctx.pos + 1) === token.text[0]
    ? ctx.pos + 1
    : token.to;
  return {
    from: token.from,
    to,
    prefix,
  };
}

function propertyCompletionResult(schema, parentSchema, opts) {
  const allProps = collectAllProperties(parentSchema, schema);
  const requiredSet = new Set(parentSchema.required || []);
  const existingKeys = opts && opts.existingKeys ? opts.existingKeys : new Set();
  const prefix = String((opts && opts.prefix) || '').replace(/^["']/, '');
  const prefixLower = prefix.toLowerCase();
  const hasColon = !!(opts && opts.hasColon);
  const completions = [];

  for (const [key, propSchema] of Object.entries(allProps)) {
    if (existingKeys.has(key)) continue;
    if (prefixLower && !key.toLowerCase().startsWith(prefixLower)) continue;

    const resolved = resolveSchema(propSchema, schema);
    const detail = resolved ? (Array.isArray(resolved.type) ? resolved.type.join('|') : resolved.type || '') : '';
    const info = resolved && resolved.description ? resolved.description : undefined;
    const boost = requiredSet.has(key) ? 10 : 0;
    const apply = hasColon ? `"${key}"` : `"${key}": ${getValueSnippet(resolved)}`;

    completions.push({
      label: key,
      detail,
      info,
      type: 'property',
      boost,
      apply,
    });
  }

  if (!completions.length) return null;
  return {
    from: opts.from,
    to: opts.to,
    options: completions,
    filter: false,
    validFor: /^["']?[\w$-]*$/,
  };
}

function completionValueToken(ctx) {
  const token = ctx.matchBefore(/["']?[\w$.-]*$/);
  if (!token && !ctx.explicit) return null;
  const base = token || { from: ctx.pos, to: ctx.pos, text: '' };
  const previous = findPreviousSignificantChar(ctx.state.doc, base.from);
  if (previous !== ':' && previous !== '[' && previous !== ',') return null;
  const quote = base.text[0] === '"' || base.text[0] === "'";
  const prefix = quote ? base.text.slice(1) : base.text;
  const to = quote && ctx.state.doc.sliceString(ctx.pos, ctx.pos + 1) === base.text[0]
    ? ctx.pos + 1
    : base.to;
  return {
    from: base.from,
    to,
    prefix,
  };
}

function valueCompletionLabel(value) {
  return JSON.stringify(value).replace(/^"(.*)"$/, '$1');
}

function valueCompletionResult(schema, valueSchema, opts) {
  const resolved = resolveSchema(valueSchema, schema);
  if (!resolved || typeof resolved !== 'object') return null;

  const prefix = String((opts && opts.prefix) || '').replace(/^["']/, '');
  const prefixLower = prefix.toLowerCase();
  const completions = [];
  const seen = new Set();
  const pushCompletion = (label, apply, type, detail, info) => {
    if (prefixLower && !String(label).toLowerCase().startsWith(prefixLower)) return;
    const dedupeKey = `${String(label)}\u0000${String(apply)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    completions.push({ label, apply, type, detail, info });
  };

  if (resolved.enum) {
    for (const val of resolved.enum) {
      const info = schemaDeprecationMessage(resolved, val) || undefined;
      pushCompletion(
        valueCompletionLabel(val),
        JSON.stringify(val),
        resolved.type || 'enum',
        info ? 'deprecated' : 'enum',
        info
      );
    }
  }

  if (resolved.const !== undefined) {
    pushCompletion(valueCompletionLabel(resolved.const), JSON.stringify(resolved.const), 'constant', 'const');
  }

  if (Array.isArray(resolved.examples)) {
    for (const val of resolved.examples) {
      pushCompletion(valueCompletionLabel(val), JSON.stringify(val), resolved.type || 'text', 'example');
    }
  }

  if (resolved.type === 'boolean') {
    pushCompletion('true', 'true', 'keyword', 'boolean');
    pushCompletion('false', 'false', 'keyword', 'boolean');
  }

  if (resolved.default !== undefined && !resolved.enum) {
    pushCompletion(valueCompletionLabel(resolved.default), JSON.stringify(resolved.default), 'text', 'default');
  }

  if (!completions.length) return null;
  return {
    from: opts.from,
    to: opts.to,
    options: completions,
    filter: false,
    validFor: /^["']?[\w$.-]*$/,
  };
}

function fallbackPropertyCompletion(ctx, schema) {
  const token = completionKeyToken(ctx);
  if (!token) return null;
  const pointer = inferObjectPointerBefore(ctx.state.doc.sliceString(0, token.from));
  if (pointer == null) return null;
  const parentSchema = getSchemaAtPointer(schema, schema, pointer);
  if (!parentSchema || typeof parentSchema !== 'object') return null;
  return propertyCompletionResult(schema, parentSchema, {
    from: token.from,
    to: token.to,
    prefix: token.prefix,
  });
}

function fallbackValueCompletion(ctx, schema) {
  const token = completionValueToken(ctx);
  if (!token) return null;
  const context = inferJsonContextBefore(ctx.state.doc.sliceString(0, token.from));
  const pointer = context && context.valuePointer;
  if (!pointer) return null;
  const valueSchema = getSchemaAtPointer(schema, schema, pointer);
  return valueCompletionResult(schema, valueSchema, {
    from: token.from,
    to: token.to,
    prefix: token.prefix,
  });
}

function jsonCompletion(options) {
  return function jsonDoCompletion(ctx) {
    const schema = getJSONSchema(ctx.state);
    if (!schema) return null;

    const tree = syntaxTree(ctx.state);
    const node = tree.resolveInner(ctx.pos, -1);
    const doc = ctx.state.doc;
    const nodeIsError = !!(node && node.type && node.type.isError);

    if (nodeIsError) {
      const earlyValueCompletion = fallbackValueCompletion(ctx, schema);
      if (earlyValueCompletion) return earlyValueCompletion;
      const earlyPropertyCompletion = fallbackPropertyCompletion(ctx, schema);
      if (earlyPropertyCompletion) return earlyPropertyCompletion;
    }

    // Determine if we're in a property name or value context
    let isPropertyName = false;
    let isValue = false;
    let parentObjectNode = null;
    let propertyKey = null;
    let valuePointer = null;

    if (node.name === 'PropertyName' || (node.name === '⚠' && node.parent && node.parent.name === 'Property')) {
      isPropertyName = true;
      parentObjectNode = node.parent ? node.parent.parent : null;
    } else if (node.name === 'String' || node.name === 'Number' || node.name === 'True' ||
               node.name === 'False' || node.name === 'Null' || node.name === '⚠') {
      // Check if this is a property value
      const prop = node.parent;
      if (prop && prop.name === 'Property') {
        const nameNode = getChildNodes(prop).find(c => c.name === 'PropertyName');
        if (nameNode) {
          propertyKey = getWord(doc, nameNode);
          isValue = true;
          parentObjectNode = prop.parent;
          valuePointer = getJsonPointerAt(doc, node);
        }
      } else {
        valuePointer = getJsonPointerAt(doc, node);
        if (valuePointer) isValue = true;
      }
    }

    // Also handle: cursor is right after a colon (between colon and value)
    if (!isPropertyName && !isValue) {
      // check if explicit completion was requested
      if (!ctx.explicit) return fallbackPropertyCompletion(ctx, schema) || fallbackValueCompletion(ctx, schema);

      // Try to figure out context from ancestors
      let n = node;
      while (n) {
        if (n.name === 'Object') { parentObjectNode = n; isPropertyName = true; break; }
        if (n.name === 'Property') {
          const nameNode = getChildNodes(n).find(c => c.name === 'PropertyName');
          if (nameNode) {
            propertyKey = getWord(doc, nameNode);
            isValue = true;
            parentObjectNode = n.parent;
            valuePointer = getJsonPointerAt(doc, node);
          }
          break;
        }
        n = n.parent;
      }
    }

    if (!isPropertyName && !isValue) return fallbackPropertyCompletion(ctx, schema) || fallbackValueCompletion(ctx, schema);

    // Find the JSON pointer to the parent object
    const pointer = parentObjectNode ? getJsonPointerAt(doc, parentObjectNode) : '';
    const parentSchema = getSchemaAtPointer(schema, schema, pointer);

    // --- Property name completions ---
    if (isPropertyName) {
      if (!parentSchema || typeof parentSchema !== 'object') return null;
      // Find existing keys in this object
      const existingKeys = new Set();
      if (parentObjectNode) {
        for (const child of getChildNodes(parentObjectNode)) {
          if (child.name === 'Property') {
            const kn = getChildNodes(child).find(c => c.name === 'PropertyName');
            const isCurrentKey = node.name === 'PropertyName' && kn && kn.from === node.from && kn.to === node.to;
            if (kn && !isCurrentKey) existingKeys.add(getWord(doc, kn));
          }
        }
      }

      // Determine replacement range
      let from = ctx.pos;
      let to = ctx.pos;
      if (node.name === 'PropertyName') {
        from = node.from;
        to = node.to;
      }

      const prefix = doc.sliceString(from, ctx.pos).replace(/^"/, '');

      const afterNode = node.name === 'PropertyName' ? node.nextSibling : null;
      const hasColon = afterNode && doc.sliceString(afterNode.from, afterNode.from + 1) === ':';
      return propertyCompletionResult(schema, parentSchema, {
        from,
        to,
        prefix,
        existingKeys,
        hasColon,
      });
    }

    // --- Value completions ---
    if (isValue) {
      const propSchema = valuePointer
        ? getSchemaAtPointer(schema, schema, valuePointer)
        : resolveSchema(
            (parentSchema && parentSchema.properties && propertyKey && parentSchema.properties[propertyKey]) || null,
            schema
          );
      if (!propSchema || typeof propSchema !== 'object') return null;

      let from = node.from;
      let to = node.to;
      const rawBeforeCursor = doc.sliceString(node.from, Math.min(ctx.pos, node.to));
      const prefix = rawBeforeCursor.replace(/^["']/, '');
      return valueCompletionResult(schema, propSchema, { from, to, prefix });
    }

    return null;
  };
}

/* ════════════════════════════════════════════════════════════
 *  Exports
 * ════════════════════════════════════════════════════════════ */

export {
  stateExtensions,
  updateSchema,
  getJSONSchema,
  schemaStateField,
  jsonSchemaLinter,
  handleRefresh,
  jsonSchemaHover,
  buildJsonSchemaHoverInfo,
  jsonCompletion,
};
