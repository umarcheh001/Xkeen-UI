import { bootTopLevelShell } from './top_level_shell.shared.js';
import { bootMihomoGeneratorScreen } from './mihomo_generator.screen.bootstrap.js';
import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';

void bootTopLevelShell({
  initialScreen: 'mihomo_generator',
  bootstrap() {
    return bootMihomoGeneratorScreen();
  },
}).then(() => {
  try { registerPanelMihomoTopLevelScreens(); } catch (error) {
    try { console.error('[XKeen] panel/mihomo screen registration failed', error); } catch (secondaryError) {}
  }
});
