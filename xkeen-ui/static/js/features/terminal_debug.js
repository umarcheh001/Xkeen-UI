const STORAGE_KEY = 'xkeen_terminal_debug_v1';
const MAX_RECORDS = 200;

function getRoot() {
  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.debug = XK.debug || {};
  XK.debug.terminal = XK.debug.terminal || {
    status: '',
    lastStage: '',
    runStartedAt: 0,
    runFinishedAt: 0,
    records: [],
  };
  return XK.debug.terminal;
}

function now() {
  return Date.now();
}

function persist(root) {
  try {
    if (!window.localStorage) return;
    const payload = {
      status: String(root.status || ''),
      lastStage: String(root.lastStage || ''),
      runStartedAt: Number(root.runStartedAt || 0),
      runFinishedAt: Number(root.runFinishedAt || 0),
      records: Array.isArray(root.records) ? root.records.slice(-MAX_RECORDS) : [],
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {}
}

function hydrate(root) {
  try {
    if (!window.localStorage) return root;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return root;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return root;
    if (Array.isArray(parsed.records) && !root.records.length) {
      root.records = parsed.records.slice(-MAX_RECORDS);
    }
    if (!root.status && parsed.status) root.status = String(parsed.status || '');
    if (!root.lastStage && parsed.lastStage) root.lastStage = String(parsed.lastStage || '');
    if (!root.runStartedAt && parsed.runStartedAt) root.runStartedAt = Number(parsed.runStartedAt || 0);
    if (!root.runFinishedAt && parsed.runFinishedAt) root.runFinishedAt = Number(parsed.runFinishedAt || 0);
  } catch (e) {}
  return root;
}

export function appendTerminalDebug(stage, payload) {
  const root = hydrate(getRoot());
  const entry = {
    ts: now(),
    stage: String(stage || ''),
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  root.lastStage = entry.stage;
  root.records = Array.isArray(root.records) ? root.records : [];
  root.records.push(entry);
  if (root.records.length > MAX_RECORDS) {
    root.records = root.records.slice(-MAX_RECORDS);
  }
  persist(root);
  return entry;
}

export function markTerminalDebugState(patch) {
  const root = hydrate(getRoot());
  const next = patch && typeof patch === 'object' ? patch : {};
  if (Object.prototype.hasOwnProperty.call(next, 'status')) {
    root.status = String(next.status || '');
  }
  if (Object.prototype.hasOwnProperty.call(next, 'lastStage')) {
    root.lastStage = String(next.lastStage || '');
  }
  if (Object.prototype.hasOwnProperty.call(next, 'runStartedAt')) {
    root.runStartedAt = Number(next.runStartedAt || 0);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'runFinishedAt')) {
    root.runFinishedAt = Number(next.runFinishedAt || 0);
  }
  persist(root);
  return root;
}

export function startTerminalDebugRun(meta) {
  const root = hydrate(getRoot());
  root.runStartedAt = now();
  root.runFinishedAt = 0;
  root.status = 'starting';
  root.records = [];
  persist(root);
  appendTerminalDebug('run:start', meta && typeof meta === 'object' ? meta : {});
  return root;
}

export function finishTerminalDebugRun(status, meta) {
  const root = hydrate(getRoot());
  root.runFinishedAt = now();
  root.status = String(status || 'done');
  persist(root);
  appendTerminalDebug('run:finish', {
    status: String(status || 'done'),
    ...(meta && typeof meta === 'object' ? meta : {}),
  });
  return root;
}

export function getTerminalDebugState() {
  const root = hydrate(getRoot());
  return {
    status: String(root.status || ''),
    lastStage: String(root.lastStage || ''),
    runStartedAt: Number(root.runStartedAt || 0),
    runFinishedAt: Number(root.runFinishedAt || 0),
    records: Array.isArray(root.records) ? root.records.slice() : [],
  };
}
