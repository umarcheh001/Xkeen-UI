import './shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import '../core/xk_dom.js';
import '../core/xk_http.js';
import '../core/xk_storage.js';
import '../ui/shared_primitives.js';
import '../features/update_notifier.js';
import '../ui/theme.js?v=20260324b';
import '../ui/tooltips_auto.js?v=20260119d';
import '../ui/spinner_fetch.js';
import '../ui/modal.js';
import '../ui/confirm_modal.js';
import '../features/donate.js';
import '../features/typography.js';
import '../features/layout_prefs.js';
import '../features/branding_prefs.js';
import '../features/ui_prefs_io.js?v=20260101f';
import '../util/ansi.js';
import '../features/devtools/shared.js?v=20260109e';
import '../features/devtools/service.js?v=20260109e';
import '../features/devtools/logs.js?v=20260109e';
import '../features/devtools/env.js?v=20260109e';
import '../features/devtools/update.js?v=20260220a';
import '../features/devtools/terminal_theme.js?v=20260109e';
import { bootDevtoolsPage } from './devtools.init.js';
import { getDevtoolsApi } from '../features/devtools.js?v=20260219a';
import '../features/compat/devtools.js';

export async function bootDevtoolsScreen() {
  bootDevtoolsPage();
  return getDevtoolsApi();
}

export function getDevtoolsTopLevelApi() {
  return getDevtoolsApi();
}
