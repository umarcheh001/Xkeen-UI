import { bootTopLevelShell } from './top_level_shell.shared.js';
import { bootPanelScreen } from './panel.screen.bootstrap.js';

void bootTopLevelShell({
  initialScreen: 'panel',
  async bootstrap() {
    await bootPanelScreen();
  },
  onError(error) {
    console.error('[XKeen] panel feature bundle bootstrap failed', error);
  },
}).then(async () => {
  // Do not fetch the Mihomo top-level bundle when its gated markup is absent.
  // Stage 3 still keeps the legacy-full shell intact, while Xray-only/core
  // profiles avoid loading this module-owned frontend code.
  if (!document.querySelector('[data-xk-section="mihomo"]')) return;
  try {
    const { registerPanelMihomoTopLevelScreens } = await import('./top_level_panel_mihomo.shared.js');
    registerPanelMihomoTopLevelScreens();
  } catch (error) {
    try { console.error('[XKeen] panel/mihomo screen registration failed', error); } catch (secondaryError) {}
  }
});
