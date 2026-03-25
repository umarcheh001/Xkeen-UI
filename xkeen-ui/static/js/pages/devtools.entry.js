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
  '../ui/theme.js?v=20260324b',
  '../ui/tooltips_auto.js?v=20260119d',
  '../ui/spinner_fetch.js',
  '../ui/modal.js',
  '../ui/confirm_modal.js',
  '../features/donate.js',
  '../features/typography.js?v=20251230c',
  '../features/layout_prefs.js?v=20260101c',
  '../features/branding_prefs.js?v=20260101f',
  '../features/ui_prefs_io.js?v=20260101f',
  '../util/ansi.js',
  '../features/devtools/shared.js?v=20260109e',
  '../features/devtools/service.js?v=20260109e',
  '../features/devtools/logs.js?v=20260109e',
  '../features/devtools/env.js?v=20260109e',
  '../features/devtools/update.js?v=20260220a',
  '../features/devtools/theme.js?v=20260110a',
  '../features/devtools/terminal_theme.js?v=20260109e',
  '../features/devtools/codemirror_theme.js?v=20260109e',
  '../features/devtools/custom_css.js?v=20260325a',
  '../features/devtools.js?v=20260219a',
  '../pages/devtools.init.js',
].map(toAssetUrl);

void bootLegacyEntry('devtools', urls);
