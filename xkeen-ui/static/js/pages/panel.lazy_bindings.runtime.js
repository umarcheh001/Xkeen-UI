import { getConfigShellApi, activateInboundsConfigView, activateOutboundsConfigView } from './config_shell.shared.js';
import {
  getXkeenCoreHttpApi,
  getXkeenGithubRepoUrl,
  getXkeenLazyRuntimeApi,
  getXkeenStateApi,
  getXkeenTerminalRoot,
  openXkeenTerminal,
  toastXkeen,
} from '../features/xkeen_runtime.js';
import { appendTerminalDebug } from '../features/terminal_debug.js';

function safe(fn) {
  try { return fn(); } catch (error) {
    try { console.error(error); } catch (e) {}
    return undefined;
  }
}

function getCoreHttp() {
  return getXkeenCoreHttpApi();
}

const panelFeatureModules = Object.create(null);
const panelFeatureModulePromises = Object.create(null);
const panelFeatureEnsurePromises = Object.create(null);
const panelFeatureReady = Object.create(null);

const panelFeatureSpecs = Object.freeze({
  restartLog: {
    load: () => import('../features/restart_log.js'),
    getApi: (mod) => (mod && typeof mod.getRestartLogApi === 'function') ? mod.getRestartLogApi() : null,
  },
  serviceStatus: {
    load: () => import('../features/service_status.js'),
    getApi: (mod) => (mod && typeof mod.getServiceStatusApi === 'function') ? mod.getServiceStatusApi() : null,
  },
  routingTemplates: {
    load: () => import('../features/routing_templates.js'),
    getApi: (mod) => (mod && typeof mod.getRoutingTemplatesApi === 'function') ? mod.getRoutingTemplatesApi() : null,
  },
  github: {
    load: () => import('../features/github.js').then(
      (mod) => import('../features/compat/github.js').then(() => mod)
    ),
    getApi: (mod) => (mod && typeof mod.getGithubApi === 'function') ? mod.getGithubApi() : null,
    init: (api) => {
      if (api && typeof api.init === 'function') {
        api.init({ repoUrl: getXkeenGithubRepoUrl() });
      }
    },
  },
  donate: {
    load: () => import('../features/donate.js'),
    getApi: (mod) => (mod && typeof mod.getDonateApi === 'function') ? mod.getDonateApi() : null,
  },
  uiSettingsPanel: {
    load: () => import('../ui/settings_panel.js'),
    getApi: (mod) => (mod && typeof mod.getUiSettingsPanelApi === 'function') ? mod.getUiSettingsPanelApi() : null,
  },
  mihomoImport: {
    load: () => import('../features/mihomo_import.js').then(
      (mod) => import('../features/compat/mihomo_import.js').then(() => mod)
    ),
    getApi: (mod) => (mod && typeof mod.getMihomoImportApi === 'function') ? mod.getMihomoImportApi() : null,
  },
  mihomoProxyTools: {
    load: () => import('../features/mihomo_import.js')
      .then(() => import('../features/compat/mihomo_import.js'))
      .then(() => import('../features/mihomo_proxy_tools.js'))
      .then((mod) => import('../features/compat/mihomo_proxy_tools.js').then(() => mod)),
    getApi: (mod) => (mod && typeof mod.getMihomoProxyToolsApi === 'function') ? mod.getMihomoProxyToolsApi() : null,
  },
  mihomoHwidSub: {
    load: () => import('../features/mihomo_hwid_sub.js').then(
      (mod) => import('../features/compat/mihomo_hwid_sub.js').then(() => mod)
    ),
    getApi: (mod) => (mod && typeof mod.getMihomoHwidSubApi === 'function') ? mod.getMihomoHwidSubApi() : null,
  },
  xkeenTexts: {
    load: () => import('../features/xkeen_texts.js'),
    getApi: (mod) => (mod && typeof mod.getXkeenTextsApi === 'function') ? mod.getXkeenTextsApi() : null,
  },
  commandsList: {
    load: () => import('../features/commands_list.js'),
    getApi: (mod) => (mod && typeof mod.getCommandsListApi === 'function') ? mod.getCommandsListApi() : null,
  },
  coresStatus: {
    load: () => import('../features/cores_status.js'),
    getApi: (mod) => (mod && typeof mod.getCoresStatusApi === 'function') ? mod.getCoresStatusApi() : null,
  },
});

function getPanelFeatureSpec(name) {
  const key = String(name || '');
  return key ? (panelFeatureSpecs[key] || null) : null;
}

function getPanelFeatureApiFromModule(name) {
  const key = String(name || '');
  if (!key) return null;
  try {
    const spec = getPanelFeatureSpec(key);
    const mod = panelFeatureModules[key] || null;
    if (!spec || !mod || typeof spec.getApi !== 'function') return null;
    return spec.getApi(mod) || null;
  } catch (error) {
    return null;
  }
}

function loadPanelFeatureModule(name) {
  const key = String(name || '');
  if (!key) return Promise.resolve(null);
  if (panelFeatureModules[key]) return Promise.resolve(panelFeatureModules[key]);
  if (panelFeatureModulePromises[key]) return panelFeatureModulePromises[key];

  const spec = getPanelFeatureSpec(key);
  if (!spec || typeof spec.load !== 'function') return Promise.resolve(null);

  panelFeatureModulePromises[key] = Promise.resolve()
    .then(() => spec.load())
    .then((mod) => {
      panelFeatureModules[key] = mod || null;
      return panelFeatureModules[key];
    })
    .catch((error) => {
      panelFeatureModules[key] = null;
      throw error;
    })
    .finally(() => {
      panelFeatureModulePromises[key] = null;
    });

  return panelFeatureModulePromises[key];
}

function initPanelFeature(name, api) {
  const key = String(name || '');
  const spec = getPanelFeatureSpec(key);
  const featureApi = api || getPanelFeatureApiFromModule(key);
  if (!spec || !featureApi) return;
  if (typeof spec.init === 'function') {
    spec.init(featureApi);
    return;
  }
  if (typeof featureApi.init === 'function') {
    featureApi.init();
  }
}

export function getPanelLazyRuntimeApi() {
  return getXkeenLazyRuntimeApi();
}

export function getPanelLazyFeatureApi(name) {
  const key = String(name || '');
  const localApi = getPanelFeatureApiFromModule(key);
  if (localApi) return localApi;
  const api = getPanelLazyRuntimeApi();
  return (api && typeof api.getFeatureApi === 'function')
    ? api.getFeatureApi(key)
    : null;
}

export function isPanelLazyFeatureStub(feature) {
  try {
    if (feature && feature.__xkLazyStubInstalled) return true;
  } catch (error) {}
  const api = getPanelLazyRuntimeApi();
  return !!(api && typeof api.isFeatureStub === 'function' && api.isFeatureStub(feature));
}

export function isPanelLazyFeatureReady(name) {
  const key = String(name || '');
  if (getPanelFeatureSpec(key)) return !!panelFeatureReady[key];
  const api = getPanelLazyRuntimeApi();
  return !!(api && typeof api.isFeatureReady === 'function' && api.isFeatureReady(key));
}

export function ensurePanelLazyFeature(name) {
  const key = String(name || '');
  const spec = getPanelFeatureSpec(key);
  if (spec) {
    if (panelFeatureReady[key]) return Promise.resolve(true);
    if (panelFeatureEnsurePromises[key]) return panelFeatureEnsurePromises[key];

    panelFeatureEnsurePromises[key] = Promise.resolve()
      .then(async () => {
        let featureApi = getPanelFeatureApiFromModule(key);
        if (!featureApi || isPanelLazyFeatureStub(featureApi)) {
          const mod = await loadPanelFeatureModule(key);
          if (!mod) throw new Error('missing panel lazy feature module: ' + key);
        }

        featureApi = getPanelLazyFeatureApi(key);
        if (!featureApi || isPanelLazyFeatureStub(featureApi)) {
          throw new Error('panel lazy feature did not install api: ' + key);
        }

        safe(() => initPanelFeature(key, featureApi));
        featureApi = getPanelLazyFeatureApi(key) || featureApi;
        if (!featureApi || isPanelLazyFeatureStub(featureApi)) {
          throw new Error('panel lazy feature remained stubbed after init: ' + key);
        }

        panelFeatureReady[key] = true;
        return true;
      })
      .catch((error) => {
        try { console.error('[XKeen] panel lazy feature failed:', key, error); } catch (secondaryError) {}
        panelFeatureReady[key] = false;
        return false;
      })
      .finally(() => {
        panelFeatureEnsurePromises[key] = null;
      });

    return panelFeatureEnsurePromises[key];
  }

  const api = getPanelLazyRuntimeApi();
  return (api && typeof api.ensureFeature === 'function')
    ? api.ensureFeature(key)
    : Promise.resolve(false);
}

export function ensurePanelTerminalReady() {
  const api = getPanelLazyRuntimeApi();
  appendTerminalDebug('panel:ensure-terminal-ready', { hasApi: !!api });
  if (!api || typeof api.ensureTerminalReady !== 'function') return Promise.resolve(false);
  return Promise.resolve(api.ensureTerminalReady()).then((ready) => !!ready).catch(() => false);
}

export function isPanelTerminalReady() {
  const api = getPanelLazyRuntimeApi();
  return !!(api && typeof api.isTerminalReady === 'function' && api.isTerminalReady());
}

export function ensurePanelEditorSupport(engine, opts) {
  const api = getPanelLazyRuntimeApi();
  return (api && typeof api.ensureEditorSupport === 'function')
    ? api.ensureEditorSupport(engine, opts)
    : Promise.resolve(false);
}

export function ensurePanelMonacoSupport(opts) {
  return ensurePanelEditorSupport('monaco', opts);
}

export function ensurePanelCodeMirrorSupport(opts) {
  return ensurePanelEditorSupport('codemirror', opts);
}

function isTerminalOverlayVisible() {
  try {
    const overlay = document.getElementById('terminal-overlay');
    if (!overlay || !overlay.isConnected) return false;
    const cs = window.getComputedStyle(overlay);
    if (!cs) return false;
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  } catch (error) {
    return false;
  }
}

function waitForTerminalOverlay(timeoutMs) {
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  if (isTerminalOverlayVisible()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    function tick() {
      if (isTerminalOverlayVisible()) return resolve(true);
      if ((Date.now() - startedAt) >= waitMs) return resolve(isTerminalOverlayVisible());
      setTimeout(tick, 30);
    }
    tick();
  });
}

export async function openPanelTerminal(mode) {
  const terminalMode = String(mode || 'shell').toLowerCase();
  appendTerminalDebug('panel:open-terminal-begin', { mode: terminalMode, ready: isPanelTerminalReady() });

  const terminalRoot = (getXkeenTerminalRoot() || (window.XKeen ? window.XKeen.terminal : null) || null);
  safe(() => {
    if (terminalRoot && typeof terminalRoot.ensureReady === 'function') return terminalRoot.ensureReady();
    if (terminalRoot && typeof terminalRoot.init === 'function') return terminalRoot.init();
    if (terminalRoot && typeof terminalRoot.bootstrap === 'function') return terminalRoot.bootstrap();
    return false;
  });

  const attempts = [];
  attempts.push(async () => {
    const result = openXkeenTerminal({ cmd: '', mode: terminalMode });
    return Promise.resolve(result);
  });
  attempts.push(async () => {
    const root = getXkeenTerminalRoot() || (window.XKeen ? window.XKeen.terminal : null) || null;
    if (!root) return false;
    let api = root && root.api ? root.api : null;
    if ((!api || api.__xkLazyStubInstalled) && root.core && typeof root.core.createPublicApi === 'function') {
      api = root.core.createPublicApi();
      root.api = api;
    }
    if (api && typeof api.open === 'function') return api.open({ cmd: '', mode: terminalMode });
    return false;
  });
  attempts.push(async () => {
    const root = getXkeenTerminalRoot() || (window.XKeen ? window.XKeen.terminal : null) || null;
    const actions = root && root.ui_actions ? root.ui_actions : null;
    if (actions && typeof actions.openTerminal === 'function') return actions.openTerminal('', terminalMode);
    return false;
  });
  attempts.push(async () => {
    const root = getXkeenTerminalRoot() || (window.XKeen ? window.XKeen.terminal : null) || null;
    if (root && typeof root.open === 'function') return root.open(null, { cmd: '', mode: terminalMode });
    return false;
  });

  for (let index = 0; index < attempts.length; index += 1) {
    try {
      appendTerminalDebug('panel:open-terminal-attempt', { mode: terminalMode, index: index + 1 });
      const value = await Promise.resolve(attempts[index]());
      const visible = await waitForTerminalOverlay(index === 0 ? 120 : 220);
      appendTerminalDebug('panel:open-terminal-attempt-result', { mode: terminalMode, index: index + 1, value: value === undefined ? 'undefined' : value, visible: visible });
      if (visible) return true;
      if (value === true && isTerminalOverlayVisible()) return true;
    } catch (error) {
      appendTerminalDebug('panel:open-terminal-attempt-error', { mode: terminalMode, index: index + 1, error: error ? String(error.message || error) : 'unknown error' });
    }
  }

  appendTerminalDebug('panel:open-terminal-failed', { mode: terminalMode });
  return isTerminalOverlayVisible();
}

function withTimeout(promise, timeoutMs, label) {
  const waitMs = Math.max(1000, Number(timeoutMs) || 0);
  if (!promise || typeof promise.then !== 'function') return Promise.resolve(!!promise);

  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
        try {
          toastXkeen(label || 'Открытие терминала заняло слишком много времени.', 'error');
        } catch (error) {}
      }, waitMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function wirePanelTerminalLazyOpen() {
  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');

  function wire(btn, mode) {
    if (!btn) return;
    if (btn.dataset && btn.dataset.xkLazyTerminal === '1') return;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (btn.dataset && btn.dataset.xkTerminalBusy === '1') return;

      try {
        if (btn.dataset) btn.dataset.xkTerminalBusy = '1';
        btn.disabled = true;
      } catch (error) {}

      (async () => {
        let ready = true;
        if (!isPanelTerminalReady()) {
          ready = await withTimeout(
            ensurePanelTerminalReady(),
            12000,
            'Не удалось подготовить терминал. Попробуйте ещё раз.'
          );
        }
        appendTerminalDebug('panel:open-terminal-ready', { mode: mode, ready: !!ready });
        if (!ready) return;
        const opened = await openPanelTerminal(mode);
        if (!opened) {
          try {
            toastXkeen('Терминал инициализирован, но окно не открылось.', 'error');
          } catch (error) {}
        }
      })().finally(() => {
        try {
          if (btn.dataset) delete btn.dataset.xkTerminalBusy;
          btn.disabled = false;
        } catch (error) {}
      });
    }, true);
    if (btn.dataset) btn.dataset.xkLazyTerminal = '1';
  }

  wire(shellBtn, 'shell');
  wire(ptyBtn, 'pty');
}

let terminalCapsInit = false;
export function initPanelTerminalCapabilityButtons() {
  if (terminalCapsInit) return;
  terminalCapsInit = true;

  const shellBtn = document.getElementById('terminal-open-shell-btn');
  const ptyBtn = document.getElementById('terminal-open-pty-btn');
  if (!shellBtn && !ptyBtn) return;

  function apply(data) {
    const ws = !!(data && data.websocket);
    const hasPty = !!(
      data &&
      data.terminal &&
      typeof data.terminal === 'object' &&
      'pty' in data.terminal
        ? data.terminal.pty
        : ws
    );
    try {
      const state = getXkeenStateApi();
      if (state) {
        state.hasWs = ws;
        state.hasPty = hasPty;
      }
    } catch (error) {}

    if (hasPty) {
      if (ptyBtn) { try { ptyBtn.style.display = ''; ptyBtn.disabled = false; } catch (error) {} }
      if (shellBtn) { try { shellBtn.style.display = 'none'; shellBtn.disabled = true; } catch (error) {} }
    } else {
      if (shellBtn) { try { shellBtn.style.display = ''; shellBtn.disabled = false; } catch (error) {} }
      if (ptyBtn) { try { ptyBtn.style.display = 'none'; ptyBtn.disabled = true; } catch (error) {} }
    }
  }

  Promise.resolve().then(() => {
    const http = getCoreHttp();
    if (http && typeof http.fetchJSON === 'function') {
      return http.fetchJSON('/api/capabilities', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      }).catch(() => null);
    }
    return fetch('/api/capabilities', { cache: 'no-store' })
      .then((response) => (response && response.ok) ? response.json() : null)
      .catch(() => null);
  })
    .then((data) => apply(data))
    .catch(() => {
      // On error keep the server-rendered default terminal button.
    });
}

function fireDeferredClick(el) {
  if (!el) return;
  try {
    el.click();
  } catch (error) {
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (secondaryError) {}
  }
}

function replayDeferredClick(el) {
  if (!el) return;
  try {
    if (el.dataset) el.dataset.xkLazyReplay = '1';
  } catch (error) {}
  fireDeferredClick(el);
}

function replayDeferredEvent(el, type) {
  if (!el || !type) return;
  if (String(type) === 'click') {
    replayDeferredClick(el);
    return;
  }
  try {
    el.dispatchEvent(new Event(String(type), { bubbles: true, cancelable: true }));
  } catch (error) {}
}

function consumeReplayFlag(el) {
  try {
    if (!el || !el.dataset || el.dataset.xkLazyReplay !== '1') return false;
    delete el.dataset.xkLazyReplay;
    return true;
  } catch (error) {
    return false;
  }
}

export function wirePanelLazyFeatureClicks() {
  if (document.body && document.body.dataset && document.body.dataset.xkLazyFeatureClicks === '1') return;

  document.addEventListener('click', (event) => {
    const raw = event && event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (!raw) return;

    const serviceTrigger = raw.closest('#xkeen-start-btn, #xkeen-stop-btn, #xkeen-restart-btn, #xkeen-core-text');
    if (serviceTrigger && !isPanelLazyFeatureReady('serviceStatus')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('serviceStatus').then((ready) => {
        if (!ready) return;
        fireDeferredClick(serviceTrigger);
      });
      return;
    }

    const xrayActionBtn = raw.closest('#view-xray-logs button');
    if (xrayActionBtn && !isPanelLazyFeatureReady('xrayLogs')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        fireDeferredClick(xrayActionBtn);
      });
      return;
    }

    const templateBtn = raw.closest('#routing-import-template-btn');
    if (templateBtn) {
      if (consumeReplayFlag(templateBtn)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('routingTemplates').then((ready) => {
        if (!ready) return;
        try {
          const api = getPanelLazyFeatureApi('routingTemplates');
          if (api && typeof api.open === 'function') api.open();
          else replayDeferredClick(templateBtn);
        } catch (error) {}
      });
      return;
    }

    const githubExportBtn = raw.closest('#github-export-btn');
    if (githubExportBtn) {
      if (consumeReplayFlag(githubExportBtn)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('github').then((ready) => {
        if (!ready) return;
        try {
          const api = getPanelLazyFeatureApi('github');
          if (api && typeof api.openExportModal === 'function') api.openExportModal();
          else replayDeferredClick(githubExportBtn);
        } catch (error) {}
      });
      return;
    }

    const githubCatalogBtn = raw.closest('#github-open-catalog-btn');
    if (githubCatalogBtn) {
      if (consumeReplayFlag(githubCatalogBtn)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('github').then((ready) => {
        if (!ready) return;
        try {
          const api = getPanelLazyFeatureApi('github');
          if (api && typeof api.openCatalogModal === 'function') api.openCatalogModal();
          else replayDeferredClick(githubCatalogBtn);
        } catch (error) {}
      });
      return;
    }

    const donateBtn = raw.closest('#top-tab-donate');
    if (donateBtn) {
      if (consumeReplayFlag(donateBtn)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('donate').then((ready) => {
        if (!ready) return;
        try {
          const api = getPanelLazyFeatureApi('donate');
          if (api && typeof api.open === 'function') {
            api.open();
            return;
          }
        } catch (error) {}
        replayDeferredClick(donateBtn);
      });
      return;
    }

    const settingsBtn = raw.closest('#ui-settings-open-btn');
    if (settingsBtn && !isPanelLazyFeatureReady('uiSettingsPanel')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('uiSettingsPanel').then((ready) => {
        if (!ready) return;
        fireDeferredClick(settingsBtn);
      });
      return;
    }

    const mihomoImportBtn = raw.closest('#mihomo-import-node-btn');
    if (mihomoImportBtn && !isPanelLazyFeatureReady('mihomoImport')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('mihomoImport').then((ready) => {
        if (!ready) return;
        fireDeferredClick(mihomoImportBtn);
      });
      return;
    }

    const mihomoProxyToolsBtn = raw.closest('#mihomo-proxy-tools-btn');
    if (mihomoProxyToolsBtn && !isPanelLazyFeatureReady('mihomoProxyTools')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('mihomoProxyTools').then((ready) => {
        if (!ready) return;
        fireDeferredClick(mihomoProxyToolsBtn);
      });
      return;
    }

    const mihomoHwidBtn = raw.closest('#mihomo-hwid-sub-btn');
    if (mihomoHwidBtn && !isPanelLazyFeatureReady('mihomoHwidSub')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('mihomoHwidSub').then((ready) => {
        if (!ready) return;
        fireDeferredClick(mihomoHwidBtn);
      });
      return;
    }

    const xkeenAction = raw.closest('#port-proxying-save-btn, #port-exclude-save-btn, #ip-exclude-save-btn, #xkeen-config-save-btn');
    if (xkeenAction && !isPanelLazyFeatureReady('xkeenTexts')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('xkeenTexts').then((ready) => {
        if (!ready) return;
        fireDeferredClick(xkeenAction);
      });
      return;
    }

    const commandsAction = raw.closest('.command-item, #cores-check-btn, #core-xray-update-btn, #core-mihomo-update-btn');
    if (commandsAction && (!isPanelLazyFeatureReady('commandsList') || !isPanelLazyFeatureReady('coresStatus'))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.all([
        ensurePanelLazyFeature('commandsList'),
        ensurePanelLazyFeature('coresStatus'),
      ]).then((results) => {
        if (results.every(Boolean)) fireDeferredClick(commandsAction);
      });
      return;
    }

    const backupsHeader = raw.closest('#routing-backups-header');
    if (backupsHeader && !isPanelLazyFeatureReady('backups')) {
      if (consumeReplayFlag(backupsHeader)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('backups').then((ready) => {
        if (!ready) return;
        try {
          const api = getPanelLazyFeatureApi('backups');
          if (api && typeof api.load === 'function') api.load();
        } catch (error) {}
        replayDeferredClick(backupsHeader);
      });
      return;
    }

    const inboundsTrigger = raw.closest('#inbounds-header, [id^="inbounds-"], [name="inbounds_mode"]');
    if (inboundsTrigger && !isPanelLazyFeatureReady('inbounds')) {
      if (consumeReplayFlag(inboundsTrigger)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const configShell = getConfigShellApi();
      if (!configShell) return;
      Promise.resolve(activateInboundsConfigView({ reason: 'interaction' })).then((ready) => {
        if (!ready) return;
        replayDeferredClick(inboundsTrigger);
      });
      return;
    }

    const outboundsTrigger = raw.closest('#outbounds-header, [id^="outbounds-"]');
    if (outboundsTrigger && !isPanelLazyFeatureReady('outbounds')) {
      if (consumeReplayFlag(outboundsTrigger)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const configShell = getConfigShellApi();
      if (!configShell) return;
      Promise.resolve(activateOutboundsConfigView({ reason: 'interaction' })).then((ready) => {
        if (!ready) return;
        replayDeferredClick(outboundsTrigger);
      });
      return;
    }
  }, true);

  document.addEventListener('change', (event) => {
    const raw = event && event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (!raw) return;

    const xrayControl = raw.closest('#view-xray-logs select, #view-xray-logs input, #view-xray-logs textarea');
    if (xrayControl && !isPanelLazyFeatureReady('xrayLogs')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        replayDeferredEvent(xrayControl, 'change');
      });
    }
  }, true);

  document.addEventListener('input', (event) => {
    const raw = event && event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (!raw) return;

    const xrayInput = raw.closest('#view-xray-logs input, #view-xray-logs textarea');
    if (xrayInput && !isPanelLazyFeatureReady('xrayLogs')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ensurePanelLazyFeature('xrayLogs').then((ready) => {
        if (!ready) return;
        replayDeferredEvent(xrayInput, 'input');
      });
    }
  }, true);

  if (document.body && document.body.dataset) document.body.dataset.xkLazyFeatureClicks = '1';
}

export const panelLazyBindingsRuntimeApi = Object.freeze({
  getRuntimeApi: getPanelLazyRuntimeApi,
  getFeatureApi: getPanelLazyFeatureApi,
  isFeatureStub: isPanelLazyFeatureStub,
  isFeatureReady: isPanelLazyFeatureReady,
  ensureFeature: ensurePanelLazyFeature,
  ensureTerminalReady: ensurePanelTerminalReady,
  isTerminalReady: isPanelTerminalReady,
  ensureEditorSupport: ensurePanelEditorSupport,
  ensureMonacoSupport: ensurePanelMonacoSupport,
  ensureCodeMirrorSupport: ensurePanelCodeMirrorSupport,
  openTerminal: openPanelTerminal,
  wireTerminalLazyOpen: wirePanelTerminalLazyOpen,
  initTerminalCapabilityButtons: initPanelTerminalCapabilityButtons,
  wireLazyFeatureClicks: wirePanelLazyFeatureClicks,
});
