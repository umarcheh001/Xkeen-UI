import { rememberModulePart } from 'xk-core/js/features/module_parts.js';

export const MIHOMO_MODULE_PARTS = Object.freeze({
  bundle: () => import('./mihomo.module.bundle.js'),
  import: () => import('../features/mihomo_import.js').then(
    (mod) => import('../features/compat/mihomo_import.js').then(() => mod)
  ),
  proxy_tools: () => load('import')
    .then(() => import('../features/mihomo_proxy_tools.js'))
    .then((mod) => import('../features/compat/mihomo_proxy_tools.js').then(() => mod)),
  hwid_sub: () => import('../features/mihomo_hwid_sub.js').then(
    (mod) => import('../features/compat/mihomo_hwid_sub.js').then(() => mod)
  ),
  clash: () => import('../features/mihomo_clash/index.js'),
  generator: () => import('./mihomo_generator.screen.bootstrap.js'),
});

const partPromises = new Map();

export function load(part) {
  const loader = Object.prototype.hasOwnProperty.call(MIHOMO_MODULE_PARTS, part) ? MIHOMO_MODULE_PARTS[part] : null;
  if (typeof loader !== 'function') {
    return Promise.reject(new Error(`unknown part of the Mihomo module: ${part}`));
  }
  if (!partPromises.has(part)) {
    partPromises.set(part, Promise.resolve().then(loader).then((mod) => {
      rememberModulePart('engine.mihomo', part, mod);
      return mod;
    }).catch((error) => {
      partPromises.delete(part);
      throw error;
    }));
  }
  return partPromises.get(part);
}

export async function activate(context) {
  const bundle = await load('bundle');
  return bundle.activate(context);
}
