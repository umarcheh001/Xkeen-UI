import { EditorState, Compartment, EditorSelection, Prec, RangeSetBuilder } from '@codemirror/state';
import { EditorView, keymap, Decoration, ViewPlugin, MatchDecorator, hoverTooltip } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { json, jsonLanguage } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { syntaxHighlighting, HighlightStyle, LanguageSupport, ensureSyntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { lintGutter, linter, setDiagnostics as cmSetDiagnostics } from '@codemirror/lint';
import { search, openSearchPanel, closeSearchPanel, findNext, findPrevious, replaceNext, replaceAll as cmReplaceAll } from '@codemirror/search';
import { toggleComment, undo, redo } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import {
  jsonSchemaLinter, handleRefresh, jsonSchemaHover, jsonCompletion,
  stateExtensions as schemaStateExtensions, updateSchema as schemaUpdateSchema, getJSONSchema
} from 'codemirror-json-schema';
import { completeYamlTextFromSchema, hoverYamlTextFromSchema } from './yaml_schema.js';

const GLOBAL_KEY = '__XKEEN_CM6_RUNTIME__';
const BACKEND = 'cm6-local-offline';
const VERSION = '0.5.2-monaco-fine-tuned';
const LINK_TOOLTIP_TEXT = 'Перейти по ссылке (Ctrl + клик)';
const URL_FULL_RE = /(?:https?:\/\/|ftp:\/\/|file:\/\/|mailto:|magnet:)[^\s<>"'`\)\]\}]+/g;
let _schemaHoverSettingsPromise = null;
let _schemaHoverSettingsLoadFinished = false;

function getWindow() {
  if (typeof window !== 'undefined') return window;
  return null;
}

function ensureGlobalScope() {
  const win = getWindow();
  if (!win) return null;
  win.XKeen = win.XKeen || {};
  win.XKeen.ui = win.XKeen.ui || {};
  return win;
}

function readUiSettingsSnapshot() {
  const win = getWindow();
  try {
    const api = win && win.XKeen && win.XKeen.ui ? win.XKeen.ui.settings : null;
    if (api && typeof api.get === 'function') return api.get();
  } catch (e) {}
  return {};
}

function getUiSettingsApi() {
  const win = getWindow();
  try {
    return win && win.XKeen && win.XKeen.ui ? (win.XKeen.ui.settings || null) : null;
  } catch (e) {}
  return null;
}

function areUiSettingsLoadedFromServer() {
  try {
    const api = getUiSettingsApi();
    return !!(api && typeof api.isLoadedFromServer === 'function' && api.isLoadedFromServer());
  } catch (e) {}
  return false;
}

function shouldDeferSchemaHoverForSettings() {
  try {
    const api = getUiSettingsApi();
    return !!(api
      && typeof api.fetchOnce === 'function'
      && !areUiSettingsLoadedFromServer()
      && !_schemaHoverSettingsLoadFinished);
  } catch (e) {}
  return false;
}

function ensureSchemaHoverSettingsLoaded() {
  const api = getUiSettingsApi();
  if (!api || typeof api.fetchOnce !== 'function' || areUiSettingsLoadedFromServer()) {
    _schemaHoverSettingsLoadFinished = true;
    return Promise.resolve(readUiSettingsSnapshot());
  }
  if (_schemaHoverSettingsPromise) return _schemaHoverSettingsPromise;
  _schemaHoverSettingsPromise = Promise.resolve()
    .then(() => api.fetchOnce())
    .catch(() => null)
    .finally(() => {
      _schemaHoverSettingsLoadFinished = true;
      _schemaHoverSettingsPromise = null;
    });
  return _schemaHoverSettingsPromise;
}

function isSchemaHoverEnabled(opts) {
  if (opts && opts.schemaHover === false) return false;
  if (opts && opts.schemaHoverEnabled === false) return false;
  if (shouldDeferSchemaHoverForSettings()) return false;
  try {
    const settings = readUiSettingsSnapshot();
    const editor = settings && settings.editor && typeof settings.editor === 'object' ? settings.editor : {};
    return editor.schemaHoverEnabled !== false;
  } catch (e) {}
  return true;
}

function hideSchemaHoverTooltips() {
  try {
    const nodes = document.querySelectorAll('.cm-tooltip-hover, .cm6-json-schema-hover');
    nodes.forEach((node) => {
      try {
        const tip = node.closest && node.closest('.cm-tooltip') ? node.closest('.cm-tooltip') : node;
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
      } catch (e) {}
    });
  } catch (e) {}
}

function clampNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asString(value) {
  return value == null ? '' : String(value);
}

function normalizeMode(input) {
  const raw = asString(input || '').trim().toLowerCase();
  if (!raw) return 'text/plain';
  if (raw === 'jsonc' || raw === 'application/jsonc' || raw === 'text/jsonc') return 'application/jsonc';
  if (raw === 'application/json' || raw === 'text/json' || raw === 'json') return 'application/json';
  if (raw === 'application/yaml' || raw === 'text/yaml' || raw === 'yaml' || raw === 'yml') return 'text/yaml';
  if (raw === 'javascript' || raw === 'js' || raw === 'application/javascript') return 'application/javascript';
  if (raw === 'plaintext' || raw === 'plain' || raw === 'text') return 'text/plain';
  return raw;
}

function isJsonLikeMode(mode) {
  const next = normalizeMode(mode);
  return next === 'application/json' || next === 'application/jsonc' || next === 'application/javascript';
}

function isJsonEditorMode(mode) {
  const next = normalizeMode(mode);
  return next === 'application/json' || next === 'application/jsonc';
}

const jsoncLanguage = jsonLanguage.configure({ dialect: 'jsonc' });
const jsonCommentMark = Decoration.mark({ class: 'cm-json-comment' });
const jsonBracketMarks = [
  Decoration.mark({ class: 'cm-json-bracket-depth-0' }),
  Decoration.mark({ class: 'cm-json-bracket-depth-1' }),
  Decoration.mark({ class: 'cm-json-bracket-depth-2' }),
];
const jsonPunctuationCommaMark = Decoration.mark({ class: 'cm-json-punctuation-comma' });
const jsonPunctuationColonMark = Decoration.mark({ class: 'cm-json-punctuation-colon' });

function buildJsonDecorations(view, opts = {}) {
  const text = asString(view && view.state && view.state.doc ? view.state.doc.toString() : '');
  const allowComments = !!opts.allowComments;
  if (!text) return Decoration.none;
  const builder = new RangeSetBuilder();
  let inString = false;
  let escaped = false;
  const bracketStack = [];
  const addBracket = (from, to, depth) => {
    const safeDepth = Math.max(0, clampNumber(depth, 0));
    builder.add(from, to, jsonBracketMarks[safeDepth % jsonBracketMarks.length]);
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === 92) {
        escaped = true;
        continue;
      }
      if (ch === 34) inString = false;
      continue;
    }
    if (ch === 34) {
      inString = true;
      escaped = false;
      continue;
    }
    if (allowComments && ch === 47 && text.charCodeAt(i + 1) === 47) {
      const start = i;
      i += 2;
      while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i += 1;
      builder.add(start, i, jsonCommentMark);
      i -= 1;
      continue;
    }
    if (allowComments && ch === 47 && text.charCodeAt(i + 1) === 42) {
      const start = i;
      i += 2;
      while (i < text.length && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i += 1;
      const end = i < text.length ? i + 2 : text.length;
      builder.add(start, end, jsonCommentMark);
      i = Math.max(start, end - 1);
      continue;
    }
    if (ch === 123 || ch === 91) {
      const depth = bracketStack.length;
      addBracket(i, i + 1, depth);
      bracketStack.push(ch);
      continue;
    }
    if (ch === 125 || ch === 93) {
      const open = ch === 125 ? 123 : 91;
      let depth = Math.max(0, bracketStack.length - 1);
      if (bracketStack.length && bracketStack[bracketStack.length - 1] === open) {
        depth = bracketStack.length - 1;
        bracketStack.pop();
      } else if (bracketStack.length) {
        bracketStack.pop();
      }
      addBracket(i, i + 1, depth);
      continue;
    }
    if (ch === 44) {
      builder.add(i, i + 1, jsonPunctuationCommaMark);
      continue;
    }
    if (ch === 58) {
      builder.add(i, i + 1, jsonPunctuationColonMark);
      continue;
    }
  }
  return builder.finish();
}

function createJsonDecorationsExtension(getMode, opts = {}) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.mode = normalizeMode(typeof getMode === 'function' ? getMode() : '');
      this.allowComments = !!opts.allowComments;
      this.decorations = buildJsonDecorations(view, { allowComments: this.allowComments });
    }
    update(update) {
      const nextMode = normalizeMode(typeof getMode === 'function' ? getMode() : '');
      if (update.docChanged || update.viewportChanged || nextMode !== this.mode) {
        this.mode = nextMode;
        this.decorations = buildJsonDecorations(update.view, { allowComments: this.allowComments });
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations,
  });
}

const jsoncCommentDecorator = createJsonDecorationsExtension(() => 'application/jsonc', { allowComments: true });
const jsonStrictPunctuationDecorator = createJsonDecorationsExtension(() => 'application/json', { allowComments: false });
const jsoncEagerParser = ViewPlugin.fromClass(class {
  constructor(view) {
    try { ensureSyntaxTree(view.state, view.state.doc.length, 1000); } catch (e) {}
  }
  update(update) {
    if (update.docChanged) {
      try { ensureSyntaxTree(update.view.state, update.view.state.doc.length, 1000); } catch (e) {}
    }
  }
});

const jsoncExtension = new LanguageSupport(jsoncLanguage, [
  jsoncLanguage.data.of({ commentTokens: { line: '//' } }),
  jsoncEagerParser,
  Prec.highest(jsoncCommentDecorator),
]);

const jsonStrictExtension = [json(), jsoncEagerParser, Prec.highest(jsonStrictPunctuationDecorator)];

function jsonSchemaWithSyntaxLinter(opts) {
  const options = opts || {};
  const schemaLintSource = jsonSchemaLinter();
  return function jsonSchemaSyntaxAwareLintSource(view) {
    const source = view && view.state && view.state.doc ? view.state.doc.toString() : '';
    const syntax = makeJsonDiagnostics(source, {
      mode: options.mode,
      allowComments: options.allowComments,
    });
    if (syntax && syntax.ok === false) {
      return Array.isArray(syntax.diagnostics) ? syntax.diagnostics : [];
    }
    return schemaLintSource(view);
  };
}

function isSchemaHoverTarget(view, pos, side) {
  try {
    const doc = view && view.state && view.state.doc ? view.state.doc : null;
    if (!doc) return false;
    const length = doc.length;
    const safePos = Math.max(0, Math.min(length, clampNumber(pos, 0)));
    const text = doc.toString();
    const current = safePos < length ? text.charAt(safePos) : '';
    const previous = safePos > 0 ? text.charAt(safePos - 1) : '';
    const preferred = side < 0 ? previous || current : current || previous;
    const ch = preferred && !/\s/.test(preferred)
      ? preferred
      : (current && !/\s/.test(current) ? current : (previous && !/\s/.test(previous) ? previous : ''));
    if (!ch) return false;
    return !/[{}\[\]:,]/.test(ch);
  } catch (e) {}
  return true;
}

function jsonSchemaSyntaxAwareHover(opts) {
  const options = opts || {};
  const schemaHoverSource = jsonSchemaHover();
  return function jsonSchemaSyntaxAwareHoverSource(view, pos, side) {
    const source = view && view.state && view.state.doc ? view.state.doc.toString() : '';
    const syntax = makeJsonDiagnostics(source, {
      mode: options.mode,
      allowComments: options.allowComments,
    });
    if (syntax && syntax.ok === false) return null;
    if (!isSchemaHoverTarget(view, pos, side)) return null;
    return schemaHoverSource(view, pos, side);
  };
}

function schemaExtensionFor(schema, opts) {
  if (!schema) return [];
  const extensions = [
    linter(jsonSchemaWithSyntaxLinter(opts), { needsRefresh: handleRefresh }),
    jsonLanguage.data.of({ autocomplete: jsonCompletion() }),
    ...schemaStateExtensions(schema),
  ];
  if (isSchemaHoverEnabled(opts)) {
    extensions.splice(1, 0, hoverTooltip(jsonSchemaSyntaxAwareHover(opts)));
  }
  return extensions;
}

function yamlAssistResolver(opts) {
  const assist = opts && opts.yamlAssist ? opts.yamlAssist : null;
  if (!assist) return null;
  try {
    if (typeof assist.getSchema === 'function') return assist.getSchema;
  } catch (e) {}
  if (assist && typeof assist === 'object' && assist.schema) {
    return () => assist.schema;
  }
  return null;
}

function buildYamlAssistTooltipContent(text) {
  const root = document.createElement('div');
  root.className = 'cm6-json-schema-hover xk-yaml-schema-hover';
  const parts = asString(text).split(/\n{2,}/);
  parts.forEach((part) => {
    const block = document.createElement('div');
    block.textContent = part.replace(/\n/g, ' ');
    root.appendChild(block);
  });
  return root;
}

function yamlAssistExtensionFor(opts) {
  const mode = normalizeMode(opts && (opts.mode || opts.language || opts.mime));
  if (mode !== 'text/yaml') return [];
  const getSchema = yamlAssistResolver(opts);
  if (!getSchema) return [];

  const completionSource = async (context) => {
    let schema = null;
    try { schema = getSchema(); } catch (e) {}
    if (!schema) return null;
    const result = completeYamlTextFromSchema(context.state.doc.toString(), schema, { offset: context.pos });
    if (!result || !Array.isArray(result.options) || !result.options.length) return null;
    return {
      from: Math.max(0, Number(result.from || 0)),
      to: Math.max(0, Number(result.to || result.from || 0)),
      options: result.options.map((item) => ({
        label: item.label,
        type: item.type === 'property' ? 'property' : 'keyword',
        detail: item.detail || '',
        apply: item.insertText || item.label,
        info: item.documentation && item.documentation.plain ? item.documentation.plain : '',
      })),
    };
  };

  const hoverSource = (view, pos, side) => {
    let schema = null;
    try { schema = getSchema(); } catch (e) {}
    if (!schema) return null;
    const probe = Math.max(0, pos + (side < 0 ? -1 : 0));
    const result = hoverYamlTextFromSchema(view.state.doc.toString(), schema, { offset: probe });
    if (!result || !result.plain) return null;
    return {
      pos: Math.max(0, Number(result.from || 0)),
      end: Math.max(0, Number(result.to || result.from || 0)),
      create() {
        return { dom: buildYamlAssistTooltipContent(result.plain) };
      },
    };
  };

  return [
    autocompletion({ override: [completionSource] }),
    hoverTooltip(hoverSource),
  ];
}

function languageExtensionFor(mode) {
  const next = normalizeMode(mode);
  if (next === 'application/json') return jsonStrictExtension;
  if (next === 'application/jsonc' || next === 'application/javascript') return jsoncExtension;
  if (next === 'text/yaml') return yaml();
  return [];
}

function createEmitter() {
  const buckets = new Map();
  function on(name, handler) {
    if (typeof handler !== 'function') return () => {};
    const key = String(name || '');
    if (!buckets.has(key)) buckets.set(key, new Set());
    buckets.get(key).add(handler);
    return () => off(key, handler);
  }
  function off(name, handler) {
    const key = String(name || '');
    const set = buckets.get(key);
    if (!set) return;
    set.delete(handler);
    if (!set.size) buckets.delete(key);
  }
  function emit(name, payload) {
    const key = String(name || '');
    const set = buckets.get(key);
    if (!set || !set.size) return;
    Array.from(set).forEach((handler) => {
      try { handler(payload); } catch (e) {}
    });
  }
  return { on, off, emit };
}

function isTextarea(node) {
  try { return !!(node && node.tagName && String(node.tagName).toUpperCase() === 'TEXTAREA'); } catch (e) {}
  return false;
}

function applyHostClasses(host) {
  if (!host || !host.classList) return;
  try { host.classList.add('CodeMirror', 'xkeen-cm', 'xkeen-cm6-host'); } catch (e) {}
}

function createHost(target) {
  if (!target) return null;
  if (!isTextarea(target)) {
    applyHostClasses(target);
    return { host: target, textarea: null, restore: null };
  }
  const doc = target.ownerDocument || document;
  const host = doc.createElement('div');
  applyHostClasses(host);
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.minHeight = target.style && target.style.minHeight ? target.style.minHeight : '240px';
  const parent = target.parentNode;
  if (parent) {
    if (target.nextSibling) parent.insertBefore(host, target.nextSibling);
    else parent.appendChild(host);
  }
  const prevDisplay = target.style.display;
  target.style.display = 'none';
  return {
    host,
    textarea: target,
    restore: () => {
      try { target.style.display = prevDisplay || ''; } catch (e) {}
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (e) {}
    },
  };
}

function docLineFromPos(doc, pos) {
  try {
    const safePos = Math.max(0, Math.min(doc.length, clampNumber(pos, 0)));
    const line = doc.lineAt(safePos);
    return { line: Math.max(0, line.number - 1), ch: Math.max(0, safePos - line.from) };
  } catch (e) {}
  return { line: 0, ch: 0 };
}

function posFromLineCh(doc, line, ch) {
  try {
    const total = Math.max(1, doc.lines || 1);
    const safeLine = Math.min(total, Math.max(1, clampNumber(line, 0) + 1));
    const lineInfo = doc.line(safeLine);
    const safeCh = Math.min(lineInfo.length, Math.max(0, clampNumber(ch, 0)));
    return lineInfo.from + safeCh;
  } catch (e) {}
  return 0;
}

function normalizeSelections(view, list) {
  const source = Array.isArray(list) ? list : [];
  const ranges = source.map((item) => {
    const anchor = item && item.anchor ? item.anchor : item;
    const head = item && item.head ? item.head : anchor;
    return EditorSelection.range(
      posFromLineCh(view.state.doc, anchor && anchor.line, anchor && anchor.ch),
      posFromLineCh(view.state.doc, head && head.line, head && head.ch)
    );
  }).filter(Boolean);
  return ranges.length ? ranges : null;
}

function normalizeDiagnostics(view, list) {
  const source = Array.isArray(list) ? list : [];
  return source.map((item) => {
    const raw = item || {};
    let from = clampNumber(raw.from, NaN);
    let to = clampNumber(raw.to, NaN);
    if (!Number.isFinite(from) && Number.isFinite(raw.line)) {
      from = posFromLineCh(view.state.doc, Math.max(0, Number(raw.line) - 1), Math.max(0, Number(raw.column || 1) - 1));
    }
    if (!Number.isFinite(to)) {
      if (Number.isFinite(raw.endLine)) {
        to = posFromLineCh(view.state.doc, Math.max(0, Number(raw.endLine) - 1), Math.max(0, Number(raw.endColumn || 1) - 1));
      } else {
        to = Number.isFinite(from) ? Math.min(view.state.doc.length, from + Math.max(1, clampNumber(raw.length, 1))) : 0;
      }
    }
    if (!Number.isFinite(from)) from = 0;
    if (!Number.isFinite(to)) to = from;
    if (to < from) to = from;
    return {
      from,
      to,
      severity: raw.severity || 'error',
      message: asString(raw.message || raw.text || raw.reason || 'Issue detected'),
      source: raw.source ? asString(raw.source) : 'xkeen-cm6',
    };
  });
}

function offsetToLineColumn(text, offset) {
  const source = asString(text || '');
  const safe = Math.max(0, Math.min(source.length, clampNumber(offset, 0)));
  let line = 1;
  let column = 1;
  for (let i = 0; i < safe; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function hasJsonComments(text) {
  const source = asString(text || '');
  return /(^|[^:])\/\/|\n\s*#|\/\*/.test(source);
}

function makeJsonDiagnostics(text, opts = {}) {
  const source = asString(text || '');
  const mode = (() => {
    const normalized = normalizeMode(opts.mode || opts.language || opts.mime);
    if (normalized === 'application/jsonc') return normalized;
    if (opts.allowComments || hasJsonComments(source)) return 'application/jsonc';
    if (isJsonLikeMode(normalized)) return normalized;
    return '';
  })();
  if (!mode || !source.trim()) return { ok: true, diagnostics: [], summary: '', mode };
  const errors = [];
  try {
    parseJsonc(source, errors, { allowTrailingComma: mode === 'application/jsonc', disallowComments: mode !== 'application/jsonc' });
  } catch (e) {
    errors.push({ error: 4, offset: 0, length: Math.max(1, source.length) });
  }
  const diagnostics = errors.map((item) => {
    const offset = clampNumber(item && item.offset, 0);
    const length = Math.max(1, clampNumber(item && item.length, 1));
    const point = offsetToLineColumn(source, offset);
    const reason = typeof printParseErrorCode === 'function' ? printParseErrorCode(item && item.error) : 'ParseError';
    let message = 'JSON содержит ошибку';
    if (reason === 'InvalidSymbol') message = 'Недопустимый символ';
    else if (reason === 'InvalidNumberFormat') message = 'Некорректный формат числа';
    else if (reason === 'PropertyNameExpected') message = 'Ожидается имя свойства';
    else if (reason === 'ValueExpected') message = 'Ожидается значение';
    else if (reason === 'ColonExpected') message = 'Ожидается двоеточие';
    else if (reason === 'CommaExpected') message = 'Ожидается запятая';
    else if (reason === 'CloseBraceExpected') message = 'Ожидается закрывающая фигурная скобка';
    else if (reason === 'CloseBracketExpected') message = 'Ожидается закрывающая квадратная скобка';
    else if (reason === 'EndOfFileExpected') message = 'После завершения JSON обнаружен лишний текст';
    else if (reason === 'InvalidCommentToken') message = 'Комментарии допустимы только в JSONC';
    else if (reason === 'UnexpectedEndOfComment') message = 'Комментарий не закрыт';
    else if (reason === 'UnexpectedEndOfString') message = 'Строка не закрыта';
    else if (reason === 'UnexpectedEndOfNumber') message = 'Число обрывается раньше времени';
    else if (reason === 'InvalidUnicode') message = 'Некорректная Unicode-последовательность';
    else if (reason === 'InvalidEscapeCharacter') message = 'Некорректная escape-последовательность';
    else if (reason === 'InvalidCharacter') message = 'Некорректный символ';
    return {
      from: offset,
      to: Math.min(source.length, offset + length),
      severity: 'error',
      message: `${message} (строка ${point.line}, столбец ${point.column})`,
      line: point.line,
      column: point.column,
      length,
      reason,
      source: 'jsonc-parser',
    };
  });
  return { ok: diagnostics.length === 0, diagnostics, summary: diagnostics[0] ? diagnostics[0].message : '', mode };
}

function resolveThemeMode(theme) {
  const next = String(theme || '').trim().toLowerCase();
  if (next === 'default' || next === 'light' || next === 'xkeen-light') return 'light';
  if (next === 'material-darker' || next === 'dark' || next === 'xkeen-dark') return 'dark';
  try {
    return document && document.documentElement && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  } catch (e) {}
  return 'dark';
}

function createThemeExtension(theme) {
  const mode = resolveThemeMode(theme);
  const dark = mode !== 'light';
  return [
    EditorView.theme({
      '&': {
        height: '100%',
        color: 'var(--xk-cm-fg)',
        backgroundColor: 'var(--xk-cm-bg)',
        fontFamily: 'var(--editor-font-stack, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace)',
        fontSize: 'var(--xk-cm-editor-font-size, var(--xk-editor-font-size, 15px))',
        lineHeight: 'var(--xk-cm-editor-line-height, var(--xk-editor-line-height, 1.68))',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto', color: 'inherit', fontFamily: 'inherit', lineHeight: 'inherit' },
      '.cm-content': { caretColor: 'var(--xk-cm-caret)', padding: '8px 0 16px', minHeight: '100%' },
      '.cm-line': { padding: '0 12px 0 6px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--xk-cm-caret)', borderLeftWidth: '2px' },
      '.cm-selectionBackground': { backgroundColor: 'var(--xk-cm-selection) !important' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--xk-cm-selection) !important' },
      '.cm-activeLine': { backgroundColor: 'var(--xk-cm-active-line)' },
      '.cm-gutters': {
        backgroundColor: 'var(--xk-cm-gutter-bg)',
        color: 'var(--xk-cm-gutter-fg)',
        borderRight: '1px solid var(--xk-cm-gutter-border)',
        minWidth: '58px',
      },
      '.cm-gutterElement': { padding: '0 10px 0 14px' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--xk-cm-active-line-gutter)', color: 'var(--xk-cm-active-line-fg)' },
      '.cm-foldGutter': { color: 'var(--xk-cm-fold-fg)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--xk-cm-selection-match)' },
      '.cm-searchMatch': {
        backgroundColor: 'var(--xk-cm-search-bg)',
        outline: '1px solid var(--xk-cm-search-border)',
        borderRadius: '5px',
      },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--xk-cm-search-active-bg)' },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--xk-cm-bracket-bg)',
        outline: '1px solid var(--xk-cm-bracket-border)',
        borderRadius: '4px',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--xk-cm-fold-bg)',
        border: '1px solid var(--xk-cm-fold-border)',
        color: 'var(--xk-cm-fold-fg)',
        borderRadius: '999px',
        padding: '0 8px',
      },
      '.cm-panels': { backgroundColor: 'var(--xk-cm-popup-bg)', color: 'var(--xk-cm-popup-fg)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--xk-cm-popup-border)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--xk-cm-popup-border)' },
      '.cm-tooltip': {
        border: '1px solid var(--xk-cm-popup-border)',
        backgroundColor: 'var(--xk-cm-popup-bg)',
        color: 'var(--xk-cm-popup-fg)',
        boxShadow: '0 18px 36px var(--xk-cm-popup-shadow)',
        borderRadius: '14px',
        overflow: 'hidden',
        backdropFilter: 'blur(16px) saturate(135%)',
      },
      '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--xk-cm-popup-border)', borderBottomColor: 'var(--xk-cm-popup-border)' },
      '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--xk-cm-popup-bg)', borderBottomColor: 'var(--xk-cm-popup-bg)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--xk-cm-selection-match)', color: 'var(--xk-cm-popup-fg)' },
      '.cm-diagnostic': { padding: '10px 12px 10px 14px', fontSize: '12px' },
      '.cm-diagnostic-error': { borderLeft: '3px solid var(--xk-cm-error)' },
      '.cm-diagnostic-warning': { borderLeft: '3px solid var(--xk-cm-warning)' },
      '.cm-diagnostic-info': { borderLeft: '3px solid var(--xk-cm-info)' },
      '.cm-lintRange-error': { backgroundColor: 'transparent', borderBottom: '2px wavy var(--xk-cm-error)' },
      '.cm-lintRange-warning': { backgroundColor: 'transparent', borderBottom: '2px wavy var(--xk-cm-warning)' },
      '.cm-lintRange-info': { backgroundColor: 'transparent', borderBottom: '2px wavy var(--xk-cm-info)' },
      '.cm-lintPoint-error': { color: 'var(--xk-cm-error)' },
      '.cm-lintPoint-warning': { color: 'var(--xk-cm-warning)' },
      '.cm-lintPoint-info': { color: 'var(--xk-cm-info)' },
      '.cm-link.cm-xk-url': { color: 'var(--xk-cm-link, #7ab8ff)', textDecoration: 'underline', cursor: 'pointer' },
      '.cm-json-comment': { color: 'var(--xk-cm-comment)' },
      '.cm-json-bracket-depth-0': { color: 'var(--xk-cm-bracket-depth-0)' },
      '.cm-json-bracket-depth-1': { color: 'var(--xk-cm-bracket-depth-1)' },
      '.cm-json-bracket-depth-2': { color: 'var(--xk-cm-bracket-depth-2)' },
      '.cm-json-punctuation-comma': { color: 'var(--xk-cm-comma)' },
      '.cm-json-punctuation-colon': { color: 'var(--xk-cm-colon)' },
    }, { dark }),
    Prec.highest(EditorView.theme({
      '.cm-selectionLayer': { display: 'none' },
      '.cm-line': {
        '&::selection, & ::selection': {
          backgroundColor: 'var(--xk-cm-selection-native) !important',
          color: 'inherit !important',
        },
      },
      '.cm-content': {
        '&::selection, & ::selection': {
          backgroundColor: 'var(--xk-cm-selection-native) !important',
          color: 'inherit !important',
        },
      },
    }, { dark })),
    Prec.highest(syntaxHighlighting(HighlightStyle.define([
      { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--xk-cm-comment)' },
      { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--xk-cm-keyword)', fontWeight: '600' },
      { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--xk-cm-string)' },
      { tag: [t.number, t.integer, t.float], color: 'var(--xk-cm-number)' },
      { tag: [t.bool, t.null, t.atom], color: 'var(--xk-cm-atom)', fontWeight: '600' },
      { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--xk-cm-property)' },
      { tag: [t.variableName, t.name], color: 'var(--xk-cm-variable)' },
      { tag: [t.definition(t.variableName), t.definition(t.propertyName), t.definition(t.name)], color: 'var(--xk-cm-definition)', fontWeight: '600' },
      { tag: [t.typeName, t.className, t.namespace], color: 'var(--xk-cm-type)' },
      { tag: [t.operator], color: 'var(--xk-cm-operator, var(--xk-cm-colon, var(--xk-cm-punctuation)))' },
      { tag: [t.punctuation, t.separator], color: 'var(--xk-cm-delimiter, var(--xk-cm-comma, var(--xk-cm-punctuation)))' },
      { tag: [t.brace, t.squareBracket, t.paren], color: 'var(--xk-cm-bracket-depth-0, var(--xk-cm-punctuation))' },
      { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--xk-cm-meta)' },
      { tag: [t.invalid], color: 'var(--xk-cm-invalid)', textDecoration: 'underline wavy var(--xk-cm-error)' },
    ]))),
  ];
}

function applyThemeClasses(host, theme) {
  if (!host || !host.classList) return;
  const mode = resolveThemeMode(theme);
  try {
    host.classList.remove('cm-s-default', 'cm-s-material-darker', 'xkeen-cm6-light', 'xkeen-cm6-dark');
    host.classList.add(mode === 'light' ? 'cm-s-default' : 'cm-s-material-darker');
    host.classList.add(mode === 'light' ? 'xkeen-cm6-light' : 'xkeen-cm6-dark');
    host.setAttribute('data-xkeen-cm6-theme', mode);
  } catch (e) {}
}

function normalizeLegacyKey(key) {
  const parts = String(key || '').split('-').filter(Boolean);
  if (!parts.length) return '';
  const last = parts.pop();
  const mapped = parts.map((part) => {
    if (part === 'Cmd' || part === 'Command') return 'Cmd';
    if (part === 'Ctrl' || part === 'Control') return 'Ctrl';
    if (part === 'Shift') return 'Shift';
    if (part === 'Alt' || part === 'Option') return 'Alt';
    if (part === 'Mod') return 'Mod';
    return part;
  });
  let keyName = String(last || '');
  if (keyName.length === 1) keyName = keyName.toLowerCase();
  else if (/^Arrow/i.test(keyName)) keyName = keyName;
  return mapped.concat(keyName).join('-');
}

function normalizeCommandName(name) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase();
  const aliases = {
    find: 'findPersistent',
    findpersistent: 'findPersistent',
    findnext: 'findNext',
    next: 'findNext',
    findprev: 'findPrev',
    findprevious: 'findPrev',
    prev: 'findPrev',
    previous: 'findPrev',
    replace: 'replace',
    replaceall: 'replaceAll',
    togglecomment: 'toggleComment',
    comment: 'toggleComment',
    fullscreen: 'fullscreen',
    fs: 'fullscreen',
    save: 'save',
    undo: 'undo',
    redo: 'redo',
    links: 'links',
  };
  return aliases[key] || raw;
}

function ensureLinkTooltipEl() {
  let el = document.getElementById('xkeen-cm6-linktip');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'xkeen-cm6-linktip';
  el.className = 'xkeen-cm-linktip';
  el.style.display = 'none';
  el.textContent = LINK_TOOLTIP_TEXT;
  document.body.appendChild(el);
  return el;
}

function hideLinkTooltip() {
  try {
    const el = document.getElementById('xkeen-cm6-linktip');
    if (el) el.style.display = 'none';
  } catch (e) {}
}

function isCtrlLike(event) {
  return !!(event && (event.ctrlKey || event.metaKey));
}

function findUrlAtPos(view, pos) {
  try {
    const offset = Math.max(0, Math.min(view.state.doc.length, clampNumber(pos, 0)));
    const line = view.state.doc.lineAt(offset);
    const text = line.text || '';
    URL_FULL_RE.lastIndex = 0;
    let match;
    const localPos = offset - line.from;
    while ((match = URL_FULL_RE.exec(text))) {
      let url = match[0];
      let start = match.index;
      let end = start + url.length;
      const trimmed = url.replace(/[\.,;:]+$/, '');
      if (trimmed !== url) {
        url = trimmed;
        end = start + url.length;
      }
      if (localPos >= start && localPos < end) return { url, from: line.from + start, to: line.from + end };
    }
  } catch (e) {}
  return null;
}

function placeLinkTooltip(view, token) {
  const tip = ensureLinkTooltipEl();
  if (!tip || !token) return;
  try {
    tip.textContent = LINK_TOOLTIP_TEXT;
    tip.style.display = 'block';
    const coords = view.coordsAtPos(token.from);
    if (!coords) return;
    const w = tip.offsetWidth || 160;
    const h = tip.offsetHeight || 24;
    const pageX = window.pageXOffset || document.documentElement.scrollLeft || 0;
    const pageY = window.pageYOffset || document.documentElement.scrollTop || 0;
    const vw = document.documentElement.clientWidth || window.innerWidth || 1024;
    let left = coords.left + pageX;
    let top = coords.top + pageY - h - 6;
    const maxLeft = pageX + vw - w - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < pageX + 8) left = pageX + 8;
    if (top < pageY + 8) top = coords.bottom + pageY + 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  } catch (e) {
    hideLinkTooltip();
  }
}

const linkMarker = Decoration.mark({ class: 'cm-link cm-xk-url' });
const linkMatcher = new MatchDecorator({ regexp: URL_FULL_RE, decoration: linkMarker });

function createLinksExtension() {
  const decorations = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = linkMatcher.createDeco(view);
    }
    update(update) {
      this.decorations = linkMatcher.updateDeco(update, this.decorations);
      if (update.docChanged || update.viewportChanged) hideLinkTooltip();
    }
  }, {
    decorations: (plugin) => plugin.decorations,
  });

  const handlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const token = pos == null ? null : findUrlAtPos(view, pos);
      try {
        view.dom.classList.toggle('xkeen-cm-link-hover', !!token);
        view.dom.classList.toggle('xkeen-cm-link-armed', !!token && isCtrlLike(event));
      } catch (e) {}
      if (!token) {
        hideLinkTooltip();
        return false;
      }
      placeLinkTooltip(view, token);
      return false;
    },
    mouseleave(_event, view) {
      try { view.dom.classList.remove('xkeen-cm-link-hover', 'xkeen-cm-link-armed'); } catch (e) {}
      hideLinkTooltip();
      return false;
    },
    mousedown(event, view) {
      if (!isCtrlLike(event)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const token = pos == null ? null : findUrlAtPos(view, pos);
      if (!token || !token.url) return false;
      try { event.preventDefault(); } catch (e) {}
      try { event.stopPropagation(); } catch (e) {}
      try { window.open(token.url, '_blank', 'noopener'); } catch (e) { try { window.location.href = token.url; } catch (e2) {} }
      return true;
    },
  });

  return [decorations, handlers];
}

function createExtraKeymap(extraKeys, getBridge) {
  const source = (extraKeys && typeof extraKeys === 'object') ? extraKeys : {};
  const bindings = [];
  Object.keys(source).forEach((rawKey) => {
    const spec = source[rawKey];
    const key = normalizeLegacyKey(rawKey);
    if (!key) return;
    if (typeof spec === 'function') {
      bindings.push({
        key,
        preventDefault: true,
        run: () => {
          const bridge = typeof getBridge === 'function' ? getBridge() : null;
          try { return spec(bridge) !== false; } catch (e) {}
          return true;
        },
      });
      return;
    }
    const command = normalizeCommandName(spec);
    bindings.push({
      key,
      preventDefault: true,
      run: () => {
        const bridge = typeof getBridge === 'function' ? getBridge() : null;
        try { return !!(bridge && typeof bridge.runCommand === 'function' && bridge.runCommand(command)); } catch (e) {}
        return false;
      },
    });
  });
  return bindings.length ? keymap.of(bindings) : [];
}

function buildState(ctx, options, value, selection) {
  const saveKeymap = keymap.of([{ key: 'Mod-s', run() { ctx.emitter.emit('save', null); return true; }, preventDefault: true }]);
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) ctx.emitter.emit('change', update);
    if (update.selectionSet) ctx.emitter.emit('cursorActivity', update);
  });
  return EditorState.create({
    doc: value,
    selection,
    extensions: [
      basicSetup,
      indentationMarkers(),
      saveKeymap,
      updateListener,
      ctx.languageCompartment.of(languageExtensionFor(options.mode)),
      ctx.readOnlyCompartment.of(EditorState.readOnly.of(!!options.readOnly)),
      ctx.lineWrappingCompartment.of(options.lineWrapping ? EditorView.lineWrapping : []),
      ctx.diagnosticsCompartment.of([lintGutter()]),
      ctx.themeCompartment.of(createThemeExtension(options.theme)),
      ctx.searchCompartment.of(search({ top: true })),
      ctx.linksCompartment.of(options.links !== false ? createLinksExtension() : []),
      ctx.extraKeysCompartment.of([]),
      ctx.schemaCompartment.of(schemaExtensionFor(ctx.schema, options)),
      ctx.yamlAssistCompartment.of(yamlAssistExtensionFor(options)),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
    ],
  });
}

function createFullscreenState() {
  return { active: false, placeholder: null, parent: null, prevBodyOverflow: '', prevStyle: null, onKeyDown: null };
}

function applyFullscreenStyles(host, active, prevStyle) {
  if (!host || !host.style) return;
  if (active) {
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2140';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.maxWidth = '100vw';
    host.style.maxHeight = '100vh';
    host.style.margin = '0';
    host.style.borderRadius = '0';
    host.style.background = 'var(--card, var(--bg-elevated, #111))';
  } else {
    Object.keys(prevStyle || {}).forEach((key) => {
      try { host.style[key] = prevStyle[key] || ''; } catch (e) {}
    });
  }
}

function setBridgeFullscreen(bridge, enabled) {
  const ctx = bridge.__ctx;
  const host = bridge.getWrapperElement();
  if (!ctx || !host) return false;
  const st = ctx.fullscreenState || (ctx.fullscreenState = createFullscreenState());
  const next = !!enabled;
  if (!!st.active === next) return true;

  if (next) {
    const parent = host.parentNode;
    if (!parent) return false;
    const placeholder = document.createElement('div');
    placeholder.className = 'xkeen-editor-fs-placeholder';
    placeholder.style.display = 'none';
    parent.insertBefore(placeholder, host);
    st.placeholder = placeholder;
    st.parent = parent;
    st.prevBodyOverflow = document.body.style.overflow || '';
    st.prevStyle = {
      position: host.style.position || '',
      inset: host.style.inset || '',
      zIndex: host.style.zIndex || '',
      width: host.style.width || '',
      height: host.style.height || '',
      maxWidth: host.style.maxWidth || '',
      maxHeight: host.style.maxHeight || '',
      margin: host.style.margin || '',
      borderRadius: host.style.borderRadius || '',
      background: host.style.background || '',
    };
    document.body.appendChild(host);
    try { host.classList.add('is-fullscreen', 'CodeMirror-fullscreen'); } catch (e) {}
    applyFullscreenStyles(host, true, st.prevStyle);
    try { document.body.style.overflow = 'hidden'; } catch (e) {}
    st.onKeyDown = (event) => {
      try {
        if (event && event.key === 'Escape' && bridge.getOption('fullScreen')) {
          event.preventDefault();
          bridge.setOption('fullScreen', false);
        }
      } catch (e) {}
    };
    try { document.addEventListener('keydown', st.onKeyDown, { capture: true }); } catch (e) {}
    st.active = true;
  } else {
    try { if (st.onKeyDown) document.removeEventListener('keydown', st.onKeyDown, { capture: true }); } catch (e) {}
    st.onKeyDown = null;
    try { host.classList.remove('is-fullscreen', 'CodeMirror-fullscreen'); } catch (e) {}
    applyFullscreenStyles(host, false, st.prevStyle || {});
    try {
      if (st.parent && st.placeholder && st.placeholder.parentNode === st.parent) {
        st.parent.insertBefore(host, st.placeholder);
        st.placeholder.remove();
      }
    } catch (e) {}
    try { document.body.style.overflow = st.prevBodyOverflow || ''; } catch (e) {}
    st.active = false;
    st.placeholder = null;
    st.parent = null;
    st.prevStyle = null;
  }

  ctx.options.fullScreen = next;
  ctx.emitter.emit('fullscreen', { active: next });
  try { if (bridge._xkeenToolbarEl) bridge._xkeenToolbarEl.classList.toggle('is-fullscreen', next); } catch (e) {}
  try { bridge.layout(); } catch (e) {}
  return true;
}

function buildBridge(view, ctx) {
  const emitter = ctx.emitter;
  const textarea = ctx.textarea || null;
  const host = ctx.host || view.dom;
  const options = ctx.options || {};
  let lastDiagnostics = Array.isArray(ctx.diagnostics) ? ctx.diagnostics.slice() : [];
  let schemaInstalled = !!ctx.schema;
  let disposed = false;
  let bridge = null;

  function syncTextarea() {
    if (!textarea) return;
    try { textarea.value = view.state.doc.toString(); } catch (e) {}
  }

  function dispatch(spec) {
    if (disposed) return false;
    try { view.dispatch(spec); syncTextarea(); return true; } catch (e) {}
    return false;
  }

  function cmPosToOffset(pos) {
    const next = pos || {};
    return posFromLineCh(view.state.doc, next.line, next.ch);
  }

  function selectionToCm(range) {
    return {
      anchor: docLineFromPos(view.state.doc, range.anchor),
      head: docLineFromPos(view.state.doc, range.head),
    };
  }

  function setDiagnosticsList(list) {
    lastDiagnostics = normalizeDiagnostics(view, list);
    try { view.dispatch(cmSetDiagnostics(view.state, lastDiagnostics)); return true; } catch (e) {}
    return false;
  }

  function getModeForCompat() {
    const next = normalizeMode(options.mode);
    if (next === 'application/json') return { name: 'javascript', json: true };
    if (next === 'application/jsonc') return { name: 'jsonc', jsonc: true, json: true };
    if (next === 'application/javascript') return 'javascript';
    if (next === 'text/yaml') return 'yaml';
    return 'text/plain';
  }

  function resetStatePreservingDoc() {
    try {
      const text = view.state.doc.toString();
      const nextState = buildState(ctx, options, text, view.state.selection);
      view.setState(nextState);
      syncTextarea();
      return true;
    } catch (e) {}
    return false;
  }

  function refreshSchemaExtensions() {
    if (!schemaInstalled || !ctx.schema) {
      if (!isSchemaHoverEnabled(options)) hideSchemaHoverTooltips();
      return false;
    }
    const ok = dispatch({ effects: ctx.schemaCompartment.reconfigure(schemaExtensionFor(ctx.schema, options)) });
    if (!isSchemaHoverEnabled(options)) hideSchemaHoverTooltips();
    return ok;
  }

  function commandRunner(name) {
    const command = normalizeCommandName(name);
    if (!command) return false;
    if (command === 'findPersistent' || command === 'find') return openSearchPanel(view);
    if (command === 'findNext') return findNext(view) || openSearchPanel(view);
    if (command === 'findPrev') return findPrevious(view) || openSearchPanel(view);
    if (command === 'replace') return openSearchPanel(view);
    if (command === 'replaceAll') return cmReplaceAll(view) || openSearchPanel(view);
    if (command === 'toggleComment') return toggleComment(view);
    if (command === 'undo') return undo(view);
    if (command === 'redo') return redo(view);
    if (command === 'save') { emitter.emit('save', null); return true; }
    if (command === 'fullscreen') return setBridgeFullscreen(bridge, !bridge.getOption('fullScreen'));
    if (command === 'links') return bridge.setLinksEnabled(!bridge.getLinksEnabled());
    if (command === 'closeSearch') return closeSearchPanel(view);
    return false;
  }

  bridge = {
    __xkeenCm6Bridge: true,
    __xkeen_cm6_bridge: true,
    engine: 'codemirror',
    backend: BACKEND,
    version: VERSION,
    view,
    host,
    textarea,
    options,
    __ctx: ctx,
    refresh() { try { view.requestMeasure(); } catch (e) {} return true; },
    layout() { return bridge.refresh(); },
    focus() { try { view.focus(); } catch (e) {} return true; },
    getValue() { return view.state.doc.toString(); },
    setValue(value) { const next = asString(value); dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } }); return next; },
    getWrapperElement() { return host; },
    getTextArea() { return textarea; },
    getCursor() { return docLineFromPos(view.state.doc, view.state.selection.main.head); },
    setCursor(pos) { const offset = cmPosToOffset(pos); return dispatch({ selection: { anchor: offset, head: offset }, scrollIntoView: true }); },
    listSelections() { return view.state.selection.ranges.map(selectionToCm); },
    setSelections(selections) { const ranges = normalizeSelections(view, selections); if (!ranges) return false; return dispatch({ selection: { ranges, mainIndex: 0 }, scrollIntoView: true }); },
    scrollTo(x, y) { try { if (typeof x === 'number') view.scrollDOM.scrollLeft = Math.max(0, x); if (typeof y === 'number') view.scrollDOM.scrollTop = Math.max(0, y); emitter.emit('scroll', { left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop }); hideLinkTooltip(); return true; } catch (e) {} return false; },
    getScrollInfo() { const el = view.scrollDOM; return { left: clampNumber(el && el.scrollLeft, 0), top: clampNumber(el && el.scrollTop, 0), clientWidth: clampNumber(el && el.clientWidth, 0), clientHeight: clampNumber(el && el.clientHeight, 0) }; },
    lineCount() { return view.state.doc.lines; },
    getLine(index) { try { return view.state.doc.line(Math.max(1, Number(index || 0) + 1)).text; } catch (e) {} return ''; },
    replaceRange(text, from, to) { const insert = asString(text); return dispatch({ changes: { from: cmPosToOffset(from || { line: 0, ch: 0 }), to: cmPosToOffset(to || from || { line: 0, ch: 0 }), insert } }); },
    replaceAll(text) { return bridge.setValue(text); },
    setLanguage(mode) {
      options.mode = normalizeMode(mode);
      return dispatch({
        effects: [
          ctx.languageCompartment.reconfigure(languageExtensionFor(options.mode)),
          ctx.yamlAssistCompartment.reconfigure(yamlAssistExtensionFor(options)),
        ],
      });
    },
    setReadOnly(flag) { options.readOnly = !!flag; return dispatch({ effects: ctx.readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!options.readOnly)) }); },
    setDiagnostics(list) { return setDiagnosticsList(list); },
    clearDiagnostics() { lastDiagnostics = []; try { view.dispatch(cmSetDiagnostics(view.state, [])); return true; } catch (e) {} return false; },
    getDiagnostics() { return lastDiagnostics.slice(); },
    refreshSchemaExtensions,
    setLinksEnabled(flag) {
      options.links = flag !== false;
      hideLinkTooltip();
      return dispatch({ effects: ctx.linksCompartment.reconfigure(options.links ? createLinksExtension() : []) });
    },
    getLinksEnabled() { return options.links !== false; },
    setSchema(schema) {
      ctx.schema = schema || null;
      if (!schema) {
        schemaInstalled = false;
        hideSchemaHoverTooltips();
        return dispatch({ effects: ctx.schemaCompartment.reconfigure([]) });
      }
      if (schemaInstalled) {
        try {
          schemaUpdateSchema(view, schema);
          refreshSchemaExtensions();
          return true;
        } catch (e) {}
      }
      const ok = dispatch({ effects: ctx.schemaCompartment.reconfigure(schemaExtensionFor(schema, options)) });
      schemaInstalled = !!ok;
      if (!isSchemaHoverEnabled(options)) hideSchemaHoverTooltips();
      return ok;
    },
    getSchema() {
      try { return getJSONSchema(view.state); } catch (e) {}
      return undefined;
    },
    saveViewState() {
      const scroll = bridge.getScrollInfo();
      return {
        kind: 'codemirror',
        backend: BACKEND,
        cursor: bridge.getCursor(),
        selections: bridge.listSelections(),
        scrollTop: scroll.top,
        scrollLeft: scroll.left,
        fullScreen: !!bridge.getOption('fullScreen'),
      };
    },
    restoreViewState(state) {
      const viewState = state || {};
      let ok = false;
      if (Array.isArray(viewState.selections) && viewState.selections.length) ok = bridge.setSelections(viewState.selections) || ok;
      else if (viewState.cursor) ok = bridge.setCursor(viewState.cursor) || ok;
      if (typeof viewState.scrollLeft === 'number' || typeof viewState.scrollTop === 'number') ok = bridge.scrollTo(viewState.scrollLeft, viewState.scrollTop) || ok;
      if (typeof viewState.fullScreen === 'boolean') ok = bridge.setOption('fullScreen', !!viewState.fullScreen) || ok;
      return ok;
    },
    revealLine(line) {
      const offset = posFromLineCh(view.state.doc, Math.max(0, Number(line || 1) - 1), 0);
      try {
        view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'center' }) });
        return true;
      } catch (e) {}
      try {
        const block = view.lineBlockAt(offset);
        const viewport = view.scrollDOM;
        const clientHeight = clampNumber(viewport && viewport.clientHeight, 0);
        const targetTop = Math.max(0, clampNumber(block && block.top, 0) - Math.max(0, Math.floor((clientHeight - clampNumber(block && block.height, 0)) / 2)));
        return bridge.scrollTo(null, targetTop);
      } catch (e) {}
      return false;
    },
    getOption(name) {
      const key = asString(name || '');
      if (key === 'mode') return getModeForCompat();
      if (key === 'readOnly') return options.readOnly ? 'nocursor' : false;
      if (key === 'fullScreen') return !!options.fullScreen;
      if (key === 'links' || key === 'linksEnabled') return options.links !== false;
      if (key === 'extraKeys') return options.extraKeys || {};
      return options[key];
    },
    setOption(name, value) {
      const key = asString(name || '');
      options[key] = value;
      if (key === 'mode') return bridge.setLanguage(value);
      if (key === 'theme') {
        applyThemeClasses(host, value);
        return dispatch({ effects: ctx.themeCompartment.reconfigure(createThemeExtension(value)) });
      }
      if (key === 'readOnly') return bridge.setReadOnly(value === 'nocursor' || !!value);
      if (key === 'lineWrapping') return dispatch({ effects: ctx.lineWrappingCompartment.reconfigure(value ? EditorView.lineWrapping : []) });
      if (key === 'fullScreen') return setBridgeFullscreen(bridge, !!value);
      if (key === 'links' || key === 'linksEnabled') return bridge.setLinksEnabled(value !== false);
      if (key === 'extraKeys') {
        options.extraKeys = (value && typeof value === 'object') ? value : {};
        return dispatch({ effects: ctx.extraKeysCompartment.reconfigure(createExtraKeymap(options.extraKeys, () => bridge)) });
      }
      if (key === 'yamlAssist') {
        options.yamlAssist = value || null;
        return dispatch({ effects: ctx.yamlAssistCompartment.reconfigure(yamlAssistExtensionFor(options)) });
      }
      return true;
    },
    getMode() { return getModeForCompat(); },
    clearHistory() { return resetStatePreservingDoc(); },
    operation(fn) { try { return typeof fn === 'function' ? fn() : null; } catch (e) {} return null; },
    runCommand(name) { return !!commandRunner(name); },
    execCommand(name) { return !!commandRunner(name); },
    hasCommand(name) { return ['findPersistent', 'find', 'findNext', 'findPrev', 'replace', 'replaceAll', 'toggleComment', 'save', 'undo', 'redo', 'fullscreen', 'links'].includes(normalizeCommandName(name)); },
    on(name, handler) { return emitter.on(name, handler); },
    off(name, handler) { return emitter.off(name, handler); },
    onChange(handler) { return emitter.on('change', handler); },
    onCursorChange(handler) { return emitter.on('cursorActivity', handler); },
    onSave(handler) { return emitter.on('save', handler); },
    dispose() {
      if (disposed) return true;
      disposed = true;
      try { if (bridge.getOption('fullScreen')) bridge.setOption('fullScreen', false); } catch (e) {}
      try { hideLinkTooltip(); } catch (e) {}
      try { if (ctx.scrollHandler) view.scrollDOM.removeEventListener('scroll', ctx.scrollHandler); } catch (e) {}
      try { view.destroy(); } catch (e) {}
      if (ctx.restoreHost) { try { ctx.restoreHost(); } catch (e) {} }
      emitter.emit('dispose', bridge);
      return true;
    },
  };

  syncTextarea();
  applyThemeClasses(host, options.theme);
  return bridge;
}

function createBridge(target, opts = {}) {
  const emitter = createEmitter();
  const hostInfo = createHost(target);
  const host = hostInfo && hostInfo.host ? hostInfo.host : target;
  const textarea = hostInfo && hostInfo.textarea ? hostInfo.textarea : (isTextarea(target) ? target : null);
  const ctx = {
    emitter,
    host,
    textarea,
    options: {
      mode: normalizeMode(opts.mode || opts.language || opts.mime),
      readOnly: !!opts.readOnly,
      lineWrapping: opts.lineWrapping !== false,
      theme: opts.theme || 'material-darker',
      fullScreen: false,
      lint: opts.lint !== false,
      links: opts.links !== false,
      extraKeys: (opts.extraKeys && typeof opts.extraKeys === 'object') ? opts.extraKeys : {},
      yamlAssist: opts.yamlAssist || null,
    },
    languageCompartment: new Compartment(),
    readOnlyCompartment: new Compartment(),
    lineWrappingCompartment: new Compartment(),
    diagnosticsCompartment: new Compartment(),
    themeCompartment: new Compartment(),
    searchCompartment: new Compartment(),
    linksCompartment: new Compartment(),
    extraKeysCompartment: new Compartment(),
    schemaCompartment: new Compartment(),
    yamlAssistCompartment: new Compartment(),
    fullscreenState: createFullscreenState(),
    restoreHost: hostInfo && typeof hostInfo.restore === 'function' ? hostInfo.restore : null,
    scrollHandler: null,
  };
  const value = typeof opts.value === 'string' ? opts.value : (textarea ? asString(textarea.value) : asString(opts.doc));
  const view = new EditorView({ state: buildState(ctx, ctx.options, value, null), parent: host });
  try { view.dom.classList.add('xkeen-cm6-editor'); } catch (e) {}
  ctx.scrollHandler = () => { try { emitter.emit('scroll', { left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop }); hideLinkTooltip(); } catch (e) {} };
  try { view.scrollDOM.addEventListener('scroll', ctx.scrollHandler, { passive: true }); } catch (e) {}
  const bridge = buildBridge(view, ctx);
  const themeListener = (event) => {
    try {
      const next = event && event.detail && event.detail.cmTheme ? event.detail.cmTheme : null;
      if (next) bridge.setOption('theme', next);
    } catch (e) {}
  };
  const uiSettingsListener = () => {
    try { if (bridge && typeof bridge.refreshSchemaExtensions === 'function') bridge.refreshSchemaExtensions(); } catch (e) {}
    try { view.requestMeasure(); } catch (e) {}
    try { bridge.refresh(); } catch (e) {}
  };
  try { document.addEventListener('xkeen-theme-change', themeListener); } catch (e) {}
  try { document.addEventListener('xkeen:ui-settings-changed', uiSettingsListener); } catch (e) {}
  try {
    ensureSchemaHoverSettingsLoaded().then(() => {
      try { if (bridge && typeof bridge.refreshSchemaExtensions === 'function') bridge.refreshSchemaExtensions(); } catch (e) {}
      try { bridge.refresh(); } catch (e) {}
    });
  } catch (e) {}
  try { if (ctx.options.extraKeys && Object.keys(ctx.options.extraKeys).length) bridge.setOption('extraKeys', ctx.options.extraKeys); } catch (e) {}
  const baseDispose = bridge.dispose.bind(bridge);
  bridge.dispose = function disposeWithThemeListener() {
    try { document.removeEventListener('xkeen-theme-change', themeListener); } catch (e) {}
    try { document.removeEventListener('xkeen:ui-settings-changed', uiSettingsListener); } catch (e) {}
    return baseDispose();
  };
  if (typeof opts.onChange === 'function') bridge.onChange(() => opts.onChange(bridge));
  if (typeof opts.onCursorChange === 'function') bridge.onCursorChange(() => opts.onCursorChange(bridge));
  if (typeof opts.onSave === 'function') bridge.onSave(() => opts.onSave(bridge));
  return bridge;
}

function getEditorEngine() {
  const win = getWindow();
  try { return win && win.XKeen && win.XKeen.ui ? win.XKeen.ui.editorEngine : null; } catch (e) {}
  return null;
}

function toFacade(editor, opts = {}) {
  const helper = getEditorEngine();
  if (helper && typeof helper.createFacade === 'function') {
    return helper.createFacade({
      ...(opts || {}),
      kind: 'codemirror',
      engine: 'codemirror',
      target: editor,
      raw: editor,
      get: () => editor.getValue(),
      set: (value) => editor.setValue(value),
      focus: () => editor.focus(),
      layout: () => editor.layout(),
      saveViewState: () => editor.saveViewState(),
      restoreViewState: (state) => editor.restoreViewState(state),
      onChange: (cb) => editor.onChange(cb),
      dispose: () => editor.dispose(),
    });
  }
  return editor;
}

const runtime = {
  backend: BACKEND,
  version: VERSION,
  engine: 'codemirror',
  source: 'local-offline-bundle',
  ensure: async () => ({ ok: true, ready: true, backend: BACKEND, source: 'local-offline-bundle' }),
  create(target, opts = {}) { if (!target) return null; return createBridge(target, opts); },
  toFacade,
  validateText(text, opts = {}) { return makeJsonDiagnostics(text, opts); },
  applyValidation(editor, opts = {}) {
    const target = editor && editor.raw ? editor.raw : editor;
    const text = typeof opts.text === 'string' ? opts.text : (target && typeof target.getValue === 'function' ? target.getValue() : '');
    const result = makeJsonDiagnostics(text, opts);
    if (target && typeof target.setDiagnostics === 'function') {
      try { if (result.diagnostics && result.diagnostics.length) target.setDiagnostics(result.diagnostics); else target.clearDiagnostics(); } catch (e) {}
    }
    return result;
  },
  clearValidation(editor) { const target = editor && editor.raw ? editor.raw : editor; try { if (target && typeof target.clearDiagnostics === 'function') target.clearDiagnostics(); } catch (e) {} return true; },
  setSchema(editor, schema) { const target = editor && editor.raw ? editor.raw : editor; try { if (target && typeof target.setSchema === 'function') return target.setSchema(schema); } catch (e) {} return false; },
  supportsMode(mode) { const next = normalizeMode(mode); return ['application/json', 'application/jsonc', 'application/javascript', 'text/yaml', 'text/plain'].includes(next); },
  isAvailable() { return true; },
  describe() { return { engine: 'codemirror', backend: BACKEND, version: VERSION, source: 'local-offline-bundle', ready: true }; },
};

const win = ensureGlobalScope();
if (win) {
  win[GLOBAL_KEY] = runtime;
  win.XKeen.ui.cm6Runtime = runtime;
}

export default runtime;
