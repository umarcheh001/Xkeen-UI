let devtoolsNamespace = null;

function createDevtoolsNamespace() {
  return {
    devtools: null,
    devtoolsShared: null,
    devtoolsService: null,
    devtoolsLogs: null,
    devtoolsEnv: null,
    devtoolsUpdate: null,
    devtoolsTheme: null,
    devtoolsTerminalTheme: null,
    devtoolsCodeMirrorTheme: null,
    devtoolsCustomCss: null,
  };
}

export function getDevtoolsNamespace() {
  if (!devtoolsNamespace) {
    devtoolsNamespace = createDevtoolsNamespace();
  }
  return devtoolsNamespace;
}

export function getDevtoolsNamespaceApi(name) {
  const key = String(name || '');
  if (!key) return null;
  const namespace = getDevtoolsNamespace();
  return namespace[key] || null;
}

export function setDevtoolsNamespaceApi(name, api) {
  const key = String(name || '');
  if (!key) return null;
  const namespace = getDevtoolsNamespace();
  namespace[key] = api || null;
  return namespace[key];
}

export function getDevtoolsSharedApi() {
  return getDevtoolsNamespaceApi('devtoolsShared');
}

export const devtoolsNamespaceApi = Object.freeze({
  get: getDevtoolsNamespace,
  getApi: getDevtoolsNamespaceApi,
  getSharedApi: getDevtoolsSharedApi,
  setApi: setDevtoolsNamespaceApi,
});
