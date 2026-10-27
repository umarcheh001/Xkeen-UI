/**
 * Small state/revision helpers for the Mihomo import workbench.
 *
 * This module is intentionally framework-free. It owns request/session
 * identity, not DOM rendering or parser output.
 */

export function createMihomoImportState() {
  return {
    sessionId: 0,
    sourceRevision: 0,
    source: '',
    mode: 'auto',
    selectedGroups: [],
    destination: null,
    warnings: [],
    baseConfigRevision: 0,
    candidate: null,
    requestId: 0,
    activeRequest: null,
    resultRevision: 0,
    result: null,
  };
}

export function resetMihomoImportState(state) {
  if (!state || typeof state !== 'object') return createMihomoImportState();
  state.sessionId += 1;
  state.sourceRevision = 0;
  state.source = '';
  state.mode = 'auto';
  state.selectedGroups = [];
  state.destination = null;
  state.warnings = [];
  state.baseConfigRevision = 0;
  state.candidate = null;
  state.requestId = 0;
  state.activeRequest = null;
  state.resultRevision = 0;
  state.result = null;
  return state;
}

/** Invalidate a parse result without cancelling server work already in flight. */
export function invalidateMihomoImportResult(state) {
  if (!state || typeof state !== 'object') return 0;
  state.sourceRevision += 1;
  state.result = null;
  state.resultRevision = 0;
  state.candidate = null;
  return state.sourceRevision;
}

export function updateMihomoImportContext(state, context = {}) {
  if (!state || typeof state !== 'object') return state;
  if (Object.prototype.hasOwnProperty.call(context, 'source')) state.source = String(context.source || '');
  if (Object.prototype.hasOwnProperty.call(context, 'mode')) state.mode = String(context.mode || 'auto');
  if (Object.prototype.hasOwnProperty.call(context, 'selectedGroups')) {
    state.selectedGroups = Array.isArray(context.selectedGroups) ? context.selectedGroups.slice() : [];
  }
  if (Object.prototype.hasOwnProperty.call(context, 'destination')) state.destination = context.destination || null;
  if (Object.prototype.hasOwnProperty.call(context, 'warnings')) {
    state.warnings = Array.isArray(context.warnings) ? context.warnings.slice() : [];
  }
  if (Object.prototype.hasOwnProperty.call(context, 'baseConfigRevision')) {
    state.baseConfigRevision = Number(context.baseConfigRevision) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(context, 'candidate')) state.candidate = context.candidate || null;
  return state;
}

export function beginMihomoImportRequest(state, kind = 'parse') {
  if (!state || typeof state !== 'object') return null;
  const token = Object.freeze({
    sessionId: state.sessionId,
    sourceRevision: state.sourceRevision,
    requestId: ++state.requestId,
    kind: String(kind || 'parse'),
  });
  state.activeRequest = token;
  return token;
}

export function isCurrentMihomoImportRequest(state, token) {
  if (!state || !token || !state.activeRequest) return false;
  const current = state.activeRequest;
  return current.sessionId === token.sessionId
    && current.sourceRevision === token.sourceRevision
    && current.sourceRevision === state.sourceRevision
    && current.requestId === token.requestId;
}

export function commitMihomoImportResult(state, token, result) {
  if (!isCurrentMihomoImportRequest(state, token)) return false;
  state.resultRevision = token.sourceRevision;
  state.result = result || null;
  return true;
}

export function isCurrentMihomoImportResult(state, result) {
  return !!(
    state
    && result
    && state.result === result
    && state.resultRevision === state.sourceRevision
  );
}
