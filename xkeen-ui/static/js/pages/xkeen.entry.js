import { bootTopLevelShell } from './top_level_shell.shared.js';
import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';
import { bootXkeenScreen } from './xkeen.screen.bootstrap.js';

void bootTopLevelShell({
  initialScreen: 'xkeen',
  bootstrap() {
    return bootXkeenScreen();
  },
}).then(() => {
  try { registerPanelMihomoTopLevelScreens(); } catch (error) {
    try { console.error('[XKeen] canonical top-level screen registration failed', error); } catch (secondaryError) {}
  }
});
