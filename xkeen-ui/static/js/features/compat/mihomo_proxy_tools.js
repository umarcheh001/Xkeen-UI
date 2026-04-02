import { getMihomoProxyToolsApi } from '../mihomo_proxy_tools.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const mihomoProxyToolsApi = typeof getMihomoProxyToolsApi === 'function' ? getMihomoProxyToolsApi() : null;
if (mihomoProxyToolsApi) {
  const legacyMihomoProxyToolsApi = XKeen.features.mihomoProxyTools || {};
  XKeen.features.mihomoProxyTools = legacyMihomoProxyToolsApi;
  Object.assign(legacyMihomoProxyToolsApi, mihomoProxyToolsApi);
}
