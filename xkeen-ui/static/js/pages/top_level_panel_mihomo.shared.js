import { registerPanelTopLevelScreen } from './top_level_panel_screen.js';
import { registerMihomoGeneratorTopLevelScreen } from './top_level_mihomo_generator_screen.js';

let _registered = false;

export function registerPanelMihomoTopLevelScreens() {
  if (_registered) return true;
  registerPanelTopLevelScreen();
  registerMihomoGeneratorTopLevelScreen();
  _registered = true;
  return true;
}
