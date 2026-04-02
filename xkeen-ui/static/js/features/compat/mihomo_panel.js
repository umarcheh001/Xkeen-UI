import { getMihomoPanelApi } from '../mihomo_panel.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const mihomoPanelApi = typeof getMihomoPanelApi === 'function' ? getMihomoPanelApi() : null;
if (mihomoPanelApi) {
  const legacyMihomoPanelApi = XKeen.features.mihomoPanel || {};
  XKeen.features.mihomoPanel = legacyMihomoPanelApi;
  Object.assign(legacyMihomoPanelApi, mihomoPanelApi);
}
