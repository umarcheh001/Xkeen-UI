import {
  createMihomoSnippetProvider,
  createXraySnippetProvider,
} from './schema_snippets.js';
import {
  createMihomoQuickFixProvider,
  createXrayQuickFixProvider,
} from './schema_quickfixes.js';

const SCHEMA_URLS = Object.freeze({
  xray: '/static/schemas/xray-config.schema.json',
  xrayRouting: '/static/schemas/xray-routing.schema.json',
  xrayInbounds: '/static/schemas/xray-inbounds.schema.json',
  xrayOutbounds: '/static/schemas/xray-outbounds.schema.json',
  mihomo: '/static/schemas/mihomo-config.schema.json',
});

const _schemaCache = new Map();
const _snippetProviderCache = Object.freeze({
  'xray-config': createXraySnippetProvider('xray-config'),
  'xray-routing': createXraySnippetProvider('xray-routing'),
  'xray-inbounds': createXraySnippetProvider('xray-inbounds'),
  'xray-outbounds': createXraySnippetProvider('xray-outbounds'),
  mihomo: createMihomoSnippetProvider(),
});
const _quickFixProviderCache = Object.freeze({
  'xray-config': createXrayQuickFixProvider(),
  'xray-routing': createXrayQuickFixProvider(),
  'xray-inbounds': createXrayQuickFixProvider(),
  'xray-outbounds': createXrayQuickFixProvider(),
  mihomo: createMihomoQuickFixProvider(),
});

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function basename(value) {
  const raw = normalizeText(value).replace(/\\/g, '/');
  if (!raw) return '';
  const parts = raw.split('/');
  return parts[parts.length - 1] || '';
}

function isEditorExpertModeEnabled(ctx) {
  const o = ctx || {};
  try {
    if (Object.prototype.hasOwnProperty.call(o, 'expertModeEnabled')) return o.expertModeEnabled === true;
  } catch (e) {}
  try {
    const api = window.XKeen && window.XKeen.ui && window.XKeen.ui.settings;
    if (api && typeof api.isEditorExpertModeEnabled === 'function') return api.isEditorExpertModeEnabled();
    if (api && typeof api.get === 'function') {
      const settings = api.get();
      const editor = (settings && settings.editor && typeof settings.editor === 'object') ? settings.editor : {};
      return editor.expertModeEnabled === true;
    }
  } catch (e) {}
  return false;
}

function isJsonMode(mode) {
  const raw = normalizeLower(mode);
  if (!raw) return true;
  return raw === 'json'
    || raw === 'jsonc'
    || raw === 'application/json'
    || raw === 'application/jsonc'
    || raw === 'text/json'
    || raw === 'text/jsonc';
}

function inferSchemaKind(ctx) {
  const o = ctx || {};
  const target = normalizeLower(o.target || o.kind || o.feature || o.scope);
  const file = basename(o.file || o.filename || o.path || o.url || '');
  const fileLower = file.toLowerCase();
  const pathLower = normalizeLower(o.path || o.url || o.file || '');
  const mode = normalizeLower(o.mode || o.language);

  if (target === 'inbounds' || /(^|_)inbounds/i.test(file)) return 'xray-inbounds';
  if (target === 'outbounds' || /(^|_)outbounds/i.test(file)) return 'xray-outbounds';
  if (target === 'routing' || /(^|_)routing/i.test(file)) return 'xray-routing';
  if (target === 'xray' || /(?:^|\.)jsonc?$/i.test(fileLower)) return 'xray';
  if (target === 'mihomo' || fileLower === 'config.yaml' || fileLower === 'config.yml' || pathLower.includes('/mihomo/') || mode === 'yaml' || mode === 'text/yaml') return 'mihomo';
  return '';
}

export function resolveEditorSchemaSpec(ctx) {
  const kind = inferSchemaKind(ctx);
  if (!kind) return null;
  if (kind === 'mihomo') {
    return {
      id: 'mihomo',
      family: 'mihomo',
      url: SCHEMA_URLS.mihomo,
      title: 'Mihomo config',
      label: 'Mihomo config',
      mode: 'yaml',
    };
  }
  const fragment = kind.startsWith('xray-') ? kind.slice('xray-'.length) : '';
  const fragmentUrls = {
    routing: SCHEMA_URLS.xrayRouting,
    inbounds: SCHEMA_URLS.xrayInbounds,
    outbounds: SCHEMA_URLS.xrayOutbounds,
  };
  const fragmentLabels = {
    routing: 'Xray routing',
    inbounds: 'Xray inbounds',
    outbounds: 'Xray outbounds',
  };
  return {
    id: fragment ? `xray:${fragment}` : 'xray',
    family: 'xray',
    fragment,
    url: fragmentUrls[fragment] || SCHEMA_URLS.xray,
    title: fragment ? `Xray ${fragment} fragment` : 'Xray config',
    label: fragment ? (fragmentLabels[fragment] || `Xray ${fragment}`) : 'Xray config',
    mode: 'json',
  };
}

async function loadSchema(url) {
  const key = normalizeText(url);
  if (!key) return null;
  if (_schemaCache.has(key)) return _schemaCache.get(key);

  const promise = fetch(key, { cache: 'no-store' })
    .then((res) => {
      if (!res || !res.ok) throw new Error(`schema load failed: ${key}`);
      return res.json();
    });

  _schemaCache.set(key, promise);
  try {
    return await promise;
  } catch (e) {
    _schemaCache.delete(key);
    throw e;
  }
}

export async function loadEditorSchema(ctx) {
  if (isEditorExpertModeEnabled(ctx)) {
    return { ok: false, skipped: true, reason: 'expert-mode', spec: null, schema: null };
  }
  const spec = resolveEditorSchemaSpec(ctx || {});
  if (!spec) return { ok: false, skipped: true, reason: 'schema-unmatched', spec: null, schema: null };
  try {
    const schema = await loadSchema(spec.url);
    return { ok: true, skipped: false, spec, schema };
  } catch (error) {
    return { ok: false, skipped: true, reason: 'schema-load-failed', error, spec, schema: null };
  }
}

function getRuntime(ctx) {
  try {
    if (ctx && ctx.runtime && typeof ctx.runtime === 'object') return ctx.runtime;
  } catch (e) {}
  try {
    return window.XKeen && window.XKeen.ui ? window.XKeen.ui.cm6Runtime : null;
  } catch (e2) {}
  return null;
}

function setEditorSchema(editor, schema, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  const runtime = getRuntime(ctx);
  try {
    if (runtime && typeof runtime.setSchema === 'function') return !!runtime.setSchema(target, schema || null);
  } catch (e) {}
  try {
    if (target && typeof target.setSchema === 'function') return !!target.setSchema(schema || null);
  } catch (e2) {}
  return false;
}

function setEditorSnippetProvider(editor, provider, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  const runtime = getRuntime(ctx);
  try {
    if (runtime && typeof runtime.setSnippetProvider === 'function') return !!runtime.setSnippetProvider(target, provider || null);
  } catch (e) {}
  try {
    if (target && typeof target.setSnippetProvider === 'function') return !!target.setSnippetProvider(provider || null);
  } catch (e2) {}
  try {
    if (target && typeof target.setOption === 'function') return !!target.setOption('snippetProvider', provider || null);
  } catch (e3) {}
  return false;
}

function setEditorQuickFixProvider(editor, provider, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  const runtime = getRuntime(ctx);
  try {
    if (runtime && typeof runtime.setQuickFixProvider === 'function') return !!runtime.setQuickFixProvider(target, provider || null);
  } catch (e) {}
  try {
    if (target && typeof target.setQuickFixProvider === 'function') return !!target.setQuickFixProvider(provider || null);
  } catch (e2) {}
  try {
    if (target && typeof target.setOption === 'function') return !!target.setOption('quickFixProvider', provider || null);
  } catch (e3) {}
  return false;
}

function setEditorSemanticValidation(editor, provider, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  const runtime = getRuntime(ctx);
  try {
    if (runtime && typeof runtime.setSemanticValidation === 'function') return !!runtime.setSemanticValidation(target, provider || null);
  } catch (e) {}
  try {
    if (target && typeof target.setSemanticValidation === 'function') return !!target.setSemanticValidation(provider || null);
  } catch (e2) {}
  try {
    if (target && typeof target.setOption === 'function') return !!target.setOption('semanticValidation', provider || null);
  } catch (e3) {}
  return false;
}

function normalizeSnippetKind(value) {
  const raw = normalizeLower(value);
  if (!raw) return '';
  if (raw === 'xray') return 'xray-config';
  return raw;
}

export function resolveEditorSnippetProvider(ctx) {
  if (isEditorExpertModeEnabled(ctx)) return null;
  const o = ctx || {};
  const explicitKind = normalizeSnippetKind(o.snippetKind || o.schemaKind);
  if (explicitKind && _snippetProviderCache[explicitKind]) return _snippetProviderCache[explicitKind];

  const inferredKind = normalizeSnippetKind(inferSchemaKind(o));
  if (!inferredKind) return null;
  return _snippetProviderCache[inferredKind] || null;
}

export function resolveEditorQuickFixProvider(ctx) {
  if (isEditorExpertModeEnabled(ctx)) return null;
  const o = ctx || {};
  const explicitKind = normalizeSnippetKind(o.quickFixKind || o.schemaKind);
  if (explicitKind && _quickFixProviderCache[explicitKind]) return _quickFixProviderCache[explicitKind];

  const inferredKind = normalizeSnippetKind(inferSchemaKind(o));
  if (!inferredKind) return null;
  return _quickFixProviderCache[inferredKind] || null;
}

export function resolveEditorSemanticValidation(ctx) {
  if (isEditorExpertModeEnabled(ctx)) return null;
  const o = ctx || {};
  const explicitKind = normalizeSnippetKind(o.semanticKind || o.schemaKind);
  const inferredKind = explicitKind || normalizeSnippetKind(inferSchemaKind(o));
  if (!inferredKind) return null;
  if (inferredKind === 'xray-config' || inferredKind === 'xray' || inferredKind === 'xray-routing' || inferredKind === 'xray-inbounds' || inferredKind === 'xray-outbounds') {
    return {
      kind: inferredKind === 'xray' ? 'xray-config' : inferredKind,
      options: {
        schemaKind: inferredKind,
      },
    };
  }
  return null;
}

export function clearSchemaFromEditor(editor, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  const context = ctx || {};
  const schemaCleared = setEditorSchema(target, null, context);
  const snippetCleared = setEditorSnippetProvider(target, null, context);
  const quickFixCleared = setEditorQuickFixProvider(target, null, context);
  const semanticCleared = setEditorSemanticValidation(target, null, context);
  return schemaCleared || snippetCleared || quickFixCleared || semanticCleared;
}

export async function applySchemaToEditor(editor, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  if (!target) return { ok: false, skipped: true, reason: 'editor-missing' };

  const o = ctx || {};
  if (isEditorExpertModeEnabled(o)) {
    clearSchemaFromEditor(target, o);
    return { ok: false, skipped: true, reason: 'expert-mode' };
  }
  const spec = resolveEditorSchemaSpec(o);
  if (!spec) {
    clearSchemaFromEditor(target, o);
    return { ok: false, skipped: true, reason: 'schema-unmatched' };
  }

  if (!isJsonMode(o.mode || o.language || spec.mode)) {
    clearSchemaFromEditor(target, o);
    return { ok: false, skipped: true, reason: 'mode-not-json', spec };
  }

  const loaded = await loadEditorSchema(o);
  if (!loaded || !loaded.ok || !loaded.schema) {
    clearSchemaFromEditor(target, o);
    return {
      ok: false,
      skipped: true,
      reason: loaded && loaded.reason ? loaded.reason : 'schema-load-failed',
      error: loaded && loaded.error ? loaded.error : null,
      spec,
    };
  }
  const ok = setEditorSchema(target, loaded.schema, o);
  const snippetProvider = resolveEditorSnippetProvider({
    ...o,
    schemaKind: spec.family === 'xray'
      ? (spec.fragment ? `xray-${spec.fragment}` : 'xray-config')
      : spec.family,
  });
  const quickFixProvider = o.quickFixProvider || resolveEditorQuickFixProvider({
    ...o,
    schemaKind: spec.family === 'xray'
      ? (spec.fragment ? `xray-${spec.fragment}` : 'xray-config')
      : spec.family,
  });
  const semanticValidation = o.semanticValidation || resolveEditorSemanticValidation({
    ...o,
    schemaKind: spec.family === 'xray'
      ? (spec.fragment ? `xray-${spec.fragment}` : 'xray-config')
      : spec.family,
  });
  const snippetsOk = setEditorSnippetProvider(target, snippetProvider, o);
  const quickFixOk = setEditorQuickFixProvider(target, quickFixProvider, o);
  const semanticOk = setEditorSemanticValidation(target, semanticValidation, o);
  return {
    ok: ok || snippetsOk || quickFixOk || semanticOk,
    skipped: false,
    spec,
    schema: loaded.schema,
    snippetProvider,
    quickFixProvider,
    semanticValidation,
  };
}

export const editorSchemaApi = Object.freeze({
  resolveEditorSchemaSpec,
  resolveEditorSnippetProvider,
  resolveEditorQuickFixProvider,
  resolveEditorSemanticValidation,
  loadEditorSchema,
  applySchemaToEditor,
  clearSchemaFromEditor,
  setEditorSnippetProvider,
  setEditorQuickFixProvider,
  setEditorSemanticValidation,
});
