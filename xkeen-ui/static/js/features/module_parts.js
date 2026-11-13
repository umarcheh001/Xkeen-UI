// The core reaches the files of a separately built module only through here:
// it names the module and the part it needs, the module's entry loads it.
let MODULE_ENTRIES = {
  'engine.mihomo': () => import('../pages/mihomo.module.entry.js'),
  'engine.xray': () => import('xk-module/engine.xray'),
};

const loadedParts = new Map();

function partKey(moduleId, part) {
  return `${String(moduleId)}\u0000${String(part)}`;
}

export function rememberModulePart(moduleId, part, mod) {
  if (mod) loadedParts.set(partKey(moduleId, part), mod);
}

export function loadedModulePart(moduleId, part) {
  return loadedParts.get(partKey(moduleId, part)) || null;
}

export function loadModulePart(moduleId, part) {
  const loadEntry = Object.prototype.hasOwnProperty.call(MODULE_ENTRIES, moduleId) ? MODULE_ENTRIES[moduleId] : null;
  if (typeof loadEntry !== 'function') {
    return Promise.reject(new Error(`module is not separate: ${moduleId}`));
  }
  return Promise.resolve()
    .then(() => loadEntry())
    .then((entry) => entry.load(part));
}

export function __setModuleEntriesForTest(table) {
  MODULE_ENTRIES = table || {};
}
