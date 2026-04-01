import { getLocalIoApi } from '../local_io.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;

const localIoApi = typeof getLocalIoApi === 'function' ? getLocalIoApi() : null;
if (localIoApi) {
  const legacyLocalIoApi = XKeen.localIO || {};
  XKeen.localIO = legacyLocalIoApi;
  Object.assign(legacyLocalIoApi, localIoApi);
}
