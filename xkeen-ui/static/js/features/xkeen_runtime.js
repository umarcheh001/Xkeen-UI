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

function getXkeenRawPageConfig() {
  try {
    const xk = getWindowXKeen();
    return xk && xk.pageConfig && typeof xk.pageConfig === 'object' ? xk.pageConfig : null;
  } catch (e) {
    return null;
  }
}

function getObjectPathValue(source, path) {
  const root = source && typeof source === 'object' ? source : null;
  const rawPath = Array.isArray(path)
    ? path.map((part) => String(part || '').trim()).filter(Boolean)
    : String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (!root || !rawPath.length) return undefined;

  let cursor = root;
  for (const part of rawPath) {
    if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function setObjectPathValue(source, path, value) {
  const root = source && typeof source === 'object' ? source : null;
  const rawPath = Array.isArray(path)
    ? path.map((part) => String(part || '').trim()).filter(Boolean)
    : String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  if (!root || !rawPath.length) return false;

  let cursor = root;
  for (let index = 0; index < rawPath.length - 1; index += 1) {
    const part = rawPath[index];
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }

  cursor[rawPath[rawPath.length - 1]] = value;
  return true;
}

function coerceXkeenBooleanValue(value, fallbackValue = false) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!normalized) return !!fallbackValue;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function getXkeenPageConfigValue(path, fallbackValue = undefined) {
  const key = String(path || '').trim();
  if (!key) {
    const rawPageConfig = getXkeenRawPageConfig();
    return rawPageConfig == null ? fallbackValue : rawPageConfig;
  }

  const rawPageConfig = getXkeenRawPageConfig();
  const rawValue = getObjectPathValue(rawPageConfig, key);
  return rawValue === undefined ? fallbackValue : rawValue;
}

export function getXkeenPageName() {
  const value = getXkeenPageConfigValue('page', '');
  return typeof value === 'string' ? value : String(value || '');
}

export function getXkeenPageSectionsConfig() {
  return {
    panelWhitelist: getXkeenPageConfigValue('sections.panelWhitelist', null),
    devtoolsWhitelist: getXkeenPageConfigValue('sections.devtoolsWhitelist', null),
  };
}

export function getXkeenPageFilesConfig() {
  return {
    routing: String(getXkeenPageConfigValue('files.routing', '') || ''),
    inbounds: String(getXkeenPageConfigValue('files.inbounds', '') || ''),
    outbounds: String(getXkeenPageConfigValue('files.outbounds', '') || ''),
    mihomo: String(getXkeenPageConfigValue('files.mihomo', '') || ''),
  };
}

export function getXkeenPageFlagsConfig() {
  return {
    hasXray: coerceXkeenBooleanValue(getXkeenPageConfigValue('flags.hasXray', true), true),
    hasMihomo: coerceXkeenBooleanValue(getXkeenPageConfigValue('flags.hasMihomo', false), false),
    isMips: coerceXkeenBooleanValue(getXkeenPageConfigValue('flags.isMips', false), false),
    multiCore: coerceXkeenBooleanValue(getXkeenPageConfigValue('flags.multiCore', false), false),
    mihomoConfigExists: coerceXkeenBooleanValue(getXkeenPageConfigValue('flags.mihomoConfigExists', false), false),
  };
}

export function getXkeenPageCoresConfig() {
  const available = getXkeenPageConfigValue('cores.available', []);
  const detected = getXkeenPageConfigValue('cores.detected', []);
  return {
    available: Array.isArray(available) ? available : [],
    detected: Array.isArray(detected) ? detected : [],
    uiFallback: coerceXkeenBooleanValue(getXkeenPageConfigValue('cores.uiFallback', false), false),
  };
}

export function getXkeenFileManagerDefaults() {
  return {
    rightDefault: String(getXkeenPageConfigValue('fileManager.rightDefault', '') || ''),
  };
}

export function getXkeenGithubConfig() {
  return {
    repoUrl: String(getXkeenPageConfigValue('github.repoUrl', '') || ''),
  };
}

export function getXkeenStaticConfig() {
  return {
    base: String(getXkeenPageConfigValue('static.base', '') || ''),
    version: String(getXkeenPageConfigValue('static.version', '') || ''),
  };
}

export function getXkeenRuntimeConfig() {
  return {
    debug: coerceXkeenBooleanValue(getXkeenPageConfigValue('runtime.debug', false), false),
  };
}

export function getXkeenTerminalConfig() {
  return {
    supportsPty: coerceXkeenBooleanValue(getXkeenPageConfigValue('terminal.supportsPty', false), false),
    enableOptionalAddons: coerceXkeenBooleanValue(getXkeenPageConfigValue('terminal.enableOptionalAddons', false), false),
    enableLigatures: coerceXkeenBooleanValue(getXkeenPageConfigValue('terminal.enableLigatures', false), false),
    enableWebgl: coerceXkeenBooleanValue(getXkeenPageConfigValue('terminal.enableWebgl', true), true),
  };
}

export function supportsXkeenTerminalPty() {
  return !!getXkeenTerminalConfig().supportsPty;
}

export function shouldEnableXkeenTerminalOptionalAddons() {
  return !!getXkeenTerminalConfig().enableOptionalAddons;
}

export function shouldEnableXkeenTerminalLigatures() {
  return !!getXkeenTerminalConfig().enableLigatures;
}

export function shouldEnableXkeenTerminalWebgl() {
  return !!getXkeenTerminalConfig().enableWebgl;
}



export function getXkeenPageConfig() {
  const rawPageConfig = getXkeenRawPageConfig();
  if (rawPageConfig && typeof rawPageConfig === 'object') return rawPageConfig;
  return {
    contractVersion: 1,
    page: getXkeenPageName(),
    sections: getXkeenPageSectionsConfig(),
    flags: getXkeenPageFlagsConfig(),
    cores: getXkeenPageCoresConfig(),
    files: getXkeenPageFilesConfig(),
    fileManager: getXkeenFileManagerDefaults(),
    github: getXkeenGithubConfig(),
    static: getXkeenStaticConfig(),
    runtime: getXkeenRuntimeConfig(),
    terminal: getXkeenTerminalConfig(),
  };
}

export function setXkeenPageConfigValue(path, value) {
  const key = String(path || '').trim();
  if (!key) return false;

  try {
    const xk = ensureXkeenRoot();
    if (!xk) return false;
    if (!xk.pageConfig || typeof xk.pageConfig !== 'object') {
      xk.pageConfig = getXkeenPageConfig();
    }
    if (!setObjectPathValue(xk.pageConfig, key, value)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

export function hasXkeenMihomoCore() {
  return !!getXkeenPageFlagsConfig().hasMihomo;
}

export function isXkeenMipsRuntime() {
  return !!getXkeenPageFlagsConfig().isMips;
}

export function getXkeenStaticBase() {
  return String(getXkeenStaticConfig().base || '');
}

export function getXkeenStaticVersion() {
  return String(getXkeenStaticConfig().version || '');
}

export function getXkeenFilePath(name, fallbackValue = '') {
  const key = String(name || '').trim();
  if (!key) return fallbackValue;
  const files = getXkeenPageFilesConfig();
  if (!Object.prototype.hasOwnProperty.call(files, key)) return fallbackValue;
  return String(files[key] || fallbackValue || '');
}

export function getXkeenCoreAvailability() {
  const cores = getXkeenPageCoresConfig();
  return Array.isArray(cores.available) ? cores.available : [];
}

export function hasXkeenXrayCore() {
  return !!getXkeenPageFlagsConfig().hasXray;
}

export function getXkeenGithubRepoUrl() {
  return String(getXkeenGithubConfig().repoUrl || '');
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

export function getXkeenDiffApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.diff || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenEditorToolbarApi() {
  try {
    const ui = getXkeenUiApi();
    return ui ? (ui.editorToolbar || null) : null;
  } catch (e) {
    return null;
  }
}

export function getXkeenEditorToolbarIcons() {
  try {
    const toolbar = getXkeenEditorToolbarApi();
    const icons = toolbar && toolbar.icons && typeof toolbar.icons === 'object' ? toolbar.icons : null;
    return icons ? Object.assign({}, icons) : {};
  } catch (e) {
    return {};
  }
}

export function getXkeenEditorToolbarDefaultItems() {
  try {
    const toolbar = getXkeenEditorToolbarApi();
    const items = toolbar && Array.isArray(toolbar.defaultItems) ? toolbar.defaultItems : null;
    return items ? items.slice() : [];
  } catch (e) {
    return [];
  }
}

export function getXkeenEditorToolbarMiniItems() {
  try {
    const toolbar = getXkeenEditorToolbarApi();
    const items = toolbar && Array.isArray(toolbar.miniItems) ? toolbar.miniItems : null;
    return items ? items.slice() : [];
  } catch (e) {
    return [];
  }
}

export function buildXkeenEditorCommonKeys(options) {
  const opts = options && typeof options === 'object' ? options : {};
  try {
    const toolbar = getXkeenEditorToolbarApi();
    if (toolbar && typeof toolbar.buildCommonKeys === 'function') {
      return toolbar.buildCommonKeys(opts) || {};
    }
  } catch (e) {}
  try {
    const editorActions = getXkeenEditorActionsApi();
    if (editorActions && typeof editorActions.buildCommonKeys === 'function') {
      return editorActions.buildCommonKeys(opts) || {};
    }
  } catch (e2) {}
  try {
    const win = getWindowRef();
    if (win && typeof win.buildCmExtraKeysCommon === 'function') {
      return win.buildCmExtraKeysCommon(opts) || {};
    }
  } catch (e3) {}
  return {};
}

export function attachXkeenEditorToolbar(editor, items, options) {
  if (!editor) return null;
  try {
    const toolbar = getXkeenEditorToolbarApi();
    if (toolbar && typeof toolbar.attach === 'function') {
      return toolbar.attach(editor, items, options);
    }
  } catch (e) {}
  try {
    const win = getWindowRef();
    if (win && typeof win.xkeenAttachCmToolbar === 'function') {
      return win.xkeenAttachCmToolbar(editor, items, options);
    }
  } catch (e2) {}
  return null;
}

export function isXkeenDebugRuntime() {
  return !!getXkeenRuntimeConfig().debug;
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
    if (!terminal) return null;

    let api = terminal.api || null;
    if ((!api || api.__xkLazyStubInstalled) && terminal.core && typeof terminal.core.createPublicApi === 'function') {
      try {
        api = terminal.core.createPublicApi() || null;
        terminal.api = api;
      } catch (error) {}
    }
    return api || null;
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
    if (terminal && typeof terminal.init === 'function') {
      try { terminal.init(); } catch (error) {}
    }
    if (terminal && typeof terminal.open === 'function') return terminal.open(null, opts);

    if (terminal && terminal.core && typeof terminal.core.createPublicApi === 'function') {
      try {
        const api = terminal.core.createPublicApi();
        if (api && typeof api.open === 'function') {
          terminal.api = api;
          return api.open(opts);
        }
      } catch (error) {}
    }
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
  getPageConfig: getXkeenPageConfig,
  getPageConfigValue: getXkeenPageConfigValue,
  setPageConfigValue: setXkeenPageConfigValue,
  getPageName: getXkeenPageName,
  getPageSectionsConfig: getXkeenPageSectionsConfig,
  getPageFilesConfig: getXkeenPageFilesConfig,
  getPageFlagsConfig: getXkeenPageFlagsConfig,
  getPageCoresConfig: getXkeenPageCoresConfig,
  getFileManagerDefaults: getXkeenFileManagerDefaults,
  getGithubConfig: getXkeenGithubConfig,
  getStaticConfig: getXkeenStaticConfig,
  getRuntimeConfig: getXkeenRuntimeConfig,
  getTerminalConfig: getXkeenTerminalConfig,
  getStateApi: getXkeenStateApi,
  getLazyRuntimeApi: getXkeenLazyRuntimeApi,
  getModalApi: getXkeenModalApi,
  getSettingsApi: getXkeenSettingsApi,
  getSharedPrimitivesApi: getXkeenSharedPrimitivesApi,
  getEditorActionsApi: getXkeenEditorActionsApi,
  getDiffApi: getXkeenDiffApi,
  getEditorToolbarApi: getXkeenEditorToolbarApi,
  getEditorToolbarIcons: getXkeenEditorToolbarIcons,
  getEditorToolbarDefaultItems: getXkeenEditorToolbarDefaultItems,
  getEditorToolbarMiniItems: getXkeenEditorToolbarMiniItems,
  buildEditorCommonKeys: buildXkeenEditorCommonKeys,
  attachEditorToolbar: attachXkeenEditorToolbar,
  isDebugRuntime: isXkeenDebugRuntime,
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
  hasXrayCore: hasXkeenXrayCore,
  hasMihomoCore: hasXkeenMihomoCore,
  isMipsRuntime: isXkeenMipsRuntime,
  getGithubRepoUrl: getXkeenGithubRepoUrl,
  getStaticBase: getXkeenStaticBase,
  getStaticVersion: getXkeenStaticVersion,
  getFilePath: getXkeenFilePath,
  getCoreAvailability: getXkeenCoreAvailability,
  supportsTerminalPty: supportsXkeenTerminalPty,
  shouldEnableTerminalOptionalAddons: shouldEnableXkeenTerminalOptionalAddons,
  shouldEnableTerminalLigatures: shouldEnableXkeenTerminalLigatures,
  shouldEnableTerminalWebgl: shouldEnableXkeenTerminalWebgl,
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


try {
  const xk = ensureXkeenRoot();
  if (xk) {
    xk.runtime = xk.runtime && typeof xk.runtime === 'object' ? xk.runtime : {};
    Object.assign(xk.runtime, xkeenRuntimeApi);
  }
} catch (e) {}
