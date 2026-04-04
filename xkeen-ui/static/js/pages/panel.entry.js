import { bootTopLevelShell } from './top_level_shell.shared.js';
import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';
import { bootPanelScreen } from './panel.screen.bootstrap.js';

void bootTopLevelShell({
  initialScreen: 'panel',
  async bootstrap() {
    await bootPanelScreen();
  },
  onError(error) {
    console.error('[XKeen] panel feature bundle bootstrap failed', error);
  },
}).then(() => {
  try { registerPanelMihomoTopLevelScreens(); } catch (error) {
    try { console.error('[XKeen] panel/mihomo screen registration failed', error); } catch (secondaryError) {}
  }
});
