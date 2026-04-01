// Build-managed panel bootstrap tail bundle.
//
// Keeps panel.entry.js focused on bundle-level composition while
// panel.init.js remains the page wiring/orchestration module.

import initPanelPageDefault, { initPanelPage, bootPanelPage } from './panel.init.js?v=20260327-stage3-tail1';

export { initPanelPage, bootPanelPage };
export default initPanelPageDefault;
