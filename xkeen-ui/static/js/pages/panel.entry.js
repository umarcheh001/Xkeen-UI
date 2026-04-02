import './shell.shared.js';
import './logs_shell.shared.js';
import './panel_shell.shared.js';
import './config_shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import './panel.shared_compat.bundle.js';
import { hasXkeenMihomoCore, hasXkeenXrayCore } from '../features/xkeen_runtime.js';
import { bootPanelPage } from './panel.bootstrap_tail.bundle.js';

async function loadPanelFeatureBundles() {
  if (hasXkeenXrayCore()) {
    await import('./panel.routing.bundle.js');
  }

  if (hasXkeenMihomoCore()) {
    await import('./panel.mihomo.bundle.js');
  }
}

void loadPanelFeatureBundles()
  .then(() => {
    bootPanelPage();
  })
  .catch((error) => {
    console.error('[XKeen] panel feature bundle bootstrap failed', error);
  });
