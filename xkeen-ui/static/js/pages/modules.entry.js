import { bootTopLevelShell } from './top_level_shell.shared.js';
import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';
import { bootModulesScreen } from './modules.screen.bootstrap.js';

void bootTopLevelShell({
  initialScreen: 'modules',
  bootstrap() {
    return bootModulesScreen();
  },
}).then(() => {
  try { registerPanelMihomoTopLevelScreens(); } catch (error) {
    try { console.error('[XKeen] canonical top-level screen registration failed', error); } catch (secondaryError) {}
  }
});
