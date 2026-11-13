import { bootTopLevelShell } from './top_level_shell.shared.js';
import { loadModulePart } from '../features/module_parts.js';
import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';

void bootTopLevelShell({
  initialScreen: 'mihomo_generator',
  bootstrap() {
    return loadModulePart('engine.mihomo', 'generator').then((mod) => mod.bootMihomoGeneratorScreen());
  },
}).then(() => {
  try { registerPanelMihomoTopLevelScreens(); } catch (error) {
    try { console.error('[XKeen] panel/mihomo screen registration failed', error); } catch (secondaryError) {}
  }
});
