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


def test_mihomo_generator_ignores_stale_profile_defaults_and_auto_preview_overwrites():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'let _previewRequestSeq = 0;' in text
    assert 'let _profileDefaultsRequestSeq = 0;' in text
    assert 'if (_isEditable) return;' in text
    assert 'const requestSeq = ++_profileDefaultsRequestSeq;' in text
    assert 'const currentProfile = (profileSelect && profileSelect.value) || "router_custom";' in text
    assert 'if (requestSeq !== _profileDefaultsRequestSeq) return;' in text
    assert 'if (String(currentProfile || "router_custom") !== String(p || "router_custom")) return;' in text
    assert 'const requestSeq = ++_previewRequestSeq;' in text
    assert 'if (!manual && _isEditable) return;' in text
    assert text.count('if (requestSeq !== _previewRequestSeq) return;') >= 2


def test_top_level_navigation_controls_use_shared_helper_contract():
    helper = Path('xkeen-ui/static/js/pages/top_level_nav.shared.js').read_text(encoding='utf-8')
    shell = Path('xkeen-ui/static/js/pages/top_level_shell.shared.js').read_text(encoding='utf-8')
    router = Path('xkeen-ui/static/js/pages/top_level_router.js').read_text(encoding='utf-8')
    registry = Path('xkeen-ui/static/js/pages/top_level_screen_registry.js').read_text(encoding='utf-8')
    host = Path('xkeen-ui/static/js/pages/top_level_screen_host.shared.js').read_text(encoding='utf-8')
    panel_screen = Path('xkeen-ui/static/js/pages/top_level_panel_screen.js').read_text(encoding='utf-8')
    mihomo_screen = Path('xkeen-ui/static/js/pages/top_level_mihomo_generator_screen.js').read_text(encoding='utf-8')
    devtools_screen = Path('xkeen-ui/static/js/pages/top_level_devtools_screen.js').read_text(encoding='utf-8')
    panel_mihomo_shared = Path('xkeen-ui/static/js/pages/top_level_panel_mihomo.shared.js').read_text(encoding='utf-8')
    panel_shell = Path('xkeen-ui/static/js/pages/panel_shell.shared.js').read_text(encoding='utf-8')
    panel_entry = Path('xkeen-ui/static/js/pages/panel.entry.js').read_text(encoding='utf-8')
    devtools_entry = Path('xkeen-ui/static/js/pages/devtools.entry.js').read_text(encoding='utf-8')
    mihomo_entry = Path('xkeen-ui/static/js/pages/mihomo_generator.entry.js').read_text(encoding='utf-8')
    devtools_bootstrap = Path('xkeen-ui/static/js/pages/devtools.screen.bootstrap.js').read_text(encoding='utf-8')
    devtools_init = Path('xkeen-ui/static/js/pages/devtools.init.js').read_text(encoding='utf-8')
    mihomo_init = Path('xkeen-ui/static/js/pages/mihomo_generator.init.js').read_text(encoding='utf-8')
    panel_template = Path('xkeen-ui/templates/panel.html').read_text(encoding='utf-8')
    devtools_template = Path('xkeen-ui/templates/devtools.html').read_text(encoding='utf-8')
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
    assert "devtools: '/devtools'" in registry
    assert "mihomo_generator: '/mihomo_generator'" in registry
    assert 'export function ensureTopLevelScreenMount()' in host
    assert 'export async function fetchTopLevelScreenSnapshot(name, route)' in host
    assert 'export function registerPanelTopLevelScreen()' in panel_screen
    assert "fetchTopLevelScreenSnapshot('panel', '/')" in panel_screen
    assert 'export function registerMihomoGeneratorTopLevelScreen()' in mihomo_screen
    assert "fetchTopLevelScreenSnapshot('mihomo_generator', '/mihomo_generator')" in mihomo_screen
    assert 'export function registerDevtoolsTopLevelScreen()' in devtools_screen
    assert "fetchTopLevelScreenSnapshot('devtools', '/devtools')" in devtools_screen
    assert 'export function registerPanelMihomoTopLevelScreens()' in panel_mihomo_shared
    assert 'export function registerCanonicalTopLevelScreens()' in panel_mihomo_shared
    assert "import { registerDevtoolsTopLevelScreen } from './top_level_devtools_screen.js';" in panel_mihomo_shared
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in panel_shell
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in panel_entry
    assert "import { bootPanelScreen } from './panel.screen.bootstrap.js';" in panel_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in panel_entry
    assert "initialScreen: 'panel'" in panel_entry
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in devtools_entry
    assert "import { bootDevtoolsScreen } from './devtools.screen.bootstrap.js';" in devtools_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in devtools_entry
    assert "initialScreen: 'devtools'" in devtools_entry
    assert "import { bootTopLevelShell } from './top_level_shell.shared.js';" in mihomo_entry
    assert "import { bootMihomoGeneratorScreen } from './mihomo_generator.screen.bootstrap.js';" in mihomo_entry
    assert "import { registerPanelMihomoTopLevelScreens } from './top_level_panel_mihomo.shared.js';" in mihomo_entry
    assert "initialScreen: 'mihomo_generator'" in mihomo_entry
    assert 'export async function bootDevtoolsScreen()' in devtools_bootstrap
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in devtools_init
    assert "import { wireTopLevelNavigation } from './top_level_nav.shared.js';" in mihomo_init
    assert panel_template.count('data-xk-top-nav="1"') >= 3
    assert 'data-xk-top-nav="1"' in devtools_template
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
    assert 'function activate(options) {' in logs
    assert 'function deactivate() {' in logs
    assert 'try { _stopLogStreamingAll(); } catch (e) {}' in logs
    assert 'try { stopLogListPolling(); } catch (e) {}' in logs
    assert 'getActiveTab,' in logs
    assert 'activate,' in logs
    assert 'deactivate,' in logs

    assert 'function activate() {' in update
    assert 'function deactivate() {' in update
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
    assert "devtools: '/devtools'" in registry
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


def test_routing_comments_ux_listener_is_guarded_after_init_flag():
    text = Path('xkeen-ui/static/js/features/routing.js').read_text(encoding='utf-8')

    assert 'let _commentsUxWired = false;' in text
    assert 'if (_inited) return;' in text
    assert "document.addEventListener('xkeen:routing-comments-ux', (ev) => {" in text
    assert '_commentsUxWired = true;' in text
    assert text.index('if (_inited) return;') < text.index("document.addEventListener('xkeen:routing-comments-ux', (ev) => {")


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
