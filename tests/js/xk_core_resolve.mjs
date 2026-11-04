// Resolve hook: `xk-core/<path>` is the file <repo>/xkeen-ui/static/<path>,
// the same file the importmap of a page without a build gives the browser.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PREFIX = 'xk-core/';
const STATIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../xkeen-ui/static');

export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === 'string' && specifier.startsWith(PREFIX)) {
    const target = pathToFileURL(path.join(STATIC_ROOT, specifier.slice(PREFIX.length))).href;
    return nextResolve(target, context);
  }
  return nextResolve(specifier, context);
}
