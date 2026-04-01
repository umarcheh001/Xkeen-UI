import { getDevtoolsApi } from '../devtools.js';
import { getDevtoolsNamespace } from '../devtools_namespace.js';

window.XKeen = window.XKeen || {};
const XKeen = window.XKeen;
XKeen.features = XKeen.features || {};

const namespace = getDevtoolsNamespace();
const mainDevtoolsApi = typeof getDevtoolsApi === 'function' ? getDevtoolsApi() : null;
if (mainDevtoolsApi) {
  namespace.devtools = mainDevtoolsApi;
}

for (const key of Object.keys(namespace)) {
  const api = namespace[key];
  if (!api) continue;
  const legacyApi = XKeen.features[key] || {};
  Object.assign(legacyApi, api);
  XKeen.features[key] = legacyApi;
}
