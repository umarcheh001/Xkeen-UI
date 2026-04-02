import { ensureXkeenRoot } from './xkeen_runtime.js';
import { getDevtoolsNamespaceApi } from './devtools_namespace.js';
import { getUpdateNotifierApi } from './update_notifier.js';

const featureAccessorRegistry = Object.freeze({
  devtools: () => getDevtoolsNamespaceApi('devtools'),
  updateNotifier: getUpdateNotifierApi,
});

export function getFeatureAccessorRegistry() {
  return featureAccessorRegistry;
}

export function getFeatureApi(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  try {
    const getter = featureAccessorRegistry[key] || null;
    if (typeof getter !== 'function') return null;
    const api = getter();
    return api || null;
  } catch (error) {
    return null;
  }
}

export function requireFeatureApi(name) {
  const key = String(name || '').trim();
  const api = getFeatureApi(key);
  if (api) return api;
  throw new Error('missing feature api: ' + key);
}

export const featureAccessApi = Object.freeze({
  getFeatureApi,
  requireFeatureApi,
  getRegistry: getFeatureAccessorRegistry,
});

try {
  const xk = ensureXkeenRoot();
  if (xk) {
    xk.runtime = xk.runtime && typeof xk.runtime === 'object' ? xk.runtime : {};
    xk.runtime.getFeatureApi = getFeatureApi;
    xk.runtime.requireFeatureApi = requireFeatureApi;
    xk.runtime.getFeatureAccessorRegistry = getFeatureAccessorRegistry;
    xk.runtime.featureAccess = featureAccessApi;
  }
} catch (error) {}
