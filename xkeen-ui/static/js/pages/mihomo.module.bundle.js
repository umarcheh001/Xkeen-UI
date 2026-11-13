import {
  initMihomoPanel,
  onShowMihomoPanel,
  isMihomoPanelEditorDirty,
} from '../features/mihomo_panel.js';
import '../features/compat/mihomo_panel.js';
import '../features/mihomo_yaml_patch.js';
import '../features/mihomo_dns.js?v=20260924b';
import { initCoreSources } from '../features/core_source.js';

let mihomoBundleActivated = false;

export function activate() {
  if (!mihomoBundleActivated) {
    mihomoBundleActivated = true;
    initCoreSources(document, 'mihomo');
  }

  return {
    initMihomoPanel,
    onShowMihomoPanel,
    isMihomoPanelEditorDirty,
  };
}
