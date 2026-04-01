export function getXrayLogLineClass(line) {
  const lower = String(line || '').toLowerCase();

  if (
    lower.includes('error') ||
    lower.includes('fail') ||
    lower.includes('failed') ||
    lower.includes('fatal')
  ) {
    return 'log-line log-line-error';
  }

  if (lower.includes('warning') || lower.includes('warn')) {
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
