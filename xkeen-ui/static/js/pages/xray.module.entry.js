// Entry of the Xray module. It stays light: every part loads on demand, and the
// core asks for a part through features/module_parts.js.
import { rememberModulePart } from '../features/module_parts.js';

export const XRAY_MODULE_PARTS = Object.freeze({
  bundle: () => import('./xray.module.bundle.js'),
  routing: () => import('../features/routing.js'),
  routing_cards: () => import('../features/routing_cards.js'),
  routing_shell: () => import('../features/routing_shell.js'),
  routing_templates: () => import('../features/routing_templates.js'),
  inbounds: () => import('../features/inbounds.js'),
  outbounds: () => import('../features/outbounds.js'),
  xray_preflight_modal: () => import('../ui/xray_preflight_modal.js'),
  dat_contents_modal: () => import('../ui/dat_contents_modal.js'),
  github: () => import('../features/github.js').then(
    (mod) => import('../features/compat/github.js').then(() => mod)
  ),
});

export function load(part) {
  const loader = Object.prototype.hasOwnProperty.call(XRAY_MODULE_PARTS, part) ? XRAY_MODULE_PARTS[part] : null;
  if (typeof loader !== 'function') {
    return Promise.reject(new Error(`unknown part of the Xray module: ${part}`));
  }
  return loader().then((mod) => {
    rememberModulePart('engine.xray', part, mod);
    return mod;
  });
}

export async function activate(context) {
  const bundle = await load('bundle');
  // The bundle takes these statically; loading them here lets the core see them.
  await Promise.all(['routing', 'routing_cards', 'routing_shell'].map((part) => load(part)));
  return bundle.activate(context);
}
