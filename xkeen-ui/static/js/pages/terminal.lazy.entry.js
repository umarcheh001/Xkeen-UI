import {
  appendTerminalDebug,
  finishTerminalDebugRun,
  markTerminalDebugState,
  startTerminalDebugRun,
} from '../features/terminal_debug.js';
import {
  ensureXtermVendorReady,
  OPTIONAL_XTERM_VENDOR_SPECS,
  REQUIRED_XTERM_VENDOR_SPECS,
} from '../terminal/vendors/xterm_import_adapter.js';

// Build-managed lazy bundle for terminal runtime.
// Debug build: logs every vendor/app module step to localStorage so the last
// successful import is still available after a hard tab freeze.

const TERMINAL_IMPORTS = [
  '../terminal/_core.js',
  '../terminal/core/events.js',
  '../terminal/core/logger.js',
  '../terminal/core/config.js',
  '../terminal/core/ui.js',
  '../terminal/core/api.js',
  '../terminal/transport/pty_transport.js',
  '../terminal/transport/lite_transport.js',
  '../terminal/transport/index.js',
  '../terminal/core/state.js',
  '../terminal/core/registry.js',
  '../terminal/commands/registry.js',
  '../terminal/commands/router.js',
  '../terminal/commands/builtins/xkeen_restart.js',
  '../terminal/commands/builtins/sysmon.js',
  '../terminal/core/session_controller.js',
  '../terminal/core/context.js',
  '../terminal/core/public_api.js',
  '../terminal/core/output_controller.js',
  '../terminal/core/input_controller.js',
  '../terminal/capabilities.js',
  '../terminal/pty.js',
  '../terminal/core/xterm_manager.js',
  '../terminal/lite_runner.js',
  '../terminal/search.js',
  '../terminal/history.js',
  '../terminal/quick_commands.js',
  '../terminal/chrome.js',
  '../terminal/modules/overlay_controller.js',
  '../terminal/modules/status_controller.js',
  '../terminal/modules/terminal_controller.js',
  '../terminal/modules/ui_controller.js',
  '../terminal/modules/buffer_actions.js',
  '../terminal/modules/ssh_profiles.js',
  '../terminal/modules/reconnect_controller.js',
  '../terminal/modules/output_prefs.js',
  '../terminal/modules/confirm_prompt.js',
  '../terminal/xray_tail.js',
  '../terminal/terminal.js',
];

let terminalBundlePromise = null;

function nextTick(delay = 0) {
  return new Promise((resolve) => {
    try { setTimeout(resolve, delay); } catch (error) { resolve(); }
  });
}

async function importAppModule(specifier) {
  appendTerminalDebug('lazy:module:begin', { specifier });
  markTerminalDebugState({ status: 'loading-module', lastStage: 'lazy:module:begin', currentModule: specifier });
  await nextTick(0);
  const mod = await import(specifier);
  appendTerminalDebug('lazy:module:done', { specifier, keys: mod ? Object.keys(mod).slice(0, 8) : [] });
  return mod;
}

export async function ensureTerminalBundleReady() {
  if (terminalBundlePromise) return terminalBundlePromise;

  terminalBundlePromise = (async () => {
    startTerminalDebugRun({ source: 'terminal.lazy.entry' });
    markTerminalDebugState({ status: 'bundle-loading', lastStage: 'lazy:start' });
    appendTerminalDebug('lazy:start', {
      requiredVendorCount: REQUIRED_XTERM_VENDOR_SPECS.length,
      optionalVendorCount: OPTIONAL_XTERM_VENDOR_SPECS.length,
      moduleCount: TERMINAL_IMPORTS.length,
    });

    await ensureXtermVendorReady();


    for (const specifier of TERMINAL_IMPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await importAppModule(specifier);
      // eslint-disable-next-line no-await-in-loop
      await nextTick(0);
    }

    try {
      const root = window && window.XKeen ? (window.XKeen.terminal || null) : null;
      if (!root || typeof root.init !== 'function') {
        await import('../terminal/terminal.js');
      }
    } catch (e) {}

    appendTerminalDebug('lazy:complete', { ok: true });
    finishTerminalDebugRun('bundle-ready', { ok: true });
    return true;
  })().catch((error) => {
    appendTerminalDebug('lazy:failed', { error: error ? String(error.message || error) : 'unknown error' });
    finishTerminalDebugRun('bundle-failed', { error: error ? String(error.message || error) : 'unknown error' });
    terminalBundlePromise = null;
    throw error;
  });

  return terminalBundlePromise;
}

export { TERMINAL_IMPORTS, REQUIRED_XTERM_VENDOR_SPECS, OPTIONAL_XTERM_VENDOR_SPECS };
