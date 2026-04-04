import { bootTopLevelShell } from './top_level_shell.shared.js';
import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';
import { bootDevtoolsScreen } from './devtools.screen.bootstrap.js';

void bootTopLevelShell({
  initialScreen: 'devtools',
  bootstrap() {
    return bootDevtoolsScreen();
  },
}).then(() => {
  try { registerPanelMihomoTopLevelScreens(); } catch (error) {
    try { console.error('[XKeen] panel/mihomo/devtools screen registration failed', error); } catch (secondaryError) {}
  }
});
