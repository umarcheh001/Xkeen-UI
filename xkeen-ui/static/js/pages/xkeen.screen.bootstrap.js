import './shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import '../core/xk_dom.js';
import '../core/xk_http.js';
import '../core/xk_storage.js';
import '../features/update_notifier.js';
import '../ui/theme.js?v=20260324b';
import '../ui/tooltips_auto.js?v=20260119d';
import '../util/helpers.js';
import '../ui/spinner_fetch.js';
import { bootXkeenPage } from './xkeen.init.js';
import { getServiceStatusApi } from '../features/service_status.js';
import { getXkeenTextsApi } from '../features/xkeen_texts.js';

function getWindowRef() {
  try {
    return window || null;
  } catch (error) {
    return null;
  }
}

function emitXkeenEditorsReady() {
  try {
    document.dispatchEvent(new CustomEvent('xkeen-editors-ready'));
  } catch (error) {}
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

function createXkeenTopLevelApi(apis) {
  const serviceStatus = apis && apis.serviceStatus ? apis.serviceStatus : null;
  const xkeenTexts = apis && apis.xkeenTexts ? apis.xkeenTexts : null;

  return {
    activate(context) {
      if (serviceStatus && typeof serviceStatus.activate === 'function') {
        try { serviceStatus.activate(context); } catch (error) {}
      } else if (serviceStatus && typeof serviceStatus.isInitialized === 'function' && serviceStatus.isInitialized()) {
        try { if (typeof serviceStatus.startPolling === 'function') serviceStatus.startPolling(); } catch (error) {}
      }

      if (xkeenTexts && typeof xkeenTexts.activate === 'function') {
        try { xkeenTexts.activate(context); } catch (error) {}
      }

      emitXkeenEditorsReady();
    },
    deactivate(context) {
      let state = null;
      if (xkeenTexts && typeof xkeenTexts.deactivate === 'function') {
        try { state = xkeenTexts.deactivate(context) || state; } catch (error) {}
      }
      if (serviceStatus && typeof serviceStatus.deactivate === 'function') {
        try { serviceStatus.deactivate(context); } catch (error) {}
      }
      return state;
    },
    serializeState(context) {
      return Object.assign(
        {},
        readScrollState() || {},
        {
          xkeenTexts: xkeenTexts && typeof xkeenTexts.serializeState === 'function'
            ? (xkeenTexts.serializeState(context) || null)
            : null,
          serviceStatus: serviceStatus && typeof serviceStatus.serializeState === 'function'
            ? (serviceStatus.serializeState(context) || null)
            : null,
        }
      );
    },
    restoreState(state, context) {
      const next = state && typeof state === 'object' ? state : null;
      if (!next) return false;

      if (xkeenTexts && typeof xkeenTexts.restoreState === 'function' && next.xkeenTexts) {
        try { xkeenTexts.restoreState(next.xkeenTexts, context); } catch (error) {}
      }
      if (serviceStatus && typeof serviceStatus.restoreState === 'function' && next.serviceStatus) {
        try { serviceStatus.restoreState(next.serviceStatus, context); } catch (error) {}
      }

      return applyScrollState(next);
    },
  };
}

let _xkeenTopLevelApi = null;

export async function bootXkeenScreen() {
  bootXkeenPage();

  if (!_xkeenTopLevelApi) {
    _xkeenTopLevelApi = Object.assign({
      serviceStatus: getServiceStatusApi(),
      xkeenTexts: getXkeenTextsApi(),
    }, createXkeenTopLevelApi({
      serviceStatus: getServiceStatusApi(),
      xkeenTexts: getXkeenTextsApi(),
    }));
  }

  return _xkeenTopLevelApi;
}

export function getXkeenTopLevelApi() {
  if (_xkeenTopLevelApi) return _xkeenTopLevelApi;
  _xkeenTopLevelApi = Object.assign({
    serviceStatus: getServiceStatusApi(),
    xkeenTexts: getXkeenTextsApi(),
  }, createXkeenTopLevelApi({
    serviceStatus: getServiceStatusApi(),
    xkeenTexts: getXkeenTextsApi(),
  }));
  return _xkeenTopLevelApi;
}
