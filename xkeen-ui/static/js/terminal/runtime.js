import {
  ansiToXkeenHtml,
  closeXkeenModal,
  escapeXkeenHtml,
  focusXkeenTerminal,
  getXkeenCommandJobApi,
  getXkeenCoreHttpApi,
  getXkeenModalApi,
  getXkeenStateApi,
  isXkeenTerminalPtyConnected,
  openXkeenTerminal,
  getXkeenTerminalCapabilitiesApi,
  getXkeenTerminalCoreContext,
  getXkeenTerminalPtyApi,
  getXkeenTerminalRoot,
  getXkeenUtilApi,
  openXkeenModal,
  syncXkeenBodyScrollLock,
  toastXkeen,
} from '../features/xkeen_runtime.js';

function getWindowRef() {
  try {
    return window || null;
  } catch (error) {
    return null;
  }
}

function ensureWindowXKeen() {
  const win = getWindowRef();
  if (!win) return null;
  if (!win.XKeen || typeof win.XKeen !== 'object') win.XKeen = {};
  return win.XKeen;
}

export function ensureTerminalRoot() {
  const xk = ensureWindowXKeen();
  if (!xk) return null;
  if (!xk.terminal || typeof xk.terminal !== 'object') xk.terminal = {};
  return xk.terminal;
}

export function ensureGlobalStateRoot() {
  const xk = ensureWindowXKeen();
  if (!xk) return null;
  if (!xk.state || typeof xk.state !== 'object') xk.state = {};
  return xk.state;
}

export function ensureTerminalCompatState(defaults) {
  const xk = ensureWindowXKeen();
  if (!xk) return null;
  if (!xk.terminalState || typeof xk.terminalState !== 'object') xk.terminalState = {};
  const state = xk.terminalState;
  const seed = (defaults && typeof defaults === 'object') ? defaults : {};
  Object.keys(seed).forEach((key) => {
    if (!(key in state)) state[key] = seed[key];
  });
  return state;
}

export function ensureTerminalNamespaceBucket(name) {
  const terminal = ensureTerminalRoot();
  const key = String(name || '').trim();
  if (!terminal || !key) return null;
  if (!terminal[key] || typeof terminal[key] !== 'object') terminal[key] = {};
  return terminal[key];
}

function getTerminalCompatBucket(name) {
  const terminal = getXkeenTerminalRoot() || ensureTerminalRoot();
  const key = String(name || '').trim();
  if (!terminal || !key) return null;
  const bucket = terminal[key];
  return bucket && typeof bucket === 'object' ? bucket : null;
}

function publishTerminalBucketCompatApi(rootName, apiName, api) {
  const bucket = ensureTerminalNamespaceBucket(rootName);
  const key = String(apiName || '').trim();
  if (!bucket || !key) return api || null;
  bucket[key] = api || null;
  return bucket[key];
}

function getTerminalBucketCompatApi(rootName, apiName) {
  const bucket = getTerminalCompatBucket(rootName);
  const key = String(apiName || '').trim();
  if (!bucket || !key) return null;
  return bucket[key] || null;
}

export function ensureTerminalCoreRoot() {
  return ensureTerminalNamespaceBucket('core');
}

export function ensureTerminalTransportRoot() {
  return ensureTerminalNamespaceBucket('transport');
}

export function ensureTerminalCommandsRoot() {
  return ensureTerminalNamespaceBucket('commands');
}

export function ensureTerminalCommandBuiltinsRoot() {
  const commands = ensureTerminalCommandsRoot();
  if (!commands) return null;
  if (!commands.builtins || typeof commands.builtins !== 'object') commands.builtins = {};
  return commands.builtins;
}

export function getTerminalCompatApi(name) {
  const terminal = getXkeenTerminalRoot() || ensureTerminalRoot();
  const key = String(name || '').trim();
  if (!terminal || !key) return null;
  return terminal[key] || null;
}

export function publishTerminalCompatApi(name, api) {
  const terminal = ensureTerminalRoot();
  const key = String(name || '').trim();
  if (!terminal || !key) return api || null;
  terminal[key] = api || null;
  return terminal[key];
}

export function getTerminalCoreCompatApi(name) {
  return getTerminalBucketCompatApi('core', name);
}

export function publishTerminalCoreCompatApi(name, api) {
  return publishTerminalBucketCompatApi('core', name, api);
}

export function getTerminalTransportCompatApi(name) {
  return getTerminalBucketCompatApi('transport', name);
}

export function publishTerminalTransportCompatApi(name, api) {
  return publishTerminalBucketCompatApi('transport', name, api);
}

export function getTerminalCommandsCompatApi(name) {
  return getTerminalBucketCompatApi('commands', name);
}

export function publishTerminalCommandsCompatApi(name, api) {
  return publishTerminalBucketCompatApi('commands', name, api);
}

export function getTerminalBuiltinCommandCompatApi(name) {
  const builtins = ensureTerminalCommandBuiltinsRoot();
  const key = String(name || '').trim();
  if (!builtins || !key) return null;
  return builtins[key] || null;
}

export function publishTerminalBuiltinCommandCompatApi(name, api) {
  const builtins = ensureTerminalCommandBuiltinsRoot();
  const key = String(name || '').trim();
  if (!builtins || !key) return api || null;
  builtins[key] = api || null;
  return builtins[key];
}

export function publishXkeenCompatValue(name, value) {
  const xk = ensureWindowXKeen();
  const key = String(name || '').trim();
  if (!xk || !key) return value;
  xk[key] = value;
  return xk[key];
}

export function publishWindowCompatFunction(name, fn) {
  const win = getWindowRef();
  const key = String(name || '').trim();
  if (!win || !key || typeof fn !== 'function') return null;
  if (typeof win[key] !== 'function') win[key] = fn;
  return win[key];
}

export function computeTerminalTabId() {
  try {
    const util = getXkeenUtilApi();
    if (util && typeof util.getTabId === 'function') return util.getTabId();
  } catch (error) {}
  return 'xkeen_tab_id_v1:' + (String(Math.random()).slice(2) + '-' + String(Date.now()));
}

export function getTerminalContext() {
  return getXkeenTerminalCoreContext();
}

export function getTerminalCoreApi() {
  try {
    const compat = getTerminalCompatApi('_core');
    if (compat) return compat;
  } catch (error) {}
  try {
    const terminal = getXkeenTerminalRoot() || ensureTerminalRoot();
    if (!terminal) return null;
    return terminal._core || terminal.core || null;
  } catch (error2) {
    return null;
  }
}

export function getTerminalCoreState() {
  try {
    const core = getTerminalCoreApi();
    if (core && core.state && typeof core.state === 'object') return core.state;
  } catch (error) {}
  return ensureTerminalCompatState();
}

export function getTerminalOverlayController() {
  try {
    const ctx = getTerminalContext();
    const controller = ctx ? (ctx.overlay || ctx.overlayCtrl) : null;
    if (controller) return controller;
  } catch (error) {}
  return getTerminalCompatApi('overlay');
}

let terminalByIdLookupDepth = 0;

export function getTerminalById(id, fallback) {
  const key = String(id || '').trim();
  if (!key) return null;

  try {
    if (typeof fallback === 'function') {
      const el = fallback(key);
      if (el) return el;
    }
  } catch (error) {}

  try {
    const direct = document.getElementById(key);
    if (direct) return direct;
  } catch (error2) {}

  // Guard against recursive lookups:
  // ctx.ui.byId -> getTerminalById -> ctx.ui.byId -> ...
  if (terminalByIdLookupDepth > 0) return null;

  terminalByIdLookupDepth += 1;
  try {
    const ctx = getTerminalContext();
    const byId = (ctx && ctx.ui && typeof ctx.ui.byId === 'function') ? ctx.ui.byId : null;
    if (byId) {
      const el = byId(key);
      if (el) return el;
    }
  } catch (error3) {}
  finally {
    terminalByIdLookupDepth = Math.max(0, terminalByIdLookupDepth - 1);
  }

  return null;
}

export function getTerminalMode(ctx) {
  const current = ctx || getTerminalContext();
  try {
    if (current && current.session && typeof current.session.getMode === 'function') {
      return current.session.getMode() || 'shell';
    }
  } catch (error) {}
  try {
    if (current && current.core && typeof current.core.getMode === 'function') {
      return current.core.getMode() || 'shell';
    }
  } catch (error2) {}
  try {
    if (current && current.state && current.state.mode) return String(current.state.mode || 'shell');
  } catch (error3) {}
  try {
    const core = getTerminalCoreApi();
    if (core && typeof core.getMode === 'function') return core.getMode() || 'shell';
  } catch (error4) {}
  return 'shell';
}

export function getTerminalUiActionsApi() {
  try {
    const terminal = getXkeenTerminalRoot() || ensureTerminalRoot();
    return terminal ? (terminal.ui_actions || null) : null;
  } catch (error) {
    return null;
  }
}

export function getTerminalPublicApi() {
  try {
    const terminal = getXkeenTerminalRoot() || ensureTerminalRoot();
    return terminal ? (terminal.api || null) : null;
  } catch (error) {
    return null;
  }
}

export function getTerminalHistoryApi() {
  return getTerminalCompatApi('history');
}

export function getTerminalSearchApi() {
  return getTerminalCompatApi('search');
}

export function getTerminalChromeApi() {
  return getTerminalCompatApi('chrome');
}

export function getTerminalOverlayApi() {
  return getTerminalCompatApi('overlay');
}

export function getTerminalReconnectApi() {
  return getTerminalCompatApi('reconnect');
}

export function getTerminalStatusApi() {
  return getTerminalCompatApi('status');
}

export function getTerminalXtermManagerApi() {
  return getTerminalCompatApi('xterm_manager');
}

export function getTerminalExecCommand() {
  try {
    const terminal = getXkeenTerminalRoot() || ensureTerminalRoot();
    if (terminal && typeof terminal.execCommand === 'function') {
      return terminal.execCommand.bind(terminal);
    }
  } catch (error) {}
  return null;
}

export function focusTerminalView() {
  return focusXkeenTerminal();
}

export function isTerminalPtyConnected() {
  return isXkeenTerminalPtyConnected();
}

export function openTerminalCompat(options) {
  const opts = (options && typeof options === 'object') ? Object.assign({}, options) : {};
  return openXkeenTerminal(opts);
}

export function setTerminalCapabilityState(hasWs, hasPty, shellPolicy) {
  const state = ensureGlobalStateRoot();
  if (!state) return null;
  state.hasWs = !!hasWs;
  state.hasPty = !!hasPty;
  if (arguments.length >= 3) {
    const policy = shellPolicy && typeof shellPolicy === 'object' ? Object.assign({}, shellPolicy) : null;
    state.hasShell = !!(policy && policy.enabled);
    state.shellPolicy = policy;
  }
  return state;
}

export function setTerminalGlobalTabId(tabId) {
  const state = ensureGlobalStateRoot();
  if (state) state.tabId = tabId;
  return tabId;
}

export function ansiToTerminalHtml(text) {
  return ansiToXkeenHtml(text);
}

export function escapeTerminalHtml(text) {
  return escapeXkeenHtml(text);
}

export function toastTerminal(message, kindOrOptions) {
  return toastXkeen(message, kindOrOptions);
}

export function syncTerminalBodyScrollLock(fallbackLocked) {
  return syncXkeenBodyScrollLock(fallbackLocked);
}

export function openTerminalModal(modal, source, fallbackLocked) {
  return openXkeenModal(modal, source || 'terminal_runtime', fallbackLocked);
}

export function closeTerminalModal(modal, source, fallbackLocked) {
  return closeXkeenModal(modal, source || 'terminal_runtime', fallbackLocked);
}

export function getTerminalCommandJobApi() {
  return getXkeenCommandJobApi();
}

export function getTerminalCoreHttpApi() {
  return getXkeenCoreHttpApi();
}

export function getTerminalCapabilitiesApi() {
  return getXkeenTerminalCapabilitiesApi();
}

export function getTerminalPtyApi() {
  return getXkeenTerminalPtyApi();
}

export function getTerminalModalApi() {
  return getXkeenModalApi();
}

export function getTerminalSharedStateApi() {
  return getXkeenStateApi();
}
