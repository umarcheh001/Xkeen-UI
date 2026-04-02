import { getRoutingShellApi } from '../routing_shell.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const routingShellApi = typeof getRoutingShellApi === 'function' ? getRoutingShellApi() : null;
if (routingShellApi) {
  const legacyRoutingShellApi = XKeen.features.routingShell || {};
  XKeen.features.routingShell = legacyRoutingShellApi;
  Object.assign(legacyRoutingShellApi, routingShellApi);
}
