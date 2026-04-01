import { getRoutingApi } from '../routing.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const routingApi = typeof getRoutingApi === 'function' ? getRoutingApi() : null;
if (routingApi) {
  const legacyRoutingApi = XKeen.routing || {};
  XKeen.routing = legacyRoutingApi;
  Object.assign(legacyRoutingApi, routingApi);
  XKeen.features.routing = legacyRoutingApi;
}
