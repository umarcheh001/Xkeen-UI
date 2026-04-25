import { buildJsoncPointerMap } from '../vendor/codemirror_json_schema.js';

function asString(value) {
  return value == null ? '' : String(value);
}

export function diagnosticPointerLabel(pointer) {
  const text = asString(pointer);
  if (!text || text === '/') return 'root';
  const parts = text.slice(1).split('/').filter(Boolean).map((part) =>
    part.replace(/~1/g, '/').replace(/~0/g, '~'),
  );
  if (!parts.length) return 'root';
  return parts.reduce((acc, part) => {
    if (/^\d+$/.test(part)) return `${acc}[${part}]`;
    return acc ? `${acc}.${part}` : part;
  }, '');
}

export function findPointerAtRange(pointerMap, from, to) {
  if (!pointerMap || typeof pointerMap.forEach !== 'function') return '';
  const start = Math.max(0, Number(from || 0));
  const end = Math.max(start, Number(to != null ? to : from || 0));

  let exactKeyHit = null;
  let bestPointer = '';
  let bestSpan = Infinity;

  pointerMap.forEach((mapping, pointer) => {
    if (!mapping) return;
    const keyFrom = Number.isFinite(mapping.keyFrom) ? Number(mapping.keyFrom) : null;
    const keyTo = Number.isFinite(mapping.keyTo) ? Number(mapping.keyTo) : null;
    const valueFrom = Number.isFinite(mapping.valueFrom) ? Number(mapping.valueFrom) : null;
    const valueTo = Number.isFinite(mapping.valueTo) ? Number(mapping.valueTo) : null;

    if (exactKeyHit == null && keyFrom === start && keyTo === end) {
      exactKeyHit = pointer;
      return;
    }

    const boundsFrom = Math.min(
      keyFrom != null ? keyFrom : Infinity,
      valueFrom != null ? valueFrom : Infinity,
    );
    const boundsTo = Math.max(
      keyTo != null ? keyTo : -Infinity,
      valueTo != null ? valueTo : -Infinity,
    );
    if (!Number.isFinite(boundsFrom) || !Number.isFinite(boundsTo)) return;
    if (boundsFrom > start || boundsTo < end) return;

    const span = boundsTo - boundsFrom;
    if (span < bestSpan) {
      bestSpan = span;
      bestPointer = pointer;
    }
  });

  return exactKeyHit != null ? exactKeyHit : bestPointer;
}

const MONACO_MESSAGE_PATTERNS = [
  {
    re: /^Property\s+(.+?)\s+is not allowed\.?\s*$/i,
    ru: (m) => `Свойство \`${m[1].trim()}\` не разрешено схемой`,
  },
  {
    re: /^Missing property\s+"(.+?)"\.?\s*$/i,
    ru: (m) => `Отсутствует обязательное свойство \`${m[1]}\``,
  },
  {
    re: /^Value is not accepted\.\s*Valid values:\s*(.+?)\.?\s*$/i,
    ru: (m) => `Значение не разрешено. Допустимые значения: ${m[1].trim()}`,
  },
  {
    re: /^Incorrect type\.\s*Expected\s+"(.+?)"\.?\s*$/i,
    ru: (m) => `Неверный тип. Ожидается \`${m[1]}\``,
  },
  {
    re: /^String does not match the pattern of\s+"(.+?)"\.?\s*$/i,
    ru: (m) => `Строка не соответствует шаблону \`${m[1]}\``,
  },
  {
    re: /^String is shorter than the minimum length of\s+(\d+)\.?\s*$/i,
    ru: (m) => `Строка короче минимальной длины ${m[1]}`,
  },
  {
    re: /^String is longer than the maximum length of\s+(\d+)\.?\s*$/i,
    ru: (m) => `Строка длиннее максимальной длины ${m[1]}`,
  },
  {
    re: /^Value is below the minimum of\s+(\S+?)\.?\s*$/i,
    ru: (m) => `Значение меньше минимума ${m[1]}`,
  },
  {
    re: /^Value is above the maximum of\s+(\S+?)\.?\s*$/i,
    ru: (m) => `Значение больше максимума ${m[1]}`,
  },
  {
    re: /^Value must be a multiple of\s+(\S+?)\.?\s*$/i,
    ru: (m) => `Значение должно быть кратно ${m[1]}`,
  },
  {
    re: /^Array has too few items\.\s*Expected at least\s+(\d+)\.?\s*$/i,
    ru: (m) => `Массив содержит слишком мало элементов. Нужно минимум ${m[1]}`,
  },
  {
    re: /^Array has too many items\.\s*Expected at most\s+(\d+)\.?\s*$/i,
    ru: (m) => `Массив содержит слишком много элементов. Нужно максимум ${m[1]}`,
  },
  {
    re: /^Array should not contain duplicates\.?\s*$/i,
    ru: () => 'Элементы массива должны быть уникальными',
  },
  {
    re: /^Object has too few properties\.\s*Expected at least\s+(\d+)\.?\s*$/i,
    ru: (m) => `Объект содержит слишком мало свойств. Нужно минимум ${m[1]}`,
  },
  {
    re: /^Object has too many properties\.\s*Expected at most\s+(\d+)\.?\s*$/i,
    ru: (m) => `Объект содержит слишком много свойств. Нужно максимум ${m[1]}`,
  },
  {
    re: /^Matches a schema that is not allowed\.?\s*$/i,
    ru: () => 'Значение соответствует not-схеме, что не разрешено',
  },
  {
    re: /^Matches multiple schemas when only one must validate\.?\s*$/i,
    ru: () => 'Значение соответствует нескольким oneOf-схемам',
  },
  {
    re: /^Matches (?:no|none of the) schemas.*$/i,
    ru: () => 'Значение не соответствует ни одной из схем',
  },
];

export function translateMonacoSchemaMessage(text) {
  const clean = asString(text).trim();
  if (!clean) return null;
  for (let i = 0; i < MONACO_MESSAGE_PATTERNS.length; i += 1) {
    const pattern = MONACO_MESSAGE_PATTERNS[i];
    const match = clean.match(pattern.re);
    if (match) {
      try { return pattern.ru(match); } catch (e) {}
    }
  }
  return null;
}

const ENRICHED_MARKER = '(строка ';

export function isEnrichedMessage(text) {
  return asString(text).includes(ENRICHED_MARKER);
}

export function formatEnrichedMessage(baseMessage, context) {
  const base = asString(baseMessage);
  const parts = [];
  const line = Number(context && context.line);
  const column = Number(context && context.column);
  if (Number.isFinite(line) && Number.isFinite(column) && line > 0 && column > 0) {
    parts.push(`строка ${line}, столбец ${column}`);
  }
  const label = asString(context && context.pathLabel);
  if (label && label !== 'root') parts.push(`путь ${label}`);
  if (!parts.length) return base;
  return `${base} (${parts.join('; ')})`;
}

export function enrichSchemaDiagnostic(context) {
  const rawMessage = asString(context && context.message);
  if (!rawMessage) return null;
  if (isEnrichedMessage(rawMessage)) return { message: rawMessage, source: asString(context && context.source) };

  const text = asString(context && context.text);
  const from = Number(context && context.from);
  const to = Number(context && context.to != null ? context.to : context.from);
  const line = Number(context && context.line);
  const column = Number(context && context.column);

  let pointer = asString(context && context.pointer);
  let pathLabel = '';
  if (!pointer && text) {
    try {
      const map = buildJsoncPointerMap(text);
      pointer = findPointerAtRange(map, from, to);
    } catch (e) {}
  }
  if (pointer) pathLabel = diagnosticPointerLabel(pointer);

  const translated = translateMonacoSchemaMessage(rawMessage);
  const baseMessage = translated != null ? translated : rawMessage;
  const enriched = formatEnrichedMessage(baseMessage, { line, column, pathLabel });

  const source = asString(context && context.source).trim();
  return { message: enriched, source: source || '' };
}

export const schemaDiagnosticFormatApi = Object.freeze({
  diagnosticPointerLabel,
  findPointerAtRange,
  translateMonacoSchemaMessage,
  formatEnrichedMessage,
  enrichSchemaDiagnostic,
  isEnrichedMessage,
});
