import './shell.shared.js';
import './logs_shell.shared.js';
import './panel_shell.shared.js';
import './config_shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import './panel.shared_compat.bundle.js';
import { bootPanelPage } from './panel.bootstrap_tail.bundle.js';

async function loadPanelFeatureBundles() {
  if (window.XKEEN_HAS_XRAY) {
    await import('./panel.routing.bundle.js');
  }

  if (window.XKEEN_HAS_MIHOMO) {
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
