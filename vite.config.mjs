import { defineConfig } from 'vite';
import path from 'node:path';

const repoRoot = path.resolve('.');
const uiRoot = path.resolve(repoRoot, 'xkeen-ui');
const staticRoot = path.resolve(uiRoot, 'static');
const pageDir = path.resolve(staticRoot, 'js/pages');

const CANONICAL_PAGE_ENTRIES = {
  panel: path.resolve(pageDir, 'panel.entry.js'),
  xkeen: path.resolve(pageDir, 'xkeen.entry.js'),
  backups: path.resolve(pageDir, 'backups.entry.js'),
  devtools: path.resolve(pageDir, 'devtools.entry.js'),
  mihomo_generator: path.resolve(pageDir, 'mihomo_generator.entry.js'),
};

const EXTERNAL_IMPORT_SPECIFIERS = new Set([
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-json',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/lint',
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
  'crelt',
  'jsonc-parser',
  'js-yaml',
  'style-mod',
  'w3c-keyname',
]);

function isExternalImport(specifier) {
  return EXTERNAL_IMPORT_SPECIFIERS.has(String(specifier || ''));
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
      input: CANONICAL_PAGE_ENTRIES,
      external: isExternalImport,
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
