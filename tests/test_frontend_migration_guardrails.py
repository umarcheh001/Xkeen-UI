from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGES_DIR = ROOT / "xkeen-ui" / "static" / "js" / "pages"
RUNTIME_DIR = ROOT / "xkeen-ui" / "static" / "js" / "runtime"
DOCS_DIR = ROOT / "docs"


def test_source_entrypoints_bootstrap_pages_without_legacy_loader():
    expectations = {
        "panel.entry.js": [
            "import { bootPanelPage } from './panel.bootstrap_tail.bundle.js';",
            "await import('./panel.routing.bundle.js');",
            "await import('./panel.mihomo.bundle.js');",
        ],
        "backups.entry.js": [
            "import { bootBackupsPage } from './backups.init.js';",
        ],
        "devtools.entry.js": [
            "import { bootDevtoolsPage } from './devtools.init.js';",
            "import '../features/compat/devtools.js';",
        ],
        "xkeen.entry.js": [
            "import { bootXkeenPage } from './xkeen.init.js';",
        ],
        "mihomo_generator.entry.js": [
            "import { bootMihomoGeneratorPage } from './mihomo_generator.init.js';",
        ],
    }
    forbidden_fragments = {
        "panel.entry.js": [],
        "backups.entry.js": [
            "../features/update_notifier.js?v=",
        ],
        "devtools.entry.js": [
            "../features/update_notifier.js?v=",
            "../features/typography.js?v=",
            "../features/layout_prefs.js?v=",
            "../features/branding_prefs.js?v=",
        ],
        "xkeen.entry.js": [
            "../features/update_notifier.js?v=",
        ],
        "mihomo_generator.entry.js": [
            "../features/update_notifier.js?v=",
        ],
    }

    for filename, fragments in expectations.items():
        text = (PAGES_DIR / filename).read_text(encoding="utf-8")
        assert "legacy_script_loader.js" not in text
        assert "bootLegacyEntry(" not in text
        for fragment in fragments:
            assert fragment in text, f"missing source-bootstrap fragment in {filename}: {fragment}"
        for fragment in forbidden_fragments.get(filename, []):
            assert fragment not in text, f"source entrypoint should use canonical feature import URLs in {filename}: {fragment}"


def test_panel_runtime_bundle_files_exist_for_current_architecture():
    required_files = [
        "panel.bootstrap_tail.bundle.js",
        "panel.core_ui_watch.runtime.js",
        "panel.lazy_bindings.runtime.js",
        "panel.mihomo.bundle.js",
        "panel.routing.bundle.js",
        "panel.shared_compat.bundle.js",
        "panel.view_runtime.js",
    ]

    for filename in required_files:
        assert (PAGES_DIR / filename).is_file(), f"missing current panel runtime file: {filename}"


def test_frontend_migration_docs_exist_for_current_contract():
    required_docs = [
        DOCS_DIR / "README_frontend_migration_plan.md",
        DOCS_DIR / "frontend-target-architecture.md",
        DOCS_DIR / "frontend-feature-api.md",
        DOCS_DIR / "frontend-page-inventory.md",
        DOCS_DIR / "adr" / "0001-frontend-esm-bootstrap.md",
    ]

    for path in required_docs:
        assert path.is_file(), f"missing frontend migration doc: {path.relative_to(ROOT).as_posix()}"


def test_lazy_runtime_keeps_only_generic_compat_feature_paths():
    text = (RUNTIME_DIR / "lazy_runtime.js").read_text(encoding="utf-8")

    required_fragments = [
        "const featureLoaders = {",
        "backups: () => import('../features/backups.js'),",
        "jsonEditor: () => import('../ui/json_editor_modal.js'),",
        "datContents: () => import('../ui/dat_contents_modal.js'),",
        "const featureModules = Object.create(null);",
        "function loadFeatureModule(name) {",
        "case 'backups': {",
        "const managed = getBuildManagedFeatureLoader(key);",
    ]
    forbidden_fragments = [
        "routingTemplates: () => import('../features/routing_templates.js'),",
        "github: () => import('../features/github.js').then(",
        "serviceStatus: () => import('../features/service_status.js'),",
        "restartLog: () => import('../features/restart_log.js'),",
        "donate: () => import('../features/donate.js'),",
        "xkeenTexts: () => import('../features/xkeen_texts.js'),",
        "commandsList: () => import('../features/commands_list.js'),",
        "coresStatus: () => import('../features/cores_status.js'),",
        "formatters: () => import('../ui/prettier_loader.js').then(() => import('../ui/formatters.js')),",
        "xrayPreflight: () => import('../ui/xray_preflight_modal.js'),",
        "uiSettingsPanel: () => import('../ui/settings_panel.js'),",
        "mihomoImport: () => import('../features/mihomo_import.js').then(",
        "mihomoProxyTools: () => import('../features/mihomo_import.js')",
        "mihomoHwidSub: () => import('../features/mihomo_hwid_sub.js').then(",
        "const featureModuleApiGetters = Object.freeze({",
        "function getFeatureApiFromModule(name) {",
    ]

    for fragment in required_fragments:
        assert fragment in text, f"missing generic lazy runtime fragment in lazy_runtime.js: {fragment}"
    for fragment in forbidden_fragments:
        assert fragment not in text, f"lazy runtime should not own panel-specific feature path: {fragment}"


def test_panel_lazy_bindings_own_panel_specific_feature_loaders():
    text = (PAGES_DIR / "panel.lazy_bindings.runtime.js").read_text(encoding="utf-8")

    required_fragments = [
        "const panelFeatureSpecs = Object.freeze({",
        "const panelFeatureModulePromises = Object.create(null);",
        "const panelFeatureEnsurePromises = Object.create(null);",
        "function loadPanelFeatureModule(name) {",
        "function initPanelFeature(name, api) {",
        "const localApi = getPanelFeatureApiFromModule(key);",
        "restartLog: {",
        "serviceStatus: {",
        "routingTemplates: {",
        "github: {",
        "donate: {",
        "uiSettingsPanel: {",
        "mihomoImport: {",
        "mihomoProxyTools: {",
        "mihomoHwidSub: {",
        "xkeenTexts: {",
        "commandsList: {",
        "coresStatus: {",
        "import('../features/restart_log.js')",
        "import('../features/service_status.js')",
        "import('../features/routing_templates.js')",
        "import('../features/github.js').then(",
        "import('../features/compat/github.js').then(() => mod)",
        "import('../ui/settings_panel.js')",
        "import('../features/compat/mihomo_import.js').then(() => mod)",
        "import('../features/compat/mihomo_proxy_tools.js').then(() => mod)",
        "import('../features/compat/mihomo_hwid_sub.js').then(() => mod)",
    ]

    for fragment in required_fragments:
        assert fragment in text, (
            f"missing panel-local lazy binding fragment in panel.lazy_bindings.runtime.js: {fragment}"
        )


def test_panel_view_runtime_uses_panel_lazy_bindings_for_xkeen_and_commands_views():
    text = (PAGES_DIR / "panel.view_runtime.js").read_text(encoding="utf-8")

    required_fragments = [
        "import { ensurePanelLazyFeature, getPanelLazyRuntimeApi } from './panel.lazy_bindings.runtime.js';",
        "const ready = await ensurePanelLazyFeature('xkeenTexts');",
        "ensurePanelLazyFeature('commandsList'),",
        "ensurePanelLazyFeature('coresStatus'),",
    ]
    forbidden_fragments = [
        "function ensureLazyFeature(name) {",
        "ensureLazyFeature('xkeenTexts')",
        "ensureLazyFeature('commandsList')",
        "ensureLazyFeature('coresStatus')",
    ]

    for fragment in required_fragments:
        assert fragment in text, f"panel view runtime should use panel lazy bindings: {fragment}"
    for fragment in forbidden_fragments:
        assert fragment not in text, f"legacy panel view lazy helper should be removed: {fragment}"


def test_formatters_and_xray_preflight_use_direct_imports_in_consumers():
    expectations = {
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "mihomo_panel.js": [
            "await import('../ui/prettier_loader.js');",
            "await import('../ui/formatters.js');",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing.js": [
            "await import('../ui/prettier_loader.js');",
            "await import('../ui/formatters.js');",
            "return import('../ui/xray_preflight_modal.js');",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "ui" / "json_editor_modal.js": [
            "await import('./prettier_loader.js');",
            "await import('./formatters.js');",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "ui" / "spinner_fetch.js": [
            "return import('./xray_preflight_modal.js');",
        ],
    }
    forbidden_fragments = [
        "ensureFeature('formatters')",
        "ensureFeature('xrayPreflight')",
    ]

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, f"missing direct-import fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"
        for fragment in forbidden_fragments:
            assert fragment not in text, (
                f"consumer should not use lazy_runtime feature bridge in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_routing_jsonc_preserve_uses_canonical_import_urls():
    files = [
        PAGES_DIR / "panel.routing.bundle.js",
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing_cards" / "rules" / "apply.js",
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing_cards" / "rules" / "model.js",
    ]

    for path in files:
        text = path.read_text(encoding="utf-8")
        assert "routing_jsonc_preserve.js?v=" not in text, (
            f"routing jsonc preserve should be imported via canonical URL in {path.relative_to(ROOT).as_posix()}"
        )


def test_routing_compat_bridges_use_canonical_import_urls_and_explicit_shell_bridge():
    expectations = {
        PAGES_DIR / "panel.routing.bundle.js": [
            "import '../features/routing.js';",
            "import '../features/compat/routing.js';",
            "import '../features/compat/routing_shell.js';",
            "import '../features/routing_cards.js';",
            "import '../features/compat/routing_cards.js';",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "compat" / "routing.js": [
            "import { getRoutingApi } from '../routing.js';",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "compat" / "routing_cards.js": [
            "import { getRoutingCardsApi } from '../routing_cards.js';",
            "import { getRoutingCardsNamespace } from '../routing_cards_namespace.js';",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing_cards" / "ns.js": [
            "import { initRoutingCardsNamespace } from '../routing_cards_namespace.js';",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing_cards_namespace.js": [
            "let routingCardsNamespace = null;",
            "const RC = {};",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "compat" / "routing_shell.js": [
            "import { getRoutingShellApi } from '../routing_shell.js';",
            "XKeen.features.routingShell = legacyRoutingShellApi;",
        ],
    }
    forbidden = {
        PAGES_DIR / "panel.routing.bundle.js": [
            "../features/routing.js?v=",
            "../features/routing_cards.js?v=",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "compat" / "routing.js": [
            "../routing.js?v=",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "compat" / "routing_cards.js": [
            "../routing_cards.js?v=",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "routing_cards_namespace.js": [
            "XK.features && XK.features.routingCards",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, f"missing routing compat fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"routing compat should use canonical import URLs in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_selected_page_runtime_modules_use_shared_runtime_adapters_instead_of_raw_window_xkeen_reads():
    expectations = {
        PAGES_DIR / "panel.lazy_bindings.runtime.js": [
            "from '../features/xkeen_runtime.js';",
        ],
        PAGES_DIR / "panel.core_ui_watch.runtime.js": [
            "from '../features/xkeen_runtime.js';",
        ],
        RUNTIME_DIR / "lazy_runtime.js": [
            "from '../features/xkeen_runtime.js';",
        ],
    }
    forbidden = {
        PAGES_DIR / "panel.lazy_bindings.runtime.js": [
            "window.XKeen.runtime",
            "window.XKeen.core",
            "window.openTerminal(",
        ],
        PAGES_DIR / "panel.core_ui_watch.runtime.js": [
            "window.XKeen && XKeen.core && XKeen.core.http",
            "window.XKeen && XKeen.ui",
            "window.toast(",
            "XKeen.jsonEditor",
            "window.confirm(",
        ],
        RUNTIME_DIR / "lazy_runtime.js": [
            "window.XKeen && XKeen.ui && XKeen.ui.cm6Runtime",
            "window.XKeen && XKeen.ui && XKeen.ui.editorActions",
            "XK.pages ? XK.pages.logsShell : null",
            "XK.pages ? XK.pages.configShell : null",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, f"missing runtime adapter import in {path.relative_to(ROOT).as_posix()}: {fragment}"

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"page/runtime module should use shared runtime adapters instead of raw globals in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_page_shell_helper_modules_use_xkeen_runtime_adapters_for_page_api_and_shell_access():
    expectations = {
        PAGES_DIR / "panel.view_runtime.js": [
            "from '../features/xkeen_runtime.js';",
            "getXkeenStateValue(",
            "hasXkeenXrayCore()",
            "syncXkeenBodyScrollLock()",
        ],
        PAGES_DIR / "panel_shell.shared.js": [
            "from '../features/xkeen_runtime.js';",
            "getXkeenCoreHttpApi()",
            "getXkeenUiShellApi()",
            "ensureXkeenUiBucket('tabs')",
            "publishXkeenPageApi('panelShell', api);",
            "getXkeenPageApi('panelShell')",
        ],
        PAGES_DIR / "config_shell.shared.js": [
            "from '../features/xkeen_runtime.js';",
            "getXkeenUiConfigShellApi()",
            "publishXkeenPageApi('configShell', {",
            "getXkeenPageApi('configShell')",
        ],
        PAGES_DIR / "logs_shell.shared.js": [
            "from '../features/xkeen_runtime.js';",
            "publishXkeenPageApi('logsShell', {",
            "getXkeenPageApi('logsShell')",
        ],
    }
    forbidden = {
        PAGES_DIR / "panel.view_runtime.js": [
            "window.XKeen && XKeen.state",
            "XKeen.ui.modal.syncBodyScrollLock",
        ],
        PAGES_DIR / "panel_shell.shared.js": [
            "window.XKeen && XKeen.core && XKeen.core.http",
            "window.XKeen && XKeen.core && XKeen.core.uiShell",
            "XK.pages.panelShell = api;",
            "window.XKeen && window.XKeen.pages ? window.XKeen.pages.panelShell : null",
        ],
        PAGES_DIR / "config_shell.shared.js": [
            "const api = XK.ui ? XK.ui.configShell : null;",
            "XK.pages.configShell = {",
            "window.XKeen && window.XKeen.pages ? window.XKeen.pages.configShell : null",
        ],
        PAGES_DIR / "logs_shell.shared.js": [
            "XK.pages.logsShell = {",
            "window.XKeen && window.XKeen.pages ? window.XKeen.pages.logsShell : null",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, (
                f"missing page helper runtime adapter fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"page helper should use xkeen runtime adapters instead of raw globals in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_terminal_runtime_helper_and_core_modules_use_terminal_runtime_adapters():
    runtime_src = (ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "runtime.js").read_text(encoding="utf-8")
    required_runtime_fragments = [
        "export function ensureTerminalRoot()",
        "export function ensureTerminalCompatState(defaults)",
        "export function ensureTerminalNamespaceBucket(name)",
        "export function getTerminalContext()",
        "export function publishTerminalCompatApi(name, api)",
        "export function publishWindowCompatFunction(name, fn)",
        "export function computeTerminalTabId()",
        "export function getTerminalCoreApi()",
        "export function getTerminalMode(ctx)",
        "export function getTerminalUiActionsApi()",
        "export function getTerminalExecCommand()",
        "export function focusTerminalView()",
        "export function isTerminalPtyConnected()",
        "export function openTerminalCompat(options)",
        "export function escapeTerminalHtml(text)",
        "export function openTerminalModal(modal, source, fallbackLocked)",
        "export function closeTerminalModal(modal, source, fallbackLocked)",
    ]
    for fragment in required_runtime_fragments:
        assert fragment in runtime_src, f"missing terminal runtime helper fragment: {fragment}"

    expectations = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "_core.js": [
            "from './runtime.js';",
            "publishTerminalCompatApi('_core', terminalCoreApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "capabilities.js": [
            "from './runtime.js';",
            "publishTerminalCompatApi('capabilities', {",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "history.js": [
            "from './runtime.js';",
            "publishTerminalCompatApi('history', {",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "lite_runner.js": [
            "from './runtime.js';",
            "publishTerminalCompatApi('lite_runner', terminalLiteRunnerApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "terminal.js": [
            "from './runtime.js';",
            "publishWindowCompatFunction('terminalOpen', (a, b) => {",
            "publishWindowCompatFunction('openTerminal', (cmd, mode) => uiActions.openTerminal(cmd, mode || 'shell'));",
        ],
    }
    forbidden = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "_core.js": [
            "window.XKeen.terminal",
            "window.XKeen.state",
            "XKeen.util.getTabId",
            "XKeen.ui.modal",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "capabilities.js": [
            "window.XKeen.terminal",
            "window.XKeen.state",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "history.js": [
            "window.XKeen.terminal",
            "XKeen.ui.modal",
            "window.showToast(",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "lite_runner.js": [
            "(window.XKeen && XKeen.util && XKeen.util.commandJob)",
            "window.XKeen.terminal",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "terminal.js": [
            "window.XKeen.terminal",
            "window.XKeen.state",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, f"missing terminal runtime adapter fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"terminal core module should use terminal runtime adapters instead of raw globals in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_terminal_side_modules_use_terminal_runtime_adapters_instead_of_raw_window_xkeen_reads():
    expectations = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "chrome.js": [
            "from './runtime.js';",
            "publishTerminalCompatApi('chrome', terminalChromeApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "pty.js": [
            "from './runtime.js';",
            "getTerminalContext()",
            "getTerminalMode()",
            "toastTerminal('PTY не подключён', 'info');",
            "publishTerminalCompatApi('pty', terminalPtyApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "quick_commands.js": [
            "from './runtime.js';",
            "escapeTerminalHtml(",
            "getTerminalExecCommand()",
            "isTerminalPtyConnected()",
            "publishTerminalCompatApi('quick_commands', terminalQuickCommandsApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "search.js": [
            "from './runtime.js';",
            "focusTerminalView()",
            "toastTerminal(",
            "publishTerminalCompatApi('search', terminalSearchApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "xray_tail.js": [
            "from './runtime.js';",
            "openTerminalCompat({ mode: 'pty', cmd: '' });",
            "isTerminalPtyConnected()",
            "publishTerminalCompatApi('xray_tail', terminalXrayTailApi);",
            "publishTerminalCompatApi('xrayTail', terminalXrayTailApi);",
        ],
    }
    forbidden = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "chrome.js": [
            "window.XKeen.terminal",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "pty.js": [
            "window.XKeen.terminal",
            "typeof showToast === 'function'",
            "window.XKeen && window.XKeen.state",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "quick_commands.js": [
            "window.XKeen.terminal",
            "window.showToast(",
            "window.escapeHtml",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "search.js": [
            "window.XKeen.terminal",
            "window.showToast(",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "xray_tail.js": [
            "window.XKeen.terminal",
            "window.XKeen = window.XKeen || {};",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, (
                f"missing terminal side-module runtime adapter fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"terminal side module should use runtime adapters instead of raw globals in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_deeper_terminal_core_transport_and_command_modules_use_runtime_adapter_publishers():
    runtime_src = (ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "runtime.js").read_text(encoding="utf-8")
    required_runtime_fragments = [
        "export function ensureTerminalCoreRoot()",
        "export function ensureTerminalTransportRoot()",
        "export function ensureTerminalCommandsRoot()",
        "export function ensureTerminalCommandBuiltinsRoot()",
        "export function publishTerminalCoreCompatApi(name, api)",
        "export function publishTerminalTransportCompatApi(name, api)",
        "export function publishTerminalCommandsCompatApi(name, api)",
        "export function publishTerminalBuiltinCommandCompatApi(name, api)",
    ]
    for fragment in required_runtime_fragments:
        assert fragment in runtime_src, f"missing deeper terminal runtime helper fragment: {fragment}"

    expectations = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "api.js": [
            "from '../runtime.js';",
            "getTerminalCommandJobApi()",
            "publishTerminalCoreCompatApi('createApi', createApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "config.js": [
            "from '../runtime.js';",
            "publishTerminalCoreCompatApi('createConfig', createConfig);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "events.js": [
            "from '../runtime.js';",
            "publishTerminalCoreCompatApi('createEventBus', createEventBus);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "logger.js": [
            "from '../runtime.js';",
            "publishTerminalCoreCompatApi('createLogger', createLogger);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "registry.js": [
            "from '../runtime.js';",
            "publishTerminalCoreCompatApi('createRegistry', createRegistry);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "state.js": [
            "from '../runtime.js';",
            "publishTerminalCoreCompatApi('defaultState', defaultState);",
            "publishTerminalCoreCompatApi('createStateStore', createStateStore);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "ui.js": [
            "from '../runtime.js';",
            "getTerminalById(",
            "toastTerminal(",
            "publishTerminalCoreCompatApi('createUiAdapter', createUiAdapter);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "context.js": [
            "from '../runtime.js';",
            "getTerminalCoreCompatApi('createEventBus')",
            "getTerminalTransportCompatApi('createTransportManager')",
            "getTerminalCompatApi('lite_runner')",
            "publishTerminalCoreCompatApi('createTerminalContext', createTerminalContext);",
            "publishTerminalCoreCompatApi('getCtx', getCtx);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "transport" / "index.js": [
            "from '../runtime.js';",
            "getTerminalTransportCompatApi('createPtyTransport')",
            "getTerminalTransportCompatApi('createLiteTransport')",
            "publishTerminalTransportCompatApi('createTransportManager', createTransportManager);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "transport" / "lite_transport.js": [
            "from '../runtime.js';",
            "getTerminalCommandJobApi()",
            "getTerminalMode(ctx)",
            "publishTerminalTransportCompatApi('createLiteTransport', createLiteTransport);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "transport" / "pty_transport.js": [
            "from '../runtime.js';",
            "getTerminalPtyApi()",
            "publishTerminalTransportCompatApi('createPtyTransport', createPtyTransport);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "registry.js": [
            "from '../runtime.js';",
            "publishTerminalCommandsCompatApi('createCommandRegistry', createCommandRegistry);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "router.js": [
            "from '../runtime.js';",
            "publishTerminalCommandsCompatApi('createCommandRouter', createCommandRouter);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "builtins" / "sysmon.js": [
            "from '../../runtime.js';",
            "getTerminalCommandJobApi()",
            "publishTerminalBuiltinCommandCompatApi('sysmon', commandDef);",
            "publishTerminalBuiltinCommandCompatApi('registerSysmon', register);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "builtins" / "xkeen_restart.js": [
            "from '../../runtime.js';",
            "publishTerminalBuiltinCommandCompatApi('xkeen_restart', commandDef);",
            "publishTerminalBuiltinCommandCompatApi('registerXkeenRestart', register);",
        ],
    }
    forbidden = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "api.js": [
            "window.XKeen.terminal.core",
            "XKeen.util.commandJob",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "config.js": [
            "window.XKeen.terminal.core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "events.js": [
            "window.XKeen.terminal.core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "logger.js": [
            "window.XKeen.terminal.core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "registry.js": [
            "window.XKeen.terminal.core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "state.js": [
            "window.XKeen.terminal.core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "ui.js": [
            "window.XKeen.terminal.core",
            "window.showToast(",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "context.js": [
            "window.XKeen.terminal.core.createEventBus",
            "window.XKeen.terminal.transport",
            "window.XKeen.terminal.ctx",
            "window.XKeen.terminal._core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "transport" / "index.js": [
            "window.XKeen.terminal.transport",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "transport" / "lite_transport.js": [
            "window.XKeen.util.commandJob",
            "window.XKeen.terminal.transport",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "transport" / "pty_transport.js": [
            "window.XKeen.terminal.pty",
            "window.XKeen.terminal.transport",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "registry.js": [
            "window.XKeen.terminal.commands",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "router.js": [
            "window.XKeen.terminal.commands",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "builtins" / "sysmon.js": [
            "window.XKeen.terminal.commands",
            "window.XKeen.util",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "commands" / "builtins" / "xkeen_restart.js": [
            "window.XKeen.terminal.commands",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, (
                f"missing deeper terminal adapter fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"deeper terminal compat module should use runtime adapters instead of raw globals in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )


def test_terminal_remaining_core_controllers_and_modules_use_runtime_adapters():
    expectations = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "input_controller.js": [
            "from '../runtime.js';",
            "getTerminalHistoryApi()",
            "publishTerminalCoreCompatApi('createInputController', createInputController);",
            "publishTerminalCompatApi('input_controller', {",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "output_controller.js": [
            "from '../runtime.js';",
            "getTerminalHistoryApi()",
            "publishTerminalCoreCompatApi('createOutputController', createOutputController);",
            "publishTerminalCompatApi('output_controller', {",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "public_api.js": [
            "from '../runtime.js';",
            "getTerminalContext()",
            "publishTerminalCompatApi('api', createPublicApi());",
            "publishTerminalCoreCompatApi('createPublicApi', createPublicApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "session_controller.js": [
            "from '../runtime.js';",
            "getTerminalPtyApi()",
            "publishTerminalCoreCompatApi('createSessionController', createSessionController);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "xterm_manager.js": [
            "from '../runtime.js';",
            "toastTerminal(String(msg || ''), kind || 'info');",
            "getTerminalCoreApi()",
            "publishTerminalCoreCompatApi('xterm_manager', terminalXtermManagerApi);",
            "publishTerminalCompatApi('xterm_manager', terminalXtermManagerApi);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "confirm_prompt.js": [
            "from '../runtime.js';",
            "getTerminalMode(ctx)",
            "getTerminalPublicApi()",
            "publishTerminalCompatApi('confirmPrompt', mod);",
            "publishTerminalCompatApi('confirm_prompt', terminalConfirmPromptCompat);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "output_prefs.js": [
            "from '../runtime.js';",
            "toastTerminal(m, k);",
            "publishTerminalCompatApi('outputPrefs', prefs);",
            "publishTerminalCompatApi('output_prefs', terminalOutputPrefsCompat);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "overlay_controller.js": [
            "from '../runtime.js';",
            "getTerminalModalApi()",
            "publishTerminalCompatApi('overlay', api);",
            "publishTerminalCompatApi('overlay_controller', terminalOverlayControllerCompat);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "reconnect_controller.js": [
            "from '../runtime.js';",
            "getTerminalCoreApi()",
            "getTerminalOverlayApi()",
            "publishTerminalCompatApi('reconnect', controller);",
            "publishTerminalCompatApi('reconnect_controller', terminalReconnectControllerCompat);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "status_controller.js": [
            "from '../runtime.js';",
            "getTerminalCoreApi()",
            "publishTerminalCompatApi('status', api);",
            "publishTerminalCompatApi('status_controller', terminalStatusControllerCompat);",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "ssh_profiles.js": [
            "from '../runtime.js';",
            "toastTerminal(String(msg || ''), kind || 'info');",
            "publishTerminalCompatApi('ssh_profiles', { createModule });",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "terminal_controller.js": [
            "from '../runtime.js';",
            "getTerminalContext()",
            "getTerminalChromeApi()",
            "getTerminalPtyApi()",
            "getTerminalSearchApi()",
            "publishTerminalCompatApi('terminalCtrl', api);",
            "publishTerminalCompatApi('terminal_controller', {",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "ui_controller.js": [
            "from '../runtime.js';",
            "getTerminalUiActionsApi() || {};",
            "getTerminalPtyApi()",
            "getTerminalPublicApi()",
            "getTerminalReconnectApi()",
            "publishTerminalCompatApi('ui_controller', { createModule });",
        ],
    }
    forbidden = {
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "input_controller.js": [
            "window.XKeen.terminal.history",
            "window.showToast(",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "output_controller.js": [
            "window.XKeen.terminal.history",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "public_api.js": [
            "window.XKeen.terminal.api",
            "window.XKeen.terminal._legacy",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "session_controller.js": [
            "window.XKeen.terminal.pty",
            "window.XKeen.terminal._core",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "core" / "xterm_manager.js": [
            "window.XKeen.terminal",
            "window.showToast(",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "confirm_prompt.js": [
            "window.XKeen.terminal.api",
            "window.XKeen = window.XKeen || {};",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "output_prefs.js": [
            "window.showToast(",
            "window.XKeen.terminal.output_prefs",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "overlay_controller.js": [
            "window.XKeen.ui.modal",
            "window.XKeen.terminal.overlay_controller",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "reconnect_controller.js": [
            "window.XKeen.terminal.overlay",
            "window.XKeen.terminal.reconnect_controller",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "status_controller.js": [
            "window.XKeen.terminal.status",
            "window.XKeen.terminal.status_controller",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "ssh_profiles.js": [
            "window.showToast(",
            "window.XKeen.terminal.ssh_profiles",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "terminal_controller.js": [
            "window.XKeen.terminal.terminalCtrl",
            "window.XKeen.terminal.terminal_controller",
            "window.showToast(",
        ],
        ROOT / "xkeen-ui" / "static" / "js" / "terminal" / "modules" / "ui_controller.js": [
            "window.XKeen.terminal.ui_actions",
            "window.XKeen.terminal.open",
            "window.XKeen.terminal.close",
            "window.XKeen.terminal.pty",
            "window.XKeen.terminal.ui_controller",
        ],
    }

    for path, fragments in expectations.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in text, (
                f"missing terminal controller/module runtime adapter fragment in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )

    for path, fragments in forbidden.items():
        text = path.read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment not in text, (
                f"terminal controller/module should use runtime adapters instead of raw globals in {path.relative_to(ROOT).as_posix()}: {fragment}"
            )
