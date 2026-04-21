from pathlib import Path
import shutil
import re

import pytest

def test_terminal_debug_module_exists_and_exports_expected_helpers():
    path = Path('xkeen-ui/static/js/features/terminal_debug.js')
    text = path.read_text(encoding='utf-8')

    assert 'export function appendTerminalDebug' in text
    assert 'export function markTerminalDebugState' in text
    assert 'export function startTerminalDebugRun' in text
    assert 'export function finishTerminalDebugRun' in text


def test_update_notifier_postjson_sends_csrf_header():
    path = Path('xkeen-ui/static/js/features/update_notifier.js')
    text = path.read_text(encoding='utf-8')

    assert "meta[name=\"csrf-token\"]" in text
    assert "headers['X-CSRF-Token'] = csrf" in text


def test_devtools_postjson_uses_single_request_path_and_keeps_csrf_on_raw_fallback():
    devtools_text = Path('xkeen-ui/static/js/features/devtools/shared.js').read_text(encoding='utf-8')
    ui_text = Path('xkeen-ui/static/js/ui/shared_primitives.js').read_text(encoding='utf-8')

    devtools_body = devtools_text.split('async function postJSON(url, body) {', 1)[1].split('\n\n  function byId', 1)[0]
    ui_body = ui_text.split('async function postJSON(url, body, options) {', 1)[1].split('\n\n  function wireCollapsibleState', 1)[0]

    assert "try {\n      if (UI && typeof UI.postJSON === 'function')" not in devtools_body
    assert "try {\n      if (CORE_HTTP && typeof CORE_HTTP.postJSON === 'function')" not in ui_body
    assert "headers.set('X-CSRF-Token', csrf);" in devtools_body
    assert "headers.set('X-CSRF-Token', csrf);" in ui_body


def test_devtools_whitelist_tokens_keep_update_and_branding_reachable_in_restrictive_setups():
    template = Path('xkeen-ui/templates/devtools.html').read_text(encoding='utf-8')
    env_text = Path('xkeen-ui/static/js/features/devtools/env.js').read_text(encoding='utf-8')

    assert 'id="dt-update-card" data-xk-section="service update dt-update-card"' in template
    assert 'id="dt-branding-card" data-xk-section="ui branding dt-branding-card"' in template
    assert 'tools,logs,service,update,logging,ui,branding,layout,theme,css,env' in env_text


def test_devtools_env_help_button_keeps_required_modal_shell_ids():
    template = Path('xkeen-ui/templates/devtools.html').read_text(encoding='utf-8')
    env_text = Path('xkeen-ui/static/js/features/devtools/env.js').read_text(encoding='utf-8')

    assert 'id="dt-env-help-btn"' in template
    assert 'id="dt-env-help-modal"' in template
    assert 'id="dt-env-help-body"' in template
    assert 'id="dt-env-help-close-btn"' in template
    assert 'id="dt-env-help-ok-btn"' in template
    assert "const modal = byId('dt-env-help-modal');" in env_text
    assert "const body = byId('dt-env-help-body');" in env_text


def test_settings_panel_logout_redirects_to_login_after_api_logout():
    text = Path('xkeen-ui/static/js/ui/settings_panel.js').read_text(encoding='utf-8')

    assert "function getLogoutRedirectHref() {" in text
    assert "return '/login';" in text
    assert "document.querySelector('.xk-header-btn-logout[href]')" not in text
    assert "window.location.assign(getLogoutRedirectHref());" in text


def test_mihomo_generator_ignores_stale_profile_defaults_and_auto_preview_overwrites():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'let _previewRequestSeq = 0;' in text
    assert 'let _profileDefaultsRequestSeq = 0;' in text
    assert 'if (_isEditable) {' in text
    assert 'setStatus(getEditablePreviewDirtyMessage(), "warn");' in text
    assert 'const requestSeq = ++_profileDefaultsRequestSeq;' in text
    assert 'const currentProfile = (profileSelect && profileSelect.value) || "router_custom";' in text
    assert 'if (requestSeq !== _profileDefaultsRequestSeq) return;' in text
    assert 'if (String(currentProfile || "router_custom") !== String(p || "router_custom")) return;' in text
    assert 'const requestSeq = ++_previewRequestSeq;' in text
    assert 'if (!manual && _isEditable) return;' in text
    assert text.count('if (requestSeq !== _previewRequestSeq) return;') >= 2


def test_mihomo_generator_tracks_dirty_preview_state_while_manual_editing_is_enabled():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'let _previewDirtyWhileEditable = false;' in text
    assert 'function syncStateSummaryFromInputs() {' in text
    assert 'function getEditablePreviewDirtyMessage() {' in text
    assert 'try { syncStateSummaryFromInputs(); } catch (e) {}' in text
    assert '_previewDirtyWhileEditable = true;' in text
    assert 'setStatus(getEditablePreviewDirtyMessage(), "warn");' in text
    assert 'previewDirty: !!_previewDirtyWhileEditable,' in text
    assert '_previewDirtyWhileEditable = !!draft.previewDirty;' in text
    assert 'if (_previewDirtyWhileEditable) {' in text


def test_mihomo_generator_rebuilds_preview_after_exiting_manual_edit_mode_with_stale_inputs():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'const wasEditable = _isEditable;' in text
    assert "setStatus('Редактирование выключено. Пересобираю YAML из исходных данных…', 'warn');" in text
    assert 'if (!_isEditable && wasEditable && _previewDirtyWhileEditable) {' in text
    assert 'try { schedulePreview(90); } catch (e) {}' in text


def test_mihomo_generator_preserves_explicit_empty_rule_group_selection():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'state.enabledRuleGroups = enabledRuleGroups;' in text
    assert 'if (enabledRuleGroups.length) state.enabledRuleGroups = enabledRuleGroups;' not in text
    assert 'if (Array.isArray(_pendingSessionRuleGroups)) {' in text
    assert 'if (Array.isArray(_pendingSessionRuleGroups) && _pendingSessionRuleGroups.length) {' not in text


def test_mihomo_generator_initializes_preview_toolbar_without_engine_toggle():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert "try { enhanceEditorOptions(); } catch (e) {}" in text
    assert "try { attachPreviewToolbar(); } catch (e) {}" in text
    assert text.index("try { attachPreviewToolbar(); } catch (e) {}") < text.index("try { wireLazyPreviewToolbar(); } catch (e) {}")


def test_mihomo_result_modal_collapses_empty_log_column_and_uses_compact_sections():
    script = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')
    template = Path('xkeen-ui/templates/mihomo_generator.html').read_text(encoding='utf-8')

    assert 'const mihomoResultGrid = document.getElementById("mihomoResultGrid");' in script
    assert 'const mihomoResultSidePanel = document.getElementById("mihomoResultSidePanel");' in script
    assert "if (mihomoResultSidePanel) mihomoResultSidePanel.style.display = hasLog ? '' : 'none';" in script
    assert "if (mihomoResultGrid && mihomoResultGrid.dataset) mihomoResultGrid.dataset.hasLog = hasLog ? '1' : '0';" in script
    assert "return '<div class=\"mihomo-result-list\">' + itemsHtml + '</div>';" in script

    assert 'id="mihomoResultGrid"' in template
    assert 'id="mihomoResultSidePanel"' in template
    assert 'class="mihomo-result-overview"' in template
    assert '.mihomo-result-grid[data-has-log="0"] {' in template
    assert '.mihomo-result-log-shell {' in template


def test_mihomo_result_modal_supports_compact_validate_mode():
    script = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')
    template = Path('xkeen-ui/templates/mihomo_generator.html').read_text(encoding='utf-8')

    assert 'function normalizeResultMode(rawMode, action) {' in script
    assert "try { mihomoResultModal.dataset.mode = normalizedMode; } catch (e) {}" in script
    assert "mode: 'validate'," in script
    assert '#mihomoResultModal[data-mode="validate"] .modal-content {' in template
    assert '#mihomoResultModal[data-mode="validate"] .mihomo-result-grid {' in template
    assert '#mihomoResultModal[data-mode="validate"] .mihomo-result-meta-grid {' in template
    assert '#mihomoResultModal[data-mode="validate"] .mihomo-result-terminal {' in template


def test_top_level_navigation_controls_use_shared_helper_contract():
    helper = Path('xkeen-ui/static/js/pages/top_level_nav.shared.js').read_text(encoding='utf-8')
    shell = Path('xkeen-ui/static/js/pages/top_level_shell.shared.js').read_text(encoding='utf-8')
    router = Path('xkeen-ui/static/js/pages/top_level_router.js').read_text(encoding='utf-8')
    registry = Path('xkeen-ui/static/js/pages/top_level_screen_registry.js').read_text(encoding='utf-8')
    host = Path('xkeen-ui/static/js/pages/top_level_screen_host.shared.js').read_text(encoding='utf-8')
    panel_screen = Path('xkeen-ui/static/js/pages/top_level_panel_screen.js').read_text(encoding='utf-8')
    backups_screen = Path('xkeen-ui/static/js/pages/top_level_backups_screen.js').read_text(encoding='utf-8')
    mihomo_screen = Path('xkeen-ui/static/js/pages/top_level_mihomo_generator_screen.js').read_text(encoding='utf-8')
    devtools_screen = Path('xkeen-ui/static/js/pages/top_level_devtools_screen.js').read_text(encoding='utf-8')
    xkeen_screen = Path('xkeen-ui/static/js/pages/top_level_xkeen_screen.js').read_text(encoding='utf-8')
    panel_mihomo_shared = Path('xkeen-ui/static/js/pages/top_level_panel_mihomo.shared.js').read_text(encoding='utf-8')
    panel_shell = Path('xkeen-ui/static/js/pages/panel_shell.shared.js').read_text(encoding='utf-8')
    panel_entry = Path('xkeen-ui/static/js/pages/panel.entry.js').read_text(encoding='utf-8')
    backups_entry = Path('xkeen-ui/static/js/pages/backups.entry.js').read_text(encoding='utf-8')
    devtools_entry = Path('xkeen-ui/static/js/pages/devtools.entry.js').read_text(encoding='utf-8')
    xkeen_entry = Path('xkeen-ui/static/js/pages/xkeen.entry.js').read_text(encoding='utf-8')
    mihomo_entry = Path('xkeen-ui/static/js/pages/mihomo_generator.entry.js').read_text(encoding='utf-8')
    backups_bootstrap = Path('xkeen-ui/static/js/pages/backups.screen.bootstrap.js').read_text(encoding='utf-8')
    devtools_bootstrap = Path('xkeen-ui/static/js/pages/devtools.screen.bootstrap.js').read_text(encoding='utf-8')
    xkeen_bootstrap = Path('xkeen-ui/static/js/pages/xkeen.screen.bootstrap.js').read_text(encoding='utf-8')
    backups_init = Path('xkeen-ui/static/js/pages/backups.init.js').read_text(encoding='utf-8')
    devtools_init = Path('xkeen-ui/static/js/pages/devtools.init.js').read_text(encoding='utf-8')
    xkeen_init = Path('xkeen-ui/static/js/pages/xkeen.init.js').read_text(encoding='utf-8')
    mihomo_init = Path('xkeen-ui/static/js/pages/mihomo_generator.init.js').read_text(encoding='utf-8')
    panel_template = Path('xkeen-ui/templates/panel.html').read_text(encoding='utf-8')
    backups_template = Path('xkeen-ui/templates/backups.html').read_text(encoding='utf-8')
    devtools_template = Path('xkeen-ui/templates/devtools.html').read_text(encoding='utf-8')
    xkeen_template = Path('xkeen-ui/templates/xkeen.html').read_text(encoding='utf-8')
    mihomo_template = Path('xkeen-ui/templates/mihomo_generator.html').read_text(encoding='utf-8')

    assert 'export function navigateTopLevelHref(rawHref, opts)' in helper
    assert "window.dispatchEvent(new CustomEvent('xkeen:top-level-nav-intent'" in helper
    assert "import { getTopLevelRouterApi } from './top_level_router.js';" in helper
    assert "const router = getTopLevelRouterApi();" in helper
    assert "router.navigate(resolved, opts || {})" in helper
    assert "const nodes = scope.querySelectorAll('[data-xk-top-nav]');" in helper
    assert 'export async function bootTopLevelShell(opts)' in shell
    assert "registry.registerScreen(name, screen);" in shell
    assert 'export function getTopLevelRouterApi()' in router
    assert 'const ROUTE_CHANGE_EVENT = \'xkeen:top-level-route-change\';' in router
    assert "xk.topLevel = xk.topLevel && typeof xk.topLevel === 'object' ? xk.topLevel : {};" in router
    assert 'export function getTopLevelScreenRegistryApi()' in registry
    assert "panel: '/'" in registry
    assert "backups: '/backups'" in registry
    assert "devtools: '/devtools'" in registry
    assert "xkeen: '/xkeen'" in registry
    assert "mihomo_generator: '/mihomo_generator'" in registry
    assert 'export function ensureTopLevelScreenMount()' in host
    assert 'export async function fetchTopLevelScreenSnapshot(name, route)' in host
    assert 'export function registerPanelTopLevelScreen()' in panel_screen
    assert "fetchTopLevelScreenSnapshot('panel', '/')" in panel_screen
    assert 'export function registerBackupsTopLevelScreen()' in backups_screen
    assert "fetchTopLevelScreenSnapshot('backups', '/backups')" in backups_screen
    assert 'export function registerMihomoGeneratorTopLevelScreen()' in mihomo_screen
    assert "fetchTopLevelScreenSnapshot('mihomo_generator', '/mihomo_generator')" in mihomo_screen
    assert 'export function registerDevtoolsTopLevelScreen()' in devtools_screen
    assert "fetchTopLevelScreenSnapshot('devtools', '/devtools')" in devtools_screen
    assert 'export function registerXkeenTopLevelScreen()' in xkeen_screen
    assert "fetchTopLevelScreenSnapshot('xkeen', '/xkeen')" in xkeen_screen
    assert 'export function registerPanelMihomoTopLevelScreens()' in panel_mihomo_shared
    assert 'export function registerCanonicalTopLevelScreens()' in panel_mihomo_shared
    assert "const GLOBAL_BODY_NODE_IDS = new Set(['xk-tooltip-portal']);" in host
    assert 'function shouldKeepBodyNodeGlobal(node) {' in host
    assert 'if (shouldKeepBodyNodeGlobal(node)) return false;' in host
    assert "import { registerBackupsTopLevelScreen } from './top_level_backups_screen.js';" in panel_mihomo_shared
    assert "import { registerDevtoolsTopLevelScreen } from './top_level_devtools_screen.js';" in panel_mihomo_shared
    assert "import { registerXkeenTopLevelScreen } from './top_level_xkeen_screen.js';" in panel_mihomo_shared
    assert "'backups'," in panel_mihomo_shared
    assert "'xkeen'," in panel_mihomo_shared
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in panel_shell
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in panel_entry
    assert "import { bootPanelScreen } from './panel.screen.bootstrap.js';" in panel_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in panel_entry
    assert "initialScreen: 'panel'" in panel_entry
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in backups_entry
    assert "import { bootBackupsScreen } from './backups.screen.bootstrap.js';" in backups_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in backups_entry
    assert "initialScreen: 'backups'" in backups_entry
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in devtools_entry
    assert "import { bootDevtoolsScreen } from './devtools.screen.bootstrap.js';" in devtools_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in devtools_entry
    assert "initialScreen: 'devtools'" in devtools_entry
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in xkeen_entry
    assert "import { bootXkeenScreen } from './xkeen.screen.bootstrap.js';" in xkeen_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in xkeen_entry
    assert "initialScreen: 'xkeen'" in xkeen_entry
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in mihomo_entry
    assert "import { bootMihomoGeneratorScreen } from './mihomo_generator.screen.bootstrap.js';" in mihomo_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in mihomo_entry
    assert "initialScreen: 'mihomo_generator'" in mihomo_entry
    assert 'export async function bootBackupsScreen()' in backups_bootstrap
    assert 'export async function bootDevtoolsScreen()' in devtools_bootstrap
    assert 'export async function bootXkeenScreen()' in xkeen_bootstrap
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in backups_init
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in devtools_init
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in xkeen_init
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in mihomo_init
    assert panel_template.count('data-xk-top-nav="1"') >= 3
    assert backups_template.count('data-xk-top-nav="1"') >= 3
    assert 'data-xk-top-nav="1"' in devtools_template
    assert xkeen_template.count('data-xk-top-nav="1"') >= 3
    assert mihomo_template.count('data-xk-top-nav="1"') >= 3


def test_bfcache_lifecycle_uses_pagehide_instead_of_beforeunload_for_p0_paths():
    routing = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')
    xray_logs = Path('xkeen-ui/static/js/features/xray_logs.js').read_text(encoding='utf-8')

    assert 'beforeunload' not in routing
    assert 'beforeunload' not in xray_logs
    assert "window.addEventListener('pagehide'" in routing
    assert "window.addEventListener('pagehide'" in xray_logs
    assert "document.addEventListener('visibilitychange'" in xray_logs


def test_devtools_host_defers_noncritical_init_and_mihomo_generator_persists_session_draft():
    devtools_host = Path('xkeen-ui/static/js/features/devtools.js').read_text(encoding='utf-8')
    devtools_logs = Path('xkeen-ui/static/js/features/devtools/logs.js').read_text(encoding='utf-8')
    mihomo = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert "_initModuleOnce('logs', 'devtoolsLogs', { deferInitialFetch: true });" in devtools_host
    assert "_wireDeferredModuleInit('update', 'devtoolsUpdate', 'dt-update-card'" in devtools_host
    assert "_wireDeferredModuleInit('env', 'devtoolsEnv', 'dt-env-card'" in devtools_host
    assert "_wireDeferredModuleInit('terminalTheme', 'devtoolsTerminalTheme', 'dt-terminal-theme-card'" in devtools_host
    assert "if (!initOptions.deferInitialFetch)" in devtools_logs
    assert "try { loadLogList(true); } catch (e) {}" in devtools_logs

    assert 'const SESSION_DRAFT_KEY = "xk.mihomo_generator.session_draft.v1";' in mihomo
    assert 'window.sessionStorage.setItem(SESSION_DRAFT_KEY, JSON.stringify(payload));' in mihomo
    assert 'function hydrateSessionDraft(draft) {' in mihomo
    assert 'async function finalizeSessionDraftRestore(draft) {' in mihomo


def test_p2_panel_mihomo_screen_modules_keep_runtime_alive_between_activations():
    mihomo = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')
    panel_bootstrap = Path('xkeen-ui/static/js/pages/panel.screen.bootstrap.js').read_text(encoding='utf-8')
    mihomo_bootstrap = Path('xkeen-ui/static/js/pages/mihomo_generator.screen.bootstrap.js').read_text(encoding='utf-8')
    panel_screen = Path('xkeen-ui/static/js/pages/top_level_panel_screen.js').read_text(encoding='utf-8')
    mihomo_screen = Path('xkeen-ui/static/js/pages/top_level_mihomo_generator_screen.js').read_text(encoding='utf-8')

    assert 'function refreshLayout() {' in mihomo
    assert 'async function activate(opts = {}) {' in mihomo
    assert 'function deactivate() {' in mihomo
    assert 'function serializeState() {' in mihomo
    assert 'async function restoreState(state) {' in mihomo
    assert 'const lifecycleApi = {' in mihomo
    assert "activate(...args) { return callLifecycle('activate', ...args); }" in mihomo
    assert "deactivate(...args) { return callLifecycle('deactivate', ...args); }" in mihomo
    assert "serializeState(...args) { return callLifecycle('serializeState', ...args); }" in mihomo
    assert "restoreState(...args) { return callLifecycle('restoreState', ...args); }" in mihomo
    assert "refreshLayout(...args) { return callLifecycle('refreshLayout', ...args); }" in mihomo

    assert 'export async function bootPanelScreen()' in panel_bootstrap
    assert 'export async function bootMihomoGeneratorScreen()' in mihomo_bootstrap
    assert 'serializedState = runtimeApi.serializeState(context);' in panel_screen
    assert 'serializedState = await runtimeApi.serializeState(context);' in mihomo_screen
    assert 'attachScreenRoot(nextSnapshot);' in panel_screen
    assert 'attachScreenRoot(nextSnapshot);' in mihomo_screen
    assert "window.XKeen?.pageConfig?.page === 'panel'" in panel_screen
    assert "window.XKeen?.pageConfig?.page === 'mihomo_generator'" in mihomo_screen
    assert "String(window.location.pathname || '') === '/'" not in panel_screen
    assert "String(window.location.pathname || '') === '/mihomo_generator'" not in mihomo_screen
    assert 'window.addEventListener("pagehide", () => persist("pagehide"));' in mihomo
    assert 'try { hydrateSessionDraft(initialSessionDraft); } catch (e) {}' in mihomo
    assert 'try { await finalizeSessionDraftRestore(initialSessionDraft); } catch (e) {}' in mihomo


def test_p3_devtools_screen_module_keeps_host_alive_and_stops_background_tasks_on_deactivate():
    devtools = Path('xkeen-ui/static/js/features/devtools.js').read_text(encoding='utf-8')
    logs = Path('xkeen-ui/static/js/features/devtools/logs.js').read_text(encoding='utf-8')
    update = Path('xkeen-ui/static/js/features/devtools/update.js').read_text(encoding='utf-8')
    bootstrap = Path('xkeen-ui/static/js/pages/devtools.screen.bootstrap.js').read_text(encoding='utf-8')
    screen = Path('xkeen-ui/static/js/pages/top_level_devtools_screen.js').read_text(encoding='utf-8')
    entry = Path('xkeen-ui/static/js/pages/devtools.entry.js').read_text(encoding='utf-8')

    assert 'function getActiveTab() {' in devtools
    assert 'function activate(state) {' in devtools
    assert 'function deactivate() {' in devtools
    assert 'function serializeState() {' in devtools
    assert 'function restoreState(state) {' in devtools
    assert "if (logs && typeof logs.activate === 'function')" in devtools
    assert "if (update && typeof update.deactivate === 'function') update.deactivate();" in devtools

    assert 'function getActiveTab() {' in logs
    assert 'async function openLog(name, opts) {' in logs
    assert 'function activate(options) {' in logs
    assert 'function deactivate() {' in logs
    assert 'try { _stopLogStreamingAll(); } catch (e) {}' in logs
    assert 'try { stopLogListPolling(); } catch (e) {}' in logs
    assert 'getActiveTab,' in logs
    assert 'openLog,' in logs
    assert 'activate,' in logs
    assert 'deactivate,' in logs

    assert 'function activate() {' in update
    assert 'function deactivate() {' in update
    assert "logs.openLog('update')" in update
    assert '_stopPolling();' in update
    assert 'loadStatus(true).catch(() => {});' in update

    assert 'export async function bootDevtoolsScreen()' in bootstrap
    assert "import { getDevtoolsApi } from '../features/devtools.js?v=20260219a';" in bootstrap
    assert 'export function getDevtoolsTopLevelApi()' in bootstrap

    assert 'export function registerDevtoolsTopLevelScreen()' in screen
    assert "fetchTopLevelScreenSnapshot('devtools', '/devtools')" in screen
    assert 'attachScreenRoot(nextSnapshot);' in screen
    assert 'serializedState = runtimeApi.serializeState(context);' in screen
    assert "window.XKeen?.pageConfig?.page === 'devtools'" in screen

    assert "import { bootDevtoolsScreen } from './devtools.screen.bootstrap.js';" in entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in entry


def test_devtools_update_blocked_runs_render_inline_diagnostics_and_stop_retry_launch():
    text = Path('xkeen-ui/static/js/features/devtools/update.js').read_text(encoding='utf-8')

    assert 'function _showBlockedUpdateReason(btnRun) {' in text
    assert 'function _buildClientSideCheckFailureData(error) {' in text
    assert "toastKind(blockedSummary + ' Подробности показаны в карточке обновления.', 'error');" in text
    assert '_scrollToUpdateSecurityBox();' in text
    assert "const failureData = _buildClientSideCheckFailureData(e);" in text
    assert 'state.lastCheck = failureData;' in text
    assert '_renderCheck(failureData);' in text
    assert 'if (_showBlockedUpdateReason(btnRun)) return;' in text
    assert 'Сломалась не установка, а предварительная проверка обновления' in text
    assert 'Частая причина: GitHub, GitHub API или release asset URLs недоступны с роутера' in text


def test_file_manager_monaco_modal_tracks_modal_resize_and_fills_available_height():
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')
    editor = Path('xkeen-ui/static/js/features/file_manager/editor.js').read_text(encoding='utf-8')

    monaco_block = styles.split('#fm-editor-modal #fm-editor-monaco {', 1)[1].split('}', 1)[0]

    assert 'flex: 1 1 auto;' in monaco_block
    assert 'min-height: 0;' in monaco_block
    assert 'height: 100%;' in monaco_block

    assert 'function layoutMonacoSoon(ui, focus = false) {' in editor
    assert "document.addEventListener('xkeen-modal-resize', (event) => {" in editor
    assert "modalId && modalId !== 'fm-editor-modal'" in editor
    assert "if (!STATE.ctx || STATE.activeKind !== 'monaco') return;" in editor
    assert 'layoutMonacoSoon(els());' in editor
    assert 'layoutMonacoSoon(ui, true);' in editor


def test_json_editor_modal_tracks_modal_resize_and_stretches_monaco_and_cm6_hosts():
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')
    editor = Path('xkeen-ui/static/js/ui/json_editor_modal.js').read_text(encoding='utf-8')

    monaco_block = styles.split('#json-editor-modal #json-editor-monaco {', 1)[1].split('}', 1)[0]
    cm6_block = styles.split('#json-editor-modal .xkeen-cm6-host,\n#fm-editor-modal .xkeen-cm6-host {', 1)[1].split('}', 1)[0]

    assert 'flex: 1 1 auto;' in monaco_block
    assert 'min-height: 0;' in monaco_block
    assert 'height: 100%;' in monaco_block
    assert 'max-height: none;' in monaco_block

    assert '#json-editor-modal .modal-body > .xk-editor-toolbar,' in styles
    assert '#json-editor-modal .xkeen-cm6-host,' in styles
    assert '#json-editor-modal .xkeen-cm6-host .cm-scroller,' in styles
    assert 'flex: 1 1 auto;' in cm6_block
    assert 'width: 100%;' in cm6_block
    assert 'max-height: none;' in cm6_block

    assert 'let _modalResizeWired = false;' in editor
    assert 'function layoutEditorSoon(focus = false) {' in editor
    assert "document.addEventListener('xkeen-modal-resize', (event) => {" in editor
    assert "modalId && modalId !== 'json-editor-modal'" in editor
    assert 'layoutEditorSoon();' in editor
    assert 'layoutEditorSoon(true);' in editor


def test_codemirror6_source_bridge_is_opt_in_and_does_not_inject_importmap_dynamically():
    path = Path('xkeen-ui/static/js/pages/codemirror6.shared.js')
    text = path.read_text(encoding='utf-8')

    assert 'data-xkeen-cm6-importmap="1"' in text
    assert "document.createElement(\'script\')" not in text
    assert "script.type = 'importmap'" not in text
    assert "backend: 'cm6-unavailable'" in text
    assert "ensureSkippedRuntime('importmap-missing')" in text


def test_codemirror6_importmap_template_exists_and_maps_required_packages():
    path = Path('xkeen-ui/templates/_codemirror6_importmap.html')
    text = path.read_text(encoding='utf-8')

    assert 'type="importmap"' in text
    assert 'data-xkeen-cm6-importmap="1"' in text
    assert "vendor/npm/@codemirror/state/dist/index.js" in text
    assert "vendor/npm/@codemirror/view/dist/index.js" in text
    assert "vendor/npm/codemirror/dist/index.js" in text
    assert "vendor/npm/jsonc-parser/lib/esm/main.js" in text
    assert "vendor/npm/style-mod/src/style-mod.js" in text
    assert "vendor/npm/w3c-keyname/index.js" in text
    assert "codemirror-json-schema" in text
    assert "js/vendor/codemirror_json_schema.js" in text
    assert "vendor/npm/codemirror-json-schema" not in text


def test_codemirror6_json_schema_bridge_is_tracked_and_wired_to_xray_editors():
    importmap = Path('xkeen-ui/templates/_codemirror6_importmap.html').read_text(encoding='utf-8')
    shim_path = Path('xkeen-ui/static/js/vendor/codemirror_json_schema.js')
    schema_loader_path = Path('xkeen-ui/static/js/ui/editor_schema.js')
    fragment_schema_paths = [
        Path('xkeen-ui/static/schemas/xray-routing.schema.json'),
        Path('xkeen-ui/static/schemas/xray-inbounds.schema.json'),
        Path('xkeen-ui/static/schemas/xray-outbounds.schema.json'),
    ]
    boot = Path('xkeen-ui/static/js/ui/codemirror6_boot.js').read_text(encoding='utf-8')
    json_modal = Path('xkeen-ui/static/js/ui/json_editor_modal.js').read_text(encoding='utf-8')
    routing = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')
    vite = Path('vite.config.mjs').read_text(encoding='utf-8')
    schema_loader = schema_loader_path.read_text(encoding='utf-8')
    schema_shim = shim_path.read_text(encoding='utf-8')

    assert shim_path.is_file()
    assert schema_loader_path.is_file()
    for fragment_schema_path in fragment_schema_paths:
        assert fragment_schema_path.is_file()
        assert '"anyOf"' in fragment_schema_path.read_text(encoding='utf-8')
    assert "js/vendor/codemirror_json_schema.js" in importmap
    assert "xray-routing.schema.json" in schema_loader
    assert "xray-inbounds.schema.json" in schema_loader
    assert "xray-outbounds.schema.json" in schema_loader
    assert "adaptXraySchema" not in schema_loader
    assert "parse as parseJsonc" in schema_shim
    assert "function pointerLabel" in schema_shim
    assert "function renderPropertiesSummary" in schema_shim
    assert "function renderArrayItemsSummary" in schema_shim
    assert "поля:" in schema_shim
    assert "элементы:" in schema_shim
    assert "jsonSchemaWithSyntaxLinter" in boot
    assert "jsonSchemaSyntaxAwareHover" in boot
    assert "isSchemaHoverTarget" in boot
    assert "!/[{}\\[\\]:,]/.test(ch)" in boot
    assert "makeJsonDiagnostics(source" in boot
    assert "__xkeenCm6Bridge: true" in boot
    assert "__xkeen_cm6_bridge: true" in boot
    assert "schemaUpdateSchema(view, schema)" in boot
    assert "setSchema(editor, schema)" in boot
    assert "applySchemaToEditor(_cm" in json_modal
    assert "__xkeenCm6Bridge === true" in json_modal
    assert "target: 'routing'" in routing
    assert "target: _routingMode === 'routing' ? 'routing' : 'xray'" in routing
    assert "await applyRoutingSchemaToCodeMirror(_cm, text)" in routing
    assert "'codemirror-json-schema'" in vite


def test_runtime_vendor_assets_exist_after_frontend_build():
    required = [
        Path('xkeen-ui/static/vendor/npm/@codemirror/state/dist/index.js'),
        Path('xkeen-ui/static/vendor/npm/@codemirror/view/dist/index.js'),
        Path('xkeen-ui/static/vendor/npm/codemirror/dist/index.js'),
        Path('xkeen-ui/static/vendor/npm/jsonc-parser/lib/esm/main.js'),
        Path('xkeen-ui/static/vendor/npm/style-mod/src/style-mod.js'),
        Path('xkeen-ui/static/vendor/npm/w3c-keyname/index.js'),
        Path('xkeen-ui/static/vendor/prettier/standalone.js'),
        Path('xkeen-ui/static/vendor/prettier/plugins/babel.js'),
        Path('xkeen-ui/static/vendor/prettier/plugins/estree.js'),
        Path('xkeen-ui/static/vendor/prettier/plugins/yaml.js'),
    ]

    if shutil.which('npm') is None and not any(path.exists() for path in required):
        pytest.skip('npm/vendor assets are not available in this environment')

    missing = [str(path) for path in required if not path.is_file()]
    assert not missing, f"frontend runtime vendor assets are missing after build:\n" + "\n".join(missing)


def test_runtime_vendor_esm_imports_are_browser_safe():
    vendor_root = Path('xkeen-ui/static/vendor/npm')
    pattern_specs = [
        re.compile(r"""\bfrom\s*["'](\.{1,2}/[^"'?#]+(?:[?#][^"']*)?)["']"""),
        re.compile(r"""^\s*import\s*["'](\.{1,2}/[^"'?#]+(?:[?#][^"']*)?)["']""", re.MULTILINE),
        re.compile(r"""\bimport\s*\(\s*["'](\.{1,2}/[^"'?#]+(?:[?#][^"']*)?)["']\s*\)"""),
    ]
    known_extensions = ('.js', '.mjs', '.cjs', '.json', '.node')

    if shutil.which('npm') is None and not vendor_root.exists():
        pytest.skip('npm/vendor assets are not available in this environment')

    offenders = []
    for path in vendor_root.rglob('*'):
        if not path.is_file() or path.suffix not in {'.js', '.mjs'}:
            continue
        text = path.read_text(encoding='utf-8')
        for pattern in pattern_specs:
            for match in pattern.finditer(text):
                specifier = match.group(1).strip()
                base_specifier = re.split(r'[?#]', specifier, maxsplit=1)[0]
                if base_specifier.endswith(known_extensions):
                    continue
                offenders.append(f"{path.as_posix()} :: {specifier}")

    assert not offenders, (
        'frontend runtime vendor contains browser-unsafe relative ESM imports without file extensions:\n'
        + '\n'.join(offenders[:20])
    )

def test_source_mode_templates_include_codemirror6_importmap_before_entry_module():
    templates = [
        'xkeen-ui/templates/panel.html',
        'xkeen-ui/templates/devtools.html',
        'xkeen-ui/templates/xkeen.html',
        'xkeen-ui/templates/backups.html',
        'xkeen-ui/templates/mihomo_generator.html',
    ]

    for rel in templates:
        text = Path(rel).read_text(encoding='utf-8')
        include_marker = "{% include '_codemirror6_importmap.html' %}"
        module_marker = 'frontend_page_entry_url('

        assert include_marker in text, rel
        assert module_marker in text, rel
        assert text.index(include_marker) < text.index(module_marker), rel


def test_p4_top_level_templates_share_host_partials_without_forcing_single_template_merge():
    partials = {
        'xkeen-ui/templates/_top_level_host_head_assets.html': [
            "favicon.ico",
            "js/ui/typography.js",
            "js/ui/layout.js",
            "js/ui/xk_brand.js",
        ],
        'xkeen-ui/templates/_top_level_host_theme_bootstrap.html': [
            "localStorage.getItem('xkeen-theme')",
            "document.documentElement.style.colorScheme = theme;",
        ],
        'xkeen-ui/templates/_top_level_global_spinner.html': [
            "id=\"global-xkeen-spinner\"",
            "id=\"global-xkeen-spinner-text\"",
            "top_level_spinner_text",
        ],
    }
    template_expectations = {
        'xkeen-ui/templates/panel.html': [
            "{% include '_top_level_host_head_assets.html' %}",
            "{% include '_top_level_host_theme_bootstrap.html' %}",
            "{% include '_top_level_global_spinner.html' %}",
        ],
        'xkeen-ui/templates/devtools.html': [
            "{% include '_top_level_host_head_assets.html' %}",
            "{% include '_top_level_host_theme_bootstrap.html' %}",
            "{% include '_top_level_global_spinner.html' %}",
        ],
        'xkeen-ui/templates/backups.html': [
            "{% include '_top_level_host_head_assets.html' %}",
            "{% include '_top_level_host_theme_bootstrap.html' %}",
            "{% include '_top_level_global_spinner.html' %}",
        ],
        'xkeen-ui/templates/xkeen.html': [
            "{% include '_top_level_host_head_assets.html' %}",
            "{% include '_top_level_host_theme_bootstrap.html' %}",
            "{% include '_top_level_global_spinner.html' %}",
        ],
        'xkeen-ui/templates/mihomo_generator.html': [
            "{% include '_top_level_host_head_assets.html' %}",
            "{% include '_top_level_host_theme_bootstrap.html' %}",
            "{% include '_top_level_global_spinner.html' %}",
        ],
    }

    for rel, fragments in partials.items():
        text = Path(rel).read_text(encoding='utf-8')
        for fragment in fragments:
            assert fragment in text, f"missing P4 host partial fragment in {rel}: {fragment}"

    for rel, fragments in template_expectations.items():
        text = Path(rel).read_text(encoding='utf-8')
        for fragment in fragments:
            assert fragment in text, f"missing shared host partial include in {rel}: {fragment}"


def test_p5_top_level_router_prefers_history_navigation_and_keeps_hard_navigation_as_fallback():
    helper = Path('xkeen-ui/static/js/pages/top_level_nav.shared.js').read_text(encoding='utf-8')
    router = Path('xkeen-ui/static/js/pages/top_level_router.js').read_text(encoding='utf-8')
    registry = Path('xkeen-ui/static/js/pages/top_level_screen_registry.js').read_text(encoding='utf-8')
    shell = Path('xkeen-ui/static/js/pages/top_level_shell.shared.js').read_text(encoding='utf-8')

    assert 'const TOP_LEVEL_SCREEN_ROUTES = Object.freeze({' in registry
    assert "panel: '/'" in registry
    assert "backups: '/backups'" in registry
    assert "devtools: '/devtools'" in registry
    assert "xkeen: '/xkeen'" in registry
    assert "mihomo_generator: '/mihomo_generator'" in registry
    assert 'export function resolveTopLevelRoute(input) {' in registry

    assert """if (resolved) {
      const router = getTopLevelRouterApi();
      if (router && typeof router.navigate === 'function' && router.navigate(resolved, opts || {})) {
        return true;
      }
    }""" in helper
    assert """if (opts && opts.replace && typeof locationRef.replace === 'function') {
      locationRef.replace(nextUrl);
    } else if (typeof locationRef.assign === 'function') {
      locationRef.assign(nextUrl);
    } else {
      locationRef.href = nextUrl;
    }""" in helper

    assert "const fn = replace ? historyRef.replaceState : historyRef.pushState;" in router
    assert """if (currentScreen !== nextScreen || !state.currentScreenMounted) {
      await runScreenLifecycle(nextScreen, 'mount', {
        router: api,
        route,
        trigger: meta.trigger,
        reason: meta.reason,
      });
    }

    if (currentScreen && currentScreen !== nextScreen) {
      await runScreenLifecycle(currentScreen, 'deactivate', {
        router: api,
        from: currentRoute,
        to: route,
        trigger: meta.trigger,
        reason: meta.reason,
      });
    }""" in router
    assert """if (currentScreenName && route.name === currentScreenName) {
      pushHistoryState(route, replace);
      return handleSameScreenNavigation(route, meta);
    }""" in router
    assert """if (!registry.hasScreen(route.name)) return false;

    pushHistoryState(route, replace);
    return queueTransition(route, meta);""" in router
    assert """catch (error) {
          try { console.error('[XKeen] top-level router transition failed', error); } catch (secondaryError) {}
          hardNavigate(route, true);
        }""" in router
    assert """if (!registry.hasScreen(route.name)) {
      hardNavigate(route, true);
      return;
    }""" in router
    assert "win.addEventListener('popstate', handlePopstate);" in router
    assert "trigger: 'popstate'," in router
    assert "reason: 'popstate'," in router
    assert "emitRouteChange(route, Object.assign({}, meta, { inApp: true }));" in router
    assert 'hardNavigate(route, false);' not in router

    assert "const route = resolveTopLevelRoute(getWindowRef()?.location?.href || '') || null;" in shell
    assert "router.bootstrapCurrentScreen({" in shell


def test_p9_backups_and_xkeen_screen_modules_keep_runtime_reactivation_safe():
    backups = Path('xkeen-ui/static/js/features/backups.js').read_text(encoding='utf-8')
    service_status = Path('xkeen-ui/static/js/features/service_status.js').read_text(encoding='utf-8')
    xkeen_texts = Path('xkeen-ui/static/js/features/xkeen_texts.js').read_text(encoding='utf-8')
    backups_bootstrap = Path('xkeen-ui/static/js/pages/backups.screen.bootstrap.js').read_text(encoding='utf-8')
    xkeen_bootstrap = Path('xkeen-ui/static/js/pages/xkeen.screen.bootstrap.js').read_text(encoding='utf-8')

    assert 'function getMode() {' in backups
    assert "const m = t && t.dataset ? String(t.dataset.mode || '').trim() : '';" in backups
    assert 'function init() {' in backups
    assert 'if (!_inited) _inited = true;' in backups
    assert 'isInitialized() {' in backups

    assert 'function hasServiceStatusHost() {' in service_status
    assert 'if (!hasServiceStatusHost()) return null;' in service_status
    assert 'isPolling() {' in service_status
    assert 'activate(opts) {' in service_status
    assert 'deactivate() {' in service_status
    assert 'serializeState() {' in service_status
    assert 'restoreState(state) {' in service_status

    assert 'const hostStates = Object.create(null);' in xkeen_texts
    assert 'function getCurrentHostKey() {' in xkeen_texts
    assert 'function getHostState(hostKey) {' in xkeen_texts
    assert 'function serializeState() {' in xkeen_texts
    assert 'function restoreState(rawState) {' in xkeen_texts
    assert 'function activate() {' in xkeen_texts
    assert 'function deactivate() {' in xkeen_texts
    assert 'isInitialized() {' in xkeen_texts

    assert 'function readScrollState() {' in backups_bootstrap
    assert 'function applyScrollState(state) {' in backups_bootstrap
    assert "if (backupsApi && typeof backupsApi.isInitialized === 'function' && !backupsApi.isInitialized()) {" in backups_bootstrap
    assert 'return applyScrollState(state);' in backups_bootstrap

    assert 'function readScrollState() {' in xkeen_bootstrap
    assert 'function applyScrollState(state) {' in xkeen_bootstrap
    assert "if (serviceStatus && typeof serviceStatus.activate === 'function') {" in xkeen_bootstrap
    assert "if (xkeenTexts && typeof xkeenTexts.activate === 'function') {" in xkeen_bootstrap
    assert 'xkeenTexts: xkeenTexts && typeof xkeenTexts.serializeState === \'function\'' in xkeen_bootstrap
    assert 'serviceStatus: serviceStatus && typeof serviceStatus.serializeState === \'function\'' in xkeen_bootstrap


def test_terminal_lazy_entry_uses_import_first_vendor_adapter_without_dom_script_injection():
    entry_text = Path('xkeen-ui/static/js/pages/terminal.lazy.entry.js').read_text(encoding='utf-8')
    adapter_text = Path('xkeen-ui/static/js/terminal/vendors/xterm_import_adapter.js').read_text(encoding='utf-8')

    assert "from '../terminal/vendors/xterm_import_adapter.js';" in entry_text
    assert 'await ensureXtermVendorReady();' in entry_text
    assert "document.createElement('script')" not in entry_text
    assert 'appendChild(script)' not in entry_text
    assert 'document.head.appendChild(script)' not in entry_text
    assert 'querySelector(\'script[data-xk-term-src="' not in entry_text

    assert 'export async function ensureXtermVendorReady()' in adapter_text
    assert 'await import(/* @vite-ignore */ url);' in adapter_text
    assert "appendTerminalDebug('lazy:vendor:amd-shield'" in adapter_text
    assert 'restoreAmdGlobals(scope, amdStash)' in adapter_text
    assert "document.createElement('script')" not in adapter_text
    assert 'appendChild(script)' not in adapter_text


def test_file_manager_terminal_waits_for_real_terminal_api_before_first_open_and_keeps_pty_hint():
    text = Path('xkeen-ui/static/js/features/file_manager/terminal.js').read_text(encoding='utf-8')

    assert "import { supportsXkeenTerminalPty } from '../xkeen_runtime.js';" in text
    assert "if (!allowLazyStub && api.__xkLazyStubInstalled) return null;" in text
    assert "const capsReady = !!(caps && typeof caps.isReady === 'function' && caps.isReady());" in text
    assert "return supportsXkeenTerminalPty() ? 'pty' : 'shell';" in text
    assert "if (!api) api = _terminalApi({ allowLazyStub: true });" in text


def test_routing_fragment_refresh_uses_runtime_http_api_instead_of_undefined_core_http_global():
    path = Path('xkeen-ui/static/js/features/routing.js')
    text = path.read_text(encoding='utf-8')

    assert 'const coreHttp = getXkeenCoreHttpApi();' in text
    assert 'CORE_HTTP.fetchJSON' not in text


def test_routing_fragment_switch_uses_commit_helper_and_rolls_back_after_load_failure():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'async function loadCommittedFragmentSelection(next, opts)' in text
    assert 'return _activeFragment || getSelectedFragmentFromUI() || restoreRememberedFragment() || null;' in text
    assert 'const ok = await load();' in text
    assert 'if (ok) return true;' in text
    assert 'if (prevValue) restoreFragmentSelection(selectEl, prevValue, prevDir, prevItems);' in text
    assert "commit: async () => loadCommittedFragmentSelection(next, {" in text
    assert 'applyActiveFragment(next, dir);' not in text


def test_routing_refresh_button_is_wired_in_wireui_instead_of_refresh_success_path():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'const refreshBtn = $(IDS.fragmentRefresh);' in text
    assert "await refreshFragmentsList({ notify: true, prevSelection: prev, syncActive: false });" in text
    assert "const next = getSelectedFragmentFromUI() || getActiveFragment();" in text
    assert "if (btn && !btn.dataset.xkWired)" not in text


def test_routing_topbar_fragment_select_keeps_intrinsic_width_after_screen_return():
    text = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert '.xk-routing-fileline .xray-log-select{' in text
    assert 'width: auto;' in text
    assert 'min-width: 0;' in text
    assert 'max-width: 100%;' in text
    assert 'flex: 0 1 auto;' in text


def test_xray_live_logs_header_selects_keep_compact_width_after_panel_reactivation():
    text = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert '.log-header-actions > .xray-log-select {' in text
    assert 'width: auto;' in text
    assert 'min-width: 0;' in text
    assert 'max-width: 100%;' in text
    assert 'flex: 0 1 auto;' in text


def test_root_layout_keeps_body_background_painted_to_full_viewport_height():
    text = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert 'html {' in text
    assert 'min-height: 100%;' in text
    assert 'body {' in text
    assert 'min-height: 100vh;' in text
    assert 'min-height: 100dvh;' in text


def test_xray_preflight_modal_exposes_explainer_block_and_problem_line_rendering():
    modal_text = Path('xkeen-ui/static/js/ui/xray_preflight_modal.js').read_text(encoding='utf-8')
    css_text = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')
    spinner_text = Path('xkeen-ui/static/js/ui/spinner_fetch.js').read_text(encoding='utf-8')

    assert "data-xk-preflight-explainer-wrap" in modal_text
    assert "data-xk-preflight-explainer" in modal_text
    assert "data-xk-preflight-code-trigger" in modal_text
    assert "data-xk-preflight-code-help-wrap" in modal_text
    assert "data-xk-preflight-code-help" in modal_text
    assert 'function classifyTerminalLine(line) {' in modal_text
    assert 'function buildHumanDiagnosis(payload, details) {' in modal_text
    assert 'function buildReturnCodeHelp(payload, code) {' in modal_text
    assert 'function buildExplanationItems(payload, details) {' in modal_text
    assert 'function renderExplanationItems(container, items) {' in modal_text
    assert 'function renderTerminalOutput(el, text, emptyLabel) {' in modal_text
    assert 'function extractBalancerReference(text) {' in modal_text
    assert 'function extractOutboundReference(text) {' in modal_text
    assert 'function scoreDiagnosticText(text) {' in modal_text
    assert "id: 'missing_outbound'" in modal_text
    assert "id: 'missing_balancer'" in modal_text
    assert 'Правило ссылается на balancerTag "' in modal_text
    assert 'Правило ссылается на outboundTag "' in modal_text
    assert r"\boutbound\s+([A-Za-z0-9_.:-]+)\s+(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b" in modal_text
    assert r"\bbalancer\s+([A-Za-z0-9_.:-]+)\s+(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b" in modal_text
    assert "phase === 'routing_semantic_validate'" in modal_text
    assert "title: 'Панель отклонила конфиг'" in modal_text
    assert ".replace(/(^|>\\s*)main:\\s*/gi, '$1')" in modal_text
    assert ".replace(/(?:^|>\\s*)main:\\s*/gi, '$1')" not in modal_text
    assert 'function scrollTerminalToDiagnostic(el, preferredText) {' in modal_text
    assert 'renderTerminalOutput(els.stderr, stderr, \'stderr пуст\');' in modal_text
    assert 'renderTerminalOutput(els.stdout, stdout, \'stdout пуст\');' in modal_text
    assert 'scrollTerminalToDiagnostic(els.stdout, preferredDiagnosticText);' in modal_text
    assert "Код 23 здесь означает только то, что `xray -test` завершился с ошибкой" in modal_text
    assert '.xk-preflight-block--explainer {' in css_text
    assert '.xk-preflight-code-trigger {' in css_text
    assert '.xk-preflight-block--code-help {' in css_text
    assert '.xk-preflight-explainer-item {' in css_text
    assert '.xk-preflight-terminal-line.is-problem {' in css_text
    assert '.xk-preflight-terminal-line.is-warning {' in css_text
    assert "const phase = String(data.phase || '');" in spinner_text
    assert "phase === 'xray_test' ||" in spinner_text
    assert "phase === 'routing_semantic_validate' ||" in spinner_text
    assert "errorCode === 'xray preflight failed' ||" in spinner_text
    assert "errorCode === 'routing semantic validation failed';" in spinner_text
    assert "if (!isRoutingValidationFailure) return;" in spinner_text


def test_devtools_light_theme_has_readable_update_pills_and_layout_tab_list():
    css_text = Path('xkeen-ui/static/devtools.css').read_text(encoding='utf-8')

    assert 'html[data-theme="light"] body.devtools-page .dt-badge,' in css_text
    assert 'html[data-theme="light"] body.devtools-page .dt-pill {' in css_text
    assert 'html[data-theme="light"] body.devtools-page .dt-badge-warn,' in css_text
    assert 'html[data-theme="light"] body.devtools-page .dt-pill-warn {' in css_text
    assert 'html[data-theme="light"] body.devtools-page .dt-tab-item {' in css_text
    assert 'html[data-theme="light"] body.devtools-page .dt-tab-label {' in css_text
    assert 'html[data-theme="light"] body.devtools-page #dt-layout-card hr {' in css_text


def test_theme_toggle_uses_delegated_binding_and_resyncs_after_top_level_route_changes():
    text = Path('xkeen-ui/static/js/ui/theme.js').read_text(encoding='utf-8')

    assert "const TOP_LEVEL_ROUTE_CHANGE_EVENT = 'xkeen:top-level-route-change';" in text
    assert 'function syncThemeToggleButtons(theme) {' in text
    assert "getThemeToggleButtons().forEach((btn) => {" in text
    assert "event.target.closest('#theme-toggle-btn')" in text
    assert "document.addEventListener('click', handleThemeToggleClick);" in text
    assert "window.addEventListener(TOP_LEVEL_ROUTE_CHANGE_EVENT, () => {" in text
    assert "applyTheme(_currentTheme || getInitialTheme(), { syncEditors: false, notify: false });" in text
    assert "XKeen.ui.syncThemeToggleButtons = syncThemeToggleButtons;" in text
    assert "btn.addEventListener('click'" not in text


def test_donate_visibility_resyncs_after_same_tab_pref_changes_and_top_level_route_swaps():
    text = Path('xkeen-ui/static/js/features/donate.js').read_text(encoding='utf-8')

    assert "const TOP_LEVEL_ROUTE_CHANGE_EVENT = 'xkeen:top-level-route-change';" in text
    assert "const DONATE_PREF_CHANGE_EVENT = 'xkeen:donate-pref-change';" in text
    assert 'function syncDevtoolsToggleState() {' in text
    assert 'function syncDonateUiState() {' in text
    assert "window.dispatchEvent(new CustomEvent(DONATE_PREF_CHANGE_EVENT, {" in text
    assert "window.addEventListener(TOP_LEVEL_ROUTE_CHANGE_EVENT, () => {" in text
    assert "window.addEventListener(DONATE_PREF_CHANGE_EVENT, () => {" in text
    assert "window.addEventListener('storage', (event) => {" in text
    assert "if (!event || event.key !== LS_KEY_HIDE) return;" in text
    assert "document.addEventListener('xkeen-ui-prefs-applied', () => {" in text
    assert 'Donate.syncVisibility = syncDonateUiState;' in text


def test_routing_comments_ux_listener_is_guarded_after_init_flag():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'let _commentsUxWired = false;' in text
    assert 'if (_inited) return;' in text
    assert "document.addEventListener('xkeen:routing-comments-ux', (ev) => {" in text
    assert '_commentsUxWired = true;' in text
    assert text.index('if (_inited) return;') < text.index("document.addEventListener('xkeen:routing-comments-ux', (ev) => {")


def test_routing_monaco_custom_menu_includes_symbol_occurrence_and_palette_actions():
    routing = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert 'function routingMonacoMenuItemHtml(action, label, shortcut) {' in routing
    assert "routingMonacoMenuItemHtml('goToSymbol', 'Перейти к символу...', 'Ctrl+Shift+O')" in routing
    assert "routingMonacoMenuItemHtml('changeAllOccurrences', 'Изменить все вхождения', 'Ctrl+F2')" in routing
    assert "routingMonacoMenuItemHtml('commandPalette', 'Палитра команд', 'F1')" in routing
    assert "return runRoutingMonacoEditorAction(editor, 'editor.action.quickOutline');" in routing
    assert "return runRoutingMonacoEditorAction(editor, 'editor.action.changeAll');" in routing
    assert "return runRoutingMonacoEditorAction(editor, 'editor.action.quickCommand');" in routing
    assert "isRoutingMonacoActionSupported(editor, 'editor.action.quickOutline')" in routing
    assert "isRoutingMonacoActionSupported(editor, 'editor.action.quickCommand')" in routing
    assert '.xk-routing-monaco-menu-shortcut {' in styles
    assert '.xk-routing-monaco-menu-label {' in styles


def test_routing_monaco_custom_menu_includes_symbol_occurrence_and_palette_actions():
    routing = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')
    monaco_shared = Path('xkeen-ui/static/js/ui/monaco_shared.js').read_text(encoding='utf-8')
    mihomo_panel = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')
    mihomo_generator = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')
    file_manager = Path('xkeen-ui/static/js/features/file_manager/editor.js').read_text(encoding='utf-8')
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert 'function installCustomContextMenu(editor, host, opts) {' in monaco_shared
    assert "const customContextMenu = _normalizeCustomContextMenuOptions(o, language);" in monaco_shared
    assert "contextmenu: useCustomContextMenu ? false : ((typeof o.contextmenu === 'boolean') ? o.contextmenu : true)," in monaco_shared
    assert "installCustomContextMenu(editor, el, o);" in monaco_shared
    assert "_customContextMenuItemHtml('goToSymbol', labels.goToSymbol, 'Ctrl+Shift+O')" in monaco_shared
    assert "_customContextMenuItemHtml('changeAllOccurrences', labels.changeAllOccurrences, 'Ctrl+F2')" in monaco_shared
    assert "_customContextMenuItemHtml('commandPalette', labels.commandPalette, 'F1')" in monaco_shared
    assert "function hideCustomContextMenu() {" in monaco_shared
    assert "function uninstallCustomContextMenu(editor) {" in monaco_shared
    assert "customContextMenu: useRoutingMonacoCustomMenu() ? {" in routing
    assert "if (typeof formatEditorJson === 'function') return formatEditorJson();" in routing
    assert "monacoShared.uninstallCustomContextMenu(_monaco || null);" in routing
    assert "monacoShared.hideCustomContextMenu();" in routing
    assert 'await runtime.create(host, {' in mihomo_panel
    assert 'await runtime.create(previewMonacoHost, {' in mihomo_generator
    assert 'await runtime.create(ui.monacoHost, {' in file_manager
    assert 'contextmenu:' not in mihomo_panel
    assert 'contextmenu:' not in mihomo_generator
    assert 'contextmenu:' not in file_manager
    assert '.xk-routing-monaco-menu-shortcut {' in styles
    assert '.xk-routing-monaco-menu-label {' in styles


def test_mihomo_template_load_button_uses_dirty_guard_while_select_path_skips_duplicate_prompt():
    text = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')

    assert 'async function confirmDiscardDirtyEditorChanges(opts)' in text
    assert "MP.loadSelectedTemplateToEditor = async function loadSelectedTemplateToEditor(opts) {" in text
    assert "const confirmDirty = !Object.prototype.hasOwnProperty.call(options, 'confirmDirty') || !!options.confirmDirty;" in text
    assert "if (confirmDirty && !(await confirmDiscardDirtyEditorChanges({" in text
    assert "const loaded = await MP.loadSelectedTemplateToEditor({ confirmDirty: false });" in text


def test_mihomo_server_side_config_swaps_resync_editor_after_activate_and_restore():
    text = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')

    assert "async function loadLiveConfigIntoEditor()" in text
    assert text.count("const syncResult = await loadLiveConfigIntoEditor();") >= 2
    assert "const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name) + '/activate', { method: 'POST' });" in text
    assert "const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename) + '/restore', { method: 'POST' });" in text
    assert "config.yaml уже изменён на сервере, но редактор не удалось обновить." in text
    assert "Восстановление из бэкапа заменит текущее содержимое редактора." in text


def test_mihomo_profiles_backups_panel_uses_compact_premium_vault_layout():
    template = Path('xkeen-ui/templates/panel.html').read_text(encoding='utf-8')
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')
    script = Path('xkeen-ui/static/js/features/mihomo_panel.js').read_text(encoding='utf-8')

    assert 'class="xk-mihomo-vault"' in template
    assert 'class="xk-mihomo-vault-grid"' in template
    assert 'class="xk-mihomo-vault-card xk-mihomo-vault-card--profiles"' in template
    assert 'class="xk-mihomo-vault-card xk-mihomo-vault-card--backups"' in template
    assert 'class="xk-mihomo-backups-toolbar"' in template
    assert 'class="routing-editor-badge is-muted xk-mihomo-backups-active-pill"' in template
    assert 'class="xk-mihomo-vault-table-shell xk-mihomo-vault-table-shell--backups"' in template
    assert 'class="xk-mihomo-profile-create-row"' in template

    assert 'function buildMihomoMiniButton(action, label, opts) {' in script
    assert 'function buildMihomoNamePill(text) {' in script
    assert 'function buildMihomoScrollingNamePill(text) {' in script
    assert "label.className = 'routing-editor-badge is-ok xk-mihomo-backups-active-pill';" in script
    assert "label.className = 'routing-editor-badge is-muted xk-mihomo-backups-active-pill';" in script
    assert "buildMihomoMiniButton('activate', activateLabel, {" in script
    assert "buildMihomoMiniButton('restore', 'Восстановить бэкап', {" in script
    assert "tbody.innerHTML = '<tr><td colspan=\"4\">' + buildMihomoRowBadge('Бэкапы не найдены', 'muted') + '</td></tr>';" in script

    assert '.xk-mihomo-vault-grid {' in styles
    assert '.xk-mihomo-vault-table-shell--backups {' in styles
    assert '.xk-mihomo-mini-btn {' in styles
    assert '.xk-mihomo-backups-toolbar {' in styles
    assert '.xk-mihomo-profile-create {' in styles
    assert 'position: sticky;' in styles
    assert 'html[data-theme="light"] .xk-mihomo-vault-card {' in styles


def test_panel_mobile_usability_pass_uses_scrollable_tabs_and_compact_editor_toolbar_overrides():
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert 'Panel page: mobile usability pass' in styles
    assert '@media (max-width: 760px) {' in styles
    assert 'body.panel-page .top-tabs.header-tabs {' in styles
    assert 'scroll-snap-type: x proximity;' in styles
    assert 'body.panel-page .xkeen-ctrl-group-main {' in styles
    assert 'grid-template-columns: repeat(3, minmax(0, 1fr));' in styles
    assert 'body.panel-page .xk-routing-toolbararea,' in styles
    assert 'body.panel-page .xk-mihomo-toolbararea {' in styles
    assert 'body.panel-page .xk-routing-toolbarhost,' in styles
    assert 'body.panel-page .xk-mihomo-toolbarhost {' in styles
    assert 'body.panel-page #routing-body {' in styles
    assert '--xk-routing-editor-height: min(44vh, 360px);' in styles
    assert 'body.panel-page .routing-dat-actions-inline {' in styles
    assert 'body.panel-page .theme-toggle-btn.xk-header-btn-theme .theme-toggle-text {' in styles
    assert '@media (max-width: 420px) {' in styles


def test_panel_mobile_second_wave_compacts_file_manager_and_modal_shells():
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert 'Panel page: mobile second wave (file manager + modal ergonomics).' in styles
    assert 'body.panel-page .modal-content {' in styles
    assert 'max-height: calc(100dvh - 16px);' in styles
    assert 'body.panel-page .fm-panel-bar {' in styles
    assert 'body.panel-page .fm-path-input {' in styles
    assert 'body.panel-page .fm-row,' in styles
    assert 'body.panel-page .fm-panel.is-trash .fm-row {' in styles
    assert 'min-width: 560px;' in styles
    assert 'body.panel-page #json-editor-modal .xk-editor-toolbar {' in styles
    assert 'body.panel-page #json-editor-modal .modal-actions {' in styles
    assert 'body.panel-page #fm-editor-modal .modal-actions {' in styles
    assert 'body.panel-page #routing-dat-contents-modal .xk-dat-modal-content {' in styles
    assert 'body.panel-page #routing-dat-contents-modal .dat-contents-routingbar {' in styles
    assert 'body.panel-page #ui-settings-modal .xk-ui-settings-nav {' in styles
    assert 'body.panel-page #ui-settings-modal .xk-ui-settings-nav-btn {' in styles


def test_panel_mobile_third_wave_switches_file_manager_to_touch_first_rows_and_stacks_editor_toolbars():
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')

    assert 'Panel page: mobile third wave (touch-first file manager + cleaner editor toolbars).' in styles
    assert 'body.panel-page .routing-focus-note {' in styles
    assert 'display: none;' in styles
    assert 'body.panel-page .xk-routing-toolbararea,' in styles
    assert 'body.panel-page .xk-mihomo-toolbararea {' in styles
    assert 'grid-template-columns: repeat(3, 32px) minmax(0, 1fr);' in styles
    assert 'body.panel-page .xk-routing-toolbarhost,' in styles
    assert 'body.panel-page .xk-mihomo-toolbarhost {' in styles
    assert 'grid-column: 1 / -1;' in styles
    assert 'body.panel-page .fm-hints {' in styles
    assert 'body.panel-page .fm-row-header {' in styles
    assert 'body.panel-page .fm-row:not(.fm-row-header) {' in styles
    assert 'grid-template-columns: 24px minmax(0, 1fr) auto;' in styles
    assert 'body.panel-page .fm-cell.fm-perm,' in styles
    assert 'body.panel-page .fm-cell.fm-mtime {' in styles
    assert 'body.panel-page .fm-header-actions,' in styles
    assert 'body.panel-page .fm-footer-actions {' in styles


def test_routing_template_modals_stretch_preview_and_edit_editors_with_modal_resize():
    styles = Path('xkeen-ui/static/styles.css').read_text(encoding='utf-8')
    script = Path('xkeen-ui/static/js/features/routing_templates.js').read_text(encoding='utf-8')

    assert '#routing-template-modal .modal-content,' in styles
    assert '#routing-template-edit-modal .modal-content {' in styles
    assert 'height: 80vh;' in styles
    assert '#routing-template-modal .modal-body,' in styles
    assert 'overflow: hidden;' in styles
    assert '#routing-template-modal .routing-template-grid {' in styles
    assert '#routing-template-modal .routing-template-preview-monaco,' in styles
    assert '#routing-template-modal .xkeen-cm6-host.routing-template-preview-cm {' in styles
    assert '#routing-template-edit-modal .routing-template-edit-form > label:last-of-type > .routing-template-edit-monaco,' in styles
    assert '#routing-template-edit-modal .routing-template-edit-cm .CodeMirror-scroll {' in styles
    assert 'height: 100%;' in styles
    assert 'max-height: none;' in styles
    assert 'resize: none;' in styles

    assert 'let _modalResizeWired = false;' in script
    assert 'function layoutPreviewEditorsSoon() {' in script
    assert 'function layoutEditEditorsSoon() {' in script
    assert 'function wireTemplateModalResizeOnce() {' in script
    assert "document.addEventListener('xkeen-modal-resize', (event) => {" in script
    assert 'if (modalId === IDS.modal) {' in script
    assert 'if (modalId === IDS.editModal) {' in script
    assert 'wireTemplateModalResizeOnce();' in script
    assert 'layoutPreviewEditorsSoon();' in script
    assert 'layoutEditEditorsSoon();' in script


def test_routing_dat_card_keeps_visible_current_file_labels_in_sync_with_selected_names():
    ids_text = Path('xkeen-ui/static/js/features/routing_cards/ids.js').read_text(encoding='utf-8')
    panel_text = Path('xkeen-ui/templates/panel.html').read_text(encoding='utf-8')
    card_text = Path('xkeen-ui/static/js/features/routing_cards/dat/card.js').read_text(encoding='utf-8')

    assert "datGeositeCurrentFile: 'routing-dat-geosite-current-file'" in ids_text
    assert "datGeoipCurrentFile: 'routing-dat-geoip-current-file'" in ids_text
    assert 'id="routing-dat-geosite-current-file"' in panel_text
    assert 'id="routing-dat-geoip-current-file"' in panel_text
    assert 'function syncDatCurrentFileLabels(prefs)' in card_text
    assert 'syncDatCurrentFileLabels(prefs);' in card_text
    assert "if (source === 'dir' || source === 'name') refreshLater();" in card_text


def test_routing_dat_actions_read_current_dom_selection_before_falling_back_to_saved_prefs():
    text = Path('xkeen-ui/static/js/features/routing_cards/dat/api.js').read_text(encoding='utf-8')

    assert 'function readKindPrefs(kind)' in text
    assert "const dirId = (k === 'geosite') ? IDS.datGeositeDir : IDS.datGeoipDir;" in text
    assert "const nameId = (k === 'geosite') ? IDS.datGeositeName : IDS.datGeoipName;" in text
    assert "const urlId = (k === 'geosite') ? IDS.datGeositeUrl : IDS.datGeoipUrl;" in text
    assert text.count('const p = readKindPrefs(k);') >= 3


def test_routing_dat_prefs_backfill_blank_values_with_defaults():
    text = Path('xkeen-ui/static/js/features/routing_cards/dat/prefs.js').read_text(encoding='utf-8')

    assert 'function mergeKindDefaults(kind, value)' in text
    assert "if (!String(merged.url || '').trim()) merged.url = DEFAULTS[k].url;" in text
    assert "if (!String(merged.dir || '').trim()) merged.dir = DEFAULTS[k].dir;" in text
    assert "if (!String(merged.name || '').trim()) merged.name = DEFAULTS[k].name;" in text


def test_panel_shell_dat_fallback_rehydrates_current_card_before_deferring_and_dispatches_input_change():
    text = Path('xkeen-ui/static/js/pages/panel_shell.shared.js').read_text(encoding='utf-8')
    card_text = Path('xkeen-ui/static/js/features/routing_cards/dat/card.js').read_text(encoding='utf-8')

    assert 'function hasModernRoutingDatFeature()' in text
    assert 'function isCurrentRoutingDatCardWired()' in text
    assert 'function ensureModernRoutingDatCardReady()' in text
    assert "if (ensureModernRoutingDatCardReady()) return;" in text
    assert "return !!(datBody && datBody.dataset && datBody.dataset.xkDatCardWired === '1');" in text
    assert "if (datBody.dataset) datBody.dataset.xkDatCardWired = '1';" in card_text
    assert "refs.name.dispatchEvent(new Event('input', { bubbles: true }));" in text
    assert "refs.name.dispatchEvent(new Event('change', { bubbles: true }));" in text


def test_xray_logs_height_prefs_keep_local_draft_and_survive_hidden_view_saves():
    text = Path('xkeen-ui/static/js/features/xray_logs.js').read_text(encoding='utf-8')

    assert 'const LOG_WINDOW_MIN_HEIGHT = 420;' in text
    assert 'function _resolveLogWindowHeight(refs, runtimeState)' in text
    assert 'const storedHeight = _normalizeLogWindowHeight(readStoredUiState().height);' in text
    assert 'const height = _resolveLogWindowHeight(refs, runtime);' in text
    assert 'function persistLocalLogsViewDraft()' in text
    assert 'persistLocalLogsViewDraft();' in text
    assert "ui-settings: failed to promote local logs view draft" in text
    assert 'function applyInitialLogWindowHeightFromStoredState(st)' in text
    assert 'applyInitialLogWindowHeightFromStoredState(st);' in text
    assert text.index('applyInitialLogWindowHeightFromStoredState(st);') < text.index('if (_seedMarkerIsSet()) return;')
    assert 'if (_logsViewPrefsUserTouched) persistLocalLogsViewDraft();' in text


def test_file_manager_non_navigation_refreshes_do_not_consume_path_input_drafts():
    editor_text = Path('xkeen-ui/static/js/features/file_manager/editor.js').read_text(encoding='utf-8')
    listing_text = Path('xkeen-ui/static/js/features/file_manager/listing.js').read_text(encoding='utf-8')

    assert "if (ctx.side && typeof lp === 'function') await lp(ctx.side, { fromInput: false });" in editor_text
    assert "await Promise.all([listPanel('left', { fromInput: false }), listPanel('right', { fromInput: false })]);" in listing_text
