import './shell.shared.js';
import './logs_shell.shared.js';
import './panel_shell.shared.js';
import './config_shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import { bootLegacyEntry, toAssetUrl } from './legacy_script_loader.js';

const sharedScripts = [
  '../core/xk_dom.js',
  '../core/xk_http.js',
  '../core/xk_storage.js',
  '../ui/shared_primitives.js',
  '../ui/modal.js',
  '../ui/confirm_modal.js',
  '../ui/theme.js?v=20260324b',
  '../ui/tooltips_auto.js?v=20260119d',
  '../util/helpers.js',
  '../runtime/lazy_runtime.js?v=20260324d',
  '../util/tab_id.js',
  '../util/ansi.js?v=20260302a',
  '../util/command_job.js',
  '../ui/spinner_fetch.js?v=20260317c',
];

const xrayScripts = [
  '../features/routing.js?v=20260324b',
  '../features/routing_jsonc_preserve.js?v=20260218d',
  '../features/routing_cards/ns.js?v=20260304d',
  '../features/routing_cards/ids.js?v=20260304d',
  '../features/routing_cards/common.js?v=20260304d',
  '../features/routing_cards/collapse.js?v=20260304d',
  '../features/routing_cards/dat/prefs.js?v=20260304d',
  '../features/routing_cards/dat/combo.js?v=20260304d',
  '../features/routing_cards/dat/api.js?v=20260304d',
  '../features/routing_cards/dat/card.js?v=20260304d',
  '../features/routing_cards/rules/state.js?v=20260313b',
  '../features/routing_cards/rules/model.js?v=20260308-stage3fix1',
  '../features/routing_cards/rules/detect.js?v=20260304j',
  '../features/routing_cards/rules/json_modal.js?v=20260304h4',
  '../features/routing_cards/rules/apply.js?v=20260308-stage3fix1',
  '../features/routing_cards/rules/fields.js?v=20260308-stage1',
  '../features/routing_cards/rules/dnd_pointer.js?v=20260308-stage3',
  '../features/routing_cards/rules/render.js?v=20260317a',
  '../features/routing_cards/rules/controls.js?v=20260317g',
  '../features/routing_cards/rules/dat_bridge.js?v=20260304h4',
  '../features/routing_cards.js?v=20260317a',
  '../features/local_io.js',
];

const mihomoScripts = [
  '../features/mihomo_panel.js?v=20260324c',
  '../features/mihomo_yaml_patch.js?v=20260302a',
];

const tailScripts = [
  '../features/update_notifier.js?v=20260220b',
  '../pages/panel.init.js?v=20260324d',
];

const urls = [
  ...sharedScripts,
  ...(window.XKEEN_HAS_XRAY ? xrayScripts : []),
  ...(window.XKEEN_HAS_MIHOMO ? mihomoScripts : []),
  ...tailScripts,
].map(toAssetUrl);

void bootLegacyEntry('panel', urls);
