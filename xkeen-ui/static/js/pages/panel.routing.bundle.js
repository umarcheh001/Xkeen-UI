// Loader of the Xray screens. It stays in the core and does not change when the
// Xray module changes: the screens themselves are in xray.module.bundle.js.
export function activate(context) {
  return import('./xray.module.entry.js').then((entry) => entry.activate(context));
}
