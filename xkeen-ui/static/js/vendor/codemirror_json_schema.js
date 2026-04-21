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
import { parse as parseJsonc } from 'jsonc-parser';

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

    // required
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) {
          errors.push({ pointer: p ? `${p}/${req}` : `/${req}`, message: `Обязательное свойство \`${req}\` отсутствует` });
        }
      }
    }

    // properties
    const props = schema.properties || {};
    const patterns = schema.patternProperties || {};
    const additional = schema.additionalProperties;

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
        errors.push({ pointer: childPointer, message: `Свойство \`${key}\` не разрешено схемой` });
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
    const matching = schema.anyOf.some(sub => {
      const resolved = resolveSchema(sub, rootSchema);
      return validateValue(value, resolved, rootSchema, p).length === 0;
    });
    if (!matching) errors.push({ pointer: p, message: `Значение не соответствует ни одной из anyOf-схем` });
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
      let idx = 0;
      let sibling = n.parent.firstChild;
      while (sibling && sibling !== n) {
        if (sibling.name !== '[' && sibling.name !== ']' && sibling.name !== ',') idx++;
        sibling = sibling.nextSibling;
      }
      // Adjust: only count value nodes
      const valueChildren = getChildNodes(n.parent).filter(c =>
        c.name !== '[' && c.name !== ']' && c.name !== ','
      );
      const foundIdx = valueChildren.indexOf(n);
      if (foundIdx >= 0) path.unshift(`${foundIdx}`);
    }
  }
  return path.length ? '/' + path.join('/') : '';
}

/**
 * Build a Map<pointer, {keyFrom, keyTo, valueFrom, valueTo}> from the syntax tree
 */
function buildPointerMap(state) {
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
      const mapping = pointerMap.get(pointer);

      let from = 0, to = 0;
      if (mapping) {
        // For "property missing" errors, highlight the parent object key
        // For value errors, highlight the value
        if (err.message.includes('отсутствует') || err.message.includes('не разрешено')) {
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

      diagnostics.push({
        from,
        to,
        severity: 'warning',
        message: err.message,
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

function jsonSchemaHover(options) {
  return async function schemaHoverSource(view, pos, side) {
    const schema = getJSONSchema(view.state);
    if (!schema) return null;

    const tree = syntaxTree(view.state);
    const node = tree.resolveInner(pos, side);
    const doc = view.state.doc;
    const pointer = getJsonPointerAt(doc, node);
    if (pointer === '' && node.name === 'JsonText') return null;

    const subSchema = getSchemaAtPointer(schema, schema, pointer);
    if (!subSchema || typeof subSchema !== 'object') return null;

    // Build tooltip content
    const parts = [];
    const label = pointerLabel(pointer);
    if (label) {
      parts.push(`<div style="margin-bottom:5px;font-size:.9em;opacity:.74"><code>${escapeHtml(label)}</code></div>`);
    }

    if (subSchema.description) {
      parts.push(`<div style="margin-bottom:6px">${escapeHtml(subSchema.description)}</div>`);
    }

    const typeInfo = [];
    if (subSchema.type) {
      const t = Array.isArray(subSchema.type) ? subSchema.type.join(' | ') : subSchema.type;
      typeInfo.push(`тип: <code>${escapeHtml(t)}</code>`);
    }
    if (subSchema.enum) {
      typeInfo.push(`enum: ${subSchema.enum.map(e => `<code>${escapeHtml(JSON.stringify(e))}</code>`).join(', ')}`);
    }
    if (subSchema.default !== undefined) {
      typeInfo.push(`по-умолчанию: <code>${escapeHtml(JSON.stringify(subSchema.default))}</code>`);
    }
    if (subSchema.format) {
      typeInfo.push(`формат: <code>${escapeHtml(subSchema.format)}</code>`);
    }
    if (subSchema.pattern) {
      typeInfo.push(`паттерн: <code>${escapeHtml(subSchema.pattern)}</code>`);
    }
    if (subSchema.minimum !== undefined || subSchema.maximum !== undefined) {
      const range = [];
      if (subSchema.minimum !== undefined) range.push(`мин: ${subSchema.minimum}`);
      if (subSchema.maximum !== undefined) range.push(`макс: ${subSchema.maximum}`);
      typeInfo.push(range.join(', '));
    }

    if (typeInfo.length) {
      parts.push(`<div style="font-size:0.9em;opacity:0.85">${typeInfo.join(' · ')}</div>`);
    }

    if (schemaTypeLabel(subSchema).includes('object') || subSchema.properties || subSchema.anyOf || subSchema.allOf || subSchema.oneOf) {
      const propertiesSummary = renderPropertiesSummary(subSchema, schema);
      if (propertiesSummary) parts.push(propertiesSummary);
    }

    if (schemaTypeLabel(subSchema).includes('array') || subSchema.items) {
      const arraySummary = renderArrayItemsSummary(subSchema, schema);
      if (arraySummary) parts.push(arraySummary);
    }

    if (!parts.length) return null;

    return {
      pos: node.from,
      end: node.to,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm6-json-schema-hover';
        dom.style.cssText = 'padding:8px 12px;max-width:520px;line-height:1.45;font-size:13px;';
        dom.innerHTML = parts.join('');
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

function jsonCompletion(options) {
  return function jsonDoCompletion(ctx) {
    const schema = getJSONSchema(ctx.state);
    if (!schema) return null;

    const tree = syntaxTree(ctx.state);
    const node = tree.resolveInner(ctx.pos, -1);
    const doc = ctx.state.doc;

    // Determine if we're in a property name or value context
    let isPropertyName = false;
    let isValue = false;
    let parentObjectNode = null;
    let propertyKey = null;

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
        }
      }
    }

    // Also handle: cursor is right after a colon (between colon and value)
    if (!isPropertyName && !isValue) {
      // check if explicit completion was requested
      if (!ctx.explicit) return null;

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
          }
          break;
        }
        n = n.parent;
      }
    }

    if (!isPropertyName && !isValue) return null;

    // Find the JSON pointer to the parent object
    const pointer = parentObjectNode ? getJsonPointerAt(doc, parentObjectNode) : '';
    const parentSchema = getSchemaAtPointer(schema, schema, pointer);
    if (!parentSchema || typeof parentSchema !== 'object') return null;

    // --- Property name completions ---
    if (isPropertyName) {
      const allProps = collectAllProperties(parentSchema, schema);
      const requiredSet = new Set(parentSchema.required || []);

      // Find existing keys in this object
      const existingKeys = new Set();
      if (parentObjectNode) {
        for (const child of getChildNodes(parentObjectNode)) {
          if (child.name === 'Property') {
            const kn = getChildNodes(child).find(c => c.name === 'PropertyName');
            if (kn) existingKeys.add(getWord(doc, kn));
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

      const completions = [];
      for (const [key, propSchema] of Object.entries(allProps)) {
        if (existingKeys.has(key)) continue;
        if (prefix && !key.startsWith(prefix)) continue;

        const resolved = resolveSchema(propSchema, schema);
        const detail = resolved ? (Array.isArray(resolved.type) ? resolved.type.join('|') : resolved.type || '') : '';
        const info = resolved && resolved.description ? resolved.description : undefined;
        const boost = requiredSet.has(key) ? 10 : 0;

        // Determine if we need to add `: value` part
        // Check if there's already a colon after the property name
        const afterNode = node.name === 'PropertyName' ? node.nextSibling : null;
        const hasColon = afterNode && doc.sliceString(afterNode.from, afterNode.from + 1) === ':';

        let apply;
        if (hasColon) {
          apply = `"${key}"`;
        } else {
          const valSnippet = getValueSnippet(resolved);
          apply = `"${key}": ${valSnippet}`;
        }

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
      return { from, to, options: completions, filter: false };
    }

    // --- Value completions ---
    if (isValue && propertyKey) {
      const propSchema = resolveSchema(
        (parentSchema.properties && parentSchema.properties[propertyKey]) || null,
        schema
      );
      if (!propSchema || typeof propSchema !== 'object') return null;

      const completions = [];
      let from = node.from;
      let to = node.to;

      // enum values
      if (propSchema.enum) {
        for (const val of propSchema.enum) {
          completions.push({
            label: JSON.stringify(val).replace(/^"(.*)"$/, '$1'),
            apply: JSON.stringify(val),
            type: propSchema.type || 'enum',
            detail: 'enum',
          });
        }
      }

      // const
      if (propSchema.const !== undefined) {
        completions.push({
          label: JSON.stringify(propSchema.const).replace(/^"(.*)"$/, '$1'),
          apply: JSON.stringify(propSchema.const),
          type: 'constant',
          detail: 'const',
        });
      }

      // boolean
      if (propSchema.type === 'boolean') {
        completions.push({ label: 'true', type: 'keyword' });
        completions.push({ label: 'false', type: 'keyword' });
      }

      // default
      if (propSchema.default !== undefined && !propSchema.enum) {
        completions.push({
          label: JSON.stringify(propSchema.default).replace(/^"(.*)"$/, '$1'),
          apply: JSON.stringify(propSchema.default),
          type: 'text',
          detail: 'default',
        });
      }

      if (!completions.length) return null;
      return { from, to, options: completions };
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
  jsonCompletion,
};
