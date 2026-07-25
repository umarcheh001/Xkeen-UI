const XRAY_LOG_LEVEL_ORDER = Object.freeze({ debug: 0, info: 1, warning: 2, error: 3 });

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

export function detectXrayLogLineLevel(line) {
  const text = String(line || '');
  const lower = text.toLowerCase();

  // Xray frequently wraps operational failures in an [Info] record, for
  // example "[Info] ... failed ... stream ERROR".  For the view threshold,
  // the semantic failure must win over that logger-verbosity marker.
  if (hasXrayErrorSignal(lower)) return 'error';
  if (hasXrayWarningSignal(lower)) return 'warning';

  let match = text.match(/\[(debug|info|warning|error)\]/i);
  if (match && match[1]) return String(match[1]).toLowerCase();

  match = text.match(/\blevel=(debug|info|warning|error)\b/i);
  if (match && match[1]) return String(match[1]).toLowerCase();

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
  const lower = String(line || '').toLowerCase();

  if (hasXrayErrorSignal(lower)) {
    return 'log-line log-line-error';
  }

  if (hasXrayWarningSignal(lower)) {
    return 'log-line log-line-warning';
  }

  if (lower.includes('info')) {
    return 'log-line log-line-info';
  }

  if (lower.includes('debug')) {
    return 'log-line log-line-debug';
  }

  return 'log-line';
}
