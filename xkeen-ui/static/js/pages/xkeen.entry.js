import './shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import { bootLegacyEntry, toAssetUrl } from './legacy_script_loader.js';

const urls = [
  '../core/xk_dom.js',
  '../core/xk_http.js',
  '../core/xk_storage.js',
  '../features/update_notifier.js?v=20260220b',
  '../ui/theme.js?v=20260324b',
  '../ui/tooltips_auto.js?v=20260119d',
  '../util/helpers.js',
  '../ui/spinner_fetch.js',
  '../features/local_io.js',
  '../features/xkeen_texts.js?v=20260324a',
  '../pages/xkeen.init.js',
].map(toAssetUrl);

void bootLegacyEntry('xkeen', urls);
