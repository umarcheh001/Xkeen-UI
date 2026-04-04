import { registerPanelTopLevelScreen } from './top_level_panel_screen.js';
import { registerMihomoGeneratorTopLevelScreen } from './top_level_mihomo_generator_screen.js';
import { registerDevtoolsTopLevelScreen } from './top_level_devtools_screen.js';

const CANONICAL_TOP_LEVEL_SCREEN_NAMES = Object.freeze([
  'panel',
  'backups',
  'devtools',
  'xkeen',
  'mihomo_generator',
]);

const IMPLEMENTED_TOP_LEVEL_SCREEN_REGISTRARS = Object.freeze({
  panel: registerPanelTopLevelScreen,
  devtools: registerDevtoolsTopLevelScreen,
  mihomo_generator: registerMihomoGeneratorTopLevelScreen,
});

let _registered = false;

export function listCanonicalTopLevelScreenNames() {
  return CANONICAL_TOP_LEVEL_SCREEN_NAMES.slice();
}

export function listImplementedTopLevelScreenNames() {
  return CANONICAL_TOP_LEVEL_SCREEN_NAMES.filter((name) => typeof IMPLEMENTED_TOP_LEVEL_SCREEN_REGISTRARS[name] === 'function');
}

export function registerCanonicalTopLevelScreens() {
  if (_registered) return true;

  listImplementedTopLevelScreenNames().forEach((name) => {
    IMPLEMENTED_TOP_LEVEL_SCREEN_REGISTRARS[name]();
  });

  _registered = true;
  return true;
}

export function registerPanelMihomoTopLevelScreens() {
  return registerCanonicalTopLevelScreens();
}
