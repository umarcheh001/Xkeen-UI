import './shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import { bootLegacyEntry, toAssetUrl } from './legacy_script_loader.js';

const urls = [
  '../core/xk_dom.js',
  '../core/xk_http.js',
  '../core/xk_storage.js',
  '../ui/shared_primitives.js',
  '../features/update_notifier.js?v=20260220b',
  '../ui/modal.js',
  '../ui/confirm_modal.js',
  '../ui/theme.js?v=20260324b',
  '../ui/tooltips_auto.js?v=20260119d',
  '../ui/monaco_loader.js?v=20260317b',
  '../ui/spinner_fetch.js',
  '../features/backups.js?v=20260317b',
  '../pages/backups.init.js',
].map(toAssetUrl);

void bootLegacyEntry('backups', urls);
