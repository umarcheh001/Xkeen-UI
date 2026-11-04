import { defineConfig } from 'vite';
import path from 'node:path';
import { EXTERNAL_IMPORT_SPECIFIERS, staticRoot } from './vite.config.mjs';

// Modules built apart from the panel. A change inside one of them must change
// only its own build files, so the core reaches it by the name xk-module/<id>.
export const SEPARATE_MODULES = {
  'tool.advanced-diagnostics': { entry: 'js/features/resource_monitor.js' },
  'engine.xray': { entry: 'js/pages/xray.module.entry.js' },
};

// Rollup refuses `../` in a file name, so the manifest is written inside outDir
// and scripts/build_frontend_modules.mjs moves it next to the core manifests.
export const MODULE_MANIFEST_FILENAME = 'module.manifest.json';

export function moduleOutDir(moduleId) {
  return path.resolve(staticRoot, 'frontend-build', 'modules', moduleId);
}

function isExternalImport(specifier) {
  const name = String(specifier || '');
  return EXTERNAL_IMPORT_SPECIFIERS.has(name) || /^xk-(core|module)\//.test(name);
}

export default defineConfig(() => {
  const moduleId = String(process.env.XK_MODULE_ID || '');
  const definition = SEPARATE_MODULES[moduleId];
  if (!definition) {
    throw new Error(`XK_MODULE_ID does not name a separate module: ${moduleId || '(empty)'}`);
  }
  const entryName = path.basename(definition.entry, '.js');
  return {
    root: staticRoot,
    publicDir: false,
    build: {
      outDir: moduleOutDir(moduleId),
      emptyOutDir: true,
      manifest: MODULE_MANIFEST_FILENAME,
      modulePreload: false,
      sourcemap: false,
      target: 'es2022',
      rollupOptions: {
        // The core calls the exports of the entry; Vite drops them by default.
        preserveEntrySignatures: 'strict',
        input: { [entryName]: path.resolve(staticRoot, definition.entry) },
        external: isExternalImport,
        output: {
          entryFileNames: '[name]-[hash].js',
          chunkFileNames: '[name]-[hash].js',
          assetFileNames: '[name]-[hash][extname]',
        },
      },
    },
  };
});
