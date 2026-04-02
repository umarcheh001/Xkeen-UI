import { getInboundsApi } from '../inbounds.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const inboundsApi = typeof getInboundsApi === 'function' ? getInboundsApi() : null;
if (inboundsApi) {
  const legacyInboundsApi = XKeen.features.inbounds || {};
  XKeen.features.inbounds = legacyInboundsApi;
  Object.assign(legacyInboundsApi, inboundsApi);
}
