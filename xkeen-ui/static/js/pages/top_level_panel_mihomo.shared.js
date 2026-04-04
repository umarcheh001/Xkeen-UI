import { registerPanelTopLevelScreen } from './top_level_panel_screen.js';
import { registerMihomoGeneratorTopLevelScreen } from './top_level_mihomo_generator_screen.js';
import { registerDevtoolsTopLevelScreen } from './top_level_devtools_screen.js';

let _registered = false;

export function registerCanonicalTopLevelScreens() {
  if (_registered) return true;
  registerPanelTopLevelScreen();
  registerMihomoGeneratorTopLevelScreen();
  registerDevtoolsTopLevelScreen();
  _registered = true;
  return true;
}

export function registerPanelMihomoTopLevelScreens() {
  return registerCanonicalTopLevelScreens();
}
