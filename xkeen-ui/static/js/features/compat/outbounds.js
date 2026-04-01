import { getOutboundsApi } from '../outbounds.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const outboundsApi = typeof getOutboundsApi === 'function' ? getOutboundsApi() : null;
if (outboundsApi) {
  const legacyOutboundsApi = XKeen.features.outbounds || {};
  XKeen.features.outbounds = legacyOutboundsApi;
  Object.assign(legacyOutboundsApi, outboundsApi);
}
