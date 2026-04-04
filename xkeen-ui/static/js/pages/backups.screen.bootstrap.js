import './shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import '../core/xk_dom.js';
import '../core/xk_http.js';
import '../core/xk_storage.js';
import '../ui/shared_primitives.js';
import '../features/update_notifier.js';
import '../ui/modal.js';
import '../ui/confirm_modal.js';
import '../ui/theme.js?v=20260324b';
import '../ui/tooltips_auto.js?v=20260119d';
import '../ui/monaco_loader.js?v=20260317b';
import '../ui/spinner_fetch.js';
import { bootBackupsPage } from './backups.init.js';
import { getBackupsApi } from '../features/backups.js?v=20260317b';

function getWindowRef() {
  try {
    return window || null;
  } catch (error) {
    return null;
  }
}

function readScrollState() {
  const win = getWindowRef();
  if (!win) return null;
  return {
    scrollX: Number(win.scrollX || win.pageXOffset || 0) || 0,
    scrollY: Number(win.scrollY || win.pageYOffset || 0) || 0,
  };
}

function applyScrollState(state) {
  const win = getWindowRef();
  if (!win || !state || typeof state !== 'object') return false;

  const x = Number(state.scrollX || 0) || 0;
  const y = Number(state.scrollY || 0) || 0;
  try {
    setTimeout(() => {
      try { win.scrollTo(x, y); } catch (error) {}
    }, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function createBackupsTopLevelApi(backupsApi) {
  return {
    activate(context) {
      if (backupsApi && typeof backupsApi.activate === 'function') {
        return backupsApi.activate(context);
      }
      if (backupsApi && typeof backupsApi.isInitialized === 'function' && !backupsApi.isInitialized()) {
        return backupsApi.init();
      }
      return null;
    },
    deactivate(context) {
      if (backupsApi && typeof backupsApi.deactivate === 'function') {
        return backupsApi.deactivate(context);
      }
      return null;
    },
    serializeState(context) {
      const state = Object.assign(
        {},
        backupsApi && typeof backupsApi.serializeState === 'function'
          ? (backupsApi.serializeState(context) || {})
          : {},
        readScrollState() || {}
      );
      return state;
    },
    restoreState(state, context) {
      if (backupsApi && typeof backupsApi.restoreState === 'function') {
        try { backupsApi.restoreState(state, context); } catch (error) {}
      }
      return applyScrollState(state);
    },
  };
}

let _backupsTopLevelApi = null;

export async function bootBackupsScreen() {
  bootBackupsPage();

  if (!_backupsTopLevelApi) {
    const backupsApi = getBackupsApi();
    _backupsTopLevelApi = Object.assign({}, backupsApi || {}, createBackupsTopLevelApi(backupsApi));
  }

  return _backupsTopLevelApi;
}

export function getBackupsTopLevelApi() {
  if (_backupsTopLevelApi) return _backupsTopLevelApi;
  const backupsApi = getBackupsApi();
  _backupsTopLevelApi = Object.assign({}, backupsApi || {}, createBackupsTopLevelApi(backupsApi));
  return _backupsTopLevelApi;
}
