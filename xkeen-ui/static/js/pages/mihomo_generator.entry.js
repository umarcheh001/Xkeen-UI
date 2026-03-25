import './shell.shared.js';
import './editor.shared.js';
import './editor_monaco.shared.js';
import './codemirror6.shared.js';
import { bootLegacyEntry, toAssetUrl } from './legacy_script_loader.js';

const urls = [
  '../core/xk_dom.js',
  '../core/xk_http.js',
  '../core/xk_storage.js',
  '../features/update_notifier.js?v=20260220b',
  '../ui/modal.js',
  '../ui/theme.js?v=20260324b',
  '../ui/tooltips_auto.js?v=20260119d',
  '../util/helpers.js',
  '../util/command_job.js',
  '../ui/spinner_fetch.js',
  '../features/mihomo_generator.js?v=20260325b',
  '../pages/mihomo_generator.init.js?v=20260325a',
].map(toAssetUrl);

void bootLegacyEntry('mihomo-generator', urls);
