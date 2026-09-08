import {
  mihomoClashTelemetryWsUrl,
  requestMihomoClashWsToken,
} from './client.js';

// The established feature modules still own rendering and mutations. This
// adapter owns only the single browser telemetry socket and its lifecycle.
const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_RECONNECT_DELAY_MS = 15000;

let socket = null;
let generation = 0;
let listeners = new Set();
let state = 'paused';
let lastFrame = null;
let reconnectAttempt = 0;
let reconnectTimer = 0;
let connectOptions = null;
let connecting = false;

function emit(nextState, frame = lastFrame, detail = {}) {
  state = String(nextState || 'error');
  if (frame) lastFrame = frame;
  for (const listener of Array.from(listeners)) {
    try { listener({ state, frame: lastFrame, ...detail }); } catch (error) {}
  }
}

function clearReconnect() {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = 0;
}

function reconnectDelay() {
  const base = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * (2 ** Math.min(4, reconnectAttempt)));
  reconnectAttempt += 1;
  return Math.round(base * (.8 + Math.random() * .4));
}

function disposeSocket() {
  const current = socket;
  socket = null;
  if (!current) return;
  current.onopen = null; current.onmessage = null; current.onerror = null; current.onclose = null;
  try { current.close(); } catch (error) {}
}

function scheduleReconnect(run) {
  if (!connectOptions || run !== generation) return;
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    emit('fallback', null, { reason: 'reconnect_exhausted' });
    return;
  }
  emit('reconnecting');
  clearReconnect();
  reconnectTimer = window.setTimeout(() => void open(run), reconnectDelay());
}

async function open(run) {
  if (!connectOptions || run !== generation || connecting || socket) return false;
  connecting = true;
  emit(reconnectAttempt ? 'reconnecting' : 'connecting');
  try {
    const token = await requestMihomoClashWsToken({
      signal: connectOptions.signal,
      scope: 'mihomo-clash-telemetry',
    });
    if (run !== generation || !connectOptions || !token) return false;
    const current = new WebSocket(mihomoClashTelemetryWsUrl(token));
    socket = current;
    current.onopen = () => {
      if (socket !== current || run !== generation) return;
      reconnectAttempt = 0;
      emit('live');
    };
    current.onmessage = (event) => {
      if (socket !== current || run !== generation) return;
      let frame = null;
      try { frame = JSON.parse(event.data); } catch (error) { return; }
      if (frame?.type !== 'mihomo-clash-telemetry' || Number(frame.schema_version) !== 1) return;
      const next = frame.state === 'error' ? 'error' : frame.state === 'stale' ? 'stale' : 'live';
      emit(next, frame);
    };
    current.onerror = () => { if (socket === current) emit('reconnecting'); };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      scheduleReconnect(run);
    };
    return true;
  } catch (error) {
    if (run === generation) scheduleReconnect(run);
    return false;
  } finally {
    connecting = false;
  }
}

export function subscribeMihomoTelemetry(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  try { listener({ state, frame: lastFrame, replay: true }); } catch (error) {}
  return () => listeners.delete(listener);
}

export function closeMihomoTelemetry(reason = 'paused') {
  generation += 1;
  connectOptions = null;
  connecting = false;
  reconnectAttempt = 0;
  clearReconnect();
  disposeSocket();
  emit(reason, null, { reason });
}

export function connectMihomoTelemetry(options = {}) {
  if (typeof WebSocket !== 'function' || options.enabled !== true) return false;
  connectOptions = { ...options };
  if (socket || connecting || reconnectTimer) return true;
  const run = ++generation;
  reconnectAttempt = 0;
  void open(run);
  return true;
}

export function getMihomoTelemetryState() {
  return { state, frame: lastFrame, connected: !!socket };
}
