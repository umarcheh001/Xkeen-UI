import './shell.shared.js';
import './editor.shared.js';
import './editor_monaco.shared.js';
import './codemirror6.shared.js';
import '../core/xk_dom.js';
import '../core/xk_http.js';
import '../core/xk_storage.js';
import '../features/update_notifier.js';
import '../ui/modal.js';
import '../ui/theme.js?v=20260324b';
import '../ui/tooltips_auto.js?v=20260119d';
import '../util/helpers.js';
import '../util/command_job.js';
import '../ui/spinner_fetch.js';
import { bootMihomoGeneratorPage } from './mihomo_generator.init.js';
import { bootTopLevelShell } from './top_level_shell.shared.js';

void bootTopLevelShell({
  initialScreen: 'mihomo_generator',
  bootstrap() {
    bootMihomoGeneratorPage();
  },
});
