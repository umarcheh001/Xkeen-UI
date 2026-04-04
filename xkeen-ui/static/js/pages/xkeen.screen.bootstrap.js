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

function emitXkeenEditorsReady() {
  try {
    document.dispatchEvent(new CustomEvent('xkeen-editors-ready'));
  } catch (error) {}
}

function createXkeenTopLevelApi() {
  return {
    activate() {
      emitXkeenEditorsReady();
    },
    deactivate() {},
  };
}

let _xkeenTopLevelApi = null;

export async function bootXkeenScreen() {
  bootXkeenPage();

  if (!_xkeenTopLevelApi) {
    _xkeenTopLevelApi = Object.assign(createXkeenTopLevelApi(), {
      serviceStatus: getServiceStatusApi(),
      xkeenTexts: getXkeenTextsApi(),
    });
  }

  return _xkeenTopLevelApi;
}

export function getXkeenTopLevelApi() {
  if (_xkeenTopLevelApi) return _xkeenTopLevelApi;
  _xkeenTopLevelApi = Object.assign(createXkeenTopLevelApi(), {
    serviceStatus: getServiceStatusApi(),
    xkeenTexts: getXkeenTextsApi(),
  });
  return _xkeenTopLevelApi;
}
