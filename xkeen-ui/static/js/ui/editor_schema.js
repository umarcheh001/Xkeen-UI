const SCHEMA_URLS = Object.freeze({
  xray: '/static/schemas/xray-config.schema.json',
  xrayRouting: '/static/schemas/xray-routing.schema.json',
  xrayInbounds: '/static/schemas/xray-inbounds.schema.json',
  xrayOutbounds: '/static/schemas/xray-outbounds.schema.json',
  mihomo: '/static/schemas/mihomo-config.schema.json',
});

const _schemaCache = new Map();

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

export function clearSchemaFromEditor(editor, ctx) {
  return setEditorSchema(editor, null, ctx || {});
}

export async function applySchemaToEditor(editor, ctx) {
  const target = editor && editor.raw ? editor.raw : editor;
  if (!target) return { ok: false, skipped: true, reason: 'editor-missing' };

  const o = ctx || {};
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
  return { ok, skipped: false, spec, schema: loaded.schema };
}

export const editorSchemaApi = Object.freeze({
  resolveEditorSchemaSpec,
  loadEditorSchema,
  applySchemaToEditor,
  clearSchemaFromEditor,
});
