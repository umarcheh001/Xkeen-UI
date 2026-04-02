function getWindowRef() {
  try {
    return window || null;
  } catch (e) {
    return null;
  }
}

function getWindowXKeen() {
  try {
    const win = getWindowRef();
    return win && win.XKeen ? win.XKeen : null;
  } catch (e) {
    return null;
  }
}

export function ensureXkeenRoot() {
  try {
    const win = getWindowRef();
    if (!win) return null;
    if (!win.XKeen || typeof win.XKeen !== 'object') win.XKeen = {};
    return win.XKeen;
  } catch (e) {
    return null;
  }
}

export function ensureXkeenUiRoot() {
  try {
    const xk = ensureXkeenRoot();
    if (!xk) return null;
    if (!xk.ui || typeof xk.ui !== 'object') xk.ui = {};
    return xk.ui;
  } catch (e) {
    return null;
  }
}

export function ensureXkeenUiBucket(name) {
  try {
    const ui = ensureXkeenUiRoot();
    const key = String(name || '').trim();
    if (!ui || !key) return null;
    if (!ui[key] || typeof ui[key] !== 'object') ui[key] = {};
    return ui[key];
  } catch (e) {
    return null;
  }
}

export function ensureXkeenPagesRoot() {
  try {
    const xk = ensureXkeenRoot();
    if (!xk) return null;
    if (!xk.pages || typeof xk.pages !== 'object') xk.pages = {};
    return xk.pages;
  } catch (e) {
    return null;
  }
}

export function getXkeenUiApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.ui || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenMonacoLoaderApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.monacoLoader || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenCoreApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.core || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenPagesApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.pages || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenUtilApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.util || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenStateApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.state || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenStateValue(name, fallbackValue = null) {
  const key = String(name || '').trim();
  if (!key) return fallbackValue;
  try {
    const state = getXkeenStateApi();
    if (state && Object.prototype.hasOwnProperty.call(state, key)) {
      return state[key];
    }
  } catch (e) {}
  try {
    const win = getWindowRef();
    if (win && Object.prototype.hasOwnProperty.call(win, key)) return win[key];
  } catch (e2) {}
  return fallbackValue;
}

export function getXkeenPageApi(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  try {
    const pages = getXkeenPagesApi();
    return pages ? (pages[key] || null) : null;
  } catch (e) {
    return null;
  }
}

export function publishXkeenPageApi(name, api) {
  const key = String(name || '').trim();
  if (!key) return api || null;
  try {
    const pages = ensureXkeenPagesRoot();
    if (!pages) return api || null;
    pages[key] = api || null;
    return pages[key];
  } catch (e) {
    return api || null;
  }
}

export function getXkeenWindowFlag(name, fallbackValue = undefined) {
  const key = String(name || '').trim();
  if (!key) return fallbackValue;
  try {
    const win = getWindowRef();
    if (!win || !(key in win)) return fallbackValue;
    return win[key];
  } catch (e) {
    return fallbackValue;
  }
}

export function getXkeenBooleanFlag(name, fallbackValue = false) {
  const value = getXkeenWindowFlag(name, fallbackValue);
  if (typeof value === 'boolean') return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!normalized) return !!fallbackValue;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function hasXkeenXrayCore() {
  return getXkeenBooleanFlag('XKEEN_HAS_XRAY', true);
}

export function getXkeenGithubRepoUrl() {
  return String(getXkeenWindowFlag('XKEEN_GITHUB_REPO_URL', '') || '');
}

export function getXkeenLazyRuntimeApi() {
  try {
    const xk = getWindowXKeen();
    return xk && xk.runtime ? (xk.runtime.lazy || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenModalApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.modal || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenSettingsApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.settings || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenSharedPrimitivesApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.sharedPrimitives || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenEditorActionsApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.editorActions || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenEditorLinksApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.editorLinks || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenMonacoSharedApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.monacoShared || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenDatContentsApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.datContents || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenConfigDirtyApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.configDirty || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenUiShellApi() {
  try {
    const core = getXkeenCoreApi();
    const api = core ? (core.uiShell || null) : null;
    if (api && typeof api.getState === 'function' && typeof api.patchState === 'function') return api;
  } catch (e) {}
  return null;
}

export function getXkeenUiConfigShellApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.configShell || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenPageConfigShellApi() {
  try {
    const pages = getXkeenPagesApi();
    return pages ? (pages.configShell || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenEditorEngineApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.editorEngine || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenFormattersApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.formatters || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenCm6RuntimeApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.cm6Runtime || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenJsonEditorApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.jsonEditor || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenPanelShellApi() {
  try {
    const pages = getXkeenPagesApi();
    if (pages && pages.panelShell) return pages.panelShell;
  } catch (e) {}
  try {
    const ui = getXkeenUiApi();
    if (ui && ui.tabs) return ui.tabs;
  } catch (e2) {}
  return null;
}

export function getXkeenCoreHttpApi() {
  try {
    const core = getXkeenCoreApi();
    return core ? (core.http || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenCoreStorageApi() {
  try {
    const core = getXkeenCoreApi();
    return core ? (core.storage || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenCommandJobApi() {
  try {
    const util = getXkeenUtilApi();
    return util ? (util.commandJob || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenShowXrayPreflightErrorApi() {
  try {
    const ui = getXkeenUiApi();
    return ui && typeof ui.showXrayPreflightError === 'function' ? ui.showXrayPreflightError : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenTerminalRoot() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.terminal || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenTerminalApi() {
  try {
    const terminal = getXkeenTerminalRoot();
    return terminal ? (terminal.api || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenTerminalCoreContext() {
  try {
    const terminal = getXkeenTerminalRoot();
    if (terminal && terminal.core && typeof terminal.core.getCtx === 'function') {
      return terminal.core.getCtx() || null;
    }
  } catch (e) {}
  return null;
}

export function getXkeenTerminalPtyApi() {
  try {
    const terminal = getXkeenTerminalRoot();
    return terminal ? (terminal.pty || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenTerminalChromeApi() {
  try {
    const terminal = getXkeenTerminalRoot();
    return terminal ? (terminal.chrome || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenTerminalCapabilitiesApi() {
  try {
    const terminal = getXkeenTerminalRoot();
    return terminal ? (terminal.capabilities || null) : null;
  } catch (e) {
    return null;
  }
}

export function hasXkeenTerminalApi() {
  try {
    const api = getXkeenTerminalApi();
    if (api && typeof api.open === 'function') return true;
  } catch (e) {}
  try {
    const terminal = getXkeenTerminalRoot();
    return !!(terminal && typeof terminal.open === 'function');
  } catch (e2) {
    return false;
  }
}

export function hasXkeenTerminalPtyCapability() {
  try {
    const caps = getXkeenTerminalCapabilitiesApi();
    return !!(caps && typeof caps.hasPty === 'function' && caps.hasPty());
  } catch (e) {
    return false;
  }
}

export function isXkeenTerminalPtyConnected() {
  try {
    const ctx = getXkeenTerminalCoreContext();
    if (ctx && ctx.transport && ctx.transport.kind === 'pty' && typeof ctx.transport.isConnected === 'function') {
      return !!ctx.transport.isConnected();
    }
    const state = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
    const ws = state ? state.ptyWs : null;
    return !!(ws && ws.readyState === WebSocket.OPEN);
  } catch (e) {
    return false;
  }
}

export function focusXkeenTerminal() {
  try {
    const ctx = getXkeenTerminalCoreContext();
    const state = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
    const term = state ? (state.term || state.xterm) : null;
    if (term && typeof term.focus === 'function') {
      term.focus();
      return true;
    }
  } catch (e) {}
  return false;
}

export function ensureXkeenTerminalInViewport() {
  try {
    const chromeApi = getXkeenTerminalChromeApi();
    if (chromeApi && typeof chromeApi.ensureInViewport === 'function') {
      chromeApi.ensureInViewport();
      return true;
    }
    if (chromeApi && typeof chromeApi.onOpen === 'function') {
      chromeApi.onOpen();
      return true;
    }
  } catch (e) {}
  return false;
}

export function openXkeenTerminal(options) {
  const opts = (options && typeof options === 'object') ? Object.assign({}, options) : {};
  const mode = String(opts.mode || '');
  const cmd = String(opts.cmd || '');

  try {
    const api = getXkeenTerminalApi();
    if (api && typeof api.open === 'function') return api.open(opts);
  } catch (e) {}

  try {
    const terminal = getXkeenTerminalRoot();
    if (terminal && typeof terminal.open === 'function') return terminal.open(null, opts);
  } catch (e2) {}

  try {
    const win = getWindowRef();
    if (win && typeof win.openTerminal === 'function') return win.openTerminal(cmd, mode);
  } catch (e3) {}

  return null;
}

export function sendXkeenTerminal(payload, options) {
  const data = String(payload == null ? '' : payload);
  const opts = (options && typeof options === 'object') ? Object.assign({}, options) : {};

  try {
    const ctx = getXkeenTerminalCoreContext();
    if (ctx && ctx.transport && typeof ctx.transport.send === 'function' && ctx.transport.kind === 'pty') {
      return ctx.transport.send(data, opts);
    }
  } catch (e) {}

  try {
    const api = getXkeenTerminalApi();
    if (api && typeof api.send === 'function') return api.send(data, opts);
  } catch (e2) {}

  try {
    const pty = getXkeenTerminalPtyApi();
    if (pty && typeof pty.sendRaw === 'function') return pty.sendRaw(data);
  } catch (e3) {}

  return null;
}

export function openXkeenJsonEditor(target, options) {
  const mode = String(target || '').trim();
  if (!mode) return null;

  try {
    const api = getXkeenJsonEditorApi();
    if (api && typeof api.open === 'function') return api.open(mode, options);
  } catch (e) {}

  return null;
}

export function toastXkeen(message, kindOrOptions) {
  try {
    const win = getWindowRef();
    if (win && typeof win.toast === 'function') return win.toast(message, kindOrOptions);
  } catch (e) {}
  try {
    const ui = getXkeenUiApi();
    if (ui && typeof ui.toast === 'function') return ui.toast(message, kindOrOptions);
    if (ui && typeof ui.showToast === 'function') return ui.showToast(message, kindOrOptions);
  } catch (e2) {}
  try {
    const win = getWindowRef();
    if (win && typeof win.showToast === 'function') return win.showToast(message, kindOrOptions);
  } catch (e3) {}
  return null;
}

export function dismissXkeenToast(id) {
  try {
    const win = getWindowRef();
    if (win && typeof win.toast === 'function' && typeof win.toast.dismiss === 'function') {
      win.toast.dismiss(id);
      return true;
    }
  } catch (e) {}
  try {
    const ui = getXkeenUiApi();
    if (ui && typeof ui.dismissToast === 'function') {
      ui.dismissToast(id);
      return true;
    }
  } catch (e2) {}
  return false;
}

export function ansiToXkeenHtml(text) {
  try {
    const util = getXkeenUtilApi();
    if (util && typeof util.ansiToHtml === 'function') return util.ansiToHtml(text || '');
  } catch (e) {}
  return escapeXkeenHtml(text || '');
}

function buildConfirmText(opts, fallbackText) {
  const cfg = (opts && typeof opts === 'object') ? opts : {};
  const base = String(fallbackText || cfg.message || cfg.text || cfg.body || cfg.title || 'Continue?').trim() || 'Continue?';
  const details = Array.isArray(cfg.details)
    ? cfg.details.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
    : String(cfg.details || '').trim();
  return details ? (base + '\n\n' + details) : base;
}

export async function confirmXkeenAction(opts, fallbackText) {
  const cfg = (opts && typeof opts === 'object') ? opts : {};
  try {
    const ui = getXkeenUiApi();
    if (ui && typeof ui.confirm === 'function') return !!(await ui.confirm(cfg));
  } catch (e) {}
  try {
    return !!window.confirm(buildConfirmText(cfg, fallbackText));
  } catch (e2) {
    return false;
  }
}

export function syncXkeenBodyScrollLock(fallbackLocked) {
  try {
    const modalApi = getXkeenModalApi();
    if (modalApi && typeof modalApi.syncBodyScrollLock === 'function') {
      modalApi.syncBodyScrollLock();
      return true;
    }
  } catch (e) {}
  try {
    if (typeof fallbackLocked === 'boolean') {
      document.body.classList.toggle('modal-open', !!fallbackLocked);
      return true;
    }
  } catch (e2) {}
  return false;
}

export function openXkeenModal(modal, source, fallbackLocked) {
  if (!modal) return false;
  try {
    const modalApi = getXkeenModalApi();
    if (modalApi && typeof modalApi.open === 'function') {
      modalApi.open(modal, { source: source || 'xkeen_runtime' });
      return true;
    }
  } catch (e) {}
  try { modal.classList.remove('hidden'); } catch (e2) {}
  syncXkeenBodyScrollLock(typeof fallbackLocked === 'boolean' ? fallbackLocked : true);
  return true;
}

export function closeXkeenModal(modal, source, fallbackLocked) {
  if (!modal) return false;
  try {
    const modalApi = getXkeenModalApi();
    if (modalApi && typeof modalApi.close === 'function') {
      modalApi.close(modal, { source: source || 'xkeen_runtime' });
      return true;
    }
  } catch (e) {}
  try { modal.classList.add('hidden'); } catch (e2) {}
  syncXkeenBodyScrollLock(typeof fallbackLocked === 'boolean' ? fallbackLocked : false);
  return true;
}

export function escapeXkeenHtml(str) {
  try {
    const util = getXkeenUtilApi();
    if (util && typeof util.escapeHtml === 'function') return util.escapeHtml(str);
  } catch (e) {}
  try {
    const win = getWindowRef();
    if (win && typeof win.escapeHtml === 'function') return win.escapeHtml(str);
  } catch (e2) {}
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const xkeenRuntimeApi = Object.freeze({
  getUiApi: getXkeenUiApi,
  getMonacoLoaderApi: getXkeenMonacoLoaderApi,
  getCoreApi: getXkeenCoreApi,
  getPagesApi: getXkeenPagesApi,
  getUtilApi: getXkeenUtilApi,
  getStateApi: getXkeenStateApi,
  getLazyRuntimeApi: getXkeenLazyRuntimeApi,
  getModalApi: getXkeenModalApi,
  getSettingsApi: getXkeenSettingsApi,
  getSharedPrimitivesApi: getXkeenSharedPrimitivesApi,
  getEditorActionsApi: getXkeenEditorActionsApi,
  getEditorLinksApi: getXkeenEditorLinksApi,
  getMonacoSharedApi: getXkeenMonacoSharedApi,
  getDatContentsApi: getXkeenDatContentsApi,
  getConfigDirtyApi: getXkeenConfigDirtyApi,
  getUiShellApi: getXkeenUiShellApi,
  getUiConfigShellApi: getXkeenUiConfigShellApi,
  getPageConfigShellApi: getXkeenPageConfigShellApi,
  getEditorEngineApi: getXkeenEditorEngineApi,
  getFormattersApi: getXkeenFormattersApi,
  getCm6RuntimeApi: getXkeenCm6RuntimeApi,
  getJsonEditorApi: getXkeenJsonEditorApi,
  getPanelShellApi: getXkeenPanelShellApi,
  getCoreHttpApi: getXkeenCoreHttpApi,
  getCoreStorageApi: getXkeenCoreStorageApi,
  getCommandJobApi: getXkeenCommandJobApi,
  getShowXrayPreflightErrorApi: getXkeenShowXrayPreflightErrorApi,
  getTerminalRoot: getXkeenTerminalRoot,
  getTerminalApi: getXkeenTerminalApi,
  getTerminalCoreContext: getXkeenTerminalCoreContext,
  getTerminalPtyApi: getXkeenTerminalPtyApi,
  getTerminalChromeApi: getXkeenTerminalChromeApi,
  getTerminalCapabilitiesApi: getXkeenTerminalCapabilitiesApi,
  hasTerminalApi: hasXkeenTerminalApi,
  hasTerminalPtyCapability: hasXkeenTerminalPtyCapability,
  isTerminalPtyConnected: isXkeenTerminalPtyConnected,
  focusTerminal: focusXkeenTerminal,
  ensureTerminalInViewport: ensureXkeenTerminalInViewport,
  openTerminal: openXkeenTerminal,
  sendTerminal: sendXkeenTerminal,
  openJsonEditor: openXkeenJsonEditor,
  toast: toastXkeen,
  dismissToast: dismissXkeenToast,
  ansiToHtml: ansiToXkeenHtml,
  confirm: confirmXkeenAction,
  syncBodyScrollLock: syncXkeenBodyScrollLock,
  openModal: openXkeenModal,
  closeModal: closeXkeenModal,
  escapeHtml: escapeXkeenHtml,
});
