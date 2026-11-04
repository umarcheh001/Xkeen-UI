import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve('.');
const uiRoot = path.resolve(repoRoot, 'xkeen-ui');
export const staticRoot = path.resolve(uiRoot, 'static');
const pageDir = path.resolve(staticRoot, 'js/pages');

const CANONICAL_PAGE_ENTRIES = {
  panel: path.resolve(pageDir, 'panel.entry.js'),
  xkeen: path.resolve(pageDir, 'xkeen.entry.js'),
  modules: path.resolve(pageDir, 'modules.entry.js'),
  devtools: path.resolve(pageDir, 'devtools.entry.js'),
  mihomo_generator: path.resolve(pageDir, 'mihomo_generator.entry.js'),
};

const CORE_PUBLIC_SPECIFIER_RE = /\b(?:from|import)\s*\(?\s*['"`]xk-core\/([^'"`?#\s]+)['"`]/g;

function listScripts(dir) {
  const found = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...listScripts(full));
    else if (item.isFile() && item.name.endsWith('.js')) found.push(full);
  }
  return found;
}

// Every file of the core that a source names `xk-core/<path under static>`.
// The core publishes them as entries of its build, so a module built apart
// reaches the very chunk the core loads, not a copy of it.
export function collectCorePublicPaths(root) {
  const jsRoot = path.resolve(root, 'js');
  const vendorNpm = path.resolve(jsRoot, 'vendor/npm') + path.sep;
  const paths = new Set();
  for (const file of listScripts(jsRoot)) {
    if (file.startsWith(vendorNpm)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(CORE_PUBLIC_SPECIFIER_RE)) paths.add(match[1]);
  }
  return [...paths].sort();
}

// Entry names stay stable while the paths do; the hash keeps them short.
const CORE_PUBLIC_ENTRIES = Object.fromEntries(
  collectCorePublicPaths(staticRoot).map((relative) => [
    'xk-core-' + createHash('sha1').update(relative).digest('hex').slice(0, 10),
    path.resolve(staticRoot, relative),
  ]),
);

export const EXTERNAL_IMPORT_SPECIFIERS = new Set([
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-json',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/merge',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/json',
  '@lezer/lr',
  '@lezer/yaml',
  '@marijn/find-cluster-break',
  '@replit/codemirror-indentation-markers',
  'codemirror',
  'codemirror-json-schema',
  'crelt',
  'jsonc-parser',
  'js-yaml',
  'style-mod',
  'w3c-keyname',
]);

function isExternalImport(specifier) {
  const name = String(specifier || '');
  return EXTERNAL_IMPORT_SPECIFIERS.has(name) || /^(?:xk-core|xk-module)\//.test(name);
}

export default defineConfig({
  root: staticRoot,
  publicDir: false,
  build: {
    outDir: path.resolve(staticRoot, 'frontend-build'),
    emptyOutDir: false,
    manifest: '.vite/manifest.build.json',
    modulePreload: false,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: { ...CANONICAL_PAGE_ENTRIES, ...CORE_PUBLIC_ENTRIES },
      // A module imports the exports of a public entry, which Vite would
      // otherwise drop as unused.
      preserveEntrySignatures: 'strict',
      external: isExternalImport,
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
