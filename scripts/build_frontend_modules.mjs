// Second pass of `npm run frontend:build`: every separate module gets its own
// directory under frontend-build/modules and its own manifest next to the core
// ones. Whatever belongs to a module that is no longer separate is removed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { MODULE_MANIFEST_FILENAME, SEPARATE_MODULES, moduleOutDir } from '../vite.module.config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(repoRoot, 'xkeen-ui', 'static', 'frontend-build');
const modulesRoot = path.join(buildRoot, 'modules');
const manifestRoot = path.join(buildRoot, '.vite');
const MANIFEST_NAME = /^module\.(.+)\.json$/;

function removeRetiredModules(moduleIds) {
  if (fs.existsSync(modulesRoot)) {
    for (const entry of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
      if (!moduleIds.has(entry.name)) fs.rmSync(path.join(modulesRoot, entry.name), { recursive: true, force: true });
    }
  }
  if (fs.existsSync(manifestRoot)) {
    for (const name of fs.readdirSync(manifestRoot)) {
      const match = MANIFEST_NAME.exec(name);
      if (match && !moduleIds.has(match[1])) fs.rmSync(path.join(manifestRoot, name), { force: true });
    }
  }
}

async function buildModule(moduleId) {
  process.env.XK_MODULE_ID = moduleId;
  await build({ configFile: path.join(repoRoot, 'vite.module.config.mjs') });
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.renameSync(
    path.join(moduleOutDir(moduleId), MODULE_MANIFEST_FILENAME),
    path.join(manifestRoot, `module.${moduleId}.json`),
  );
}

const moduleIds = Object.keys(SEPARATE_MODULES);
removeRetiredModules(new Set(moduleIds));
for (const moduleId of moduleIds) {
  await buildModule(moduleId);
}
console.log(`Built ${moduleIds.length} separate module(s).`);
