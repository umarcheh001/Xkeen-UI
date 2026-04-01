import './shell.shared.js';
import './editor.shared.js';
import './codemirror6.shared.js';
import '../core/xk_dom.js';
import '../core/xk_http.js';
import '../core/xk_storage.js';
import '../ui/shared_primitives.js';
import '../features/update_notifier.js';
import '../ui/modal.js';
import '../ui/confirm_modal.js';
import '../ui/theme.js?v=20260324b';
import '../ui/tooltips_auto.js?v=20260119d';
import '../ui/monaco_loader.js?v=20260317b';
import '../ui/spinner_fetch.js';
import { bootBackupsPage } from './backups.init.js';

bootBackupsPage();
