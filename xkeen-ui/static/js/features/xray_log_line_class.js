const XRAY_LOG_LEVEL_ORDER = Object.freeze({ debug: 0, info: 1, warning: 2, error: 3 });

// Xray's logger marker is the source of truth for a line's severity.  The
// message payload may contain words such as "failed" or "ERROR" while the
// logger intentionally emitted the record with LogInfo/LogWarning.  Keep the
// marker expression in one place so classification and future consumers use
// exactly the same precedence and aliases.
const XRAY_LOG_MARKER_RE = /\[(debug|info|warn(?:ing)?|error|fatal)\]/i;
const XRAY_LOG_LEVEL_FIELD_RE = /\blevel\s*=\s*(debug|info|warn(?:ing)?|error|fatal)\b/i;

function normalizeXrayLogLevel(level) {
  const value = String(level || '').trim().toLowerCase();
  if (value === 'warn') return 'warning';
  if (value === 'fatal') return 'error';
  return value;
}

function hasXrayErrorSignal(lower) {
  return (
    lower.includes('error') ||
    lower.includes('fail') ||
    lower.includes('fatal')
  );
}

function hasXrayWarningSignal(lower) {
  return lower.includes('warning') || lower.includes('warn');
}

function hasXrayInfoSignal(text) {
  return /\binfo\b/i.test(String(text || ''));
}

function hasXrayDebugSignal(text) {
  return /\bdebug\b/i.test(String(text || ''));
}

export function detectXrayLogLineLevel(line) {
  const text = String(line || '');
  const lower = text.toLowerCase();

  // 1) Structured Xray marker: this must win over message words.  For
  // example, "[Info] ... failed ... stream ERROR" remains an Info record.
  let match = text.match(XRAY_LOG_MARKER_RE);
  if (match && match[1]) return normalizeXrayLogLevel(match[1]);

  // 2) Other structured logger formats occasionally expose level=... rather
  // than a bracketed marker.  Treat this as authoritative as well.
  match = text.match(XRAY_LOG_LEVEL_FIELD_RE);
  if (match && match[1]) return normalizeXrayLogLevel(match[1]);

  // 3) Legacy/unstructured lines have no marker; retain the old best-effort
  // fallback so restart/devtools logs do not lose useful coloring/filtering.
  if (hasXrayErrorSignal(lower)) return 'error';
  if (hasXrayWarningSignal(lower)) return 'warning';
  if (hasXrayInfoSignal(text)) return 'info';
  if (hasXrayDebugSignal(text)) return 'debug';

  return '';
}

export function shouldKeepXrayLogLineForLevel(line, threshold) {
  const normalizedThreshold = String(threshold || '').trim().toLowerCase();
  if (!(normalizedThreshold in XRAY_LOG_LEVEL_ORDER)) return true;

  const level = detectXrayLogLineLevel(line);
  if (!(level in XRAY_LOG_LEVEL_ORDER)) return true;

  return XRAY_LOG_LEVEL_ORDER[level] >= XRAY_LOG_LEVEL_ORDER[normalizedThreshold];
}

export function getXrayLogLineClass(line) {
  const level = detectXrayLogLineLevel(line);
  if (level === 'error') return 'log-line log-line-error';
  if (level === 'warning') return 'log-line log-line-warning';
  if (level === 'info') return 'log-line log-line-info';
  if (level === 'debug') return 'log-line log-line-debug';
  return 'log-line';
}
