let mihomoYamlPatchModuleApi = null;

export function ensureNewline(s) {
  const t = String(s || '');
  return t.endsWith('\n') ? t : t + '\n';
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns { headerStart, headerEnd, bodyStart, bodyEnd, inlineTail } or null
export function findSection(text, key) {
  const src = String(text || '');

  // Match top-level key (column 0). If user indented the whole file, we still try (best-effort).
  const re = new RegExp(`^(?:${escapeRegExp(key)})\\s*:\\s*(.*)$`, 'm');
  const m = re.exec(src);
  if (!m) return null;

  const lineStart = m.index;
  const lineEnd = src.indexOf('\n', lineStart);
  const afterLine = lineEnd === -1 ? src.length : lineEnd + 1;

  // Find next top-level key (starts in column 0, not comment)
  const rest = src.slice(afterLine);
  const next = /^(?!\s)(?!#)([A-Za-z0-9_.-]+)\s*:/m.exec(rest);
  const bodyEnd = next ? afterLine + next.index : src.length;

  // If section is inline like `proxies: []` or `proxy-providers: {}`
  const inlineTail = String(m[1] || '').trim();

  return {
    headerStart: lineStart,
    headerEnd: afterLine,
    bodyStart: afterLine,
    bodyEnd,
    inlineTail,
  };
}

function normalizeInlineSection(text, key) {
  const src = String(text || '');
  const re = new RegExp(`^(${escapeRegExp(key)}\\s*:)\\s*(\\[\\]|\\{\\}|null|~)?\\s*(#.*)?$`, 'm');
  const m = re.exec(src);
  if (!m) return src;

  // Convert to block style: keep comment
  const comment = m[3] ? ' ' + m[3].trim() : '';
  const repl = `${key}:${comment}`;
  return src.replace(re, repl);
}

/**
 * Insert `snippet` into a top-level YAML section.
 *
 * @param {string} text     YAML document
 * @param {string} key      top-level key (e.g. "proxies", "proxy-providers")
 * @param {string} snippet  YAML fragment to append inside section
 * @param {object=} opts
 *   - avoidDuplicates (default true): if snippet already present, do nothing
 */
export function insertIntoSection(text, key, snippet, opts) {
  const o = opts || {};
  const avoidDuplicates = (o.avoidDuplicates !== false);

  let src = ensureNewline(String(text || ''));
  src = normalizeInlineSection(src, key);

  const sec = findSection(src, key);
  const sn = ensureNewline(String(snippet || '')).trimEnd() + '\n';

  if (!sec) {
    // Append new section at the end
    const sep = src.trimEnd().length ? '\n' : '';
    return src.trimEnd() + sep + `${key}:\n` + sn;
  }

  if (avoidDuplicates) {
    try {
      if (src.includes(sn.trim())) return src;
    } catch (e) {}
  }

  const before = src.slice(0, sec.bodyEnd);
  const after = src.slice(sec.bodyEnd);

  let mid = before;
  if (!mid.endsWith('\n')) mid += '\n';

  // Keep body compact: only add extra newline when there is existing body content
  const body = src.slice(sec.bodyStart, sec.bodyEnd);
  const hasBodyContent = body.trim().length > 0;
  if (hasBodyContent && !body.endsWith('\n\n')) {
    if (!mid.endsWith('\n')) mid += '\n';
  }

  mid += sn;
  return mid + after;
}

function noopDisposeMihomoYamlPatch() {
  return null;
}

function createMihomoYamlPatchModuleApi() {
  return {
    init: initMihomoYamlPatch,
    load: loadMihomoYamlPatch,
    onShow: onShowMihomoYamlPatch,
    ensureNewline,
    findSection,
    insertIntoSection,
    dispose: noopDisposeMihomoYamlPatch,
  };
}

export function getMihomoYamlPatchApi() {
  try {
    if (!mihomoYamlPatchModuleApi) {
      mihomoYamlPatchModuleApi = createMihomoYamlPatchModuleApi();
    }
    return mihomoYamlPatchModuleApi;
  } catch (error) {
    console.error(error);
    return null;
  }
}

export function initMihomoYamlPatch() {
  return getMihomoYamlPatchApi();
}

export function loadMihomoYamlPatch() {
  return getMihomoYamlPatchApi();
}

export function onShowMihomoYamlPatch() {
  return getMihomoYamlPatchApi();
}

export function disposeMihomoYamlPatch(...args) {
  const api = getMihomoYamlPatchApi();
  if (!api || typeof api.dispose !== 'function') return null;
  return api.dispose(...args);
}

export const mihomoYamlPatchApi = Object.freeze({
  get: getMihomoYamlPatchApi,
  init: initMihomoYamlPatch,
  load: loadMihomoYamlPatch,
  onShow: onShowMihomoYamlPatch,
  ensureNewline,
  findSection,
  insertIntoSection,
  dispose: disposeMihomoYamlPatch,
});
